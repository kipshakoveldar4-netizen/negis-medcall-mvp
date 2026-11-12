import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { createSalesRetryRuntime } from "./sales-retry-test-runtime";

type Attempt = { workspaceId: string; actorId: string; requestKey: string; payload: Record<string, unknown>; uncertain: boolean };
type AttemptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const helpers = await import(new URL("../../artifacts/negis/src/lib/salesCreateAttempt.ts", import.meta.url).href) as {
  newSalesCreateAttempt(workspaceId: string, actorId: string, payload: Record<string, unknown>, makeKey?: () => string): Attempt;
  persistSalesCreateAttempt(storage: AttemptStorage, attempt: Attempt): boolean;
  restoreSalesCreateAttempt(storage: AttemptStorage, workspaceId: string, actorId: string): Attempt | null;
  clearPersistedSalesCreateAttempt(storage: AttemptStorage, attempt: Attempt): void;
  canReleaseSalesAttempt(attempt: Attempt, status: number, body: unknown): boolean;
  confirmedSalesCreate(body: unknown): Record<string, unknown> | null;
  mergeCreatedSale<T extends { id: string }>(items: T[], saved: T): T[];
};
const workspace = "00000000-0000-4000-8000-000000000071";
const otherWorkspace = "00000000-0000-4000-8000-000000000072";
const actor = "00000000-0000-4000-8000-000000000090";
const otherActor = "00000000-0000-4000-8000-000000000091";
const key = "00000000-0000-4000-8000-000000000080";
const savedId = "00000000-0000-4000-8000-000000000081";
const attemptSlot = `medina_sale_create_attempt_v1::${workspace}:${actor}`;
const item = { id: savedId, title: "Synthetic manual sale", amountMinor: 123450, currency: "KZT", status: "paid" };
const list = (items: unknown[] = []) => Response.json({ success: true, mode: "supabase", data: { deals: items } });
const success = (replayed = false, saved: Record<string, unknown> = item) =>
  Response.json({ success: true, mode: "supabase", data: { item: saved, replayed } }, { status: replayed ? 200 : 201 });
const refusal = (status: number, code: string) => Response.json({ success: false, code, error: "Synthetic refusal" }, { status });
type Runtime = Awaited<ReturnType<typeof createSalesRetryRuntime>>;
const posts = (runtime: Runtime) => runtime.calls.filter(call => call.method === "POST");
async function fill(runtime: Runtime) {
  runtime.view.openAdd();
  runtime.render();
  runtime.view.setForm({ ...runtime.view.form, title: item.title, amountTenge: "1234.50", status: "paid", notes: "Synthetic note" });
  await runtime.settle();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function deferredSaleBody() {
  const body = deferred<unknown>();
  const response = success(true);
  let reading = false;
  Object.defineProperty(response, "json", { value: () => { reading = true; return body.promise; } });
  return { body, response, get reading() { return reading; } };
}
function memoryStorage() {
  const values = new Map<string, string>();
  return { values, getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value); },
    removeItem: (name: string) => { values.delete(name); } };
}

function recoveryRecord() {
  const storage = memoryStorage();
  const attempt = helpers.newSalesCreateAttempt(workspace, actor, {
    ...item, paidAt: "2026-10-01T10:00:00Z", closedAt: "2026-10-01T10:00:00Z", notes: "Synthetic retained note",
  }, () => key);
  assert.ok(helpers.persistSalesCreateAttempt(storage, attempt));
  return { storage, attempt, raw: storage.values.get(attemptSlot)! };
}

test("helper snapshots and freezes the payload and dates; only UUID4 keys are accepted", () => {
  const payload = { ...item, id: "local-id", requestKey: "supplied", paidAt: "2026-10-01T10:00:00Z", clientId: savedId };
  let keys = 0;
  const attempt = helpers.newSalesCreateAttempt(workspace, actor, payload, () => { keys++; return key; });
  payload.amountMinor = 0;
  payload.clientId = otherActor;
  payload.paidAt = "changed";
  assert.equal(keys, 1);
  assert.equal(attempt.payload.id, undefined);
  assert.equal(attempt.payload.requestKey, undefined);
  assert.equal(attempt.payload.paidAt, "2026-10-01T10:00:00Z");
  assert.equal(attempt.payload.amountMinor, 123450);
  assert.equal(attempt.payload.clientId, savedId);
  assert.ok(Object.isFrozen(attempt.payload));
  assert.throws(() => helpers.newSalesCreateAttempt(workspace, actor, item, () => "not-a-uuid"));
  assert.throws(() => helpers.newSalesCreateAttempt(workspace, "", item, () => key));
});

for (const amountMinor of [0, 700050, Number.MAX_SAFE_INTEGER]) {
  test(`helper accepts safe minor amount ${amountMinor} and preserves dates and string references through recovery`, () => {
    const storage = memoryStorage();
    const payload = { ...item, amountMinor, paidAt: "2026-10-01T10:00:00.000Z", closedAt: "2026-10-01T10:00:00.000Z",
      paymentMethod: "cash", clientId: actor, leadId: otherActor, appointmentId: savedId, serviceId: key,
      metaCampaignLaunchId: otherWorkspace, responsibleUserId: actor, notes: "Synthetic retained note" };
    const attempt = helpers.newSalesCreateAttempt(workspace, actor, payload, () => key);
    assert.ok(helpers.persistSalesCreateAttempt(storage, attempt));
    const recovered = helpers.restoreSalesCreateAttempt(storage, workspace, actor)!;
    assert.deepEqual(recovered, { ...attempt, uncertain: true });
    assert.equal(recovered.payload.amountMinor, amountMinor);
    assert.equal(recovered.payload.paidAt, payload.paidAt);
    assert.equal(recovered.payload.closedAt, payload.closedAt);
    assert.equal(recovered.payload.responsibleUserId, actor);
    assert.equal(recovered.requestKey, key);
  });
}

const invalidPayloads: Array<[string, Record<string, unknown>]> = [
  ["empty object", {}],
  ["empty title", { ...item, title: "" }],
  ["whitespace title", { ...item, title: "   " }],
  ["missing amount", { title: item.title, currency: "KZT", status: "paid" }],
  ["unsafe integer", { ...item, amountMinor: Number.MAX_SAFE_INTEGER + 1 }],
  ["negative minor amount", { ...item, amountMinor: -1 }],
  ["fractional minor amount", { ...item, amountMinor: 1.5 }],
  ["non-finite amount", { ...item, amountMinor: Infinity }],
  ["string amount", { ...item, amountMinor: "700050" }],
  ["wrong currency", { ...item, currency: "USD" }],
  ["missing status", { title: item.title, amountMinor: 0, currency: "KZT" }],
  ["unknown status", { ...item, status: "unknown" }],
  ["array status", { ...item, status: ["paid"] }],
  ["unknown nested fields", { ...item, nested: { amountMinor: 0 } }],
  ["non-string reference", { ...item, clientId: { id: actor } }],
  ["invalid date", { ...item, paidAt: "not-a-date" }],
  ["oversized known payload", { ...item, notes: "x".repeat(256_001) }],
];

for (const [label, payload] of invalidPayloads) {
  test(`helper rejects ${label} before generating a key or persisting an unrestorable attempt`, () => {
    let keys = 0;
    assert.throws(() => helpers.newSalesCreateAttempt(workspace, actor, payload, () => { keys++; return key; }));
    assert.equal(keys, 0);
    const { id: _id, ...fields } = payload;
    const storage = memoryStorage();
    const attempt = { workspaceId: workspace, actorId: actor, requestKey: key, payload: fields, uncertain: false };
    assert.equal(helpers.persistSalesCreateAttempt(storage, attempt), false);
    assert.equal(storage.values.size, 0);
  });
}

for (const amountTenge of ["90071992547409.92", "9007199254740991", "1e307", "-1", "NaN"]) {
  test(`UI rejects unsafe or invalid tenge amount ${amountTenge} before POST, keeping the form editable`, async () => {
    let keys = 0;
    const runtime = await createSalesRetryRuntime(workspace, async method => method === "GET" ? list() : success(), {
      randomUUID: () => { keys++; return key; },
    });
    try {
      await fill(runtime);
      runtime.view.setForm({ ...runtime.view.form, amountTenge }); runtime.render();
      runtime.view.submitForm(); await runtime.settle();
      assert.equal(posts(runtime).length, 0);
      assert.equal(keys, 0);
      assert.equal(runtime.sessionStored.size, 0);
      assert.equal(runtime.view.form.amountTenge, amountTenge);
      assert.equal(runtime.view.formOpen, true);
      assert.equal(runtime.view.saving, false);
      assert.equal(runtime.view.unconfirmedCreate, false);
      assert.equal(runtime.view.restoreError, "");
      assert.ok(runtime.toasts.some(toast => toast.kind === "error"));
      runtime.view.setForm({ ...runtime.view.form, amountTenge: "7000.50" }); runtime.render();
      runtime.view.submitForm(); await runtime.settle();
      assert.equal(posts(runtime).length, 1);
      assert.equal(posts(runtime)[0].body.amountMinor, 700050);
    } finally { runtime.dispose(); }
  });
}

for (const [amountTenge, amountMinor] of [["0", 0], ["7000.50", 700050], ["1000000000000", 100000000000000]] as const) {
  test(`UI accepts ${amountTenge} KZT as ${amountMinor} safe minor units, without a business price cap`, async () => {
    const saved = { ...item, amountMinor };
    const runtime = await createSalesRetryRuntime(workspace, async method => method === "GET" ? list() : success(false, saved));
    try {
      await fill(runtime);
      runtime.view.setForm({ ...runtime.view.form, amountTenge }); runtime.render();
      runtime.view.submitForm(); await runtime.settle();
      assert.equal(posts(runtime).length, 1);
      assert.equal(posts(runtime)[0].body.amountMinor, amountMinor);
      assert.equal(runtime.view.formOpen, false);
      assert.equal(runtime.view.unconfirmedCreate, false);
      assert.equal(runtime.sessionStored.size, 0);
    } finally { runtime.dispose(); }
  });
}

test("actual page prefill preserves fractional minor units and zero through keyed submission", async () => {
  for (const [priceMinor, amountTenge] of [[700050, "7000.50"], [0, "0"]] as const) {
    const prefillKey = `negis_deal_prefill::${workspace}`;
    const localStored = new Map([["negis_workspace_selector", workspace],
      [prefillKey, JSON.stringify({ title: item.title, priceMinor })]]);
    const saved = { ...item, amountMinor: priceMinor, status: "pending" };
    const runtime = await createSalesRetryRuntime(workspace, async method => method === "GET" ? list() : success(false, saved), { localStored });
    try {
      assert.equal(runtime.view.formOpen, true);
      assert.equal(runtime.view.form.amountTenge, amountTenge);
      assert.equal(localStored.has(prefillKey), false);
      assert.equal(posts(runtime).length, 0);
      runtime.view.submitForm(); await runtime.settle();
      assert.equal(posts(runtime).length, 1);
      assert.equal(posts(runtime)[0].body.amountMinor, priceMinor);
      assert.ok(posts(runtime)[0].body.requestKey);
      assert.equal(runtime.view.formOpen, false);
      assert.equal(runtime.view.unconfirmedCreate, false);
      assert.equal(runtime.sessionStored.size, 0);
    } finally { runtime.dispose(); }
  }
});

test("tab recovery is scope-bound, uncertain and does not erase other accounts' attempts", () => {
  const storage = memoryStorage();
  const attempt = helpers.newSalesCreateAttempt(workspace, actor, { ...item, paidAt: "2026-10-01T10:00:00Z" }, () => key);
  assert.ok(helpers.persistSalesCreateAttempt(storage, attempt));
  assert.equal(helpers.restoreSalesCreateAttempt(storage, workspace, otherActor), null);
  assert.equal(helpers.restoreSalesCreateAttempt(storage, otherWorkspace, actor), null);
  assert.equal(storage.values.size, 1);
  assert.deepEqual(helpers.restoreSalesCreateAttempt(storage, workspace, actor), { ...attempt, uncertain: true });
  helpers.clearPersistedSalesCreateAttempt(storage, attempt);
  assert.equal(storage.values.size, 0);
});

test("only confirmed saved sales can finish; merging a replay removes duplicate IDs", () => {
  for (const body of [null, {}, { success: true }, { success: true, mode: "demo", data: { item, replayed: false } },
    { success: true, mode: "supabase", data: { item } },
    { success: true, mode: "supabase", data: { item: { id: savedId }, replayed: false } },
    { success: true, mode: "supabase", data: { item: { ...item, id: "local-id" }, replayed: true } }]) {
    assert.equal(helpers.confirmedSalesCreate(body), null);
  }
  assert.deepEqual(helpers.confirmedSalesCreate({ success: true, mode: "supabase", data: { item, replayed: true } }), item);
  const stale = { ...item, title: "Synthetic stale sale" };
  const other = { ...item, id: "another-id" };
  assert.deepEqual(helpers.mergeCreatedSale([other, stale, stale], item), [other, item]);
});

test("real closure persists before dispatch, blocks synchronous double submit and merges only server data", async () => {
  const reply = deferred<Response>();
  const sessionStored = new Map<string, string>();
  const runtime = await createSalesRetryRuntime(workspace, async (method, body) => {
    if (method === "GET") return list([item, item]);
    const persisted = JSON.parse([...sessionStored.values()][0]) as Attempt;
    assert.equal(persisted.requestKey, body.requestKey);
    assert.deepEqual(persisted.payload, Object.fromEntries(Object.entries(body).filter(([name]) => name !== "requestKey")));
    return reply.promise;
  }, { actorId: actor, sessionStored, randomUUID: () => key });
  try {
    await fill(runtime);
    const submit = runtime.view.submitForm;
    submit(); submit();
    runtime.render();
    await tick();
    assert.equal(posts(runtime).length, 1);
    assert.equal(runtime.view.saving, true);
    assert.equal(runtime.view.formOpen, true);
    assert.equal(runtime.view.items.length, 2, "no optimistic third row");
    assert.equal(runtime.tokenLookups.at(-1), actor);
    const saved = { ...item, title: "Synthetic server title" };
    reply.resolve(success(false, saved));
    await runtime.settle();
    assert.equal(runtime.view.items.length, 1);
    assert.equal((runtime.view.items[0] as unknown as typeof item).title, saved.title);
    assert.equal(runtime.view.formOpen, false);
    assert.equal(sessionStored.size, 0);
    assert.equal(runtime.stored.size, 1, "no real sale/contact cache in localStorage");
  } finally { reply.resolve(success()); runtime.dispose(); }
});

test("network uncertainty survives close/new/edit and later 403; retry sends the identical key and dated payload", async () => {
  let writes = 0, keys = 0;
  const runtime = await createSalesRetryRuntime(workspace, async method => {
    if (method === "GET") return list();
    if (++writes === 1) throw new Error("synthetic lost reply");
    return writes === 2 ? refusal(403, "sale_request_access_denied") : success(true);
  }, { randomUUID: () => { keys++; return key; } });
  try {
    await fill(runtime);
    const entered = JSON.stringify(runtime.view.form);
    runtime.view.submitForm(); await runtime.settle();
    assert.equal(runtime.view.unconfirmedCreate, true);
    assert.equal(runtime.view.saving, false);
    assert.equal(runtime.view.items.length, 0);
    runtime.view.closeSaleForm(); runtime.view.openAdd(); runtime.view.openEdit(item);
    await runtime.settle();
    assert.equal(runtime.view.formOpen, true);
    assert.equal(runtime.view.editingId, null);
    assert.equal(JSON.stringify(runtime.view.form), entered);
    runtime.view.submitForm(); await runtime.settle();
    assert.equal(runtime.view.unconfirmedCreate, true);
    assert.equal(runtime.sessionStored.size, 1);
    runtime.view.submitForm(); await runtime.settle();
    assert.deepEqual(posts(runtime).map(call => call.body), Array(3).fill(posts(runtime)[0].body));
    assert.equal(keys, 1);
    assert.equal(runtime.view.items.length, 1);
    assert.equal(runtime.sessionStored.size, 0);
  } finally { runtime.dispose(); }
});

for (const failure of ["5xx", "malformed-json", "incomplete-success", "demo-success", "wrong-status"] as const) {
  test(`${failure} retains the attempt and retries without fallback`, async () => {
    let writes = 0;
    const runtime = await createSalesRetryRuntime(workspace, async method => {
      if (method === "GET") return list();
      if (++writes > 1) return success(true);
      if (failure === "5xx") return refusal(503, "unknown_failure");
      if (failure === "malformed-json") return new Response("invalid", { status: 201 });
      if (failure === "wrong-status") return new Response(JSON.stringify({ success: true, mode: "supabase", data: { item, replayed: false } }), { status: 202 });
      return Response.json(failure === "demo-success" ? { success: true, mode: "demo", data: { item, replayed: false } }
        : { success: true, mode: "supabase", data: { item } }, { status: 201 });
    });
    try {
      await fill(runtime);
      runtime.view.submitForm(); await runtime.settle();
      assert.equal(posts(runtime).length, 1);
      assert.equal(runtime.view.unconfirmedCreate, true);
      assert.equal(runtime.view.items.length, 0);
      runtime.view.submitForm(); await runtime.settle();
      assert.deepEqual(posts(runtime)[1].body, posts(runtime)[0].body);
      assert.equal(runtime.view.items.length, 1);
    } finally { runtime.dispose(); }
  });
}

test("reload restores the exact intent ahead of prefill and never automatically posts", async () => {
  const first = await createSalesRetryRuntime(workspace, async method => {
    if (method === "GET") return list();
    throw new Error("synthetic dropped response");
  });
  await fill(first);
  first.view.submitForm(); await first.settle();
  const sent = posts(first)[0].body;
  const sessionStored = first.sessionStored;
  first.dispose();
  const localStored = new Map([["negis_workspace_selector", workspace],
    [`negis_deal_prefill::${workspace}`, JSON.stringify({ title: "Synthetic different prefill", priceMinor: 1 })]]);
  const reloaded = await createSalesRetryRuntime(workspace, async method => method === "GET" ? list() : success(true), { sessionStored, localStored });
  try {
    assert.equal(posts(reloaded).length, 0);
    assert.equal(reloaded.view.form.title, item.title);
    assert.equal(reloaded.view.form.amountTenge, "1234.50");
    assert.equal(reloaded.view.formOpen, true);
    assert.equal(reloaded.view.unconfirmedCreate, true);
    assert.ok(localStored.has(`negis_deal_prefill::${workspace}`));
    reloaded.view.submitForm(); await reloaded.settle();
    assert.deepEqual(posts(reloaded)[0].body, sent);
  } finally { reloaded.dispose(); }
});

for (const change of ["actor", "workspace", "unmount"] as const) {
  test(`${change} invalidates queued authentication and stale submit handlers before dispatch`, async () => {
    const token = deferred<string>();
    const runtime = await createSalesRetryRuntime(workspace, async method => method === "GET" ? list() : success(), {
      getAccessToken: async expected => expected ? token.promise : "fixture.test.signature",
    });
    try {
      await fill(runtime);
      const oldSubmit = runtime.view.submitForm;
      oldSubmit();
      if (change === "unmount") runtime.dispose();
      else runtime.setScope(change === "actor" ? otherActor : actor, change === "workspace" ? otherWorkspace : workspace);
      const toastCount = runtime.toasts.length;
      oldSubmit();
      token.resolve("fixture.test.signature");
      await runtime.settle();
      assert.equal(posts(runtime).length, 0);
      assert.equal(runtime.toasts.length, toastCount);
      assert.equal(runtime.sessionStored.size, 1, "the old scope remains recoverable");
    } finally { token.resolve("fixture.test.signature"); runtime.dispose(); }
  });
}

for (const change of ["actor", "workspace", "unmount"] as const) {
  test(`${change} ignores late success without merging, clearing recovery or changing the new form`, async () => {
    const reply = deferred<Response>();
    const runtime = await createSalesRetryRuntime(workspace, async method => method === "GET" ? list() : reply.promise);
    try {
      await fill(runtime);
      runtime.view.submitForm(); await tick();
      assert.equal(posts(runtime).length, 1);
      if (change === "unmount") runtime.dispose();
      else {
        runtime.setScope(change === "actor" ? otherActor : actor, change === "workspace" ? otherWorkspace : workspace);
        runtime.render();
        runtime.view.openAdd(); runtime.render();
      }
      const toastCount = runtime.toasts.length;
      reply.resolve(success()); await runtime.settle();
      assert.equal(runtime.view.items.length, 0);
      assert.equal(runtime.toasts.length, toastCount);
      assert.equal(runtime.sessionStored.size, 1);
      if (change !== "unmount") {
        assert.equal(runtime.view.formOpen, true);
        assert.equal(runtime.view.form.title, "");
        runtime.setScope(actor, workspace); await runtime.settle();
        assert.equal(runtime.view.unconfirmedCreate, true);
        assert.equal(runtime.view.form.title, item.title);
      }
    } finally { reply.resolve(success()); runtime.dispose(); }
  });
}

for (const change of ["ABA", "actor", "logout"] as const) {
  test(`raw SDK ${change} invalidates a queued lookup before AuthContext renders and retains the original explicit retry`, async () => {
    const token = deferred<string>();
    let keys = 0;
    const runtime = await createSalesRetryRuntime(workspace, async method => method === "GET" ? list() : success(true), {
      getAccessToken: async expected => expected ? token.promise : "fixture.test.signature",
      randomUUID: () => { keys++; return key; },
    });
    try {
      assert.equal(runtime.authListeners.size, 1);
      await fill(runtime);
      const oldSubmit = runtime.view.submitForm;
      oldSubmit();
      const raw = runtime.sessionStored.get(attemptSlot)!;
      const attempt = JSON.parse(raw) as Attempt;
      if (change === "logout") runtime.emitSdkActor(null);
      else {
        runtime.emitSdkActor(otherActor);
        if (change === "ABA") runtime.emitSdkActor(actor);
      }
      const toastCount = runtime.toasts.length;
      oldSubmit();
      // Return a valid A token even when AuthContext never observed the boundary.
      token.resolve("fixture.test.signature");
      await runtime.settle();
      assert.equal(posts(runtime).length, 0);
      assert.equal(runtime.toasts.length, toastCount);
      assert.equal(runtime.sessionStored.get(attemptSlot), raw);
      assert.equal(keys, 1);
      oldSubmit();
      if (change !== "ABA") {
        runtime.view.openAdd(); runtime.view.submitForm();
        runtime.setScope(actor); await runtime.settle();
        runtime.view.openAdd(); runtime.view.submitForm(); await runtime.settle();
        assert.equal(posts(runtime).length, 0, "old AuthContext A cannot reactivate while SDK is different or logged out");
        assert.equal(runtime.view.formOpen, false);
        assert.equal(runtime.sessionStored.get(attemptSlot), raw);
        runtime.emitSdkActor(actor); await runtime.settle();
      }
      assert.equal(runtime.view.unconfirmedCreate, true);
      assert.equal(runtime.view.form.title, item.title);
      assert.equal(posts(runtime).length, 0, "returning to the original actor never posts automatically");
      oldSubmit(); await runtime.settle();
      assert.equal(posts(runtime).length, 0, "old A closures remain expired even after A returns");
      runtime.view.submitForm(); await runtime.settle();
      assert.equal(posts(runtime).length, 1);
      assert.deepEqual(posts(runtime)[0].body, { ...attempt.payload, requestKey: attempt.requestKey });
      assert.equal(keys, 1);
      assert.equal(runtime.sessionStored.size, 0);
    } finally {
      token.resolve("fixture.test.signature"); runtime.dispose();
      assert.equal(runtime.authListeners.size, 0);
    }
  });
}

for (const change of ["ABA", "logout"] as const) {
  test(`raw SDK ${change} during a late response body cannot merge, toast or clear the saved attempt`, async () => {
    const reply = deferredSaleBody();
    const acknowledged = { success: true, mode: "supabase", data: { item, replayed: true } };
    let writes = 0, keys = 0;
    const runtime = await createSalesRetryRuntime(workspace, async method => {
      if (method === "GET") return list();
      return ++writes === 1 ? reply.response : success(true);
    }, { randomUUID: () => { keys++; return key; } });
    try {
      await fill(runtime);
      const oldSubmit = runtime.view.submitForm;
      oldSubmit(); await tick();
      assert.equal(posts(runtime).length, 1);
      assert.equal(reply.reading, true, "scope changes while response.json is still pending");
      const original = posts(runtime)[0].body;
      const raw = runtime.sessionStored.get(attemptSlot)!;
      const toastCount = runtime.toasts.length;
      if (change === "logout") runtime.emitSdkActor(null);
      else { runtime.emitSdkActor(otherActor); runtime.emitSdkActor(actor); }
      reply.body.resolve(acknowledged); await runtime.settle();
      assert.equal(runtime.view.items.length, 0);
      assert.equal(runtime.toasts.length, toastCount);
      assert.equal(runtime.sessionStored.get(attemptSlot), raw);
      assert.equal(keys, 1);
      if (change === "logout") {
        runtime.setScope(actor); await runtime.settle();
        runtime.view.openAdd(); runtime.view.submitForm(); await runtime.settle();
        assert.equal(posts(runtime).length, 1);
        assert.equal(runtime.view.formOpen, false);
        runtime.emitSdkActor(actor); await runtime.settle();
      }
      assert.equal(runtime.view.unconfirmedCreate, true);
      assert.equal(posts(runtime).length, 1, "scope recovery does not retry automatically");
      oldSubmit(); await runtime.settle();
      assert.equal(posts(runtime).length, 1);
      runtime.view.submitForm(); await runtime.settle();
      assert.equal(posts(runtime).length, 2);
      assert.deepEqual(posts(runtime)[1].body, original);
      assert.equal(keys, 1);
    } finally {
      reply.body.resolve(acknowledged); runtime.dispose();
      assert.equal(runtime.authListeners.size, 0);
    }
  });
}

test("same-actor SDK token refresh preserves queued dispatch, the pending body and the current form", async () => {
  const token = deferred<string>();
  const reply = deferredSaleBody();
  const acknowledged = { success: true, mode: "supabase", data: { item, replayed: true } };
  let keys = 0;
  const runtime = await createSalesRetryRuntime(workspace, async method => method === "GET" ? list() : reply.response, {
    getAccessToken: async expected => expected ? token.promise : "fixture.test.signature",
    randomUUID: () => { keys++; return key; },
  });
  try {
    await fill(runtime);
    const entered = JSON.stringify(runtime.view.form);
    runtime.view.submitForm();
    const raw = runtime.sessionStored.get(attemptSlot)!;
    runtime.emitSdkActor(actor, "INITIAL_SESSION");
    runtime.emitSdkActor(actor, "TOKEN_REFRESHED");
    runtime.render();
    assert.equal(runtime.view.saving, true);
    assert.equal(JSON.stringify(runtime.view.form), entered);
    assert.equal(runtime.sessionStored.get(attemptSlot), raw);
    token.resolve("fixture.test.signature"); await tick();
    assert.equal(posts(runtime).length, 1);
    assert.equal(reply.reading, true);
    runtime.emitSdkActor(actor, "TOKEN_REFRESHED");
    runtime.emitSdkActor(actor, "USER_UPDATED");
    runtime.render();
    assert.equal(runtime.view.saving, true);
    assert.equal(JSON.stringify(runtime.view.form), entered);
    assert.equal(runtime.view.unconfirmedCreate, false);
    reply.body.resolve(acknowledged); await runtime.settle();
    assert.equal(runtime.view.items.length, 1);
    assert.equal(runtime.view.formOpen, false);
    assert.equal(runtime.sessionStored.size, 0);
    assert.equal(keys, 1);
    assert.equal(runtime.toasts.filter(toast => toast.kind === "success").length, 1);
  } finally {
    token.resolve("fixture.test.signature"); reply.body.resolve(acknowledged); runtime.dispose();
    assert.equal(runtime.authListeners.size, 0);
  }
});

test("a replay returning an edited refunded sale uses the current row and never announces a new paid sale", async () => {
  const current = { ...item, title: "Synthetic edited refunded sale", status: "refunded", amountMinor: 700050 };
  const runtime = await createSalesRetryRuntime(workspace, async method => method === "GET" ? list() : success(true, current));
  try {
    await fill(runtime);
    assert.equal(runtime.view.form.status, "paid");
    runtime.view.submitForm(); await runtime.settle();
    assert.equal(posts(runtime)[0].body.status, "paid", "the original keyed intent stays immutable");
    assert.equal(runtime.view.items.length, 1);
    assert.equal(runtime.view.items[0].status, "refunded");
    assert.equal((runtime.view.items[0] as unknown as typeof item).title, current.title);
    assert.equal((runtime.view.items[0] as unknown as typeof item).amountMinor, current.amountMinor);
    assert.deepEqual(runtime.toasts.filter(toast => toast.kind === "success"), [{ kind: "success", message: "Продажа сохранена" }]);
    assert.equal(runtime.view.formOpen, false);
  } finally { runtime.dispose(); }
});

for (const storageMode of ["denied", "no-readback"] as const) {
  test(`${storageMode} tab storage fails closed before POST and preserves entered data`, async () => {
    const runtime = await createSalesRetryRuntime(workspace, async method => method === "GET" ? list() : success(), { storageMode });
    try {
      await fill(runtime);
      runtime.view.submitForm(); await runtime.settle();
      assert.equal(posts(runtime).length, 0);
      assert.equal(runtime.view.saving, false);
      assert.equal(runtime.view.unconfirmedCreate, false);
      assert.equal(runtime.view.form.title, item.title);
      assert.ok(runtime.view.restoreError);
    } finally { runtime.dispose(); }
  });
}

const validRecord = JSON.parse(recoveryRecord().raw) as Record<string, unknown>;
const invalidRecords = [
  ["malformed JSON", "{not-json"],
  ["oversized record", " ".repeat(256_001)],
  ["empty string record", ""],
  ["JSON null record", "null"],
  ["wrong version", JSON.stringify({ ...validRecord, version: 2 })],
  ["tampered actor", JSON.stringify({ ...validRecord, actorId: otherActor })],
  ["tampered workspace", JSON.stringify({ ...validRecord, workspaceId: otherWorkspace })],
  ["tampered key", JSON.stringify({ ...validRecord, requestKey: "corrupt-key" })],
  ["missing payload fields", JSON.stringify({ ...validRecord, payload: {} })],
  ["invalid amount", JSON.stringify({ ...validRecord, payload: { ...item, id: undefined, amountMinor: "123450" } })],
  ["injected payload key", JSON.stringify({ ...validRecord, payload: { ...item, id: undefined, requestKey: key } })],
  ["invalid uncertainty flag", JSON.stringify({ ...validRecord, uncertain: "false" })],
  ...invalidPayloads.map(([label, payload]) => {
    const { id: _id, ...fields } = payload;
    return [`stored ${label}`, JSON.stringify({ ...validRecord, payload: fields })] as const;
  }),
] as const;

for (const [label, raw] of invalidRecords) {
  test(`${label} throws on restore, preserves the record and blocks mount/new/re-read paths`, async () => {
    const storage = memoryStorage();
    assert.equal(helpers.restoreSalesCreateAttempt(storage, workspace, actor), null, "only absent storage is empty");
    storage.values.set(attemptSlot, raw);
    assert.throws(() => helpers.restoreSalesCreateAttempt(storage, workspace, actor), /SalesAttemptRestoreError/);
    const attempt = recoveryRecord().attempt;
    assert.equal(helpers.persistSalesCreateAttempt(storage, attempt), false, "invalid record cannot be overwritten");
    helpers.clearPersistedSalesCreateAttempt(storage, attempt);
    assert.equal(storage.values.get(attemptSlot), raw, "invalid record cannot be silently removed");
    const prefillKey = `negis_deal_prefill::${workspace}`;
    const localStored = new Map([["negis_workspace_selector", workspace],
      [prefillKey, JSON.stringify({ title: "Synthetic pending prefill", priceMinor: 1 })]]);
    let keys = 0;
    const runtime = await createSalesRetryRuntime(workspace, async method => method === "GET" ? list() : success(), {
      sessionStored: storage.values, localStored, randomUUID: () => { keys++; return key; },
    });
    try {
      assert.ok(runtime.view.restoreError);
      assert.equal(runtime.view.formOpen, true);
      assert.equal(runtime.view.form.title, "", "prefill is not consumed or applied");
      assert.ok(localStored.has(prefillKey));
      await fill(runtime);
      runtime.view.submitForm(); runtime.view.openAdd(); runtime.view.openEdit(item); runtime.view.closeSaleForm();
      await runtime.settle();
      runtime.view.retrySaleRecovery(); await runtime.settle();
      assert.ok(runtime.view.restoreError);
      assert.equal(runtime.view.formOpen, true);
      assert.equal(runtime.view.editingId, null);
      assert.equal(posts(runtime).length, 0);
      assert.equal(keys, 0, "no fresh retry identity is minted");
      assert.equal(storage.values.get(attemptSlot), raw);
      assert.ok(localStored.has(prefillKey));
    } finally { runtime.dispose(); }
  });
}

test("getItem errors are not empty storage and leave the original record untouched", () => {
  const { storage, raw } = recoveryRecord();
  const denied = { ...storage, getItem: () => { throw new Error("synthetic getItem denial"); } };
  assert.throws(() => helpers.restoreSalesCreateAttempt(denied, workspace, actor), /SalesAttemptRestoreError/);
  assert.equal(helpers.persistSalesCreateAttempt(denied, recoveryRecord().attempt), false);
  helpers.clearPersistedSalesCreateAttempt(denied, recoveryRecord().attempt);
  assert.equal(storage.values.get(attemptSlot), raw);
});

for (const phase of ["mount", "new-submit"] as const) {
  test(`transient getItem denial at ${phase} requires explicit re-read and recovers the original key without automatic POST`, async () => {
    const { raw, attempt } = recoveryRecord();
    const sessionStored = new Map<string, string>(phase === "mount" ? [[attemptSlot, raw]] : []);
    const prefillKey = `negis_deal_prefill::${workspace}`;
    const localStored = new Map([["negis_workspace_selector", workspace]]);
    if (phase === "mount") localStored.set(prefillKey, JSON.stringify({ title: "Synthetic held prefill" }));
    let denied = phase === "mount", keys = 0;
    const runtime = await createSalesRetryRuntime(workspace, async method => method === "GET" ? list() : success(true), {
      sessionStored, localStored, randomUUID: () => { keys++; return key; },
      sessionGetItem: name => {
        if (denied) throw new Error("synthetic temporary denial");
        return sessionStored.get(name) ?? null;
      },
    });
    try {
      if (phase === "new-submit") {
        await fill(runtime);
        sessionStored.set(attemptSlot, raw);
        denied = true;
        runtime.view.submitForm(); await runtime.settle();
      }
      assert.ok(runtime.view.restoreError);
      assert.equal(posts(runtime).length, 0);
      assert.equal(sessionStored.get(attemptSlot), raw);
      runtime.view.retrySaleRecovery(); await runtime.settle();
      assert.ok(runtime.view.restoreError, "re-read while still denied stays blocked");
      denied = false;
      runtime.view.openAdd(); runtime.view.submitForm(); await runtime.settle();
      assert.ok(runtime.view.restoreError, "storage becoming readable does not automatically unblock");
      assert.equal(posts(runtime).length, 0);
      runtime.view.retrySaleRecovery(); await runtime.settle();
      assert.equal(runtime.view.restoreError, "");
      assert.equal(runtime.view.unconfirmedCreate, true);
      assert.equal(runtime.view.form.title, item.title);
      assert.equal(runtime.view.form.notes, "Synthetic retained note");
      assert.equal(runtime.view.form.amountTenge, "1234.50");
      assert.equal(posts(runtime).length, 0, "recovery never dispatches");
      assert.equal(keys, 0);
      if (phase === "mount") assert.ok(localStored.has(prefillKey));
      runtime.view.submitForm(); await runtime.settle();
      assert.deepEqual(posts(runtime)[0].body, { ...attempt.payload, requestKey: attempt.requestKey });
      assert.equal(keys, 0);
      assert.equal(sessionStored.size, 0, "cleared only after confirmed keyed success");
    } finally { runtime.dispose(); }
  });
}

test("corruption after an empty mount is checked again before minting a new key", async () => {
  let keys = 0;
  const runtime = await createSalesRetryRuntime(workspace, async method => method === "GET" ? list() : success(), {
    randomUUID: () => { keys++; return key; },
  });
  try {
    await fill(runtime);
    const raw = JSON.stringify({ ...validRecord, payload: {} });
    runtime.sessionStored.set(attemptSlot, raw);
    runtime.view.submitForm(); await runtime.settle();
    assert.ok(runtime.view.restoreError);
    assert.equal(runtime.view.form.title, item.title);
    assert.equal(keys, 0);
    assert.equal(posts(runtime).length, 0);
    assert.equal(runtime.sessionStored.get(attemptSlot), raw);
  } finally { runtime.dispose(); }
});

test("a same-scope record changed during an uncertain attempt is neither overwritten nor re-keyed", async () => {
  let keys = 0;
  const runtime = await createSalesRetryRuntime(workspace, async method => {
    if (method === "GET") return list();
    throw new Error("synthetic lost reply");
  }, { randomUUID: () => { keys++; return key; } });
  try {
    await fill(runtime);
    runtime.view.submitForm(); await runtime.settle();
    const saved = JSON.parse(runtime.sessionStored.get(attemptSlot)!) as { payload: Record<string, unknown> };
    saved.payload.amountMinor = 1;
    const tampered = JSON.stringify(saved);
    runtime.sessionStored.set(attemptSlot, tampered);
    runtime.view.submitForm(); await runtime.settle();
    assert.ok(runtime.view.restoreError);
    runtime.view.retrySaleRecovery(); await runtime.settle();
    assert.ok(runtime.view.restoreError);
    assert.equal(runtime.view.unconfirmedCreate, true);
    assert.equal(posts(runtime).length, 1);
    assert.equal(keys, 1);
    assert.equal(runtime.sessionStored.get(attemptSlot), tampered);
  } finally { runtime.dispose(); }
});

test("ordinary absent storage permits a fresh keyed create", async () => {
  const runtime = await createSalesRetryRuntime(workspace, async method => method === "GET" ? list() : success());
  try {
    assert.equal(runtime.view.restoreError, "");
    assert.equal(runtime.sessionStored.size, 0);
    await fill(runtime);
    runtime.view.submitForm(); await runtime.settle();
    assert.equal(posts(runtime).length, 1);
    assert.match(String(posts(runtime)[0].body.requestKey), /^[0-9a-f-]{14}4[0-9a-f-]{21}$/i);
    assert.equal(runtime.view.formOpen, false);
  } finally { runtime.dispose(); }
});

const releasableRefusals = [[400, "sale_request_invalid"], [401, "authentication_required"],
  [403, "sale_request_access_denied"], [422, "validation"], [409, "arrival_payment"],
  [503, "sale_create_unavailable"]] as const;

for (const [status, code] of releasableRefusals) {
  test(`initial confirmed ${code} releases the form; earlier uncertainty never releases`, async () => {
    const attempt = helpers.newSalesCreateAttempt(workspace, actor, item, () => key);
    assert.equal(helpers.canReleaseSalesAttempt(attempt, status, { success: false, code }), true);
    attempt.uncertain = true;
    assert.equal(helpers.canReleaseSalesAttempt(attempt, status, { success: false, code }), false);
    let writes = 0;
    const runtime = await createSalesRetryRuntime(workspace, async method => method === "GET" ? list()
      : ++writes === 1 ? refusal(status, code) : success());
    try {
      await fill(runtime);
      runtime.view.submitForm(); await runtime.settle();
      assert.equal(runtime.sessionStored.size, 0);
      assert.equal(runtime.view.unconfirmedCreate, false);
      assert.equal(runtime.view.formOpen, true);
      assert.equal(runtime.view.form.title, item.title);
      runtime.view.setForm({ ...runtime.view.form, title: "Synthetic corrected sale" }); runtime.render();
      runtime.view.submitForm(); await runtime.settle();
      assert.notEqual(posts(runtime)[0].body.requestKey, posts(runtime)[1].body.requestKey);
      assert.equal(posts(runtime)[1].body.title, "Synthetic corrected sale");
    } finally { runtime.dispose(); }
  });
}

for (const code of ["sale_request_conflict", "sale_request_unavailable", "unknown_conflict"] as const) {
  test(`initial 409 ${code} retains the exact intent and cannot turn into a new key`, async () => {
    const attempt = helpers.newSalesCreateAttempt(workspace, actor, item, () => key);
    assert.equal(helpers.canReleaseSalesAttempt(attempt, 409, { success: false, code }), false);
    let writes = 0, keys = 0;
    const runtime = await createSalesRetryRuntime(workspace, async method => {
      if (method === "GET") return list();
      if (++writes === 1) return refusal(409, code);
      return writes === 2 ? refusal(503, "sale_create_unavailable") : success(true);
    }, { randomUUID: () => { keys++; return key; } });
    try {
      await fill(runtime);
      const entered = JSON.stringify(runtime.view.form);
      runtime.view.submitForm(); await runtime.settle();
      assert.equal(runtime.view.unconfirmedCreate, true);
      assert.equal(runtime.sessionStored.size, 1);
      assert.equal(runtime.view.items.length, 0);
      runtime.view.closeSaleForm(); runtime.view.openAdd(); runtime.view.openEdit(item);
      await runtime.settle();
      assert.equal(runtime.view.editingId, null);
      assert.equal(runtime.view.formOpen, true);
      assert.equal(JSON.stringify(runtime.view.form), entered);
      runtime.view.submitForm(); await runtime.settle();
      assert.equal(runtime.view.unconfirmedCreate, true, "later 503 cannot release the retained intent");
      assert.equal(runtime.sessionStored.size, 1);
      runtime.view.submitForm(); await runtime.settle();
      assert.equal(keys, 1);
      assert.deepEqual(posts(runtime).map(call => call.body), Array(3).fill(posts(runtime)[0].body));
      assert.equal(runtime.view.items.length, 1);
      assert.equal(runtime.sessionStored.size, 0);
    } finally { runtime.dispose(); }
  });
}

for (const [status, code] of releasableRefusals) {
  test(`after network uncertainty ${status} ${code} cannot clear the stored attempt`, async () => {
    let writes = 0;
    const runtime = await createSalesRetryRuntime(workspace, async method => {
      if (method === "GET") return list();
      if (++writes === 1) throw new Error("synthetic lost reply");
      return writes === 2 ? refusal(status, code) : success(true);
    });
    try {
      await fill(runtime);
      runtime.view.submitForm(); await runtime.settle();
      const original = posts(runtime)[0].body;
      runtime.view.submitForm(); await runtime.settle();
      assert.equal(runtime.view.unconfirmedCreate, true);
      assert.equal(runtime.sessionStored.size, 1);
      assert.equal(runtime.view.formOpen, true);
      assert.equal(runtime.view.items.length, 0);
      runtime.view.submitForm(); await runtime.settle();
      assert.deepEqual(posts(runtime).map(call => call.body), Array(3).fill(original));
      assert.equal(runtime.view.items.length, 1);
      assert.equal(runtime.sessionStored.size, 0);
    } finally { runtime.dispose(); }
  });
}

test("a legitimate new sale after confirmation gets a new key", async () => {
  const runtime = await createSalesRetryRuntime(workspace, async method => method === "GET" ? list() : success());
  try {
    await fill(runtime);
    runtime.view.submitForm(); await runtime.settle();
    await fill(runtime);
    runtime.view.submitForm(); await runtime.settle();
    assert.equal(posts(runtime).length, 2);
    assert.notEqual(posts(runtime)[0].body.requestKey, posts(runtime)[1].body.requestKey);
    assert.equal(runtime.view.items.length, 1, "merge is by confirmed ID even when server returns the same fixture row");
  } finally { runtime.dispose(); }
});

test("real form controls and every close path stay locked during dispatch and uncertainty", async () => {
  const source = await readFile(new URL("../../artifacts/negis/src/pages/SalesPage.tsx", import.meta.url), "utf8");
  assert.match(source, /<fieldset[^>]*disabled=\{saving \|\| unconfirmedCreate \|\| Boolean\(restoreError\)\}/);
  assert.match(source, /dispatchGuard: isCurrent/);
  assert.match(source, /expectedUserId: attempt.actorId/);
  assert.match(source, /useLayoutEffect\(/);
  assert.match(source, /Проверить сохранение/);
  assert.match(source, /onClick=\{retrySaleRecovery\}/);
  assert.match(source, /Повторить чтение/);
  assert.match(source, /role="alert"/);
  assert.doesNotMatch(source, /onClick=\{\(\) => setFormOpen\(false\)\}/);
  assert.doesNotMatch(source, /localStorage\.setItem\([^\n]*(attempt|payload|requestKey)/);
});

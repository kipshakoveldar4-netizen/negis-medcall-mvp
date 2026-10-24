import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script } from "node:vm";

// Run: node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-control-browser-fixture.test.ts
// Real fixture factory/component/Auth mock; only streams, React hooks and listeners are doubled.
// No listening sockets, browser, application Auth, configuration, or external HTTP.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const fixturePath = "scripts/fixtures/control-subscription-browser";
type Snapshot = {
  counters: Record<string, number>; ownerCounters: Record<string, number>;
  holdOwnerReply: boolean; ownerReplyPending: boolean;
  heldOwnerReply: { method: string; path: string } | null;
  receipts: number; clinics: unknown[]; [key: string]: unknown;
};
type Factory = { snapshot(): Snapshot; handle(req: unknown, res: unknown): boolean; close(): void };
const { createControlSubscriptionHttpFixture } = await import(pathToFileURL(path.join(root, `${fixturePath}.mjs`)).href) as {
  createControlSubscriptionHttpFixture(): Factory;
};
function compile(source: string, fileName: string) {
  return ts.transpileModule(source, { fileName, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
}
const uiCode = compile(await readFile(path.join(root, `${fixturePath}.tsx`), "utf8"), `${fixturePath}.tsx`);
const mockCode = compile(await readFile(path.join(root, `${fixturePath}-mocks.ts`), "utf8"), `${fixturePath}-mocks.ts`);
const CONTROL = "/__fixture/control-subscription", OPERATORS = "/api/crm/platform-operators";
const INVITE = "/api/crm/platform-onboarding", CREDS = "/api/crm/platform-onboarding-credentials";
const REISSUE = "/api/crm/platform-invitation-reissue", SUBS = "/api/crm/platform-subscriptions";
const W1 = "aaaaaaaa-1111-4111-8111-111111111111", OP = "dddddddd-1111-4111-8111-000000000001";
const SUB = "cccccccc-1111-4111-8111-000000000001", KEY = "eeeeeeee-1111-4111-8111-111111111111";
const onboarding = { name: "QA reset", ownerName: "QA owner", ownerEmail: "qa-reset@example.invalid",
  vertical: "clinic", purpose: "clinic_services", timeZone: "Asia/Almaty" };
const replace = { workspaceId: W1, requestKey: KEY, expectedActiveId: SUB,
  plan: "basic", priceMinor: 123400, billingPeriod: "monthly", currency: "KZT" };
const bounded = { timeout: 5_000 };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 16; i++) await Promise.resolve(); await setImmediate(); }

class MemoryResponse extends EventEmitter {
  statusCode = 0;
  destroyed = false;
  writableEnded = false;
  body: any;
  private completion = deferred<void>();
  done = this.completion.promise;
  writeHead(status: number) { this.statusCode = status; return this; }
  end(bytes: string) {
    this.body = JSON.parse(bytes); this.writableEnded = true;
    this.completion.resolve(); this.emit("finish"); this.emit("close");
  }
  destroy() { this.destroyed = true; this.completion.resolve(); this.emit("close"); }
}
function memory(t: TestContext) {
  const fixture = createControlSubscriptionHttpFixture();
  const streams: PassThrough[] = [];
  t.after(async () => { fixture.close(); for (const req of streams) req.destroy(); await flush(); });
  function start(url: string, method = "GET", actor = "A") {
    const req = Object.assign(new PassThrough(), { url, method,
      headers: { host: "127.0.0.1:5236", "content-type": "application/json", authorization: `Bearer fixture-control-${actor}` },
      socket: { remoteAddress: "127.0.0.1" } });
    streams.push(req);
    const res = new MemoryResponse();
    assert.equal(fixture.handle(req, res), true);
    if (method === "GET") req.end();
    return { req, res };
  }
  async function call(url: string, method = "GET", body?: unknown, actor = "A") {
    const pending = start(url, method, actor);
    if (method !== "GET") pending.req.end(JSON.stringify(body));
    await pending.res.done;
    return pending.res;
  }
  return { fixture, start, call, reset: () => call(CONTROL, "POST", { command: "reset" }),
    arm: () => call(CONTROL, "POST", { command: "holdOwnerReply", enabled: true }),
    release: () => call(CONTROL, "POST", { command: "releaseOwnerReply" }) };
}

for (const [label, route, method, body] of [
  ["operator PATCH", OPERATORS, "PATCH", { id: OP, action: "approve" }],
  ["onboarding", INVITE, "POST", onboarding],
  ["credentials", CREDS, "POST", { ...onboarding, password: "Synthetic-not-a-real-password" }],
  ["replacement", SUBS, "POST", replace],
  ["status PATCH", SUBS, "PATCH", { workspaceId: W1, requestKey: KEY, subscriptionId: SUB,
    expectedUpdatedAt: "2026-10-24T08:00:00.000Z", expectedStatus: "active", status: "paused" }],
  ["abandon", SUBS, "POST", { workspaceId: W1, requestKey: KEY, abandon: true }],
  ["late fail control", CONTROL, "POST", { command: "failAfterCommit", enabled: true }],
  ["late hold control", CONTROL, "POST", { command: "holdOwnerReply", enabled: true }],
  ["late release control", CONTROL, "POST", { command: "releaseOwnerReply" }],
  ["late reset control", CONTROL, "POST", { command: "reset" }],
] as const) {
  test(`Fixture reset: ${label} awaiting body bytes cannot change or publish into the new epoch`, bounded, async (t) => {
    const m = memory(t), old = m.start(route, method), bytes = JSON.stringify(body);
    old.req.write(bytes.slice(0, 1)); await flush();
    await m.reset();
    const clean = m.fixture.snapshot();
    old.req.end(bytes.slice(1)); await old.res.done; await flush();
    assert.equal(old.res.destroyed, true, "Old work must be discarded rather than answered in a fresh epoch");
    assert.deepEqual(m.fixture.snapshot(), clean, "No reset counters, receipts, flags, or state may change");
  });
}

test("Fixture reset: an old reissue cannot act on a new epoch", bounded, async (t) => {
  const m = memory(t), created = await m.call(INVITE, "POST", onboarding);
  const bytes = JSON.stringify({ workspaceId: created.body.data.workspaceId }), old = m.start(REISSUE, "POST");
  old.req.write(bytes.slice(0, 1)); await flush(); await m.reset();
  const clean = m.fixture.snapshot();
  old.req.end(bytes.slice(1)); await old.res.done;
  assert.equal(old.res.destroyed, true); assert.deepEqual(m.fixture.snapshot(), clean);
});

for (const failure of ["invalid JSON", "body limit", "stream error"] as const) {
  test(`Fixture reset: late ${failure} cannot increment fresh refusal counters`, bounded, async (t) => {
    const m = memory(t), old = m.start(OPERATORS, "PATCH");
    old.req.write("{"); await flush(); await m.reset();
    const clean = m.fixture.snapshot();
    if (failure === "stream error") old.req.destroy(new Error("Synthetic old stream failure"));
    else old.req.end(failure === "body limit" ? Buffer.alloc(8193, 0x61) : "invalid}");
    await old.res.done; await flush();
    assert.equal(old.res.destroyed, true); assert.deepEqual(m.fixture.snapshot(), clean);
  });
}

test("Fixture reset: current malformed input still counts as a refusal", bounded, async (t) => {
  const m = memory(t), request = m.start(OPERATORS, "PATCH");
  request.req.end("{invalid}"); await request.res.done;
  assert.equal(request.res.statusCode, 400); assert.equal(m.fixture.snapshot().counters.refused, 1);
});

test("Fixture hold: GET and B denial cannot consume the mutation hold", bounded, async (t) => {
  const m = memory(t); await m.arm();
  const get = m.start(`${OPERATORS}?offset=0`); await flush();
  assert.equal(get.res.writableEnded, true, "List reads must never be held");
  assert.equal(get.res.statusCode, 200);
  assert.equal((await m.call(OPERATORS, "PATCH", { id: OP, action: "approve" }, "B")).statusCode, 404);
  const state = m.fixture.snapshot();
  assert.equal(state.holdOwnerReply, true); assert.equal(state.heldOwnerReply, null);
  assert.equal(state.ownerCounters.mutations, 0);
});

for (const [route, method, body] of [[OPERATORS, "PATCH", { id: OP, action: "approve" }],
  [CREDS, "POST", { ...onboarding, password: "Synthetic-private-request-marker" }]] as const) {
  test(`Fixture hold: ${method} ${route} exposes only method/path and release never repeats its mutation`, bounded, async (t) => {
    const m = memory(t); await m.arm();
    const pending = m.start(route, method); pending.req.end(JSON.stringify(body)); await flush();
    const state = m.fixture.snapshot();
    assert.equal(pending.res.writableEnded, false); assert.equal(state.ownerCounters.mutations, 1);
    assert.deepEqual(state.heldOwnerReply, { method, path: route });
    assert.equal(state.holdOwnerReply, false);
    assert.ok(!JSON.stringify(state).includes("Synthetic-private-request-marker"));
    await m.release(); await pending.res.done;
    assert.equal(pending.res.statusCode, method === "PATCH" ? 200 : 201);
    assert.equal(m.fixture.snapshot().ownerCounters.mutations, 1);
    assert.equal(m.fixture.snapshot().heldOwnerReply, null);
  });
}

test("Fixture hold: a conflicting onboarding POST cannot consume the mutation hold", bounded, async (t) => {
  const m = memory(t); await m.call(INVITE, "POST", onboarding); await m.arm();
  const duplicate = m.start(INVITE, "POST"); duplicate.req.end(JSON.stringify(onboarding)); await flush();
  assert.equal(duplicate.res.writableEnded, true); assert.equal(duplicate.res.statusCode, 409);
  assert.equal(m.fixture.snapshot().holdOwnerReply, true); assert.equal(m.fixture.snapshot().ownerCounters.mutations, 1);
});

test("Fixture hold: reset discards the old reply and late close cannot clear a new hold", bounded, async (t) => {
  const m = memory(t); await m.arm();
  const old = m.start(OPERATORS, "PATCH"); old.req.end(JSON.stringify({ id: OP, action: "approve" })); await flush();
  await m.reset(); assert.equal(old.res.destroyed, true);
  assert.equal(m.fixture.snapshot().heldOwnerReply, null); assert.equal(m.fixture.snapshot().ownerCounters.mutations, 0);
  await m.arm();
  const current = m.start(OPERATORS, "PATCH"); current.req.end(JSON.stringify({ id: OP, action: "approve" })); await flush();
  old.res.emit("close");
  assert.deepEqual(m.fixture.snapshot().heldOwnerReply, { method: "PATCH", path: OPERATORS });
  await m.release(); await current.res.done; assert.equal(m.fixture.snapshot().ownerCounters.mutations, 1);
});

test("Fixture counters: two in-memory mutations then Reset0 preserves the recorded manual-history convention", bounded, async (t) => {
  const m = memory(t);
  await m.call(OPERATORS, "PATCH", { id: OP, action: "approve" });
  await m.call(OPERATORS, "PATCH", { id: OP, action: "suspend" });
  assert.equal(m.fixture.snapshot().ownerCounters.mutations, 2);
  await m.reset();
  assert.ok(Object.values(m.fixture.snapshot().ownerCounters).every((value) => value === 0));
  assert.ok(Object.values(m.fixture.snapshot().counters).every((value) => value === 0));
});

type UiNode = { type: unknown; props: Record<string, any> };
function nodes(value: any): UiNode[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  return value?.props ? [value, ...nodes(value.props.children)] : [];
}
function textOf(value: any): string {
  if (Array.isArray(value)) return value.map(textOf).join("");
  return value?.props ? textOf(value.props.children) : value == null ? "" : String(value);
}
function state(mutations: number) {
  return { failAfterCommit: false, holdOwnerReply: false, ownerReplyPending: false, heldOwnerReply: null,
    counters: { commits: 0, replays: 0, abandons: 0, lostResponses: 0 },
    ownerCounters: { reads: 0, mutations, operatorChanges: mutations, onboardingInvites: 0, credentials: 0, reissues: 0, denied: 0 } };
}
function ui(t: TestContext) {
  const slots: any[] = [], effects: Array<() => void | (() => void)> = [], cleanups: Array<() => void> = [];
  const calls: Array<{ command?: Record<string, unknown>; result: ReturnType<typeof deferred<ReturnType<typeof state>>> }> = [];
  const listeners = new Map<string, Set<() => void>>();
  let cursor = 0, rootNode!: UiNode, resetCalls = 0, writes = 0;
  const jsx = (type: unknown, props: UiNode["props"]): UiNode => ({ type, props });
  new Script(uiCode).runInNewContext({ exports: {}, document: { getElementById: () => ({}) },
    addEventListener(name: string, fn: () => void) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn); },
    removeEventListener(name: string, fn: () => void) { listeners.get(name)?.delete(fn); },
    require(name: string) {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "react") return { StrictMode: "StrictMode", useSyncExternalStore: () => ({ actor: "A", revision: 0 }),
        useState(initial: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
          return [slots[i], (next: unknown) => { writes++; slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; },
        useRef(initial: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
        useEffect(fn: () => void | (() => void)) { const i = cursor++; if (!(i in slots)) { slots[i] = true; effects.push(fn); } },
      };
      if (name === "react-dom/client") return { createRoot: () => ({ render(node: UiNode) { rootNode = node; } }) };
      if (name === "../../artifacts/medina-control/src/App") return { default: () => null };
      if (name === "./control-subscription-browser-mocks") return {
        subscriptionAuthFixture: { subscribe() {}, snapshot() {}, select() {}, aba() {}, silentB() {}, refresh() {}, reset() { resetCalls++; } },
        subscriptionFixtureControl(command?: Record<string, unknown>) {
          const result = deferred<ReturnType<typeof state>>(); calls.push({ command, result }); return result.promise;
        },
      };
      assert.fail(`Unexpected fixture UI import: ${name}`);
    },
  }, { timeout: 1000 });
  const component = rootNode.props.children.type as () => UiNode;
  function render() { cursor = 0; return component(); }
  function unmount() { for (const cleanup of cleanups.splice(0)) cleanup(); }
  render(); for (const effect of effects.splice(0)) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
  t.after(async () => { unmount(); for (const call of calls) call.result.reject(new Error("Synthetic cleanup")); await flush(); });
  return { calls, render, unmount, resetCalls: () => resetCalls, writes: () => writes,
    refresh() { for (const fn of listeners.get("qa-control-subscription-http") || []) fn(); },
    click(label: string) { const button = nodes(render()).find((node) => node.type === "button" && textOf(node.props.children) === label);
      assert.ok(button, `Missing actual fixture button: ${label}`); button.props.onClick(); },
    ownerText() { return textOf(nodes(render()).find((node) => node.props["data-testid"] === "control-owner-state")); },
    hasAlert() { return nodes(render()).some((node) => node.props.role === "alert"); },
  };
}

for (const completion of ["success", "error"] as const) {
  test(`Fixture UI: late refresh ${completion} cannot overwrite a newer reset`, bounded, async (t) => {
    const view = ui(t); view.click("Reset fixture");
    view.calls[1].result.resolve(state(0)); await flush();
    assert.equal(view.resetCalls(), 1);
    if (completion === "success") view.calls[0].result.resolve(state(7)); else view.calls[0].result.reject(new Error("Old refresh"));
    await flush();
    assert.ok(view.ownerText().includes("Owner mutations 0")); assert.equal(view.hasAlert(), false);
  });
  test(`Fixture UI: late automatic refresh ${completion} cannot replace a newer read`, bounded, async (t) => {
    const view = ui(t); view.refresh();
    view.calls[1].result.resolve(state(2)); await flush();
    if (completion === "success") view.calls[0].result.resolve(state(1)); else view.calls[0].result.reject(new Error("Old read"));
    await flush(); assert.ok(view.ownerText().includes("Owner mutations 2")); assert.equal(view.hasAlert(), false);
  });
}

test("Fixture UI: automatic refresh is suppressed while a reset command owns the state", bounded, async (t) => {
  const view = ui(t); view.click("Reset fixture"); view.refresh();
  assert.equal(view.calls.length, 2);
  view.calls[1].result.resolve(state(0)); await flush(); assert.equal(view.resetCalls(), 1);
});

for (const completion of ["success", "error"] as const) {
  test(`Fixture UI: command ${completion} after unmount cannot write state or reset Auth`, bounded, async (t) => {
    const view = ui(t); view.click("Reset fixture"); view.unmount(); const writes = view.writes();
    if (completion === "success") view.calls[1].result.resolve(state(0)); else view.calls[1].result.reject(new Error("Old command"));
    await flush(); assert.equal(view.writes(), writes); assert.equal(view.resetCalls(), 0);
  });
}

function authMock(blockStorage = false) {
  const exports: Record<string, any> = {}, values = new Map<string, string>(), removals: string[] = [];
  const context = { exports, URL, Request, Event, queueMicrotask,
    location: { protocol: "http:", hostname: "127.0.0.1", pathname: "/", search: "?subscriptions=qa", origin: "http://127.0.0.1:5236" },
    sessionStorage: { getItem: (key: string) => values.get(key) ?? null,
      setItem(key: string, value: string) { if (blockStorage) throw new Error("Synthetic blocked storage"); values.set(key, value); },
      removeItem(key: string) { removals.push(key); if (blockStorage) throw new Error("Synthetic blocked storage"); values.delete(key); } },
    fetch() { assert.fail("No network is available to the synthetic Auth mock tests"); }, dispatchEvent() {},
  };
  new Script(mockCode).runInNewContext(context, { timeout: 1000 });
  return { exports, removals };
}

test("Fixture Auth: storage errors cannot prevent reset's normal null-to-A transitions", bounded, async () => {
  const { exports, removals } = authMock(true), auth = exports.subscriptionAuthFixture;
  auth.select("B");
  const events: Array<{ event: string; actor: string | null }> = [];
  exports.supabase.auth.onAuthStateChange((event: string, value: any) => events.push({ event, actor: value?.user.id || null }));
  await flush(); events.length = 0;
  assert.doesNotThrow(() => auth.reset());
  assert.deepEqual(events.map(({ event }) => event), ["SIGNED_OUT", "SIGNED_IN"]);
  assert.equal(auth.snapshot().actor, "A");
  assert.ok(removals.some((key) => key.includes("11111111")) && removals.some((key) => key.includes("22222222")));
});

test("Fixture Auth: Silent SDK B updates getSession and QA listeners without firing SDK auth listeners", bounded, async () => {
  const { exports } = authMock(), auth = exports.subscriptionAuthFixture;
  const sdkEvents: string[] = [], controls: string[] = [];
  exports.supabase.auth.onAuthStateChange((event: string) => sdkEvents.push(event)); await flush(); sdkEvents.length = 0;
  auth.subscribe(() => controls.push(auth.snapshot().actor));
  const previous = auth.snapshot().revision;
  assert.equal(typeof auth.silentB, "function"); auth.silentB();
  assert.equal(auth.snapshot().actor, "B"); assert.ok(auth.snapshot().revision > previous);
  assert.deepEqual(sdkEvents, []); assert.deepEqual(controls, ["B"]);
  assert.equal((await exports.supabase.auth.getSession()).data.session.user.id, "22222222-2222-4222-8222-222222222222");
  auth.reset(); assert.equal(auth.snapshot().actor, "A"); assert.deepEqual(sdkEvents, ["SIGNED_OUT", "SIGNED_IN"]);
});

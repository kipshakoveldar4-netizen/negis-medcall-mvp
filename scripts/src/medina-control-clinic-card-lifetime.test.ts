import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Whole actual ClinicCard, controlFetch, billing and vertical modules. React
// scheduling, SDK sessions, HTTP and clipboard delivery are explicit doubles.
// No real credentials, invitation, subscription, messages or network calls.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const CARD = "artifacts/medina-control/src/screens/ClinicCard.tsx";
const API = "artifacts/medina-control/src/lib/api.ts";
const PLANS = "lib/billing/plans.ts";
const TERMS = "lib/vertical/terms.ts";
const scripts = new Map<string, Script>();
for (const file of [CARD, API, PLANS, TERMS]) {
  const compiled = ts.transpileModule(await readFile(path.join(root, file), "utf8"), {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  assert.deepEqual(compiled.diagnostics ?? [], [], `Actual ${file} must transpile`);
  scripts.set(file, new Script(compiled.outputText, { filename: file }));
}
type Json = Record<string, any>;
type Element = { type: unknown; props: Json };
type Child = Element | string | number | boolean | null | undefined | Child[];
type Effect = () => void | (() => void);
type Slot = { kind: string; value?: any; set?: (next: any) => void; deps?: readonly unknown[]; create?: Effect; cleanup?: () => void; pending?: boolean };
const ACTOR_A = "11111111-1111-4111-8111-111111111111";
const ACTOR_B = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORIGIN = "https://clinic-card.fixture.invalid";
const CARD_ROUTE = "/api/crm/platform-clinic";
const RECOS_ROUTE = "/api/crm/platform-recommendations";
const REISSUE_ROUTE = "/api/crm/platform-invitation-reissue";
const LINK_A = "https://invitation.fixture.invalid/join?token=synthetic-A";
const LINK_B = "https://invitation.fixture.invalid/join?token=synthetic-B";
const jsx = (type: unknown, props: Json): Element => ({ type, props });
function nodes(child: Child): Element[] {
  if (Array.isArray(child)) return child.flatMap(nodes);
  return child && typeof child === "object" ? [child, ...nodes(child.props.children)] : [];
}
function text(child: Child): string {
  if (Array.isArray(child)) return child.map(text).join("");
  if (child && typeof child === "object") return text(child.props.children);
  return typeof child === "string" || typeof child === "number" ? String(child) : "";
}
function sameDeps(a?: readonly unknown[], b?: readonly unknown[]) {
  return !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}
function driver() {
  const slots: Slot[] = [];
  let cursor = 0, dirty = true, mounted = true, lateWrites = 0;
  let component!: () => Child;
  let tree: Child;
  let hookCount: number | undefined;
  function slot(kind: string, create: () => Slot) {
    const item = slots[cursor++] ??= create();
    assert.equal(item.kind, kind, "Actual hooks retain their order");
    return item;
  }
  const hooks = {
    useState(initial: any) {
      const state = slot("state", () => {
        const item: Slot = { kind: "state", value: typeof initial === "function" ? initial() : initial };
        item.set = (next) => {
          if (!mounted) { lateWrites++; return; }
          const value = typeof next === "function" ? next(item.value) : next;
          if (!Object.is(value, item.value)) { item.value = value; dirty = true; }
        };
        return item;
      });
      return [state.value, state.set];
    },
    useRef(initial: any) { return slot("ref", () => ({ kind: "ref", value: { current: initial } })).value; },
    useEffect(create: Effect, deps?: readonly unknown[]) {
      const item = slot("effect", () => ({ kind: "effect", create, deps, pending: true }));
      if (!sameDeps(item.deps, deps)) item.pending = true;
      item.create = create; item.deps = deps;
    },
  };
  return {
    hooks, mount(render: () => Child) { component = render; }, invalidate() { dirty = true; },
    commit() {
      if (!mounted || !dirty) return;
      dirty = false; cursor = 0;
      tree = component();
      hookCount ??= cursor;
      assert.equal(cursor, hookCount, "No conditional hooks");
      const effects = slots.filter((item) => item.kind === "effect" && item.pending);
      for (const item of effects) item.cleanup?.();
      for (const item of effects) { item.pending = false; item.cleanup = item.create!() || undefined; }
    },
    nodes: () => nodes(tree), text: () => text(tree), lateWrites: () => lateWrites,
    dispose() { if (!mounted) return; mounted = false; for (const item of slots) if (item.kind === "effect") item.cleanup?.(); },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Http = {
  url: URL; method: string; body: Json; authorization: string; bodyReads: number; settled: boolean; claimed: boolean;
  reply(value: unknown, status?: number): void;
  hold(status?: number): { release(value: unknown): void };
  lose(): void;
};
function card(workspaceId: string, ownerInside = false) {
  const label = workspaceId === WORKSPACE_A ? "A" : "B";
  return { success: true, data: {
    clinic: { id: workspaceId, name: `Synthetic clinic ${label}`, ownerEmail: `private-owner-${label}@example.invalid`,
      createdAt: "2026-10-25T00:00:00Z", vertical: "clinic", timeZone: "Asia/Almaty", plan: "standard",
      subscriptionStatus: "active", monthlyMinor: 3990000, currency: "KZT", billingPeriod: "monthly" },
    access: { staff: ownerInside ? [{ email: `private-owner-${label}@example.invalid`, role: "owner", status: "active", linked: true }] : [],
      ownerInvitations: [{ email: `private-owner-${label}@example.invalid`, role: "owner", status: "pending", createdAt: "2026-10-25T00:00:00Z", expiresAt: "2026-11-01T00:00:00Z" }],
      staffInvitations: [], ownerSignIn: { lastAt: "" } },
    counts: { staff: 0, doctors: 0, doctorsWithSchedule: 0, services: 0, whatsappChannels: 0, clients: 0 },
    weekly: [], signals: [],
  } };
}

async function fixture(t: TestContext) {
  const render = driver();
  const requests: Http[] = [];
  const releases: Array<() => void> = [];
  const clipboard: Array<{ value: string; resolve(): void }> = [];
  const timers: Array<{ callback: () => void; active: boolean }> = [];
  const listeners = new Set<(event: string, session: Json | null) => void>();
  let actor: string | null = ACTOR_A, tokenRevision = 0, workspaceId = WORKSPACE_A;
  const session = () => actor ? { user: { id: actor, email: "synthetic-actor@example.invalid" }, access_token: `synthetic-token:${actor}:${tokenRevision}` } : null;
  const auth = {
    async getSession() { return { data: { session: session() }, error: null }; },
    onAuthStateChange(callback: (event: string, value: Json | null) => void) {
      listeners.add(callback);
      return { data: { subscription: { unsubscribe() { listeners.delete(callback); } } } };
    },
  };
  function transport(address: string, init: RequestInit = {}) {
    const url = new URL(address);
    assert.equal(url.origin, ORIGIN, "Only the fake API origin is allowed");
    assert.ok([CARD_ROUTE, RECOS_ROUTE, REISSUE_ROUTE, "/api/crm/platform-whatsapp-number"].includes(url.pathname));
    const pending = deferred<Response>();
    const observe = (response: Response) => {
      Object.defineProperty(response, "json", { configurable: true, writable: true,
        value() { request.bodyReads++; return Response.prototype.json.call(response); } });
      return response;
    };
    const deliver = (response: Response) => { assert.equal(request.settled, false); request.settled = true; pending.resolve(observe(response)); };
    const request: Http = {
      url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : {},
      authorization: new Headers(init.headers).get("Authorization") || "", bodyReads: 0, settled: false, claimed: false,
      reply(value, status = 200) { deliver(new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })); },
      hold(status = 200) {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let released = false;
        const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
        const release = (value: unknown) => {
          if (released) return;
          released = true; controller.enqueue(new TextEncoder().encode(JSON.stringify(value))); controller.close();
        };
        releases.push(() => release({ success: false }));
        deliver(new Response(stream, { status, headers: { "content-type": "application/json" } }));
        return { release };
      },
      lose() { assert.equal(request.settled, false); request.settled = true; pending.reject(new TypeError("Synthetic response lost")); },
    };
    requests.push(request);
    // Ignore transport cancellation deliberately; the component must guard late delivery.
    return pending.promise;
  }
  const modules = new Map<string, Json>();
  function load(file: string): Json {
    const cached = modules.get(file);
    if (cached) return cached;
    const exports: Json = {};
    modules.set(file, exports);
    scripts.get(file)!.runInNewContext({
      exports, Error, TypeError, SyntaxError, Date, URL, Headers, Response, ReadableStream, TextEncoder, AbortController, AbortSignal,
      fetch: transport,
      navigator: { clipboard: { writeText(value: string) {
        const pending = deferred<void>(); clipboard.push({ value, resolve: () => pending.resolve() }); return pending.promise;
      } } },
      window: { setTimeout(callback: () => void) { timers.push({ callback, active: true }); return timers.length; },
        clearTimeout(id: number) { if (timers[id - 1]) timers[id - 1].active = false; } },
      require(name: string) {
        if (name === "react") return render.hooks;
        if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
        if (name === "../lib/api") return load(API);
        if (name === "../../../../lib/billing/plans") return load(PLANS);
        if (name === "../../../../lib/vertical/terms") return load(TERMS);
        if (name === "./supabase") return { controlConfig: { ready: true, apiOrigin: ORIGIN }, supabase: { auth } };
        assert.fail(`Unexpected ClinicCard harness import: ${name}`);
      },
    });
    return exports;
  }
  const api = load(API);
  await setImmediate();
  const component = load(CARD);
  const unsubscribe = api.subscribeControlActor(() => render.invalidate());
  render.mount(() => component.ClinicCard({ workspaceId, onBack() {} }));
  async function flush() { for (let index = 0; index < 8; index++) { render.commit(); await setImmediate(); } render.commit(); }
  function take(route: string, method = "GET", workspace?: string) {
    const request = requests.find((item) => !item.claimed && item.url.pathname === route && item.method === method
      && (!workspace || (method === "GET" ? item.url.searchParams.get("workspaceId") : item.body.workspaceId) === workspace));
    assert.ok(request, `Expected ${method} ${route} ${workspace ?? ""}`);
    request.claimed = true; return request;
  }
  async function ready(workspace = workspaceId, ownerInside = false) {
    await flush(); take(CARD_ROUTE, "GET", workspace).reply(card(workspace, ownerInside)); await flush();
    take(RECOS_ROUTE, "GET", workspace).reply({ success: true, data: { items: [], available: true } }); await flush();
  }
  function button(label: string) {
    const found = render.nodes().find((node) => node.type === "button" && text(node.props.children) === label);
    assert.ok(found, `Expected actual button: ${label}`); return found;
  }
  function click(label: string) { const node = button(label); assert.notEqual(node.props.disabled, true); node.props.onClick(); }
  function field(id: string, value: string) {
    const node = render.nodes().find((item) => item.props.id === id);
    assert.ok(node, `Expected actual field: ${id}`);
    node.props.onChange({ target: { value } });
  }
  async function reissue(link = LINK_A) {
    click("Перевыпустить приглашение"); await flush();
    take(REISSUE_ROUTE, "POST").reply({ success: true, data: { acceptUrl: link } }); await flush();
    take(CARD_ROUTE, "GET", workspaceId).reply(card(workspaceId)); await flush();
  }
  t.after(async () => {
    unsubscribe(); render.dispose();
    for (const release of releases) release();
    for (const call of requests) if (!call.settled) call.lose();
    for (const call of clipboard) call.resolve();
    await flush();
  });
  await flush();
  return {
    render, requests, clipboard, timers, flush, take, ready, button, click, field, reissue,
    setWorkspace(next: string) { workspaceId = next; render.invalidate(); render.commit(); },
    setActor(next: string | null) { actor = next; tokenRevision++; for (const listener of [...listeners]) listener(next ? "SIGNED_IN" : "SIGNED_OUT", session()); render.invalidate(); render.commit(); },
    refreshToken() { tokenRevision++; for (const listener of [...listeners]) listener("TOKEN_REFRESHED", session()); },
  };
}

test("current actor can read subscription/access history, reissue, refresh and copy the actual invitation", async (t) => {
  const f = await fixture(t); await f.ready();
  assert.ok(f.render.text().includes("Synthetic clinic A"));
  assert.ok(f.render.text().includes("private-owner-A@example.invalid"));
  await f.reissue();
  assert.ok(f.render.text().includes(LINK_A));
  f.click("Скопировать"); await f.flush();
  assert.equal(f.clipboard.length, 1); assert.equal(f.clipboard[0]!.value, LINK_A);
  f.clipboard[0]!.resolve(); await f.flush();
  assert.ok(f.render.text().includes("Скопировано"));
});

test("retained input and cancel handlers cannot alter the next workspace draft", async t => {
  const f = await fixture(t); await f.ready();
  f.click("Написать рекомендацию"); await f.flush();
  const ids = ["wa-number", "reco-title", "reco-body", "reco-action"];
  const old = ids.map(id => f.render.nodes().find(node => node.props.id === id)!.props.onChange);
  const cancel = f.button("Отмена").props.onClick;
  f.setWorkspace(WORKSPACE_B); await f.ready(WORKSPACE_B);
  f.click("Написать рекомендацию"); await f.flush();
  const values = ["123456789012345", "SYNTHETIC B title", "SYNTHETIC B body", "/services"];
  ids.forEach((id, index) => f.field(id, values[index]!)); await f.flush();
  for (const callback of old) callback({ target: { value: "SYNTHETIC stale A" } });
  cancel(); await f.flush();
  ids.forEach((id, index) => assert.equal(f.render.nodes().find(node => node.props.id === id)!.props.value, values[index]));
  assert.ok(f.button("Отправить"));
  assert.equal(f.requests.filter(request => request.method === "POST").length, 0);
});

test("late reissue for route A cannot reveal its invitation or refresh A into route B", async (t) => {
  const f = await fixture(t); await f.ready();
  f.click("Перевыпустить приглашение"); await f.flush();
  const old = f.take(REISSUE_ROUTE, "POST", WORKSPACE_A);
  f.setWorkspace(WORKSPACE_B);
  assert.equal(f.render.text().includes("private-owner-A@example.invalid"), false, "Do not paint the previous card before the route effect resets its state");
  await f.ready(WORKSPACE_B);
  old.reply({ success: true, data: { acceptUrl: LINK_A } }); await f.flush();
  assert.equal(f.render.text().includes(LINK_A), false, "Never show an old workspace's owner token in the new card");
  assert.ok(f.render.text().includes("Synthetic clinic B"));
  assert.equal(f.requests.filter((call) => !call.claimed && call.url.pathname === CARD_ROUTE && call.url.searchParams.get("workspaceId") === WORKSPACE_A).length, 0,
    "Old completion must not issue an old-workspace follow-up read");
});

test("a retained reissue callback cannot dispatch under a newly signed-in actor", async (t) => {
  const f = await fixture(t); await f.ready();
  const staleClick = f.button("Перевыпустить приглашение").props.onClick;
  const before = f.requests.length;
  f.setActor(ACTOR_B);
  staleClick(); await f.flush();
  assert.equal(f.requests.length, before, "Do not authorize an old screen action with the new actor's token");
  assert.equal(f.render.text().includes("private-owner-A@example.invalid"), false);
});

test("a reissue body already being read cannot publish an old workspace's owner token after navigation", async (t) => {
  const f = await fixture(t); await f.ready();
  f.click("Перевыпустить приглашение"); await f.flush();
  const request = f.take(REISSUE_ROUTE, "POST", WORKSPACE_A);
  const body = request.hold(); await f.flush();
  assert.equal(request.bodyReads, 1, "Exercise actual Response.json already awaiting private bytes");
  f.setWorkspace(WORKSPACE_B); await f.ready(WORKSPACE_B);
  const count = f.requests.length;
  body.release({ success: true, data: { acceptUrl: LINK_A } }); await f.flush();
  assert.equal(f.render.text().includes(LINK_A), false);
  assert.ok(f.render.text().includes("Synthetic clinic B"));
  assert.equal(f.requests.length, count);
});

test("an old route callback cannot reissue after A-to-B-to-A navigation", async (t) => {
  const f = await fixture(t); await f.ready();
  const stale = f.button("Перевыпустить приглашение").props.onClick;
  f.setWorkspace(WORKSPACE_B); await f.ready(WORKSPACE_B);
  f.setWorkspace(WORKSPACE_A); await f.ready(WORKSPACE_A);
  const count = f.requests.length;
  stale(); await f.flush();
  assert.equal(f.requests.length, count, "Returning to the same ID must not resurrect an old action lifetime");
});

test("401/403/404 headers immediately clear private data and owner links without reading the response body", async (t) => {
  for (const status of [401, 403, 404]) {
    await t.test(String(status), async (t) => {
      const f = await fixture(t); await f.ready(); await f.reissue();
      const staleCopy = f.button("Скопировать").props.onClick;
      f.click("Перевыпустить приглашение"); await f.flush();
      const request = f.take(REISSUE_ROUTE, "POST");
      request.hold(status); await f.flush();
      assert.equal(request.bodyReads, 0, "A blocked or malformed denial body must not delay access revocation");
      assert.equal(f.render.text().includes(LINK_A), false);
      assert.equal(f.render.text().includes("private-owner-A@example.invalid"), false);
      const before = f.requests.length; staleCopy(); await f.flush();
      assert.equal(f.clipboard.length, 0); assert.equal(f.requests.length, before);
    });
  }
});

test("pending old recommendation history cannot replace a new workspace's history", async (t) => {
  const f = await fixture(t);
  f.take(CARD_ROUTE, "GET", WORKSPACE_A).reply(card(WORKSPACE_A)); await f.flush();
  const old = f.take(RECOS_ROUTE, "GET", WORKSPACE_A).hold(); await f.flush();
  f.setWorkspace(WORKSPACE_B); await f.ready(WORKSPACE_B);
  old.release({ success: true, data: { items: [{ id: "old", title: "Private A recommendation", body: "old-owner-history", status: "sent", createdAt: "2026-10-25" }], available: true } });
  await f.flush();
  assert.equal(f.render.text().includes("Private A recommendation"), false);
  assert.ok(f.render.text().includes("Synthetic clinic B"));
});

test("synchronous double activation sends only one reissue request", async (t) => {
  const f = await fixture(t); await f.ready();
  const click = f.button("Перевыпустить приглашение").props.onClick;
  click(); click(); await f.flush();
  assert.equal(f.requests.filter((call) => call.url.pathname === REISSUE_ROUTE).length, 1);
});

test("network-lost reissue preserves the previously shown link but does not claim the operation was unsaved", async (t) => {
  const f = await fixture(t); await f.ready(); await f.reissue();
  f.click("Перевыпустить приглашение"); await f.flush(); f.take(REISSUE_ROUTE, "POST").lose(); await f.flush();
  assert.ok(f.render.text().includes(LINK_A), "Preserve existing server error-code semantics for the old link");
  assert.equal(f.render.text().includes("приглашение не перевыпущено"), false, "Lost response does not prove that no invitation was issued");
});

test("same-actor token refresh remains a positive action lifetime", async (t) => {
  const f = await fixture(t); await f.ready(); f.refreshToken();
  await f.reissue(LINK_B);
  assert.ok(f.render.text().includes(LINK_B));
  const write = f.requests.find((call) => call.url.pathname === REISSUE_ROUTE)!;
  assert.equal(write.authorization, `Bearer synthetic-token:${ACTOR_A}:1`);
});

test("unmount rejects retained callbacks and late completions without state writes", async (t) => {
  const f = await fixture(t); await f.ready();
  const stale = f.button("Перевыпустить приглашение").props.onClick;
  stale(); await f.flush(); const request = f.take(REISSUE_ROUTE, "POST");
  f.render.dispose(); const before = f.requests.length;
  stale(); request.reply({ success: true, data: { acceptUrl: LINK_A } }); await f.flush();
  assert.equal(f.requests.length, before);
  assert.equal(f.render.lateWrites(), 0);
});

test("late clipboard completion cannot mark a new workspace's invitation copied", async (t) => {
  const f = await fixture(t); await f.ready(); await f.reissue();
  f.click("Скопировать"); await f.flush();
  f.setWorkspace(WORKSPACE_B); await f.ready(WORKSPACE_B);
  f.clipboard[0]!.resolve(); await f.flush();
  assert.equal(f.timers.some((timer) => timer.active), false, "Old copy completion must not create a new screen timer");
  await f.reissue(LINK_B);
  assert.ok(f.render.text().includes("Скопировать"));
  assert.equal(f.render.text().includes("Скопировано"), false);
});

test("initial card denials are handled from headers without attempting JSON", async (t) => {
  for (const status of [401, 403, 404]) {
    await t.test(String(status), async (t) => {
      const f = await fixture(t);
      const request = f.take(CARD_ROUTE, "GET", WORKSPACE_A);
      request.hold(status); await f.flush();
      assert.equal(request.bodyReads, 0);
      assert.ok(f.render.text().includes("Страница не найдена"));
      assert.equal(f.requests.length, 1);
    });
  }
});

test("a delayed history denial removes an already displayed invitation before reading its body", async (t) => {
  const f = await fixture(t);
  f.take(CARD_ROUTE, "GET", WORKSPACE_A).reply(card(WORKSPACE_A)); await f.flush();
  const history = f.take(RECOS_ROUTE, "GET", WORKSPACE_A);
  await f.reissue();
  assert.ok(f.render.text().includes(LINK_A));
  history.hold(403); await f.flush();
  assert.equal(history.bodyReads, 0);
  assert.equal(f.render.text().includes(LINK_A), false);
  assert.equal(f.render.text().includes("private-owner-A@example.invalid"), false);
});

test("an old route's denial cannot close the new route or consume the obsolete private body", async (t) => {
  const f = await fixture(t);
  const old = f.take(CARD_ROUTE, "GET", WORKSPACE_A);
  f.setWorkspace(WORKSPACE_B); await f.ready(WORKSPACE_B);
  old.hold(403); await f.flush();
  assert.equal(old.bodyReads, 0);
  assert.ok(f.render.text().includes("Synthetic clinic B"));
  await f.reissue(LINK_B);
  assert.ok(f.render.text().includes(LINK_B));
});

test("server invitation invalidation codes retain their existing link and owner-state semantics", async (t) => {
  for (const code of ["reissue_incomplete", "owner_already_member", "reissue_failed"]) {
    await t.test(code, async (t) => {
      const f = await fixture(t); await f.ready(); await f.reissue();
      const stale = f.button("Перевыпустить приглашение").props.onClick;
      f.click("Перевыпустить приглашение"); await f.flush();
      f.take(REISSUE_ROUTE, "POST").reply({ success: false, code, error: "Synthetic action refusal" }, 409);
      await f.flush();
      const invalidated = code !== "reissue_failed";
      if (invalidated) {
        f.take(CARD_ROUTE, "GET", WORKSPACE_A).reply(card(WORKSPACE_A, code === "owner_already_member"));
        await f.flush();
      }
      assert.equal(f.render.text().includes(LINK_A), !invalidated);
      if (code === "owner_already_member") {
        const count = f.requests.length;
        stale(); await f.flush();
        assert.equal(f.requests.length, count, "A retained callback must respect the current owner membership");
      }
    });
  }
});

test("current actor can send a recommendation and reread the same workspace history", async (t) => {
  const f = await fixture(t); await f.ready();
  f.click("Написать рекомендацию"); await f.flush();
  f.field("reco-title", "Synthetic current recommendation");
  f.field("reco-body", "Synthetic current advice"); await f.flush();
  f.click("Отправить"); await f.flush();
  const post = f.take(RECOS_ROUTE, "POST", WORKSPACE_A);
  assert.equal(post.body.title, "Synthetic current recommendation");
  post.reply({ success: true }); await f.flush();
  f.take(RECOS_ROUTE, "GET", WORKSPACE_A).reply({ success: true, data: { available: true, items: [{
    id: "current", title: "Synthetic current recommendation", body: "Synthetic current advice", status: "sent", createdAt: "2026-10-25",
  }] } }); await f.flush();
  assert.ok(f.render.text().includes("Synthetic current recommendation"));
});

test("current actor can link a WhatsApp number and refresh the matching card", async (t) => {
  const f = await fixture(t); await f.ready();
  f.field("wa-number", "123456789012345"); await f.flush();
  f.click("Привязать номер"); await f.flush();
  const post = f.take("/api/crm/platform-whatsapp-number", "POST", WORKSPACE_A);
  assert.equal(post.body.phoneNumberId, "123456789012345");
  post.reply({ success: true, data: { alreadyLinked: false } }); await f.flush();
  const fresh = card(WORKSPACE_A); fresh.data.counts.whatsappChannels = 1;
  f.take(CARD_ROUTE, "GET", WORKSPACE_A).reply(fresh); await f.flush();
  assert.ok(f.render.text().includes("Номер привязан"));
  assert.ok(f.render.text().includes("подключён (1)"));
});

test("pending recommendation and number actions cannot publish or refresh into a new workspace", async (t) => {
  for (const kind of ["recommendation", "number"]) {
    await t.test(kind, async (t) => {
      const f = await fixture(t); await f.ready();
      if (kind === "recommendation") {
        f.click("Написать рекомендацию"); await f.flush();
        f.field("reco-title", "Private old recommendation"); f.field("reco-body", "Private old body"); await f.flush();
        f.click("Отправить");
      } else {
        f.field("wa-number", "123456789012345"); await f.flush(); f.click("Привязать номер");
      }
      await f.flush();
      const route = kind === "recommendation" ? RECOS_ROUTE : "/api/crm/platform-whatsapp-number";
      const post = f.take(route, "POST", WORKSPACE_A);
      f.setWorkspace(WORKSPACE_B); await f.ready(WORKSPACE_B);
      const count = f.requests.length;
      post.reply({ success: true, data: { alreadyLinked: false } }); await f.flush();
      assert.equal(f.requests.length, count);
      assert.ok(f.render.text().includes("Synthetic clinic B"));
      assert.equal(f.render.text().includes("Private old recommendation"), false);
      assert.equal(f.render.text().includes("Номер привязан"), false);
    });
  }
});

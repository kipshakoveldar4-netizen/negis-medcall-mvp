import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Actual component + push + CRM transport + serverAuth; only hooks, Auth/SDK,
// browser APIs and HTTP are synthetic. No browser, storage, network or SDK loads.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const componentPath = "artifacts/negis/src/components/layout/PushSettings.tsx";
const baseline = process.argv.includes("--baseline");
const sources: Record<string, string> = {};
for (const [id, file] of Object.entries({ component: componentPath, push: "artifacts/negis/src/lib/push.ts",
  api: "artifacts/negis/src/lib/api.ts", serverAuth: "artifacts/negis/src/lib/serverAuth.ts",
  authSignOut: "artifacts/negis/src/lib/authSignOut.ts" })) {
  const source = baseline && id === "component"
    ? execFileSync("git", ["show", `db73c4a:${file}`], { cwd: root, encoding: "utf8" })
    : await readFile(path.join(root, file), "utf8");
  sources[id] = ts.transpileModule(source, { fileName: file, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  }, transformers: { before: [context => {
    const visit: import("typescript").Visitor = node => ts.isMetaProperty(node)
      ? ts.factory.createObjectLiteralExpression([ts.factory.createPropertyAssignment("env", ts.factory.createObjectLiteralExpression([]))])
      : ts.visitEachChild(node, visit, context);
    return file => ts.visitNode(file, visit) as import("typescript").SourceFile;
  }] } }).outputText;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Node = { type: unknown; props: Record<string, any> };
const nodes = (value: any): Node[] => Array.isArray(value) ? value.flatMap(nodes)
  : value?.props ? [value, ...nodes(value.props.children)] : [];
const label = (value: any): string => Array.isArray(value) ? value.map(label).join("")
  : value?.props ? label(value.props.children) : value == null || typeof value === "boolean" ? "" : String(value);
const session = (actor: string) => ({ user: { id: actor }, access_token: `synthetic-token-${actor}` });
type Pending = { url: string; method: string; headers: Headers; body: string; signal?: AbortSignal | null;
  reads: number; respond(body: unknown, status?: number): void; fail(): void };

function fixture(sync = false, initial: Record<string, any> = {}) {
  let auth: Record<string, any> = { user: { id: "A" }, session: session("A"), clinicId: "workspace-A",
    isImpersonation: false, isDemoMode: false, isSigningOut: false, ...initial };
  let sdk = session("A") as ReturnType<typeof session> | null;
  const listeners = new Set<(event: string, session: any) => void>();
  const slots: any[] = [], requests: Pending[] = [], messages: string[] = [];
  let cursor = 0, tree: any, dirty = false, mounted = true, writes = 0, autoRender = true;
  let authGate: ReturnType<typeof deferred<any>> | undefined;
  let permissionGate: ReturnType<typeof deferred<string>> | undefined;
  let subscriptionGate: ReturnType<typeof deferred<any>> | undefined;
  let subscribeGate: ReturnType<typeof deferred<any>> | undefined;
  let unsubscribeGate: ReturnType<typeof deferred<boolean>> | undefined;
  let readyGate: ReturnType<typeof deferred<any>> | undefined;
  let subscribed = false, authReads = 0, permissions = 0, subscriptions = 0, unsubscriptions = 0, subscriptionReads = 0;
  const subscription = { endpoint: "https://push.example.test/private-endpoint-A",
    getKey(name: string) { return new Uint8Array(name === "auth" ? [11, 12] : [21, 22]).buffer; },
    async unsubscribe() { unsubscriptions++; if (unsubscribeGate) await unsubscribeGate.promise; subscribed = false; return true; } };
  const registration = { pushManager: {
    async getSubscription() { subscriptionReads++; return subscriptionGate ? subscriptionGate.promise : subscribed ? subscription : null; },
    async subscribe(options: any) { subscriptions++; assert.equal(options.userVisibleOnly, true);
      assert.deepEqual(Array.from(new Uint8Array(options.applicationServerKey)), [1, 2, 3]);
      if (subscribeGate) await subscribeGate.promise; subscribed = true; return subscription; },
  } };
  const effects = (create: () => unknown, deps?: unknown[]) => {
    const index = cursor++, previous = slots[index];
    const changed = !previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]));
    slots[index] = { ...previous, create, deps, pending: previous?.pending || changed, effect: true };
  };
  const hooks = {
    useState(initial: any) { const index = cursor++; const slot = slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slot.value, (value: any) => { writes++; slot.value = typeof value === "function" ? value(slot.value) : value; dirty = true; }]; },
    useRef(initial: any) { return slots[cursor++] ??= { current: initial }; },
    useCallback(fn: unknown, deps: unknown[]) { const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) slots[index] = { fn, deps }; return slots[index].fn; },
    useEffect: effects, useLayoutEffect: effects,
  };
  const modules = new Map<string, any>();
  const jsx = (type: unknown, props: any) => ({ type, props });
  const browser = { isSecureContext: true, PushManager: function () {}, matchMedia: () => ({ matches: false }) };
  const navigator = { userAgent: "Synthetic Windows Chrome/100", serviceWorker: { get ready() { return readyGate?.promise ?? Promise.resolve(registration); } } };
  function load(id: string): any {
    if (modules.has(id)) return modules.get(id);
    const exports = {}; modules.set(id, exports);
    new Script(sources[id], { filename: id }).runInNewContext({ exports, Error, Headers, Response, AbortController, DOMException,
      Uint8Array, atob, btoa, window: browser, navigator,
      Notification: { permission: "default", async requestPermission() { permissions++; return permissionGate ? permissionGate.promise : "granted"; } },
      fetch(url: string, init: RequestInit) {
        const gate = deferred<unknown>();
        const pending: Pending = { url, method: init.method || "GET", headers: new Headers(init.headers), body: String(init.body || ""),
          signal: init.signal, reads: 0,
          respond(body, status = 200) { gate.resolve({ ok: status < 400, status, headers: new Headers(),
            clone() { return this; }, async text() { return JSON.stringify(await body); },
            async json() { pending.reads++; return await body; } }); },
          fail() { gate.reject(new Error("SYNTHETIC_PRIVATE_FAILURE")); } };
        requests.push(pending); return gate.promise;
      },
      require(name: string) {
        if (name === "react") return hooks;
        if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
        if (name === "lucide-react") return { Bell: "Bell", BellOff: "BellOff" };
        if (name === "sonner") return { toast: { success: (m: string) => messages.push(`success:${m}`), error: (m: string) => messages.push(`error:${m}`) } };
        if (name === "@/contexts/AuthContext") return { useAuth: () => auth };
        if (name === "@/lib/supabase") return { hasSupabaseFrontendEnv: true, supabase: { auth: {
          onAuthStateChange(fn: any) { listeners.add(fn); return { data: { subscription: { unsubscribe() { listeners.delete(fn); } } } }; },
          async getSession() { authReads++; return authGate ? await authGate.promise : { data: { session: sdk }, error: null }; },
        } }, get sessionAuth() { return { onAuthStateChange: this.supabase.auth.onAuthStateChange }; } };
        if (name.startsWith("@/lib/")) return load(name.slice(6));
        assert.fail(`Unexpected dependency ${name}`);
      },
    });
    return exports;
  }
  const component = load("component");
  function render(runEffects = true) {
    assert.ok(mounted);
    for (let i = 0; i < 15; i++) {
      dirty = false; cursor = 0; tree = sync ? component.PushSync() : component.PushSettings();
      if (runEffects) {
        const pending = slots.filter(slot => slot.effect && slot.pending);
        for (const slot of pending) slot.cleanup?.();
        for (const slot of pending) { slot.pending = false; slot.cleanup = slot.create(); }
      }
      if (!dirty || !runEffects) return;
    }
    assert.fail("Unbounded component renders");
  }
  async function flush() { for (let i = 0; i < 50; i++) { await Promise.resolve(); if (mounted && dirty && autoRender) render(); } }
  render();
  return { requests, messages, subscription, registration, flush,
    async loaded(here = false, count = 2) { subscribed = here; await flush(); const req = requests.at(-1)!; assert.equal(req.method, "GET");
      req.respond({ success: true, vapidPublicKey: "AQID", devices: Array.from({ length: count }, (_, id) => ({ id: String(id), endpointTail: "synthetic-tail", label: "Synthetic device", lastSuccessAt: "", revoked: false, gone: false })) }); await flush(); },
    action() { const node = nodes(tree).find(node => node.type === "button"); assert.ok(node, label(tree)); return node.props.onClick as () => void; },
    text: () => label(tree), writes: () => writes,
    counters: () => ({ authReads, permissions, subscriptions, unsubscriptions, subscriptionReads }),
    patch(value: Record<string, any>, runEffects = autoRender) { auth = { ...auth, ...value }; render(runEffects); },
    holdRender() { autoRender = false; },
    emit(actor: string | null) { sdk = actor ? session(actor) : null; for (const fn of listeners) fn(actor ? "SIGNED_IN" : "SIGNED_OUT", sdk); },
    silent(actor: string | null) { sdk = actor ? session(actor) : null; },
    deferAuth() { return authGate = deferred<any>(); },
    deferPermission() { return permissionGate = deferred<string>(); },
    deferSubscription() { return subscriptionGate = deferred<any>(); },
    deferSubscribe() { return subscribeGate = deferred<any>(); },
    deferUnsubscribe() { return unsubscribeGate = deferred<boolean>(); },
    deferReady() { return readyGate = deferred<any>(); },
    subscribed(value = true) { subscribed = value; },
    markLogout() { load("authSignOut").markSignOutPending(); },
    clearLogout() { load("authSignOut").clearSignOutPending(); },
    unmount() { if (!mounted) return; mounted = false; for (const slot of slots) if (slot.effect) slot.cleanup?.(); },
  };
}

test("current load / enable / disable retain the live HTTP and notification contract", async () => {
  const f = fixture(); await f.loaded(); assert.match(f.text(), /Всего устройств.*2/);
  f.action()(); f.action()(); await f.flush();
  assert.equal(f.counters().permissions, 1, "duplicate retained actions must share the pending lock");
  const post = f.requests.at(-1)!; assert.equal(post.method, "POST");
  assert.equal(post.headers.get("Authorization"), "Bearer synthetic-token-A");
  assert.equal(post.url, "/api/crm/push-subscriptions?workspaceId=workspace-A");
  assert.equal(JSON.parse(post.body).endpoint, f.subscription.endpoint);
  assert.equal(JSON.parse(post.body).auth, "Cww");
  post.respond({ success: true }); await f.flush(); await f.loaded(true);
  assert.match(f.text(), /Выключить на этом устройстве/);
  f.action()(); await f.flush(); const patch = f.requests.at(-1)!;
  assert.equal(patch.method, "PATCH"); assert.deepEqual(JSON.parse(patch.body), { endpoint: f.subscription.endpoint });
  patch.respond({ success: true }); await f.flush(); await f.loaded(false);
  assert.match(f.text(), /Включить уведомления/); assert.equal(f.messages.length, 2); f.unmount();
});

const invalidations = ["account", "workspace", "logout", "logout-tombstone", "ABA", "unmount", "demo", "impersonation", "session-mismatch"] as const;
type Invalidation = typeof invalidations[number];
function invalidate(f: ReturnType<typeof fixture>, mode: Invalidation) {
  // Withhold replacement effects: these assertions observe only the original
  // continuation, not a legitimate newly mounted account/workspace request.
  f.holdRender();
  if (mode === "account") f.patch({ user: { id: "B" }, session: session("B") });
  if (mode === "workspace") f.patch({ clinicId: "workspace-B" });
  if (mode === "logout") f.patch({ isSigningOut: true });
  if (mode === "logout-tombstone") f.markLogout();
  if (mode === "ABA") { f.emit("B"); f.emit("A"); }
  if (mode === "unmount") f.unmount();
  if (mode === "demo") f.patch({ isDemoMode: true });
  if (mode === "impersonation") f.patch({ isImpersonation: true });
  if (mode === "session-mismatch") f.patch({ session: session("B") });
}

for (const mode of invalidations) {
  test(`retained action after ${mode} cannot read credentials or touch browser push`, async () => {
    const f = fixture(); await f.loaded(); const old = f.action(); invalidate(f, mode);
    const count = f.requests.length, counters = f.counters(), writes = f.writes();
    old(); await f.flush(); assert.deepEqual(f.counters(), counters); assert.equal(f.writes(), writes);
    assert.equal(f.requests.slice(count).some(req => req.method !== "GET" || req.body.includes("private-endpoint")), false);
    assert.deepEqual(f.messages, []); f.unmount();
  });
  for (const action of ["enable", "disable"] as const) {
    test(`pending ${action} getSubscription after ${mode} never discloses endpoint or credentials`, async () => {
      const f = fixture(); await f.loaded(action === "disable"); const gate = f.deferSubscription();
      f.action()(); await f.flush(); invalidate(f, mode);
      const count = f.requests.length, writes = f.writes(), authReads = f.counters().authReads;
      gate.resolve(f.subscription); await f.flush();
      assert.equal(f.requests.slice(count).filter(req => req.method !== "GET").length, 0);
      assert.equal(f.counters().authReads, authReads); assert.equal(f.writes(), writes); assert.deepEqual(f.messages, []); f.unmount();
    });
  }
}

for (const mode of invalidations) for (const stage of ["headers", "body", "subscription", "failure"] as const) {
  test(`obsolete load ${stage} after ${mode} cannot refill the UI`, async () => {
    const f = fixture(); await f.flush(); const old = f.requests[0];
    const body = deferred<unknown>(), sub = stage === "subscription" ? f.deferSubscription() : undefined;
    if (stage === "body") { old.respond(body.promise); await f.flush(); }
    if (stage === "subscription") { old.respond({ success: true, vapidPublicKey: "AQID", devices: [] }); await f.flush(); }
    invalidate(f, mode); const writes = f.writes();
    if (stage === "headers") old.respond({ success: true, vapidPublicKey: "AQID", devices: [] });
    if (stage === "body") body.resolve({ success: true, vapidPublicKey: "AQID", devices: [] });
    if (stage === "subscription") sub!.resolve(f.subscription);
    if (stage === "failure") old.fail();
    await f.flush(); assert.equal(f.writes(), writes); assert.doesNotMatch(f.text(), /Включить уведомления|Всего устройств/);
    if (stage === "headers") assert.equal(old.reads, 0, "obsolete response body must not even be opened"); f.unmount();
  });
}

for (const action of ["enable", "disable"] as const) for (const stage of ["headers", "body", "failure"] as const) {
  test(`${action} dispatched before invalidation ignores late ${stage} without claiming rollback`, async () => {
    const f = fixture(); await f.loaded(action === "disable"); f.action()(); await f.flush(); const req = f.requests.at(-1)!;
    const body = deferred<unknown>(); if (stage === "body") { req.respond(body.promise); await f.flush(); }
    f.holdRender(); f.emit("B"); const count = f.requests.length, writes = f.writes(), messages = [...f.messages];
    if (stage === "headers") req.respond({ success: true });
    if (stage === "body") body.resolve({ success: true });
    if (stage === "failure") req.fail();
    await f.flush(); assert.equal(f.requests.length, count); assert.equal(f.writes(), writes); assert.deepEqual(f.messages, messages);
    assert.equal(req.signal?.aborted, true); if (stage === "headers" && action === "enable") assert.equal(req.reads, 0); f.unmount();
  });
}

for (const mode of ["ABA", "workspace", "logout-tombstone", "unmount"] as const) for (const action of ["load", "enable", "disable", "sync"] as const) {
  test(`${action} token lookup cannot dispatch after ${mode}`, async () => {
    const f = fixture(action === "sync"); let gate: ReturnType<typeof deferred<any>>;
    if (action === "load" || action === "sync") { gate = f.deferAuth(); if (action === "sync") f.subscribed(); }
    else { await f.loaded(action === "disable"); gate = f.deferAuth(); f.action()(); }
    await f.flush(); invalidate(f, mode); const count = f.requests.length, writes = f.writes();
    gate.resolve({ data: { session: session("A") }, error: null }); await f.flush();
    assert.equal(f.requests.length, count); assert.equal(f.writes(), writes); assert.deepEqual(f.messages, []); f.unmount();
  });
}

test("source SDK actor invalidates retained handler before any token lookup, including A/B/A", async () => {
  const f = fixture(); await f.loaded(); const old = f.action(), before = f.counters();
  f.emit("B"); old(); f.emit("A"); old();
  assert.deepEqual(f.counters(), before); await f.flush(); assert.deepEqual(f.messages, []); f.unmount();
});

test("silent SDK B cannot attach B credentials to source A HTTP", async () => {
  const f = fixture(); await f.loaded(); f.silent("B"); f.action()(); await f.flush();
  assert.equal(f.requests.filter(req => req.method !== "GET").length, 0); f.unmount();
});

test("PushSync repairs only an existing subscription and never requests permission", async () => {
  const f = fixture(true); f.subscribed(); await f.flush();
  assert.equal(f.requests.length, 1); const req = f.requests[0]; assert.equal(req.method, "POST");
  assert.equal(JSON.parse(req.body).endpoint, f.subscription.endpoint); req.respond({ success: true }); await f.flush();
  assert.equal(f.counters().permissions, 0); assert.equal(f.counters().subscriptions, 0); assert.deepEqual(f.messages, []); f.unmount();
});

test("PushSync pending subscription cannot send after SDK A/B/A", async () => {
  const f = fixture(true); const gate = f.deferSubscription(); await f.flush(); f.holdRender(); f.emit("B"); f.emit("A");
  gate.resolve(f.subscription); await f.flush(); assert.equal(f.requests.length, 0); assert.equal(f.counters().authReads, 0); f.unmount();
});

for (const stage of ["permission", "ready", "subscribe", "unsubscribe"] as const) for (const mode of ["account", "workspace", "logout", "ABA", "unmount"] as const) {
  test(`pending browser ${stage} after ${mode} cannot continue into CRM or UI`, async () => {
    const f = fixture(); await f.loaded(stage === "unsubscribe");
    const gate = stage === "permission" ? f.deferPermission() : stage === "ready" ? f.deferReady()
      : stage === "subscribe" ? f.deferSubscribe() : f.deferUnsubscribe();
    f.action()(); await f.flush(); invalidate(f, mode);
    const count = f.requests.length, reads = f.counters().authReads, writes = f.writes();
    gate.resolve((stage === "permission" ? "granted" : stage === "ready" ? f.registration : true) as never);
    await f.flush(); assert.equal(f.requests.length, count); assert.equal(f.counters().authReads, reads);
    assert.equal(f.writes(), writes); assert.deepEqual(f.messages, []); f.unmount();
  });
}

test("logout tombstone cleared before React render still permanently invalidates old callbacks", async () => {
  const f = fixture(); await f.loaded(); const old = f.action(); f.markLogout(); f.clearLogout();
  const counters = f.counters(); old(); await f.flush(); assert.deepEqual(f.counters(), counters); assert.deepEqual(f.messages, []); f.unmount();
});

test("rendered workspace A/B/A loads fresh state without reviving A callbacks", async () => {
  const f = fixture(); await f.loaded(true, 3); const oldA = f.action();
  f.patch({ clinicId: "workspace-B" }); assert.doesNotMatch(f.text(), /Всего устройств|Выключить на этом устройстве/);
  await f.loaded(false, 2); const oldB = f.action();
  f.patch({ clinicId: "workspace-A" }); await f.loaded(false, 4);
  const counters = f.counters(), writes = f.writes(); oldA(); oldB(); await f.flush();
  assert.deepEqual(f.counters(), counters); assert.equal(f.writes(), writes); assert.match(f.text(), /Всего устройств.*4/);
  f.action()(); await f.flush(); assert.equal(f.requests.at(-1)!.method, "POST");
  assert.match(f.requests.at(-1)!.url, /workspaceId=workspace-A$/); f.unmount();
});

test("new account current action works while the old request finally stays silent", async () => {
  const f = fixture(); await f.loaded(); f.action()(); await f.flush(); const oldPost = f.requests.at(-1)!;
  f.emit("B"); f.patch({ user: { id: "B" }, session: session("B") }); await f.loaded();
  f.action()(); await f.flush(); const newPost = f.requests.at(-1)!;
  assert.equal(newPost.headers.get("Authorization"), "Bearer synthetic-token-B");
  assert.equal(newPost.method, "POST"); const writes = f.writes(); oldPost.respond({ success: true }); await f.flush();
  assert.equal(f.writes(), writes); assert.deepEqual(f.messages, []); assert.match(f.text(), /Секунду/);
  newPost.respond({ success: true }); await f.flush(); await f.loaded(true);
  assert.equal(f.messages.length, 1); assert.match(f.text(), /Выключить на этом устройстве/); f.unmount();
});

test("unchanged actor refresh does not invalidate a current pending permission", async () => {
  const f = fixture(); await f.loaded(); const gate = f.deferPermission(); f.action()(); await f.flush();
  f.emit("A"); gate.resolve("granted"); await f.flush(); assert.equal(f.requests.at(-1)!.method, "POST"); f.unmount();
});

for (const initial of [{ user: null, session: null }, { clinicId: null }, { isSigningOut: true },
  { isImpersonation: true }, { isDemoMode: true }, { session: session("B") }]) {
  test(`initial read-only ${JSON.stringify(initial)} has no HTTP or permission work`, async () => {
    const f = fixture(false, initial); await f.flush(); assert.equal(f.requests.length, 0);
    assert.equal(f.counters().authReads, 0); assert.equal(f.counters().permissions, 0); f.unmount();
  });
}

test("retirement during permission stops the actual helper before native subscription or CRM dispatch", async () => {
  const f = fixture(); await f.loaded(); const gate = f.deferPermission(); f.action()(); await f.flush();
  f.unmount(); gate.resolve("granted"); await f.flush();
  assert.equal(f.counters().permissions, 1);
  assert.equal(f.counters().subscriptions, 0); assert.equal(f.requests.filter(req => req.method !== "GET").length, 0);
  assert.deepEqual(f.messages, []);
});

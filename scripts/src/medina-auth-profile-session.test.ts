import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// The real AuthProvider/useAuth run with local hooks, storage, SDK and requests.
// No browser, React DOM, environment files, credentials or network are loaded.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const read = (file: string) => readFile(path.join(root, file), "utf8");
const source = await read("artifacts/negis/src/contexts/AuthContext.tsx");
const signOutSource = await read("artifacts/negis/src/lib/authSignOut.ts");
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
class StaleAuthIntentError extends Error { name = "StaleAuthIntentError"; }

type Node = { type: any; props: Record<string, any> };
const jsx = (type: any, props: Node["props"]): Node => ({ type, props });
function evaluate(code: string, imports: Record<string, unknown> = {}, bindings: Record<string, unknown> = {}) {
  const exports: Record<string, any> = {};
  const compiled = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    // Supply an inert build-time env while preserving the entire provider logic.
    transformers: { before: [(context) => {
      const visit: import("typescript").Visitor = (node) => {
        if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
          return ts.factory.createObjectLiteralExpression([
            ts.factory.createPropertyAssignment("env", ts.factory.createObjectLiteralExpression([
              ts.factory.createPropertyAssignment("DEV", ts.factory.createFalse()),
            ])),
          ]);
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (file) => ts.visitNode(file, visit) as import("typescript").SourceFile;
    }] },
  }).outputText;
  new Script(compiled).runInNewContext({
    exports, URLSearchParams, Response, AbortController, setTimeout, clearTimeout, ...bindings,
    require(name: string) {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      assert.ok(name in imports, `Unmocked import: ${name}`);
      return imports[name];
    },
  });
  return exports;
}

const terms = evaluate(await read("lib/vertical/terms.ts"));
const purposes = evaluate(await read("lib/crm/workspace-purpose.ts"), { "../vertical/terms": terms });
const permissions = evaluate(await read("artifacts/negis/src/lib/permissions.ts"));
const sameDeps = (left?: unknown[], right?: unknown[]) => Boolean(left && right && left.length === right.length
  && left.every((value, index) => Object.is(value, right[index])));
type Instance = { slots: any[]; cursor: number; disposed: boolean };

function hookRenderer() {
  const instances = new Map<string, Instance>();
  const writes: { instance: Instance; value: unknown }[] = [];
  let current: Instance;
  let rootNode: Node;
  let dirty = true;
  let mounted = true;

  function render(value: any, address: string): any {
    if (Array.isArray(value)) return value.map((child, index) => render(child, `${address}/${index}`));
    if (!value || typeof value !== "object" || !("props" in value)) return value;
    if (value.type?.context) {
      const context = value.type.context;
      const previous = context.current;
      context.current = value.props.value;
      const output = render(value.props.children, `${address}/provider`);
      context.current = previous;
      return output;
    }
    if (typeof value.type !== "function") return render(value.props.children, `${address}/children`);
    let instance = instances.get(address);
    if (!instance) {
      instance = { slots: [], cursor: 0, disposed: false };
      instances.set(address, instance);
    }
    current = instance;
    instance.cursor = 0;
    return render(value.type(value.props), `${address}/child`);
  }

  function effect(create: () => any, deps?: unknown[], layout = false) {
    const index = current.cursor++;
    const old = current.slots[index];
    current.slots[index] = { create, deps, layout, cleanup: old?.cleanup, pending: !old || !sameDeps(old.deps, deps) };
  }
  const hooks = {
    createContext(initial: unknown) {
      const context: any = { current: initial };
      context.Provider = { context };
      return context;
    },
    useContext(context: any) { return context.current; },
    useState(initial: any) {
      const instance = current, index = instance.cursor++;
      instance.slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [instance.slots[index].value, (update: any) => {
        const value = typeof update === "function" ? update(instance.slots[index].value) : update;
        writes.push({ instance, value });
        if (!instance.disposed && !Object.is(value, instance.slots[index].value)) {
          instance.slots[index].value = value;
          dirty = true;
        }
      }];
    },
    useRef(initial: any) { const index = current.cursor++; return current.slots[index] ??= { current: initial }; },
    useMemo(create: () => any, deps?: unknown[]) {
      const index = current.cursor++;
      if (!current.slots[index] || !sameDeps(current.slots[index].deps, deps)) current.slots[index] = { value: create(), deps };
      return current.slots[index].value;
    },
    useCallback(callback: any, deps?: unknown[]) { return hooks.useMemo(() => callback, deps); },
    useEffect: effect,
    useLayoutEffect: (create: () => any, deps?: unknown[]) => effect(create, deps, true),
  };
  function commit() {
    if (!mounted || !dirty) return;
    dirty = false;
    render(rootNode, "root");
    for (const layout of [true, false]) {
      const pending = [...instances.values()].flatMap((instance) => instance.slots)
        .filter((slot) => slot?.pending && slot.layout === layout);
      for (const slot of pending) slot.cleanup?.();
      for (const slot of pending) { slot.pending = false; slot.cleanup = slot.create(); }
    }
  }
  return {
    hooks, writes, commit,
    mount(type: any, child: any) { rootNode = jsx(type, { children: jsx(child, {}) }); },
    async flush() {
      for (let pass = 0; pass < 80; pass++) { commit(); await Promise.resolve(); }
      assert.equal(dirty, false, "synthetic hooks must settle after rerender");
    },
    dispose() {
      if (!mounted) return;
      mounted = false;
      dirty = false;
      for (const instance of instances.values()) {
        instance.disposed = true;
        for (const slot of instance.slots) slot?.cleanup?.();
      }
      instances.clear();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function memoryStorage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  const writes: { key: string; value: string | null }[] = [];
  return {
    values, writes,
    getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) { values.set(key, value); writes.push({ key, value }); },
    removeItem(key: string) { values.delete(key); writes.push({ key, value: null }); },
  };
}

const actorA = "00000000-0000-4000-8000-000000000101";
const actorB = "00000000-0000-4000-8000-000000000102";
const workspaceA = "00000000-0000-4000-8000-000000000103";
const workspaceB = "00000000-0000-4000-8000-000000000104";
const unknownWorkspace = "00000000-0000-4000-8000-000000000105";
const selectorKey = "negis_workspace_selector";
const localSession = (id: string | null) => id ? {
  user: { id, email: `${id === actorA ? "a" : "b"}@example.test`,
    user_metadata: { purpose: "marketing", workspacePurpose: "marketing", vertical: "dental", role: "owner" },
    app_metadata: { purpose: "clinic_services" } },
} : null;
const membership = (patch: Record<string, unknown> = {}) => ({
  staffUserId: "staff-profile-local-a", workspaceId: workspaceA, workspaceName: "Local clinic",
  role: "owner", permissions: ["view_clients", "manage_staff"], vertical: "beauty", purpose: "clinic_services", ...patch,
});
const mortgage = () => membership({ staffUserId: "staff-profile-local-b", workspaceId: workspaceB,
  workspaceName: "Local mortgage", role: "lead_manager", permissions: ["view_leads"], vertical: null, purpose: "mortgage_leads" });
const success = (memberships: Record<string, unknown>[]) => ({ success: true, mode: "supabase", data: {
  memberships, workspaceId: memberships.length === 1 ? memberships[0].workspaceId : null,
  requiresWorkspaceSelection: memberships.length > 1,
  // Only memberships[].purpose is authoritative, not a sibling profile hint.
  purpose: "marketing", vertical: "dental",
} });

type Snapshot = {
  user: { id: string } | null; session: unknown; clinicId: string | null; userRole: string | null;
  rolePermissions: Record<string, boolean>; vertical: string; workspacePurpose: string | null;
  availableWorkspaces: { id: string; name: string; role: string; vertical: string; purpose: string }[];
  isLoading: boolean; isStaffMode: boolean; isDemoMode: boolean; isImpersonation: boolean;
  isSigningOut: boolean; signOutFailed: boolean;
  selectWorkspace: (id: string) => void; clearWorkspaceSelection: () => void; signOut: () => Promise<void>;
};
type Init = RequestInit & { accessToken?: string; expectedUserId?: string; dispatchGuard?: () => boolean };
type PendingRequest = { url: string; init: Init; actor: string | undefined; reply: (body: unknown, status?: number) => void;
  resolve: (response: Response) => void; reject: (error: unknown) => void };
type SignOutBoundary = { isSignOutPending(): boolean; getSignOutRevision(): number; markSignOutPending(): void; clearSignOutPending(): boolean };
type Options = { initialActor?: string | null; deferSession?: boolean; storage?: Record<string, string>; pathname?: string;
  sessionStorage?: Record<string, string>; deferSignOut?: boolean;
  sharedSignOut?: { storage: ReturnType<typeof memoryStorage>; sessionStorage: ReturnType<typeof memoryStorage>;
    boundary: SignOutBoundary } };

function setup(options: Options = {}) {
  const renderer = hookRenderer();
  const storage = options.sharedSignOut?.storage ?? memoryStorage(options.storage);
  const sessionStorage = options.sharedSignOut?.sessionStorage ?? memoryStorage(options.sessionStorage);
  const signOutBoundary: SignOutBoundary = options.sharedSignOut?.boundary
    ?? evaluate(signOutSource, {}, { window: { localStorage: storage, sessionStorage } }) as SignOutBoundary;
  const sessionGate = deferred<{ data: { session: ReturnType<typeof localSession> } }>();
  const callbacks = new Set<(event: string, session: ReturnType<typeof localSession>) => void>();
  const requests: PendingRequest[] = [];
  const tokenCalls: (string | undefined)[] = [];
  const tokenOwners = new Map<string, string>();
  const cacheClears: string[] = [];
  const caches = { crm: new Map<string, unknown>(), lists: new Map<string, unknown>() };
  const toasts: { kind: string; message: string }[] = [];
  const locations: string[] = [];
  let snapshot!: Snapshot;
  let sdkActor = options.initialActor === undefined ? actorA : options.initialActor;
  let sdkRevision = 0;
  let sdkIntent = 0;
  const stamps = new WeakMap<object, { actorId: string | null; revision: number }>();
  let tokenReply: ((expected?: string) => Promise<string>) | undefined;
  let logoutGate: ReturnType<typeof deferred<void>> | undefined;
  if (options.deferSignOut) logoutGate = deferred<void>();
  let logoutFailure: "return" | "throw" | null = null;
  let completedSignOuts = 0;
  let signOutCalls = 0;
  let getSessionCalls = 0;
  if (!options.deferSession) sessionGate.resolve({ data: { session: localSession(sdkActor) } });

  function emit(id: string | null, event = id ? "SIGNED_IN" : "SIGNED_OUT") {
    if (id !== sdkActor || !["TOKEN_REFRESHED", "USER_UPDATED"].includes(event)) sdkIntent++;
    sdkActor = id;
    sdkRevision++;
    for (const callback of [...callbacks]) callback(event, localSession(id));
  }
  const sdk = {
    onAuthStateChange(callback: typeof callbacks extends Set<infer T> ? T : never) {
      callbacks.add(callback);
      return { data: { subscription: { unsubscribe: () => callbacks.delete(callback) } } };
    },
    getSession() {
      getSessionCalls += 1;
      return completedSignOuts > 0
        ? Promise.resolve({ data: { session: localSession(sdkActor) } }) : sessionGate.promise;
    },
    async signOut() {
      signOutCalls += 1;
      if (logoutGate) await logoutGate.promise;
      if (logoutFailure === "throw") throw new Error("Isolated SDK logout failure");
      if (logoutFailure === "return") return { error: new Error("Isolated SDK logout failure") };
      completedSignOuts += 1;
      emit(null);
      return { error: null };
    },
  };
  // Synthetic dispatch contract only, not a model of native SDK storage fencing.
  const sessionAuth = {
    onAuthStateChange: sdk.onAuthStateChange,
    capture() {
      const stamp = Object.freeze({ revision: String(sdkRevision), intent: String(sdkIntent) });
      stamps.set(stamp, { actorId: sdkActor, revision: sdkRevision });
      return stamp;
    },
    isCurrent(stamp: unknown) {
      const saved = stamp && typeof stamp === "object" ? stamps.get(stamp) : undefined;
      return Boolean(saved && saved.actorId === sdkActor && saved.revision === sdkRevision);
    },
    signOut(scope: { isCurrent(): boolean; signal?: AbortSignal; expected?: unknown; expectedUserId?: string | null }) {
      assert.equal(typeof scope?.isCurrent, "function", "sessionAuth requires a caller scope");
      assert.equal(scope.isCurrent(), true, "Retired sign-out must not dispatch");
      assert.notEqual(scope.signal?.aborted, true, "Aborted sign-out must not dispatch");
      if ((scope.expected && !sessionAuth.isCurrent(scope.expected))
        || (scope.expectedUserId !== undefined && scope.expectedUserId !== sdkActor)) throw new StaleAuthIntentError();
      return sdk.signOut();
    },
  };
  const auth = evaluate(source, {
    react: { ...renderer.hooks, default: renderer.hooks },
    // Preserve this legacy fixture's former undefined/offline branch explicitly.
    "@/lib/supabase": { supabase: { auth: sdk }, sessionAuth, hasSupabaseFrontendEnv: false },
    "@/lib/authSessionAuthority": { StaleAuthIntentError },
    "@/lib/authSignOut": signOutBoundary,
    "../../../../lib/vertical/terms": terms,
    "../../../../lib/crm/workspace-purpose": purposes,
    wouter: { useLocation: () => [options.pathname ?? "/dashboard", (location: string) => locations.push(location)] },
    sonner: { toast: new Proxy({}, { get: (_target, kind) => (message: string) => toasts.push({ kind: String(kind), message }) }) },
    "@/lib/permissions": permissions,
    "@/lib/demoStorage": { WORKSPACE_SELECTOR_KEY: selectorKey, bindWorkspaceReadScope() {}, clearWorkspaceReadScope() {},
      clearListReadCache() { cacheClears.push("lists"); caches.lists.clear(); } },
    "@/lib/api": {
      apiUrl: (url: string) => url,
      clearCrmCache() { cacheClears.push("crm"); caches.crm.clear(); },
      crmFetch(url: string, init: Init = {}) {
        assert.equal(url, "/api/crm/auth-context", "only an isolated auth bootstrap may be dispatched");
        const gate = deferred<Response>();
        requests.push({ url, init, actor: tokenOwners.get(init.accessToken ?? ""), resolve: gate.resolve, reject: gate.reject,
          reply(body: unknown, status = 200) { gate.resolve(Response.json(body, { status })); } });
        return gate.promise;
      },
    },
    "@/lib/serverAuth": { async getSupabaseAccessToken(expected?: string) {
      tokenCalls.push(expected);
      const token = tokenReply ? await tokenReply(expected) : expected && expected !== sdkActor ? "" : `local-fixture-token:${expected}`;
      if (expected) tokenOwners.set(token, expected);
      return token;
    } },
  }, {
    localStorage: storage, sessionStorage,
    window: { localStorage: storage, sessionStorage,
      addEventListener() {}, removeEventListener() {},
      location: { search: "", origin: "https://example.test", pathname: options.pathname ?? "/dashboard" }, history: { replaceState() {} } },
    document: { title: "Local auth fixture" },
    fetch: () => { throw new Error("Network is forbidden in the local AuthProvider fixture"); },
  });
  function Probe() { snapshot = auth.useAuth(); return null; }
  renderer.mount(auth.AuthProvider, Probe);
  return {
    renderer, storage, sessionStorage, signOutBoundary, sessionGate, requests, tokenCalls, cacheClears, caches, toasts, locations, emit,
    snapshot: () => snapshot,
    subscriptions: () => callbacks.size,
    sdkCalls: () => ({ signOut: signOutCalls, getSession: getSessionCalls }),
    setSdkActor(id: string | null) { sdkActor = id; },
    token(reply?: typeof tokenReply) { tokenReply = reply; },
    holdSignOut() { logoutGate = deferred<void>(); return logoutGate; },
    releaseSignOut() { logoutGate?.resolve(); },
    failSignOut(kind: typeof logoutFailure) { logoutFailure = kind; },
    request(actor: string, index = 0) {
      const request = requests.filter((entry) => entry.actor === actor)[index];
      assert.ok(request, `missing bootstrap ${index + 1} for isolated actor ${actor}`);
      return request;
    },
    seedCaches() { caches.crm.set("local-old-read", ["old CRM row"]); caches.lists.set("local-old-list", ["old list row"]); },
    async respond(request: PendingRequest, body: unknown, status = 200) { request.reply(body, status); await renderer.flush(); },
  };
}
type Fixture = ReturnType<typeof setup>;
async function withFixture(run: (fixture: Fixture) => Promise<void>, options: Options = {}) {
  const fixture = setup(options);
  try { await fixture.renderer.flush(); await run(fixture); }
  finally { fixture.renderer.dispose(); }
}
async function choose(fixture: Fixture, workspaceId: string, memberships = [membership(), mortgage()],
  select = fixture.snapshot().selectWorkspace) {
  const count = fixture.requests.length;
  select(workspaceId);
  await fixture.renderer.flush();
  assert.equal(fixture.requests.length, count + 1, "Every choice must dispatch a fresh membership check");
  assert.equal(fixture.snapshot().clinicId, null, "Cached permissions stay quarantined before the fresh response");
  await fixture.respond(fixture.requests[count], success(memberships));
}
async function confirm(fixture: Fixture, memberships = [membership()]) {
  await fixture.respond(fixture.request(actorA), success(memberships));
  assert.equal(fixture.snapshot().isLoading, false);
}
function context(fixture: Fixture) {
  const { user, session, clinicId, userRole, rolePermissions, vertical, workspacePurpose, availableWorkspaces,
    isLoading, isStaffMode, isDemoMode, isImpersonation, isSigningOut, signOutFailed } = fixture.snapshot();
  return clone({ user, session, clinicId, userRole, rolePermissions, vertical, workspacePurpose, availableWorkspaces,
    isLoading, isStaffMode, isDemoMode, isImpersonation, isSigningOut, signOutFailed });
}
function assertUnselected(fixture: Fixture, choices = false) {
  const value = fixture.snapshot();
  assert.equal(value.clinicId, null);
  assert.equal(value.userRole, null);
  assert.deepEqual(clone(value.rolePermissions), {});
  assert.equal(value.workspacePurpose, null);
  assert.equal(value.vertical, terms.DEFAULT_VERTICAL);
  if (!choices) assert.deepEqual(clone(value.availableWorkspaces), []);
}
function assertCachesEmpty(fixture: Fixture, start: number) {
  assert.equal(fixture.caches.crm.size, 0);
  assert.equal(fixture.caches.lists.size, 0);
  assert.ok(fixture.cacheClears.slice(start).includes("crm"));
  assert.ok(fixture.cacheClears.slice(start).includes("lists"));
}
function effects(fixture: Fixture) {
  return { context: context(fixture), storage: [...fixture.storage.values], storageWrites: fixture.storage.writes.length,
    writes: fixture.renderer.writes.length, toasts: fixture.toasts.length, locations: fixture.locations.length,
    cacheClears: fixture.cacheClears.length };
}

const managerMembership = () => membership({ staffUserId: "staff-profile-local-manager", role: "lead_manager", permissions: ["view_leads"] });

async function confirmManagerB(fixture: Fixture) {
  fixture.emit(actorB);
  await fixture.renderer.flush();
  await fixture.respond(fixture.request(actorB), success([managerMembership()]));
  assert.equal(fixture.snapshot().user?.id, actorB);
  assert.equal(fixture.snapshot().clinicId, workspaceA);
  assert.equal(fixture.snapshot().userRole, "lead_manager");
  assert.equal(fixture.snapshot().rolePermissions.admin, false);
  assert.equal(fixture.snapshot().workspacePurpose, "clinic_services");
  assert.equal(fixture.toasts.length, 0);
}

for (const phase of ["headers", "body"] as const) {
  const outcomes = [
    { label: "success", status: 200, body: success([membership()]) },
    { label: "empty", status: 200, body: success([]) },
    ...[401, 403, 503].map((status) => ({ label: String(status), status, body: { success: false } })),
  ];
  for (const outcome of outcomes.filter(({ status }) => phase === "headers" || status === 200)) {
    test(`publication fence: SDK B before callback suppresses delayed ${phase} ${outcome.label}`, async () => {
      await withFixture(async (fixture) => {
        await confirm(fixture);
        fixture.seedCaches();
        const clearStart = fixture.cacheClears.length;
        fixture.emit(actorA, "USER_UPDATED");
        await fixture.renderer.flush();
        const pending = fixture.request(actorA, 1);
        const body = deferred<string>();
        let bodyReads = 0;
        if (phase === "body") {
          pending.resolve({ ok: true, status: 200, text() { bodyReads++; return body.promise; } } as Response);
          await fixture.renderer.flush();
          assert.equal(bodyReads, 1, "the successful response body must already be pending");
        }
        fixture.setSdkActor(actorB);
        if (phase === "headers") pending.reply(outcome.body, outcome.status);
        else body.resolve(JSON.stringify(outcome.body));
        await fixture.renderer.flush();
        assert.equal(fixture.toasts.length, 0, "a stale result cannot announce denial, missing membership or service failure");
        assertUnselected(fixture);
        assert.equal(fixture.snapshot().isStaffMode, false);
        assertCachesEmpty(fixture, clearStart);
        assert.deepEqual(fixture.locations, []);
        assert.equal(fixture.sdkCalls().signOut, 0);
        await confirmManagerB(fixture);
      });
    });
  }

  test(`publication fence: SDK B before callback suppresses a delayed ${phase} rejection`, async () => {
    await withFixture(async (fixture) => {
      await confirm(fixture);
      fixture.seedCaches();
      const clearStart = fixture.cacheClears.length;
      fixture.emit(actorA, "USER_UPDATED");
      await fixture.renderer.flush();
      const pending = fixture.request(actorA, 1);
      const body = deferred<string>();
      let bodyReads = 0;
      if (phase === "body") {
        pending.resolve({ ok: true, status: 200, text() { bodyReads++; return body.promise; } } as Response);
        await fixture.renderer.flush();
        assert.equal(bodyReads, 1);
      }
      fixture.setSdkActor(actorB);
      if (phase === "headers") pending.reject(new Error("Isolated delayed headers failure"));
      else body.reject(new Error("Isolated delayed body failure"));
      await fixture.renderer.flush();
      assert.equal(fixture.toasts.length, 0);
      assertUnselected(fixture);
      assertCachesEmpty(fixture, clearStart);
      await confirmManagerB(fixture);
    });
  });
}

for (const phase of ["headers", "body"] as const) {
  test(`publication fence: a rotated same-user token invalidates delayed ${phase} before the SDK event`, async () => {
    await withFixture(async (fixture) => {
      await confirm(fixture);
      fixture.seedCaches();
      const clearStart = fixture.cacheClears.length;
      fixture.emit(actorA, "USER_UPDATED");
      await fixture.renderer.flush();
      const pending = fixture.request(actorA, 1);
      const body = deferred<string>();
      if (phase === "body") {
        pending.resolve({ ok: true, status: 200, text: () => body.promise } as Response);
        await fixture.renderer.flush();
      }
      fixture.token(() => Promise.resolve("local-rotated-a-token"));
      if (phase === "headers") pending.reply(success([membership()]));
      else body.resolve(JSON.stringify(success([membership()])));
      await fixture.renderer.flush();
      assertUnselected(fixture);
      assertCachesEmpty(fixture, clearStart);
      assert.equal(fixture.toasts.length, 0);
      fixture.emit(actorA, "TOKEN_REFRESHED");
      await fixture.renderer.flush();
      await fixture.respond(fixture.request(actorA, 2), success([membership()]));
      assert.equal(fixture.snapshot().userRole, "owner");
      assert.equal(fixture.snapshot().clinicId, workspaceA);
    });
  });
}

test("publication fence: requests pin the expected actor and expire their dispatch guard across raw ABA", async () => {
  await withFixture(async (fixture) => {
    const firstA = fixture.request(actorA);
    assert.equal(firstA.init.expectedUserId, actorA);
    assert.equal(typeof firstA.init.dispatchGuard, "function");
    assert.equal(firstA.init.dispatchGuard!(), true);
    fixture.emit(actorB);
    assert.equal(firstA.init.dispatchGuard!(), false);
    fixture.emit(actorA);
    assert.equal(firstA.init.dispatchGuard!(), false, "matching the actor again cannot revive a dispatch lifetime");
    await fixture.renderer.flush();
    const currentA = fixture.request(actorA, 1);
    assert.equal(currentA.init.expectedUserId, actorA);
    assert.equal(currentA.init.dispatchGuard!(), true);
    await fixture.respond(currentA, success([managerMembership()]));
    const before = effects(fixture);
    await fixture.respond(firstA, success([membership()]));
    assert.deepEqual(effects(fixture), before);
    fixture.renderer.dispose();
    assert.equal(currentA.init.dispatchGuard!(), false);
  });
});

test("publication fence: a cleared signout marker cannot revive the preceding resolution or dispatch guard", async () => {
  await withFixture(async (fixture) => {
    const pending = fixture.request(actorA);
    assert.equal(pending.init.dispatchGuard!(), true);
    fixture.signOutBoundary.markSignOutPending();
    assert.equal(pending.init.dispatchGuard!(), false);
    assert.equal(fixture.signOutBoundary.clearSignOutPending(), true);
    assert.equal(pending.init.dispatchGuard!(), false, "a new signout revision outlives its pending marker");
    const before = effects(fixture);
    await fixture.respond(pending, success([membership()]));
    assert.deepEqual(effects(fixture), before);
    assertUnselected(fixture);
  });
});

test("publication fence: a delayed first-A token cannot dispatch after raw ABA returns to A", async () => {
  await withFixture(async (fixture) => {
    const token = deferred<string>();
    let firstA = true;
    fixture.token((expected) => {
      if (expected === actorA && firstA) { firstA = false; return token.promise; }
      return Promise.resolve(`local-current-token:${expected}`);
    });
    fixture.sessionGate.resolve({ data: { session: localSession(actorA) } });
    await fixture.renderer.flush();
    assert.equal(fixture.requests.length, 0);
    fixture.emit(actorB);
    fixture.emit(actorA);
    await fixture.renderer.flush();
    await fixture.respond(fixture.request(actorA), success([managerMembership()]));
    const before = effects(fixture);
    const requests = fixture.requests.length;
    token.resolve("local-expired-first-a-token");
    await fixture.renderer.flush();
    assert.deepEqual(effects(fixture), before);
    assert.equal(fixture.requests.length, requests, "the original A token must never reach transport");
    assert.equal(fixture.snapshot().userRole, "lead_manager");
  }, { deferSession: true });
});

for (const batching of ["committed B", "raw ABA"] as const) {
  for (const result of ["success", "empty", "malformed"] as const) {
    test(`publication fence: late first-A body ${result} cannot publish after ${batching} returns to A`, async () => {
      await withFixture(async (fixture) => {
        const body = deferred<string>();
        let bodyReads = 0;
        fixture.request(actorA).resolve({ ok: true, status: 200, text() { bodyReads++; return body.promise; } } as Response);
        await fixture.renderer.flush();
        assert.equal(bodyReads, 1);
        fixture.emit(actorB);
        if (batching === "committed B") await fixture.renderer.flush();
        const oldB = fixture.requests.find(({ actor }) => actor === actorB);
        fixture.emit(actorA);
        await fixture.renderer.flush();
        await fixture.respond(fixture.request(actorA, 1), success([managerMembership()]));
        const before = effects(fixture);
        body.resolve(result === "malformed" ? "{" : JSON.stringify(success(result === "success" ? [membership()] : [])));
        await fixture.renderer.flush();
        assert.deepEqual(effects(fixture), before, "an old body's success, denial or parse failure cannot attempt any publication");
        if (oldB) {
          await fixture.respond(oldB, success([membership()]));
          assert.deepEqual(effects(fixture), before);
        }
        assert.equal(fixture.snapshot().user?.id, actorA);
        assert.equal(fixture.snapshot().userRole, "lead_manager");
        assert.equal(fixture.snapshot().rolePermissions.admin, false);
      });
    });
  }
}

for (const pathname of ["/r/" + "A".repeat(32), "/r/invalid-code", "/r/" + "B".repeat(32) + "/", "/partner-company"]) {
  test(`public attribution ${pathname} does not require staff membership or show the unlinked-clinic warning`, async () => {
    await withFixture(async fixture => {
      await confirm(fixture, []);
      assertUnselected(fixture);
      assert.equal(fixture.snapshot().user?.id, actorA);
      assert.equal(fixture.snapshot().isStaffMode, false);
      assert.ok(fixture.toasts.every(({ message }) => !message.includes("Аккаунт не привязан")));
      assert.equal(Boolean(fixture.snapshot().rolePermissions.admin), false);
      assert.equal(fixture.sdkCalls().signOut, 0);
    }, { pathname });
  });
}

test("publication fence: verified empty membership still warns and removes confirmed permissions, caches and picker refs", async () => {
  await withFixture(async (fixture) => {
    await confirm(fixture, [membership(), mortgage()]);
    await choose(fixture, workspaceA);
    const oldSelect = fixture.snapshot().selectWorkspace;
    fixture.seedCaches();
    const clearStart = fixture.cacheClears.length;
    fixture.emit(actorA, "USER_UPDATED");
    await fixture.renderer.flush();
    await fixture.respond(fixture.request(actorA, 2), success([]));
    assertUnselected(fixture);
    assertCachesEmpty(fixture, clearStart);
    assert.equal(fixture.snapshot().user?.id, actorA);
    assert.equal(fixture.snapshot().isLoading, false);
    assert.equal(fixture.snapshot().isStaffMode, false);
    assert.ok(fixture.toasts.some(({ message }) => message.includes("Аккаунт не привязан")));
    const denied = context(fixture);
    for (const workspace of [workspaceA, workspaceB]) {
      oldSelect(workspace);
      await fixture.renderer.flush();
      assert.deepEqual(context(fixture), denied);
    }
  });
});

for (const [label, body] of [
  ["null payload", null],
  ["missing success", { data: { memberships: [] } }],
  ["false success", { success: false, data: { memberships: [] } }],
  ["truthy success", { success: "true", data: { memberships: [] } }],
  ["missing data", { success: true }],
  ["null data", { success: true, data: null }],
  ["missing memberships", { success: true, data: {} }],
  ["null memberships", { success: true, data: { memberships: null } }],
  ["object memberships", { success: true, data: { memberships: {} } }],
  ["null membership entry", { success: true, data: { memberships: [null] } }],
  ["primitive membership entry", { success: true, data: { memberships: ["owner"] } }],
  ["missing workspace ID", { success: true, data: { memberships: [{ role: "owner", purpose: "clinic_services" }] } }],
  ["empty workspace ID", success([membership({ workspaceId: "" })])],
  ["nonstring workspace ID", success([membership({ workspaceId: 42 })])],
  ["unknown role", success([membership({ role: "not-a-staff-role" })])],
  ["nonstring role", success([membership({ role: 42 })])],
  ["mixed valid and invalid entries", success([membership(), membership({ workspaceId: "" })])],
] as const) {
  test(`publication fence: malformed successful contract (${label}) denies as profile failure, never unlinked`, async () => {
    await withFixture(async (fixture) => {
      await confirm(fixture, [membership(), mortgage()]);
      await choose(fixture, workspaceA);
      const oldSelect = fixture.snapshot().selectWorkspace;
      fixture.seedCaches();
      const clearStart = fixture.cacheClears.length;
      fixture.emit(actorA, "USER_UPDATED");
      await fixture.renderer.flush();
      await fixture.respond(fixture.request(actorA, 2), body);
      assertUnselected(fixture);
      assertCachesEmpty(fixture, clearStart);
      assert.equal(fixture.snapshot().isLoading, false);
      assert.equal(fixture.snapshot().isStaffMode, false);
      assert.match(fixture.toasts.at(-1)?.message ?? "", /профил/i);
      assert.ok(fixture.toasts.every(({ message }) => !message.includes("Аккаунт не привязан")));
      const denied = context(fixture);
      oldSelect(workspaceB);
      await fixture.renderer.flush();
      assert.deepEqual(context(fixture), denied);
    });
  });
}

for (const status of [401, 403]) {
  test(`publication fence: live same-account ${status} clears both caches and invalidates old picker refs`, async () => {
    await withFixture(async (fixture) => {
      await confirm(fixture, [membership(), mortgage()]);
      await choose(fixture, workspaceA);
      const oldSelect = fixture.snapshot().selectWorkspace;
      fixture.seedCaches();
      const clearStart = fixture.cacheClears.length;
      fixture.emit(actorA, "USER_UPDATED");
      await fixture.renderer.flush();
      await fixture.respond(fixture.request(actorA, 2), { success: false }, status);
      assertUnselected(fixture);
      assertCachesEmpty(fixture, clearStart);
      assert.equal(fixture.snapshot().isStaffMode, false);
      assert.equal(fixture.snapshot().isLoading, false);
      assert.equal(fixture.snapshot().user?.id, actorA);
      assert.equal(fixture.sdkCalls().signOut, 0);
      assert.match(fixture.toasts.at(-1)?.message ?? "", status === 401 ? /сесси|войдите|авторизац/i : /доступ|прав|запрещ/i);
      assert.ok(fixture.toasts.every(({ message }) => !message.includes("Аккаунт не привязан")));
      const denied = context(fixture);
      const navigations = [...fixture.locations];
      for (const workspace of [workspaceA, workspaceB]) {
        oldSelect(workspace);
        await fixture.renderer.flush();
        assert.deepEqual(context(fixture), denied);
        assert.deepEqual(fixture.locations, navigations);
      }
    });
  });
}

test("publication fence: live same-account 429 preserves the verified profile, both caches and picker refs", async () => {
  await withFixture(async (fixture) => {
    await confirm(fixture, [membership(), mortgage()]);
    await choose(fixture, workspaceB);
    const oldSelect = fixture.snapshot().selectWorkspace;
    fixture.seedCaches();
    const before = context(fixture);
    const clearStart = fixture.cacheClears.length;
    const crmBefore = [...fixture.caches.crm];
    const listsBefore = [...fixture.caches.lists];
    fixture.emit(actorA, "USER_UPDATED");
    await fixture.renderer.flush();
    assert.deepEqual(context(fixture), before);
    await fixture.respond(fixture.request(actorA, 2), { success: false }, 429);
    assert.deepEqual(context(fixture), before);
    assert.equal(fixture.cacheClears.length, clearStart);
    assert.deepEqual([...fixture.caches.crm], crmBefore);
    assert.deepEqual([...fixture.caches.lists], listsBefore);
    assert.equal(fixture.storage.getItem(selectorKey), workspaceB);
    assert.ok(fixture.toasts.length > 0, "rate limiting remains visible without revoking verified access");
    assert.ok(fixture.toasts.every(({ message }) => !message.includes("Аккаунт не привязан")));
    await choose(fixture, workspaceA, [membership(), mortgage()], oldSelect);
    assert.equal(fixture.snapshot().clinicId, workspaceA);
    assert.equal(fixture.snapshot().userRole, "owner");
    assert.equal(fixture.snapshot().rolePermissions.admin, true);
    assert.equal(fixture.snapshot().availableWorkspaces.length, 2);
  });
});

test("mortgage purpose comes only from the signed-in user's server membership", async () => {
  await withFixture(async (fixture) => {
    assertUnselected(fixture);
    assert.deepEqual(fixture.tokenCalls, [actorA], "bootstrap token lookup must name the expected user");
    await confirm(fixture, [mortgage()]);
    const value = fixture.snapshot();
    assert.equal(value.user?.id, actorA);
    assert.equal(value.clinicId, workspaceB);
    assert.equal(value.userRole, "lead_manager");
    assert.equal(value.workspacePurpose, "mortgage_leads");
    assert.equal(value.vertical, terms.DEFAULT_VERTICAL);
    assert.equal(value.rolePermissions.crm, true);
    assert.equal(value.rolePermissions.admin, false);
    assert.deepEqual(clone(value.availableWorkspaces), [{ id: workspaceB, name: "Local mortgage", role: "lead_manager",
      vertical: terms.DEFAULT_VERTICAL, purpose: "mortgage_leads" }]);
  }, { storage: { negis_workspace_purpose: "marketing", [selectorKey]: unknownWorkspace } });
});

for (const purpose of ["clinic_services", "marketing"] as const) {
  test(`explicit server ${purpose} purpose is accepted without inferring it from vertical or metadata`, async () => {
    await withFixture(async (fixture) => {
      await confirm(fixture, [membership({ purpose, vertical: "dental", role: "marketer" })]);
      assert.equal(fixture.snapshot().workspacePurpose, purpose);
      assert.equal(fixture.snapshot().vertical, "dental");
      assert.equal(fixture.snapshot().availableWorkspaces[0].purpose, purpose);
    });
  });
}

test("the user's clinic/mortgage picker swaps purpose, vertical and role and clearing restores null/default", async () => {
  await withFixture(async (fixture) => {
    await confirm(fixture, [membership(), mortgage()]);
    assertUnselected(fixture, true);
    assert.deepEqual(clone(fixture.snapshot().availableWorkspaces.map((entry) => entry.purpose)), ["clinic_services", "mortgage_leads"]);
    assert.equal(fixture.toasts.length, 0, "a valid multi-workspace picker is not denied access");
    await choose(fixture, workspaceA);
    assert.equal(fixture.snapshot().workspacePurpose, "clinic_services");
    assert.equal(fixture.snapshot().vertical, "beauty");
    assert.equal(fixture.snapshot().userRole, "owner");
    await choose(fixture, workspaceB);
    assert.equal(fixture.snapshot().workspacePurpose, "mortgage_leads");
    assert.equal(fixture.snapshot().vertical, terms.DEFAULT_VERTICAL);
    assert.equal(fixture.snapshot().userRole, "lead_manager");
    assert.equal(fixture.snapshot().rolePermissions.crm, true);
    assert.equal(fixture.snapshot().rolePermissions.admin, false);
    assert.equal(fixture.snapshot().rolePermissions.ads, false);
    assert.equal(fixture.storage.getItem(selectorKey), workspaceB);
    assert.equal(fixture.locations.at(-1), "/dashboard");
    await choose(fixture, workspaceA);
    assert.equal(fixture.snapshot().workspacePurpose, "clinic_services");
    assert.equal(fixture.snapshot().vertical, "beauty");
    fixture.snapshot().clearWorkspaceSelection();
    await fixture.renderer.flush();
    assertUnselected(fixture, true);
    assert.equal(fixture.storage.getItem(selectorKey), null);
    assert.equal(fixture.snapshot().availableWorkspaces.length, 2);
    assert.equal(fixture.snapshot().user?.id, actorA);
    assert.equal(fixture.requests.length, 4, "Bootstrap plus three freshly verified selections");
  });
});

for (const purpose of ["clinic_services", "marketing"] as const) {
  test(`the ${purpose} lead manager picker keeps the leads-only entry route`, async () => {
    await withFixture(async (fixture) => {
      await confirm(fixture, [membership(), { ...mortgage(), purpose }]);
      await choose(fixture, workspaceB, [membership(), { ...mortgage(), purpose }]);
      assert.equal(fixture.snapshot().workspacePurpose, purpose);
      assert.equal(fixture.snapshot().userRole, "lead_manager");
      assert.equal(fixture.snapshot().rolePermissions.admin, false);
      assert.equal(fixture.locations.at(-1), "/leads");
    });
  });
}

test("a picker cannot apply a workspace outside the current server memberships", async () => {
  await withFixture(async (fixture) => {
    await confirm(fixture, [membership(), mortgage()]);
    await choose(fixture, workspaceB);
    const before = context(fixture);
    const navigations = [...fixture.locations];
    fixture.snapshot().selectWorkspace(unknownWorkspace);
    await fixture.renderer.flush();
    assert.deepEqual(context(fixture), before);
    assert.deepEqual(fixture.locations, navigations);
    assert.equal(fixture.storage.getItem(selectorKey), workspaceB);
  });
});

test("invalid raw membership purposes deny access instead of falling back to clinic_services", async () => {
  for (const purpose of [null, "", "mortgage", "CLINIC_SERVICES", "clinic_services ", 42, { purpose: "clinic_services" }, ["marketing"]]) {
    await withFixture(async (fixture) => {
      await confirm(fixture, [membership({ purpose })]);
      assertUnselected(fixture);
      assert.equal(fixture.snapshot().user?.id, actorA);
      fixture.snapshot().selectWorkspace(workspaceA);
      await fixture.renderer.flush();
      assertUnselected(fixture);
    }, { storage: { [selectorKey]: workspaceA } });
  }
});

test("missing purpose in a successful frontend response is denied even with valid sibling profile hints", async () => {
  await withFixture(async (fixture) => {
    const entry = membership();
    delete (entry as Record<string, unknown>).purpose;
    await confirm(fixture, [entry]);
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().isStaffMode, false);
    assert.match(fixture.toasts.at(-1)?.message ?? "", /\u043f\u0440\u043e\u0444\u0438\u043b\u044c/);
  });
});

test("a successful current-account response with missing/invalid purpose cannot retain a previously confirmed profile", async () => {
  for (const purpose of [undefined, "unrecognized"] as const) {
    await withFixture(async (fixture) => {
      await confirm(fixture, [mortgage()]);
      const oldSelect = fixture.snapshot().selectWorkspace;
      fixture.emit(actorA, "USER_UPDATED");
      await fixture.renderer.flush();
      await fixture.respond(fixture.request(actorA, 1), success([mortgage()].map((entry) => ({ ...entry, purpose }))));
      assertUnselected(fixture);
      oldSelect(workspaceB);
      await fixture.renderer.flush();
      assertUnselected(fixture);
    });
  }
});

test("account A to B clears context, both caches and membership refs synchronously before B token/response", async () => {
  await withFixture(async (fixture) => {
    await confirm(fixture, [membership(), mortgage()]);
    await choose(fixture, workspaceA);
    const oldSelect = fixture.snapshot().selectWorkspace;
    fixture.seedCaches();
    const clearStart = fixture.cacheClears.length;
    const tokenGate = deferred<string>();
    fixture.token((expected) => expected === actorB ? tokenGate.promise : Promise.resolve("local-unused-token"));
    fixture.emit(actorB);
    assertCachesEmpty(fixture, clearStart);
    fixture.renderer.commit();
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().user?.id, actorB);
    assert.equal(fixture.snapshot().isLoading, true);
    assert.equal(fixture.snapshot().isStaffMode, false);
    assert.equal(fixture.requests.length, 2, "Bootstrap and verified A selection; B token is still pending");
    oldSelect(workspaceA);
    fixture.renderer.commit();
    assertUnselected(fixture);
    tokenGate.resolve("local-b-gated-token");
    await fixture.renderer.flush();
    assert.deepEqual(fixture.tokenCalls, [actorA, actorA, actorA, actorA, actorB], "Bootstrap and selection reverify A; B remains gated until its own token arrives");
    assertUnselected(fixture);
    await fixture.respond(fixture.request(actorB), success([mortgage()]));
    assert.equal(fixture.snapshot().workspacePurpose, "mortgage_leads");
  });
});

for (const timing of ["while B is pending", "after B is confirmed"] as const) {
  test(`late A bootstrap success cannot overwrite B ${timing}`, async () => {
    await withFixture(async (fixture) => {
      const previous = fixture.request(actorA);
      fixture.emit(actorB);
      await fixture.renderer.flush();
      if (timing === "after B is confirmed") await fixture.respond(fixture.request(actorB), success([mortgage()]));
      const before = effects(fixture);
      await fixture.respond(previous, success([membership()]));
      assert.deepEqual(effects(fixture), before, "expired success must not write state, selector, cache or toast");
      assert.equal(fixture.snapshot().user?.id, actorB);
      if (timing === "while B is pending") {
        assertUnselected(fixture);
        await fixture.respond(fixture.request(actorB), success([mortgage()]));
      }
      assert.equal(fixture.snapshot().workspacePurpose, "mortgage_leads");
    });
  });
}

test("late A denial or unavailable response cannot revoke B or announce A's failure", async () => {
  for (const status of [200, 401, 403, 503]) {
    await withFixture(async (fixture) => {
      const previous = fixture.request(actorA);
      fixture.emit(actorB);
      await fixture.renderer.flush();
      await fixture.respond(fixture.request(actorB), success([mortgage()]));
      const before = effects(fixture);
      await fixture.respond(previous, status === 200 ? success([]) : { success: false }, status);
      assert.deepEqual(effects(fixture), before, `expired status ${status}`);
    });
  }
});

test("a token lookup rejected by the changed SDK session before its event cannot announce missing membership", async () => {
  await withFixture(async (fixture) => {
    await confirm(fixture);
    const token = deferred<string>();
    fixture.token(() => token.promise);
    fixture.emit(actorA, "USER_UPDATED");
    await fixture.renderer.flush();
    fixture.setSdkActor(actorB);
    token.resolve("");
    await fixture.renderer.flush();
    assertUnselected(fixture);
    assert.equal(fixture.toasts.length, 0, "an expired session lookup is not verified empty membership");
    fixture.token();
    fixture.emit(actorB);
    await fixture.renderer.flush();
    await fixture.respond(fixture.request(actorB), success([mortgage()]));
    assert.equal(fixture.snapshot().user?.id, actorB);
    assert.equal(fixture.snapshot().userRole, "lead_manager");
  });
});

for (const status of [401, 403]) {
  test(`current-session HTTP ${status} must deny access without diagnosing an unlinked account`, async () => {
    await withFixture(async (fixture) => {
      await confirm(fixture);
      fixture.emit(actorA, "USER_UPDATED");
      await fixture.renderer.flush();
      await fixture.respond(fixture.request(actorA, 1), { success: false }, status);
      assertUnselected(fixture);
      assert.ok(fixture.toasts.length > 0, "a genuine authorization refusal remains visible");
      assert.ok(fixture.toasts.every(({ message }) => !message.includes("Аккаунт не привязан")));
    });
  });
}

for (const result of ["success", "denial"] as const) {
  test(`ABA auth events reject the first A generation's late ${result} even though its user ID matches again`, async () => {
    await withFixture(async (fixture) => {
      const firstA = fixture.request(actorA);
      fixture.emit(actorB);
      await fixture.renderer.flush();
      const firstB = fixture.request(actorB);
      fixture.emit(actorA);
      await fixture.renderer.flush();
      const currentA = fixture.request(actorA, 1);
      assertUnselected(fixture);
      const pending = effects(fixture);
      await fixture.respond(firstA, result === "success" ? success([membership()]) : { success: false }, result === "success" ? 200 : 403);
      assert.deepEqual(effects(fixture), pending);
      await fixture.respond(currentA, success([mortgage()]));
      const confirmed = effects(fixture);
      await fixture.respond(firstB, success([membership({ purpose: "marketing" })]));
      assert.deepEqual(effects(fixture), confirmed);
      assert.equal(fixture.snapshot().user?.id, actorA);
      assert.equal(fixture.snapshot().workspacePurpose, "mortgage_leads");
      assert.deepEqual(fixture.tokenCalls, [actorA, actorB, actorA, actorA], "only the current A response gets a publication verification");
    });
  });
}

test("SIGNED_OUT invalidates pending bootstrap success and denial without restoring context", async () => {
  for (const status of [200, 403]) {
    await withFixture(async (fixture) => {
      const previous = fixture.request(actorA);
      fixture.emit(null);
      await fixture.renderer.flush();
      assertUnselected(fixture);
      assert.equal(fixture.snapshot().user, null);
      assert.equal(fixture.snapshot().session, null);
      assert.equal(fixture.snapshot().isLoading, false);
      const before = effects(fixture);
      await fixture.respond(previous, status === 200 ? success([mortgage()]) : { success: false }, status);
      assert.deepEqual(effects(fixture), before);
    });
  }
});

test("signOut clears the confirmed profile and invalidates rechecks before a pending SDK logout resolves", async () => {
  await withFixture(async (fixture) => {
    await confirm(fixture, [membership(), mortgage()]);
    await choose(fixture, workspaceB);
    fixture.emit(actorA, "USER_UPDATED");
    await fixture.renderer.flush();
    const recheck = fixture.request(actorA, 2);
    const gate = fixture.holdSignOut();
    fixture.seedCaches();
    const clearStart = fixture.cacheClears.length;
    const signingOut = fixture.snapshot().signOut();
    assertCachesEmpty(fixture, clearStart);
    await fixture.renderer.flush();
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().user, null);
    assert.equal(fixture.snapshot().session, null);
    assert.equal(fixture.snapshot().isSigningOut, true);
    assert.equal(fixture.snapshot().isLoading, true);
    assert.equal(fixture.sdkCalls().signOut, 1);
    const before = effects(fixture);
    await fixture.respond(recheck, success([membership()]));
    assert.deepEqual(effects(fixture), before);
    gate.resolve();
    await signingOut;
    await fixture.renderer.flush();
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().isSigningOut, false);
    assert.equal(fixture.signOutBoundary.isSignOutPending(), false);
  });
});

test("SDK auth events during a pending logout cannot revive an account, bootstrap or unlinked toast", async () => {
  await withFixture(async (fixture) => {
    await confirm(fixture, [mortgage()]);
    const gate = fixture.holdSignOut();
    const signingOut = fixture.snapshot().signOut();
    await fixture.renderer.flush();
    const before = effects(fixture);
    const requests = fixture.requests.length;
    const tokens = fixture.tokenCalls.length;
    for (const [actor, event] of [[actorA, "INITIAL_SESSION"], [actorA, "TOKEN_REFRESHED"],
      [actorA, "USER_UPDATED"], [actorB, "SIGNED_IN"], [null, "SIGNED_OUT"]] as const) {
      fixture.emit(actor, event);
      await fixture.renderer.flush();
      assert.deepEqual(effects(fixture), before, event);
      assert.equal(fixture.requests.length, requests);
      assert.equal(fixture.tokenCalls.length, tokens);
      assertUnselected(fixture);
      assert.equal(fixture.snapshot().user, null);
    }
    gate.resolve(); await signingOut; await fixture.renderer.flush();
    fixture.emit(actorB); await fixture.renderer.flush();
    await fixture.respond(fixture.request(actorB), success([mortgage()]));
    assert.equal(fixture.snapshot().user?.id, actorB);
    assert.equal(fixture.snapshot().workspacePurpose, "mortgage_leads");
    assert.equal(fixture.snapshot().isSigningOut, false);
    assert.equal(fixture.toasts.length, 0);
  });
});

test("reload with a pending logout finishes SDK cleanup before any old-session profile lookup", async () => {
  await withFixture(async (fixture) => {
    assert.equal(fixture.snapshot().isSigningOut, true);
    assert.equal(fixture.snapshot().isLoading, true);
    assertUnselected(fixture);
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.tokenCalls.length, 0);
    assert.equal(fixture.sdkCalls().signOut, 1);
    assert.equal(fixture.subscriptions(), 0);
    fixture.releaseSignOut(); await fixture.renderer.flush();
    assert.equal(fixture.signOutBoundary.isSignOutPending(), false);
    assert.equal(fixture.snapshot().isSigningOut, false);
    assert.equal(fixture.snapshot().user, null);
    assert.equal(fixture.toasts.length, 0);
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.subscriptions(), 1, "new logins remain observable after recovery");
    fixture.emit(actorB); await fixture.renderer.flush();
    await fixture.respond(fixture.request(actorB), success([mortgage()]));
    assert.equal(fixture.snapshot().user?.id, actorB);
  }, { initialActor: actorA, sessionStorage: { negis_signout_pending_v1: "1" }, deferSignOut: true });
});

test("SDK logout errors keep the UI fenced and retryable without claiming unlinked or successful logout", async () => {
  for (const failure of ["return", "throw"] as const) {
    await withFixture(async (fixture) => {
      await confirm(fixture, [mortgage()]);
      fixture.failSignOut(failure);
      await fixture.snapshot().signOut(); await fixture.renderer.flush();
      assertUnselected(fixture);
      assert.equal(fixture.snapshot().user, null);
      assert.equal(fixture.snapshot().session, null);
      assert.equal(fixture.snapshot().isSigningOut, true);
      assert.equal(fixture.snapshot().signOutFailed, true);
      assert.equal(fixture.signOutBoundary.isSignOutPending(), true);
      assert.equal(fixture.toasts.length, 0);
      assert.equal(fixture.locations.length, 0);
      fixture.emit(actorA, "TOKEN_REFRESHED"); await fixture.renderer.flush();
      assert.equal(fixture.requests.length, 1);
      fixture.failSignOut(null);
      await fixture.snapshot().signOut(); await fixture.renderer.flush();
      assert.equal(fixture.sdkCalls().signOut, 2);
      assert.equal(fixture.snapshot().isSigningOut, false);
      assert.equal(fixture.snapshot().signOutFailed, false);
      assert.equal(fixture.signOutBoundary.isSignOutPending(), false);
      assert.deepEqual(fixture.locations, ["/"]);
      assert.equal(fixture.toasts.length, 0);
    });
  }
});

test("repeated logout clicks share one SDK request, marker and navigation", async () => {
  await withFixture(async (fixture) => {
    await confirm(fixture, [mortgage()]);
    const gate = fixture.holdSignOut();
    const first = fixture.snapshot().signOut();
    const second = fixture.snapshot().signOut();
    assert.equal(first, second);
    await fixture.renderer.flush();
    assert.equal(fixture.sdkCalls().signOut, 1);
    assert.equal(fixture.locations.length, 0);
    gate.resolve(); await first; await fixture.renderer.flush();
    assert.deepEqual(fixture.locations, ["/"]);
    assert.equal(fixture.snapshot().isSigningOut, false);
  });
});

test("failed reload cleanup cannot restore legacy authentication or show an unlinked profile toast", async () => {
  await withFixture(async (fixture) => {
    fixture.failSignOut("return");
    fixture.releaseSignOut(); await fixture.renderer.flush();
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().user, null);
    assert.equal(fixture.snapshot().isDemoMode, false);
    assert.equal(fixture.snapshot().isImpersonation, false);
    assert.equal(fixture.snapshot().signOutFailed, true);
    assert.equal(fixture.snapshot().isSigningOut, true);
    assert.equal(fixture.tokenCalls.length, 0);
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.toasts.length, 0);
    fixture.failSignOut(null);
    await fixture.snapshot().signOut(); await fixture.renderer.flush();
    assert.equal(fixture.snapshot().isSigningOut, false);
    assert.equal(fixture.subscriptions(), 1);
    assert.equal(fixture.snapshot().user, null);
  }, { initialActor: actorA, sessionStorage: { negis_signout_pending_v1: "1" }, deferSignOut: true,
    storage: { negis_demo_user: JSON.stringify({ id: "isolated-demo", name: "Local demo" }),
      negis_demo_workspace: JSON.stringify({ id: "isolated-demo-workspace", name: "Local demo" }),
      negis_demo_session: JSON.stringify({ mode: "demo", authenticated: true, createdAt: "2026-01-01T00:00:00Z" }) } });
});

test("a retired provider's completed SDK logout cannot publish or clear the recovery fence", async () => {
  await withFixture(async (fixture) => {
    await confirm(fixture, [mortgage()]);
    const gate = fixture.holdSignOut();
    const signingOut = fixture.snapshot().signOut();
    await fixture.renderer.flush();
    fixture.renderer.dispose();
    const writes = fixture.renderer.writes.length;
    const locations = fixture.locations.length;
    const exitRevision = fixture.signOutBoundary.getSignOutRevision();
    assert.equal(fixture.signOutBoundary.isSignOutPending(), true);
    gate.resolve(); await signingOut; await fixture.renderer.flush();
    assert.equal(fixture.renderer.writes.length, writes);
    assert.equal(fixture.locations.length, locations);
    assert.equal(fixture.toasts.length, 0);
    assert.equal(fixture.signOutBoundary.isSignOutPending(), true,
      "an unmounted provider cannot declare recovery complete for the next provider");
    assert.equal(fixture.signOutBoundary.getSignOutRevision(), exitRevision,
      "retired completion cannot mutate the shared exit ownership revision");
    assert.equal(fixture.subscriptions(), 0);
  });
});

for (const oldMounted of [true, false]) for (const outcome of [null, "return", "throw"] as const)
test(`a previous ${oldMounted ? "mounted" : "unmounted"} provider's late ${outcome ?? "success"} cannot clear a newer logout fence`, async () => {
  const previous = setup(); let current: Fixture | undefined;
  try {
    await previous.renderer.flush(); await confirm(previous, [mortgage()]);
    const oldGate = previous.holdSignOut(), oldRequest = previous.snapshot().signOut();
    previous.failSignOut(outcome);
    await previous.renderer.flush();
    const oldRevision = previous.signOutBoundary.getSignOutRevision();
    if (!oldMounted) previous.renderer.dispose();
    current = setup({ initialActor: actorA, deferSignOut: true, sharedSignOut: {
      storage: previous.storage, sessionStorage: previous.sessionStorage, boundary: previous.signOutBoundary,
    } });
    await current.renderer.flush();
    const currentRevision = current.signOutBoundary.getSignOutRevision();
    assert.ok(currentRevision > oldRevision); assert.equal(current.sdkCalls().signOut, 1);
    assert.equal(current.requests.length, 0); assert.equal(current.snapshot().isSigningOut, true);
    oldGate.resolve(); await oldRequest; await current.renderer.flush();
    await previous.renderer.flush();
    assert.equal(current.signOutBoundary.isSignOutPending(), true, "old completion must not clear the new attempt's tombstone");
    assert.equal(current.signOutBoundary.getSignOutRevision(), currentRevision);
    assert.equal(current.snapshot().user, null); assert.equal(current.subscriptions(), 0);
    assert.deepEqual(previous.locations, []); assert.deepEqual(previous.toasts, []);
    if (oldMounted) assert.equal(previous.snapshot().signOutFailed, false, "obsolete errors must not be published");
    current.releaseSignOut(); await current.renderer.flush();
    assert.equal(current.signOutBoundary.isSignOutPending(), false);
    assert.equal(current.snapshot().isSigningOut, false); assert.equal(current.subscriptions(), 1);
  } finally { previous.renderer.dispose(); current?.renderer.dispose(); }
});

test("a retired logout which has not called the SDK cannot dispatch after a newer exit starts", async () => {
  await withFixture(async fixture => {
    await confirm(fixture, [mortgage()]);
    const old = fixture.snapshot().signOut();
    fixture.signOutBoundary.markSignOutPending();
    await old; await fixture.renderer.flush();
    assert.equal(fixture.sdkCalls().signOut, 0);
    assert.equal(fixture.signOutBoundary.isSignOutPending(), true);
    assert.deepEqual(fixture.locations, []); assert.deepEqual(fixture.toasts, []);
    assert.equal(fixture.snapshot().signOutFailed, false);
  });
});

test("same-account USER_UPDATED plus 503 preserves confirmed role, purpose, choices and both caches", async () => {
  await withFixture(async (fixture) => {
    await confirm(fixture, [membership(), mortgage()]);
    await choose(fixture, workspaceB);
    fixture.seedCaches();
    const before = context(fixture), clearStart = fixture.cacheClears.length;
    fixture.emit(actorA, "USER_UPDATED");
    await fixture.renderer.flush();
    assert.deepEqual(context(fixture), before, "confirmed context remains during the same-user recheck");
    await fixture.respond(fixture.request(actorA, 2), { success: false }, 503);
    assert.deepEqual(context(fixture), before);
    assert.equal(fixture.caches.crm.size, 1);
    assert.equal(fixture.caches.lists.size, 1);
    assert.equal(fixture.cacheClears.length, clearStart);
    assert.equal(fixture.storage.getItem(selectorKey), workspaceB);
  });
});

test("new-account 503 cannot inherit A's confirmed role, purpose, choices, refs or cached data", async () => {
  await withFixture(async (fixture) => {
    await confirm(fixture, [membership(), mortgage()]);
    await choose(fixture, workspaceB);
    const oldSelect = fixture.snapshot().selectWorkspace;
    fixture.seedCaches();
    const clearStart = fixture.cacheClears.length;
    fixture.emit(actorB, "USER_UPDATED");
    await fixture.renderer.flush();
    assertUnselected(fixture);
    assertCachesEmpty(fixture, clearStart);
    await fixture.respond(fixture.request(actorB), { success: false }, 503);
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().user?.id, actorB);
    assert.equal(fixture.snapshot().isLoading, false);
    oldSelect(workspaceB);
    await fixture.renderer.flush();
    assertUnselected(fixture);
  });
});

test("same-user owner downgrade to lead_manager applies new permissions and clears both read caches", async () => {
  await withFixture(async (fixture) => {
    const owned = mortgage();
    await confirm(fixture, [{ ...owned, role: "owner", permissions: ["view_clients", "manage_staff"] }]);
    assert.equal(fixture.snapshot().rolePermissions.admin, true);
    fixture.seedCaches();
    const clearStart = fixture.cacheClears.length;
    fixture.emit(actorA, "USER_UPDATED");
    await fixture.renderer.flush();
    await fixture.respond(fixture.request(actorA, 1), success([owned]));
    assert.equal(fixture.snapshot().userRole, "lead_manager");
    assert.equal(fixture.snapshot().workspacePurpose, "mortgage_leads");
    assert.equal(fixture.snapshot().rolePermissions.admin, false);
    assert.equal(fixture.snapshot().rolePermissions.dashboard, false);
    assert.equal(fixture.snapshot().rolePermissions.crm, true);
    assert.equal(fixture.snapshot().availableWorkspaces[0].role, "lead_manager");
    assertCachesEmpty(fixture, clearStart);
  });
});

test("same-user authoritative membership revocation clears purpose, role, choices, refs and both caches", async () => {
  await withFixture(async (fixture) => {
    await confirm(fixture, [mortgage()]);
    const oldSelect = fixture.snapshot().selectWorkspace;
    fixture.seedCaches();
    const clearStart = fixture.cacheClears.length;
    fixture.emit(actorA, "USER_UPDATED");
    await fixture.renderer.flush();
    await fixture.respond(fixture.request(actorA, 1), success([]));
    assertUnselected(fixture);
    assertCachesEmpty(fixture, clearStart);
    assert.equal(fixture.snapshot().user?.id, actorA);
    oldSelect(workspaceB);
    await fixture.renderer.flush();
    assertUnselected(fixture);
  });
});

test("same-user overlapping bootstrap generations cannot let an older denial revoke the newer confirmed profile", async () => {
  await withFixture(async (fixture) => {
    await confirm(fixture);
    fixture.emit(actorA, "USER_UPDATED");
    await fixture.renderer.flush();
    const old = fixture.request(actorA, 1);
    fixture.emit(actorA, "USER_UPDATED");
    await fixture.renderer.flush();
    await fixture.respond(fixture.request(actorA, 2), success([mortgage()]));
    const before = effects(fixture);
    await fixture.respond(old, { success: false }, 403);
    assert.deepEqual(effects(fixture), before);
  });
});

test("a callback-confirmed B session cannot be overwritten by a delayed initial getSession A/null snapshot", async () => {
  for (const initial of [actorA, null]) {
    await withFixture(async (fixture) => {
      assert.equal(fixture.subscriptions(), 1);
      assert.equal(fixture.sdkCalls().getSession, 1);
      assert.equal(fixture.requests.length, 0);
      fixture.emit(actorB);
      await fixture.renderer.flush();
      await fixture.respond(fixture.request(actorB), success([mortgage()]));
      const before = effects(fixture);
      fixture.sessionGate.resolve({ data: { session: localSession(initial) } });
      await fixture.renderer.flush();
      assert.deepEqual(effects(fixture), before);
      assert.equal(fixture.requests.length, 1, "late initial snapshot cannot dispatch a previous actor bootstrap");
      assert.deepEqual(fixture.tokenCalls, [actorB, actorB], "B is checked before dispatch and before publication");
    }, { deferSession: true });
  }
});

test("a pending expected-user token lookup cannot dispatch or apply A after the auth callback switches to B", async () => {
  await withFixture(async (fixture) => {
    const gate = deferred<string>();
    fixture.token((expected) => expected === actorA ? gate.promise : Promise.resolve("local-b-token"));
    fixture.sessionGate.resolve({ data: { session: localSession(actorA) } });
    await fixture.renderer.flush();
    assert.deepEqual(fixture.tokenCalls, [actorA]);
    assert.equal(fixture.requests.length, 0);
    fixture.emit(actorB);
    await fixture.renderer.flush();
    await fixture.respond(fixture.request(actorB), success([mortgage()]));
    const before = effects(fixture);
    gate.resolve("local-delayed-a-token");
    await fixture.renderer.flush();
    assert.deepEqual(effects(fixture), before);
    assert.deepEqual(fixture.tokenCalls, [actorA, actorB, actorB], "only B may be reverified after its response");
    assert.equal(fixture.requests.length, 1);
  }, { deferSession: true });
});

test("a response body resolved after rerender cannot apply the previous account's parsed profile", async () => {
  await withFixture(async (fixture) => {
    const body = deferred<string>();
    fixture.request(actorA).resolve({ ok: true, status: 200, text: () => body.promise } as Response);
    await fixture.renderer.flush();
    fixture.emit(actorB);
    await fixture.renderer.flush();
    await fixture.respond(fixture.request(actorB), success([mortgage()]));
    const before = effects(fixture);
    body.resolve(JSON.stringify(success([membership()])));
    await fixture.renderer.flush();
    assert.deepEqual(effects(fixture), before);
  });
});

test("provider unmount unsubscribes and pending bootstrap success/denial cannot even attempt a state write", async () => {
  for (const status of [200, 403, 503]) {
    await withFixture(async (fixture) => {
      const pending = fixture.request(actorA);
      fixture.renderer.dispose();
      assert.equal(fixture.subscriptions(), 0);
      const before = effects(fixture);
      fixture.emit(actorB);
      await fixture.respond(pending, status === 200 ? success([mortgage()]) : { success: false }, status);
      assert.deepEqual(effects(fixture), before);
      assert.equal(fixture.requests.length, 1);
    });
  }
});

test("provider unmount during the initial getSession gate cannot dispatch bootstrap or set state", async () => {
  await withFixture(async (fixture) => {
    fixture.renderer.dispose();
    const before = effects(fixture);
    fixture.sessionGate.resolve({ data: { session: localSession(actorA) } });
    await fixture.renderer.flush();
    assert.deepEqual(effects(fixture), before);
    assert.equal(fixture.subscriptions(), 0);
    assert.equal(fixture.requests.length, 0);
    assert.deepEqual(fixture.tokenCalls, []);
  }, { deferSession: true });
});

test("legacy demo restoration after a signed-out boundary resets mortgage profile and refuses stale memberships", async () => {
  await withFixture(async (fixture) => {
    await confirm(fixture, [mortgage()]);
    const oldSelect = fixture.snapshot().selectWorkspace;
    fixture.emit(actorA, "USER_UPDATED");
    await fixture.renderer.flush();
    const oldReply = fixture.request(actorA, 1);
    fixture.storage.setItem("negis_demo_user", JSON.stringify({ id: "local-profile-demo-user", name: "Local demo", purpose: "mortgage_leads" }));
    fixture.storage.setItem("negis_demo_workspace", JSON.stringify({ id: "local-profile-demo-workspace", name: "Local demo", purpose: "mortgage_leads", vertical: "beauty" }));
    fixture.storage.setItem("negis_demo_session", JSON.stringify({ mode: "demo", authenticated: true, createdAt: "2026-01-01T00:00:00Z" }));
    fixture.emit(null);
    await fixture.renderer.flush();
    assert.equal(fixture.snapshot().isDemoMode, true);
    assert.equal(fixture.snapshot().workspacePurpose, "clinic_services", "legacy demo uses its explicit clinic profile, not previous mortgage purpose");
    assert.equal(fixture.snapshot().vertical, terms.DEFAULT_VERTICAL);
    assert.deepEqual(clone(fixture.snapshot().availableWorkspaces), []);
    const before = effects(fixture);
    await fixture.respond(oldReply, success([mortgage()]));
    assert.deepEqual(effects(fixture), before);
    oldSelect(workspaceB);
    await fixture.renderer.flush();
    assert.equal(fixture.snapshot().clinicId, "local-profile-demo-workspace");
    assert.equal(fixture.snapshot().workspacePurpose, "clinic_services");
    await fixture.snapshot().signOut();
    await fixture.renderer.flush();
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().user, null);
    assert.equal(fixture.snapshot().isDemoMode, false);
    assert.equal(fixture.storage.getItem("negis_demo_workspace"), null);
  });
});

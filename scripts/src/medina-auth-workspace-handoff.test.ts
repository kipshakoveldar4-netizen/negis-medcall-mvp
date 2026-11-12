import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Real AuthProvider/useAuth and permission helpers; synthetic hooks, SDK, storage,
// transport and navigation. This is not React DOM or a live server/browser test.
// Imports are closed: no environment files, credentials, providers or network.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const read = (file: string) => readFile(path.join(root, file), "utf8");
const source = await read("artifacts/negis/src/contexts/AuthContext.tsx");
class StaleAuthIntentError extends Error { name = "StaleAuthIntentError"; }
const signOutSource = await read("artifacts/negis/src/lib/authSignOut.ts");
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
type Element = { type: any; props: Record<string, any> };
const jsx = (type: any, props: Element["props"]): Element => ({ type, props });

function evaluate(code: string, imports: Record<string, unknown> = {}, bindings: Record<string, unknown> = {}) {
  const exports: Record<string, any> = {};
  const compiled = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
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
      return file => ts.visitNode(file, visit) as import("typescript").SourceFile;
    }] },
  }).outputText;
  new Script(compiled).runInNewContext({
    exports, URLSearchParams, Response, AbortController, AbortSignal, DOMException, setTimeout, clearTimeout, ...bindings,
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
const sameDeps = (a?: unknown[], b?: unknown[]) => Boolean(a && b && a.length === b.length
  && a.every((value, index) => Object.is(value, b[index])));
type Instance = { slots: any[]; cursor: number; disposed: boolean };

function hookRenderer() {
  const instances = new Map<string, Instance>();
  const writes: { instance: Instance; value: unknown }[] = [];
  let current: Instance;
  let rootNode: Element;
  let dirty = true;
  let mounted = true;
  function render(value: any, address: string): any {
    if (Array.isArray(value)) return value.map((child, index) => render(child, `${address}/${index}`));
    if (!value || typeof value !== "object" || !("props" in value)) return value;
    if (value.type?.context) {
      const context = value.type.context, previous = context.current;
      context.current = value.props.value;
      const result = render(value.props.children, `${address}/provider`);
      context.current = previous;
      return result;
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
    const index = current.cursor++, old = current.slots[index];
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
      const pending = [...instances.values()].flatMap(instance => instance.slots)
        .filter(slot => slot?.pending && slot.layout === layout);
      for (const slot of pending) slot.cleanup?.();
      for (const slot of pending) { slot.pending = false; slot.cleanup = slot.create(); }
    }
  }
  return {
    hooks, writes,
    mount(type: any, child: any) { rootNode = jsx(type, { children: jsx(child, {}) }); },
    async flush() {
      for (let pass = 0; pass < 80; pass++) { commit(); await Promise.resolve(); }
      assert.equal(dirty, false, "synthetic hooks must settle");
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
  const values = new Map(Object.entries(seed)), writes: { key: string; value: string | null }[] = [];
  return {
    values, writes,
    getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) { values.set(key, value); writes.push({ key, value }); },
    removeItem(key: string) { values.delete(key); writes.push({ key, value: null }); },
  };
}

const actorA = "00000000-0000-4000-8000-000000000201";
const actorB = "00000000-0000-4000-8000-000000000202";
const workspaceA = "00000000-0000-4000-8000-000000000203";
const workspaceB = "00000000-0000-4000-8000-000000000204";
const workspaceC = "00000000-0000-4000-8000-000000000205";
const selectorKey = "negis_workspace_selector";
const localSession = (id: string | null) => id ? { user: { id, email: "local@example.test",
  user_metadata: { role: "owner", purpose: "marketing", vertical: "dental" }, app_metadata: {} } } : null;
const membership = (patch: Record<string, unknown> = {}) => ({
  staffUserId: "local-owner-a", workspaceId: workspaceA, workspaceName: "Old local clinic",
  role: "owner", permissions: ["view_clients", "manage_staff"], vertical: "beauty", purpose: "clinic_services", ...patch,
});
const target = (patch: Record<string, unknown> = {}) => membership({ staffUserId: "local-owner-b",
  workspaceId: workspaceB, workspaceName: "Fresh local company", vertical: "dental", purpose: "mortgage_leads", ...patch });
const success = (memberships: Record<string, unknown>[]) => ({ success: true, mode: "supabase", data: {
  memberships, workspaceId: workspaceA, requiresWorkspaceSelection: true, purpose: "clinic_services", vertical: "beauty",
} });
type EntryOptions = { expectedUserId: string; signal: AbortSignal; isCurrent(): boolean; confirm?(): Promise<void> };
type Snapshot = {
  user: { id: string } | null; session: unknown; clinicId: string | null; userRole: string | null;
  rolePermissions: Record<string, boolean>; vertical: string; workspacePurpose: string | null;
  availableWorkspaces: { id: string; name: string; role: string; vertical: string; purpose: string }[];
  isLoading: boolean; isStaffMode: boolean; isDemoMode: boolean; isImpersonation: boolean; isSigningOut: boolean;
  workspaceSelectionFailed: boolean;
  enterWorkspace(id: string, options: EntryOptions): Promise<boolean>;
  selectWorkspace(id: string): void; clearWorkspaceSelection(): void; signOut(): Promise<void>;
};
type Init = RequestInit & { accessToken?: string; expectedUserId?: string; dispatchGuard?: () => boolean };
type PendingRequest = { init: Init; resolve(response: Response): void; reject(error: unknown): void;
  reply(body: unknown, status?: number): void };
type Options = { initialActor?: string | null; storage?: Record<string, string>; deferSignOut?: boolean };

// The transport remains mocked; preserve its exported error identity/contract.
class CrmApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "CrmApiError";
  }
}

function setup(options: Options = {}) {
  const renderer = hookRenderer(), storage = memoryStorage(options.storage), sessionStorage = memoryStorage();
  const signOutBoundary = evaluate(signOutSource, {}, { window: { localStorage: storage, sessionStorage } });
  const requests: PendingRequest[] = [], attempts: PendingRequest[] = [];
  const callbacks = new Set<(event: string, session: ReturnType<typeof localSession>) => void>();
  const tokenCalls: (string | undefined)[] = [], locations: string[] = [], toasts: unknown[] = [];
  const caches = { crm: new Map<string, unknown>(), lists: new Map<string, unknown>() };
  const readScopes: { kind: "bind" | "clear"; args: unknown[] }[] = [];
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const location = { search: "", hash: "", origin: "https://example.test", pathname: "/partner-company",
    href: "https://example.test/partner-company" };
  function updateLocation(url?: string | URL | null) {
    if (url == null) return;
    const next = new URL(String(url), location.href);
    Object.assign(location, { pathname: next.pathname, search: next.search, hash: next.hash, href: next.href });
  }
  // Wouter's installed history wrappers dispatch these events after mutating history.
  const pushState = (_data: unknown, _unused: string, url?: string | URL | null) => {
    updateLocation(url); browser.dispatchEvent(new Event("pushState"));
  };
  const replaceState = (_data: unknown, _unused: string, url?: string | URL | null) => {
    updateLocation(url); browser.dispatchEvent(new Event("replaceState"));
  };
  const history = { pushState, replaceState };
  const browser = { localStorage: storage, sessionStorage, location, history,
    addEventListener(type: string, listener: (event: Event) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: (event: Event) => void) { listeners.get(type)?.delete(listener); },
    dispatchEvent(event: Event) {
      for (const listener of [...(listeners.get(event.type) ?? [])]) listener(event);
      return true;
    },
  };
  let snapshot!: Snapshot;
  let sdkActor = options.initialActor === undefined ? actorA : options.initialActor;
  let sdkRevision = 0;
  let sdkIntent = 0;
  const stamps = new WeakMap<object, { actorId: string | null; revision: number }>();
  let tokenReply: ((expected?: string) => Promise<string>) | undefined;
  let tokenVersion = "initial";
  let dispatchGate: ReturnType<typeof deferred<void>> | undefined;
  const signOutGate = options.deferSignOut ? deferred<void>() : undefined;
  function emit(id: string | null, event = id ? "SIGNED_IN" : "SIGNED_OUT") {
    if (id !== sdkActor || !["TOKEN_REFRESHED", "USER_UPDATED"].includes(event)) sdkIntent++;
    sdkActor = id;
    sdkRevision++;
    for (const callback of [...callbacks]) callback(event, localSession(id));
  }
  const sdk = {
    onAuthStateChange(callback: (event: string, session: ReturnType<typeof localSession>) => void) {
      callbacks.add(callback);
      return { data: { subscription: { unsubscribe: () => callbacks.delete(callback) } } };
    },
    getSession: async () => ({ data: { session: localSession(sdkActor) } }),
    async signOut() { if (signOutGate) await signOutGate.promise; emit(null); return { error: null }; },
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
    "@/lib/permissions": permissions,
    wouter: { useLocation: () => [location.pathname, (next: string) => {
      locations.push(next);
      browser.history.pushState(null, "", next);
    }] },
    sonner: { toast: new Proxy({}, { get: (_target, kind) => (message: string) => toasts.push({ kind, message }) }) },
    "@/lib/demoStorage": {
      WORKSPACE_SELECTOR_KEY: selectorKey,
      clearListReadCache: () => caches.lists.clear(),
      bindWorkspaceReadScope(...args: unknown[]) { readScopes.push({ kind: "bind", args }); },
      clearWorkspaceReadScope(...args: unknown[]) { readScopes.push({ kind: "clear", args }); },
    },
    "@/lib/api": {
      CrmApiError,
      apiUrl: (url: string) => url,
      clearCrmCache: () => caches.crm.clear(),
      async crmFetch(url: string, init: Init = {}) {
        assert.equal(url, "/api/crm/auth-context", "only the local auth-context stub is permitted");
        const gate = deferred<Response>();
        const request = { init, resolve: gate.resolve, reject: gate.reject,
          reply(body: unknown, status = 200) { gate.resolve(Response.json(body, { status })); } };
        attempts.push(request);
        // Models the API wrapper's last-moment guard, not its implementation.
        if (dispatchGate) await dispatchGate.promise;
        if (init.signal?.aborted || (init.dispatchGuard && !init.dispatchGuard())) {
          throw new DOMException("Local request retired", "AbortError");
        }
        requests.push(request);
        return gate.promise;
      },
    },
    "@/lib/serverAuth": { async getSupabaseAccessToken(expected?: string) {
      tokenCalls.push(expected);
      if (tokenReply) return tokenReply(expected);
      return expected && expected === sdkActor ? `local-fixture:${expected}:${tokenVersion}` : "";
    } },
  }, {
    localStorage: storage, sessionStorage,
    window: browser,
    document: { title: "Isolated workspace handoff" },
    fetch() { throw new Error("Network forbidden in the local AuthProvider harness"); },
  });
  function Probe() { snapshot = auth.useAuth(); return null; }
  renderer.mount(auth.AuthProvider, Probe);
  return {
    renderer, storage, sessionStorage, requests, attempts, tokenCalls, locations, toasts, caches, readScopes, emit,
    route: () => location.pathname + location.search + location.hash,
    windowListeners: () => [...listeners.values()].reduce((count, registered) => count + registered.size, 0),
    historyRestored: () => browser.history.pushState === pushState && browser.history.replaceState === replaceState,
    navigate(method: "popstate" | "hashchange" | "pushState" | "replaceState", url: string) {
      if (method === "pushState" || method === "replaceState") browser.history[method](null, "", url);
      else { updateLocation(url); browser.dispatchEvent(new Event(method)); }
    },
    snapshot: () => snapshot,
    subscriptions: () => callbacks.size,
    token(reply?: typeof tokenReply) { tokenReply = reply; },
    rotateToken() { tokenVersion = "fresh-handoff"; },
    setSdkActor(id: string | null) { sdkActor = id; },
    holdDispatch() { dispatchGate = deferred<void>(); return dispatchGate; },
    releaseSignOut() { signOutGate?.resolve(); },
    request(index = requests.length - 1) {
      const request = requests[index];
      assert.ok(request, `missing isolated auth-context request ${index + 1}`);
      return request;
    },
    seedCaches() { caches.crm.set("old-clinic", ["old CRM rows"]); caches.lists.set("old-clinic", ["old list rows"]); },
    async respond(request: PendingRequest, body: unknown, status = 200) { request.reply(body, status); await renderer.flush(); },
  };
}
type Fixture = ReturnType<typeof setup>;
async function withFixture(run: (fixture: Fixture) => Promise<void>, options: Options = {}) {
  const fixture = setup(options);
  try { await fixture.renderer.flush(); await run(fixture); }
  finally {
    fixture.renderer.dispose();
    fixture.releaseSignOut();
    assert.equal(fixture.subscriptions(), 0, "fixture disposal releases the SDK subscription");
    assert.equal(fixture.windowListeners(), 0, "fixture disposal releases navigation listeners");
    assert.equal(fixture.historyRestored(), true, "fixture disposal restores its owned history methods");
  }
}
async function confirm(fixture: Fixture, memberships = [membership()]) {
  await fixture.respond(fixture.request(0), success(memberships));
  assert.equal(fixture.snapshot().isLoading, false);
  assert.equal(typeof fixture.snapshot().enterWorkspace, "function", "the actual AuthProvider must expose enterWorkspace");
}
async function beginPick(fixture: Fixture, workspaceId: string) {
  const requests = fixture.requests.length;
  assert.equal(fixture.snapshot().selectWorkspace(workspaceId), undefined, "the picker retains its void API");
  await fixture.renderer.flush();
  assert.equal(fixture.requests.length, requests + 1, "a known current picker choice starts one fresh verification");
  return fixture.request();
}
async function pick(fixture: Fixture, workspaceId: string, memberships = [membership()]) {
  await fixture.respond(await beginPick(fixture, workspaceId), success(memberships));
  assert.equal(fixture.snapshot().isLoading, false);
}
function entryOptions(patch: Partial<EntryOptions> = {}): EntryOptions {
  return { expectedUserId: actorA, signal: new AbortController().signal, isCurrent: () => true, ...patch };
}
function assertNeutral(fixture: Fixture) {
  const value = fixture.snapshot();
  assert.equal(value.clinicId, null);
  assert.equal(value.userRole, null);
  assert.deepEqual(clone(value.rolePermissions), {});
  assert.equal(value.workspacePurpose, null);
  assert.equal(value.vertical, terms.DEFAULT_VERTICAL);
  assert.equal(fixture.storage.getItem(selectorKey), null);
}
function assertUnselected(fixture: Fixture) {
  assertNeutral(fixture);
  assert.deepEqual(clone(fixture.snapshot().availableWorkspaces), []);
}
function effects(fixture: Fixture) {
  const { enterWorkspace: _entry, selectWorkspace: _select, clearWorkspaceSelection: _clear, signOut: _exit, ...state } = fixture.snapshot();
  return clone({ state, storage: [...fixture.storage.values], storageWrites: fixture.storage.writes.length,
    writes: fixture.renderer.writes.length, locations: fixture.locations, toasts: fixture.toasts,
    crm: [...fixture.caches.crm], lists: [...fixture.caches.lists], readScopes: fixture.readScopes });
}
function observe(pending: Promise<boolean>) {
  const outcome: { settled: boolean; result?: boolean; failure?: unknown } = { settled: false };
  void pending.then(value => { outcome.settled = true; outcome.result = value; },
    error => { outcome.settled = true; outcome.failure = error; });
  return outcome;
}
async function settleObserved(fixture: Fixture, outcome: ReturnType<typeof observe>, denialStatus?: number) {
  await fixture.renderer.flush();
  assert.equal(outcome.settled, true, "handoff must settle after its local boundaries resolve");
  if (denialStatus !== undefined) {
    assert.ok(outcome.failure instanceof CrmApiError, "confirmed denial must reject with the transport's typed error");
    assert.equal(outcome.failure.status, denialStatus);
    assert.equal(outcome.failure.code, "partner_company_access_denied");
    assert.equal(outcome.result, undefined);
  } else assert.equal(outcome.failure, undefined, "non-denial failures resolve false, never reject");
  return outcome.result;
}
function settle(fixture: Fixture, pending: Promise<boolean>) {
  return settleObserved(fixture, observe(pending));
}

test("generic picker reproduction: silent SDK actor replacement cannot apply cached W or leave tenant caches", async () => {
  await withFixture(async fixture => {
    await confirm(fixture);
    const oldPick = fixture.snapshot().selectWorkspace;
    fixture.seedCaches();
    fixture.setSdkActor(actorB);
    oldPick(workspaceA);
    await fixture.renderer.flush();
    assert.deepEqual(clone({ clinicId: fixture.snapshot().clinicId, role: fixture.snapshot().userRole,
      selector: fixture.storage.getItem(selectorKey), locations: fixture.locations,
      crm: [...fixture.caches.crm], lists: [...fixture.caches.lists], scope: fixture.readScopes.at(-1)?.args[1] }),
    { clinicId: null, role: null, selector: null, locations: [], crm: [], lists: [], scope: null },
    "cached W belongs to A; an SDK-only replacement by B must quarantine it without navigation");
  });
});

test("generic picker reproduction: old A callback cannot act as the new A after actor ABA", async () => {
  await withFixture(async fixture => {
    await confirm(fixture, [membership(), target()]);
    const oldPick = fixture.snapshot().selectWorkspace;
    fixture.emit(actorB);
    await fixture.renderer.flush();
    await fixture.respond(fixture.request(), success([target({ workspaceId: workspaceC })]));
    fixture.emit(actorA);
    await fixture.renderer.flush();
    await fixture.respond(fixture.request(), success([membership(), target()]));
    fixture.seedCaches();
    const before = effects(fixture), tokens = fixture.tokenCalls.length, attempts = fixture.attempts.length;
    oldPick(workspaceA);
    await fixture.renderer.flush();
    assert.deepEqual(effects(fixture), before, "a captured A callback must not adopt a later A identity epoch");
    assert.equal(fixture.tokenCalls.length, tokens);
    assert.equal(fixture.attempts.length, attempts);
  });
});

test("fresh owner-only handoff clears the old tenant before token lookup and applies fresh target metadata", async () => {
  await withFixture(async fixture => {
    await confirm(fixture);
    fixture.seedCaches();
    const tokensBefore = fixture.tokenCalls.length, token = deferred<string>();
    fixture.token(() => token.promise);
    const pending = fixture.snapshot().enterWorkspace(workspaceB, entryOptions());
    await fixture.renderer.flush();
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().isLoading, true);
    assert.equal(fixture.snapshot().user?.id, actorA);
    assert.equal(fixture.caches.crm.size, 0);
    assert.equal(fixture.caches.lists.size, 0);
    assert.equal(fixture.requests.length, 1, "the new token lookup is still pending");
    assert.deepEqual(fixture.tokenCalls.slice(tokensBefore), [actorA]);
    token.resolve("fresh-local-token");
    await fixture.renderer.flush();
    const request = fixture.request();
    assert.equal(request.init.accessToken, "fresh-local-token");
    assert.equal(request.init.expectedUserId, actorA);
    assert.ok(request.init.signal, "caller cancellation reaches the request boundary");
    assert.equal(typeof request.init.dispatchGuard, "function");
    assert.equal(request.init.dispatchGuard!(), true);
    assert.deepEqual(fixture.locations, []);
    await fixture.respond(request, success([membership(), target()]));
    assert.equal(await settle(fixture, pending), true);
    assert.equal(fixture.snapshot().clinicId, workspaceB);
    assert.equal(fixture.snapshot().userRole, "owner");
    assert.equal(fixture.snapshot().workspacePurpose, "mortgage_leads");
    assert.equal(fixture.snapshot().vertical, "dental");
    assert.equal(fixture.snapshot().rolePermissions.admin, true);
    assert.equal(fixture.snapshot().availableWorkspaces.find(value => value.id === workspaceB)?.name, "Fresh local company");
    assert.equal(fixture.snapshot().isLoading, false);
    assert.equal(fixture.storage.getItem(selectorKey), workspaceB);
    assert.equal(fixture.readScopes.at(-1)?.kind, "bind");
    assert.equal(fixture.readScopes.at(-1)?.args[1], workspaceB);
    assert.deepEqual(fixture.locations, ["/dashboard"]);
    assert.ok(fixture.tokenCalls.length >= tokensBefore + 2, "fresh token is reverified before publication");
    assert.ok(fixture.tokenCalls.slice(tokensBefore).every(value => value === actorA));
  });
});

const denials: { name: string; body?: unknown; status?: number; raw?: string; reject?: boolean;
  denialStatus?: number; workspaceId?: string; ownerOnly?: boolean; retryCandidates?: boolean; pickerChoices?: string[] }[] = [
  { name: "no memberships", body: success([]), denialStatus: 403 },
  { name: "another owner is not the target", body: success([membership()]), denialStatus: 403, pickerChoices: [workspaceA] },
  ...["admin", "manager", "lead_manager", "receptionist"].map(role => ({ name: `target ${role} is not owner`,
    body: success([target({ role })]), denialStatus: 403, ownerOnly: true })),
  { name: "duplicate target membership", body: success([target(), target()]), denialStatus: 403, pickerChoices: [workspaceB, workspaceB] },
  { name: "conflicting duplicate target role", body: success([target(), target({ role: "lead_manager" })]), denialStatus: 403,
    pickerChoices: [workspaceB, workspaceB] },
  { name: "case-insensitive duplicate target", workspaceId: "abcdefab-0000-4000-8000-000000000204",
    body: success([target({ workspaceId: "abcdefab-0000-4000-8000-000000000204" }),
      target({ workspaceId: "ABCDEFAB-0000-4000-8000-000000000204" })]), denialStatus: 403,
    pickerChoices: ["abcdefab-0000-4000-8000-000000000204", "ABCDEFAB-0000-4000-8000-000000000204"] },
  { name: "success false", body: { success: false, data: { memberships: [target()] } } },
  { name: "missing data", body: { success: true } },
  { name: "membership list is not an array", body: { success: true, data: { memberships: { target: target() } } } },
  { name: "malformed purpose", body: success([target({ purpose: "untrusted-purpose" })]) },
  { name: "malformed role", body: success([target({ role: "OWNER" })]) },
  { name: "malformed member", body: { success: true, data: { memberships: [null, target()] } } },
  { name: "invalid JSON", raw: "{not-json", retryCandidates: true },
  { name: "empty response body", raw: "" },
  ...[401, 403, 422, 429, 503].map(status => ({ name: `HTTP ${status}`, status, body: { success: false },
    denialStatus: status === 401 || status === 403 ? status : undefined, retryCandidates: status === 429 || status >= 500 })),
  { name: "network rejection", reject: true, retryCandidates: true },
];
for (const denial of denials) test(`handoff refuses ${denial.name} without restoring a stored selector or old clinic`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture, [membership(), target()]);
    await pick(fixture, workspaceA, [membership(), target()]);
    fixture.locations.length = 0;
    fixture.storage.setItem(selectorKey, workspaceB);
    const outcome = observe(fixture.snapshot().enterWorkspace(denial.workspaceId ?? workspaceB, entryOptions()));
    await fixture.renderer.flush();
    assertUnselected(fixture);
    const request = fixture.request();
    if (denial.reject) request.reject(new Error("Isolated offline response"));
    else if (denial.raw !== undefined) request.resolve(new Response(denial.raw, { status: 200 }));
    else request.reply(denial.body, denial.status ?? 200);
    const result = await settleObserved(fixture, outcome, denial.denialStatus);
    if (denial.denialStatus === undefined) assert.equal(result, false);
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().isLoading, false);
    assert.deepEqual(fixture.locations, []);
  });
});

for (const reason of ["aborted", "stale", "guard throws", "wrong actor", "empty actor", "invalid workspace"] as const)
test(`handoff refuses ${reason} before reading a token or dispatching`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture);
    const controller = new AbortController();
    if (reason === "aborted") controller.abort();
    const options = entryOptions({ signal: controller.signal,
      expectedUserId: reason === "wrong actor" ? actorB : reason === "empty actor" ? "" : actorA,
      isCurrent: () => { if (reason === "guard throws") throw new Error("retired caller"); return reason !== "stale"; } });
    const before = effects(fixture), tokens = fixture.tokenCalls.length;
    const pending = fixture.snapshot().enterWorkspace(reason === "invalid workspace" ? "not-a-workspace" : workspaceB, options);
    assert.equal(await settle(fixture, pending), false);
    assert.deepEqual(effects(fixture), before);
    assert.equal(fixture.tokenCalls.length, tokens);
    assert.equal(fixture.requests.length, 1);
  });
});

const legacyStorage: Record<string, Record<string, string>> = {
  demo: { negis_demo_user: JSON.stringify({ id: actorA, name: "Local demo" }),
    negis_demo_workspace: JSON.stringify({ id: workspaceA, name: "Local demo" }),
    negis_demo_session: JSON.stringify({ mode: "demo", authenticated: true, createdAt: "2026-01-01T00:00:00Z" }) },
  staff: { negis_staff_user: JSON.stringify({ id: "local-stored-owner", authUserId: actorA,
    email: "local@example.test", role: "owner", workspaceId: workspaceA }),
    negis_staff_session: JSON.stringify({ mode: "staff", authenticated: true, email: "local@example.test",
      workspaceId: workspaceA, supabaseUserId: actorA, createdAt: "2026-01-01T00:00:00Z" }) },
  impersonation: { negis_impersonation: JSON.stringify({ active: true, clinic_id: workspaceA,
    clinic_name: "Local impersonation", owner_email: "local@example.test", issued_by: "local-admin" }) },
};
for (const [mode, storage] of Object.entries(legacyStorage).filter(([mode]) => mode !== "impersonation")) {
  for (const restored of [true, false]) test(`handoff refuses ${restored ? "restored" : "newly stored"} ${mode} even with owner hints`, async () => {
    await withFixture(async fixture => {
      if (!restored) {
        await confirm(fixture);
        for (const [key, value] of Object.entries(storage)) fixture.storage.setItem(key, value);
      }
      const before = effects(fixture), requests = fixture.requests.length, tokens = fixture.tokenCalls.length;
      assert.equal(await settle(fixture, fixture.snapshot().enterWorkspace(workspaceB, entryOptions())), false);
      assert.deepEqual(effects(fixture), before);
      assert.equal(fixture.requests.length, requests);
      assert.equal(fixture.tokenCalls.length, tokens);
    }, restored ? { storage } : {});
  });
}

for (const restored of [true, false]) for (const role of ["owner", "lead_manager"])
test(`${restored ? "restored" : "new"} unbound impersonation hint cannot grant or deny a fresh ${role} handoff`, async () => {
  await withFixture(async fixture => {
    if (restored) {
      assert.equal(fixture.snapshot().userRole, null, "stored owner metadata grants nothing before fresh membership");
      assert.equal(fixture.snapshot().isImpersonation, false);
    }
    await confirm(fixture);
    if (!restored) {
      for (const [key, value] of Object.entries(legacyStorage.impersonation)) fixture.storage.setItem(key, value);
    }
    assert.equal(fixture.snapshot().isImpersonation, false, "unbound cache is not an active delegated session");
    const before = fixture.requests.length;
    const outcome = observe(fixture.snapshot().enterWorkspace(workspaceB, entryOptions()));
    await fixture.renderer.flush();
    assert.equal(fixture.requests.length, before + 1, "only fresh server authority decides the target role");
    assert.equal(outcome.settled, false);
    assertUnselected(fixture);
    await fixture.respond(fixture.request(), success([target({ role })]));
    const accepted = await settleObserved(fixture, outcome, role === "owner" ? undefined : 403);
    if (role === "owner") {
      assert.equal(accepted, true);
      assert.equal(fixture.snapshot().clinicId, workspaceB);
      assert.equal(fixture.snapshot().userRole, "owner");
      assert.equal(fixture.snapshot().isImpersonation, false);
      assert.deepEqual(fixture.locations, ["/dashboard"]);
    } else {
      assertUnselected(fixture);
      assert.deepEqual(fixture.locations, []);
    }
  }, restored ? { storage: legacyStorage.impersonation } : {});
});

test("freshly confirmed actor-bound impersonation still refuses another workspace handoff", async () => {
  const hint = JSON.parse(legacyStorage.impersonation.negis_impersonation);
  await withFixture(async fixture => {
    assert.equal(fixture.snapshot().isImpersonation, false);
    await confirm(fixture);
    assert.equal(fixture.snapshot().isImpersonation, true);
    const before = effects(fixture), requests = fixture.requests.length, tokens = fixture.tokenCalls.length;
    assert.equal(await settle(fixture, fixture.snapshot().enterWorkspace(workspaceB, entryOptions())), false);
    assert.deepEqual(effects(fixture), before);
    assert.equal(fixture.requests.length, requests);
    assert.equal(fixture.tokenCalls.length, tokens);
  }, { storage: { negis_impersonation: JSON.stringify({ ...hint, auth_user_id: actorA }) } });
});

test("a signed-out provider cannot enter a workspace using SDK metadata or a selector", async () => {
  await withFixture(async fixture => {
    const before = effects(fixture);
    assert.equal(await settle(fixture, fixture.snapshot().enterWorkspace(workspaceB, entryOptions())), false);
    assert.deepEqual(effects(fixture), before);
    assert.equal(fixture.requests.length, 0);
    assert.deepEqual(fixture.tokenCalls, []);
  }, { initialActor: null, storage: { [selectorKey]: workspaceB } });
});

for (const outcome of ["success", "denied", "network"] as const)
test(`later handoff wins and an older ${outcome} cannot alter the new target`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture);
    const first = fixture.snapshot().enterWorkspace(workspaceB, entryOptions());
    await fixture.renderer.flush();
    const old = fixture.request();
    const second = fixture.snapshot().enterWorkspace(workspaceC, entryOptions());
    await fixture.renderer.flush();
    assert.equal(old.init.dispatchGuard!(), false);
    await fixture.respond(fixture.request(), success([target({ workspaceId: workspaceC, workspaceName: "Winning company" })]));
    assert.equal(await settle(fixture, second), true);
    const before = effects(fixture);
    if (outcome === "network") old.reject(new Error("obsolete offline result"));
    else old.reply(outcome === "success" ? success([target()]) : { success: false }, outcome === "denied" ? 403 : 200);
    assert.equal(await settle(fixture, first), false);
    assert.deepEqual(effects(fixture), before);
    assert.equal(fixture.snapshot().clinicId, workspaceC);
    assert.deepEqual(fixture.locations, ["/dashboard"]);
  });
});

test("an older completion cannot drop the loading fence while the newer handoff is pending", async () => {
  await withFixture(async fixture => {
    await confirm(fixture);
    const first = fixture.snapshot().enterWorkspace(workspaceB, entryOptions());
    await fixture.renderer.flush();
    const old = fixture.request();
    const second = fixture.snapshot().enterWorkspace(workspaceC, entryOptions());
    await fixture.renderer.flush();
    const current = fixture.request(), before = effects(fixture);
    old.reply(success([target()]));
    assert.equal(await settle(fixture, first), false);
    assert.deepEqual(effects(fixture), before);
    assert.equal(fixture.snapshot().isLoading, true);
    current.reply(success([target({ workspaceId: workspaceC })]));
    assert.equal(await settle(fixture, second), true);
  });
});

for (const reason of ["abort", "caller stale", "actor switch", "actor ABA", "regular resolution", "unmount", "signout"] as const)
test(`pending token lookup cannot dispatch after ${reason}`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture);
    const gate = deferred<string>(), controller = new AbortController();
    let current = true;
    fixture.token(() => gate.promise);
    const pending = fixture.snapshot().enterWorkspace(workspaceB, entryOptions({ signal: controller.signal, isCurrent: () => current }));
    await fixture.renderer.flush();
    fixture.token();
    let signingOut: Promise<void> | undefined;
    if (reason === "abort") controller.abort();
    if (reason === "caller stale") current = false;
    if (reason === "actor switch" || reason === "actor ABA") fixture.emit(actorB);
    if (reason === "actor ABA") fixture.emit(actorA);
    if (reason === "regular resolution") fixture.emit(actorA, "USER_UPDATED");
    if (reason === "unmount") fixture.renderer.dispose();
    if (reason === "signout") signingOut = fixture.snapshot().signOut();
    await fixture.renderer.flush();
    const attempts = fixture.attempts.length, writes = fixture.renderer.writes.length;
    gate.resolve(`local-fixture:${actorA}:initial`);
    assert.equal(await settle(fixture, pending), false);
    assert.equal(fixture.attempts.length, attempts, "retired token must not even reach crmFetch");
    assert.equal(fixture.locations.length, 0);
    if (reason === "unmount") assert.equal(fixture.renderer.writes.length, writes);
    fixture.releaseSignOut();
    await signingOut;
  }, { deferSignOut: true });
});

for (const reason of ["actor switch", "actor ABA", "unmount", "signout"] as const)
test(`captured entry callback refuses ${reason} synchronously before a rerender`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture);
    const savedEntry = fixture.snapshot().enterWorkspace;
    let signingOut: Promise<void> | undefined;
    if (reason === "actor switch" || reason === "actor ABA") fixture.emit(actorB);
    if (reason === "actor ABA") fixture.emit(actorA);
    if (reason === "unmount") fixture.renderer.dispose();
    if (reason === "signout") signingOut = fixture.snapshot().signOut();
    const before = effects(fixture), tokens = fixture.tokenCalls.length;
    const pending = savedEntry(workspaceB, entryOptions());
    assert.equal(fixture.tokenCalls.length, tokens, "no token lookup may start from the retired callback");
    assert.deepEqual(effects(fixture), before, "retired callback cannot clear a newer identity's state");
    assert.equal(await settle(fixture, pending), false);
    assert.equal(fixture.locations.length, 0);
    fixture.releaseSignOut();
    await signingOut;
  }, { deferSignOut: true });
});

for (const stage of ["transport", "body", "token recheck"] as const) for (const reason of ["abort", "caller stale"] as const)
test(`${reason} during ${stage} prevents target publication and navigation`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture);
    const controller = new AbortController();
    let current = true;
    const pending = fixture.snapshot().enterWorkspace(workspaceB, entryOptions({ signal: controller.signal, isCurrent: () => current }));
    await fixture.renderer.flush();
    const request = fixture.request(), body = deferred<string>(), token = deferred<string>();
    if (stage === "body") request.resolve({ ok: true, status: 200, text: () => body.promise } as Response);
    if (stage === "token recheck") {
      fixture.token(() => token.promise);
      request.reply(success([target()]));
    }
    await fixture.renderer.flush();
    if (reason === "abort") controller.abort();
    else current = false;
    assert.equal(request.init.dispatchGuard!(), false);
    if (stage === "transport") request.reply(success([target()]));
    if (stage === "body") body.resolve(JSON.stringify(success([target()])));
    if (stage === "token recheck") token.resolve(`local-fixture:${actorA}:initial`);
    assert.equal(await settle(fixture, pending), false);
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().isLoading, false);
    assert.deepEqual(fixture.locations, []);
  });
});

test("the supplied dispatch guard prevents a delayed transport from sending after actor ABA", async () => {
  await withFixture(async fixture => {
    await confirm(fixture);
    const dispatch = fixture.holdDispatch();
    const pending = fixture.snapshot().enterWorkspace(workspaceB, entryOptions());
    await fixture.renderer.flush();
    const old = fixture.attempts.at(-1)!;
    assert.equal(old.init.dispatchGuard!(), true);
    fixture.emit(actorB); fixture.emit(actorA);
    assert.equal(old.init.dispatchGuard!(), false);
    dispatch.resolve();
    assert.equal(await settle(fixture, pending), false);
    assert.ok(!fixture.requests.includes(old), "retired handoff never crosses the simulated final send boundary");
    assert.deepEqual(fixture.locations, []);
  });
});

test("a newer regular auth resolution plus valid picker choice invalidates the pending handoff", async () => {
  await withFixture(async fixture => {
    await confirm(fixture);
    const pending = fixture.snapshot().enterWorkspace(workspaceB, entryOptions());
    await fixture.renderer.flush();
    const old = fixture.request();
    fixture.emit(actorA, "USER_UPDATED");
    await fixture.renderer.flush();
    await fixture.respond(fixture.request(), success([membership(), target({ role: "lead_manager" })]));
    await pick(fixture, workspaceA, [membership(), target({ role: "lead_manager" })]);
    assert.equal(fixture.snapshot().clinicId, workspaceA);
    const before = effects(fixture);
    old.reply(success([target()]));
    assert.equal(await settle(fixture, pending), false);
    assert.deepEqual(effects(fixture), before);
    assert.deepEqual(fixture.locations, ["/dashboard"]);
  });
});

for (const initial of [true, false])
test(`handoff invalidates an older ${initial ? "initial bootstrap" : "same-actor recheck"} with no fallback after network failure`, async () => {
  await withFixture(async fixture => {
    if (!initial) {
      await confirm(fixture);
      fixture.emit(actorA, "USER_UPDATED");
      await fixture.renderer.flush();
    }
    const old = fixture.request();
    const pending = fixture.snapshot().enterWorkspace(workspaceB, entryOptions());
    await fixture.renderer.flush();
    const request = fixture.request(), before = effects(fixture);
    old.reply(success([membership()]));
    await fixture.renderer.flush();
    assert.deepEqual(effects(fixture), before, "superseded bootstrap cannot restore old membership or loading state");
    request.reply({ success: false }, 503);
    assert.equal(await settle(fixture, pending), false);
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().isLoading, false);
    assert.deepEqual(fixture.locations, []);
  });
});

for (const reason of ["actor switch", "actor ABA", "regular resolution", "signout"] as const)
for (const status of [200, 401, 403])
test(`late handoff HTTP ${status} cannot publish or throw a current denial after ${reason}`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture);
    const outcome = observe(fixture.snapshot().enterWorkspace(workspaceB, entryOptions()));
    await fixture.renderer.flush();
    const old = fixture.request();
    let signingOut: Promise<void> | undefined;
    if (reason === "actor switch" || reason === "actor ABA") fixture.emit(actorB);
    if (reason === "actor ABA") fixture.emit(actorA);
    if (reason === "regular resolution") fixture.emit(actorA, "USER_UPDATED");
    if (reason === "signout") signingOut = fixture.snapshot().signOut();
    await fixture.renderer.flush();
    if (reason !== "signout") {
      await fixture.respond(fixture.request(), success([target({ workspaceId: workspaceC })]));
      if (reason === "regular resolution") assertNeutral(fixture);
      else assert.equal(fixture.snapshot().clinicId, workspaceC);
    }
    const before = effects(fixture);
    old.reply(status === 200 ? success([target()]) : { success: false }, status);
    assert.equal(await settleObserved(fixture, outcome), false);
    assert.deepEqual(effects(fixture), before);
    fixture.releaseSignOut();
    await signingOut;
  }, { deferSignOut: true });
});

test("invalid stale picker and clear-selection callbacks do not retire an active handoff", async () => {
  await withFixture(async fixture => {
    await confirm(fixture, [membership(), target({ role: "lead_manager" })]);
    const oldPick = fixture.snapshot().selectWorkspace, oldClear = fixture.snapshot().clearWorkspaceSelection;
    oldPick(workspaceA);
    await fixture.renderer.flush();
    await fixture.respond(fixture.request(), success([membership(), target({ role: "lead_manager" })]));
    fixture.locations.length = 0;
    const pending = fixture.snapshot().enterWorkspace(workspaceB, entryOptions());
    await fixture.renderer.flush();
    oldPick(workspaceA); oldClear();
    await fixture.renderer.flush();
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().isLoading, true);
    assert.equal(fixture.request().init.dispatchGuard!(), true);
    fixture.request().reply(success([target()]));
    assert.equal(await settle(fixture, pending), true);
    assert.equal(fixture.snapshot().clinicId, workspaceB);
    assert.deepEqual(fixture.locations, ["/dashboard"]);
  });
});

for (const choice of [
  { role: "lead_manager", purpose: "clinic_services", route: "/leads", admin: false },
  { role: "lead_manager", purpose: "mortgage_leads", route: "/dashboard", admin: false },
  { role: "manager", purpose: "clinic_services", route: "/dashboard", admin: true },
  { role: "owner", purpose: "clinic_services", route: "/dashboard", admin: true },
]) test(`ordinary picker verifies fresh ${choice.role}/${choice.purpose} and routes to ${choice.route}`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture, [membership(), target({ role: "admin", purpose: "clinic_services", vertical: "beauty" })]);
    fixture.seedCaches();
    const tokens = fixture.tokenCalls.length, request = await beginPick(fixture, workspaceB);
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().isLoading, true);
    assert.equal(fixture.caches.crm.size, 0);
    assert.equal(fixture.caches.lists.size, 0);
    assert.equal(fixture.readScopes.at(-1)?.args[1], null);
    assert.equal(request.init.expectedUserId, actorA);
    assert.equal(request.init.accessToken, `local-fixture:${actorA}:initial`);
    assert.equal(request.init.cache, "no-store");
    assert.equal(request.init.signal?.aborted, false);
    assert.equal(request.init.dispatchGuard?.(), true);
    assert.deepEqual(fixture.locations, []);
    await fixture.respond(request, success([membership(), target({ role: choice.role, purpose: choice.purpose,
      workspaceName: "Fresh verified picker target" })]));
    assert.equal(fixture.snapshot().clinicId, workspaceB);
    assert.equal(fixture.snapshot().userRole, choice.role);
    assert.equal(fixture.snapshot().workspacePurpose, choice.purpose);
    assert.equal(fixture.snapshot().vertical, "dental");
    assert.equal(fixture.snapshot().rolePermissions.admin, choice.admin);
    assert.equal(fixture.snapshot().availableWorkspaces.find(value => value.id === workspaceB)?.name,
      "Fresh verified picker target");
    assert.equal(fixture.storage.getItem(selectorKey), workspaceB);
    assert.equal(fixture.readScopes.at(-1)?.args[1], workspaceB);
    assert.equal(fixture.snapshot().isLoading, false);
    assert.deepEqual(fixture.locations, [choice.route]);
    assert.ok(fixture.tokenCalls.length >= tokens + 2, "picker token is verified again before publication");
    assert.equal(fixture.windowListeners(), 0);
    assert.equal(fixture.historyRestored(), true);
  }, { storage: { [selectorKey]: workspaceA } });
});

test("generic picker quarantines both caches and the memory read scope before looking up a fresh token", async () => {
  await withFixture(async fixture => {
    await confirm(fixture, [membership(), target()]);
    fixture.seedCaches();
    const token = deferred<string>(), requests = fixture.requests.length;
    fixture.token(() => {
      assert.equal(fixture.storage.getItem(selectorKey), null);
      assert.equal(fixture.caches.crm.size, 0);
      assert.equal(fixture.caches.lists.size, 0);
      assert.equal(fixture.readScopes.at(-1)?.kind, "bind");
      assert.equal(fixture.readScopes.at(-1)?.args[1], null);
      return token.promise;
    });
    assert.equal(fixture.snapshot().selectWorkspace(workspaceB), undefined);
    await fixture.renderer.flush();
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().isLoading, true);
    assert.equal(fixture.requests.length, requests);
    fixture.token();
    token.resolve(`local-fixture:${actorA}:initial`);
    await fixture.renderer.flush();
    assert.equal(fixture.requests.length, requests + 1);
    await fixture.respond(fixture.request(), success([target({ role: "lead_manager", purpose: "clinic_services" })]));
    assert.equal(fixture.snapshot().clinicId, workspaceB);
    assert.deepEqual(fixture.locations, ["/leads"]);
  }, { storage: { [selectorKey]: workspaceA } });
});

for (const workspaceId of [workspaceC, "not-a-workspace", ""])
test(`generic picker refuses an unlisted target ${workspaceId || "(empty)"} before token lookup or dispatch`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture, [membership(), target()]);
    fixture.seedCaches();
    const before = effects(fixture), tokens = fixture.tokenCalls.length, attempts = fixture.attempts.length;
    fixture.snapshot().selectWorkspace(workspaceId);
    await fixture.renderer.flush();
    assert.equal(fixture.tokenCalls.length, tokens);
    assert.equal(fixture.attempts.length, attempts);
    assert.deepEqual({ ...effects(fixture), toasts: [] }, { ...before, toasts: [] });
  }, { storage: { [selectorKey]: workspaceA } });
});

test("generic picker checks the current whitelist instead of a captured callback's old memberships", async () => {
  await withFixture(async fixture => {
    await confirm(fixture, [membership(), target()]);
    const oldPick = fixture.snapshot().selectWorkspace;
    fixture.emit(actorA, "USER_UPDATED");
    await fixture.renderer.flush();
    await fixture.respond(fixture.request(), success([membership()]));
    const before = effects(fixture), tokens = fixture.tokenCalls.length, attempts = fixture.attempts.length;
    oldPick(workspaceB);
    await fixture.renderer.flush();
    assert.equal(fixture.tokenCalls.length, tokens);
    assert.equal(fixture.attempts.length, attempts);
    assert.deepEqual({ ...effects(fixture), toasts: [] }, { ...before, toasts: [] });
  });
});

for (const denial of denials.filter(value => !value.ownerOnly))
test(`generic picker refuses fresh ${denial.name} with no cached membership fallback`, async () => {
  await withFixture(async fixture => {
    const workspaceId = denial.workspaceId ?? workspaceB;
    await confirm(fixture, [membership(), target({ workspaceId })]);
    fixture.seedCaches();
    const request = await beginPick(fixture, workspaceId);
    assertUnselected(fixture);
    if (denial.reject) request.reject(new Error("Isolated picker offline response"));
    else if (denial.raw !== undefined) request.resolve(new Response(denial.raw, { status: 200 }));
    else request.reply(denial.body, denial.status ?? 200);
    await fixture.renderer.flush();
    assertNeutral(fixture);
    assert.deepEqual(clone(fixture.snapshot().availableWorkspaces.map(choice => choice.id)),
      denial.retryCandidates ? [workspaceA, workspaceId] : denial.pickerChoices ?? []);
    assert.equal(fixture.snapshot().workspaceSelectionFailed, true);
    assert.equal(fixture.snapshot().isLoading, false);
    assert.equal(fixture.caches.crm.size, 0);
    assert.equal(fixture.caches.lists.size, 0);
    assert.equal(fixture.readScopes.at(-1)?.args[1], null);
    assert.deepEqual(fixture.locations, []);
    assert.equal(fixture.windowListeners(), 0);
    assert.equal(fixture.historyRestored(), true);
  }, { storage: { [selectorKey]: workspaceA } });
});

for (const reply of ["missing", "throw"] as const)
test(`generic picker fails closed on a ${reply} fresh token before dispatch`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture, [membership(), target()]);
    fixture.seedCaches();
    fixture.token(async () => {
      if (reply === "throw") throw new Error("isolated picker token lookup failure");
      return "";
    });
    fixture.snapshot().selectWorkspace(workspaceB);
    await fixture.renderer.flush();
    assertUnselected(fixture);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.snapshot().isLoading, false);
    assert.equal(fixture.caches.crm.size, 0);
    assert.equal(fixture.caches.lists.size, 0);
    assert.deepEqual(fixture.locations, []);
    assert.equal(fixture.windowListeners(), 0);
    assert.equal(fixture.historyRestored(), true);
  }, { storage: { [selectorKey]: workspaceA } });
});

for (const status of [0, 429, 503])
test(`generic picker transient ${status} retains retry candidates only and the retry verifies a fresh role`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture, [membership(), target()]);
    fixture.seedCaches();
    const request = await beginPick(fixture, workspaceB);
    if (status === 0) request.reject(new Error("isolated retryable picker failure"));
    else request.reply({ success: false }, status);
    await fixture.renderer.flush();
    assertNeutral(fixture);
    assert.equal(fixture.snapshot().workspaceSelectionFailed, true);
    assert.deepEqual(clone(fixture.snapshot().availableWorkspaces.map(choice => choice.id)), [workspaceA, workspaceB]);
    assert.equal(fixture.caches.crm.size, 0);
    assert.equal(fixture.caches.lists.size, 0);
    assert.equal(fixture.readScopes.at(-1)?.args[1], null);
    assert.deepEqual(fixture.locations, []);
    const retry = await beginPick(fixture, workspaceB);
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().workspaceSelectionFailed, false);
    await fixture.respond(retry, success([target({ role: "lead_manager", purpose: "clinic_services" })]));
    assert.equal(fixture.requests.length, 3);
    assert.equal(fixture.snapshot().clinicId, workspaceB);
    assert.equal(fixture.snapshot().userRole, "lead_manager");
    assert.equal(fixture.snapshot().rolePermissions.admin, false);
    assert.equal(fixture.snapshot().workspaceSelectionFailed, false);
    assert.deepEqual(fixture.locations, ["/leads"]);
  }, { storage: { [selectorKey]: workspaceA } });
});

for (const status of [0, 429, 503])
for (const reason of ["silent SDK replacement", "token rotation"] as const)
test(`generic picker transient ${status} cannot restore retry candidates after ${reason}`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture, [membership(), target()]);
    const request = await beginPick(fixture, workspaceB);
    if (reason === "silent SDK replacement") fixture.setSdkActor(actorB);
    else fixture.rotateToken();
    if (status === 0) request.reject(new Error("isolated obsolete retryable failure"));
    else request.reply({ success: false }, status);
    await fixture.renderer.flush();
    assertUnselected(fixture);
    assert.equal(fixture.readScopes.at(-1)?.args[1], null);
    assert.deepEqual(fixture.locations, []);
    assert.equal(fixture.windowListeners(), 0);
    if (reason === "silent SDK replacement") {
      assert.equal(fixture.snapshot().workspaceSelectionFailed, false);
      assert.deepEqual(fixture.toasts, []);
    }
  });
});

test("a fresh single different membership stays unselected until another explicit fresh choice", async () => {
  await withFixture(async fixture => {
    await confirm(fixture, [membership(), target()]);
    await fixture.respond(await beginPick(fixture, workspaceB), success([membership()]));
    assertNeutral(fixture);
    assert.equal(fixture.snapshot().workspaceSelectionFailed, true);
    assert.deepEqual(clone(fixture.snapshot().availableWorkspaces.map(choice => choice.id)), [workspaceA]);
    assert.deepEqual(fixture.locations, []);
    await pick(fixture, workspaceA, [membership({ role: "lead_manager" })]);
    assert.equal(fixture.snapshot().clinicId, workspaceA);
    assert.equal(fixture.snapshot().userRole, "lead_manager");
    assert.equal(fixture.snapshot().workspaceSelectionFailed, false);
    assert.deepEqual(fixture.locations, ["/leads"]);
  });
});

for (const reason of ["silent SDK replacement", "actor ABA", "navigation", "unmount", "signout", "token throws"] as const)
test(`generic picker error UI's extra token recheck cannot publish after ${reason}`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture, [membership(), target()]);
    const request = await beginPick(fixture, workspaceB), token = deferred<string>();
    let calls = 0;
    fixture.token(async expected => {
      assert.equal(expected, actorA);
      return ++calls === 1 ? `local-fixture:${actorA}:initial` : token.promise;
    });
    request.reply({ success: false }, 503);
    await fixture.renderer.flush();
    assert.equal(calls, 2, "the error UI waits for an additional expected-actor token check after the response check");
    assertNeutral(fixture);
    assert.equal(fixture.snapshot().workspaceSelectionFailed, false);
    assert.deepEqual(fixture.toasts, []);
    fixture.token();
    let signingOut: Promise<void> | undefined;
    if (reason === "silent SDK replacement") fixture.setSdkActor(actorB);
    if (reason === "actor ABA") { fixture.emit(actorB); fixture.emit(actorA); }
    if (reason === "navigation") fixture.navigate("pushState", "/profile#newer-route");
    if (reason === "unmount") fixture.renderer.dispose();
    if (reason === "signout") signingOut = fixture.snapshot().signOut();
    await fixture.renderer.flush();
    const before = effects(fixture);
    if (reason === "token throws") token.reject(new Error("isolated error-UI token check failure"));
    else token.resolve(reason === "silent SDK replacement" ? "" : `local-fixture:${actorA}:initial`);
    await fixture.renderer.flush();
    assert.deepEqual(effects(fixture), before, "the obsolete failure UI cannot set retry state, toast or navigate");
    assert.equal(fixture.windowListeners(), 0);
    if (reason === "navigation") assert.equal(fixture.route(), "/profile#newer-route");
    fixture.releaseSignOut();
    await signingOut;
  }, { deferSignOut: true });
});

for (const reason of ["silent SDK replacement", "token rotation"] as const)
test(`generic picker cannot publish a fresh response after ${reason}`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture, [membership(), target()]);
    const request = await beginPick(fixture, workspaceB);
    if (reason === "silent SDK replacement") fixture.setSdkActor(actorB);
    else fixture.rotateToken();
    await fixture.respond(request, success([target()]));
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().isLoading, false);
    assert.deepEqual(fixture.locations, []);
    assert.equal(fixture.windowListeners(), 0);
  });
});

for (const reason of ["actor switch", "actor ABA", "unmount", "signout"] as const)
test(`captured generic picker refuses ${reason} before a rerender or fresh token lookup`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture, [membership(), target()]);
    const oldPick = fixture.snapshot().selectWorkspace;
    let signingOut: Promise<void> | undefined;
    if (reason === "actor switch" || reason === "actor ABA") fixture.emit(actorB);
    if (reason === "actor ABA") fixture.emit(actorA);
    if (reason === "unmount") fixture.renderer.dispose();
    if (reason === "signout") signingOut = fixture.snapshot().signOut();
    const before = effects(fixture), tokens = fixture.tokenCalls.length, attempts = fixture.attempts.length;
    oldPick(workspaceB);
    assert.deepEqual(effects(fixture), before, "a retired caller cannot change state, caches, selector, scope or toasts");
    assert.equal(fixture.tokenCalls.length, tokens);
    assert.equal(fixture.attempts.length, attempts);
    fixture.releaseSignOut();
    await signingOut;
  }, { deferSignOut: true });
});

for (const reason of ["actor switch", "actor ABA", "regular resolution", "unmount", "signout"] as const)
test(`generic picker held token cannot dispatch after ${reason}`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture, [membership(), target()]);
    const token = deferred<string>();
    fixture.token(() => token.promise);
    fixture.snapshot().selectWorkspace(workspaceB);
    await fixture.renderer.flush();
    fixture.token();
    let signingOut: Promise<void> | undefined;
    if (reason === "actor switch" || reason === "actor ABA") fixture.emit(actorB);
    if (reason === "actor ABA") fixture.emit(actorA);
    if (reason === "regular resolution") fixture.emit(actorA, "USER_UPDATED");
    if (reason === "unmount") fixture.renderer.dispose();
    if (reason === "signout") signingOut = fixture.snapshot().signOut();
    await fixture.renderer.flush();
    const before = effects(fixture), attempts = fixture.attempts.length;
    token.resolve(`local-fixture:${actorA}:initial`);
    await fixture.renderer.flush();
    assert.equal(fixture.attempts.length, attempts, "retired picker token cannot reach the transport");
    assert.deepEqual(effects(fixture), before);
    fixture.releaseSignOut();
    await signingOut;
  }, { deferSignOut: true });
});

test("generic picker dispatch guard refuses a delayed send after actor ABA", async () => {
  await withFixture(async fixture => {
    await confirm(fixture, [membership(), target()]);
    const dispatch = fixture.holdDispatch();
    fixture.snapshot().selectWorkspace(workspaceB);
    await fixture.renderer.flush();
    const old = fixture.attempts.at(-1)!;
    assert.equal(old.init.dispatchGuard?.(), true);
    fixture.emit(actorB); fixture.emit(actorA);
    assert.equal(old.init.dispatchGuard?.(), false);
    dispatch.resolve();
    await fixture.renderer.flush();
    assert.ok(!fixture.requests.includes(old), "a retired picker never crosses the last-moment send boundary");
    assert.deepEqual(fixture.locations, []);
  });
});

for (const reason of ["actor switch", "actor ABA", "new explicit choice", "signout", "unmount"] as const)
for (const outcome of ["success", "denied", "network"] as const)
test(`late generic picker ${outcome} cannot publish effects after ${reason}`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture, [membership(), target()]);
    const old = await beginPick(fixture, workspaceB);
    let signingOut: Promise<void> | undefined;
    if (reason === "actor switch" || reason === "actor ABA") fixture.emit(actorB);
    if (reason === "actor ABA") fixture.emit(actorA);
    if (reason === "new explicit choice") fixture.emit(actorA, "USER_UPDATED");
    if (reason === "signout") signingOut = fixture.snapshot().signOut();
    if (reason === "unmount") fixture.renderer.dispose();
    await fixture.renderer.flush();
    if (reason === "actor switch" || reason === "actor ABA" || reason === "new explicit choice") {
      const memberships = [target({ workspaceId: workspaceC, purpose: "clinic_services", role: "lead_manager" })];
      await fixture.respond(fixture.request(), success(memberships));
      if (reason === "new explicit choice") await pick(fixture, workspaceC, memberships);
      assert.equal(fixture.snapshot().clinicId, workspaceC);
    }
    const before = effects(fixture), tokens = fixture.tokenCalls.length;
    if (outcome === "network") old.reject(new Error("obsolete isolated picker response"));
    else old.reply(outcome === "success" ? success([target()]) : { success: false }, outcome === "denied" ? 403 : 200);
    await fixture.renderer.flush();
    assert.deepEqual(effects(fixture), before, "obsolete void picker completion has no state, scope, cache, toast or routing effects");
    assert.equal(fixture.tokenCalls.length, tokens, "retired picker does not recheck a newer caller's token");
    fixture.releaseSignOut();
    await signingOut;
  }, { deferSignOut: true });
});

for (const stage of ["token", "transport", "body", "token recheck"] as const)
for (const method of ["popstate", "hashchange", "pushState", "replaceState"] as const)
test(`generic picker ${stage} is cancelled by ${method} without stealing the newer route`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture, [membership(), target()]);
    const token = deferred<string>(), body = deferred<string>();
    const requests = fixture.requests.length;
    if (stage === "token") fixture.token(() => token.promise);
    fixture.snapshot().selectWorkspace(workspaceB);
    await fixture.renderer.flush();
    const request = stage === "token" ? undefined : fixture.request();
    if (stage === "body") request!.resolve({ ok: true, status: 200, text: () => body.promise } as Response);
    if (stage === "token recheck") {
      fixture.token(() => token.promise);
      request!.reply(success([target()]));
    }
    await fixture.renderer.flush();
    const route = method === "hashchange" ? "/partner-company#new-route" : "/profile?tab=security#new-route";
    fixture.navigate(method, route);
    await fixture.renderer.flush();
    assertUnselected(fixture);
    if (request) assert.equal(request.init.dispatchGuard?.(), false, "navigation retires the pending picker guard");
    fixture.token();
    if (stage === "token" || stage === "token recheck") token.resolve(`local-fixture:${actorA}:initial`);
    if (stage === "body") body.resolve(JSON.stringify(success([target()])));
    if (stage === "transport") request!.reply(success([target()]));
    await fixture.renderer.flush();
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().isLoading, false);
    assert.equal(fixture.route(), route);
    assert.deepEqual(fixture.locations, []);
    assert.equal(fixture.requests.length, requests + (stage === "token" ? 0 : 1));
    assert.equal(fixture.windowListeners(), 0, "completed cancellation removes its browser event listeners");
    assert.equal(fixture.historyRestored(), true);
  });
});

test("a genuine explicit picker choice after failure and a same-actor recheck can still select W", async () => {
  await withFixture(async fixture => {
    await confirm(fixture, [membership(), target()]);
    await fixture.respond(await beginPick(fixture, workspaceB), { success: false }, 503);
    assertNeutral(fixture);
    fixture.emit(actorA, "USER_UPDATED");
    await fixture.renderer.flush();
    await fixture.respond(fixture.request(), success([membership()]));
    assertNeutral(fixture);
    assert.deepEqual(fixture.locations, []);
    await pick(fixture, workspaceA);
    assert.equal(fixture.snapshot().clinicId, workspaceA);
    assert.equal(fixture.storage.getItem(selectorKey), workspaceA);
    assert.deepEqual(fixture.locations, ["/dashboard"]);
  }, { storage: { [selectorKey]: workspaceA } });
});

for (const outcome of ["success", "denied", "network"] as const)
test(`unmount fences every late ${outcome} handoff side effect, including attempted state writes`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture);
    const pending = fixture.snapshot().enterWorkspace(workspaceB, entryOptions());
    await fixture.renderer.flush();
    const request = fixture.request();
    fixture.renderer.dispose();
    assert.equal(fixture.subscriptions(), 0);
    const before = effects(fixture);
    if (outcome === "network") request.reject(new Error("late isolated transport error"));
    else request.reply(outcome === "success" ? success([target()]) : { success: false }, outcome === "denied" ? 403 : 200);
    assert.equal(await settle(fixture, pending), false);
    assert.deepEqual(effects(fixture), before);
  });
});

test("SDK actor replacement before its auth event cannot publish an old actor's handoff", async () => {
  await withFixture(async fixture => {
    await confirm(fixture);
    const pending = fixture.snapshot().enterWorkspace(workspaceB, entryOptions());
    await fixture.renderer.flush();
    fixture.setSdkActor(actorB);
    fixture.request().reply(success([target()]));
    assert.equal(await settle(fixture, pending), false);
    assertUnselected(fixture);
    assert.deepEqual(fixture.locations, []);
  });
});

test("token rotation after dispatch cannot publish a response bound to the previous token", async () => {
  await withFixture(async fixture => {
    await confirm(fixture);
    const pending = fixture.snapshot().enterWorkspace(workspaceB, entryOptions());
    await fixture.renderer.flush();
    fixture.rotateToken();
    fixture.request().reply(success([target()]));
    assert.equal(await settle(fixture, pending), false);
    assertUnselected(fixture);
    assert.deepEqual(fixture.locations, []);
  });
});

for (const reply of ["missing", "throw"] as const)
test(`a ${reply} fresh token fails closed without issuing a handoff request`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture);
    fixture.token(async () => {
      if (reply === "throw") throw new Error("isolated token failure");
      return "";
    });
    assert.equal(await settle(fixture, fixture.snapshot().enterWorkspace(workspaceB, entryOptions())), false);
    assertUnselected(fixture);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.snapshot().isLoading, false);
    assert.deepEqual(fixture.locations, []);
  });
});

test("the handoff actor remains immutable even if the caller mutates its options during token lookup", async () => {
  await withFixture(async fixture => {
    await confirm(fixture);
    const token = deferred<string>(), options = entryOptions();
    fixture.token(() => token.promise);
    const pending = fixture.snapshot().enterWorkspace(workspaceB, options);
    await fixture.renderer.flush();
    options.expectedUserId = actorB;
    token.resolve("local-immutable-actor-token");
    await fixture.renderer.flush();
    assert.equal(fixture.request().init.expectedUserId, actorA);
    fixture.request().reply(success([target()]));
    assert.equal(await settle(fixture, pending), true);
    assert.ok(fixture.tokenCalls.every(actor => actor === actorA));
    assert.equal(fixture.snapshot().user?.id, actorA);
    assert.equal(fixture.snapshot().clinicId, workspaceB);
  });
});

test("confirmation runs after quarantine and must settle before the fresh auth-context token/read", async () => {
  await withFixture(async fixture => {
    await confirm(fixture);
    fixture.seedCaches();
    const confirmation = deferred<void>(), tokens = fixture.tokenCalls.length;
    let calls = 0;
    const outcome = observe(fixture.snapshot().enterWorkspace(workspaceB, entryOptions({ confirm: () => {
      calls++;
      assert.equal(fixture.storage.getItem(selectorKey), null, "selector is cleared before confirmation starts");
      assert.equal(fixture.caches.crm.size, 0);
      assert.equal(fixture.caches.lists.size, 0);
      assert.equal(fixture.readScopes.at(-1)?.kind, "bind");
      assert.equal(fixture.readScopes.at(-1)?.args[1], null, "workspace read scope is quarantined before confirmation");
      return confirmation.promise;
    } })));
    await fixture.renderer.flush();
    assert.equal(calls, 1);
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().isLoading, true);
    assert.equal(outcome.settled, false);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.tokenCalls.length, tokens);
    confirmation.resolve();
    await fixture.renderer.flush();
    assert.equal(fixture.requests.length, 2);
    fixture.request().reply(success([target()]));
    assert.equal(await settleObserved(fixture, outcome), true);
    assert.equal(calls, 1);
    assert.equal(fixture.snapshot().clinicId, workspaceB);
    assert.deepEqual(fixture.locations, ["/dashboard"]);
  });
});

test("sign-out while confirmation is held retires the entry before any fresh token or auth-context read", async () => {
  await withFixture(async fixture => {
    await confirm(fixture);
    const confirmation = deferred<void>();
    const outcome = observe(fixture.snapshot().enterWorkspace(workspaceB, entryOptions({ confirm: () => confirmation.promise })));
    await fixture.renderer.flush();
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().isLoading, true);
    const signingOut = fixture.snapshot().signOut();
    await fixture.renderer.flush();
    assert.equal(fixture.snapshot().isSigningOut, true);
    const before = effects(fixture), tokens = fixture.tokenCalls.length, attempts = fixture.attempts.length;
    confirmation.resolve();
    assert.equal(await settleObserved(fixture, outcome), false);
    assert.deepEqual(effects(fixture), before, "retired confirmation cannot publish state, read scope or navigation");
    assert.equal(fixture.tokenCalls.length, tokens);
    assert.equal(fixture.attempts.length, attempts);
    assert.deepEqual(fixture.locations, []);
    fixture.releaseSignOut();
    await signingOut;
    await fixture.renderer.flush();
    assert.deepEqual(fixture.locations, ["/"], "only the provider's sign-out may navigate");
    assertUnselected(fixture);
  }, { deferSignOut: true });
});

for (const reason of ["abort", "caller stale", "unmount"] as const)
test(`held confirmation cannot start a read after ${reason}`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture);
    const confirmation = deferred<void>(), controller = new AbortController();
    let current = true;
    const outcome = observe(fixture.snapshot().enterWorkspace(workspaceB, entryOptions({ signal: controller.signal,
      isCurrent: () => current, confirm: () => confirmation.promise })));
    await fixture.renderer.flush();
    if (reason === "abort") controller.abort();
    if (reason === "caller stale") current = false;
    if (reason === "unmount") fixture.renderer.dispose();
    const before = effects(fixture), tokens = fixture.tokenCalls.length;
    confirmation.resolve();
    assert.equal(await settleObserved(fixture, outcome), false);
    assert.equal(fixture.tokenCalls.length, tokens);
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(fixture.locations, []);
    if (reason === "unmount") assert.deepEqual(effects(fixture), before);
    else {
      assertUnselected(fixture);
      assert.equal(fixture.snapshot().isLoading, false);
    }
  });
});

for (const late of ["success", "typed denial"] as const)
test(`an older held confirmation's ${late} cannot alter a newer successful handoff`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture);
    const confirmation = deferred<void>();
    const old = observe(fixture.snapshot().enterWorkspace(workspaceB, entryOptions({ confirm: () => confirmation.promise })));
    await fixture.renderer.flush();
    const current = observe(fixture.snapshot().enterWorkspace(workspaceC, entryOptions()));
    await fixture.renderer.flush();
    fixture.request().reply(success([target({ workspaceId: workspaceC })]));
    assert.equal(await settleObserved(fixture, current), true);
    const before = effects(fixture), tokens = fixture.tokenCalls.length, requests = fixture.requests.length;
    if (late === "success") confirmation.resolve();
    else confirmation.reject(new CrmApiError(403, "partner_company_access_denied", "isolated obsolete confirmation denial"));
    assert.equal(await settleObserved(fixture, old), false);
    assert.deepEqual(effects(fixture), before);
    assert.equal(fixture.tokenCalls.length, tokens);
    assert.equal(fixture.requests.length, requests);
    assert.equal(fixture.snapshot().clinicId, workspaceC);
    assert.deepEqual(fixture.locations, ["/dashboard"]);
  });
});

test("an older confirmation completion cannot clear the loading fence of a newer held confirmation", async () => {
  await withFixture(async fixture => {
    await confirm(fixture);
    const first = deferred<void>(), second = deferred<void>();
    const old = observe(fixture.snapshot().enterWorkspace(workspaceB, entryOptions({ confirm: () => first.promise })));
    await fixture.renderer.flush();
    const current = observe(fixture.snapshot().enterWorkspace(workspaceC, entryOptions({ confirm: () => second.promise })));
    await fixture.renderer.flush();
    const before = effects(fixture), tokens = fixture.tokenCalls.length;
    first.resolve();
    assert.equal(await settleObserved(fixture, old), false);
    assert.deepEqual(effects(fixture), before);
    assert.equal(fixture.tokenCalls.length, tokens);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.snapshot().isLoading, true);
    second.resolve();
    await fixture.renderer.flush();
    fixture.request().reply(success([target({ workspaceId: workspaceC })]));
    assert.equal(await settleObserved(fixture, current), true);
    assert.equal(fixture.snapshot().clinicId, workspaceC);
  });
});

for (const failure of ["network", 401, 403] as const)
test(`confirmation ${failure} leaves private UI neutral and never starts the fresh auth-context read`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture);
    const confirmation = deferred<void>(), tokens = fixture.tokenCalls.length;
    const outcome = observe(fixture.snapshot().enterWorkspace(workspaceB, entryOptions({ confirm: () => confirmation.promise })));
    await fixture.renderer.flush();
    confirmation.reject(failure === "network" ? new Error("isolated confirmation offline")
      : new CrmApiError(failure, "partner_company_access_denied", "isolated confirmation denied"));
    const result = await settleObserved(fixture, outcome, failure === "network" ? undefined : failure);
    if (failure === "network") assert.equal(result, false);
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().isLoading, false);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.tokenCalls.length, tokens);
    assert.deepEqual(fixture.locations, []);
  });
});

for (const event of ["TOKEN_REFRESHED", "USER_UPDATED"] as const)
for (const stage of ["held confirmation", "held fresh read", "failed entry", "denied entry"] as const)
test(`${event} listing only the previous W cannot auto-select it during/after ${stage} into T`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture);
    assert.equal(fixture.snapshot().clinicId, workspaceA);
    const confirmation = deferred<void>();
    const outcome = observe(fixture.snapshot().enterWorkspace(workspaceB, entryOptions(stage === "held confirmation"
      ? { confirm: () => confirmation.promise } : {})));
    await fixture.renderer.flush();
    assertUnselected(fixture);
    const entryRead = stage === "held confirmation" ? undefined : fixture.request();
    if (stage === "failed entry" || stage === "denied entry") {
      entryRead!.reply(stage === "failed entry" ? { success: false } : success([membership()]), stage === "failed entry" ? 503 : 200);
      const result = await settleObserved(fixture, outcome, stage === "denied entry" ? 403 : undefined);
      if (stage === "failed entry") assert.equal(result, false);
    }
    fixture.emit(actorA, event);
    await fixture.renderer.flush();
    await fixture.respond(fixture.request(), success([membership()]));
    assertNeutral(fixture);
    assert.equal(fixture.snapshot().user?.id, actorA);
    assert.equal(fixture.readScopes.at(-1)?.kind, "bind");
    assert.equal(fixture.readScopes.at(-1)?.args[1], null);
    assert.deepEqual(fixture.locations, []);
    if (stage === "held confirmation") {
      assert.equal(outcome.settled, false);
      const attempts = fixture.attempts.length;
      confirmation.resolve();
      assert.equal(await settleObserved(fixture, outcome), false);
      assert.equal(fixture.attempts.length, attempts, "retired confirmation must not start its fresh read");
    }
    if (stage === "held fresh read") {
      entryRead!.reply(success([target()]));
      assert.equal(await settleObserved(fixture, outcome), false);
    }
    assertNeutral(fixture);
    fixture.emit(actorA, event);
    await fixture.renderer.flush();
    await fixture.respond(fixture.request(), success([membership()]));
    assertNeutral(fixture);
    assert.deepEqual(fixture.locations, []);
    assert.equal(fixture.snapshot().availableWorkspaces.some(choice => choice.id === workspaceA), true);
    await pick(fixture, workspaceA);
    assert.equal(fixture.snapshot().clinicId, workspaceA, "an explicit current picker choice is still permitted");
    assert.deepEqual(fixture.locations, ["/dashboard"]);
  });
});

for (const event of ["TOKEN_REFRESHED", "USER_UPDATED"] as const)
test(`successful T entry stays pinned to T across ${event}; losing T cannot fall back to sole W`, async () => {
  await withFixture(async fixture => {
    await confirm(fixture);
    const outcome = observe(fixture.snapshot().enterWorkspace(workspaceB, entryOptions()));
    await fixture.renderer.flush();
    fixture.request().reply(success([membership(), target()]));
    assert.equal(await settleObserved(fixture, outcome), true);
    fixture.storage.setItem(selectorKey, workspaceA);
    fixture.emit(actorA, event);
    await fixture.renderer.flush();
    await fixture.respond(fixture.request(), success([membership(), target()]));
    assert.equal(fixture.snapshot().clinicId, workspaceB, "preserved target intent outranks a changed stored selector");
    assert.equal(fixture.storage.getItem(selectorKey), workspaceB);
    fixture.emit(actorA, event);
    await fixture.renderer.flush();
    await fixture.respond(fixture.request(), success([membership()]));
    assertNeutral(fixture);
    assert.equal(fixture.readScopes.at(-1)?.args[1], null);
    assert.deepEqual(fixture.locations, ["/dashboard"], "ordinary auth resolution never navigates back to W");
  });
});

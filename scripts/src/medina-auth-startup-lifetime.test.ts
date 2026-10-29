import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Actual AuthProvider, sign-out boundary and permission helpers. Only hooks,
// facade, storage, HTTP and navigation are synthetic. No runtime facade import,
// environment files, real SDK transport, browser or external service is loaded.
// Native SDK storage fencing is covered by the separate mutation suites, not here.
// No proof of browser paint, 30-second wall-clock expiry, or binding a legacy
// boolean sign-out marker to an unknown subject across a reload is claimed.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rootRequire = createRequire(path.join(root, "package.json"));
const ts = rootRequire("typescript") as typeof import("typescript");
const read = (file: string) => readFile(path.join(root, file), "utf8");
const providerSource = await read("artifacts/negis/src/contexts/AuthContext.tsx");
const providerDigest = createHash("sha256").update(providerSource).digest("hex");
const boundarySource = await read("artifacts/negis/src/lib/authSignOut.ts");
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const A = "10000000-0000-4000-8000-00000000a001";
const B = "10000000-0000-4000-8000-00000000b002";
const WA = "20000000-0000-4000-8000-00000000a001";
const WB = "20000000-0000-4000-8000-00000000b002";
const WI = "20000000-0000-4000-8000-00000000c003";
const IMP = "negis_impersonation";
const appOrigin = "https://startup-app.synthetic.invalid";
const controlOrigin = "https://startup-control.synthetic.invalid";
const metadata = { clinicId: WI, clinicName: "Synthetic delegated workspace",
  ownerEmail: "a@synthetic.invalid", ownerUserId: A, issuedBy: "synthetic-control-actor" };
const cachedMetadata = () => JSON.stringify({ active: true, clinic_id: WI,
  clinic_name: metadata.clinicName, owner_email: metadata.ownerEmail,
  auth_user_id: A, issued_by: metadata.issuedBy });
const localSession = (id: string | null, generation = "initial") => id ? {
  access_token: `synthetic-access:${id}:${generation}`, refresh_token: `synthetic-refresh:${id}:${generation}`,
  expires_at: 4_102_444_800, expires_in: 86_400, token_type: "bearer",
  user: { id, email: `${id === A ? "a" : "b"}@synthetic.invalid`, aud: "authenticated",
    app_metadata: {}, user_metadata: { full_name: id === A ? "Synthetic A" : "Synthetic B" },
    created_at: "2026-01-01T00:00:00.000Z" },
} : null;
type Session = ReturnType<typeof localSession>;
type Stamp = { revision: string; intent: string };
type Scope = { isCurrent(): boolean; signal?: AbortSignal; expected?: Stamp; expectedUserId?: string | null;
  onReceipt?(stamp: Stamp): void };
type Element = { type: any; props: Record<string, any> };
const jsx = (type: any, props: Element["props"]): Element => ({ type, props });

function evaluate(source: string, imports: Record<string, unknown> = {}, bindings: Record<string, unknown> = {}, dev = false) {
  const exports: Record<string, any> = {};
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    transformers: { before: [context => {
      const visit: import("typescript").Visitor = node => {
        if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
          return ts.factory.createObjectLiteralExpression([ts.factory.createPropertyAssignment("env",
            ts.factory.createObjectLiteralExpression([
              ts.factory.createPropertyAssignment("DEV", dev ? ts.factory.createTrue() : ts.factory.createFalse()),
              ts.factory.createPropertyAssignment("PROD", dev ? ts.factory.createFalse() : ts.factory.createTrue()),
              ts.factory.createPropertyAssignment("VITE_NEGIS_CONTROL_API_URL", ts.factory.createStringLiteral(controlOrigin)),
            ]))]);
        }
        return ts.visitEachChild(node, visit, context);
      };
      return file => ts.visitNode(file, visit) as import("typescript").SourceFile;
    }] },
  }).outputText;
  new Script(compiled).runInNewContext({ exports, URL, URLSearchParams, Response, Headers,
    AbortController, AbortSignal, DOMException, queueMicrotask, ...bindings,
    require(name: string) {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      assert.ok(name in imports, `Unmocked startup import: ${name}`);
      return imports[name];
    },
  });
  return exports;
}
const terms = evaluate(await read("lib/vertical/terms.ts"));
const purposes = evaluate(await read("lib/crm/workspace-purpose.ts"), { "../vertical/terms": terms });
const permissions = evaluate(await read("artifacts/negis/src/lib/permissions.ts"));
const authoritySource = await read("artifacts/negis/src/lib/authSessionAuthority.ts");
const authorityAst = ts.createSourceFile("authSessionAuthority.ts", authoritySource, ts.ScriptTarget.ES2022, true);
const staleErrorDeclaration = authorityAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "StaleAuthIntentError");
assert.ok(staleErrorDeclaration, "public stale-intent error contract must exist");
// Evaluate only the public error class, not the SDK factory or facade module.
const { StaleAuthIntentError } = evaluate(staleErrorDeclaration.getText(authorityAst));
const sameDeps = (a?: unknown[], b?: unknown[]) => Boolean(a && b && a.length === b.length
  && a.every((value, index) => Object.is(value, b[index])));

function renderer() {
  type Instance = { slots: any[]; cursor: number; disposed: boolean };
  const instances = new Map<string, Instance>();
  const writes: { instance: Instance; value: unknown }[] = [];
  let current: Instance, tree: Element, dirty = true, mounted = true;
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
    if (!instance) { instance = { slots: [], cursor: 0, disposed: false }; instances.set(address, instance); }
    current = instance; instance.cursor = 0;
    return render(value.type(value.props), `${address}/child`);
  }
  const effect = (create: () => any, deps?: unknown[], layout = false) => {
    const index = current.cursor++, old = current.slots[index];
    current.slots[index] = { create, deps, layout, cleanup: old?.cleanup, pending: !old || !sameDeps(old.deps, deps) };
  };
  const hooks = {
    createContext(initial: unknown) {
      const context: any = { current: initial }; context.Provider = { context }; return context;
    },
    useContext: (context: any) => context.current,
    useState(initial: any) {
      const owner = current, index = owner.cursor++;
      owner.slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [owner.slots[index].value, (update: any) => {
        const value = typeof update === "function" ? update(owner.slots[index].value) : update;
        writes.push({ instance: owner, value });
        if (!owner.disposed && !Object.is(value, owner.slots[index].value)) {
          owner.slots[index].value = value; dirty = true;
        }
      }];
    },
    useRef(initial: any) { const index = current.cursor++; return current.slots[index] ??= { current: initial }; },
    useMemo(create: () => any, deps?: unknown[]) {
      const index = current.cursor++;
      if (!current.slots[index] || !sameDeps(current.slots[index].deps, deps)) current.slots[index] = { value: create(), deps };
      return current.slots[index].value;
    },
    useCallback(fn: any, deps?: unknown[]) { return hooks.useMemo(() => fn, deps); },
    useEffect: effect,
    useLayoutEffect: (create: () => any, deps?: unknown[]) => effect(create, deps, true),
  };
  const commit = () => {
    if (!mounted || !dirty) return;
    dirty = false; render(tree, "root");
    for (const layout of [true, false]) {
      const pending = [...instances.values()].flatMap(instance => instance.slots)
        .filter(slot => slot?.pending && slot.layout === layout);
      for (const slot of pending) slot.cleanup?.();
      for (const slot of pending) { slot.pending = false; slot.cleanup = slot.create(); }
    }
  };
  return { hooks, writes, commit,
    mount(type: any, child: any) { tree = jsx(type, { children: jsx(child, {}) }); },
    replayEffects() {
      const effects = [...instances.values()].flatMap(owner => owner.slots).filter(slot => typeof slot?.create === "function");
      for (const slot of effects) slot.cleanup?.();
      for (const layout of [true, false]) {
        for (const slot of effects.filter(item => item.layout === layout)) slot.cleanup = slot.create();
      }
    },
    hideLayoutEffects() {
      const effects = [...instances.values()].flatMap(owner => owner.slots).filter(slot => slot?.layout);
      for (const slot of effects) { slot.cleanup?.(); slot.cleanup = undefined; }
    },
    revealLayoutEffects() {
      const effects = [...instances.values()].flatMap(owner => owner.slots).filter(slot => slot?.layout);
      for (const slot of effects) slot.cleanup = slot.create();
    },
    async flush() {
      for (let pass = 0; pass < 120; pass++) { commit(); await Promise.resolve(); }
      assert.equal(dirty, false, "synthetic provider renders settle");
    },
    dispose() {
      if (!mounted) return;
      mounted = false; dirty = false;
      for (const owner of instances.values()) {
        owner.disposed = true;
        for (const slot of owner.slots) slot?.cleanup?.();
      }
      instances.clear();
    },
  };
}

function memory(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed)), writes: { key: string; value: string | null }[] = [];
  return { values, writes, getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) { values.set(key, value); writes.push({ key, value }); },
    removeItem(key: string) { values.delete(key); writes.push({ key, value: null }); } };
}
function gate<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // A test may reject before the matching async boundary is entered.
  void promise.catch(() => {});
  return { promise, get settled() { return settled; },
    resolve(value: T) { if (!settled) { settled = true; resolve(value); } },
    reject(error: unknown) { if (!settled) { settled = true; reject(error); } } };
}
type Reply = { status?: number; body?: any };
type Kind = "verify headers" | "verify body" | "exchange headers" | "exchange body"
  | "initial session" | "dev session" | "OTP" | "membership" | "access token" | "OTP receipt" | "dev receipt" | "signOut";
type Hold = { kind: Kind; gate: ReturnType<typeof gate<any>>; used: boolean };
type Snapshot = { user: { id: string; email: string } | null; session: Session; clinicId: string | null;
  userRole: string | null; rolePermissions: Record<string, boolean>; isImpersonation: boolean;
  isStaffMode: boolean; isDemoMode: boolean; isLoading: boolean; isSigningOut: boolean;
  signOut(): Promise<void>; [key: string]: any };
type MountOptions = { search?: string; pathname?: string; dev?: boolean };
type Options = { actor?: string | null; otpActor?: string | null; storage?: Record<string, string>; verify?: Reply; exchange?: Reply;
  configured?: boolean; targetOwner?: boolean; membershipRole?: string; membershipWorkspace?: string };

function fixture(t: TestContext, options: Options = {}) {
  const forbiddenHttp = t.mock.method(globalThis, "fetch", async () => { assert.fail("Global HTTP is forbidden"); });
  const storage = memory(options.storage), sessionStorage = memory();
  const holds: Hold[] = [], mounts: { renderer: ReturnType<typeof renderer>; snapshot(): Snapshot }[] = [];
  const callbacks = new Set<(event: string, value: Session) => void>();
  const traces: { kind: string; stamp: Stamp }[] = [];
  const captures: { stamp: Stamp; order: number }[] = [];
  const requests: { kind: string; init: any; url: string }[] = [];
  const mutations: { method: string; guarded: boolean; scope?: Scope; actor: string | null }[] = [];
  const exitScopes: Scope[] = [];
  const locations: string[] = [], urlChanges: string[] = [], toasts: { kind: string; message: string }[] = [];
  const readScopes: { kind: string; owner: unknown; id?: string | null }[] = [];
  const cacheClears: string[] = [], logs: unknown[][] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let live = localSession(options.actor === undefined ? A : options.actor), revision = 0, intent = 0;
  const stamp = (): Stamp => ({ revision: String(revision), intent: String(intent) });
  const sameStamp = (a: Stamp, b: Stamp) => a.revision === b.revision && a.intent === b.intent;
  const trace = (kind: string) => traces.push({ kind, stamp: stamp() });
  let url = new URL("/dashboard", appOrigin);
  const location = { get search() { return url.search; }, get pathname() { return url.pathname; },
    get hash() { return url.hash; }, get href() { return url.href; }, origin: appOrigin };
  const window = { localStorage: storage, sessionStorage, location,
    history: { replaceState(_state: unknown, _title: string, next: string) {
      url = new URL(next, appOrigin); urlChanges.push(url.pathname + url.search);
    } }, addEventListener() {}, removeEventListener() {} };
  const boundary = evaluate(boundarySource, {}, { window });
  const consume = async (kind: Kind, fallback: any) => {
    trace(kind);
    const held = holds.find(item => item.kind === kind && !item.used);
    if (!held) return fallback;
    held.used = true;
    return (await held.gate.promise) ?? fallback;
  };
  function replace(value: Session, event = value ? "SIGNED_IN" : "SIGNED_OUT", notify = true) {
    live = clone(value); revision++;
    if (notify) for (const callback of [...callbacks]) callback(event, clone(live));
  }
  const response = (spec: Reply, bodyKind: Kind) => ({ ok: (spec.status ?? 200) < 400, status: spec.status ?? 200,
    async json() { return clone(await consume(bodyKind, spec.body)); },
    async text() { return JSON.stringify(await consume(bodyKind, spec.body)); } }) as Response;
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const target = new URL(String(input), appOrigin);
    assert.ok(target.origin === appOrigin || target.origin === controlOrigin, "only synthetic HTTP origins are accepted");
    const kind = target.pathname === "/api/impersonation/verify" ? "verify"
      : target.pathname === "/api/impersonation/session" ? "exchange" : null;
    assert.ok(kind, `Unexpected startup HTTP path: ${target.pathname}`);
    requests.push({ kind, init, url: target.href });
    const spec = await consume(`${kind} headers` as Kind, kind === "verify"
      ? options.verify ?? { body: metadata } : options.exchange ?? { body: { tokenHash: "synthetic-otp-hash" } });
    return response(spec, `${kind} body` as Kind);
  };
  const currentScope = (scope: Scope | undefined) => {
    try { return !!scope && !scope.signal?.aborted && scope.isCurrent(); } catch { return false; }
  };
  async function mutation(method: "dev session" | "OTP", params: any, scope?: Scope) {
    const guarded = scope !== undefined, original = stamp();
    mutations.push({ method, guarded, scope, actor: live?.user.id ?? null });
    trace(`${method} dispatch`);
    if (guarded && (!currentScope(scope) || (scope?.expected && !sameStamp(scope.expected, original))
      || ("expectedUserId" in scope! && scope?.expectedUserId !== (live?.user.id ?? null)))) {
      return { data: { session: null, user: null }, error: new Error("Synthetic stale auth dispatch") };
    }
    const claimed = ++intent;
    if (guarded && !currentScope(scope)) {
      return { data: { session: null, user: null }, error: new Error("Synthetic caller invalidated its own intent claim") };
    }
    const result = await consume(method, { session: method === "OTP"
      ? localSession(options.otpActor === undefined ? A : options.otpActor)
      : { ...localSession(A)!, access_token: params.access_token, refresh_token: params.refresh_token } });
    if (guarded && (!currentScope(scope) || revision !== Number(original.revision) || intent !== claimed)) {
      return { data: { session: null, user: null }, error: new Error("Synthetic stale auth completion") };
    }
    if (result.error) return { data: { session: null, user: null }, error: result.error };
    if (result.session) replace(result.session, method === "OTP" ? "SIGNED_IN" : "TOKEN_REFRESHED");
    scope?.onReceipt?.(stamp());
    await consume(method === "OTP" ? "OTP receipt" : "dev receipt", null);
    return { data: { session: clone(result.session ?? null), user: clone(result.session?.user ?? null) }, error: null };
  }
  const sdk = {
    async getSession() { const original = clone(live); return consume("initial session", { data: { session: original }, error: null }); },
    async getUser() { return { data: { user: clone(live?.user ?? null) }, error: null }; },
    setSession: (params: any) => mutation("dev session", params),
    verifyOtp: (params: any) => mutation("OTP", params),
    async signOut() { replace(null); return { error: null }; },
    onAuthStateChange(callback: (event: string, value: Session) => void) {
      callbacks.add(callback);
      return { data: { subscription: { unsubscribe() { callbacks.delete(callback); } } } };
    },
  };
  const sessionAuth = {
    capture() { const value = stamp(); captures.push({ stamp: value, order: traces.length }); trace("capture"); return value; },
    isCurrent: (value: Stamp) => sameStamp(value, stamp()),
    onAuthStateChange: sdk.onAuthStateChange,
    setSession: (params: any, scope: Scope) => mutation("dev session", params, scope),
    verifyOtp: (params: any, scope: Scope) => mutation("OTP", params, scope),
    async signOut(scope: Scope) {
      exitScopes.push(scope);
      if (!currentScope(scope) || (scope.expected && !sameStamp(scope.expected, stamp()))
        || ("expectedUserId" in scope && scope.expectedUserId !== (live?.user.id ?? null))) {
        return { error: new StaleAuthIntentError() };
      }
      const originalRevision = revision, claimed = ++intent;
      const reply = await consume("signOut", { error: null });
      if (!currentScope(scope) || revision !== originalRevision || intent !== claimed) {
        return { error: new StaleAuthIntentError() };
      }
      if (reply.error) return reply;
      return sdk.signOut();
    },
  };
  const membership = (id: string) => ({ staffUserId: `synthetic-staff:${id}`,
    workspaceId: options.membershipWorkspace ?? (options.targetOwner && id === A ? WI : id === A ? WA : WB),
    workspaceName: id === A ? "Synthetic A workspace" : "Synthetic B workspace", role: "lead_manager",
    permissions: ["view_leads"], purpose: "clinic_services", vertical: terms.DEFAULT_VERTICAL,
    ...(options.targetOwner && id === A ? { role: "owner" } : {}),
    ...(options.membershipRole ? { role: options.membershipRole } : {}) });
  function mount(config: MountOptions = {}) {
    url = new URL((config.pathname ?? "/dashboard") + (config.search ?? ""), appOrigin);
    const render = renderer();
    let snapshot!: Snapshot;
    const auth = evaluate(providerSource, {
      react: { ...render.hooks, default: render.hooks },
      "@/lib/supabase": { supabase: { auth: sdk }, sessionAuth, hasSupabaseFrontendEnv: options.configured ?? true },
      "@/lib/authSessionAuthority": { StaleAuthIntentError },
      "@/lib/authSignOut": boundary,
      "../../../../lib/vertical/terms": terms,
      "../../../../lib/crm/workspace-purpose": purposes,
      "@/lib/permissions": permissions,
      wouter: { useLocation: () => [url.pathname, (next: string) => { locations.push(next); url = new URL(next, appOrigin); }] },
      sonner: { toast: new Proxy({}, { get: (_target, kind) => (message: string) => toasts.push({ kind: String(kind), message }) }) },
      "@/lib/demoStorage": { WORKSPACE_SELECTOR_KEY: "negis_workspace_selector",
        bindWorkspaceReadScope(owner: unknown, id: string | null) { readScopes.push({ kind: "bind", owner, id }); },
        clearWorkspaceReadScope(owner: unknown) { readScopes.push({ kind: "clear", owner }); },
        clearListReadCache() { cacheClears.push("list"); } },
      "@/lib/api": { apiUrl: (next: string) => new URL(next, appOrigin).href,
        clearCrmCache() { cacheClears.push("crm"); },
        async crmFetch(next: string, init: any = {}) {
          assert.equal(next, "/api/crm/auth-context");
          requests.push({ kind: "membership", init, url: next });
          const id = init.expectedUserId ?? live?.user.id;
          const reply = await consume("membership", { status: 200, body: { success: true, mode: "supabase", data: {
            memberships: id ? [membership(id)] : [], requiresWorkspaceSelection: false,
          } } });
          return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
        } },
      "@/lib/serverAuth": { async getSupabaseAccessToken(expected?: string) {
        return consume("access token", expected && live?.user.id !== expected ? "" : live?.access_token ?? "");
      } },
    }, { localStorage: storage, sessionStorage, window, document: { title: "Synthetic startup" }, fetch,
      console: { error: (...args: unknown[]) => logs.push(args), warn: (...args: unknown[]) => logs.push(args), log() {} },
      setTimeout(fn: () => void, ms: number) {
        const handle = setTimeout(() => { timers.delete(handle); fn(); }, ms); timers.add(handle); return handle;
      },
      clearTimeout(handle: ReturnType<typeof setTimeout>) { clearTimeout(handle); timers.delete(handle); },
    }, config.dev);
    function Probe() { snapshot = auth.useAuth(); return null; }
    render.mount(auth.AuthProvider, Probe);
    const result = { renderer: render, snapshot: () => snapshot };
    mounts.push(result);
    return result;
  }
  const flush = async () => { for (const mounted of mounts) await mounted.renderer.flush(); };
  const hold = (kind: Kind) => {
    const item = { kind, gate: gate<any>(), used: false }; holds.push(item);
    return { release: (value?: any) => item.gate.resolve(value),
      reject: () => item.gate.reject(new Error(`Synthetic held ${kind} failure`)), used: () => item.used };
  };
  t.after(async () => {
    for (const mounted of mounts) mounted.renderer.dispose();
    for (const item of holds) item.gate.resolve(undefined);
    await flush();
    const leaked = callbacks.size;
    callbacks.clear();
    for (const handle of timers) clearTimeout(handle);
    timers.clear();
    assert.equal(forbiddenHttp.mock.callCount(), 0);
    assert.equal(leaked, 0, "retired startup cannot resurrect a subscription during teardown");
    assert.ok(holds.every(item => item.gate.settled), "every held promise is released");
  });
  return { mount, flush, hold, replace, stamp, captures, traces, requests, mutations, exitScopes, storage, sessionStorage,
    locations, urlChanges, toasts, readScopes, cacheClears, logs, boundary,
    live: () => clone(live), route: () => url.pathname + url.search,
    subscriptions: () => callbacks.size,
    queuedEvent(event = "SIGNED_IN", value: Session = clone(live)) {
      const pending = [...callbacks];
      return () => { for (const callback of pending) callback(event, clone(value)); };
    },
  };
}

type Fixture = ReturnType<typeof fixture>;
type Mount = ReturnType<Fixture["mount"]>;
const impersonationUrl = "?impersonate_token=synthetic-startup-proof";
const devUrl = "?dev_access_token=synthetic-dev-access&dev_refresh_token=synthetic-dev-refresh";
const context = (mount: Mount) => {
  const value = mount.snapshot();
  return clone({ user: value.user, session: value.session, clinicId: value.clinicId, userRole: value.userRole,
    rolePermissions: value.rolePermissions, isImpersonation: value.isImpersonation,
    isStaffMode: value.isStaffMode, isDemoMode: value.isDemoMode, isLoading: value.isLoading });
};
const effects = (f: Fixture, mount: Mount) => ({ context: context(mount), live: f.live(),
  storage: [...f.storage.values], writes: f.storage.writes.length,
  stateWrites: mount.renderer.writes.length, scopes: f.readScopes.length, cacheClears: f.cacheClears.length,
  locations: [...f.locations], urlChanges: [...f.urlChanges], toasts: [...f.toasts], mutations: f.mutations.length });
function noDelegatedAccess(mount: Mount) {
  assert.equal(mount.snapshot().isImpersonation, false);
  assert.notEqual(mount.snapshot().clinicId, WI);
  assert.notEqual(mount.snapshot().userRole, "owner");
  assert.notEqual(mount.snapshot().userRole, "admin");
  assert.notEqual(mount.snapshot().rolePermissions.admin, true);
}

test("normal configured startup resolves only fresh server membership and keeps its route", async t => {
  t.diagnostic(`AuthProvider source SHA256: ${providerDigest}`);
  const f = fixture(t), m = f.mount({ pathname: "/profile" });
  await f.flush();
  assert.equal(m.snapshot().user?.id, A);
  assert.equal(m.snapshot().clinicId, WA);
  assert.equal(m.snapshot().userRole, "lead_manager");
  assert.equal(m.snapshot().isLoading, false);
  assert.equal(f.route(), "/profile");
  assert.equal(f.subscriptions(), 1);
  noDelegatedAccess(m);
});

for (const pathname of ["/join/synthetic-invite", "/operator", "/contributors", "/partner-company", "/r/synthetic-link", "/reset-password"])
test(`unlinked normal startup preserves the existing ${pathname} entry route`, async t => {
  const f = fixture(t), held = f.hold("membership");
  held.release({ body: { success: true, data: { memberships: [] } } });
  const m = f.mount({ pathname });
  await f.flush();
  assert.equal(m.snapshot().isLoading, false);
  assert.equal(f.route(), pathname);
  assert.deepEqual(f.locations, []);
  assert.deepEqual(f.toasts, []);
  noDelegatedAccess(m);
});

const staffSeed = { negis_staff_session: JSON.stringify({ mode: "staff", authenticated: true,
  email: "a@synthetic.invalid", createdAt: "2026-01-01T00:00:00Z", workspaceId: WA, supabaseUserId: A }),
negis_staff_user: JSON.stringify({ id: "synthetic-local-staff", email: "a@synthetic.invalid", name: "Synthetic staff",
  role: "receptionist", workspaceId: WA, authUserId: A }) };

test("offline staff startup remains available without creating an SDK session", async t => {
  const f = fixture(t, { configured: false, actor: null, storage: staffSeed }), m = f.mount({ pathname: "/booking" });
  await f.flush();
  assert.equal(m.snapshot().isStaffMode, true);
  assert.equal(m.snapshot().userRole, "receptionist");
  assert.equal(m.snapshot().clinicId, WA);
  assert.equal(m.snapshot().isLoading, false);
  assert.equal(f.route(), "/booking");
  assert.equal(f.mutations.length, 0);
});

test("configured startup ignores cached staff privileges and resolves current B through server context", async t => {
  const f = fixture(t, { actor: B, storage: { ...staffSeed,
    negis_staff_user: JSON.stringify({ email: "a@synthetic.invalid", role: "owner", workspaceId: WI }) } });
  const m = f.mount();
  await f.flush();
  assert.equal(m.snapshot().user?.id, B);
  assert.equal(m.snapshot().clinicId, WB);
  assert.equal(m.snapshot().userRole, "lead_manager");
  noDelegatedAccess(m);
});

test("local demo startup and its current route remain intact", async t => {
  const f = fixture(t, { actor: null, storage: {
    negis_demo_session: JSON.stringify({ mode: "demo", authenticated: true, createdAt: "2026-01-01T00:00:00Z" }),
    negis_demo_workspace: JSON.stringify({ id: WA, name: "Synthetic demo" }),
    negis_demo_user: JSON.stringify({ id: "synthetic-demo-user", name: "Synthetic local user" }),
  } }), m = f.mount({ pathname: "/booking" });
  await f.flush();
  assert.equal(m.snapshot().isDemoMode, true);
  assert.equal(m.snapshot().clinicId, WA);
  assert.equal(m.snapshot().user?.id, "synthetic-demo-user");
  assert.equal(m.snapshot().session, null);
  assert.equal(f.route(), "/booking");
  assert.equal(f.mutations.length, 0);
});

for (const actor of [null, A, B])
test(`cached imp descriptor is not an authority for live ${actor ?? "anonymous"} startup`, async t => {
  const f = fixture(t, { actor, storage: { [IMP]: cachedMetadata() } }), m = f.mount();
  await f.flush();
  noDelegatedAccess(m);
  assert.equal(m.snapshot().user?.id ?? null, actor);
  assert.ok(!f.readScopes.some(scope => scope.kind === "bind" && scope.id === WI),
    "forged local metadata cannot transiently bind a privileged workspace either");
});

const cachedHint = JSON.parse(cachedMetadata());
for (const [label, raw] of [
  ["invalid JSON", "{synthetic-invalid-json"],
  ["JSON null", "null"],
  ["JSON array", JSON.stringify([cachedHint])],
  ["numeric owner email", JSON.stringify({ ...cachedHint, owner_email: 17 })],
  ["legacy missing actor binding", JSON.stringify({ ...cachedHint, auth_user_id: undefined })],
  ["numeric actor binding", JSON.stringify({ ...cachedHint, auth_user_id: 17 })],
  ["nonboolean active flag", JSON.stringify({ ...cachedHint, active: "true" })],
  ["numeric target workspace", JSON.stringify({ ...cachedHint, clinic_id: 17 })],
  ["object issuer", JSON.stringify({ ...cachedHint, issued_by: { forged: true } })],
  ["array display label", JSON.stringify({ ...cachedHint, clinic_name: ["forged"] })],
] as const)
test(`malformed cached imp hint (${label}) cannot crash configured startup or elevate B`, async t => {
  const f = fixture(t, { actor: B, storage: { [IMP]: raw } }), m = f.mount({ pathname: "/profile" });
  await f.flush();
  assert.equal(m.snapshot().isLoading, false, "root finishes a normal server-authorized startup despite malformed local JSON");
  assert.equal(m.snapshot().user?.id, B);
  assert.equal(m.snapshot().clinicId, WB);
  assert.equal(m.snapshot().userRole, "lead_manager");
  noDelegatedAccess(m);
  assert.equal(f.route(), "/profile");
  assert.deepEqual(f.logs, []);
  assert.deepEqual(f.toasts, []);
  assert.ok(!f.readScopes.some(scope => scope.kind === "bind" && scope.id === WI));
});

test("startup binds its original authority stamp before its first asynchronous boundary", async t => {
  const f = fixture(t), held = f.hold("verify headers"), m = f.mount({ search: impersonationUrl });
  await f.flush();
  assert.equal(held.used(), true);
  const firstAsync = f.traces.findIndex(item => item.kind !== "capture");
  assert.ok(f.captures.some(capture => capture.order < firstAsync),
    "capture the original SDK epoch before getSession, verify HTTP, or an auth mutation can yield");
  noDelegatedAccess(m);
  held.release();
  await f.flush();
});

for (const phase of ["verify headers", "verify body", "exchange headers", "exchange body", "OTP"] as const)
test(`fresh verification at held ${phase} cannot grant target owner authority`, async t => {
  const f = fixture(t), held = f.hold(phase), m = f.mount({ search: impersonationUrl });
  await f.flush();
  assert.equal(held.used(), true, `${phase} must actually be pending`);
  noDelegatedAccess(m);
  assert.ok(!f.readScopes.some(scope => scope.kind === "bind" && scope.id === WI));
  held.release(); await f.flush();
  noDelegatedAccess(m);
});

for (const otpActor of [null, B])
test(`verified URL metadata without the matching live owner (${otpActor ?? "missing"}) cannot grant target access`, async t => {
  const f = fixture(t, { actor: B, otpActor }), m = f.mount({ search: impersonationUrl });
  await f.flush();
  noDelegatedAccess(m);
  assert.equal(f.storage.getItem(IMP), null, "unbound verification metadata is never cached as an active hint");
  assert.equal(f.locations.includes("/dashboard"), false);
});

for (const reason of ["non-owner", "different target"] as const)
test(`correct owner email without fresh owner target membership (${reason}) cannot activate imp hint`, async t => {
  const f = fixture(t, reason === "non-owner"
    ? { membershipRole: "lead_manager", membershipWorkspace: WI }
    : { membershipRole: "owner", membershipWorkspace: WA });
  const m = f.mount({ search: impersonationUrl });
  await f.flush();
  assert.equal(m.snapshot().isImpersonation, false);
  assert.equal(f.storage.getItem(IMP), null);
  assert.equal(f.locations.includes("/dashboard"), false);
  assert.equal(m.snapshot().userRole, reason === "non-owner" ? "lead_manager" : "owner",
    "ordinary fresh membership remains authoritative independently of the refused hint");
});

test("a current owner session plus a fresh owner membership can complete the synthetic delegated startup", async t => {
  const f = fixture(t, { targetOwner: true }), m = f.mount({ search: impersonationUrl, pathname: "/profile" });
  await f.flush();
  assert.equal(m.snapshot().user?.id, A);
  assert.equal(m.snapshot().clinicId, WI);
  assert.equal(m.snapshot().userRole, "owner");
  assert.equal(m.snapshot().isImpersonation, true);
  assert.equal(m.snapshot().isLoading, false);
  const otp = f.mutations.find(call => call.method === "OTP");
  assert.ok(otp);
  assert.equal(otp.guarded, true);
  assert.equal(typeof otp.scope?.onReceipt, "function", "caller adopts only its exact authority receipt stamp");
  assert.ok(f.requests.some(request => request.kind === "membership"));
  const raw = f.storage.getItem(IMP);
  assert.ok(raw, "a current successful OTP actually publishes the bound hint, not just a canceled receipt");
  const hint = JSON.parse(raw);
  assert.equal(hint.auth_user_id, A);
  assert.equal(hint.owner_email, metadata.ownerEmail);
  assert.equal(hint.clinic_id, WI);
  assert.equal(f.live()?.user.id, A);
  assert.ok(f.locations.includes("/dashboard"), "successful current startup actively navigates from /profile");
  assert.equal(f.route(), "/dashboard");
});

test("DEV query session uses the guarded authority rather than raw SDK setSession", async t => {
  const f = fixture(t), held = f.hold("dev session"), m = f.mount({ search: devUrl, dev: true });
  await f.flush();
  assert.equal(held.used(), true);
  const call = f.mutations.find(value => value.method === "dev session");
  assert.ok(call);
  assert.equal(call.guarded, true);
  assert.equal(typeof call.scope?.isCurrent, "function");
  assert.equal(typeof call.scope?.onReceipt, "function");
  held.release(); await f.flush();
  assert.equal(m.snapshot().isLoading, false);
  assert.equal(m.snapshot().clinicId, WA);
});

test("PROD runtime ignores DEV URL credentials and preserves normal server-resolved startup", async t => {
  const f = fixture(t), m = f.mount({ search: devUrl, dev: false, pathname: "/profile" });
  await f.flush();
  assert.equal(f.mutations.some(call => call.method === "dev session"), false);
  assert.equal(m.snapshot().user?.id, A);
  assert.equal(m.snapshot().clinicId, WA);
  assert.equal(f.route().split("?")[0], "/profile");
});

test("PROD transform and tree shaking eliminate DEV credential reads and SDK session setter", async () => {
  const scriptsRequire = createRequire(path.join(root, "scripts/package.json"));
  const esbuild = createRequire(scriptsRequire.resolve("tsx/package.json"))("esbuild");
  const frontendRequire = createRequire(path.join(root, "artifacts/negis/package.json"));
  const rollup = createRequire(frontendRequire.resolve("vite/package.json"))("rollup");
  const result = esbuild.transformSync(providerSource, { loader: "tsx", format: "esm", minifySyntax: true,
    treeShaking: true, legalComments: "none", define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true" } });
  // Exercise the installed production tree shaker with a closed virtual module.
  // No Vite config, environment loader, source dependency or remote module runs.
  const entry = "synthetic:auth-provider-production";
  const bundle = await rollup.rollup({ input: entry, external: (id: string) => id !== entry,
    plugins: [{ name: "synthetic-provider-production", resolveId: (id: string) => id === entry ? entry : null,
      load: (id: string) => id === entry ? result.code : null }] });
  let output: string;
  try {
    const generated = await bundle.generate({ format: "esm" });
    output = generated.output.filter((item: { type: string }) => item.type === "chunk").map((item: { code: string }) => item.code).join("\n");
  } finally { await bundle.close(); }
  const emitted = ts.createSourceFile("startup-production.js", output, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const credentialReads: string[] = [], sdkSessionSetters: string[] = [];
  const visit = (node: import("typescript").Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (node.expression.name.text === "setSession") sdkSessionSetters.push(node.expression.getText(emitted));
      const parameter = node.arguments[0];
      if (node.expression.name.text === "get" && parameter && ts.isStringLiteral(parameter)
        && ["dev_access_token", "dev_refresh_token"].includes(parameter.text)) credentialReads.push(parameter.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(emitted);
  // Presence checks may remain solely to scrub a stale URL. Neither reading
  // credential values nor establishing a session may remain in PROD output.
  assert.deepEqual(credentialReads, []);
  assert.deepEqual(sdkSessionSetters, []);
});

const inactiveBHint = () => JSON.stringify({ active: false, actor_id: B, clinic_id: WB,
  owner_email: "b@synthetic.invalid", fixtureMarker: "newer-B-owned-descriptor" });
async function retire(f: Fixture, old: Mount, reason: "signOut" | "remount" | "account replacement" | "account ABA") {
  let current = old;
  if (reason === "signOut") { await old.snapshot().signOut(); await f.flush(); f.replace(localSession(B)); }
  else if (reason === "remount") {
    old.renderer.dispose(); f.storage.removeItem(IMP); f.replace(localSession(B));
    current = f.mount({ pathname: "/profile" });
  } else {
    const original = f.live();
    f.replace(localSession(B));
    if (reason === "account ABA") f.replace(original);
  }
  await f.flush();
  f.storage.setItem(IMP, inactiveBHint());
  return current;
}

for (const phase of ["verify headers", "verify body", "exchange headers", "exchange body", "OTP", "OTP receipt"] as const)
for (const reason of ["signOut", "remount", "account replacement", "account ABA"] as const)
test(`late ${phase} success after ${reason} cannot restore obsolete startup authority`, async t => {
  const f = fixture(t), held = f.hold(phase), old = f.mount({ search: impersonationUrl });
  await f.flush();
  assert.equal(held.used(), true, "the tested startup boundary must be reached");
  const current = await retire(f, old, reason);
  assert.equal(current.snapshot().user?.id, reason === "account ABA" ? A : B);
  assert.equal(current.snapshot().isLoading, false,
    "the current account must not wait for the obsolete response or the 30-second deadline");
  const before = effects(f, current), oldWrites = old.renderer.writes.length;
  const requestCount = f.requests.filter(request => request.kind === "verify" || request.kind === "exchange").length;
  held.release(); await f.flush();
  assert.equal(f.storage.getItem(IMP), inactiveBHint(), "old completion neither replaces nor clears B's newer descriptor");
  const writes = f.storage.writes.slice(before.writes);
  assert.ok(writes.every(write => write.key !== IMP), "obsolete completion cannot mutate B-owned imp metadata");
  if (reason === "remount") assert.equal(writes.length, 0, "unmounted startup cannot write any shared storage");
  else assert.ok(writes.every(write => write.key === "negis_workspace_selector"
    && write.value === (f.live()?.user.id === B ? WB : WA)),
  "a retired mounted startup may only trigger a fresh normal resolution of the current account");
  assert.deepEqual(f.live(), before.live, "obsolete token exchange never replaces the current SDK session");
  assert.deepEqual(f.locations, before.locations, "old completion cannot navigate the newer route");
  assert.deepEqual(f.toasts, before.toasts);
  assert.equal(f.requests.filter(request => request.kind === "verify" || request.kind === "exchange").length, requestCount,
    "no next-stage exchange dispatch after the original startup retired");
  if (reason === "remount") {
    assert.deepEqual(context(current), before.context);
    assert.equal(old.renderer.writes.length, oldWrites, "retired provider performs no attempted state writes");
  } else noDelegatedAccess(current);
});

for (const phase of ["verify headers", "verify body", "exchange headers", "exchange body", "OTP"] as const)
test(`late ${phase} rejection after remount cannot clear or navigate B`, async t => {
  const f = fixture(t), held = f.hold(phase), old = f.mount({ search: impersonationUrl });
  await f.flush(); assert.equal(held.used(), true);
  const current = await retire(f, old, "remount"), before = effects(f, current);
  held.reject(); await f.flush();
  assert.equal(f.storage.getItem(IMP), inactiveBHint());
  assert.deepEqual(effects(f, current), before);
});

for (const phase of ["dev session", "dev receipt"] as const)
for (const reason of ["signOut", "remount", "account replacement", "account ABA"] as const)
test(`late DEV ${phase} after ${reason} cannot replace or navigate the current account`, async t => {
  const f = fixture(t), held = f.hold(phase), old = f.mount({ dev: true, search: devUrl });
  await f.flush(); assert.equal(held.used(), true);
  const current = await retire(f, old, reason), before = effects(f, current);
  held.release(); await f.flush();
  assert.deepEqual(f.live(), before.live);
  assert.deepEqual(f.locations, before.locations);
  assert.equal(f.storage.getItem(IMP), inactiveBHint());
  if (reason === "remount") assert.deepEqual(context(current), before.context);
});

for (const reason of ["signOut", "remount", "account replacement", "account ABA"] as const)
test(`late initial getSession after ${reason} cannot replace the current account with its startup snapshot`, async t => {
  const f = fixture(t), held = f.hold("initial session"), m = f.mount();
  await f.flush(); assert.equal(held.used(), true);
  const current = await retire(f, m, reason), before = effects(f, current);
  held.release(); await f.flush();
  assert.deepEqual(effects(f, current), before);
  assert.equal(current.snapshot().user?.id, reason === "account ABA" ? A : B);
});

test("a queued startup observer callback from an unmounted provider cannot touch remounted B", async t => {
  const f = fixture(t), old = f.mount();
  await f.flush();
  const queued = f.queuedEvent("TOKEN_REFRESHED", localSession(A));
  const current = await retire(f, old, "remount"), before = effects(f, current), oldWrites = old.renderer.writes.length;
  queued(); await f.flush();
  assert.deepEqual(effects(f, current), before);
  assert.equal(old.renderer.writes.length, oldWrites);
});

// Defense-in-depth replay at the provider callback boundary. This intentionally
// bypasses authority.observe's native-payload filtering, which is tested elsewhere.
test("provider defense: a replayed pre-signOut A callback cannot clear current B after the exit marker clears", async t => {
  const f = fixture(t), m = f.mount();
  await f.flush();
  const queued = f.queuedEvent("USER_UPDATED", localSession(A));
  await retire(f, m, "signOut");
  const before = effects(f, m);
  queued(); await f.flush();
  assert.deepEqual(effects(f, m), before);
  assert.equal(m.snapshot().user?.id, B);
});

test("Strict effect replay retires the first setup's callback even though its mounted ref becomes true again", async t => {
  const f = fixture(t), held = f.hold("initial session"), m = f.mount();
  m.renderer.commit();
  assert.equal(held.used(), true);
  const queuedFirstSetup = f.queuedEvent("TOKEN_REFRESHED", localSession(A));
  m.renderer.replayEffects();
  await f.flush();
  f.replace(localSession(B)); await f.flush();
  assert.equal(m.snapshot().user?.id, B);
  const before = effects(f, m);
  queuedFirstSetup(); held.release(); await f.flush();
  assert.deepEqual(effects(f, m), before);
  assert.equal(f.subscriptions(), 1);
});

test("retained-state replay starts its own pending exit and old finally cannot clear the newer dedupe ref", async t => {
  const f = fixture(t), m = f.mount();
  await f.flush();
  const oldExit = f.hold("signOut"), newExit = f.hold("signOut");
  const firstRequest = m.snapshot().signOut();
  await f.flush();
  assert.equal(oldExit.used(), true);
  m.renderer.replayEffects();
  await f.flush();
  assert.equal(newExit.used(), true, "replayed setup must recover the pending global exit, not reuse the retired provider promise");
  const newerRequest = m.snapshot().signOut();
  assert.notEqual(newerRequest, firstRequest);
  oldExit.release();
  await firstRequest; await f.flush();
  assert.equal(f.boundary.isSignOutPending(), true, "old completion cannot clear the newer exit marker");
  assert.equal(m.snapshot().signOut(), newerRequest, "old finally must not clear the new provider's in-flight dedupe ref");
  assert.equal(f.traces.filter(entry => entry.kind === "signOut").length, 2);
  newExit.release();
  await newerRequest; await f.flush();
  assert.equal(f.boundary.isSignOutPending(), false);
  assert.equal(m.snapshot().user, null);
  assert.equal(m.snapshot().session, null);
  assert.equal(m.snapshot().isSigningOut, false);
});

test("ready layout hide/reveal clears private provider snapshot before held bootstrap and retires the old callback", async t => {
  const f = fixture(t), m = f.mount();
  await f.flush();
  assert.equal(m.snapshot().user?.id, A);
  assert.equal(m.snapshot().clinicId, WA);
  const queued = f.queuedEvent("TOKEN_REFRESHED", localSession(A)), held = f.hold("initial session");
  m.renderer.hideLayoutEffects();
  f.replace(localSession(B), "SIGNED_IN", false);
  m.renderer.revealLayoutEffects();
  await f.flush();
  assert.equal(held.used(), true);
  // Provider-state observation only: this is not a browser, React DOM paint,
  // visibility assertion, or a complete Suspense implementation.
  assert.equal(m.snapshot().isLoading, true);
  assert.equal(m.snapshot().session, null);
  assert.equal(m.snapshot().user, null);
  assert.equal(m.snapshot().clinicId, null);
  assert.equal(m.snapshot().userRole, null);
  assert.deepEqual(clone(m.snapshot().rolePermissions), {});
  const before = effects(f, m);
  queued(); await f.flush();
  assert.deepEqual(effects(f, m), before);
  held.release(); await f.flush();
  assert.equal(m.snapshot().isLoading, false);
  assert.equal(m.snapshot().user?.id, B);
  assert.equal(m.snapshot().clinicId, WB);
  assert.equal(m.snapshot().userRole, "lead_manager");
});

test("exit captures original A stamp and UI subject before a synchronous B replacement and microtask dispatch", async t => {
  const f = fixture(t), m = f.mount({ pathname: "/profile" });
  await f.flush();
  assert.equal(m.snapshot().user?.id, A);
  const original = f.stamp(), exitingA = m.snapshot().signOut();
  f.replace(localSession(B));
  await exitingA; await f.flush();
  assert.equal(f.exitScopes.length, 1);
  assert.deepEqual(clone(f.exitScopes[0].expected), original);
  assert.equal(f.exitScopes[0].expectedUserId, A, "capture UI actor before beginAuthResolution(null) clears the ref");
  assert.equal(f.traces.filter(entry => entry.kind === "signOut").length, 0,
    "a stale original proof is rejected before a remote logout can target B");
  assert.equal(f.live()?.user.id, B);
  assert.equal(m.snapshot().user?.id, B);
  assert.equal(m.snapshot().clinicId, WB);
  assert.equal(m.snapshot().isSigningOut, false);
  assert.equal(m.snapshot().signOutFailed, false);
  assert.equal(f.boundary.isSignOutPending(), false);
  assert.deepEqual(f.locations, [], "local A exit completion cannot navigate current B away from /profile");
  assert.equal(f.route(), "/profile");
});

for (const replacement of ["B", "ABA"] as const)
test(`retained A exit callback cannot adopt the current ${replacement} identity`, async t => {
  const f = fixture(t), m = f.mount({ pathname: "/profile" });
  await f.flush();
  assert.equal(m.snapshot().user?.id, A);
  const oldExit = m.snapshot().signOut;
  f.replace(localSession(B)); await f.flush();
  if (replacement === "ABA") { f.replace(localSession(A, "later-login")); await f.flush(); }
  const actor = replacement === "B" ? B : A;
  assert.equal(m.snapshot().user?.id, actor);
  const before = effects(f, m), scopes = f.exitScopes.length, revision = f.boundary.getSignOutRevision();
  await oldExit(); await f.flush();
  assert.deepEqual(effects(f, m), before, "retained public callback cannot clear or navigate a newer identity");
  assert.equal(f.exitScopes.length, scopes, "retained callback must not reach the mutation boundary");
  assert.equal(f.traces.filter(entry => entry.kind === "signOut").length, 0);
  assert.equal(f.boundary.getSignOutRevision(), revision);
  assert.equal(f.boundary.isSignOutPending(), false);
  assert.equal(m.snapshot().clinicId, replacement === "B" ? WB : WA);
});

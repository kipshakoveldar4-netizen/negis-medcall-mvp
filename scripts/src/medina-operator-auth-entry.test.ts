import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Real OperatorPortal JSX and callbacks; synthetic hooks/events/SDK/useAuth,
// closed workday/request boundaries and held profile transport only. No React
// renderer, browser, Auth account creation, mail, environment or network access.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const portalPath = "artifacts/negis/src/pages/OperatorPortal.tsx";
const source = await readFile(path.join(root, portalPath), "utf8");
const sourceHash = createHash("sha256").update(source).digest("hex");

function evaluate(file: string, code: string, imports: Record<string, unknown>, bindings: Record<string, unknown> = {}) {
  const result = ts.transpileModule(code, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  assert.equal(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length ?? 0, 0,
    `Cannot transpile ${file}`);
  const exports: Record<string, any> = {};
  new Script(result.outputText, { filename: file }).runInNewContext({
    exports, AbortController, DOMException, Error, TextEncoder, URL, ...bindings,
    fetch() { assert.fail("Network access is forbidden in this fixture"); },
    require(name: string) {
      assert.ok(Object.hasOwn(imports, name), `Unexpected real dependency: ${name}`);
      return imports[name];
    },
  });
  return exports;
}

const rulesPath = "lib/auth/password-rules.ts";
const loginsPath = "lib/auth/staff-logins.ts";
const contractsPath = "lib/crm/operator-contracts.ts";
const rules = evaluate(rulesPath, await readFile(path.join(root, rulesPath), "utf8"), {});
const logins = evaluate(loginsPath, await readFile(path.join(root, loginsPath), "utf8"), {});
const contracts = evaluate(contractsPath, await readFile(path.join(root, contractsPath), "utf8"), {});

type Props = Record<string, any> & { children?: Child };
type Element = { type: unknown; props: Props; key?: unknown };
type Child = Element | string | number | boolean | null | undefined | Child[];
type Deps = readonly unknown[] | undefined;
type Effect = () => void | (() => void);
type Slot =
  | { kind: "state"; value: unknown; set: (update: unknown) => void }
  | { kind: "ref"; value: { current: unknown } }
  | { kind: "memo"; value: unknown; deps: Deps }
  | { kind: "effect" | "layout"; create: Effect; deps: Deps; pending: boolean; cleanup?: () => void };
const PortalShell = Symbol("closed PortalShell");
const OperatorWorkday = Symbol("closed OperatorWorkday");
const OperatorRequests = Symbol("closed OperatorRequests");
const jsx = (type: unknown, props: Props, key?: unknown): Element => ({ type, props, key });
const actorA = "operator-entry-local-a", actorB = "operator-entry-local-b";
const password = "Local-test-password-42";
const origin = "https://operator-entry.example.test";
const session = (id: string | null) => id ? { user: { id, email: `${id}@example.test` }, access_token: `local:${id}` } : null;
type Session = ReturnType<typeof session>;
type AuthResult = { data: { session: Session; user?: unknown }; error: unknown };
const authResult = (id: string | null = null, error: unknown = null): AuthResult => ({ data: { session: session(id) }, error });
const profile = (id: string) => ({ id, displayName: `Private local profile ${id}`, status: "approved", acceptingRequests: true });

function elements(child: Child): Element[] {
  if (Array.isArray(child)) return child.flatMap(elements);
  if (!child || typeof child !== "object") return [];
  return [child, ...elements(child.props.children), ...elements(child.props.actions)];
}

function content(child: Child): string {
  if (Array.isArray(child)) return child.map(content).join("");
  if (child && typeof child === "object") return content(child.props.children);
  return typeof child === "string" || typeof child === "number" ? String(child) : "";
}

function sameDeps(a: Deps, b: Deps) {
  return a !== undefined && b !== undefined && a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
}

function hookDriver() {
  const slots: Slot[] = [], writes: { index: number; value: unknown; mounted: boolean }[] = [];
  let cursor = 0, mounted = false, rendering = false, dirty = false;
  let component: () => Child, tree: Child, hookCount: number | undefined;
  function slot<K extends Slot["kind"]>(kind: K, create: (index: number) => Extract<Slot, { kind: K }>) {
    assert.ok(rendering, "Hooks must run in the real root render");
    const index = cursor++;
    slots[index] ??= create(index);
    assert.equal(slots[index].kind, kind, "Root hook order changed");
    return slots[index] as Extract<Slot, { kind: K }>;
  }
  function effect(kind: "effect" | "layout", create: Effect, deps: Deps) {
    const current = slot(kind, () => ({ kind, create, deps, pending: true }));
    if (!sameDeps(current.deps, deps)) current.pending = true;
    current.create = create;
    current.deps = deps;
  }
  const hooks = {
    useState<T>(initial: T | (() => T)) {
      const state = slot("state", index => {
        const current: Extract<Slot, { kind: "state" }> = {
          kind: "state", value: typeof initial === "function" ? (initial as () => T)() : initial,
          set(update) {
            const next = typeof update === "function" ? update(current.value) : update;
            writes.push({ index, value: next, mounted });
            if (!Object.is(next, current.value)) { current.value = next; if (mounted) dirty = true; }
          },
        };
        return current;
      });
      return [state.value as T, state.set] as const;
    },
    useRef<T>(initial: T) { return slot("ref", () => ({ kind: "ref", value: { current: initial } })).value; },
    useMemo<T>(create: () => T, deps: Deps) {
      const memo = slot("memo", () => ({ kind: "memo", value: create(), deps }));
      if (!sameDeps(memo.deps, deps)) { memo.value = create(); memo.deps = deps; }
      return memo.value as T;
    },
    useCallback<T>(callback: T, deps: Deps) { return hooks.useMemo(() => callback, deps); },
    useEffect(create: Effect, deps: Deps) { effect("effect", create, deps); },
    useLayoutEffect(create: Effect, deps: Deps) { effect("layout", create, deps); },
  };
  function commit() {
    dirty = false;
    cursor = 0;
    rendering = true;
    try { tree = component(); } finally { rendering = false; }
    hookCount ??= cursor;
    assert.equal(cursor, hookCount, "Conditional hooks are unsupported by this simulation");
    for (const kind of ["layout", "effect"] as const) {
      const pending = slots.filter((item): item is Extract<Slot, { kind: "effect" | "layout" }> =>
        item.kind === kind && item.pending);
      for (const item of pending) item.cleanup?.();
      for (const item of pending) { item.pending = false; item.cleanup = item.create() || undefined; }
    }
  }
  return {
    hooks, writes,
    mount(value: () => Child) { component = value; mounted = true; dirty = true; },
    invalidate() { if (mounted) dirty = true; },
    state(index: number) { const item = slots[index]; assert.equal(item.kind, "state"); return item.value; },
    nodes: () => elements(tree),
    async flush() {
      for (let pass = 0; pass < 60; pass++) { if (mounted && dirty) commit(); await Promise.resolve(); }
      assert.equal(dirty, false, "Root did not quiesce within bounded microtask turns");
    },
    unmount() {
      if (!mounted) return;
      mounted = false; dirty = false;
      for (const item of slots) if (item.kind === "layout" || item.kind === "effect") { item.cleanup?.(); item.cleanup = undefined; }
    },
  };
}

function deferred<T>() {
  let yes!: (value: T) => void, no!: (reason: unknown) => void, settled = false;
  const promise = new Promise<T>((resolve, reject) => { yes = resolve; no = reject; });
  return { promise, get settled() { return settled; },
    resolve(value: T) { if (!settled) { settled = true; yes(value); } },
    reject(error: unknown) { if (!settled) { settled = true; no(error); } },
  };
}

// Observe detached SDK chains so a broken baseline reports the root's missing
// neutral state instead of leaking an unhandled rejection into another test.
function observed<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => {});
  return {
    then(yes: any, no: any) { return observed(promise.then(yes, no)); },
    catch(no: any) { return observed(promise.catch(no)); },
    finally(done: any) { return observed(promise.finally(done)); },
    [Symbol.toStringTag]: "Promise",
  } as Promise<T>;
}

function events() {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  return {
    addEventListener(name: string, callback: (...args: any[]) => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(callback);
    },
    removeEventListener(name: string, callback: (...args: any[]) => void) { listeners.get(name)?.delete(callback); },
    dispatch(name: string) { for (const callback of [...listeners.get(name) ?? []]) callback(); },
    size: () => [...listeners.values()].reduce((sum, entries) => sum + entries.size, 0),
  };
}

type ProfileCall = { path: string; body: unknown; method: string; signal?: AbortSignal; actor?: string;
  isCurrent?: () => boolean; hold: ReturnType<typeof deferred<any>>; claimed: boolean };
type CredentialCall = { kind: "signin" | "signup"; input: Props; passwordAtDispatch: unknown;
  hold: ReturnType<typeof deferred<AuthResult>> };
type Options = { initial?: string | null; holdBootstrap?: boolean; lookupThrows?: boolean;
  eventDuringLookup?: string | null; configured?: boolean };

async function fixture(t: TestContext, options: Options = {}) {
  const driver = hookDriver(), windowEvents = events(), documentEvents = events();
  const bootstrap = deferred<AuthResult>(), calls: CredentialCall[] = [], profiles: ProfileCall[] = [];
  const subscriptions = new Set<(event: string, next: Session) => void>();
  const order: string[] = [], running: Promise<unknown>[] = [];
  const providerCalls: { actor: string | null; args: unknown[]; hold: ReturnType<typeof deferred<void>> }[] = [];
  const fieldSlots: Partial<Record<"email" | "password" | "name", number>> = {};
  let actor = options.initial ?? null, unsubscribed = 0, rawSignOuts = 0, passwordSlot: number | undefined;
  let providerObservation: (() => void) | undefined;
  let isSigningOut = false, signOutFailed = false, useAuthCalls = 0;
  function emit(id: string | null, event = id ? "SIGNED_IN" : "SIGNED_OUT") {
    actor = id;
    for (const callback of [...subscriptions]) callback(event, session(id));
    driver.invalidate();
  }
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
  const window = { ...windowEvents, location: { origin, pathname: "/operator", search: "?next=/not-the-redirect" },
    localStorage: storage, sessionStorage: storage };
  const sdk = {
    getSession() {
      order.push("lookup");
      if (Object.hasOwn(options, "eventDuringLookup")) emit(options.eventDuringLookup ?? null);
      if (options.lookupThrows) throw new Error("Synthetic bootstrap failure: never publish SDK details");
      return observed(bootstrap.promise);
    },
    onAuthStateChange(callback: (event: string, next: Session) => void) {
      order.push("subscribe"); subscriptions.add(callback);
      return { data: { subscription: { unsubscribe() { if (subscriptions.delete(callback)) unsubscribed++; } } } };
    },
    signInWithPassword(input: Props) { return credentials("signin", input); },
    signUp(input: Props) { return credentials("signup", input); },
    signOut() { rawSignOuts++; return Promise.resolve({ error: null }); },
  };
  function credentials(kind: CredentialCall["kind"], input: Props) {
    const hold = deferred<AuthResult>();
    calls.push({ kind, input, hold, passwordAtDispatch: passwordSlot === undefined ? undefined : driver.state(passwordSlot) });
    return observed(hold.promise);
  }
  // Signature/dispatch checks only; held replies have no SDK persistence effects.
  function currentScope(scope: { isCurrent(): boolean; signal?: AbortSignal }) {
    assert.equal(typeof scope?.isCurrent, "function", "sessionAuth requires a caller scope");
    assert.equal(scope.isCurrent(), true, "A retired caller must not dispatch fake auth");
    assert.notEqual(scope.signal?.aborted, true, "An aborted caller must not dispatch fake auth");
  }
  const sessionAuth = {
    onAuthStateChange: sdk.onAuthStateChange,
    signInWithPassword(input: Props, scope: Parameters<typeof currentScope>[0]) {
      currentScope(scope); return sdk.signInWithPassword(input);
    },
    signUp(input: Props, scope: Parameters<typeof currentScope>[0]) {
      currentScope(scope); return sdk.signUp(input);
    },
  };
  const signOut = (...args: unknown[]) => {
    const hold = deferred<void>();
    providerObservation?.();
    providerCalls.push({ actor, args, hold });
    isSigningOut = true;
    driver.invalidate();
    return observed(hold.promise);
  };
  const authSignOutPath = "artifacts/negis/src/lib/authSignOut.ts";
  const authSignOut = evaluate(authSignOutPath, await readFile(path.join(root, authSignOutPath), "utf8"), {}, { window });
  const icons = Object.fromEntries(["ClipboardList", "FileText", "RefreshCw", "Send", "UserRound", "Users", "LogOut"]
    .map(name => [name, Symbol(name)]));
  const portal = evaluate(portalPath, source, {
    react: driver.hooks,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: Symbol("Fragment") },
    wouter: { Link: Symbol("closed Link") },
    "lucide-react": icons,
    "@/components/portals/PortalShell": { PortalShell },
    "@/components/operators/OperatorWorkday": { OperatorWorkday },
    "@/components/operators/OperatorRequests": { OperatorRequests },
    "@/lib/supabase": { supabase: { auth: sdk }, sessionAuth, hasSupabaseFrontendEnv: options.configured !== false },
    "@/contexts/AuthContext": { useAuth() {
      useAuthCalls++;
      return { session: session(actor), user: session(actor)?.user ?? null, isSigningOut, signOutFailed, signOut };
    } },
    "@/lib/authSignOut": authSignOut,
    "@/lib/operatorApi": { operatorApi(endpoint: string, body: unknown, method = "GET", signal?: AbortSignal,
      expectedUserId?: string, isCurrent?: () => boolean) {
      assert.equal(endpoint, "operator-account", "Only the local profile transport boundary is open");
      const hold = deferred<any>();
      profiles.push({ path: endpoint, body, method, signal, actor: expectedUserId, isCurrent, hold, claimed: false });
      // Complete even aborted requests: the root must reject obsolete results.
      return observed(hold.promise);
    } },
    "../../../../lib/crm/operator-contracts": contracts,
    "../../../../lib/auth/password-rules": rules,
    "../../../../lib/auth/staff-logins": logins,
  }, { window, document: { ...documentEvents, visibilityState: "visible" } });
  driver.mount(portal.default);

  function invoke(callback: unknown, event?: unknown) {
    assert.ok(typeof callback === "function", "Expected an actual rendered callback");
    const result = callback(event);
    if (result && typeof result.then === "function") {
      const promise = Promise.resolve(result);
      void promise.catch(() => {});
      running.push(promise);
    }
    return result;
  }
  const nodes = () => driver.nodes();
  function shell() { const node = nodes().find(item => item.type === PortalShell); assert.ok(node); return node.props; }
  function form() { const node = nodes().find(item => item.type === "form"); assert.ok(node, "Expected the actual root form"); return node; }
  function loginForm() {
    const node = nodes().find(item => item.type === "form" && elements(item).some(child => child.props.autoComplete === "username"));
    assert.ok(node, "Bootstrap must settle to the real neutral login form");
    return node;
  }
  function input(kind: "email" | "password" | "name") {
    const node = nodes().find(item => item.type === "input" && (kind === "email" ? item.props.autoComplete === "username"
      : kind === "password" ? item.props.type === "password" : item.props.maxLength === 120));
    assert.ok(node, `Expected ${kind} input`); return node;
  }
  async function change(kind: "email" | "password" | "name", value: string) {
    invoke(input(kind).props.onChange, { target: { value } });
    fieldSlots[kind] = driver.writes.at(-1)!.index;
    if (kind === "password") passwordSlot = driver.writes.at(-1)!.index;
    await driver.flush();
  }
  function take(method: string, expectedActor: string) {
    const call = profiles.find(item => !item.claimed && item.method === method && item.actor === expectedActor);
    assert.ok(call, `Expected synthetic ${method} profile transport for ${expectedActor}`);
    call.claimed = true; return call;
  }
  function child(kind: "work" | "requests" = "work") {
    const node = nodes().find(item => item.type === (kind === "work" ? OperatorWorkday : OperatorRequests));
    assert.ok(node, `Expected closed ${kind} boundary`); return node.props;
  }
  function snapshot() {
    const inputs = nodes().filter(item => item.type === "input");
    return {
      displayName: shell().displayName ?? null,
      privateActors: nodes().filter(item => item.type === OperatorWorkday || item.type === OperatorRequests).map(item => item.props.actorId),
      fields: inputs.map(item => ({ type: item.props.type ?? "text", value: item.props.value, checked: item.props.checked })),
      status: nodes().filter(item => item.props.role === "status").map(content).join("\n"),
      busy: nodes().filter(item => item.type === "button" && item.props.type === "submit").map(item => Boolean(item.props.disabled)),
      forms: nodes().filter(item => item.type === "form").length,
      section: shell().activeId,
    };
  }
  async function mode(value: "signin" | "signup") {
    const tabs = nodes().filter(item => item.type === "button" && item.props.role === "tab");
    assert.equal(tabs.length, 2);
    invoke(tabs[value === "signin" ? 0 : 1].props.onClick);
    await driver.flush();
  }
  async function navigate(id: string) { invoke(shell().onNavigate, id); await driver.flush(); }
  async function approve(id: string) { take("GET", id).hold.resolve(profile(id)); await driver.flush(); }
  function submit(callback = form().props.onSubmit) { return invoke(callback, { preventDefault() {} }); }
  async function complete() {
    driver.unmount();
    const leakedSubscriptions = subscriptions.size;
    subscriptions.clear();
    bootstrap.resolve(authResult());
    for (let pass = 0; pass < 4; pass++) {
      for (const call of calls) call.hold.resolve(authResult());
      for (const call of profiles) call.hold.resolve(null);
      for (const call of providerCalls) call.hold.resolve();
      await driver.flush();
    }
    await Promise.allSettled(running);
    assert.equal(leakedSubscriptions, 0, "Unmount must unsubscribe every owned auth listener");
    assert.equal(windowEvents.size() + documentEvents.size(), 0, "Unmount must remove every owned event listener");
    for (const call of profiles) assert.equal(call.signal?.aborted, true, "Every owned profile request must be aborted on teardown");
    assert.ok(bootstrap.settled && calls.every(call => call.hold.settled) && profiles.every(call => call.hold.settled)
      && providerCalls.every(call => call.hold.settled), "Teardown must settle every held SDK/transport/provider promise");
  }
  t.after(complete);
  await driver.flush();
  if (!options.holdBootstrap && !options.lookupThrows) { bootstrap.resolve(authResult(options.initial ?? null)); await driver.flush(); }
  return {
    driver, calls, profiles, bootstrap, providerCalls, order, emit, take, approve, input, change, form, loginForm, submit, mode, sessionAuth,
    navigate, child, shell, snapshot, flush: driver.flush, unmount: driver.unmount,
    rawSignOuts: () => rawSignOuts, subscriptions: () => subscriptions.size, unsubscribed: () => unsubscribed,
    useAuthCalls: () => useAuthCalls,
    fieldState(kind: "email" | "password" | "name") {
      const index = fieldSlots[kind]; assert.notEqual(index, undefined, `Change ${kind} before observing its state`);
      return driver.state(index!);
    },
    observeProvider(callback: () => void) { providerObservation = callback; },
    async credentials(email = "local.operator", secret = password) { await change("email", email); await change("password", secret); },
  };
}

test("synthetic sessionAuth signature rejects missing, retired and aborted scopes before fake dispatch", async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  for (const scope of [undefined, {}, { isCurrent: () => false }, { isCurrent: () => true, signal: controller.signal }]) {
    for (const method of [f.sessionAuth.signInWithPassword, f.sessionAuth.signUp]) {
      assert.throws(() => method({ email: "synthetic@example.invalid", password }, scope as Parameters<typeof method>[1]));
      assert.equal(f.calls.length, 0, "Invalid facade calls never enter the held SDK double");
    }
  }
});

test("bootstrap subscribes before lookup, including an identity observed synchronously inside lookup", async t => {
  t.diagnostic(`OperatorPortal SHA256 ${sourceHash}; actual root methods/JSX, synthetic hooks/events/SDK/useAuth; no React/browser/server acceptance`);
  const ui = await fixture(t, { holdBootstrap: true, eventDuringLookup: actorB });
  assert.deepEqual(ui.order.slice(0, 2), ["subscribe", "lookup"]);
  await ui.approve(actorB);
  ui.bootstrap.resolve(authResult(actorA)); await ui.flush();
  assert.deepEqual(ui.snapshot().privateActors, [actorB]);
  assert.equal(ui.profiles.length, 1, "An initial snapshot cannot overwrite the observed identity");
});

for (const outcome of ["returned-error", "rejection", "synchronous-throw"] as const) {
  test(`bootstrap ${outcome} settles to neutral login without publishing a session or SDK details`, async t => {
    const ui = await fixture(t, { holdBootstrap: true, lookupThrows: outcome === "synchronous-throw" });
    if (outcome === "returned-error") ui.bootstrap.resolve(authResult(actorA, new Error("Synthetic private SDK detail")));
    if (outcome === "rejection") ui.bootstrap.reject(new Error("Synthetic private SDK detail"));
    await ui.flush();
    ui.loginForm();
    assert.equal(ui.profiles.length, 0);
    assert.equal(ui.snapshot().displayName, null);
    assert.ok(!ui.snapshot().status.includes("Synthetic"), "SDK details must not be rendered");
    assert.ok(!ui.snapshot().status.includes("\u041f\u0440\u043e\u0432\u0435\u0440\u044f\u0435\u043c \u0432\u0445\u043e\u0434"), "Bootstrap cannot remain pending after failure");
  });
}

for (const observedActor of [actorB, null]) {
  test(`late initial session cannot overwrite an observed ${observedActor ?? "signed-out"} identity`, async t => {
    const ui = await fixture(t, { holdBootstrap: true });
    ui.emit(observedActor); await ui.flush();
    if (observedActor) await ui.approve(observedActor); else ui.loginForm();
    const before = ui.snapshot(), reads = ui.profiles.length, writes = ui.driver.writes.length;
    ui.bootstrap.resolve(authResult(actorA)); await ui.flush();
    assert.deepEqual(ui.snapshot(), before);
    assert.equal(ui.profiles.length, reads);
    assert.equal(ui.driver.writes.length, writes, "Obsolete bootstrap must not even attempt state writes");
  });
}

for (const outcome of ["returned-error", "rejection"] as const) {
  test(`late bootstrap ${outcome} cannot close an already observed approved actor`, async t => {
    const ui = await fixture(t, { holdBootstrap: true });
    ui.emit(actorB); await ui.flush(); await ui.approve(actorB);
    const before = ui.snapshot(), writes = ui.driver.writes.length;
    if (outcome === "rejection") ui.bootstrap.reject(new Error("Obsolete local bootstrap refusal"));
    else ui.bootstrap.resolve(authResult(actorA, new Error("Obsolete local bootstrap refusal")));
    await ui.flush();
    assert.deepEqual(ui.snapshot(), before);
    assert.equal(ui.driver.writes.length, writes);
  });
}
test("unmounted bootstrap unsubscribes; a late result cannot write or request a profile", async t => {
  const ui = await fixture(t, { holdBootstrap: true });
  assert.equal(ui.subscriptions(), 1);
  ui.unmount(); const writes = ui.driver.writes.length;
  ui.bootstrap.resolve(authResult(actorA)); await ui.flush();
  assert.equal(ui.driver.writes.length, writes);
  assert.equal(ui.profiles.length, 0);
  assert.equal(ui.unsubscribed(), 1);
});

for (const boundary of ["work", "requests"] as const) {
  test(`${boundary} actor ABA retires the old callback synchronously, before another render`, async t => {
    const ui = await fixture(t, { initial: actorA }); await ui.approve(actorA);
    if (boundary === "requests") await ui.navigate("cooperations");
    const old = ui.child(boundary);
    assert.equal(old.isSessionCurrent(), true);
    ui.emit(actorB); ui.emit(actorA);
    assert.equal(old.isSessionCurrent(), false, "The same actor ID must not revive an old auth lifetime");
    await ui.flush();
    assert.deepEqual(ui.snapshot().privateActors, []);
    await ui.approve(actorA);
    if (boundary === "requests") await ui.navigate("cooperations");
    assert.equal(old.isSessionCurrent(), false);
    assert.equal(ui.child(boundary).isSessionCurrent(), true);
  });
}

test("token refresh preserves the current child lifetime; a new same-ID sign-in and unmount retire it", async t => {
  const ui = await fixture(t, { initial: actorA }); await ui.approve(actorA);
  const old = ui.child();
  ui.emit(actorA, "TOKEN_REFRESHED"); await ui.flush();
  assert.equal(old.isSessionCurrent(), true, "Refreshing credentials is not a different actor lifetime");
  assert.equal(ui.profiles.length, 1);
  ui.emit(actorA, "SIGNED_IN");
  assert.equal(old.isSessionCurrent(), false, "A new sign-in cannot revive prior same-ID callbacks");
  await ui.flush(); await ui.approve(actorA);
  const current = ui.child();
  assert.equal(current.isSessionCurrent(), true);
  ui.unmount();
  assert.equal(current.isSessionCurrent(), false);
});

for (const mode of ["signin", "signup"] as const) {
  test(`${mode} duplicate same-turn submit dispatches once while React busy state is still stale`, async t => {
    const ui = await fixture(t);
    if (mode === "signup") await ui.mode(mode);
    await ui.credentials(mode === "signup" ? "local.operator@example.test" : "local.operator");
    const callback = ui.loginForm().props.onSubmit;
    ui.submit(callback); ui.submit(callback);
    assert.equal(ui.calls.length, 1, "A synchronous ref must claim the attempt before SDK dispatch");
    assert.equal(ui.calls[0].kind, mode);
  });

  test(`${mode} clears the password state before entering the held SDK, preserving only the dispatched snapshot`, async t => {
    const ui = await fixture(t);
    if (mode === "signup") await ui.mode(mode);
    await ui.credentials(mode === "signup" ? "local.operator@example.test" : "local.operator");
    ui.submit();
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.calls[0].passwordAtDispatch, "", "Password clear must precede SDK entry, not its await/finally");
    assert.equal(ui.calls[0].input.password, password);
    assert.equal(ui.calls[0].hold.settled, false);
    await ui.flush();
    assert.equal(ui.input("password").props.value, "");
    assert.deepEqual(ui.snapshot().busy, [true]);
  });
}

test("signin retains real login/email normalization and does not add signup password rules", async t => {
  const ui = await fixture(t); await ui.credentials(" Local-Operator ", "short"); ui.submit();
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].input.email, logins.loginOrEmailToAuthEmail(" Local-Operator "));
  assert.equal(ui.calls[0].input.password, "short");
  assert.equal(ui.calls[0].kind, "signin");
});

test("signup keeps normalized personal email and the literal same-origin /operator redirect", async t => {
  const ui = await fixture(t); await ui.mode("signup"); await ui.credentials(" Local.Operator@Example.Test "); ui.submit();
  assert.equal(ui.calls.length, 1);
  const call = ui.calls[0];
  assert.equal(call.kind, "signup");
  assert.equal(call.input.email, "local.operator@example.test");
  assert.equal(call.input.options.emailRedirectTo, `${origin}/operator`);
  call.hold.resolve(authResult()); await ui.flush();
  assert.ok(ui.snapshot().status, "Signup without a session must retain its confirmation message");
  assert.deepEqual(ui.snapshot().busy, [false]);
});

test("mode switching preserves input semantics and clears the prior password", async t => {
  const ui = await fixture(t); await ui.credentials();
  assert.equal(ui.input("email").props.type, "text");
  assert.equal(ui.input("password").props.autoComplete, "current-password");
  await ui.mode("signup");
  assert.equal(ui.input("email").props.type, "email");
  assert.equal(ui.input("email").props.required, true);
  assert.equal(ui.input("password").props.autoComplete, "new-password");
  assert.equal(ui.input("password").props.required, true);
  assert.equal(ui.input("password").props.value, "");
  await ui.change("password", "New-mode-password-42"); await ui.mode("signin");
  assert.equal(ui.input("password").props.value, "");
  assert.equal(ui.input("password").props.autoComplete, "current-password");
  assert.equal(ui.calls.length, 0);
});

for (const email of ["local.operator", "local.operator@staff.negis.online", "LOCAL.OPERATOR@STAFF.NEGIS.LOCAL"]) {
  test(`signup rejects nonpersonal identity ${email} before SDK dispatch`, async t => {
    const ui = await fixture(t); await ui.mode("signup"); await ui.credentials(email); ui.submit(); await ui.flush();
    assert.equal(ui.calls.length, 0);
    assert.ok(ui.snapshot().status);
    assert.deepEqual(ui.snapshot().busy, [false]);
  });
}

for (const secret of ["short", " leading-space", "trailing-space ", "x".repeat(73), "        "]) {
  test(`signup preserves shared password validation for ${JSON.stringify(secret)}`, async t => {
    const ui = await fixture(t); await ui.mode("signup"); await ui.credentials("local.operator@example.test", secret);
    const expected = rules.validatePasswordRules(secret);
    assert.ok(expected.length > 0);
    ui.submit(); await ui.flush();
    assert.equal(ui.calls.length, 0);
    assert.equal(ui.snapshot().status, expected[0]);
    assert.deepEqual(ui.snapshot().busy, [false]);
  });
}

test("missing frontend configuration keeps SDK auth closed and gives a neutral message", async t => {
  const ui = await fixture(t, { configured: false }); await ui.credentials(); ui.submit(); await ui.flush();
  assert.equal(ui.calls.length, 0);
  assert.ok(ui.snapshot().status);
});

for (const transition of ["login", "actor-ABA", "mode-ABA", "unmount"] as const) {
  test(`a retained authenticate callback after ${transition} cannot dispatch or write`, async t => {
    const ui = await fixture(t); await ui.credentials();
    const oldSubmit = ui.loginForm().props.onSubmit;
    if (transition === "login" || transition === "actor-ABA") {
      ui.emit(actorA);
      if (transition === "actor-ABA") { ui.emit(actorB); ui.emit(actorA); }
      await ui.flush(); await ui.approve(actorA);
    } else if (transition === "mode-ABA") {
      await ui.mode("signup"); await ui.mode("signin");
      await ui.credentials("new.local.operator", "New-local-password-42");
    } else ui.unmount();
    const writes = ui.driver.writes.length;
    ui.submit(oldSubmit); await ui.flush();
    assert.equal(ui.calls.length, 0, "A callback belongs to its rendered auth/mode lifetime");
    assert.equal(ui.driver.writes.length, writes, "Retired callbacks must be inert before clearing messages or secrets");
  });
}

for (const transition of ["actor-B", "actor-ABA", "unmount"] as const) {
  for (const outcome of ["success-with-session", "success-without-session", "returned-error", "rejection"] as const) {
    test(`late authenticate ${outcome} after ${transition} cannot publish, clear a form or release another lifetime`, async t => {
      const ui = await fixture(t); await ui.credentials(); ui.submit(); await ui.flush();
      assert.equal(ui.calls.length, 1);
      const old = ui.calls[0];
      if (transition === "unmount") ui.unmount();
      else {
        ui.emit(actorA);
        ui.emit(actorB);
        if (transition === "actor-ABA") ui.emit(actorA);
        await ui.flush(); await ui.approve(transition === "actor-B" ? actorB : actorA);
      }
      const before = ui.snapshot(), writes = ui.driver.writes.length;
      if (outcome === "rejection") old.hold.reject(new Error("Synthetic obsolete credential detail"));
      else old.hold.resolve(authResult(outcome === "success-with-session" ? actorA : null,
        outcome === "returned-error" ? new Error("Synthetic obsolete credential detail") : null));
      await ui.flush();
      assert.deepEqual(ui.snapshot(), before);
      assert.equal(ui.driver.writes.length, writes, "Old success/catch/finally must not attempt any state write");
    });
  }
}

for (const outcome of ["success-with-session", "success-without-session", "returned-error", "rejection"] as const) {
  test(`held auth ${outcome} refuses mode ABA and replacement credentials; only a fresh settled form can retry`, async t => {
    const ui = await fixture(t); await ui.credentials(); ui.submit(); await ui.flush();
    const old = ui.calls[0], oldSubmit = ui.loginForm().props.onSubmit;
    const before = ui.snapshot(), writes = ui.driver.writes.length;
    await ui.mode("signup"); await ui.mode("signin"); await ui.credentials("new.operator", "New-local-password-42");
    ui.submit(); await ui.flush();
    assert.equal(ui.calls.length, 1, "Mode changes cannot start overlapping SDK operations");
    assert.deepEqual(ui.snapshot(), before);
    assert.equal(ui.driver.writes.length, writes, "Retained input and mode callbacks must be inert while pending");
    assert.equal(ui.input("password").props.value, "");
    if (outcome === "rejection") old.hold.reject(new Error("Synthetic retired mode failure"));
    else old.hold.resolve(authResult(outcome === "success-with-session" ? actorA : null,
      outcome === "returned-error" ? new Error("Synthetic retired mode failure") : null));
    await ui.flush();
    assert.deepEqual(ui.snapshot().busy, [false]);
    const settledWrites = ui.driver.writes.length;
    ui.submit(oldSubmit); await ui.flush();
    assert.equal(ui.calls.length, 1, "A saved callback cannot replay the old credentials after settlement");
    assert.equal(ui.driver.writes.length, settledWrites);
    await ui.credentials("new.operator", "New-local-password-42"); ui.submit(); await ui.flush();
    assert.equal(ui.calls.length, 2, "A new explicit submit is allowed only after settlement");
    const current = ui.calls[1];
    assert.deepEqual(ui.snapshot().busy, [true]);
    current.hold.resolve(authResult(null, new Error("Current refusal"))); await ui.flush();
    assert.deepEqual(ui.snapshot().busy, [false]);
    assert.ok(ui.snapshot().status);
  });
}

test("a current SDK rejection is neutral, clears busy, and permits an explicit fresh submit", async t => {
  const ui = await fixture(t); await ui.credentials(); ui.submit();
  ui.calls[0].hold.reject(new Error("Synthetic SDK error containing private detail")); await ui.flush();
  assert.deepEqual(ui.snapshot().busy, [false]);
  assert.ok(ui.snapshot().status && !ui.snapshot().status.includes("Synthetic"));
  await ui.credentials("retry.operator"); ui.submit();
  assert.equal(ui.calls.length, 2);
});

for (const boundary of ["work", "requests"] as const) {
  test(`shell signout delegates to useAuth and retires the ${boundary} boundary before provider dispatch`, async t => {
    const ui = await fixture(t, { initial: actorA }); await ui.approve(actorA);
    if (boundary === "requests") await ui.navigate("cooperations");
    const old = ui.child(boundary), signOut = ui.shell().onSignOut;
    ui.observeProvider(() => assert.equal(old.isSessionCurrent(), false, "Retire the private child before entering provider signOut"));
    signOut();
    assert.equal(ui.rawSignOuts(), 0, "The root must not call raw SDK signOut");
    assert.equal(ui.providerCalls.length, 1);
    assert.ok(ui.useAuthCalls() > 0);
    assert.equal(old.isSessionCurrent(), false);
    await ui.flush();
    assert.equal(ui.snapshot().displayName, null);
    assert.deepEqual(ui.snapshot().privateActors, []);
    assert.equal(ui.providerCalls[0].hold.settled, false, "Privacy closure cannot wait for provider completion");
  });
}

for (const method of ["GET", "POST", "PATCH"] as const) {
  test(`provider-delegated signout aborts held profile ${method} before dispatch and clears private forms`, async t => {
    const ui = await fixture(t);
    await ui.credentials("private.operator@example.test");
    ui.emit(actorA); await ui.flush();
    let held: ProfileCall;
    if (method === "GET") held = ui.take("GET", actorA);
    else if (method === "POST") {
      ui.take("GET", actorA).hold.resolve(null); await ui.flush();
      await ui.change("name", "Private operator form name"); ui.submit();
      held = ui.take("POST", actorA);
    } else {
      await ui.approve(actorA); await ui.navigate("profile");
      const checkbox = ui.driver.nodes().find(item => item.type === "input" && item.props.type === "checkbox");
      assert.ok(checkbox); checkbox.props.onChange({ target: { checked: false } });
      held = ui.take("PATCH", actorA);
    }
    assert.equal(held.signal?.aborted, false);
    ui.observeProvider(() => assert.equal(held.signal?.aborted, true, "Abort profile transport before provider signOut"));
    ui.shell().onSignOut();
    assert.equal(ui.rawSignOuts(), 0);
    assert.equal(ui.providerCalls.length, 1);
    assert.equal(held.signal?.aborted, true);
    assert.equal(held.isCurrent?.(), false);
    await ui.flush();
    assert.equal(ui.snapshot().displayName, null);
    assert.deepEqual(ui.snapshot().privateActors, []);
    assert.ok(!JSON.stringify(ui.snapshot()).includes("private.operator"));
    assert.ok(!JSON.stringify(ui.snapshot()).includes("Private operator form name"));
    assert.equal(ui.fieldState("email"), "");
    assert.equal(ui.fieldState("password"), "");
    if (method === "POST") assert.equal(ui.fieldState("name"), "");
    const writes = ui.driver.writes.length;
    held.hold.resolve(profile(actorA)); await ui.flush();
    assert.equal(ui.snapshot().displayName, null);
    assert.deepEqual(ui.snapshot().privateActors, []);
    assert.equal(ui.driver.writes.length, writes, "An already completing profile result cannot publish after signout");
  });
}

for (const transition of ["actor-B", "actor-ABA", "same-ID-login", "unmount"] as const) {
  test(`retained shell signout after ${transition} cannot sign out the replacement account or write`, async t => {
    const ui = await fixture(t, { initial: actorA }); await ui.approve(actorA);
    const oldSignOut = ui.shell().onSignOut;
    assert.equal(typeof oldSignOut, "function");
    if (transition === "unmount") ui.unmount();
    else if (transition === "same-ID-login") ui.emit(actorA, "SIGNED_IN");
    else { ui.emit(actorB); if (transition === "actor-ABA") ui.emit(actorA); }
    // Deliberately invoke before rendering the new identity.
    const writes = ui.driver.writes.length;
    oldSignOut();
    assert.equal(ui.providerCalls.length, 0);
    assert.equal(ui.rawSignOuts(), 0);
    assert.equal(ui.driver.writes.length, writes);
  });
}

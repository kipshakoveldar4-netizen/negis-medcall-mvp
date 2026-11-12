import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const pageFile = "artifacts/negis/src/pages/ContributorPortal.tsx";
const origin = "https://contributor-auth.example.invalid";
const actorA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const actorB = "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb";
const profileId = "cccccccc-cccc-4ccc-accc-cccccccccccc";
const revision = "dddddddd-dddd-4ddd-bddd-dddddddddddd";
const privateName = "Synthetic Private Contributor";
const rawDiagnostic = "PRIVATE_PROVIDER_DIAGNOSTIC synthetic-account-exists internal-stack";
const password = "synthetic-password-only";

async function compile(file: string) {
  const result = ts.transpileModule(await readFile(path.join(root, file), "utf8"), {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  assert.deepEqual(result.diagnostics ?? [], [], `Actual ${file} must transpile`);
  return result.outputText;
}
const pageCode = await compile(pageFile);
const passwordCode = await compile("lib/auth/password-rules.ts");
const loginsCode = await compile("lib/auth/staff-logins.ts");
const contractsCode = await compile("lib/crm/contributor-contracts.ts");

type Props = Record<string, any>;
type Element = { type: string | ((props: Props) => Child); props: Props; key?: string | number };
type Child = Element | string | number | boolean | null | undefined | Child[];
const jsx = (type: Element["type"], props: Props, key?: string | number): Element => ({ type, props, key });
function elements(value: Child): Element[] {
  return Array.isArray(value) ? value.flatMap(elements)
    : value && typeof value === "object" ? [value, ...elements(value.props.children)] : [];
}
function textContent(value: Child): string {
  return Array.isArray(value) ? value.map(textContent).join(" ")
    : value && typeof value === "object" ? textContent(value.props.children)
    : typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void, settled = false;
  const promise = new Promise<T>((yes, no) => {
    resolve = value => { if (!settled) { settled = true; yes(value); } };
    reject = error => { if (!settled) { settled = true; no(error); } };
  });
  return { promise, resolve, reject, settled: () => settled };
}

type Effect = () => void | (() => void);
type Slot = { kind: "state" | "ref" | "layout" | "effect" | "memo"; value?: any; set?: (value: any) => void;
  create?: Effect; deps?: readonly unknown[]; pending?: boolean; cleanup?: () => void };
type Instance = { name: string; props: Props; slots: Slot[]; cursor: number; disposed: boolean; hookCount?: number };
function hookRenderer() {
  const instances = new Map<string, Instance>(), history: Instance[] = [], identities = new Map<Function, number>();
  let current: Instance, component: () => Child, tree: Child, mounted = true, dirty = true, writes = 0, lateWrites = 0;
  const changed = (before?: readonly unknown[], after?: readonly unknown[]) =>
    !before || !after || before.length !== after.length || after.some((v, i) => !Object.is(v, before[i]));
  function slot(kind: Slot["kind"], create: () => Slot) {
    const index = current.cursor++;
    current.slots[index] ??= create();
    assert.equal(current.slots[index].kind, kind, "Actual components must preserve hook order");
    return current.slots[index];
  }
  function effect(kind: "layout" | "effect", create: Effect, deps?: readonly unknown[]) {
    const entry = slot(kind, () => ({ kind, pending: true }));
    if (changed(entry.deps, deps)) entry.pending = true;
    entry.create = create; entry.deps = deps;
  }
  const hooks = {
    useState<T>(initial: T | (() => T)) {
      const owner = current;
      const entry = slot("state", () => {
        const state: Slot = { kind: "state", value: typeof initial === "function" ? (initial as () => T)() : initial };
        state.set = update => {
          writes++;
          if (owner.disposed) { lateWrites++; return; }
          const next = typeof update === "function" ? update(state.value) : update;
          if (!Object.is(next, state.value)) { state.value = next; dirty = true; }
        };
        return state;
      });
      return [entry.value as T, entry.set!] as const;
    },
    useRef<T>(initial: T): { current: T } { return slot("ref", () => ({ kind: "ref", value: { current: initial } })).value; },
    useLayoutEffect(create: Effect, deps?: readonly unknown[]) { effect("layout", create, deps); },
    useEffect(create: Effect, deps?: readonly unknown[]) { effect("effect", create, deps); },
    useMemo<T>(create: () => T, deps?: readonly unknown[]): T {
      const entry = slot("memo", () => ({ kind: "memo" }));
      if (changed(entry.deps, deps)) entry.value = create();
      entry.deps = deps; return entry.value;
    },
    useCallback<T>(callback: T, deps?: readonly unknown[]): T { return hooks.useMemo(() => callback, deps); },
  };
  function dispose(instance: Instance) {
    instance.disposed = true;
    for (const entry of instance.slots) { entry.cleanup?.(); entry.cleanup = undefined; }
  }
  function render(value: Child, address: string, seen: Set<string>): Child {
    if (Array.isArray(value)) return value.map((v, index) => render(v,
      `${address}/${v && typeof v === "object" && !Array.isArray(v) && v.key != null ? "key:" + v.key : index}`, seen));
    if (!value || typeof value !== "object") return value;
    if (typeof value.type !== "function") return { ...value, props: { ...value.props,
      children: render(value.props.children, `${address}/${value.type}:${value.key ?? ""}/children`, seen) } };
    if (!identities.has(value.type)) identities.set(value.type, identities.size + 1);
    const id = `${address}/${identities.get(value.type)}:${value.key ?? ""}`;
    seen.add(id);
    let instance = instances.get(id);
    if (!instance) {
      instance = { name: value.type.name, props: value.props, slots: [], cursor: 0, disposed: false };
      instances.set(id, instance); history.push(instance);
    }
    current = instance; instance.cursor = 0; instance.props = value.props;
    const result = value.type(value.props);
    instance.hookCount ??= instance.cursor;
    assert.equal(instance.cursor, instance.hookCount, "No conditional hooks in actual components");
    return render(result, `${id}/out`, seen);
  }
  return {
    hooks, history,
    mount(value: () => Child) { component = value; },
    rerender() { if (mounted) dirty = true; },
    async flush() {
      // All transports are held promises. A fixed microtask budget detects render loops without timers.
      for (let pass = 0; pass < 80; pass++) {
        if (mounted && dirty) {
          dirty = false;
          const seen = new Set<string>();
          tree = render(jsx(component, {}), "root", seen);
          for (const [id, instance] of instances) if (!seen.has(id)) { dispose(instance); instances.delete(id); }
          for (const kind of ["layout", "effect"] as const) {
            const effects = [...instances.values()].flatMap(i => i.slots).filter(s => s.kind === kind && s.pending);
            for (const entry of effects) entry.cleanup?.();
            for (const entry of effects) { entry.pending = false; entry.cleanup = entry.create!() || undefined; }
          }
        }
        await Promise.resolve();
      }
      assert.equal(dirty, false, "Actual portal must settle within the bounded hook harness");
    },
    nodes: () => elements(tree), text: () => textContent(tree), writes: () => writes, lateWrites: () => lateWrites,
    dispose() {
      if (!mounted) return;
      mounted = false; dirty = false;
      for (const instance of instances.values()) dispose(instance);
      instances.clear(); tree = null;
    },
  };
}

const session = (id: string | null) => id ? { user: { id, email: "synthetic@example.invalid" } } : null;
type Session = ReturnType<typeof session>;
type SessionReply = { data: { session: Session }; error?: unknown };
type AuthReply = SessionReply & { data: { session: Session; user?: unknown } };
const authReply = (id: string | null = null): AuthReply => ({ data: { session: session(id) }, error: null });
const profile = (displayName = privateName) => ({ id: profileId, revision, displayName,
  portfolioUrls: [], partnerStatus: "approved", creatorStatus: "approved" });
type AuthCall = { kind: "signin" | "signup"; body: Props; gate: ReturnType<typeof deferred<AuthReply>> };
type ProfileCall = { route: string; body: unknown; method: string; signal: AbortSignal; actorId: string;
  isCurrent(): boolean; gate: ReturnType<typeof deferred<unknown>> };
type ChildMount = { kind: string; props: Props; active: boolean; unmounts: number };

function fixture(t: TestContext, config: { configured?: boolean; initialEvent?: string | null } = {}) {
  const renderer = hookRenderer(), trace: string[] = [], authCalls: AuthCall[] = [], profileCalls: ProfileCall[] = [];
  const providerCalls: { actorId: string | null; gate: ReturnType<typeof deferred<void>> }[] = [];
  const listeners = new Set<(event: string, value: Session) => void>(), mounts: ChildMount[] = [];
  const authCallbacks: ((event: string, value: Session) => void)[] = [];
  const domListeners = { window: new Map<string, Set<Function>>(), document: new Map<string, Set<Function>>() };
  const bootstrap = deferred<SessionReply>();
  let shell: Props = {}, unsubscribeCount = 0, rawSignOuts = 0, prevented = 0;
  let context: Props = { user: null, session: null, isLoading: false, isDemoMode: false,
    isSigningOut: false, isImpersonation: false, profile: null };
  // The provider double deliberately neither calls the SDK nor emits an auth event.
  // The root must retire private UI before this independently held boundary completes.
  const providerSignOut = () => {
    trace.push("provider.signOut");
    const gate = deferred<void>(); providerCalls.push({ actorId: context.user?.id ?? null, gate }); return gate.promise;
  };
  context.signOut = providerSignOut;
  const forbidden = new Proxy({}, { get() { assert.fail("Storage, console, and real SDK access are forbidden"); } });
  const events = (target: keyof typeof domListeners) => ({
    addEventListener(name: string, callback: Function) {
      const callbacks = domListeners[target].get(name) ?? new Set<Function>();
      callbacks.add(callback); domListeners[target].set(name, callbacks);
    },
    removeEventListener(name: string, callback: Function) { domListeners[target].get(name)?.delete(callback); },
  });
  const window = { location: { origin, pathname: "/contributors", search: "?next=https://untrusted.example.invalid/#ignored" },
    localStorage: forbidden, sessionStorage: forbidden, ...events("window") };
  const document = { visibilityState: "visible", ...events("document") };
  function evaluate(code: string, file: string, imports: Record<string, unknown> = {}) {
    const exports: Props = {};
    new Script(code, { filename: file }).runInNewContext({
      exports, module: { exports }, URL, URLSearchParams, TextEncoder, DOMException, AbortController, Error, Promise,
      window, document, console: forbidden,
      fetch() { assert.fail("No real network request is permitted"); },
      require(name: string) { assert.ok(Object.hasOwn(imports, name), `Unexpected import in ${file}: ${name}`); return imports[name]; },
    }, { timeout: 1_000 });
    return exports;
  }
  const sdk = {
    onAuthStateChange(callback: (event: string, value: Session) => void) {
      trace.push("subscribe"); listeners.add(callback); authCallbacks.push(callback);
      if (Object.hasOwn(config, "initialEvent")) callback("INITIAL_SESSION", session(config.initialEvent ?? null));
      return { data: { subscription: { unsubscribe() { unsubscribeCount++; listeners.delete(callback); } } } };
    },
    getSession() { trace.push("getSession"); return bootstrap.promise; },
    signInWithPassword(body: Props) {
      trace.push("sdk.signin"); const gate = deferred<AuthReply>(); authCalls.push({ kind: "signin", body, gate }); return gate.promise;
    },
    signUp(body: Props) {
      trace.push("sdk.signup"); const gate = deferred<AuthReply>(); authCalls.push({ kind: "signup", body, gate }); return gate.promise;
    },
    async signOut() { rawSignOuts++; trace.push("sdk.signOut"); return { error: null }; },
  };
  const auth = new Proxy(sdk, { get(target, key) {
    assert.ok(Object.hasOwn(target, key), `Only explicit Auth SDK doubles are allowed: ${String(key)}`);
    return Reflect.get(target, key);
  } });
  // Signature/dispatch checks only. Held replies do not emulate SDK persistence.
  function currentScope(scope: { isCurrent(): boolean; signal?: AbortSignal }) {
    assert.equal(typeof scope?.isCurrent, "function", "sessionAuth requires a caller scope");
    assert.equal(scope.isCurrent(), true, "A retired caller must not dispatch fake auth");
    assert.notEqual(scope.signal?.aborted, true, "An aborted caller must not dispatch fake auth");
  }
  const sessionAuth = {
    onAuthStateChange: sdk.onAuthStateChange,
    signInWithPassword(body: Props, scope: Parameters<typeof currentScope>[0]) {
      currentScope(scope); return sdk.signInWithPassword(body);
    },
    signUp(body: Props, scope: Parameters<typeof currentScope>[0]) {
      currentScope(scope); return sdk.signUp(body);
    },
  };
  const childDouble = (kind: string) => function ClosedPrivateChild(props: Props) {
    const record = renderer.hooks.useRef<ChildMount | null>(null);
    if (!record.current) { record.current = { kind, props, active: false, unmounts: 0 }; mounts.push(record.current); }
    const entry = record.current; entry.props = props;
    renderer.hooks.useEffect(() => { entry.active = true; return () => { entry.active = false; entry.unmounts++; }; }, []);
    return jsx("section", { "data-closed-private-child": kind });
  };
  const icon = () => null;
  const page = evaluate(pageCode, pageFile, {
    react: renderer.hooks, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    wouter: { Link: (props: Props) => jsx("a", props) },
    "lucide-react": { ArrowRight: icon, ClipboardList: icon, ExternalLink: icon, FileText: icon, Home: icon,
      Image: icon, RefreshCw: icon, Send: icon, UserRound: icon, Users: icon, Video: icon },
    "@/components/portals/PortalShell": { PortalShell: (props: Props) => { shell = props; return jsx("main", { children: props.children }); } },
    "@/contexts/AuthContext": { useAuth: () => context },
    "@/lib/supabase": { hasSupabaseFrontendEnv: config.configured !== false, supabase: { auth }, sessionAuth },
    "@/lib/operatorApi": { operatorApi(route: string, body: unknown, method: string, signal: AbortSignal,
      actorId: string, isCurrent: () => boolean) {
      assert.equal(route, "contributor-account", "Closed child stubs must not dispatch private child requests");
      const gate = deferred<unknown>(); profileCalls.push({ route, body, method, signal, actorId, isCurrent, gate }); return gate.promise;
    } },
    "../../../../lib/auth/password-rules": evaluate(passwordCode, "password-rules"),
    "../../../../lib/auth/staff-logins": evaluate(loginsCode, "staff-logins"),
    "../../../../lib/crm/contributor-contracts": evaluate(contractsCode, "contributor-contracts"),
    "@/components/contributors/PartnerLedger": { PartnerLedger: childDouble("ledger") },
    "@/components/contributors/PartnerHistory": { PartnerHistory: childDouble("history") },
    "@/components/contributors/PartnerLink": { PartnerLink: childDouble("link") },
    "@/components/contributors/PartnerTerms": { PartnerTerms: childDouble("terms") },
    "@/components/contributors/CreatorJobs": { CreatorJobs: childDouble("jobs") },
  });
  renderer.mount(page.default);
  t.after(async () => {
    renderer.dispose();
    bootstrap.resolve({ data: { session: null }, error: null });
    for (const call of authCalls) call.gate.resolve(authReply());
    for (const call of profileCalls) call.gate.resolve(null);
    for (const call of providerCalls) call.gate.resolve();
    await renderer.flush();
    assert.equal(listeners.size, 0, "Auth subscriptions must close on unmount");
    assert.equal(unsubscribeCount, 1, "The portal owns exactly one Auth SDK subscription");
    assert.equal(renderer.lateWrites(), 0, "No state setter may run after its component is retired");
    assert.ok(mounts.every(m => !m.active), "All private child stubs must unmount");
    assert.ok(Object.values(domListeners).every(target => [...target.values()].every(set => set.size === 0)),
      "Profile focus/visibility listeners must close");
  });
  function emit(id: string | null, event = id ? "SIGNED_IN" : "SIGNED_OUT") {
    context = { ...context, user: session(id)?.user ?? null, session: session(id) };
    for (const callback of [...listeners]) callback(event, session(id));
    renderer.rerender();
  }
  function input(type: string) {
    const node = renderer.nodes().find(n => n.type === "input" && n.props.type === type);
    assert.ok(node, `Expected rendered ${type} input`); return node;
  }
  function form() {
    const node = renderer.nodes().find(n => n.type === "form"); assert.ok(node, "Expected rendered login form"); return node;
  }
  function mode(value: "signin" | "signup") {
    const button = renderer.nodes().find(n => n.type === "button" && textContent(n.props.children) ===
      (value === "signin" ? "\u0412\u0445\u043e\u0434" : "\u0420\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u044f"));
    assert.ok(button, `Expected existing ${value} mode button`); return button;
  }
  return {
    ...renderer, bootstrap, trace, authCalls, profileCalls, providerCalls, mounts, authCallbacks, input, form, mode, emit, sessionAuth,
    shell: () => shell, rawSignOuts: () => rawSignOuts, prevented: () => prevented,
    authPatch(patch: Props) { context = { ...context, ...patch }; renderer.rerender(); },
    submit(handler = form().props.onSubmit) { return handler({ preventDefault() { prevented++; } }); },
    async ready(id: string | null) {
      context = { ...context, user: session(id)?.user ?? null, session: session(id) };
      await renderer.flush(); bootstrap.resolve({ data: { session: session(id) }, error: null }); await renderer.flush();
    },
    async fill(email = "  Synthetic.Person@Example.Invalid  ", secret = password) {
      input("email").props.onChange({ target: { value: email } });
      input("password").props.onChange({ target: { value: secret } }); await renderer.flush();
    },
    async signup() { mode("signup").props.onClick(); await renderer.flush(); },
    app() {
      const instance = renderer.history.filter(i => i.name === "Application" && !i.disposed).at(-1);
      assert.ok(instance, "Expected the actual private Application component"); return instance;
    },
    async loadProfile(name = privateName) {
      const request = profileCalls.at(-1); assert.ok(request); request.gate.resolve(profile(name)); await renderer.flush();
    },
    statuses() { return renderer.nodes().filter(n => n.props.role === "status").map(n => textContent(n.props.children)); },
    assertNoPrivate(reason = "Private Application must remain unmounted") {
      assert.equal(renderer.history.some(i => i.name === "Application" && !i.disposed), false, reason);
      assert.ok(mounts.every(m => !m.active)); assert.equal(renderer.text().includes(privateName), false);
      assert.equal(shell.displayName, undefined);
    },
  };
}

test("synthetic sessionAuth signature rejects missing, retired and aborted scopes before fake dispatch", async t => {
  const f = fixture(t); await f.flush();
  const controller = new AbortController(); controller.abort();
  for (const scope of [undefined, {}, { isCurrent: () => false }, { isCurrent: () => true, signal: controller.signal }]) {
    for (const method of [f.sessionAuth.signInWithPassword, f.sessionAuth.signUp]) {
      assert.throws(() => method({ email: "synthetic@example.invalid", password }, scope as Parameters<typeof method>[1]));
      assert.equal(f.authCalls.length, 0, "Invalid facade calls never enter the held SDK double");
    }
  }
});

test("bootstrap subscribes before lookup and holds both login and private application closed", async t => {
  const f = fixture(t); await f.flush();
  assert.deepEqual(f.trace, ["subscribe", "getSession"]);
  assert.equal(f.nodes().some(n => n.type === "form"), false);
  assert.equal(f.statuses().length, 1); f.assertNoPrivate(); assert.equal(f.profileCalls.length, 0);
});

for (const outcome of ["success", "error", "rejection"] as const) {
  test(`bootstrap ${outcome} settles without exposing provider diagnostics`, async t => {
    const f = fixture(t); await f.flush();
    if (outcome === "rejection") f.bootstrap.reject(new Error(rawDiagnostic));
    else f.bootstrap.resolve({ data: { session: session(actorA) }, error: outcome === "error" ? new Error(rawDiagnostic) : null });
    await f.flush();
    if (outcome === "success") assert.equal(f.app().props.userId, actorA);
    else { assert.ok(f.input("email")); f.assertNoPrivate(); }
    assert.equal(f.text().includes(rawDiagnostic), false);
  });
}

for (const late of ["other-actor", "anonymous", "error", "rejection"] as const) {
  test(`observed auth event wins over late bootstrap ${late}`, async t => {
    const f = fixture(t); await f.flush(); f.emit(actorB); await f.flush(); const app = f.app();
    if (late === "rejection") f.bootstrap.reject(new Error(rawDiagnostic));
    else f.bootstrap.resolve({ data: { session: session(late === "other-actor" ? actorA : null) },
      error: late === "error" ? new Error(rawDiagnostic) : null });
    await f.flush(); assert.equal(f.app(), app); assert.equal(app.props.userId, actorB);
    assert.equal(f.profileCalls.length, 1); assert.equal(f.text().includes(rawDiagnostic), false);
  });
}

test("synchronous INITIAL_SESSION and observed sign-out beat a late signed-in snapshot", async t => {
  const f = fixture(t, { initialEvent: actorA }); await f.flush(); assert.equal(f.app().props.userId, actorA);
  f.emit(null); await f.flush(); f.bootstrap.resolve({ data: { session: session(actorA) } }); await f.flush();
  assert.ok(f.input("email")); f.assertNoPrivate();
});

test("actor ABA immediately invalidates the old application and ignores its held profile", async t => {
  const f = fixture(t); await f.ready(actorA); const old = f.app(), read = f.profileCalls[0];
  f.emit(actorB); assert.equal(old.props.isActorCurrent(), false);
  f.emit(actorA); assert.equal(old.props.isActorCurrent(), false); await f.flush();
  assert.notEqual(f.app(), old); assert.equal(old.disposed, true); assert.equal(read.signal.aborted, true);
  assert.equal(read.isCurrent(), false); const writes = f.writes();
  read.gate.resolve(profile("RETIRED_A_PRIVATE_PROFILE")); await f.flush();
  assert.equal(f.writes(), writes); assert.equal(f.text().includes("RETIRED_A_PRIVATE_PROFILE"), false);
  assert.equal(f.app().props.userId, actorA);
});

test("same-actor token refresh preserves the application and its held profile scope", async t => {
  const f = fixture(t); await f.ready(actorA); const app = f.app(), read = f.profileCalls[0];
  f.emit(actorA, "TOKEN_REFRESHED"); await f.flush();
  assert.equal(f.app(), app); assert.equal(read.signal.aborted, false); assert.equal(read.isCurrent(), true);
  assert.equal(f.profileCalls.length, 1);
});

for (const kind of ["signin", "signup"] as const) {
  test(`${kind}: same-turn duplicate submit reaches only one held SDK call and clears password before reply`, async t => {
    const f = fixture(t); await f.ready(null); if (kind === "signup") await f.signup(); await f.fill();
    const submit = f.form().props.onSubmit;
    f.submit(submit); f.submit(submit); await f.flush();
    assert.equal(f.prevented(), 2); assert.equal(f.authCalls.length, 1); const call = f.authCalls[0];
    assert.equal(call.kind, kind); assert.equal(call.gate.settled(), false);
    assert.equal(call.body.email, "synthetic.person@example.invalid"); assert.equal(call.body.password, password);
    if (kind === "signup") {
      assert.deepEqual(Object.keys(call.body).sort(), ["email", "options", "password"]);
      assert.deepEqual({ ...call.body.options }, { emailRedirectTo: origin + "/contributors" });
    } else assert.deepEqual(Object.keys(call.body).sort(), ["email", "password"]);
    assert.equal(f.input("password").props.value, "");
    assert.equal(f.input("password").props.disabled, true); assert.equal(f.input("email").props.disabled, true);
    assert.equal(f.nodes().some(n => n.type === "button" && n.props.type === "submit" && !n.props.disabled), false);
    call.gate.resolve(authReply(actorA)); await f.flush();
    f.assertNoPrivate(); assert.equal(f.profileCalls.length, 0, "A returned SDK session cannot bypass the auth event boundary");
    f.emit(actorA); await f.flush(); assert.equal(f.app().props.userId, actorA);
  });
}

test("existing sign-in retains staff-login normalization without imposing the new-account password policy", async t => {
  const f = fixture(t); await f.ready(null); await f.fill("  Synthetic_Person  ", "short"); f.submit(); await f.flush();
  assert.equal(f.authCalls.length, 1); assert.equal(f.authCalls[0].kind, "signin");
  assert.equal(f.authCalls[0].body.email, "synthetic.person@staff.negis.online");
  assert.equal(f.authCalls[0].body.password, "short"); assert.equal(f.input("password").props.value, "");
});

for (const email of ["synthetic.person", "", "SYNTHETIC@STAFF.NEGIS.ONLINE", "  synthetic@staff.negis.local  "]) {
  test(`signup personal-email rejection: ${JSON.stringify(email)}`, async t => {
    const f = fixture(t); await f.ready(null); await f.signup(); await f.fill(email); f.submit(); await f.flush();
    assert.equal(f.authCalls.length, 0); assert.equal(f.statuses().length, 1); f.assertNoPrivate();
    assert.equal(f.input("password").props.disabled, false);
  });
}

for (const [label, value] of [
  ["seven characters", "1234567"], ["73 UTF-8 bytes", "x".repeat(73)],
  ["multibyte over bcrypt limit", "\u0430".repeat(37)], ["all whitespace", "        "],
  ["leading space", " 12345678"], ["trailing space", "12345678 "],
] as const) {
  test(`signup password policy rejects ${label} before SDK dispatch`, async t => {
    const f = fixture(t); await f.ready(null); await f.signup(); await f.fill(undefined, value); f.submit(); await f.flush();
    assert.equal(f.authCalls.length, 0); assert.equal(f.statuses().length, 1);
    assert.equal(f.input("password").props.disabled, false); f.assertNoPrivate();
  });
}

for (const [label, value] of [
  ["eight characters", "12345678"], ["72 UTF-8 bytes", "x".repeat(72)],
  ["72 multibyte bytes", "\u0430".repeat(36)], ["interior space", "valid interior space"],
] as const) {
  test(`signup password policy accepts ${label} and fixes the redirect to /contributors`, async t => {
    const f = fixture(t); await f.ready(null); await f.signup(); await f.fill(undefined, value); f.submit(); await f.flush();
    assert.equal(f.authCalls.length, 1); assert.equal(f.authCalls[0].kind, "signup");
    assert.equal(f.authCalls[0].body.password, value);
    assert.equal(f.authCalls[0].body.options.emailRedirectTo, origin + "/contributors");
    assert.equal(f.input("password").props.value, "");
  });
}

for (const kind of ["signin", "signup"] as const) {
  for (const outcome of ["returned-error", "rejection", "confirmation"] as const) {
    test(`${kind}: ${outcome} has neutral UI and no private application`, async t => {
      const f = fixture(t); await f.ready(null); if (kind === "signup") await f.signup(); await f.fill(); f.submit(); await f.flush();
      const call = f.authCalls[0]; assert.ok(call);
      if (outcome === "rejection") call.gate.reject(new Error(rawDiagnostic));
      else call.gate.resolve({ ...authReply(), error: outcome === "returned-error" ? { message: rawDiagnostic, code: rawDiagnostic } : null });
      await f.flush(); assert.equal(f.statuses().length, 1); assert.equal(f.text().includes(rawDiagnostic), false);
      assert.equal(f.input("password").props.value, ""); assert.equal(f.input("password").props.disabled, false);
      assert.equal(f.authCalls.length, 1); assert.equal(f.providerCalls.length, 0); f.assertNoPrivate();
    });
  }
}

test("unconfigured existing auth UI never dispatches either SDK method", async t => {
  const f = fixture(t, { configured: false }); await f.ready(null); await f.fill(); f.submit(); await f.flush();
  assert.equal(f.authCalls.length, 0); assert.equal(f.statuses().length, 1);
  await f.signup(); await f.fill(); f.submit(); await f.flush();
  assert.equal(f.authCalls.length, 0); assert.equal(f.statuses().length, 1); f.assertNoPrivate();
});

test("mode ABA retires old submit, mode, and credential callbacks", async t => {
  const f = fixture(t); await f.ready(null); await f.fill();
  const oldSubmit = f.form().props.onSubmit, oldMode = f.mode("signup").props.onClick;
  const oldEmail = f.input("email").props.onChange, oldPassword = f.input("password").props.onChange;
  await f.signup(); f.mode("signin").props.onClick(); await f.flush();
  assert.equal(f.input("password").props.value, "");
  const writes = f.writes();
  f.submit(oldSubmit); oldMode(); oldEmail({ target: { value: "retired@example.invalid" } });
  oldPassword({ target: { value: "retired-password" } }); await f.flush();
  assert.equal(f.authCalls.length, 0); assert.equal(f.writes(), writes, "Retired mode callbacks must not change the new form");
  assert.equal(f.mode("signin").props["aria-pressed"], true); assert.equal(f.input("password").props.value, "");
  await f.fill(); f.submit(); await f.flush(); assert.equal(f.authCalls.length, 1);
});

test("held SDK submission rejects retained mode toggles and credential changes", async t => {
  const f = fixture(t); await f.ready(null); await f.fill();
  const changeMode = f.mode("signup").props.onClick, changeEmail = f.input("email").props.onChange;
  const changePassword = f.input("password").props.onChange;
  f.submit(); await f.flush(); const writes = f.writes();
  changeMode(); changeEmail({ target: { value: "retired@example.invalid" } });
  changePassword({ target: { value: "retired-password" } }); await f.flush();
  assert.equal(f.writes(), writes); assert.equal(f.authCalls.length, 1);
  assert.equal(f.mode("signin").props["aria-pressed"], true); assert.equal(f.input("password").props.value, "");
});

for (const kind of ["signin", "signup"] as const) {
  for (const retirement of ["unmount", "anonymous-ABA"] as const) {
    test(`${kind}: ${retirement} ignores held completion and retained handlers`, async t => {
      const f = fixture(t); await f.ready(null); if (kind === "signup") await f.signup(); await f.fill();
      const oldSubmit = f.form().props.onSubmit, oldMode = f.mode("signup").props.onClick;
      const oldEmail = f.input("email").props.onChange, oldPassword = f.input("password").props.onChange;
      f.submit(oldSubmit); await f.flush();
      if (retirement === "unmount") f.dispose();
      else { f.emit(actorA); f.emit(null); await f.flush(); assert.equal(f.input("password").props.value, ""); }
      const writes = f.writes();
      f.submit(oldSubmit); oldMode(); oldEmail({ target: { value: "retired@example.invalid" } });
      oldPassword({ target: { value: "retired-password" } });
      f.authCalls[0].gate.reject(new Error(rawDiagnostic)); await f.flush();
      assert.equal(f.authCalls.length, 1); assert.equal(f.writes(), writes); assert.equal(f.lateWrites(), 0);
      assert.equal(f.text().includes(rawDiagnostic), false);
      if (retirement !== "unmount") { assert.equal(f.input("password").props.value, ""); assert.equal(f.statuses().length, 0); }
    });
  }
}

test("unmount before bootstrap completion ignores retained auth subscription callbacks and late lookup", async t => {
  const f = fixture(t); await f.flush(); f.dispose(); const writes = f.writes();
  f.authCallbacks[0]("SIGNED_IN", session(actorA)); f.bootstrap.reject(new Error(rawDiagnostic)); await f.flush();
  assert.equal(f.writes(), writes); assert.equal(f.profileCalls.length, 0); assert.equal(f.lateWrites(), 0);
});

for (const outcome of ["held", "resolved", "rejected"] as const) {
  test(`root sign-out delegates immediately to held provider, retires private UI, and stays closed when ${outcome}`, async t => {
    const f = fixture(t); await f.ready(actorA); await f.loadProfile();
    const app = f.app(), signOut = f.shell().onSignOut, read = f.profileCalls[0];
    assert.equal(typeof signOut, "function"); assert.equal(typeof app.props.onSignOut, "function", "Application must receive a root-owned sign-out callback");
    assert.ok(f.mounts.some(m => m.active)); assert.equal(f.shell().displayName, privateName);
    signOut(); assert.equal(f.providerCalls.length, 1, "Do not wait for an SDK event or another render before delegating");
    assert.equal(f.providerCalls[0].actorId, actorA); assert.equal(f.rawSignOuts(), 0, "The root must not call raw SDK signOut");
    assert.equal(app.props.isActorCurrent(), false, "Root retirement must synchronously invalidate the private actor scope");
    assert.equal(read.isCurrent(), false); await f.flush(); f.assertNoPrivate(); assert.equal(app.disposed, true);
    assert.equal(read.signal.aborted, true);
    signOut(); app.props.onSignOut(); assert.equal(f.providerCalls.length, 1, "Retired sign-out callbacks cannot dispatch twice");
    if (outcome === "resolved") f.providerCalls[0].gate.resolve();
    if (outcome === "rejected") f.providerCalls[0].gate.reject(new Error(rawDiagnostic));
    await f.flush(); f.assertNoPrivate(); assert.equal(f.text().includes(rawDiagnostic), false);
    f.authPatch({ isSigningOut: false }); f.emit(actorA, "TOKEN_REFRESHED"); await f.flush();
    f.assertNoPrivate("TOKEN_REFRESHED for the locally signed-out actor must not remount private Application");
    assert.equal(f.profileCalls.length, 1, "Old provider state or same-actor refresh cannot revive a locally retired login");
  });
}

for (const late of ["profile-success", "profile-rejection"] as const) {
  test(`held logout ignores ${late} without restoring private UI`, async t => {
    const f = fixture(t); await f.ready(actorA); const read = f.profileCalls[0];
    f.shell().onSignOut(); await f.flush(); const writes = f.writes();
    if (late === "profile-success") read.gate.resolve(profile()); else read.gate.reject(new Error(rawDiagnostic));
    await f.flush(); f.assertNoPrivate(); assert.equal(f.writes(), writes); assert.equal(f.rawSignOuts(), 0);
  });
}

for (const change of ["actor-B", "actor-ABA", "unmount"] as const) {
  test(`retained root and Application sign-out callbacks cannot dispatch after ${change}`, async t => {
    const f = fixture(t); await f.ready(actorA); const oldApp = f.app();
    const shellSignOut = f.shell().onSignOut, rootSignOut = oldApp.props.onSignOut;
    assert.equal(typeof rootSignOut, "function");
    if (change === "unmount") f.dispose();
    else { f.emit(actorB); if (change === "actor-ABA") f.emit(actorA); }
    shellSignOut(); rootSignOut(); assert.equal(f.providerCalls.length, 0, "Old callbacks cannot sign out a newer actor even before render");
    await f.flush(); shellSignOut(); rootSignOut(); await f.flush();
    assert.equal(f.providerCalls.length, 0); assert.equal(f.rawSignOuts(), 0); assert.equal(f.lateWrites(), 0);
    if (change !== "unmount") assert.equal(f.app().props.userId, change === "actor-B" ? actorB : actorA);
  });
}

for (const outcome of ["resolved", "rejected"] as const) {
  test(`late ${outcome} provider logout keeps this retired root closed even after a new actor event`, async t => {
    const f = fixture(t); await f.ready(actorA); const old = f.shell().onSignOut;
    old(); await f.flush(); f.emit(actorB); await f.flush();
    f.assertNoPrivate();
    const writes = f.writes();
    if (outcome === "resolved") f.providerCalls[0].gate.resolve(); else f.providerCalls[0].gate.reject(new Error(rawDiagnostic));
    await f.flush(); old();
    f.assertNoPrivate();
    assert.equal(f.profileCalls.length, 1, "A retired root cannot read a replacement profile while logout is unresolved or failed");
    assert.equal(f.writes(), writes); assert.equal(f.providerCalls.length, 1); assert.equal(f.rawSignOuts(), 0);
  });
}

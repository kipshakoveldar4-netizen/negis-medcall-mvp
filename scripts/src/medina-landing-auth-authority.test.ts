import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Actual Landing JSX/handlers. Hooks, forms and provider are synthetic; the two
// authority integration cases use the installed frontend SDK and held fake HTTP.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rootRequire = createRequire(path.join(root, "package.json"));
const frontendRequire = createRequire(path.join(root, "artifacts/negis/package.json"));
const ts = rootRequire("typescript") as typeof import("typescript");
const sdk = frontendRequire("@supabase/supabase-js");
const sdkVersion = frontendRequire("@supabase/supabase-js/package.json").version;
const sourcePath = "artifacts/negis/src/pages/Landing.tsx";
const source = await readFile(path.join(root, sourcePath), "utf8");

function evaluate(file: string, code: string, imports: Record<string, unknown>, bindings: Record<string, unknown> = {}) {
  const compiled = ts.transpileModule(code, {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
  const exports: Record<string, any> = {};
  new Script(compiled.outputText, { filename: file }).runInNewContext({
    exports, AbortController, DOMException, Error, URL, Headers, Request, Response,
    TextEncoder, setTimeout, clearTimeout, ...bindings,
    fetch() { assert.fail("Real network is forbidden"); },
    require(name: string) {
      assert.ok(Object.hasOwn(imports, name), `Unexpected dependency: ${name}`);
      return imports[name];
    },
  });
  return exports;
}

const loginsPath = "lib/auth/staff-logins.ts";
const logins = evaluate(loginsPath, await readFile(path.join(root, loginsPath), "utf8"), {});
const authorityPath = "artifacts/negis/src/lib/authSessionAuthority.ts";
const { createAuthSessionAuthority } = evaluate(authorityPath,
  await readFile(path.join(root, authorityPath), "utf8"), { "@supabase/supabase-js": sdk });

type Props = Record<string, any>;
type Element = { type: unknown; props: Props };
type Child = Element | string | number | boolean | null | undefined | Child[];
type Effect = () => void | (() => void);
type Deps = readonly unknown[] | undefined;
type Slot =
  | { kind: "state"; value: any; set: (next: any) => void }
  | { kind: "ref"; value: { current: any } }
  | { kind: "effect" | "layout"; create: Effect; deps: Deps; pending: boolean; cleanup?: () => void };

function elements(child: Child): Element[] {
  if (Array.isArray(child)) return child.flatMap(elements);
  if (!child || typeof child !== "object") return [];
  return [child, ...elements(child.props.children)];
}
function text(child: Child): string {
  if (Array.isArray(child)) return child.map(text).join("");
  if (child && typeof child === "object") return text(child.props.children);
  return typeof child === "string" || typeof child === "number" ? String(child) : "";
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function syntheticLock() {
  const tails = new Map<string, Promise<void>>();
  return async <T>(name: string, _timeout: number, callback: () => Promise<T>): Promise<T> => {
    const operation = (tails.get(name) ?? Promise.resolve()).then(callback);
    const tail = operation.then(() => {}, () => {});
    tails.set(name, tail);
    try { return await operation; } finally { if (tails.get(name) === tail) tails.delete(name); }
  };
}
function hookDriver() {
  const slots: Slot[] = [], writes: { mounted: boolean; value: unknown }[] = [];
  let cursor = 0, mounted = true, dirty = false, tree: Child, component: () => Child;
  function slot<K extends Slot["kind"]>(kind: K, create: () => Extract<Slot, { kind: K }>) {
    const index = cursor++;
    slots[index] ??= create();
    assert.equal(slots[index].kind, kind);
    return slots[index] as Extract<Slot, { kind: K }>;
  }
  function effect(kind: "effect" | "layout", create: Effect, deps: Deps) {
    const item = slot(kind, () => ({ kind, create, deps, pending: true }));
    if (!deps || !item.deps || deps.length !== item.deps.length || deps.some((d, i) => !Object.is(d, item.deps![i])))
      item.pending = true;
    item.create = create; item.deps = deps;
  }
  const hooks = {
    useState(initial: any) {
      const item = slot("state", () => {
        const state: Extract<Slot, { kind: "state" }> = {
          kind: "state", value: typeof initial === "function" ? initial() : initial,
          set(next: any) {
            writes.push({ mounted, value: next });
            const value = typeof next === "function" ? next(state.value) : next;
            if (!Object.is(value, state.value)) { state.value = value; if (mounted) dirty = true; }
          },
        };
        return state;
      });
      return [item.value, item.set];
    },
    useRef(initial: any) { return slot("ref", () => ({ kind: "ref", value: { current: initial } })).value; },
    useEffect(create: Effect, deps: Deps) { effect("effect", create, deps); },
    useLayoutEffect(create: Effect, deps: Deps) { effect("layout", create, deps); },
  };
  function commit() {
    dirty = false; cursor = 0; tree = component();
    for (const kind of ["layout", "effect"] as const) {
      const pending = slots.filter((s): s is Extract<Slot, { kind: "layout" | "effect" }> => s.kind === kind && s.pending);
      for (const item of pending) item.cleanup?.();
      for (const item of pending) { item.pending = false; item.cleanup = item.create() || undefined; }
    }
  }
  return {
    hooks, writes,
    mount(value: () => Child) { component = value; dirty = true; },
    invalidate() { if (mounted) dirty = true; },
    nodes: () => elements(tree), content: () => text(tree),
    async flush() {
      for (let i = 0; i < 30; i++) { if (mounted && dirty) commit(); await Promise.resolve(); }
      await setImmediate();
      for (let i = 0; i < 30; i++) { if (mounted && dirty) commit(); await Promise.resolve(); }
      assert.equal(dirty, false);
    },
    replay() {
      for (const item of slots) if (item.kind === "layout" || item.kind === "effect") {
        item.cleanup?.(); item.cleanup = undefined; item.pending = true;
      }
      dirty = true;
    },
    unmount() {
      if (!mounted) return;
      mounted = false; dirty = false;
      for (const item of slots) if (item.kind === "layout" || item.kind === "effect") item.cleanup?.();
    },
  };
}

type Scope = { isCurrent(): boolean; expectedUserId?: string | null; signal?: AbortSignal };
type LoginCall = { credentials: Props; scope: Scope; hold: ReturnType<typeof deferred<any>> };
const actorA = "landing-local-a", actorB = "landing-local-b";
const password = "Synthetic-password-42";
const authSession = (id: string | null) => id ? { user: { id, email: `${id}@example.test` } } : null;

async function fixture(t: TestContext, actualAuthority = false) {
  const driver = hookDriver(), forms: any[] = [], calls: LoginCall[] = [], requests: { url: string; init: RequestInit; hold: ReturnType<typeof deferred<Response>> }[] = [];
  const listeners = new Set<(event: string, session: ReturnType<typeof authSession>) => void>();
  const timers = new Map<number, { ms: number; callback: () => void }>();
  const frames = new Map<number, () => void>();
  const locations: string[] = [], resets: any[] = [], updates: any[] = [];
  const resetHold = deferred<any>(), updateHold = deferred<any>();
  const store = new Map<string, string>();
  const provider = { session: null as ReturnType<typeof authSession>, userRole: null as string | null,
    isLoading: false, clinicId: null as string | null, isDemoMode: false, workspacePurpose: null };
  let timerId = 0, nonce = 0;
  const storage = { getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); } };
  const authority = actualAuthority ? createAuthSessionAuthority({
    url: "https://landing-auth.example.test", key: "synthetic-landing-key", storage,
    lock: syntheticLock(), nonce: () => `landing-${++nonce}`, timeoutMs: 5_000,
    fetch(input: any, init: RequestInit) {
      const url = String(input);
      assert.equal(url, "https://landing-auth.example.test/auth/v1/token?grant_type=password");
      const hold = deferred<Response>(); requests.push({ url, init, hold }); return hold.promise;
    },
  }) : null;
  const nativeAuth = {
    async getSession() { return { data: { session: JSON.parse(storage.getItem(authority.storageKey) ?? "null") }, error: null }; },
    onAuthStateChange(callback: (event: string, session: ReturnType<typeof authSession>) => void) {
      listeners.add(callback); callback("INITIAL_SESSION", provider.session);
      return { data: { subscription: { unsubscribe() { listeners.delete(callback); } } } };
    },
  };
  const sessionAuth = {
    onAuthStateChange(callback: (event: string, session: ReturnType<typeof authSession>) => void) {
      return authority ? authority.observe(nativeAuth, callback) : nativeAuth.onAuthStateChange(callback);
    },
    signInWithPassword(credentials: Props, scope: Scope) {
      assert.equal(forms[0].values.password, "", "Password must be cleared before dispatch");
      const hold = deferred<any>(); calls.push({ credentials, scope, hold });
      return authority ? authority.signInWithPassword(credentials, scope) : hold.promise;
    },
  };
  function useForm(options: Props) {
    const ref = driver.hooks.useRef(null);
    if (!ref.current) {
      const values: Props = {}, form: Props = {
        values, formState: { errors: {} },
        register(name: string) { return { name, value: values[name] ?? "", onChange(event: any) {
          values[name] = event.target.value; driver.invalidate();
        } }; },
        setValue(name: string, value: unknown) { values[name] = value; driver.invalidate(); },
        reset() { for (const key of Object.keys(values)) delete values[key]; form.formState.errors = {}; driver.invalidate(); },
        handleSubmit(callback: (data: any) => Promise<void>) {
          return async () => {
            const resolved = await options.resolver({ ...values }, {}, { fields: {}, shouldUseNativeValidation: false });
            form.formState.errors = resolved.errors; driver.invalidate();
            if (!Object.keys(resolved.errors).length) await callback(resolved.values);
          };
        },
      };
      ref.current = form; forms.push(form);
    }
    return ref.current;
  }
  const jsx = (type: unknown, props: Props): Element => ({ type, props });
  const module = evaluate(sourcePath, source, {
    react: driver.hooks, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: Symbol("fragment") },
    wouter: { useLocation: () => ["/", (location: string) => locations.push(location)] },
    "lucide-react": { ArrowRight: Symbol("arrow") },
    "@/lib/supabase": { sessionAuth, supabase: { auth: {
      signInWithPassword() { assert.fail("Raw credential login is forbidden"); },
      onAuthStateChange() { assert.fail("Raw auth subscription is forbidden"); },
      resetPasswordForEmail(...args: any[]) { resets.push(args); return resetHold.promise; },
      updateUser(...args: any[]) { updates.push(args); return updateHold.promise; },
    } } },
    "../../../../lib/auth/staff-logins": logins,
    "@/contexts/AuthContext": { useAuth: () => provider },
    zod: frontendRequire("zod"), "react-hook-form": { useForm },
    "@hookform/resolvers/zod": frontendRequire("@hookform/resolvers/zod"),
  }, {
    window: { location: { origin: "https://landing.example.test" } },
    setTimeout(callback: () => void, ms: number) { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    requestAnimationFrame(callback: () => void) { const id = ++timerId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
  });
  driver.mount(module.default);
  const flush = async () => {
    await driver.flush();
    const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback();
    await driver.flush();
  };
  const find = (predicate: (node: Element) => boolean) => {
    const node = driver.nodes().find(predicate); assert.ok(node, "Expected JSX control"); return node;
  };
  const byTestId = (id: string) => find(node => node.props["data-testid"] === id || node.props.testId === id);
  const button = (label: string) => find(node => typeof node.props.onClick === "function" && (node.props.label === label || text(node) === label));
  const form = () => find(node => node.type === "form");
  const fill = (email = "synthetic.person", value = password) => {
    forms[0].values.email = email; forms[0].values.password = value; driver.invalidate();
  };
  const close = () => find(node => node.props.className === "fixed inset-0 flex items-center justify-center z-50 p-4").props.onClick({ target: 1, currentTarget: 1 });
  const emit = (id: string | null, event = id ? "SIGNED_IN" : "SIGNED_OUT") => {
    for (const callback of [...listeners]) callback(event, authSession(id));
  };
  const runTimers = (ms: number) => {
    for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.callback(); }
  };
  async function enterLogin() {
    byTestId("button-negis-main").props.onClick(); await flush();
    byTestId("button-choice-login").props.onClick(); await flush(); fill(); await flush();
  }
  t.after(() => { driver.unmount(); for (const request of requests) request.hold.resolve(Response.json({ msg: "test cleanup" }, { status: 409 })); });
  await flush();
  return { driver, forms, calls, requests, locations, resets, updates, resetHold, updateHold, provider,
    storage, authority, listeners, timers, flush, find, byTestId, button, form, fill, close, emit, runTimers, enterLogin };
}

test("Landing validates the original form and submits one guarded, password-cleared attempt", async t => {
  const f = await fixture(t); await f.enterLogin();
  f.fill("ab", "12345"); await f.form().props.onSubmit(); await f.flush();
  assert.equal(f.calls.length, 0);
  assert.ok(f.forms[0].formState.errors.email); assert.ok(f.forms[0].formState.errors.password);
  f.fill(); await f.flush();
  const originalSubmit = f.form().props.onSubmit;
  const first = originalSubmit(), duplicate = originalSubmit(); await f.flush();
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.credentials.email, logins.loginOrEmailToAuthEmail("synthetic.person"));
  assert.equal(call.credentials.password, password);
  assert.equal(call.scope.expectedUserId, null); assert.equal(call.scope.isCurrent(), true);
  assert.equal(f.byTestId("button-login").props.disabled, true);
  call.hold.resolve({ error: { message: "synthetic rejection" } }); await first; await duplicate; await f.flush();
  assert.match(f.driver.content(), /synthetic rejection/);
  assert.equal(f.byTestId("button-login").props.disabled, false);
  assert.equal(call.scope.isCurrent(), false);
  f.fill(); await originalSubmit(); await f.flush(); assert.equal(f.calls.length, 1, "Retired callback cannot replay captured form credentials");
});

test("Landing preserves current login navigation, but a success notification retires fallback navigation", async t => {
  const f = await fixture(t); await f.enterLogin();
  const first = f.form().props.onSubmit(); await f.flush();
  f.calls[0].hold.resolve({ error: null }); await first; await f.flush();
  assert.deepEqual(f.locations, ["/appointments"]);
  f.runTimers(220); await f.flush(); await f.enterLogin();
  const second = f.form().props.onSubmit(); await f.flush();
  f.emit(actorA); f.calls[1].hold.resolve({ error: null }); await second; await f.flush();
  assert.deepEqual(f.locations, ["/appointments"], "No stale fallback route after account event");
  f.provider.session = authSession(actorA); f.provider.clinicId = "synthetic-workspace"; f.provider.userRole = "lead_manager";
  f.driver.invalidate(); await f.flush(); assert.deepEqual(f.locations, ["/appointments", "/leads"]);
});

test("Landing retries the current provider route when its auth observation arrives later", async t => {
  const f = await fixture(t); await f.enterLogin();
  const pending = f.form().props.onSubmit(); await f.flush();
  f.provider.session = authSession(actorB); f.provider.clinicId = "synthetic-workspace"; f.provider.userRole = "owner";
  f.driver.invalidate(); await f.flush();
  assert.deepEqual(f.locations, [], "Do not route an unverified provider subject");
  f.emit(actorB); await f.flush();
  assert.deepEqual(f.locations, ["/dashboard"], "The original role route must resume after matching observation");
  f.calls[0].hold.resolve({ error: null }); await pending; await f.flush();
  assert.deepEqual(f.locations, ["/dashboard"], "Retired login must not append a default route");
});

for (const outcome of ["error", "throw", "success"] as const) {
  test(`Landing close/reopen rejects stale ${outcome} without clearing the new attempt`, async t => {
    const f = await fixture(t); await f.enterLogin();
    const first = f.form().props.onSubmit(); await f.flush(); const old = f.calls[0];
    f.close(); assert.equal(old.scope.isCurrent(), false); assert.equal(old.scope.signal?.aborted, true);
    const oldClose = [...f.timers.values()].find(timer => timer.ms === 220)!.callback;
    await f.flush(); await f.enterLogin();
    oldClose(); await f.flush(); assert.ok(f.byTestId("button-login"));
    const second = f.form().props.onSubmit(); await f.flush();
    const writes = f.driver.writes.length;
    if (outcome === "throw") old.hold.reject(new Error("stale failure"));
    else old.hold.resolve({ error: outcome === "error" ? { message: "stale failure" } : null });
    await first; await f.flush();
    assert.equal(f.driver.writes.length, writes, "Stale catch/finally/success must not write state");
    assert.equal(f.byTestId("button-login").props.disabled, true);
    assert.doesNotMatch(f.driver.content(), /stale failure/); assert.deepEqual(f.locations, []);
    f.calls[1].hold.resolve({ error: { message: "current failure" } }); await second; await f.flush();
  });
}

test("Landing mode ABA retires validation callbacks and isolates recovery completion from login loading/error", async t => {
  const f = await fixture(t); await f.enterLogin();
  const originalSubmit = f.form().props.onSubmit;
  const validationPending = originalSubmit();
  f.button("Забыли пароль?").props.onClick(); await f.flush(); await validationPending;
  assert.equal(f.calls.length, 0, "Async validation may not start a retired modal attempt");
  f.forms[1].values.email = "recovery@example.test";
  const reset = f.form().props.onSubmit(); await f.flush();
  assert.equal(f.resets.length, 1);
  assert.equal(f.resets[0][0], "recovery@example.test");
  assert.equal(f.resets[0][1].redirectTo, "https://landing.example.test/reset-password");
  f.button("Назад к входу").props.onClick(); await f.flush(); f.fill(); await f.flush();
  const current = f.form().props.onSubmit(); await f.flush();
  f.resetHold.resolve({ error: { message: "old reset failure" } }); await reset; await f.flush();
  assert.equal(f.byTestId("button-login").props.disabled, true);
  assert.doesNotMatch(f.driver.content(), /Не удалось отправить письмо/);
  await originalSubmit(); assert.equal(f.calls.length, 1);
  f.calls[0].hold.resolve({ error: { message: "current login failure" } }); await current; await f.flush();
});

test("Landing mode switch immediately retires an in-flight credential request", async t => {
  const f = await fixture(t); await f.enterLogin();
  const pending = f.form().props.onSubmit(); await f.flush();
  f.button("Назад").props.onClick(); assert.equal(f.calls[0].scope.isCurrent(), false);
  await f.flush(); f.byTestId("button-choice-login").props.onClick(); await f.flush();
  f.calls[0].hold.reject(new Error("old login")); await pending; await f.flush();
  assert.doesNotMatch(f.driver.content(), /old login/); assert.deepEqual(f.locations, []);
});

test("Landing context subject change retires login even without its local auth observer firing", async t => {
  const f = await fixture(t); await f.enterLogin();
  const oldSubmit = f.form().props.onSubmit, pending = oldSubmit(); await f.flush();
  f.provider.session = authSession(actorB); f.driver.invalidate(); await f.flush();
  assert.equal(f.calls[0].scope.isCurrent(), false); assert.equal(f.calls[0].scope.signal?.aborted, true);
  f.provider.session = null; f.driver.invalidate(); await f.flush(); f.fill();
  await oldSubmit(); assert.equal(f.calls.length, 1, "Context ABA may not revive the original form");
  f.calls[0].hold.resolve({ error: { message: "old context error" } }); await pending; await f.flush();
  assert.doesNotMatch(f.driver.content(), /old context error/); assert.deepEqual(f.locations, []);
});

test("Landing account notification during close does not strand the fading modal", async t => {
  const f = await fixture(t); await f.enterLogin();
  f.close(); f.emit(actorB); await f.flush(); f.runTimers(220); await f.flush();
  assert.equal(f.driver.nodes().some(node => node.type === "form"), false);
  assert.equal(f.timers.size, 0);
});

for (const event of ["SIGNED_IN", "SIGNED_OUT", "ABA"] as const) {
  test(`Landing ${event} retires pending login even before provider notification`, async t => {
    const f = await fixture(t); await f.enterLogin();
    const submit = f.form().props.onSubmit, pending = submit(); await f.flush();
    if (event === "SIGNED_OUT") f.emit(null);
    else { f.emit(actorB); if (event === "ABA") f.emit(null); }
    assert.equal(f.calls[0].scope.isCurrent(), false); await f.flush();
    f.calls[0].hold.resolve({ error: null }); await pending; await f.flush();
    f.fill(); await submit(); await f.flush();
    assert.equal(f.calls.length, 1); assert.deepEqual(f.locations, []);
  });
}

test("Landing unmount and effect replay revoke old callbacks and unsubscribe observers", async t => {
  const f = await fixture(t); await f.enterLogin();
  const oldSubmit = f.form().props.onSubmit, pending = oldSubmit(); await f.flush();
  f.driver.replay(); await f.flush();
  assert.equal(f.calls[0].scope.isCurrent(), false); assert.equal(f.listeners.size, 1);
  f.calls[0].hold.reject(new Error("replayed attempt")); await pending; await f.flush();
  await oldSubmit(); assert.equal(f.calls.length, 1);
  await f.enterLogin(); const current = f.form().props.onSubmit(); await f.flush();
  f.driver.unmount(); const writes = f.driver.writes.length;
  assert.equal(f.calls[1].scope.signal?.aborted, true); assert.equal(f.listeners.size, 0);
  f.calls[1].hold.resolve({ error: null }); await current; await f.flush();
  assert.equal(f.driver.writes.length, writes); assert.deepEqual(f.locations, []);
});

test("Landing anonymous scope denies an already stored B before its auth event, using actual SDK authority", async t => {
  assert.equal(sdkVersion, "2.118.0");
  const f = await fixture(t, true); await f.enterLogin();
  const committed = JSON.stringify(authSession(actorB));
  f.storage.setItem(f.authority.storageKey, committed);
  f.storage.setItem(f.authority.revisionKey, "other-tab-committed-b");
  await f.form().props.onSubmit(); await f.flush();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].scope.expectedUserId, null);
  assert.equal(f.requests.length, 0, "No credential HTTP may start for stale anonymous scope");
  assert.equal(f.storage.getItem(f.authority.storageKey), committed); assert.deepEqual(f.locations, []);
});

test("Landing close fences actual installed SDK response before storage/UI publication", async t => {
  const f = await fixture(t, true); await f.enterLogin();
  const pending = f.form().props.onSubmit();
  for (let i = 0; i < 20 && f.requests.length === 0; i++) await f.flush();
  assert.equal(f.requests.length, 1); const request = f.requests[0];
  assert.equal(JSON.parse(String(request.init.body)).password, password);
  f.close(); await f.flush(); assert.equal(request.init.signal?.aborted, true);
  request.hold.resolve(Response.json({ access_token: "synthetic-access-token", refresh_token: "synthetic-refresh-token",
    expires_in: 3600, token_type: "bearer", user: { id: actorA, aud: "authenticated", email: "local-a@example.test" } }));
  await pending; await f.flush();
  assert.equal(f.storage.getItem(f.authority.storageKey), null); assert.deepEqual(f.locations, []);
});

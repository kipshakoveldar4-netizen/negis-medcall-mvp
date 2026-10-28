import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const pageFile = "artifacts/negis/src/pages/PartnerCompany.tsx";
const clientFile = "artifacts/negis/src/pages/partner-company-client.ts";
const origin = "https://company-page.example.invalid";
const actorA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const actorB = "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb";
const requestId = "cccccccc-cccc-4ccc-accc-cccccccccccc";
const sourceId = "dddddddd-dddd-4ddd-bddd-dddddddddddd";
const submitBody = Object.freeze({ requestId, company: Object.freeze({ name: "Synthetic Company", purpose: "marketing",
  vertical: null, timeZone: "UTC", ownerName: "Synthetic Owner" }), consent: true, consentVersion: "company-v1" });

async function compile(file: string) {
  const result = ts.transpileModule(await readFile(path.join(root, file), "utf8"), { fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } });
  assert.deepEqual(result.diagnostics ?? [], [], `Actual ${file} must transpile`);
  return result.outputText;
}
const pageCode = await compile(pageFile);
const clientCode = await compile(clientFile);

type Props = Record<string, any>;
type Element = { type: string | ((props: Props) => Child); props: Props; key?: string | number };
type Child = Element | string | number | boolean | null | undefined | Child[];
const jsx = (type: Element["type"], props: Props, key?: string | number): Element => ({ type, props, key });
function elements(value: Child): Element[] {
  return Array.isArray(value) ? value.flatMap(elements)
    : value && typeof value === "object" ? [value, ...elements(value.props.children)] : [];
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function evaluate(code: string, file: string, imports: Record<string, unknown>) {
  const exports: Record<string, any> = {};
  const forbidden = new Proxy({}, { get() { assert.fail("No storage, logging, or real SDK access is allowed"); } });
  new Script(code, { filename: file }).runInNewContext({
    exports, module: { exports }, URL, URLSearchParams, DOMException, AbortController, Error, Promise,
    window: { location: { origin }, localStorage: forbidden, sessionStorage: forbidden }, console: forbidden,
    fetch() { assert.fail("No real requests are allowed"); },
    require(name: string) { assert.ok(Object.hasOwn(imports, name), `Unexpected dependency in ${file}: ${name}`); return imports[name]; },
  });
  return exports;
}

type Operation = "context" | "submit" | "read" | "close";
type Options = { operation: Operation; body?: unknown; requestId?: string; sourceId?: string;
  signal: AbortSignal; isCurrent(): boolean };
type CompanyRequest = (options: Options) => Promise<unknown>;
type Init = RequestInit & { expectedUserId: string; dispatchGuard(): boolean };
type Reply = { ok: boolean; status: number; json(): Promise<unknown> };
type Call = { path: string; init: Init };
class CrmApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "CrmApiError"; }
}
function reply(data: unknown = { success: true, data: { synthetic: true } }, status = 200): Reply {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}
function clientFixture(config: { apiUrl?: (path: string) => string; respond?: (call: Call) => Promise<Reply> } = {}) {
  const calls: Call[] = [], trace: string[] = [];
  let tokenReads = 0;
  const api = {
    CrmApiError,
    apiUrl(path: string) { trace.push("config"); return config.apiUrl ? config.apiUrl(path) : path; },
    crmFetch(path: string, init: Init) {
      trace.push("crmFetch", "token"); tokenReads++;
      const call = { path, init }; calls.push(call);
      // Ignore guards and abort deliberately: the actual client owns late-result checks.
      return config.respond ? config.respond(call) : Promise.resolve(reply());
    },
  };
  const client = evaluate(clientCode, clientFile, { "@/lib/api": api }) as {
    companyRequestForActor(actorId: string, isCurrent: () => boolean): CompanyRequest;
  };
  return { client, calls, trace, tokenReads: () => tokenReads };
}
function options(operation: Operation = "context", patch: Partial<Options> = {}): Options {
  return { operation, requestId, sourceId, body: submitBody, signal: new AbortController().signal, isCurrent: () => true, ...patch };
}
const isAbort = (error: unknown) => !!error && typeof error === "object" && "name" in error && error.name === "AbortError";

type Effect = () => void | (() => void);
type Slot = { kind: "state" | "ref" | "effect"; value?: any; set?: (value: any) => void;
  create?: Effect; deps?: readonly unknown[]; pending?: boolean; cleanup?: () => void };
type Instance = { slots: Slot[]; cursor: number; disposed: boolean; hookCount?: number };
function hookRenderer() {
  const instances = new Map<string, Instance>(), identities = new Map<Function, number>();
  let current: Instance, dirty = true, mounted = true, tree: Child, component: () => Child, lateWrites = 0;
  function slot(kind: Slot["kind"], create: () => Slot) {
    const index = current.cursor++;
    current.slots[index] ??= create();
    assert.equal(current.slots[index].kind, kind, "Actual page must preserve hook order");
    return current.slots[index];
  }
  const hooks = {
    useState<T>(initial: T | (() => T)) {
      const instance = current;
      const state = slot("state", () => {
        const state: Slot = { kind: "state", value: typeof initial === "function" ? (initial as () => T)() : initial };
        state.set = update => {
          if (instance.disposed) { lateWrites++; return; }
          const next = typeof update === "function" ? update(state.value) : update;
          if (!Object.is(next, state.value)) { state.value = next; dirty = true; }
        };
        return state;
      });
      return [state.value as T, state.set!] as const;
    },
    useRef<T>(initial: T): { current: T } { return slot("ref", () => ({ kind: "ref", value: { current: initial } })).value; },
    useLayoutEffect(create: Effect, deps?: readonly unknown[]) {
      const effect = slot("effect", () => ({ kind: "effect", pending: true }));
      if (!deps || !effect.deps || deps.length !== effect.deps.length || deps.some((v, i) => !Object.is(v, effect.deps![i]))) effect.pending = true;
      effect.create = create; effect.deps = deps;
    },
  };
  function dispose(instance: Instance) {
    instance.disposed = true;
    for (const slot of instance.slots) slot.cleanup?.();
  }
  function render(value: Child, address: string, seen: Set<string>): Child {
    if (Array.isArray(value)) return value.map((v, i) => render(v, `${address}/${i}`, seen));
    if (!value || typeof value !== "object") return value;
    if (typeof value.type !== "function") {
      return { ...value, props: { ...value.props, children: render(value.props.children, `${address}/children`, seen) } };
    }
    if (!identities.has(value.type)) identities.set(value.type, identities.size + 1);
    const id = `${address}/${identities.get(value.type)}:${value.key ?? ""}`;
    seen.add(id);
    let instance = instances.get(id);
    if (!instance) { instance = { slots: [], cursor: 0, disposed: false }; instances.set(id, instance); }
    current = instance; instance.cursor = 0;
    const result = value.type(value.props);
    instance.hookCount ??= instance.cursor;
    assert.equal(instance.cursor, instance.hookCount, "No conditional hooks in actual page");
    return render(result, `${id}/out`, seen);
  }
  return {
    hooks,
    mount(value: () => Child) { component = value; },
    async flush() {
      for (let pass = 0; pass < 60; pass++) {
        if (mounted && dirty) {
          dirty = false;
          const seen = new Set<string>();
          tree = render(jsx(component, {}), "root", seen);
          for (const [id, instance] of instances) if (!seen.has(id)) { dispose(instance); instances.delete(id); }
          const effects = [...instances.values()].flatMap(i => i.slots).filter(s => s.kind === "effect" && s.pending);
          for (const effect of effects) effect.cleanup?.();
          for (const effect of effects) { effect.pending = false; effect.cleanup = effect.create!() || undefined; }
        }
        await Promise.resolve();
      }
      assert.equal(dirty, false, "Actual page must settle without real timers");
    },
    nodes: () => elements(tree), lateWrites: () => lateWrites,
    dispose() {
      if (!mounted) return;
      mounted = false; dirty = false;
      for (const instance of instances.values()) dispose(instance);
      instances.clear();
    },
  };
}

type ChildProps = { actorId: string; request: CompanyRequest; isSessionCurrent(): boolean; onAccessDenied(): void };
type Mount = { props: ChildProps; active: boolean; unmounts: number };
const session = (id: string | null) => id ? { user: { id, email: "synthetic@example.invalid" } } : null;
type SessionReply = { data: { session: ReturnType<typeof session> }; error?: unknown };
function pageFixture(t: TestContext, config: { configured?: boolean; transport?: Parameters<typeof clientFixture>[0] } = {}) {
  const renderer = hookRenderer(), transport = clientFixture(config.transport), mounts: Mount[] = [];
  const listeners = new Set<(event: string, value: ReturnType<typeof session>) => void>();
  const sessionGate = deferred<SessionReply>();
  const signIns: { body: { email: string; password: string }; gate: ReturnType<typeof deferred<any>> }[] = [];
  const sdkTrace: string[] = [];
  let shell: Props = {}, unsubscribes = 0, signOuts = 0, prevented = 0;
  const sdk = {
    onAuthStateChange(callback: (event: string, value: ReturnType<typeof session>) => void) {
      sdkTrace.push("subscribe"); listeners.add(callback);
      return { data: { subscription: { unsubscribe() { unsubscribes++; listeners.delete(callback); } } } };
    },
    getSession() { sdkTrace.push("getSession"); return sessionGate.promise; },
    signInWithPassword(body: { email: string; password: string }) {
      sdkTrace.push("signInWithPassword"); const gate = deferred<any>(); signIns.push({ body: { ...body }, gate }); return gate.promise;
    },
    async signOut() { sdkTrace.push("signOut"); signOuts++; return { error: null }; },
  };
  const auth = new Proxy(sdk, { get(target, key) {
    assert.ok(Object.hasOwn(target, key), `Actual page must not access signup or other SDK methods: ${String(key)}`);
    return Reflect.get(target, key);
  } });
  function ApplicationDouble(props: Props) {
    const ref = renderer.hooks.useRef<Mount | null>(null);
    if (!ref.current) { ref.current = { props: props as ChildProps, active: false, unmounts: 0 }; mounts.push(ref.current); }
    const record = ref.current; record.props = props as ChildProps;
    renderer.hooks.useLayoutEffect(() => { record.active = true; return () => { record.active = false; record.unmounts++; }; }, []);
    return jsx("section", { "data-application-actor": props.actorId });
  }
  const icon = () => null;
  const page = evaluate(pageCode, pageFile, {
    react: renderer.hooks, "react/jsx-runtime": { jsx, jsxs: jsx },
    "lucide-react": { ArrowRight: icon, Building2: icon, ClipboardList: icon, Users: icon },
    wouter: { Link: (props: Props) => jsx("a", props) },
    "@/components/portals/PortalShell": { PortalShell: (props: Props) => { shell = props; return jsx("main", { children: props.children }); } },
    "@/components/contributors/PartnerCompanyApplication": { PartnerCompanyApplication: ApplicationDouble },
    "@/lib/supabase": { supabase: { auth }, hasSupabaseFrontendEnv: config.configured !== false },
    "./partner-company-client": transport.client,
  });
  renderer.mount(page.default);
  t.after(async () => {
    renderer.dispose(); await renderer.flush();
    assert.equal(listeners.size, 0); assert.equal(unsubscribes, 1);
    assert.equal(renderer.lateWrites(), 0, "No state writes after child or page retirement");
    assert.ok(mounts.every(m => !m.active));
  });
  function input(type: string) {
    const node = renderer.nodes().find(n => n.type === "input" && n.props.type === type); assert.ok(node, `Expected ${type} input`); return node;
  }
  return {
    ...renderer, transport, mounts, signIns, sdkTrace, sessionGate,
    shell: () => shell, signOuts: () => signOuts, prevented: () => prevented,
    emit(id: string | null, event = id ? "SIGNED_IN" : "SIGNED_OUT") { for (const callback of [...listeners]) callback(event, session(id)); },
    async ready(id: string | null) { await renderer.flush(); sessionGate.resolve({ data: { session: session(id) } }); await renderer.flush(); },
    child() { const child = mounts.filter(m => m.active).at(-1); assert.ok(child, "Expected actual page to mount application boundary"); return child; },
    input,
    async fill(email = "  Synthetic.Owner@Example.Invalid  ", password = "synthetic-password-only") {
      input("email").props.onChange({ target: { value: email } });
      input("password").props.onChange({ target: { value: password } }); await renderer.flush();
    },
    submit() {
      const form = renderer.nodes().find(n => n.type === "form"); assert.ok(form, "Expected applicant login form");
      form.props.onSubmit({ preventDefault() { prevented++; } });
    },
  };
}

test("actual page and client transpile and export callable entry points", async t => {
  const f = pageFixture(t); await f.flush(); assert.equal(typeof f.transport.client.companyRequestForActor, "function");
});

for (const operation of ["context", "submit", "read", "close"] as const) {
  test(`client ${operation}: exact path/body, actor guard, and same-origin privacy options`, async () => {
    const data = Object.freeze({ synthetic: operation });
    const f = clientFixture({ respond: async () => reply({ success: true, data }) });
    const opts = options(operation), request = f.client.companyRequestForActor(actorA, () => true);
    assert.equal(await request(opts), data);
    assert.equal(f.calls.length, 1); const { path, init } = f.calls[0];
    assert.equal(path, operation === "context" || operation === "submit" ? `/api/crm/partner-entry/company?op=${operation}`
      : operation === "read" ? `/api/crm/partner-company?requestId=${requestId}&sourceId=${sourceId}` : "/api/crm/partner-company");
    assert.equal(init.method, operation === "read" ? "GET" : "POST");
    assert.equal(init.signal, opts.signal); assert.equal(init.expectedUserId, actorA); assert.equal(init.dispatchGuard(), true);
    assert.equal(init.credentials, "same-origin"); assert.equal(init.mode, "same-origin"); assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store"); assert.equal(init.referrerPolicy, "no-referrer");
    if (operation === "read") { assert.equal(init.body, undefined); assert.equal(init.headers, undefined); }
    else {
      assert.deepEqual({ ...init.headers }, { "Content-Type": "application/json" });
      assert.deepEqual(JSON.parse(init.body as string), operation === "context" ? {} : operation === "submit" ? submitBody
        : { operation: "close", requestId, sourceId });
    }
    const url = new URL(path, origin);
    assert.equal(url.origin, origin);
    assert.equal([...url.searchParams.keys()].some(k => /actor|email|workspace|owner|token/i.test(k)), false);
    assert.equal(JSON.stringify(init.headers ?? {}).includes("Authorization"), false);
    assert.equal(JSON.stringify(init.body ?? "").includes(actorA), false);
    assert.deepEqual(f.trace, ["config", "crmFetch", "token"]);
  });
}

for (const [name, apiUrl] of [
  ["remote API origin", (p: string) => `https://remote.example.invalid${p}`],
  ["protocol downgrade", (p: string) => `http://company-page.example.invalid${p}`],
  ["different port", (p: string) => `https://company-page.example.invalid:8443${p}`],
  ["protocol-relative remote", (p: string) => `//remote.example.invalid${p}`],
  ["same-origin prefix", (p: string) => `/prefix${p}`],
  ["query injection", (p: string) => `${p}&actorId=${actorB}`],
  ["same-origin username", (p: string) => `https://synthetic@company-page.example.invalid${p}`],
  ["same-origin password without username", (p: string) => `https://:synthetic-password@company-page.example.invalid${p}`],
  ["same-origin username and password", (p: string) => `https://synthetic:synthetic-password@company-page.example.invalid${p}`],
  ["same-origin encoded username", (p: string) => `https://%73ynthetic@company-page.example.invalid${p}`],
  ["same-origin fragment", (p: string) => `${origin}${p}#synthetic-fragment`],
] as const) {
  test(`client: ${name} is refused before token lookup or crmFetch`, async () => {
    const f = clientFixture({ apiUrl });
    await assert.rejects(f.client.companyRequestForActor(actorA, () => true)(options()), error => {
      assert.ok(error instanceof CrmApiError); assert.equal(error.status, 503); assert.equal(error.code, "same_origin_required"); return true;
    });
    assert.equal(f.calls.length, 0); assert.equal(f.tokenReads(), 0); assert.deepEqual(f.trace, ["config"]);
  });
}

test("client: an exact absolute same-origin API URL is permitted", async () => {
  const f = clientFixture({ apiUrl: p => origin + p });
  await f.client.companyRequestForActor(actorA, () => true)(options("read")); assert.equal(f.calls.length, 1);
});

test("client: tuple query values are encoded, never interpreted as actor or email selectors", async () => {
  const f = clientFixture();
  const opts = options("read", { requestId: `${requestId}&actorId=${actorB}`, sourceId: `${sourceId}#email=synthetic@example.invalid` });
  await f.client.companyRequestForActor(actorA, () => true)(opts);
  assert.deepEqual(Object.fromEntries(new URL(f.calls[0].path, origin).searchParams), { requestId: opts.requestId, sourceId: opts.sourceId });
});

for (const operation of ["context", "close"] as const) {
  test(`client ${operation}: ignores unrelated body selectors`, async () => {
    const f = clientFixture();
    await f.client.companyRequestForActor(actorA, () => true)(options(operation, {
      body: { actorId: actorB, email: "forged@example.invalid", workspaceId: actorB, operation: "approve" },
    }));
    assert.deepEqual(JSON.parse(f.calls[0].init.body as string), operation === "context" ? {} : { operation: "close", requestId, sourceId });
  });
}

for (const [actorCurrent, viewCurrent] of [[true, true], [true, false], [false, true], [false, false]]) {
  test(`client: dispatchGuard composes actor=${actorCurrent}, view=${viewCurrent}`, async () => {
    const gate = deferred<Reply>(), f = clientFixture({ respond: () => gate.promise });
    const pending = f.client.companyRequestForActor(actorA, () => actorCurrent)(options("context", { isCurrent: () => viewCurrent }));
    assert.equal(f.calls[0].init.dispatchGuard(), actorCurrent && viewCurrent);
    const result = actorCurrent && viewCurrent ? pending : assert.rejects(pending, isAbort);
    gate.resolve(reply()); await result;
  });
}

for (const boundary of ["actor", "view"] as const) {
  test(`client: stale ${boundary} after response prevents JSON consumption`, async () => {
    let current = true, jsonReads = 0;
    const gate = deferred<Reply>(), f = clientFixture({ respond: () => gate.promise });
    const pending = f.client.companyRequestForActor(actorA, () => boundary === "actor" ? current : true)(
      options("read", { isCurrent: () => boundary === "view" ? current : true }));
    const rejected = assert.rejects(pending, isAbort); current = false;
    assert.equal(f.calls[0].init.dispatchGuard(), false);
    gate.resolve({ ok: true, status: 200, async json() { jsonReads++; return { success: true, data: {} }; } });
    await rejected; assert.equal(jsonReads, 0); assert.equal(f.calls.length, 1);
  });

  test(`client: stale ${boundary} while JSON is held cannot deliver success`, async () => {
    let current = true;
    const json = deferred<unknown>(), entered = deferred<void>();
    const f = clientFixture({ respond: async () => ({ ok: true, status: 200, json() { entered.resolve(); return json.promise; } }) });
    const pending = f.client.companyRequestForActor(actorA, () => boundary === "actor" ? current : true)(
      options("submit", { isCurrent: () => boundary === "view" ? current : true }));
    const rejected = assert.rejects(pending, isAbort); await entered.promise; current = false;
    json.resolve({ success: true, data: { committed: "must-not-deliver" } }); await rejected; assert.equal(f.calls.length, 1);
  });
}

for (const boundary of ["response", "json"] as const) {
  test(`client: abort during held ${boundary} refuses late success even when crmFetch ignores abort`, async () => {
    const controller = new AbortController(), json = deferred<unknown>(), response = deferred<Reply>(), entered = deferred<void>();
    const f = clientFixture({ respond: () => boundary === "response" ? response.promise : Promise.resolve({
      ok: true, status: 200, json() { entered.resolve(); return json.promise; },
    }) });
    const pending = f.client.companyRequestForActor(actorA, () => true)(options("submit", { signal: controller.signal }));
    const rejected = assert.rejects(pending, isAbort);
    if (boundary === "json") await entered.promise;
    controller.abort(); response.resolve(reply()); json.resolve({ success: true, data: {} }); await rejected;
  });
}

for (const status of [401, 403, 409, 500]) {
  test(`client: HTTP ${status} is a typed error and cannot be confirmed by a success envelope`, async () => {
    let jsonReads = 0;
    const f = clientFixture({ respond: async () => ({ ok: false, status, async json() { jsonReads++; return { success: true, data: {} }; } }) });
    await assert.rejects(f.client.companyRequestForActor(actorA, () => true)(options()), error => {
      assert.ok(error instanceof CrmApiError); assert.equal(error.status, status); assert.equal(error.code, "partner_company_request_failed"); return true;
    });
    assert.equal(jsonReads, 0); assert.equal(f.calls.length, 1);
  });
}

test("client: malformed envelopes never become successful acknowledgements", async () => {
  for (const value of [undefined, null, false, 0, "payload", [], {}, { data: {} }, { success: true },
    { success: "true", data: {} }, { success: false, data: {} }]) {
    const f = clientFixture({ respond: async () => ({ ok: true, status: 200, json: async () => value }) });
    await assert.rejects(f.client.companyRequestForActor(actorA, () => true)(options())); assert.equal(f.calls.length, 1);
  }
});

test("client: network and JSON failures stay rejected without retries", async () => {
  for (const phase of ["network", "json"]) {
    const failure = new Error(`Synthetic ${phase} failure`);
    const f = clientFixture({ respond: async () => {
      if (phase === "network") throw failure;
      return { ok: true, status: 200, async json() { throw failure; } };
    } });
    await assert.rejects(f.client.companyRequestForActor(actorA, () => true)(options()), error => error === failure);
    assert.equal(f.calls.length, 1);
  }
});

test("page: subscribes before session lookup and shows no login or application while bootstrap is held", async t => {
  const f = pageFixture(t); await f.flush();
  assert.deepEqual(f.sdkTrace, ["subscribe", "getSession"]);
  assert.equal(f.nodes().filter(n => n.props.role === "status").length, 1);
  assert.equal(f.nodes().some(n => n.type === "form"), false); assert.equal(f.mounts.length, 0);
  assert.equal(f.transport.calls.length, 0);
});

test("page: anonymous login has only existing-account credentials and never calls signup", async t => {
  const f = pageFixture(t); await f.ready(null);
  assert.equal(f.input("email").props.autoComplete, "username");
  assert.equal(f.input("password").props.autoComplete, "current-password");
  assert.equal(f.nodes().filter(n => n.type === "button" && n.props.type === "submit").length, 1);
  assert.equal(f.nodes().some(n => n.type === "input" && n.props.autoComplete === "new-password"), false);
  assert.equal(f.shell().onSignOut, undefined);
  assert.equal(JSON.stringify(f.shell().items).includes("signup"), false);
  assert.deepEqual(f.sdkTrace, ["subscribe", "getSession"]);
});

test("page: existing-account sign-in normalizes email, clears password, and blocks duplicate dispatch", async t => {
  const f = pageFixture(t); await f.ready(null); await f.fill();
  f.submit(); f.submit(); await f.flush();
  assert.equal(f.prevented(), 2); assert.equal(f.signIns.length, 1);
  assert.deepEqual({ ...f.signIns[0].body }, { email: "synthetic.owner@example.invalid", password: "synthetic-password-only" });
  assert.equal(f.input("password").props.value, "");
  assert.equal(f.input("email").props.disabled, true); assert.equal(f.input("password").props.disabled, true);
  f.signIns[0].gate.resolve({ error: null, data: { session: session(actorA) } }); await f.flush();
  assert.equal(f.mounts.length, 0, "A returned SDK session does not replace the auth event boundary");
  assert.equal(f.transport.calls.length, 0); assert.equal(f.sdkTrace.includes("signup"), false);
  f.emit(actorA); await f.flush(); assert.equal(f.child().props.actorId, actorA);
});

for (const failure of ["returned", "thrown"] as const) {
  test(`page: ${failure} sign-in failure restores login without mounting an application`, async t => {
    const f = pageFixture(t); await f.ready(null); await f.fill(); f.submit(); await f.flush();
    if (failure === "returned") f.signIns[0].gate.resolve({ error: new Error("Synthetic rejection"), data: { session: null } });
    else f.signIns[0].gate.reject(new Error("Synthetic offline"));
    await f.flush(); assert.equal(f.input("password").props.disabled, false);
    assert.ok(f.nodes().some(n => n.props.role === "status")); assert.equal(f.mounts.length, 0); assert.equal(f.signIns.length, 1);
  });
}

test("page: unconfigured sign-in never reaches the SDK or company transport", async t => {
  const f = pageFixture(t, { configured: false }); await f.ready(null); await f.fill(); f.submit(); await f.flush();
  assert.equal(f.signIns.length, 0); assert.equal(f.transport.calls.length, 0);
  assert.ok(f.nodes().some(n => n.props.role === "status")); assert.equal(f.input("password").props.disabled, false);
});

for (const outcome of ["success", "error", "rejection"] as const) {
  test(`page: bootstrap ${outcome} settles to the corresponding child or login`, async t => {
    const f = pageFixture(t); await f.flush();
    if (outcome === "rejection") f.sessionGate.reject(new Error("Synthetic session lookup failure"));
    else f.sessionGate.resolve({ data: { session: session(actorA) }, error: outcome === "error" ? new Error("Synthetic session error") : null });
    await f.flush();
    if (outcome === "success") assert.equal(f.child().props.actorId, actorA);
    else { assert.equal(f.mounts.length, 0); assert.ok(f.input("email")); }
  });
}

for (const late of ["actorA", "signedOut", "error", "rejection"] as const) {
  test(`page: late getSession ${late} cannot replace an observed auth event`, async t => {
    const f = pageFixture(t); await f.flush(); f.emit(actorB); await f.flush(); const child = f.child();
    if (late === "rejection") f.sessionGate.reject(new Error("Synthetic late rejection"));
    else f.sessionGate.resolve({ data: { session: session(late === "actorA" ? actorA : null) },
      error: late === "error" ? new Error("Synthetic late error") : null });
    await f.flush(); assert.equal(f.child(), child); assert.equal(child.props.actorId, actorB);
    assert.equal(child.props.isSessionCurrent(), true); assert.equal(f.mounts.length, 1);
  });
}

test("page: signed-out auth event wins over a late signed-in getSession", async t => {
  const f = pageFixture(t); await f.flush(); f.emit(null); await f.flush();
  f.sessionGate.resolve({ data: { session: session(actorA) } }); await f.flush();
  assert.ok(f.input("email")); assert.equal(f.mounts.length, 0);
});

test("page: actor ABA retires the first child even when both events precede the next render", async t => {
  const f = pageFixture(t); await f.ready(actorA);
  const old = f.child(), oldScope = old.props.isSessionCurrent, request = old.props.request;
  f.emit(actorB); assert.equal(oldScope(), false);
  f.emit(actorA); assert.equal(oldScope(), false, "An old A lifetime must not revive after A-B-A");
  old.props.onAccessDenied(); await f.flush();
  const current = f.child(); assert.notEqual(current, old); assert.notEqual(current.props.request, request);
  assert.equal(old.active, false); assert.equal(old.unmounts, 1);
  assert.equal(current.props.actorId, actorA); assert.equal(current.props.isSessionCurrent(), true);
  assert.equal(f.nodes().some(n => n.props.role === "alert"), false);
});

test("page: token refresh for the same actor preserves the child and its request lifetime", async t => {
  const f = pageFixture(t); await f.ready(actorA); const old = f.child(), request = old.props.request;
  f.emit(actorA, "TOKEN_REFRESHED"); await f.flush();
  assert.equal(f.child(), old); assert.equal(old.props.request, request); assert.equal(old.props.isSessionCurrent(), true);
  assert.equal(old.unmounts, 0);
});

test("page: sign-out retires the application immediately and renders existing-account login", async t => {
  const f = pageFixture(t); await f.ready(actorA); const old = f.child();
  f.emit(null); assert.equal(old.props.isSessionCurrent(), false); await f.flush();
  assert.equal(old.active, false); assert.equal(old.unmounts, 1); assert.ok(f.input("email"));
  assert.equal(f.shell().onSignOut, undefined);
});

test("page: a typed 403 reaches the actual parent denial callback and unmounts its application", async t => {
  const f = pageFixture(t, { transport: { respond: async () => reply({ success: true, data: {} }, 403) } });
  await f.ready(actorA); const old = f.child();
  await assert.rejects(old.props.request(options()), error => {
    assert.ok(error instanceof CrmApiError); assert.equal(error.status, 403); return true;
  });
  old.props.onAccessDenied(); await f.flush();
  assert.equal(old.active, false); assert.equal(old.unmounts, 1);
  assert.equal(f.mounts.filter(m => m.active).length, 0);
  assert.ok(f.nodes().some(n => n.type === "section" && n.props.role === "alert"));
  assert.ok(f.nodes().some(n => n.type === "a" && n.props.href === "/login"));
  f.emit(actorA, "TOKEN_REFRESHED"); await f.flush(); assert.equal(f.mounts.filter(m => m.active).length, 0);
  f.emit(actorB); await f.flush(); assert.equal(f.child().props.actorId, actorB);
});

test("page/client: actor ABA during held JSON rejects the old request and cannot deny the new child", async t => {
  const json = deferred<unknown>(), entered = deferred<void>();
  const f = pageFixture(t, { transport: { respond: async () => ({ ok: true, status: 200,
    json() { entered.resolve(); return json.promise; } }) } });
  await f.ready(actorA); const old = f.child();
  const pending = old.props.request(options("submit")), rejected = assert.rejects(pending, isAbort);
  await entered.promise; f.emit(actorB); f.emit(actorA); await f.flush();
  assert.equal(f.transport.calls[0].init.expectedUserId, actorA); assert.equal(f.transport.calls[0].init.dispatchGuard(), false);
  json.resolve({ success: true, data: { synthetic: "old-A" } }); await rejected;
  old.props.onAccessDenied(); await f.flush();
  assert.notEqual(f.child(), old); assert.equal(f.child().props.actorId, actorA);
  assert.equal(f.nodes().some(n => n.props.role === "alert"), false);
});

test("page: late sign-in rejection after actor change cannot update the retired login", async t => {
  const f = pageFixture(t); await f.ready(null); await f.fill(); f.submit(); await f.flush();
  f.emit(actorA); await f.flush(); const child = f.child();
  f.signIns[0].gate.reject(new Error("Synthetic late login failure")); await f.flush();
  assert.equal(f.child(), child); assert.equal(f.lateWrites(), 0); assert.equal(f.nodes().some(n => n.props.role === "status"), false);
});

test("page: late bootstrap completion after unmount cannot write state", async t => {
  const f = pageFixture(t); await f.flush(); f.dispose();
  f.sessionGate.resolve({ data: { session: session(actorA) } }); await f.flush();
  assert.equal(f.lateWrites(), 0); assert.equal(f.mounts.length, 0);
});

test("page: late sign-in success after unmount cannot write state or mount an application", async t => {
  const f = pageFixture(t); await f.ready(null); await f.fill(); f.submit(); await f.flush(); f.dispose();
  f.signIns[0].gate.resolve({ error: null, data: { session: session(actorA) } }); await f.flush();
  assert.equal(f.lateWrites(), 0); assert.equal(f.mounts.length, 0);
});

test("page: authenticated sign-out delegates only to the existing SDK method", async t => {
  const f = pageFixture(t); await f.ready(actorA); assert.equal(typeof f.shell().onSignOut, "function");
  f.shell().onSignOut(); await f.flush(); assert.equal(f.signOuts(), 1);
  assert.deepEqual(f.sdkTrace, ["subscribe", "getSession", "signOut"]); assert.equal(f.transport.calls.length, 0);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { eagerControlLazy, controlFixtureType, controlFixtureSuspense, ControlFixtureComponent } from "./control-lazy-test-fixture";

// Whole production App, Operators, controlFetch and local contracts are evaluated.
// React scheduling, the Supabase SDK session API and HTTP delivery are doubles.
// The SDK double does NOT verify JWTs or exercise Supabase's real session decoder.
// Bodies use real WHATWG Response/ReadableStream and Response.json(), including
// delayed bytes and malformed JSON. No real fetch, database, account or storage.
// Profile selection is the real row callback's OperatorProfile argument, not an
// invented detail screen. Suspension is the API's revoke action. Absent filters
// are reported as skipped; this suite does not demand a new runtime feature.
// Run: node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-control-operators-actor.test.ts
// Optional local Git source snapshot: MEDINA_CONTROL_OPERATORS_TEST_BASELINE=b301f1f
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const control = path.join(root, "artifacts/medina-control/src");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const baseline = process.env.MEDINA_CONTROL_OPERATORS_TEST_BASELINE;
const origin = "https://operators.fixture.invalid";
const endpoint = "/api/crm/platform-operators";
const actorA = "00000000-0000-4000-8000-000000000001";
const actorB = "00000000-0000-4000-8000-000000000002";
const rowA = "00000000-0000-4000-8000-000000000011";
const rowB = "00000000-0000-4000-8000-000000000012";
const compiledSources = new Map<string, string>();

function compile(filename: string): string {
  const cached = compiledSources.get(filename);
  if (cached !== undefined) return cached;
  const source = baseline
    ? execFileSync("git", ["show", `${baseline}:${path.relative(root, filename).replaceAll("\\", "/")}`], { cwd: root, encoding: "utf8" })
    : readFileSync(filename, "utf8");
  const result = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
  assert.deepEqual(result.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error), []);
  compiledSources.set(filename, result.outputText);
  return result.outputText;
}

type Profile = { id: string; displayName: string; status: "pending" | "approved" | "suspended"; acceptingRequests: boolean };
type Session = { user: { id: string; email: string }; access_token: string };
type SessionResult = { data: { session: Session | null }; error: unknown };
type Props = Record<string, any> & { children?: Child };
type Element = { type: unknown; props: Props; key?: unknown };
type Child = Element | string | number | boolean | null | undefined | Child[];
type Deps = readonly unknown[] | undefined;
type Effect = () => void | (() => void);
type Slot = { kind: string; value?: any; set?: (next: any) => void; deps?: Deps; create?: Effect; cleanup?: () => void; pending?: boolean };

function profile(id = rowA, status: Profile["status"] = "pending", label = "A"): Profile {
  return { id, displayName: `Synthetic profile ${label} / contact-${label.toLowerCase()}@example.invalid`, status,
    acceptingRequests: status === "approved" };
}
function list(items: Profile[] = [profile()], hasMore = false) { return { success: true, data: { items, hasMore } }; }
function nodes(child: Child): Element[] {
  if (Array.isArray(child)) return child.flatMap(nodes);
  return child && typeof child === "object" ? [child, ...nodes(child.props.children)] : [];
}
function text(child: Child): string {
  if (Array.isArray(child)) return child.map(text).join("");
  if (child && typeof child === "object") return text(child.props.children);
  return typeof child === "string" || typeof child === "number" ? String(child) : "";
}
const jsx = (type: unknown, props: Props, key?: unknown): Element => ({ type: controlFixtureType(type), props, key });
const sameDeps = (a: Deps, b: Deps) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

function hookDriver() {
  const slots: Slot[] = [];
  let cursor = 0, dirty = true, mounted = true, rendering = false, lateWrites = 0;
  let count: number | undefined;
  let component: () => Child;
  let tree: Child;
  function slot(kind: string, create: () => Slot): Slot {
    assert.ok(rendering, "Hooks must execute during the actual component render");
    const current = slots[cursor++] ??= create();
    assert.equal(current.kind, kind, "Hook order must remain stable");
    return current;
  }
  const hooks = {
    useState(initial: any) {
      const state = slot("state", () => {
        const item: Slot = { kind: "state", value: typeof initial === "function" ? initial() : initial };
        item.set = (next: any) => {
          if (!mounted) { lateWrites++; return; }
          const value = typeof next === "function" ? next(item.value) : next;
          if (!Object.is(item.value, value)) { item.value = value; dirty = true; }
        };
        return item;
      });
      return [state.value, state.set];
    },
    useRef(initial: any) { return slot("ref", () => ({ kind: "ref", value: { current: initial } })).value; },
    useMemo(create: () => any, deps?: Deps) {
      const item = slot("memo", () => ({ kind: "memo", value: create(), deps }));
      if (!sameDeps(item.deps, deps)) { item.value = create(); item.deps = deps; }
      return item.value;
    },
    useCallback(callback: any, deps?: Deps) { return hooks.useMemo(() => callback, deps); },
    useEffect(create: Effect, deps?: Deps) {
      const item = slot("effect", () => ({ kind: "effect", create, deps, pending: true }));
      if (!sameDeps(item.deps, deps)) item.pending = true;
      item.create = create; item.deps = deps;
    },
  };
  return {
    hooks,
    mount(render: () => Child) { component = render; },
    commit() {
      if (!mounted || !dirty) return;
      dirty = false; cursor = 0; rendering = true;
      try { tree = component(); } finally { rendering = false; }
      count ??= cursor;
      assert.equal(cursor, count, "No conditional hooks");
      const effects = slots.filter((item) => item.kind === "effect" && item.pending);
      for (const item of effects) item.cleanup?.();
      for (const item of effects) { item.pending = false; item.cleanup = item.create!() || undefined; }
    },
    nodes: () => nodes(tree), text: () => text(tree), lateWrites: () => lateWrites,
    dispose() {
      if (!mounted) return;
      mounted = false;
      for (const item of slots) if (item.kind === "effect") item.cleanup?.();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Http = {
  method: string; url: URL; init: RequestInit; body?: Record<string, unknown>; authorization: string;
  claimed: boolean; settled: boolean; bodyReads: number;
  reply(body: unknown, status?: number): void;
  badJson(): void;
  lose(): void;
  holdBody(status?: number): { release(body: unknown): void };
};

async function fixture(t: TestContext) {
  const app = hookDriver();
  let current: ReturnType<typeof hookDriver> | null = null;
  let active = app;
  let disposed = false;
  const drivers = [app];
  const requests: Http[] = [];
  const releases: Array<() => void> = [];
  const confirmations: string[] = [];
  const listeners = new Set<(event: string, value: Session | null) => void>();
  let actor: string | null = actorA, epoch = 0;
  let confirm: () => boolean = () => true;
  const lookups: Array<() => SessionResult | Promise<SessionResult>> = [];
  const heldSessions: Array<ReturnType<typeof deferred<SessionResult>>> = [];
  const session = (): Session | null => actor ? { user: { id: actor, email: `synthetic-${epoch}@example.invalid` },
    access_token: `synthetic:${actor}:${epoch}` } : null;
  const snapshot = (): SessionResult => ({ data: { session: session() }, error: null });
  const auth = {
    async getSession() { return lookups.length ? lookups.shift()!() : snapshot(); },
    onAuthStateChange(callback: (event: string, value: Session | null) => void) {
      listeners.add(callback);
      return { data: { subscription: { unsubscribe() { listeners.delete(callback); } } } };
    },
  };
  function setActor(next: string | null, silent = false) {
    actor = next; epoch++;
    if (!silent) for (const callback of [...listeners]) callback(next ? "SIGNED_IN" : "SIGNED_OUT", session());
  }
  function transport(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(String(input));
    assert.equal(url.origin, origin, "No real or foreign HTTP origin is available");
    assert.equal(url.pathname, endpoint, "Only the actual Operators endpoint is available");
    assert.ok(["GET", "PATCH"].includes(init.method ?? "GET"), "No other HTTP mutation is allowed");
    assert.equal(init.redirect, "error", "Use the actual authenticated controlFetch transport");
    assert.equal(init.cache, "no-store");
    const result = deferred<Response>();
    const request: Http = {
      url, init, method: init.method ?? "GET", authorization: new Headers(init.headers).get("Authorization") || "",
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)), claimed: false, settled: false, bodyReads: 0,
      reply(body, status = 200) {
        assert.equal(request.settled, false); request.settled = true;
        result.resolve(observe(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })));
      },
      badJson() {
        assert.equal(request.settled, false); request.settled = true;
        result.resolve(observe(new Response("{", { status: 200, headers: { "Content-Type": "application/json" } })));
      },
      lose() { assert.equal(request.settled, false); request.settled = true; result.reject(new TypeError("Synthetic delivery failure")); },
      holdBody(status = 200) {
        assert.equal(request.settled, false); request.settled = true;
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let released = false;
        const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
        const release = (value: unknown) => {
          if (released) return;
          released = true;
          controller.enqueue(new TextEncoder().encode(JSON.stringify(value))); controller.close();
        };
        releases.push(() => release({ success: false }));
        result.resolve(observe(new Response(body, { status, headers: { "Content-Type": "application/json" } })));
        return { release };
      },
    };
    function observe(response: Response) {
      Object.defineProperty(response, "json", { configurable: true, writable: true, value: () => {
        request.bodyReads++;
        return Response.prototype.json.call(response);
      } });
      return response;
    }
    requests.push(request);
    // Transport cancellation deliberately does not win late-response races.
    return result.promise;
  }
  const react = new Proxy({}, { get(_target, name) {
    if (name === "lazy") return eagerControlLazy;
    if (name === "Suspense") return controlFixtureSuspense;
    if (name === "Component") return ControlFixtureComponent;
    return (...args: unknown[]) => {
    const fn = Reflect.get(active.hooks, name === "useLayoutEffect" ? "useEffect" : name);
    assert.equal(typeof fn, "function", `Unsupported React hook ${String(name)}`);
    return fn(...args);
  }; } });
  const cache = new Map<string, any>();
  function load(filename: string): any {
    if (cache.has(filename)) return cache.get(filename);
    if (filename === path.join(control, "lib/supabase.ts")) return { supabase: { auth }, controlConfig: { ready: true, apiOrigin: origin } };
    for (const name of ["Overview", "Login", "ClinicCard", "Onboarding", "Contributors", "PartnerCompanies"]) {
      if (filename === path.join(control, `screens/${name}.tsx`)) return { [name]: Symbol(name) };
    }
    const exports = {};
    cache.set(filename, exports);
    new Script(compile(filename), { filename }).runInNewContext({
      exports, module: { exports }, Error, TypeError, SyntaxError, DOMException, URL, URLSearchParams,
      Headers, Response, Request, AbortController, AbortSignal, ReadableStream, TextEncoder, TextDecoder,
      queueMicrotask, console, fetch: transport,
      window: { confirm(message: string) { confirmations.push(message); return confirm(); } },
      require(name: string) {
        if (name === "react") return react;
        if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: Symbol.for("Fragment") };
        if (filename === path.join(control, "App.tsx") && name === "./lib/api") return load(path.join(control, "lib/api.ts"));
        assert.ok(name.startsWith("."), `External dependency must not escape the fixture: ${name}`);
        const target = path.resolve(path.dirname(filename), name);
        const found = [target, `${target}.ts`, `${target}.tsx`, path.join(target, "index.ts")].find(existsSync);
        assert.ok(found, `Actual local module must exist: ${target}`);
        return load(found);
      },
    }, { timeout: 1000 });
    return exports;
  }
  const { Operators } = load(path.join(control, "screens/Operators.tsx"));
  const { default: App } = load(path.join(control, "App.tsx"));
  const contracts = load(path.join(root, "lib/crm/operator-contracts.ts"));
  app.mount(() => { active = app; return App(); });
  let mountedKey: unknown = Symbol("unmounted");
  async function flush() {
    for (let cycle = 0; cycle < 2; cycle++) {
      for (let pass = 0; pass < 80; pass++) {
        app.commit();
        if (!disposed) {
          const main = app.nodes().find((node) => node.type === "main");
          const screen = main && nodes(main).find((node) => node.type === Operators);
          if (!screen) { current?.dispose(); current = null; mountedKey = Symbol("unmounted"); }
          else {
            if (!current || !Object.is(mountedKey, main!.key)) {
              current?.dispose(); current = hookDriver(); drivers.push(current); mountedKey = main!.key;
              const view = current;
              current.mount(() => { active = view; return Operators(screen.props); });
            }
            current.commit();
          }
        }
        await Promise.resolve();
      }
      // Real Response.json() also schedules Node stream/next-tick work.
      await setImmediate();
    }
  }
  function button(label: RegExp, tree = current?.nodes() || []) {
    const found = tree.find((node) => node.type === "button" && label.test(text(node)));
    assert.ok(found, `Expected actual Operators button ${label}; rendered: ${current?.text() || ""}`);
    return found;
  }
  function invoke(node: Element, handler = "onClick", event?: unknown) {
    assert.notEqual(node.props.disabled, true, "Capture only enabled controls; invoke captured closures explicitly for staleness tests");
    assert.equal(typeof node.props[handler], "function", `Expected actual ${handler} callback`);
    node.props[handler](event);
  }
  async function open() {
    await flush();
    invoke(button(/^Операторы$/u, app.nodes()));
    await flush();
  }
  function dispose() { disposed = true; for (const driver of drivers) driver.dispose(); }
  t.after(async () => {
    dispose();
    for (const hold of heldSessions) hold.resolve(snapshot());
    for (const release of releases) release();
    for (const request of requests) if (!request.settled) request.reply({ success: false }, 503);
    await flush();
  });
  await open();
  return {
    requests, confirmations, flush, dispose, open, button, invoke, pageSize: contracts.OPERATOR_PAGE_SIZE,
    text: () => disposed ? "" : current?.text() || "", nodes: () => disposed ? [] : current?.nodes() || [],
    lateWrites: () => drivers.reduce((sum, driver) => sum + driver.lateWrites(), 0),
    setActor,
    refreshToken() {
      epoch++;
      for (const callback of [...listeners]) callback("TOKEN_REFRESHED", session());
    },
    async changeActor(next: string | null) { setActor(next); await flush(); if (next) await open(); },
    async close() { invoke(button(/^Обзор$/u, app.nodes())); await flush(); },
    confirmWith(fn: () => boolean) { confirm = fn; },
    take(method = "GET") {
      const request = requests.find((item) => !item.claimed && item.method === method);
      assert.ok(request, `Expected fake ${method}; saw ${requests.map((item) => `${item.method} ${item.url.search}`).join(", ")}`);
      request.claimed = true; return request;
    },
    action(id: string, kind: "approve" | "suspend" = "approve") {
      const row = current?.nodes().find((node) => node.key === id);
      assert.ok(row, `Expected actual rendered profile ${id}; rendered: ${current?.text() || ""}`);
      return button(kind === "approve" ? /^Одобрить$/u : /^Приостановить$/u, nodes(row));
    },
    filter() {
      return current?.nodes().find((node) => node.type === "select"
        && nodes(node).some((option) => option.type === "option" && option.props.value === "pending"));
    },
    async click(label: RegExp) { invoke(button(label)); await flush(); },
    holdSession() {
      const hold = deferred<SessionResult>(); heldSessions.push(hold); lookups.push(() => hold.promise);
      return { release: (result = snapshot()) => hold.resolve(result) };
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function ready(t: TestContext, items = [profile()], hasMore = false) {
  const f = await fixture(t); f.take().reply(list(items, hasMore)); await f.flush(); return f;
}
function captured(node: Element, handler = "onClick"): (...args: any[]) => void {
  assert.notEqual(node.props.disabled, true);
  assert.equal(typeof node.props[handler], "function");
  return node.props[handler];
}
function noPrivateState(f: Fixture) { assert.doesNotMatch(f.text(), /Synthetic profile|contact-[a-z]+@example\.invalid/u); }
function noMutation(f: Fixture) {
  const writes = f.requests.filter((item) => item.method === "PATCH");
  assert.equal(writes.length, 0, `No privileged send expected; actual fake sends: ${JSON.stringify(writes.map((item) => ({ authorization: item.authorization, body: item.body })))}`);
}

for (const action of ["approve", "suspend"] as const) {
  test(`Operators authorized ${action}: real row callback and controlFetch preserve actor, target and payload`, async (t) => {
    const item = profile(rowA, action === "approve" ? "pending" : "approved");
    const f = await ready(t, [item]); f.invoke(f.action(item.id, action)); await f.flush();
    const request = f.take("PATCH");
    assert.deepEqual(request.body, { id: rowA, action });
    assert.match(request.authorization, new RegExp(`^Bearer synthetic:${actorA}:`));
    assert.equal(new Headers(request.init.headers).get("Content-Type"), "application/json");
    assert.equal(f.confirmations.length, 1);
    request.reply({ success: true, data: { ...item, status: action === "approve" ? "approved" : "suspended", acceptingRequests: false } });
    await f.flush(); f.take().reply(list([{ ...item, status: action === "approve" ? "approved" : "suspended", acceptingRequests: false }])); await f.flush();
    assert.match(f.text(), /Synthetic profile A/u); assert.equal(f.lateWrites(), 0);
  });

  for (const boundary of ["A/B", "A/B/A", "unmount", "same-actor remount", "confirmation actor switch", "confirmation A/B/A"] as const) {
    test(`Operators old ${action} closure cannot dispatch after ${boundary}`, async (t) => {
      const item = profile(rowA, action === "approve" ? "pending" : "approved");
      const f = await ready(t, [item]); const act = captured(f.action(rowA, action));
      if (boundary === "unmount") f.dispose();
      else if (boundary === "confirmation actor switch") f.confirmWith(() => { f.setActor(actorB); return true; });
      else if (boundary === "confirmation A/B/A") f.confirmWith(() => { f.setActor(actorB); f.setActor(actorA); return true; });
      else if (boundary === "same-actor remount") {
        await f.close(); await f.open(); f.take().reply(list([profile(rowB, "pending", "Fresh")])); await f.flush();
      }
      else {
        await f.changeActor(actorB); f.take().reply(list([profile(rowB, "pending", "B")])); await f.flush();
        if (boundary === "A/B/A") { await f.changeActor(actorA); f.take().reply(list([profile(rowB, "pending", "Fresh")])); await f.flush(); }
      }
      const before = f.text(), confirmations = f.confirmations.length;
      act(); await f.flush();
      noMutation(f);
      if (!boundary.startsWith("confirmation")) assert.equal(f.confirmations.length, confirmations, "Stale private profile must not even reopen confirmation");
      if (!boundary.startsWith("confirmation")) assert.equal(f.text(), before);
      assert.equal(f.lateWrites(), 0, "No stale busy/error/revision writes");
    });
  }
}

test("Operators cancelled confirmation sends no mutation and leaves the live view usable", async (t) => {
  const f = await ready(t); f.confirmWith(() => false); f.invoke(f.action(rowA)); await f.flush();
  noMutation(f); assert.equal(f.confirmations.length, 1); assert.notEqual(f.button(/^Обновить список$/u).props.disabled, true);
});

test("Operators locks before confirmation and rejects synchronous duplicate action invocations", async (t) => {
  const f = await ready(t); const act = captured(f.action(rowA)); act(); act(); await f.flush();
  assert.equal(f.confirmations.length, 1); assert.equal(f.requests.filter((item) => item.method === "PATCH").length, 1);
});

test("Operators profile-selection callback from a replaced list cannot mutate the old profile", async (t) => {
  const f = await ready(t); const oldProfile = captured(f.action(rowA));
  await f.click(/^Обновить список$/u); f.take().reply(list([profile(rowB, "pending", "B")])); await f.flush();
  const before = f.text(); oldProfile(); await f.flush();
  noMutation(f); assert.equal(f.text(), before); assert.equal(f.confirmations.length, 0); assert.equal(f.lateWrites(), 0);
});

test("Operators live pagination uses the real page size and stale pagination cannot fetch or restore old profiles", async (t) => {
  const f = await ready(t, [profile()], true); const oldNext = captured(f.button(/^Далее$/u));
  await f.click(/^Далее$/u); const next = f.take(); assert.equal(next.url.searchParams.get("offset"), String(f.pageSize));
  next.reply(list([profile(rowB, "pending", "Page2")])); await f.flush();
  await f.changeActor(actorB); f.take().reply(list([profile(rowB, "pending", "B")])); await f.flush();
  const before = f.text(), requests = f.requests.length; oldNext(); await f.flush();
  assert.equal(f.requests.length, requests); assert.equal(f.text(), before); assert.equal(f.lateWrites(), 0);
});

test("Operators actual status-filter callback, when present, cannot survive a different actor lifetime", async (t) => {
  const f = await ready(t); const filter = f.filter();
  if (!filter) { t.skip("This production module has no status-filter control; no new UI feature is assumed"); return; }
  const change = captured(filter, "onChange");
  await f.changeActor(actorB); f.take().reply(list([profile(rowB, "pending", "B")])); await f.flush();
  const before = f.text(), requests = f.requests.length; change({ target: { value: "pending" } }); await f.flush();
  assert.equal(f.requests.length, requests); assert.equal(f.text(), before); assert.equal(f.lateWrites(), 0);
});

for (const boundary of ["A/B/A", "unmount", "same-actor remount"] as const) {
  for (const delivery of ["headers", "body"] as const) {
    test(`Operators delayed list ${delivery} cannot publish original profile/contact after ${boundary}`, async (t) => {
      const f = await fixture(t); const old = f.take();
      const held = delivery === "body" ? old.holdBody() : null; await f.flush();
      if (boundary === "unmount") f.dispose();
      else if (boundary === "same-actor remount") {
        await f.close(); await f.open(); f.take().reply(list([profile(rowB, "pending", "Fresh")])); await f.flush();
      }
      else {
        await f.changeActor(actorB); f.take().reply(list([profile(rowB, "pending", "B")])); await f.flush();
        await f.changeActor(actorA); f.take().reply(list([profile(rowB, "pending", "Fresh")])); await f.flush();
      }
      const before = f.text(), count = f.requests.length;
      if (held) held.release(list()); else old.reply(list()); await f.flush();
      assert.equal(f.text(), before); assert.equal(f.requests.length, count); assert.equal(f.lateWrites(), 0);
    });
  }
  for (const delivery of ["headers", "body", "network error"] as const) {
    test(`Operators delayed mutation ${delivery} cannot change error/busy/revision after ${boundary}`, async (t) => {
      const f = await ready(t); f.invoke(f.action(rowA)); await f.flush(); const old = f.take("PATCH");
      const held = delivery === "body" ? old.holdBody() : null; await f.flush();
      if (boundary === "unmount") f.dispose();
      else if (boundary === "same-actor remount") {
        await f.close(); await f.open(); f.take().reply(list([profile(rowB, "pending", "Fresh")])); await f.flush();
      }
      else {
        await f.changeActor(actorB); f.take().reply(list([profile(rowB, "pending", "B")])); await f.flush();
        await f.changeActor(actorA); f.take().reply(list([profile(rowB, "pending", "Fresh")])); await f.flush();
      }
      const before = f.text(), count = f.requests.length;
      const result = { success: true, data: profile(rowA, "approved") };
      if (held) held.release(result); else if (delivery === "network error") old.lose(); else old.reply(result);
      await f.flush(); assert.equal(f.text(), before); assert.equal(f.requests.length, count); assert.equal(f.lateWrites(), 0);
    });
  }
}

for (const status of [401, 403, 404]) {
  for (const operation of ["list", "approve", "suspend"] as const) {
    test(`Operators ${status} ${operation} refusal clears private state at headers without reading its body`, async (t) => {
      const f = operation === "list" ? await fixture(t) : await ready(t, [profile(rowA, operation === "approve" ? "pending" : "approved")]);
      if (operation !== "list") { f.invoke(f.action(rowA, operation)); await f.flush(); }
      const request = f.take(operation === "list" ? "GET" : "PATCH");
      const held = request.holdBody(status); await f.flush();
      noPrivateState(f); assert.equal(request.bodyReads, 0, "An authorization refusal must not await or decode private response bytes");
      assert.match(f.text(), /(?:Доступ[^.]*закрыт|Доступ только у владельца|Страница не найдена)/u,
        "Publish the actual denied view without waiting for response bytes; a full-page refusal need not be an alert");
      assert.ok(!f.nodes().some((node) => node.type === "button" && /^(Одобрить|Приостановить)$/u.test(text(node))));
      const before = f.text(); held.release({ success: true, error: "Synthetic private refusal body", data: profile() }); await f.flush();
      assert.equal(f.text(), before); assert.doesNotMatch(f.text(), /Synthetic private refusal body/u);
    });
  }
}

for (const status of [401, 403, 404]) {
  test(`Operators captured action remains invalid after a ${status} refusal in the same actor lifetime`, async (t) => {
    const f = await ready(t); const oldAction = captured(f.action(rowA)); oldAction(); await f.flush();
    const first = f.take("PATCH"); const held = first.holdBody(status); await f.flush();
    noPrivateState(f); const sends = f.requests.length, prompts = f.confirmations.length;
    oldAction(); await f.flush();
    assert.equal(f.requests.length, sends, "Authorization denial must invalidate already-captured privileged callbacks, not only hide their buttons");
    assert.equal(f.confirmations.length, prompts, "Do not redisplay a denied private profile in confirmation");
    held.release({ success: false });
  });
  test(`Operators captured refresh and pagination remain invalid after a ${status} refusal`, async (t) => {
    const f = await ready(t, [profile()], true);
    const oldRefresh = captured(f.button(/^Обновить список$/u));
    const oldNext = captured(f.button(/^Далее$/u));
    f.invoke(f.action(rowA)); await f.flush(); const held = f.take("PATCH").holdBody(status); await f.flush();
    noPrivateState(f); const sends = f.requests.length, before = f.text();
    oldRefresh(); oldNext(); await f.flush();
    assert.equal(f.requests.length, sends, "Denied views must not be restarted through a saved list-control callback");
    assert.equal(f.text(), before); assert.equal(f.lateWrites(), 0); held.release({ success: false });
  });
}

test("Operators malformed JSON uses the real Response decoder and fails closed without actionable profiles", async (t) => {
  const f = await fixture(t); const request = f.take(); request.badJson(); await f.flush();
  assert.equal(request.bodyReads, 1); noPrivateState(f); noMutation(f);
  assert.ok(f.nodes().some((node) => node.props.role === "alert" && text(node).trim()));
});

test("Operators authorized empty list is distinct from denied or unreadable data", async (t) => {
  const f = await ready(t, []); assert.match(f.text(), /Заявок пока нет/u);
  assert.ok(!f.nodes().some((node) => node.props.role === "alert")); noMutation(f);
});

for (const delivery of ["headers", "body"] as const) {
  test(`Operators superseded same-actor page ${delivery} cannot resurrect a selected profile or its contact`, async (t) => {
    const f = await ready(t, [profile()], true); const oldAction = captured(f.action(rowA));
    await f.click(/^Далее$/u); const oldPage = f.take(); const held = delivery === "body" ? oldPage.holdBody() : null; await f.flush();
    await f.click(/^Назад$/u); f.take().reply(list([profile(rowB, "pending", "Fresh")])); await f.flush();
    const before = f.text(), count = f.requests.length;
    if (held) held.release(list([profile(rowA, "approved")])); else oldPage.reply(list([profile(rowA, "approved")]));
    await f.flush(); oldAction(); await f.flush();
    assert.equal(f.text(), before); assert.equal(f.requests.length, count); assert.equal(f.confirmations.length, 0);
  });
}

for (const [name, payload] of [
  ["missing success", { data: { items: [profile()], hasMore: false } }],
  ["truthy nonboolean success", { success: "yes", data: { items: [profile()], hasMore: false } }],
  ["nonboolean pagination", { success: true, data: { items: [profile()], hasMore: "yes" } }],
  ["invalid status", { success: true, data: { items: [{ ...profile(), status: "root" }], hasMore: false } }],
  ["invalid availability", { success: true, data: { items: [{ ...profile(), acceptingRequests: "yes" }], hasMore: false } }],
  ["mixed valid and invalid rows", { success: true, data: { items: [profile(), { ...profile(rowB), displayName: null }], hasMore: false } }],
] as const) {
  test(`Operators rejects ${name} instead of exposing actionable partial profiles`, async (t) => {
    const f = await fixture(t); f.take().reply(payload); await f.flush(); noPrivateState(f);
    assert.ok(f.nodes().some((node) => node.props.role === "alert" && text(node).trim())); noMutation(f);
  });
}

test("Operators actual App redacts a silent SDK actor mismatch, blocks PATCH, and remounts a usable fresh view", async (t) => {
  const f = await ready(t);
  const oldAction = captured(f.action(rowA)), hold = f.holdSession();
  oldAction(); await f.flush();
  assert.match(f.text(), /Synthetic profile A/u);
  assert.equal(f.button(/^Обновить список$/u).props.disabled, true, "Exercise the already rendered busy/private state before invalidation");
  noMutation(f);

  // Change only the SDK's stored session. No SDK auth event may help the App.
  f.setActor(actorB, true); hold.release(); await f.flush();
  noMutation(f); noPrivateState(f);
  assert.ok(!f.nodes().some((node) => node.type === "button" && /^Обновить список$/u.test(text(node)) && node.props.disabled === true),
    "The retired private view must not stay visibly busy after the API invalidates it");
  const prompts = f.confirmations.length;
  oldAction(); await f.flush();
  noMutation(f); assert.equal(f.confirmations.length, prompts, "The transport-driven remount must retire the captured A action");
  assert.equal(f.lateWrites(), 0);

  await f.open();
  const read = f.take();
  assert.match(read.authorization, new RegExp(`^Bearer synthetic:${actorB}:`));
  assert.equal(read.url.searchParams.get("offset"), "0");
  noPrivateState(f);
  read.reply(list([profile(rowB, "pending", "FreshB")])); await f.flush();
  assert.match(f.text(), /Synthetic profile FreshB/u);
  assert.doesNotMatch(f.text(), /Synthetic profile A|contact-a@example\.invalid/u);
  assert.notEqual(f.button(/^Обновить список$/u).props.disabled, true, "Fresh owner-verified state must remain usable, not stuck busy");
  noMutation(f); assert.equal(f.lateWrites(), 0);
});

test("Operators same-actor token refresh preserves the live callback and uses the rotated token", async (t) => {
  const item = profile(), f = await ready(t, [item]);
  const action = captured(f.action(rowA)), before = f.text(), reads = f.requests.length;
  f.refreshToken(); await f.flush();
  assert.equal(f.text(), before, "A token rotation must not redact or remount the same actor's ready list");
  assert.equal(f.requests.length, reads, "Same-actor TOKEN_REFRESHED is not a transport identity invalidation");
  assert.notEqual(f.button(/^Обновить список$/u).props.disabled, true);

  action(); await f.flush();
  const mutation = f.take("PATCH");
  assert.equal(mutation.authorization, `Bearer synthetic:${actorA}:1`);
  assert.deepEqual(mutation.body, { id: rowA, action: "approve" });
  const approved = { ...item, status: "approved", acceptingRequests: false } as Profile;
  mutation.reply({ success: true, data: approved }); await f.flush();
  const reload = f.take();
  assert.equal(reload.authorization, `Bearer synthetic:${actorA}:1`);
  reload.reply(list([approved])); await f.flush();
  assert.match(f.text(), /Synthetic profile A/u);
  assert.notEqual(f.button(/^Обновить список$/u).props.disabled, true);
  assert.equal(f.requests.filter((request) => request.method === "PATCH").length, 1);
  assert.equal(f.lateWrites(), 0);
});

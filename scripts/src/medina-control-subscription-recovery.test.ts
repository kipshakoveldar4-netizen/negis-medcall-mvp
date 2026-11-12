import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script } from "node:vm";
import { eagerControlLazy, controlFixtureType, controlFixtureSuspense, ControlFixtureComponent } from "./control-lazy-test-fixture";

// Runs the actual App/Overview, hooks, and local client modules. Only React's
// hook scheduling, other screen boundaries, auth, storage, and HTTP are faked.
// No source-text assertions, DOM acceptance, environment, or network access.
// Run: node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-control-subscription-recovery.test.ts
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { formatSubscriptionAmount } = await import(pathToFileURL(path.join(root,
  "artifacts/medina-control/src/lib/subscription-operation.ts")).href) as {
  formatSubscriptionAmount(priceMinor: number, currency?: string): string;
};
const control = path.join(root, "artifacts/medina-control/src");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const actorA = "00000000-0000-4000-8000-000000000001";
const actorB = "00000000-0000-4000-8000-000000000002";
const workspaceId = "00000000-0000-4000-8000-000000000011";
const activeId = "00000000-0000-4000-8000-000000000021";
const savedId = "00000000-0000-4000-8000-000000000022";
const pausedId = "00000000-0000-4000-8000-000000000023";
const cancelledId = "00000000-0000-4000-8000-000000000024";
const updatedAt = "2026-10-24T10:11:12.123456Z";
const otherKey = "00000000-0000-4000-8000-000000000031";
const subscriptionPath = "/api/crm/platform-subscriptions";

test("subscription amounts display exact minor units without unsafe floating point", () => {
  assert.equal(formatSubscriptionAmount(1_990_001), "19\u00a0900,01\u00a0₸");
  assert.equal(formatSubscriptionAmount(0), "0\u00a0₸");
  assert.equal(formatSubscriptionAmount(1, "USD"), "0,01\u00a0USD");
  assert.equal(formatSubscriptionAmount(Number.MAX_SAFE_INTEGER), "90\u00a0071\u00a0992\u00a0547\u00a0409,91\u00a0₸");
  for (const invalid of [-1, 1.01, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(formatSubscriptionAmount(invalid), "—");
});

type Props = Record<string, unknown> & { children?: Child };
type Element = { type: unknown; props: Props; key?: unknown };
type Child = Element | string | number | boolean | null | undefined | Child[];
type Dependencies = readonly unknown[] | undefined;
type Effect = () => void | (() => void);
type Slot =
  | { kind: "state"; value: unknown; set: (value: unknown) => void }
  | { kind: "ref"; value: { current: unknown } }
  | { kind: "memo"; value: unknown; deps: Dependencies }
  | { kind: "effect"; create: Effect; deps: Dependencies; cleanup?: () => void; pending: boolean };

const jsx = (type: unknown, props: Props, key?: unknown): Element => ({ type: controlFixtureType(type), props, key });
function elements(child: Child): Element[] {
  if (Array.isArray(child)) return child.flatMap(elements);
  if (child === null || typeof child !== "object") return [];
  // React retries a resolved lazy boundary; the hook-only tree has no reconciler.
  const type = controlFixtureType(child.type);
  return [type === child.type ? child : { ...child, type }, ...elements(child.props.children)];
}
function content(child: Child): string {
  if (Array.isArray(child)) return child.map(content).join("");
  if (child !== null && typeof child === "object") return content(child.props.children);
  return typeof child === "string" || typeof child === "number" ? String(child) : "";
}
function sameDeps(a: Dependencies, b: Dependencies) {
  return a !== undefined && b !== undefined && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

function hookDriver() {
  const slots: Slot[] = [];
  let cursor = 0;
  let rendering = false;
  let dirty = true;
  let mounted = true;
  let hookCount: number | undefined;
  let tree: Child;
  let component: () => Child;
  let lateWrites = 0;
  function slot<K extends Slot["kind"]>(kind: K, create: () => Extract<Slot, { kind: K }>) {
    assert.ok(rendering, "Hooks must run inside the real Overview render");
    const index = cursor++;
    slots[index] ??= create();
    assert.equal(slots[index].kind, kind, "Hook order must remain stable");
    return slots[index] as Extract<Slot, { kind: K }>;
  }
  const hooks = {
    useState<T>(initial: T | (() => T)) {
      const state = slot("state", () => {
        const current: Extract<Slot, { kind: "state" }> = {
          kind: "state", value: typeof initial === "function" ? (initial as () => T)() : initial,
          set(update) {
            if (!mounted) { lateWrites++; return; }
            const next = typeof update === "function" ? (update as (previous: unknown) => unknown)(current.value) : update;
            if (!Object.is(next, current.value)) { current.value = next; dirty = true; }
          },
        };
        return current;
      });
      return [state.value as T, state.set] as const;
    },
    useRef<T>(initial: T) { return slot("ref", () => ({ kind: "ref", value: { current: initial } })).value; },
    useMemo<T>(create: () => T, deps?: readonly unknown[]) {
      const memo = slot("memo", () => ({ kind: "memo", value: create(), deps }));
      if (!sameDeps(memo.deps, deps)) { memo.value = create(); memo.deps = deps; }
      return memo.value as T;
    },
    useCallback<T>(callback: T, deps?: readonly unknown[]) { return hooks.useMemo(() => callback, deps); },
    useEffect(create: Effect, deps?: readonly unknown[]) {
      const effect = slot("effect", () => ({ kind: "effect", create, deps, pending: true }));
      if (!sameDeps(effect.deps, deps)) effect.pending = true;
      effect.create = create;
      effect.deps = deps;
    },
  };
  function commit() {
    dirty = false;
    cursor = 0;
    rendering = true;
    try { tree = component(); } finally { rendering = false; }
    hookCount ??= cursor;
    assert.equal(cursor, hookCount, "No conditional hook calls");
    const pending = slots.filter((item): item is Extract<Slot, { kind: "effect" }> => item.kind === "effect" && item.pending);
    for (const effect of pending) effect.cleanup?.();
    for (const effect of pending) { effect.pending = false; effect.cleanup = effect.create() || undefined; }
  }
  return {
    hooks,
    mount(value: () => Child) { component = value; },
    rerender() { dirty = true; },
    async flush() {
      // Responses, including JSON parsing, are explicitly released by the test.
      for (let i = 0; i < 100; i++) { if (mounted && dirty) commit(); await Promise.resolve(); }
      if (mounted) assert.equal(dirty, false, "Overview must quiesce without timers");
    },
    nodes: () => elements(tree),
    text: () => content(tree),
    lateWrites: () => lateWrites,
    dispose() {
      if (!mounted) return;
      mounted = false;
      for (const item of slots) if (item.kind === "effect") item.cleanup?.();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function memoryStorage() {
  const values = new Map<string, string>();
  const writes: Array<[string, string]> = [];
  const reads: string[] = [];
  return {
    values, writes, reads,
    get length() { return values.size; },
    key(index: number) { return [...values.keys()][index] ?? null; },
    getItem(key: string) { reads.push(key); return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, String(value)); writes.push([key, String(value)]); },
    removeItem(key: string) { values.delete(key); },
    clear() { values.clear(); },
    snapshot() { return [...values.entries()]; },
  };
}
type Storage = ReturnType<typeof memoryStorage>;
type PendingMarker = { requestKey: string; workspaceId: string; kind: "replace" | "status" };
type Access = { actorId: string; isCurrent(): boolean };
type PendingStorageHelpers = {
  readPendingSubscription(access: Access): PendingMarker | null;
  persistPendingSubscription(access: Access, pending: PendingMarker): boolean;
  clearPendingSubscription(access: Access, pending: PendingMarker): boolean;
};
type Response = { ok: boolean; status: number; json(): Promise<unknown> };
type Request = {
  actorId: string;
  method: string;
  url: URL;
  body: Record<string, unknown> | undefined;
  rawBody: string | undefined;
  storageAtDispatch: Array<[string, string]>;
  claimed: boolean;
  settled: boolean;
  reply(body: unknown, status?: number): void;
  badJson(status?: number): void;
  lose(): void;
  delayedJson(body: Promise<unknown>, status?: number): void;
};

function clinic(hasActive = true, name = "Synthetic clinic A") {
  return {
    id: workspaceId, name, ownerEmail: "synthetic-owner@example.invalid", createdAt: "2026-01-01T00:00:00Z",
    plan: hasActive ? "basic" : "", subscriptionId: hasActive ? activeId : "",
    subscriptionStatus: hasActive ? "active" : "none", priceMinor: 1_234_500,
    currency: "KZT", billingPeriod: "yearly", monthlyMinor: 102_875,
    staffCount: 1, leadCount: 2, appointmentCount: 3, ownerAccess: null,
  };
}
function overviewBody(hasActive = true, name?: string) {
  return { success: true, data: { clinics: [clinic(hasActive, name)], totals: {
    clinics: 1, withSubscription: hasActive ? 1 : 0, paying: hasActive ? 1 : 0,
    currency: "KZT", mixedCurrencies: false, monthlyRevenueMinor: 102_875,
  } } };
}

async function fixture(t: TestContext, storage = memoryStorage(), initialActor = actorA) {
  const appDriver = hookDriver();
  let driver = hookDriver();
  let activeDriver = appDriver;
  const drivers = [appDriver, driver];
  let disposed = false;
  const dispose = () => { disposed = true; for (const current of drivers) current.dispose(); };
  t.after(dispose);
  const requests: Request[] = [];
  let actorId = initialActor;
  const listeners = new Set<(event: string, session: unknown) => void>();
  const session = () => ({ user: { id: actorId, email: "synthetic-actor@example.invalid" }, access_token: `synthetic-token-${actorId}` });
  const auth = {
    getSession: async () => ({ data: { session: session() } }),
    getUser: async () => ({ data: { user: session().user } }),
    onAuthStateChange(callback: (event: string, session: unknown) => void) {
      listeners.add(callback);
      return { data: { subscription: { unsubscribe() { listeners.delete(callback); } } } };
    },
  };
  const unexpected = (name: string): never => assert.fail(`Unexpected recovery harness dependency: ${name}`);
  const fetch = (input: string | URL, init: Record<string, unknown> = {}) => {
    const url = new URL(String(input), "https://control.fixture.invalid");
    assert.equal(url.origin, "https://control.fixture.invalid", "Only the isolated fake HTTP origin is allowed");
    assert.ok(["/api/crm/platform-overview", subscriptionPath].includes(url.pathname), "Only the tested control endpoints are allowed");
    const pending = deferred<Response>();
    const deliver = (json: () => Promise<unknown>, status: number) => {
      assert.equal(request.settled, false, "A request can settle only once");
      request.settled = true;
      pending.resolve({ status, ok: status >= 200 && status < 300, json });
    };
    const request: Request = {
      actorId, method: String(init.method ?? "GET"), url,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      rawBody: init.body === undefined ? undefined : String(init.body), claimed: false, settled: false,
      storageAtDispatch: storage.snapshot(),
      reply(body, status = 200) { deliver(async () => body, status); },
      badJson(status = 200) { deliver(async () => { throw new SyntaxError("Synthetic malformed JSON"); }, status); },
      lose() { assert.equal(request.settled, false); request.settled = true; pending.reject(new TypeError("Synthetic lost response")); },
      delayedJson(body, status = 200) { deliver(() => body, status); },
    };
    requests.push(request);
    // Ignore abort on purpose: the actual handler must reject stale completions.
    return pending.promise;
  };
  const cache = new Map<string, unknown>();
  const browserEvents = { addEventListener() {}, removeEventListener() {} };
  const react = new Proxy({}, { get(_target, name) {
    if (name === "lazy") return eagerControlLazy;
    if (name === "Suspense") return controlFixtureSuspense;
    if (name === "Component") return ControlFixtureComponent;
    return (...args: unknown[]) => {
      const hook = Reflect.get(activeDriver.hooks, name === "useLayoutEffect" ? "useEffect" : name);
      assert.equal(typeof hook, "function", `Unsupported React hook ${String(name)}`);
      return hook(...args);
    };
  } });
  function load(filename: string): any {
    if (cache.has(filename)) return cache.get(filename);
    if (filename === path.join(control, "lib/supabase.ts")) return {
      supabase: { auth }, controlConfig: { ready: true, apiOrigin: "https://control.fixture.invalid" },
    };
    for (const name of ["Login", "ClinicCard", "Onboarding", "Operators", "Contributors", "PartnerCompanies"]) {
      if (filename === path.join(control, `screens/${name}.tsx`)) return { [name]: Symbol(name) };
    }
    const source = ts.transpileModule(readFileSync(filename, "utf8"), {
      fileName: filename, reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    });
    assert.equal(source.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
    const exports = {};
    cache.set(filename, exports);
    new Script(source.outputText, { filename }).runInNewContext({
      exports, module: { exports }, console, URL, URLSearchParams, Headers, AbortController,
      Error, TypeError, SyntaxError, Date, crypto: { randomUUID }, fetch, sessionStorage: storage,
      window: { ...browserEvents, sessionStorage: storage, localStorage: { setItem: () => unexpected("localStorage persistence") } },
      document: { ...browserEvents, visibilityState: "visible" },
      require(name: string) {
        if (name === "react") return react;
        if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: Symbol.for("Fragment") };
        if (!name.startsWith(".")) return unexpected(name);
        const base = path.resolve(path.dirname(filename), name);
        const target = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find(existsSync);
        assert.ok(target, `Local dependency must exist: ${base}`);
        return load(target);
      },
    });
    return exports;
  }
  const { Overview } = load(path.join(control, "screens/Overview.tsx"));
  const { default: App } = load(path.join(control, "App.tsx"));
  const pendingStorage = load(path.join(control, "lib/subscription-operation.ts")) as PendingStorageHelpers;
  const { captureControlAccess } = load(path.join(control, "lib/api.ts")) as { captureControlAccess(): Access };
  appDriver.mount(() => { activeDriver = appDriver; return App(); });
  let mountedKey: unknown = Symbol("not mounted");
  async function flush() {
    // Reconcile the real App's keyed main boundary, not a synthetic actor key.
    for (let cycle = 0; cycle < 3; cycle++) {
      await appDriver.flush();
      if (disposed) { await driver.flush(); continue; }
      const main = appDriver.nodes().find((node) => node.type === "main");
      const screen = main && elements(main).find((node) => node.type === Overview);
      if (!screen) continue;
      if (!Object.is(mountedKey, main.key)) {
        if (typeof mountedKey !== "symbol") {
          driver.dispose();
          driver = hookDriver();
          drivers.push(driver);
        }
        mountedKey = main.key;
        driver.mount(() => { activeDriver = driver; return Overview(screen.props); });
      }
      await driver.flush();
    }
  }
  await flush();
  function invoke(node: Element, name: string, event?: unknown) {
    assert.notEqual(node.props.disabled, true, "Do not invoke disabled UI controls");
    const handler = node.props[name];
    assert.equal(typeof handler, "function", `Expected real ${name} handler`);
    return (handler as (event?: unknown) => unknown)(event);
  }
  function button(label: RegExp) {
    const found = driver.nodes().find((node) => node.type === "button" && label.test(content(node)));
    assert.ok(found, `Expected actual Overview button ${label}; rendered: ${driver.text()}`);
    return found;
  }
  function field(id: string) {
    const input = driver.nodes().find((node) => node.props.id === id);
    assert.ok(input, `Expected actual ${id} field`);
    return input;
  }
  return {
    requests, storage, flush, text: () => driver.text(), nodes: () => driver.nodes(), dispose,
    readPending: () => pendingStorage.readPendingSubscription(captureControlAccess()),
    persistPending: (pending: PendingMarker) => pendingStorage.persistPendingSubscription(captureControlAccess(), pending),
    clearPending: (pending: PendingMarker) => pendingStorage.clearPendingSubscription(captureControlAccess(), pending),
    lateWrites: () => drivers.reduce((total, current) => total + current.lateWrites(), 0),
    take(method: string, pathname: string = subscriptionPath) {
      const request = requests.find((item) => !item.claimed && item.method === method && item.url.pathname === pathname);
      assert.ok(request, `Expected ${method} ${pathname}; saw ${requests.map((r) => `${r.method} ${r.url.pathname}${r.url.search}`).join(", ")}`);
      request.claimed = true;
      return request;
    },
    async click(label: RegExp) { invoke(button(label), "onClick"); await flush(); },
    async edit() { invoke(button(/^(Изменить|Назначить)$/u), "onClick"); await flush(); },
    async change(id: string, value: string) {
      invoke(field(id), "onChange", { target: { value } });
      await flush();
    },
    async changeActor(next: string) {
      actorId = next;
      for (const listener of listeners) listener("SIGNED_IN", session());
      await flush();
    },
    button, field,
  };
}
type UI = Awaited<ReturnType<typeof fixture>>;

async function ready(t: TestContext, hasActive = true, storage?: Storage, history: Array<Record<string, unknown>> = [], clinicOverrides: Partial<ReturnType<typeof clinic>> = {}) {
  const ui = await fixture(t, storage);
  const body = overviewBody(hasActive);
  Object.assign(body.data.clinics[0], clinicOverrides);
  body.data.totals.currency = body.data.clinics[0].currency;
  ui.take("GET", "/api/crm/platform-overview").reply(body);
  await ui.flush();
  await ui.edit();
  const read = ui.requests.find((r) => r.method === "GET" && r.url.pathname === subscriptionPath && !r.url.searchParams.has("requestKey"));
  if (read) { read.claimed = true; read.reply({ success: true, data: { items: history } }); await ui.flush(); }
  return ui;
}
async function submit(ui: UI) {
  await ui.click(/^Сохранить$/u);
  return ui.take("POST");
}
function assertUnconfirmed(ui: UI) {
  assert.doesNotMatch(ui.text(), /подписка (?:не )?сохранена/iu, "An ambiguous delivery proves neither saved nor not saved");
  assert.match(ui.text(), /не подтвержд|неизвест|провер|уточн/iu, "The actual UI must expose an unresolved outcome");
}
function assertMinimalPending(storage: Storage, key: unknown) {
  assert.equal(typeof key, "string");
  assert.ok(storage.values.size > 0, "Persist a pending identifier before dispatch");
  const allowed = new Set([actorA, workspaceId, activeId, key, "replace", "status"]);
  function walk(value: unknown) {
    if (value === null || typeof value === "number" || typeof value === "boolean") return;
    if (typeof value === "string") { assert.ok(allowed.has(value), `Persist identifiers only, not ${JSON.stringify(value)}`); return; }
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    assert.ok(value && typeof value === "object");
    for (const [name, child] of Object.entries(value)) {
      assert.match(name, /^(?:v|version|kind|actorId|workspaceId|requestKey|expectedActiveId|pending|operations|requests)$/u, `Unexpected persisted field ${name}`);
      walk(child);
    }
  }
  for (const [name, value] of storage.writes) {
    assert.ok(name.includes(actorA), "Pending storage must be actor scoped");
    walk(JSON.parse(value));
    assert.doesNotMatch(value, /synthetic|example|price|currency|token|email|name|plan|payload/iu);
  }
}

for (const hasActive of [true, false]) {
  test(`POST captures stable requestKey and explicit expectedActiveId (${hasActive ? "replacement" : "first assignment"})`, async (t) => {
    const ui = await ready(t, hasActive);
    const request = await submit(ui);
    assert.equal(request.body?.workspaceId, workspaceId);
    assert.match(String(request.body?.requestKey), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
    assert.ok(Object.hasOwn(request.body!, "expectedActiveId"), "Absence is not an explicit no-active-row precondition");
    assert.equal(request.body?.expectedActiveId, hasActive ? activeId : null);
    assert.equal(request.body?.billingPeriod, "yearly", "Use the row's period, not a monthly default");
    assert.ok(request.storageAtDispatch.some(([, value]) => value.includes(String(request.body?.requestKey))), "Persist recovery identifiers before dispatch, not after the response");
    assertMinimalPending(ui.storage, request.body?.requestKey);
  });
}

for (const failure of ["lost response", "malformed JSON", "502", "HTTP 200 without receipt"] as const) {
  test(`${failure} is unconfirmed, never saved or not-saved`, async (t) => {
    const ui = await ready(t);
    const request = await submit(ui);
    if (failure === "lost response") request.lose();
    else if (failure === "malformed JSON") request.badJson();
    else if (failure === "502") request.reply({ error: "Synthetic gateway failure" }, 502);
    else request.reply({ success: true, data: {} });
    await ui.flush();
    assertUnconfirmed(ui);
    assert.ok(ui.storage.values.size > 0, "Do not forget the unresolved key");
  });
}

test("retry after a lost response sends the exact original bytes and key", async (t) => {
  const ui = await ready(t);
  await ui.change("price", "24680");
  const first = await submit(ui);
  first.lose();
  await ui.flush();
  assertUnconfirmed(ui);
  await ui.click(/повтор|ещё раз/iu);
  const retry = ui.take("POST");
  assert.equal(retry.rawBody, first.rawBody, "Retry must not regenerate key, precondition, or payload");
});

test("GET reconciliation includes the known key and null remains unconfirmed", async (t) => {
  const ui = await ready(t);
  const first = await submit(ui);
  first.lose();
  await ui.flush();
  await ui.click(/провер|уточн/iu);
  const read = ui.take("GET");
  assert.equal(read.url.searchParams.get("workspaceId"), workspaceId);
  assert.equal(read.url.searchParams.get("requestKey"), first.body?.requestKey);
  read.reply({ success: true, data: null });
  await ui.flush();
  assertUnconfirmed(ui);
  assert.ok(ui.storage.values.size > 0, "A null read cannot release a key whose POST may still arrive");
});

test("reload restores only identifiers and never auto-replays a POST", async (t) => {
  const firstUI = await ready(t);
  const first = await submit(firstUI);
  first.lose();
  await firstUI.flush();
  assertMinimalPending(firstUI.storage, first.body?.requestKey);
  firstUI.dispose();
  const restored = await fixture(t, firstUI.storage);
  restored.take("GET", "/api/crm/platform-overview").reply(overviewBody());
  await restored.flush();
  assert.equal(restored.requests.filter((r) => r.method === "POST").length, 0);
  if (!restored.requests.some((r) => r.url.pathname === subscriptionPath)) await restored.click(/провер|уточн/iu);
  const reconcile = restored.take("GET");
  assert.equal(reconcile.url.searchParams.get("requestKey"), first.body?.requestKey);
  reconcile.reply({ success: true, data: null });
  await restored.flush();
  assertUnconfirmed(restored);
  const retry = restored.nodes().find((node) => node.type === "button" && /повтор|ещё раз/iu.test(content(node)));
  assert.ok(!retry || retry.props.disabled === true, "Reload has no original payload to retry");
  assert.equal(restored.requests.filter((r) => r.method === "POST").length, 0);
});

test("a different actor cannot restore or clear another actor's pending operation", async (t) => {
  const original = await ready(t);
  const first = await submit(original);
  first.lose();
  await original.flush();
  assertMinimalPending(original.storage, first.body?.requestKey);
  original.dispose();
  const before = original.storage.snapshot();
  const other = await fixture(t, original.storage, actorB);
  other.take("GET", "/api/crm/platform-overview").reply(overviewBody());
  await other.flush();
  assert.equal(other.requests.filter((r) => r.url.pathname === subscriptionPath).length, 0);
  assert.deepEqual(original.storage.snapshot(), before);
});

test("unmount silences a late lost-response handler, including finally", async (t) => {
  const ui = await ready(t);
  const request = await submit(ui);
  ui.dispose();
  const count = ui.requests.length;
  request.lose();
  await ui.flush();
  assert.equal(ui.lateWrites(), 0, "No late flash, editor, busy, or list state writes after unmount");
  assert.equal(ui.requests.length, count, "No late overview refresh after unmount");
});

function receipt(request: Request, state: "committed" | "abandoned" = "committed") {
  const payload = request.body!;
  return { success: true, data: {
    item: state === "abandoned" ? null : {
      id: payload.subscriptionId ?? savedId, workspace_id: workspaceId, plan: payload.plan ?? "basic", status: payload.status ?? "active",
      price_minor: payload.priceMinor ?? 1_234_500, currency: payload.currency ?? "KZT",
      billing_period: payload.billingPeriod ?? "yearly", note: payload.note ?? null,
      created_at: "2026-10-25T00:00:00Z", updated_at: "2026-10-25T00:00:00Z",
    },
    operation: {
      requestKey: payload.requestKey, workspaceId, actorId: actorA,
      kind: state === "abandoned" ? null : payload.subscriptionId ? "status" : "replace", state, replayed: false,
    },
  } };
}
function assertSaved(ui: UI) {
  assert.match(ui.text(), /подписка сохранена/iu, "A validated committed receipt must show saved");
  assert.doesNotMatch(ui.text(), /(?:подписка|запрос) (?:не сохранен|отменен)|изменения не сохранены/iu);
  assert.equal(ui.storage.values.size, 0, "A terminal receipt releases the pending marker");
}
async function refreshAfterReceipt(ui: UI) {
  const refresh = ui.requests.find((r) => !r.settled && r.url.pathname === "/api/crm/platform-overview");
  refresh?.reply(overviewBody());
  await ui.flush();
}

test("a validated committed receipt, not HTTP ok alone, confirms a manual subscription edit", async (t) => {
  const ui = await ready(t);
  const request = await submit(ui);
  request.reply(receipt(request));
  await ui.flush();
  await refreshAfterReceipt(ui);
  assertSaved(ui);
  assert.doesNotMatch(ui.text(), /(?:плат[её]ж|оплата) (?:прош[её]л|подтвержден|успешн)/iu, "Administrative assignment is not real payment proof");
});

const invalidReceipts: Array<[string, (body: ReturnType<typeof receipt>) => void]> = [
  ["different actor", (body) => { body.data.operation.actorId = actorB; }],
  ["different request key", (body) => { body.data.operation.requestKey = otherKey; }],
  ["different operation workspace", (body) => { body.data.operation.workspaceId = actorB; }],
  ["different operation kind", (body) => { body.data.operation.kind = "status"; }],
  ["missing replay flag", (body) => { delete (body.data.operation as Partial<typeof body.data.operation>).replayed; }],
  ["missing item", (body) => { body.data.item = null; }],
  ["different item workspace", (body) => { body.data.item!.workspace_id = actorB; }],
  ["old active id", (body) => { body.data.item!.id = activeId; }],
  ["different plan", (body) => { body.data.item!.plan = "pro"; }],
  ["different price", (body) => { body.data.item!.price_minor = 1; }],
  ["different period", (body) => { body.data.item!.billing_period = "monthly"; }],
  ["different currency", (body) => { body.data.item!.currency = "USD"; }],
  ["non-active replacement", (body) => { body.data.item!.status = "cancelled"; }],
  ["explicit failure envelope", (body) => { body.success = false; }],
  ["missing explicit success", (body) => { delete (body as Partial<typeof body>).success; }],
  ["string success instead of true", (body) => { Reflect.set(body, "success", "true"); }],
  ["numeric success instead of true", (body) => { Reflect.set(body, "success", 1); }],
  ["null success instead of true", (body) => { Reflect.set(body, "success", null); }],
];
for (const [name, corrupt] of invalidReceipts) {
  test(`a receipt with ${name} cannot confirm or forget the operation`, async (t) => {
    const ui = await ready(t);
    const request = await submit(ui);
    const body = receipt(request);
    corrupt(body);
    request.reply(body);
    await ui.flush();
    assertUnconfirmed(ui);
    assert.ok(ui.storage.values.size > 0, "An invalid receipt must not release the key");
  });
}

test("GET reconciliation accepts a matching committed receipt after response loss", async (t) => {
  const ui = await ready(t);
  const request = await submit(ui);
  request.lose();
  await ui.flush();
  await ui.click(/провер|уточн/iu);
  const read = ui.take("GET");
  assert.equal(read.url.searchParams.get("requestKey"), request.body?.requestKey);
  const body = receipt(request);
  body.data.operation.replayed = true;
  read.reply(body);
  await ui.flush();
  await refreshAfterReceipt(ui);
  assertSaved(ui);
});

for (const action of ["check", "abandon"] as const) {
  test(`HTTP 200 ${action} receipt without explicit success cannot clear the pending key`, async (t) => {
    const ui = await ready(t);
    const request = await submit(ui);
    request.lose();
    await ui.flush();
    await ui.click(action === "check" ? /провер.*сохран/iu : /^Отменить запрос$/iu);
    const recovery = ui.take(action === "check" ? "GET" : "POST");
    const body = receipt(request, action === "check" ? "committed" : "abandoned");
    delete (body as Partial<typeof body>).success;
    const count = ui.requests.length;
    recovery.reply(body);
    await ui.flush();
    assertUnconfirmed(ui);
    assertMinimalPending(ui.storage, request.body?.requestKey);
    assert.equal(ui.requests.length, count, "An invalid terminal envelope cannot trigger a confirmed-result refresh");
  });
}

test("an abandoned receipt echoing pending kind instead of null cannot clear pending", async (t) => {
  const ui = await ready(t);
  const request = await submit(ui);
  request.lose();
  await ui.flush();
  await ui.click(/^Отменить запрос$/iu);
  const abandon = ui.take("POST");
  const body = receipt(request, "abandoned");
  body.data.operation.kind = "replace";
  abandon.reply(body);
  await ui.flush();
  assertUnconfirmed(ui);
  assertMinimalPending(ui.storage, request.body?.requestKey);
});

for (const result of ["abandoned", "committed"] as const) {
  test(`abandon POST uses only workspace/key/abandon and honors the ${result} receipt`, async (t) => {
    const ui = await ready(t);
    const request = await submit(ui);
    request.lose();
    await ui.flush();
    await ui.click(/отказ|отмен|забыть/iu);
    const abandon = ui.take("POST");
    assert.deepEqual(abandon.body, { workspaceId, requestKey: request.body?.requestKey, abandon: true });
    assert.ok(ui.storage.values.size > 0, "Clicking abandon is not itself proof of abandonment");
    abandon.reply(receipt(request, result));
    await ui.flush();
    await refreshAfterReceipt(ui);
    if (result === "committed") assertSaved(ui);
    else {
      assert.equal(ui.storage.values.size, 0);
      assert.doesNotMatch(ui.text(), /подписка сохранена/iu);
      assert.match(ui.text(), /отмен|не примен|не сохран|отказ/iu);
    }
  });
}

test("a lost abandon response leaves the key unresolved and retryable as abandon", async (t) => {
  const ui = await ready(t);
  const request = await submit(ui);
  request.lose();
  await ui.flush();
  await ui.click(/отказ|отмен|забыть/iu);
  const firstAbandon = ui.take("POST");
  firstAbandon.lose();
  await ui.flush();
  assertUnconfirmed(ui);
  assert.ok(ui.storage.values.size > 0);
  await ui.click(/отказ|отмен|забыть/iu);
  assert.equal(ui.take("POST").rawBody, firstAbandon.rawBody);
});

test("a late captured retry cannot reapply a confirmed abandoned request key", async (t) => {
  const ui = await ready(t);
  const request = await submit(ui);
  request.lose();
  await ui.flush();
  const retry = ui.button(/повтор.*сохран/iu).props.onClick as () => unknown;
  await ui.click(/^Отменить запрос$/iu);
  ui.take("POST").reply(receipt(request, "abandoned"));
  await ui.flush();
  await refreshAfterReceipt(ui);
  assert.equal(ui.storage.values.size, 0);
  const count = ui.requests.length;
  const before = ui.text();
  retry();
  await ui.flush();
  assert.equal(ui.requests.length, count, "A cancelled key cannot be redispatched by a stale UI callback");
  assert.equal(ui.text(), before);
  assert.equal(ui.storage.values.size, 0);
});

test("reload can atomically abandon without reconstructing any original edit payload", async (t) => {
  const original = await ready(t);
  const request = await submit(original);
  request.lose();
  await original.flush();
  original.dispose();
  const restored = await fixture(t, original.storage);
  restored.take("GET", "/api/crm/platform-overview").reply(overviewBody());
  await restored.flush();
  for (const read of restored.requests.filter((r) => r.url.pathname === subscriptionPath && r.method === "GET" && !r.settled)) {
    read.reply({ success: true, data: null });
  }
  await restored.flush();
  await restored.click(/отказ|отмен|забыть/iu);
  const abandon = restored.take("POST");
  assert.deepEqual(abandon.body, { workspaceId, requestKey: request.body?.requestKey, abandon: true });
  abandon.reply(receipt(request, "abandoned"));
  await restored.flush();
  assert.equal(restored.storage.values.size, 0);
  assert.equal(restored.requests.filter((r) => r.method === "POST" && r.body?.abandon !== true).length, 0);
});

test("pending recovery cannot publish or dispatch before a successful owner read", async (t) => {
  const original = await ready(t);
  const request = await submit(original);
  request.lose();
  await original.flush();
  original.dispose();
  const before = original.storage.snapshot();
  const reads = original.storage.reads.length;
  const restored = await fixture(t, original.storage);
  assert.doesNotMatch(restored.text(), /Synthetic clinic A|synthetic-owner|24680|12345/u);
  assert.equal(restored.requests.filter((r) => r.url.pathname === subscriptionPath).length, 0);
  assert.equal(restored.storage.reads.length, reads, "Do not read pending state until owner access is confirmed");
  restored.take("GET", "/api/crm/platform-overview").reply({ success: false }, 404);
  await restored.flush();
  assert.doesNotMatch(restored.text(), /Synthetic clinic A|synthetic-owner/u);
  assert.equal(restored.requests.filter((r) => r.url.pathname === subscriptionPath).length, 0);
  assert.deepEqual(restored.storage.snapshot(), before, "Owner denial must not erase an unresolved request");
});

for (const completion of ["receipt", "lost response", "malformed JSON"] as const) {
  test(`A/B/A silences an old A POST ${completion} instead of recognizing just the actor id`, async (t) => {
    const ui = await ready(t);
    const old = await submit(ui);
    await ui.changeActor(actorB);
    assert.doesNotMatch(ui.text(), /Synthetic clinic A|synthetic-owner/u, "Old actor data must disappear immediately");
    ui.take("GET", "/api/crm/platform-overview").reply(overviewBody(true, "Synthetic clinic B"));
    await ui.flush();
    await ui.changeActor(actorA);
    assert.doesNotMatch(ui.text(), /Synthetic clinic [AB]|synthetic-owner/u, "A warm cache cannot precede a new owner read");
    ui.take("GET", "/api/crm/platform-overview").reply(overviewBody(true, "Fresh actor A clinic"));
    await ui.flush();
    const before = ui.text();
    const stored = ui.storage.snapshot();
    const count = ui.requests.length;
    if (completion === "receipt") old.reply(receipt(old));
    else if (completion === "lost response") old.lose();
    else old.badJson();
    await ui.flush();
    assert.equal(ui.text(), before, "Old A's handlers, including finally, must be silent in the new A lifetime");
    assert.deepEqual(ui.storage.snapshot(), stored);
    assert.equal(ui.requests.length, count, "No stale refresh or reconciliation");
  });
}

test("A/B/A rejects an old overview JSON body even when it completes under the same actor id", async (t) => {
  const ui = await fixture(t);
  const staleBody = deferred<unknown>();
  ui.take("GET", "/api/crm/platform-overview").delayedJson(staleBody.promise);
  await ui.flush();
  await ui.changeActor(actorB);
  ui.take("GET", "/api/crm/platform-overview").reply(overviewBody(true, "Synthetic clinic B"));
  await ui.flush();
  await ui.changeActor(actorA);
  ui.take("GET", "/api/crm/platform-overview").reply(overviewBody(true, "Fresh owner-confirmed clinic"));
  await ui.flush();
  const before = ui.text();
  staleBody.resolve(overviewBody(true, "Stale forbidden cache"));
  await ui.flush();
  assert.equal(ui.text(), before);
  assert.doesNotMatch(ui.text(), /Stale forbidden cache/u);
});

test("unmount silences a committed POST body and does not clear its recovery key", async (t) => {
  const ui = await ready(t);
  const request = await submit(ui);
  const json = deferred<unknown>();
  request.delayedJson(json.promise);
  await ui.flush();
  const stored = ui.storage.snapshot();
  ui.dispose();
  const count = ui.requests.length;
  json.resolve(receipt(request));
  await ui.flush();
  assert.equal(ui.lateWrites(), 0);
  assert.deepEqual(ui.storage.snapshot(), stored);
  assert.equal(ui.requests.length, count);
});

test("two synchronous invocations of the actual save handler dispatch only one operation", async (t) => {
  const ui = await ready(t);
  const save = ui.button(/^Сохранить$/u).props.onClick as () => unknown;
  save();
  save();
  await ui.flush();
  assert.equal(ui.requests.filter((r) => r.method === "POST").length, 1);
});

test("a captured save handler from a closed editor cannot submit the new editor's draft", async (t) => {
  const ui = await ready(t);
  const save = ui.button(/^Сохранить$/u).props.onClick as () => unknown;
  await ui.click(/^Отмена$/u);
  await ui.edit();
  await ui.change("price", "24680");
  const before = ui.text();
  const requests = ui.requests.length;
  save();
  await ui.flush();
  assert.equal(ui.requests.length, requests);
  assert.equal(ui.text(), before);
});

test("unavailable session storage blocks dispatch instead of creating an unrecoverable write", async (t) => {
  const storage = memoryStorage();
  storage.setItem = () => { throw new Error("Synthetic unavailable storage"); };
  const ui = await ready(t, true, storage);
  await ui.click(/^Сохранить$/u);
  assert.equal(ui.requests.filter((r) => r.method === "POST").length, 0);
  assert.match(ui.text(), /ключ|хранилищ|восстанов/iu);
});

function historyItem(status: "active" | "paused" | "cancelled", id = status === "active" ? activeId : status === "paused" ? pausedId : cancelledId) {
  return {
    id, workspace_id: workspaceId, plan: "basic", status, price_minor: 1_234_500, currency: "KZT",
    billing_period: "yearly", note: null, started_at: "2026-01-01T00:00:00Z",
    ended_at: status === "cancelled" ? updatedAt : null, created_at: "2026-01-01T00:00:00Z", updated_at: updatedAt,
  };
}

test("the existing editor reads all subscription statuses by workspace without a request key", async (t) => {
  const rows = [historyItem("active"), historyItem("paused"), historyItem("cancelled")];
  const ui = await ready(t, true, undefined, rows);
  const history = ui.requests.find((r) => r.method === "GET" && r.url.pathname === subscriptionPath && !r.url.searchParams.has("requestKey"));
  assert.ok(history, "Opening the actual editor must load history, including paused rows absent from the active overview");
  assert.deepEqual([...history.url.searchParams.entries()], [["workspaceId", workspaceId]]);
  const terminal = ui.nodes().find((node) => node.key === cancelledId);
  assert.ok(terminal, "The cancelled history row must remain visible");
  assert.equal(elements(terminal).filter((node) => node.type === "button" && node.props.disabled !== true).length, 0, "Cancelled rows are terminal");
  assert.match(ui.text(), /пауз|приостанов/iu);
});

const transitions = [
  { from: "active", to: "paused", action: /приостанов|пауза|на паузу/iu },
  { from: "active", to: "cancelled", action: /^Отменить(?: подписку)?$/iu },
  { from: "paused", to: "active", action: /возобнов|восстанов|активир|продолж/iu },
  { from: "paused", to: "cancelled", action: /^Отменить(?: подписку)?$/iu },
] as const;

for (const { from, to, action } of transitions) {
  test(`history ${from} -> ${to} uses exact PATCH preconditions and replays without any price`, async (t) => {
    const item = historyItem(from);
    const ui = await ready(t, from === "active", undefined, [item]);
    await ui.change("price", "");
    await ui.click(action);
    const first = ui.take("PATCH");
    assert.deepEqual(first.body, {
      workspaceId, requestKey: first.body?.requestKey, subscriptionId: item.id,
      expectedUpdatedAt: updatedAt, expectedStatus: from, status: to,
    });
    assert.match(String(first.body?.requestKey), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
    assertMinimalPending(ui.storage, first.body?.requestKey);
    assert.ok(first.storageAtDispatch.some(([, value]) => value.includes('"kind":"status"')));
    first.lose();
    await ui.flush();
    assertUnconfirmed(ui);
    await ui.click(/повтор.*сохран/iu);
    const retry = ui.take("PATCH");
    assert.equal(retry.rawBody, first.rawBody, "Status retry must preserve id, timestamp precision, preconditions, target, and key");
    retry.reply(receipt(first));
    await ui.flush();
    await refreshAfterReceipt(ui);
    assertSaved(ui);
  });
}

test("a status receipt for another subscription id cannot confirm a resume", async (t) => {
  const ui = await ready(t, false, undefined, [historyItem("paused")]);
  await ui.click(/возобнов|восстанов|активир|продолж/iu);
  const request = ui.take("PATCH");
  const body = receipt(request);
  body.data.item!.id = savedId;
  request.reply(body);
  await ui.flush();
  assertUnconfirmed(ui);
  assert.ok(ui.storage.values.size > 0);
});

test("reload of an unconfirmed status PATCH uses GET or abandon, never auto-PATCH or replacement POST", async (t) => {
  const original = await ready(t, false, undefined, [historyItem("paused")]);
  await original.click(/возобнов|восстанов|активир|продолж/iu);
  const request = original.take("PATCH");
  request.lose();
  await original.flush();
  original.dispose();
  const restored = await fixture(t, original.storage);
  restored.take("GET", "/api/crm/platform-overview").reply(overviewBody(false));
  await restored.flush();
  assert.equal(restored.requests.filter((r) => r.method !== "GET").length, 0);
  await restored.click(/провер|уточн/iu);
  const read = restored.take("GET");
  assert.equal(read.url.searchParams.get("requestKey"), request.body?.requestKey);
  read.reply({ success: true, data: null });
  await restored.flush();
  assertUnconfirmed(restored);
  await restored.click(/^Отменить запрос$/iu);
  const abandon = restored.take("POST");
  assert.deepEqual(abandon.body, { workspaceId, requestKey: request.body?.requestKey, abandon: true });
  abandon.reply(receipt(request));
  await restored.flush();
  await refreshAfterReceipt(restored);
  assertSaved(restored);
  assert.equal(restored.requests.filter((r) => r.method === "PATCH" || (r.method === "POST" && r.body?.abandon !== true)).length, 0);
});

test("a paused row cannot resume over a different known active subscription", async (t) => {
  const ui = await ready(t, true, undefined, [historyItem("active"), historyItem("paused")]);
  assert.equal(ui.button(/возобнов/iu).props.disabled, true);
  assert.equal(ui.requests.filter((r) => r.method === "PATCH").length, 0);
});

test("an old editor history response cannot replace a reopened editor's rows", async (t) => {
  const ui = await fixture(t);
  ui.take("GET", "/api/crm/platform-overview").reply(overviewBody(false));
  await ui.flush();
  await ui.edit();
  const oldHistory = ui.take("GET");
  await ui.click(/^Отмена$/u);
  await ui.edit();
  const currentHistory = ui.take("GET");
  currentHistory.reply({ success: true, data: { items: [historyItem("paused")] } });
  await ui.flush();
  const before = ui.text();
  oldHistory.reply({ success: true, data: { items: [historyItem("cancelled")] } });
  await ui.flush();
  assert.equal(ui.text(), before);
  assert.ok(ui.nodes().some((node) => node.key === pausedId));
  assert.ok(!ui.nodes().some((node) => node.key === cancelledId));
});

test("unreadable history is unknown, never an empty history or permission to resume", async (t) => {
  const ui = await fixture(t);
  ui.take("GET", "/api/crm/platform-overview").reply(overviewBody(false));
  await ui.flush();
  await ui.edit();
  ui.take("GET").reply({ success: true, data: { items: [
    { ...historyItem("paused"), workspace_id: actorB },
  ] } });
  await ui.flush();
  assert.match(ui.text(), /не удалось прочитать историю|история неизвестна|список неизвестен/iu);
  assert.doesNotMatch(ui.text(), /подписок пока нет/iu);
  assert.ok(!ui.nodes().some((node) => node.type === "button" && /возобнов/iu.test(content(node))));
});

test("an existing 3990001 minor price opens as 39900.01 and saves unchanged with its yearly period", async (t) => {
  const ui = await ready(t, true, undefined, [], { priceMinor: 3_990_001, billingPeriod: "yearly" });
  assert.equal(ui.field("price").props.value, "39900.01", "Opening the editor must not truncate an existing minor unit");
  assert.equal(ui.field("period").props.value, "yearly");
  const request = await submit(ui);
  assert.equal(request.body?.priceMinor, 3_990_001);
  assert.equal(request.body?.billingPeriod, "yearly");
});

test("an existing maximum safe minor price opens and round-trips exactly", async (t) => {
  const ui = await ready(t, true, undefined, [], { priceMinor: 9_007_199_254_740_991 });
  assert.equal(ui.field("price").props.value, "90071992547409.91");
  const request = await submit(ui);
  assert.equal(request.body?.priceMinor, 9_007_199_254_740_991);
  assert.ok(request.rawBody?.includes('"priceMinor":9007199254740991'), "Serialize the exact integer, not a floating-point approximation");
});

// Expected pairs are literal contract examples, not a second money parser.
for (const [typed, expectedMinor] of [
  ["90071992547409.91", 9_007_199_254_740_991],
  ["90071992547409.90", 9_007_199_254_740_990],
  ["39900.01", 3_990_001],
  ["1.01", 101],
  ["0.29", 29],
  ["0.01", 1],
  ["0", 0],
  ["0.00", 0],
] as const) {
  test(`the actual price handler converts ${typed} to exactly ${expectedMinor} minor units`, async (t) => {
    const ui = await ready(t);
    await ui.change("price", typed);
    const request = await submit(ui);
    assert.equal(request.body?.priceMinor, expectedMinor);
    assert.equal(request.body?.currency, "KZT");
    assert.equal(request.body?.billingPeriod, "yearly");
    assertMinimalPending(ui.storage, request.body?.requestKey);
  });
}

for (const typed of [
  "1.001", "123.456", "1e2", "1E+2", "1e-2", "-1", "-0.01", "Infinity", "-Infinity", "", " \t ",
  "90071992547409.92",
]) {
  test(`price ${JSON.stringify(typed)} is rejected by the actual save handler before any request`, async (t) => {
    const ui = await ready(t);
    await ui.change("price", typed);
    const requests = ui.requests.length;
    const stored = ui.storage.snapshot();
    const writes = ui.storage.writes.length;
    await ui.click(/^Сохранить$/u);
    assert.equal(ui.requests.length, requests, "An invalid amount must not dispatch or start recovery");
    assert.deepEqual(ui.storage.snapshot(), stored);
    assert.equal(ui.storage.writes.length, writes, "Do not allocate a persisted operation for an invalid amount");
    assert.ok(ui.nodes().some((node) => typeof node.props.className === "string"
      && /\bnotice\b/u.test(node.props.className) && /\berror\b/u.test(node.props.className)
      && content(node).trim()), "Expose a validation error instead of silently rounding or accepting a different price");
  });
}

for (const billingPeriod of ["monthly", "yearly"] as const) {
  test(`an existing USD ${billingPeriod} subscription retains its currency, price, period, and price label`, async (t) => {
    const ui = await ready(t, true, undefined, [], { priceMinor: 3_990_001, currency: "USD", billingPeriod });
    const label = ui.nodes().find((node) => node.type === "label" && node.props.htmlFor === "price");
    assert.ok(label, "Inspect the label associated with the actual price input");
    assert.match(content(label), /USD|\$/u);
    assert.doesNotMatch(content(label), /KZT|₸/u, "A USD edit must not be labelled as tenge");
    assert.match(content(label), billingPeriod === "yearly" ? /год/iu : /месяц/iu);
    assert.equal(ui.field("price").props.value, "39900.01");
    assert.equal(ui.field("period").props.value, billingPeriod);
    const request = await submit(ui);
    assert.equal(request.body?.currency, "USD", "Saving must not silently convert an existing USD contract to KZT");
    assert.equal(request.body?.priceMinor, 3_990_001);
    assert.equal(request.body?.billingPeriod, billingPeriod);
  });

  test(`editing an existing USD ${billingPeriod} price sends USD rather than silently substituting KZT`, async (t) => {
    const ui = await ready(t, true, undefined, [], { currency: "USD", billingPeriod });
    await ui.change("price", "39900.01");
    const request = await submit(ui);
    assert.equal(request.body?.currency, "USD");
    assert.equal(request.body?.priceMinor, 3_990_001);
    assert.equal(request.body?.billingPeriod, billingPeriod);
  });
}

const recoveryMarker: PendingMarker = { requestKey: otherKey, workspaceId, kind: "replace" };
const corruptMarkers: Array<[string, string]> = [
  ["invalid JSON", "{"],
  ["empty raw string", ""],
  ["JSON null", "null"],
  ["JSON array", "[]"],
  ["missing all fields", "{}"],
  ["missing requestKey", JSON.stringify({ workspaceId, kind: "replace" })],
  ["missing workspaceId", JSON.stringify({ requestKey: otherKey, kind: "replace" })],
  ["missing kind", JSON.stringify({ requestKey: otherKey, workspaceId })],
  ["unexpected foreign field", JSON.stringify({ ...recoveryMarker, actorId: actorB })],
  ["foreign fields only", JSON.stringify({ actorId: actorB, version: 1, payload: {} })],
  ["invalid request UUID", JSON.stringify({ ...recoveryMarker, requestKey: "not-a-uuid" })],
  ["invalid workspace UUID", JSON.stringify({ ...recoveryMarker, workspaceId: "not-a-uuid" })],
  ["invalid operation kind", JSON.stringify({ ...recoveryMarker, kind: "payment" })],
];

function seedUnknownMarker(ui: UI, raw: string) {
  // Obtain the actor-scoped slot from the real writer, not a duplicate key rule.
  assert.equal(ui.persistPending(recoveryMarker), true);
  const slot = ui.storage.snapshot().find(([, value]) => value.includes(otherKey));
  assert.ok(slot);
  ui.storage.values.set(slot[0], raw);
  return { key: slot[0], snapshot: ui.storage.snapshot(), writes: ui.storage.writes.length };
}

async function assertUnknownRecoveryBlocksWrites(ui: UI) {
  // Attempt the real edit/save path if the bug exposes it, then assert no write.
  const editor = ui.nodes().find((node) => node.type === "button" && /^(Изменить|Назначить)$/u.test(content(node)) && node.props.disabled !== true);
  if (editor) {
    await ui.edit();
    const history = ui.take("GET");
    history.reply({ success: true, data: { items: [] } });
    await ui.flush();
    const save = ui.nodes().find((node) => node.type === "button" && /^Сохранить$/u.test(content(node)) && node.props.disabled !== true);
    if (save) await ui.click(/^Сохранить$/u);
  }
  assert.equal(ui.requests.filter((request) => request.method !== "GET").length, 0, "Unreadable pending state cannot authorize a new POST or PATCH");
  assert.doesNotMatch(ui.text(), /Synthetic clinic A|synthetic-owner/u, "Do not publish a ready overview while recovery state is unknown");
  assert.ok(ui.nodes().some((node) => typeof node.props.className === "string"
    && /\bnotice\b/u.test(node.props.className) && /\berror\b/u.test(node.props.className)), "A recovery read failure must leave Overview in a blocking load error");
}

for (const [name, raw] of corruptMarkers) {
  test(`the actual pending helper throws on ${name} and cannot erase the unknown marker`, async (t) => {
    const ui = await fixture(t);
    const seeded = seedUnknownMarker(ui, raw);
    assert.throws(() => ui.readPending(), "Only a genuinely absent raw value may mean no pending operation");
    assert.equal(ui.clearPending(recoveryMarker), false, "A corrupt marker is not permission to clear a guessed operation");
    assert.equal(ui.persistPending({ ...recoveryMarker, requestKey: savedId }), false, "A fresh operation must not overwrite unknown recovery data");
    assert.deepEqual(ui.storage.snapshot(), seeded.snapshot);
    assert.equal(ui.storage.writes.length, seeded.writes);
    assert.equal(ui.requests.filter((request) => request.method !== "GET").length, 0);
  });

  test(`Overview blocks fresh writes after ${name}, including repeated owner-read retries`, async (t) => {
    const ui = await fixture(t);
    const seeded = seedUnknownMarker(ui, raw);
    ui.take("GET", "/api/crm/platform-overview").reply(overviewBody());
    await ui.flush();
    await assertUnknownRecoveryBlocksWrites(ui);
    assert.deepEqual(ui.storage.snapshot(), seeded.snapshot);
    assert.equal(ui.storage.writes.length, seeded.writes);
    await ui.click(/^Повторить загрузку$/u);
    ui.take("GET", "/api/crm/platform-overview").reply(overviewBody());
    await ui.flush();
    await assertUnknownRecoveryBlocksWrites(ui);
    assert.deepEqual(ui.storage.snapshot(), seeded.snapshot, "A successful owner read does not repair or erase a corrupt marker");
    assert.equal(ui.storage.writes.length, seeded.writes);
  });
}

test("raw storage null alone means no pending operation and allows a fresh explicit save", async (t) => {
  const ui = await fixture(t);
  assert.equal(ui.readPending(), null);
  assert.equal(ui.storage.values.size, 0);
  ui.take("GET", "/api/crm/platform-overview").reply(overviewBody());
  await ui.flush();
  await ui.edit();
  ui.take("GET").reply({ success: true, data: { items: [] } });
  await ui.flush();
  const request = await submit(ui);
  assert.equal(request.body?.workspaceId, workspaceId);
  assert.equal(ui.requests.filter((item) => item.method === "POST").length, 1);
});

test("the actual pending helper propagates getItem failure and preserves the unreadable marker", async (t) => {
  const ui = await fixture(t);
  const seeded = seedUnknownMarker(ui, JSON.stringify(recoveryMarker));
  ui.storage.getItem = () => { throw new Error("Synthetic getItem failure"); };
  assert.throws(() => ui.readPending());
  assert.equal(ui.clearPending(recoveryMarker), false);
  assert.equal(ui.persistPending({ ...recoveryMarker, requestKey: savedId }), false);
  assert.deepEqual(ui.storage.snapshot(), seeded.snapshot);
  assert.equal(ui.storage.writes.length, seeded.writes);
});

test("Overview blocks while getItem throws, then restores the original key without auto-writing when reads recover", async (t) => {
  const ui = await fixture(t);
  const seeded = seedUnknownMarker(ui, JSON.stringify(recoveryMarker));
  const read = ui.storage.getItem;
  let unavailable = true;
  ui.storage.getItem = (key) => {
    if (unavailable) throw new Error("Synthetic transient getItem failure");
    return read(key);
  };
  ui.take("GET", "/api/crm/platform-overview").reply(overviewBody());
  await ui.flush();
  await assertUnknownRecoveryBlocksWrites(ui);
  assert.deepEqual(ui.storage.snapshot(), seeded.snapshot);
  await ui.click(/^Повторить загрузку$/u);
  ui.take("GET", "/api/crm/platform-overview").reply(overviewBody());
  await ui.flush();
  await assertUnknownRecoveryBlocksWrites(ui);
  assert.deepEqual(ui.storage.snapshot(), seeded.snapshot);

  unavailable = false;
  await ui.click(/^Повторить загрузку$/u);
  ui.take("GET", "/api/crm/platform-overview").reply(overviewBody());
  await ui.flush();
  assert.equal(ui.requests.filter((request) => request.method !== "GET").length, 0);
  assert.deepEqual(ui.storage.snapshot(), seeded.snapshot);
  assert.equal(ui.storage.writes.length, seeded.writes);
  await ui.click(/^Проверить сохранение$/u);
  const reconcile = ui.take("GET");
  assert.equal(reconcile.url.searchParams.get("requestKey"), otherKey);
  assert.equal(reconcile.url.searchParams.get("workspaceId"), workspaceId);
  reconcile.reply({ success: true, data: null });
  await ui.flush();
  assertUnconfirmed(ui);
  assert.deepEqual(ui.storage.snapshot(), seeded.snapshot);
});

for (const failure of ["corrupt marker", "getItem failure"] as const) {
  test(`the actual save handler cannot overwrite ${failure} introduced after the owner read`, async (t) => {
    const ui = await ready(t);
    const seeded = seedUnknownMarker(ui, failure === "corrupt marker" ? "{" : JSON.stringify(recoveryMarker));
    if (failure === "getItem failure") ui.storage.getItem = () => { throw new Error("Synthetic late getItem failure"); };
    await ui.click(/^Сохранить$/u);
    assert.equal(ui.requests.filter((request) => request.method !== "GET").length, 0);
    assert.deepEqual(ui.storage.snapshot(), seeded.snapshot);
    assert.equal(ui.storage.writes.length, seeded.writes, "No new marker may replace unreadable recovery data");
    assert.match(ui.text(), /ключ|хранилищ|восстанов/iu);
  });
}

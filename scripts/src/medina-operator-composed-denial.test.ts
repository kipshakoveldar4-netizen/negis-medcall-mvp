import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Execute real nested components, hooks and transport into a reconciled host tree.
// This is not a browser/React DOM test. Only CRM responses and browser storage are
// synthetic; no authentication, network, environment file or database is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const sourceRef = process.env.MEDINA_OPERATOR_COMPOSED_SOURCE_REF;
if (sourceRef !== undefined) {
  assert.match(sourceRef, /^[0-9a-f]{40}$/i, "Source ref must be a full commit SHA, never a branch or git expression");
  assert.equal(execFileSync("git", ["cat-file", "-t", sourceRef], { cwd: root, encoding: "utf8" }).trim(), "commit");
}
const files = {
  clinic: "artifacts/negis/src/components/admin/ClinicOperators.tsx",
  requests: "artifacts/negis/src/components/operators/OperatorRequests.tsx",
  leads: "artifacts/negis/src/components/operators/OperatorLeads.tsx",
  booking: "artifacts/negis/src/components/operators/OperatorBookingForm.tsx",
  catalog: "artifacts/negis/src/components/operators/OperatorServiceCatalog.tsx",
  arrivals: "artifacts/negis/src/components/operators/OperatorArrivals.tsx",
  api: "artifacts/negis/src/lib/operatorApi.ts",
  attempts: "artifacts/negis/src/lib/operatorBookingAttempt.ts",
  contracts: "lib/crm/operator-contracts.ts",
  commandHook: "artifacts/negis/src/lib/useOperatorCommand.ts",
  commandAttempts: "artifacts/negis/src/lib/operatorCommandAttempt.ts",
  commandRecovery: "artifacts/negis/src/components/operators/OperatorCommandRecovery.tsx",
};
const compiled = (async () => {
  const result: Record<string, string> = {};
  for (const [name, filename] of Object.entries(files)) {
    let source: string;
    try { source = sourceRef === undefined ? await readFile(path.join(root, filename), "utf8")
      : execFileSync("git", ["show", `${sourceRef}:${filename}`], { cwd: root, encoding: "utf8" }); }
    catch (error) {
      if (!sourceRef || !["commandHook", "commandAttempts", "commandRecovery"].includes(name)) throw error;
      // Older components never import these added modules. Refuse if they do;
      // do not replace historical application code with worktree behavior.
      source = "throw new Error('Added module is absent from reviewed baseline');";
    }
    const output = ts.transpileModule(source, {
      fileName: filename,
      reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    });
    assert.equal(output.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
    result[name] = output.outputText;
  }
  return result;
})();

type Props = Record<string, unknown> & { children?: Child };
type Element = { type: unknown; props: Props; key?: unknown };
type Child = Element | string | number | boolean | null | undefined | Child[];
type Component = (props: Props) => Child;
type Dependencies = readonly unknown[] | undefined;
type Effect = () => void | (() => void);
type Slot =
  | { kind: "state"; value: unknown; set(update: unknown): void }
  | { kind: "ref"; value: { current: unknown } }
  | { kind: "memo"; value: unknown; deps: Dependencies; initialized: boolean }
  | { kind: "effect"; layout: boolean; deps: Dependencies; committed: boolean; draft?: { create: Effect; deps: Dependencies }; cleanup?: () => void };
const jsx = (type: unknown, props: Props, key?: unknown): Element => ({ type, props, key });
const Fragment = Symbol("Fragment");
const icons = Object.fromEntries([
  "Check", "X", "RefreshCw", "ChevronLeft", "ChevronRight", "CheckCircle2", "Phone", "PhoneOff", "XCircle",
  "Save", "Search", "CalendarPlus", "Send",
].map((name) => [name, Symbol(name)]));
function isElement(child: Child): child is Element {
  return child !== null && typeof child === "object" && !Array.isArray(child);
}
function elements(child: Child): Element[] {
  if (Array.isArray(child)) return child.flatMap(elements);
  return isElement(child) ? [child, ...elements(child.props.children)] : [];
}
function text(child: Child): string {
  if (Array.isArray(child)) return child.map(text).join("");
  if (isElement(child)) return text(child.props.children);
  return typeof child === "string" || typeof child === "number" ? String(child) : "";
}
function sameDependencies(left: Dependencies, right: Dependencies) {
  return left !== undefined && right !== undefined && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]));
}

function hookDriver() {
  const slots: Slot[] = [];
  let cursor = 0;
  let hookCount: number | undefined;
  let rendering = false;
  let retry = false;
  let dirty = true;
  let staged = false;
  let disposed = false;
  let writes = 0;
  let tree: Child;
  function slot<K extends Slot["kind"]>(kind: K, create: () => Extract<Slot, { kind: K }>) {
    assert.ok(rendering, "Hooks must belong to a rendering component");
    const index = cursor++;
    if (!slots[index]) slots[index] = create();
    assert.equal(slots[index].kind, kind, "Hook order must remain stable within each instance");
    return slots[index] as Extract<Slot, { kind: K }>;
  }
  function effect(create: Effect, deps: Dependencies, layout: boolean) {
    const current = slot("effect", () => ({ kind: "effect", layout, deps: undefined, committed: false }));
    assert.equal(current.layout, layout, "Effect phase must remain stable");
    current.draft = { create, deps };
  }
  const hooks = {
    useState<T>(initial: T | (() => T)) {
      const current = slot("state", () => {
        const state: Extract<Slot, { kind: "state" }> = {
          kind: "state", value: typeof initial === "function" ? (initial as () => T)() : initial,
          set(update) {
            writes++;
            if (disposed) return;
            const next = typeof update === "function" ? (update as (previous: unknown) => unknown)(state.value) : update;
            if (rendering || !Object.is(next, state.value)) {
              state.value = next;
              dirty = true;
              if (rendering) retry = true;
            }
          },
        };
        return state;
      });
      return [current.value as T, current.set] as const;
    },
    useRef<T>(initial: T) {
      return slot("ref", () => ({ kind: "ref", value: { current: initial } })).value as { current: T };
    },
    useMemo<T>(create: () => T, deps?: Dependencies) {
      const current = slot("memo", () => ({ kind: "memo", value: undefined, deps: undefined, initialized: false }));
      if (!current.initialized || !sameDependencies(current.deps, deps)) {
        current.value = create(); current.deps = deps; current.initialized = true;
      }
      return current.value as T;
    },
    useCallback<T>(callback: T, deps?: Dependencies) { return hooks.useMemo(() => callback, deps); },
    useEffect(create: Effect, deps?: Dependencies) { effect(create, deps, false); },
    useLayoutEffect(create: Effect, deps?: Dependencies) { effect(create, deps, true); },
  };
  return {
    hooks,
    dirty: () => dirty,
    staged: () => staged,
    tree: () => tree,
    writes: () => writes,
    render(component: () => Child) {
      assert.equal(disposed, false);
      for (let attempt = 0; attempt < 25; attempt++) {
        for (const item of slots) if (item.kind === "effect") item.draft = undefined;
        cursor = 0; dirty = false; retry = false; rendering = true;
        let candidate: Child;
        try { candidate = component(); } finally { rendering = false; }
        if (hookCount === undefined) hookCount = cursor;
        assert.equal(cursor, hookCount, "Conditional hooks are unsupported");
        if (retry) continue;
        tree = candidate; staged = true;
        return;
      }
      assert.fail("Render-phase retries did not converge");
    },
    commit(layout = false) {
      const pending = slots.filter((item): item is Extract<Slot, { kind: "effect" }> => item.kind === "effect"
        && item.layout === layout && item.draft !== undefined && (!item.committed || !sameDependencies(item.deps, item.draft.deps)));
      for (const item of pending) item.cleanup?.();
      for (const item of pending) {
        const draft = item.draft!;
        item.deps = draft.deps; item.committed = true;
        item.cleanup = draft.create() || undefined;
      }
      for (const item of slots) if (item.kind === "effect" && item.layout === layout) item.draft = undefined;
      if (!layout) staged = false;
    },
    dispose() {
      if (disposed) return;
      disposed = true; dirty = false; staged = false;
      for (const item of slots) if (item.kind === "effect" && item.layout) item.cleanup?.();
      return () => {
        for (const item of slots) if (item.kind === "effect" && !item.layout) item.cleanup?.();
      };
    },
  };
}
type Instance = {
  id: number;
  input: Child;
  children: Instance[];
  tree: Child;
  driver?: ReturnType<typeof hookDriver>;
};
function renderer() {
  let active: Instance | undefined;
  let nextId = 0;
  let rootInstance: Instance | undefined;
  let input: Child;
  const history: Instance[] = [];
  const passiveDisposals: Array<() => void> = [];
  const hooks = Object.fromEntries(["useState", "useRef", "useMemo", "useCallback", "useEffect", "useLayoutEffect"].map((name) => [
    name, (...args: unknown[]) => {
      assert.ok(active?.driver, "No active component hook driver");
      return (active.driver.hooks[name as keyof typeof active.driver.hooks] as (...values: unknown[]) => unknown)(...args);
    },
  ]));
  function inside<T>(instance: Instance, call: () => T): T {
    const previous = active; active = instance;
    try { return call(); } finally { active = previous; }
  }
  function dispose(instance: Instance) {
    for (const child of instance.children) dispose(child);
    const cleanup = instance.driver?.dispose();
    if (cleanup) passiveDisposals.push(cleanup);
  }
  function compatible(left: Child, right: Child): boolean {
    if (isElement(left) && isElement(right)) return left.type === right.type && left.key === right.key;
    return Array.isArray(left) && Array.isArray(right)
      || (!isElement(left) && !isElement(right) && !Array.isArray(left) && !Array.isArray(right));
  }
  function reconcile(previous: Instance | undefined, value: Child): Instance {
    if (previous && !compatible(previous.input, value)) { dispose(previous); previous = undefined; }
    const instance = previous ?? { id: ++nextId, input: value, tree: undefined, children: [] };
    if (!previous) history.push(instance);
    const changed = instance.input !== value;
    instance.input = value;
    if (isElement(value) && typeof value.type === "function") {
      instance.driver ??= hookDriver();
      if (!previous || changed || instance.driver.dirty()) {
        inside(instance, () => instance.driver!.render(() => (value.type as Component)(value.props)));
      }
      instance.children = [reconcile(instance.children[0], instance.driver.tree())];
      instance.tree = instance.children[0].tree;
    } else if (isElement(value) || Array.isArray(value)) {
      const values = Array.isArray(value) ? value : [value.props.children];
      const unused = new Set(instance.children);
      const children = values.map((child, index) => {
        // Identity is local to the parent, then key (or position), then type.
        const previousChild = isElement(child) && child.key !== undefined
          ? instance.children.find((item) => unused.has(item) && isElement(item.input)
            && item.input.key === child.key && item.input.type === child.type)
          : instance.children[index];
        const candidate = previousChild && unused.has(previousChild) ? previousChild : undefined;
        if (candidate) unused.delete(candidate);
        return reconcile(candidate, child);
      });
      for (const removed of unused) dispose(removed);
      instance.children = children;
      const rendered = children.map((child) => child.tree);
      instance.tree = Array.isArray(value) ? rendered : { ...value, props: { ...value.props, children: rendered[0] } };
    } else { instance.tree = value; }
    return instance;
  }
  function instances(instance = rootInstance): Instance[] {
    const result: Instance[] = [];
    function visit(current: Instance) {
      result.push(current);
      for (const child of current.children) visit(child);
    }
    if (instance) visit(instance);
    return result;
  }
  function render() {
    rootInstance = reconcile(rootInstance, input);
    for (const instance of instances().reverse()) {
      if (instance.driver?.staged()) inside(instance, () => instance.driver!.commit(true));
    }
  }
  async function drain(commit: boolean) {
    for (let index = 0; index < 32; index++) {
      if (!rootInstance || instances().some((instance) => instance.driver?.dirty())) render();
      if (commit) {
        for (const cleanup of passiveDisposals.splice(0)) cleanup();
        for (const instance of instances().reverse()) {
          if (instance.driver?.staged()) inside(instance, () => instance.driver!.commit());
        }
      }
      await Promise.resolve();
    }
    assert.ok(!instances().some((instance) => instance.driver?.dirty()), "Controlled component work must quiesce");
  }
  return {
    hooks,
    origin: () => isElement(active?.input) && typeof active.input.type === "function" ? active.input.type.name : "event",
    mount(value: Child) { input = value; render(); },
    update(value: Child) { input = value; render(); },
    flush: () => drain(true),
    beforeEffects: () => drain(false),
    nodes: () => elements(rootInstance?.tree),
    content: () => text(rootInstance?.tree),
    instances: (name: string) => instances().filter((instance) => isElement(instance.input)
      && typeof instance.input.type === "function" && instance.input.type.name === name),
    writes: () => history.reduce((sum, instance) => sum + (instance.driver?.writes() ?? 0), 0),
    dispose() {
      if (rootInstance) dispose(rootInstance);
      rootInstance = undefined;
      for (const cleanup of passiveDisposals.splice(0)) cleanup();
    },
  };
}

type Pending = {
  url: string;
  method: string;
  origin: string;
  body: Record<string, unknown> | undefined;
  signal?: AbortSignal;
  expectedUserId?: string;
  dispatchGuard?: () => boolean;
  dispatched: boolean;
  claimed: boolean;
  settled: boolean;
  release(): void;
  succeed(data?: unknown): void;
  fail(status: number): void;
  authFail(status: number): void;
  reject(): void;
};
function eventTarget() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener(name: string, callback: () => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(callback);
    },
    removeEventListener(name: string, callback: () => void) { listeners.get(name)?.delete(callback); },
  };
}
async function runtime(t: TestContext, queueMutations = false, confirm = () => true) {
  const source = await compiled;
  const render = renderer();
  t.after(() => render.dispose());
  const requests: Pending[] = [];
  const dispatched: Pending[] = [];
  const storage = new Map<string, string>();
  const globals = {
    Error, AbortController, crypto: { randomUUID },
    window: { ...eventTarget(), confirm, sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    } },
    document: { ...eventTarget(), visibilityState: "visible" },
  };
  const modules = new Map<string, Record<string, unknown>>();
  class SyntheticCrmApiError extends Error {
    constructor(readonly status: number) { super(`Synthetic auth error ${status}`); }
  }
  function load(module: string): Record<string, unknown> {
    const cached = modules.get(module);
    if (cached) return cached;
    const exports: Record<string, unknown> = {};
    modules.set(module, exports);
    const require = (name: string): unknown => {
      if (name === "react") return render.hooks;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment };
      if (name === "lucide-react") return icons;
      if (name === "./OperatorRequests.css") return {};
      // These older composed cases exercise header/parent ownership, not SDK auth.
      // The separate request-lifetime suite executes the real serverAuth module.
      if (name === "@/lib/serverAuth") return { getSupabaseAccessToken: async () => "synthetic-composed-token" };
      if (name === "@/lib/supabase") return { supabase: { auth: { getSession: async () => {
        assert.fail("Unexpected signed-out SDK lookup in this composed case");
      } } } };
      if (name.endsWith("/crm/operator-contracts")) return load("contracts");
      const componentModules: Record<string, string> = {
        "@/components/operators/OperatorRequests": "requests",
        "./OperatorLeads": "leads", "./OperatorBookingForm": "booking", "./OperatorServiceCatalog": "catalog",
        "./OperatorArrivals": "arrivals", "@/lib/operatorApi": "api", "@/lib/operatorBookingAttempt": "attempts",
        "@/lib/useOperatorCommand": "commandHook", "./operatorCommandAttempt": "commandAttempts",
        "./OperatorCommandRecovery": "commandRecovery", "@/components/operators/OperatorCommandRecovery": "commandRecovery",
      };
      if (componentModules[name]) return load(componentModules[name]);
      if (name === "@/lib/api") return {
        CrmApiError: SyntheticCrmApiError,
        crmErrorMessage: (error: number | SyntheticCrmApiError) => `Synthetic CRM error ${typeof error === "number" ? error : error.status}`,
        crmFetch(url: string, init: RequestInit & { expectedUserId?: string; dispatchGuard?: () => boolean }) {
          assert.equal(init.cache, "no-store");
          let resolve!: (response: unknown) => void;
          let reject!: (error: Error) => void;
          const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
          const settle = () => { assert.equal(request.settled, false); request.settled = true; };
          const reply = (payload: unknown, status: number) => {
            assert.equal(request.dispatched, true, "Only dispatched requests may receive a server response");
            settle(); resolve({ ok: status < 400, status, json: async () => payload });
          };
          const request: Pending = {
            url, method: init.method ?? "GET", signal: init.signal ?? undefined,
            origin: render.origin(), expectedUserId: init.expectedUserId, dispatchGuard: init.dispatchGuard,
            body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
            claimed: false, settled: false, dispatched: false,
            release() {
              assert.equal(request.dispatched || request.settled, false, "Release the synthetic auth gate once");
              if (init.dispatchGuard?.() === false) {
                settle(); reject(new DOMException("Obsolete component action", "AbortError"));
                return;
              }
              request.dispatched = true;
              dispatched.push(request);
            },
            succeed(data) {
              if (data === undefined && request.method !== "GET" && /(?:operator-inbox|clinic-operator-requests)(?:\?|$)/.test(url)) {
                const body = request.body!, action = String(body.commandAction ?? body.action ?? "propose"), targetId = body.targetId ?? body.id ?? body.operatorId;
                data = body.action === "abandon" ? { state: "abandoned", commandId: body.commandId, action, targetId, closedAt: "2030-01-07T05:00:00Z" }
                  : { state: "committed", commandId: body.commandId, action, targetId, requestId: action === "propose" ? REQUEST_A : targetId,
                    statusAtCommit: ({propose:"requested",accept:"accepted",decline:"declined",withdraw:"declined",end:"ended"} as Record<string,string>)[action], committedAt: "2030-01-07T05:00:00Z" };
              }
              reply({ success: true, ...(data === undefined ? {} : { data }) }, 200);
            },
            fail(status) { reply({ success: false, error: `Synthetic failure ${status}` }, status); },
            authFail(status) { settle(); reject(new SyntheticCrmApiError(status)); },
            reject() { settle(); reject(new Error("Synthetic network failure")); },
          };
          requests.push(request);
          if (!queueMutations || request.method === "GET") request.release();
          // Once dispatched, ignore abort: outcome guards must reject late results.
          return promise;
        },
      };
      assert.fail(`Unexpected composed dependency: ${name}`);
    };
    assert.ok(source[module], `Missing compiled module ${module}`);
    new Script(source[module]).runInNewContext({ ...globals, exports, require });
    return exports;
  }
  function take(origin: string, method = "GET") {
    const request = requests.find((item) => !item.claimed && item.origin === origin && item.method === method);
    assert.ok(request, `Expected ${method} from ${origin}; pending: ${requests.filter((item) => !item.claimed).map((item) => `${item.origin} ${item.url}`).join(", ")}`);
    request.claimed = true;
    return request;
  }
  function find(predicate: (node: Element) => boolean, within?: Element) {
    const matches = (within ? elements(within.props.children) : render.nodes()).filter(predicate);
    assert.equal(matches.length, 1, `Expected exactly one host control, got ${matches.length}`);
    return matches[0];
  }
  function invoke(node: Element, event = "onClick", value?: unknown) {
    assert.notEqual(node.props.disabled, true, "Cannot activate a disabled control");
    assert.equal(typeof node.props[event], "function", `Missing ${event}`);
    (node.props[event] as (event: unknown) => void)(value ?? { preventDefault() {} });
  }
  function section(label: string) { return find((node) => node.type === "section" && node.props["aria-label"] === label); }
  function button(label: string) {
    return find((node) => node.type === "button" && (text(node.props.children) === label || node.props["aria-label"] === label));
  }
  return { render, requests, dispatched, storage, take, load, find, invoke, section, button };
}

const REQUEST_A = "11111111-1111-4111-8111-111111111111";
const REQUEST_B = "22222222-2222-4222-8222-222222222222";
const DOCTOR = "33333333-3333-4333-8333-333333333333";
const LEAD = "44444444-4444-4444-8444-444444444444";
const ACTOR = "55555555-5555-4555-8555-555555555555";
const SERVICE = "66666666-6666-4666-8666-666666666666";
const WORKSPACE = "77777777-7777-4777-8777-777777777777";
const list = (items: unknown[], extra = {}) => ({ items, hasMore: true, ...extra });
const doctors = () => list([{ id: DOCTOR, name: "Synthetic doctor", specialty: "Synthetic specialty" }]);
const services = () => list([{ id: SERVICE, name: "Synthetic catalog service", priceMinor: "100", durationMinutes: 30, currency: "KZT" }]);
const leadPhone = (scope: string) => `SYNTHETIC_LEAD_PHONE_${scope}`;
const arrivalPhone = (scope: string) => `SYNTHETIC_ARRIVAL_PHONE_${scope}`;
const labels = {
  booking: "\u0417\u0430\u043f\u0438\u0441\u044c \u043f\u0430\u0446\u0438\u0435\u043d\u0442\u0430",
  leads: "\u0417\u0430\u044f\u0432\u043a\u0438 \u043e\u043f\u0435\u0440\u0430\u0442\u043e\u0440\u0430",
  catalog: "\u041f\u0440\u0430\u0439\u0441 \u043a\u043b\u0438\u043d\u0438\u043a\u0438",
  arrivals: "\u041f\u0440\u0438\u0445\u043e\u0434\u044b \u043f\u0430\u0446\u0438\u0435\u043d\u0442\u043e\u0432",
};
type Ui = Awaited<ReturnType<typeof runtime>>;
async function populated(t: TestContext, isSessionCurrent?: () => boolean) {
  const ui = await runtime(t);
  let denied = 0;
  const onAccessDenied = () => { denied++; };
  const Requests = ui.load("requests").OperatorRequests;
  ui.render.mount(jsx(Requests, { actorId: ACTOR, onAccessDenied, isSessionCurrent }));
  await ui.render.flush();
  async function open(scope: string, requestId: string, parent = ui.take("OperatorRequests")) {
    parent.succeed(list([{
      id: requestId, status: "accepted", displayName: `Synthetic clinic ${scope}`, clinicBrief: `Synthetic agreement ${scope}`,
      pricePerArrivalMinor: "100", currency: "KZT", leadScope: "assigned",
    }]));
    await ui.render.flush();
    const toggles = ui.render.nodes().filter((node) => node.type === "button" && node.props["aria-expanded"] === false);
    assert.equal(toggles.length, 3, "Open all three real request children");
    for (const toggle of toggles) ui.invoke(toggle);
    await ui.render.flush();
    ui.take("LeadList").succeed(list([{
      id: LEAD, name: `Synthetic patient ${scope}`, phone: leadPhone(scope), status: "new", stageId: "stage-one", stageName: "Synthetic stage one",
    }], { stageEditingAvailable: true, stages: [{ id: "stage-one", name: "Synthetic stage one" }, { id: "stage-two", name: "Synthetic stage two" }] }));
    ui.take("OperatorServiceCatalog").succeed(doctors());
    ui.take("OperatorArrivals").succeed(list([{
      appointmentId: "synthetic-appointment", arrivalId: "synthetic-arrival", status: "arrived",
      clientName: `Synthetic arrival ${scope}`, clientPhone: arrivalPhone(scope), startsAt: "2026-10-11T09:00:00Z",
      priceMinor: "100", currency: "KZT", service: "Synthetic arrival service",
    }]));
    await ui.render.flush();
    ui.invoke(ui.find((node) => node.type === "select", ui.section(labels.catalog)), "onChange", { target: { value: DOCTOR } });
    await ui.render.flush();
    ui.take("Services").succeed(services());
    ui.invoke(ui.find((node) => node.type === "button" && node.props["aria-expanded"] === false, ui.section(labels.leads)));
    await ui.render.flush();
    ui.take("OperatorBookingForm").succeed({ timeZone: "Asia/Almaty" });
    await ui.render.flush();
    const fields = ui.render.instances("BookingFields")[0];
    assert.ok(fields, "The private BookingFields component must execute");
    ui.take("BookingFields").succeed(doctors());
    await ui.render.flush();
    ui.invoke(ui.find((node) => node.type === "select", ui.section(labels.booking)), "onChange", { target: { value: DOCTOR } });
    await ui.render.flush();
    ui.take("ServicePicker").succeed(services());
    await ui.render.flush();
    ui.invoke(ui.find((node) => node.type === "input" && node.props.type === "checkbox", ui.section(labels.booking)), "onChange");
    ui.invoke(ui.find((node) => node.type === "input" && node.props.type === "datetime-local", ui.section(labels.booking)), "onChange", { target: { value: "2026-10-18T09:00" } });
    await ui.render.flush();
    assert.equal(ui.render.instances("BookingFields")[0], fields, "Child hook state must survive parent and descendant updates");
    assert.equal(ui.find((node) => node.type === "input" && node.props.type === "datetime-local", ui.section(labels.booking)).props.value, "2026-10-18T09:00");
    assert.notEqual(ui.find((node) => node.type === "button" && node.props.type === "submit", ui.section(labels.booking)).props.disabled, true,
      "Real booking fields must reach a ready state, not just a boundary placeholder");
    assertVisible(ui, scope);
  }
  await open("A", REQUEST_A);
  return { ...ui, open, denied: () => denied };
}
function assertVisible(ui: Ui, scope: string) {
  assert.ok(ui.render.nodes().some((node) => node.type === "p" && text(node.props.children) === leadPhone(scope)), "The real lead phone text must render");
  assert.ok(ui.render.nodes().some((node) => node.type === "a" && node.props.href === `tel:${arrivalPhone(scope)}`), "The real arrival phone link must render");
  for (const label of Object.values(labels)) ui.section(label);
  const booking = ui.section(labels.booking);
  assert.ok(elements(booking.props.children).some((node) => node.type === "form"), "BookingFields must emit a real host form");
  assert.ok(elements(booking.props.children).some((node) => node.type === "select"), "Doctor select descendants must execute");
  assert.ok(elements(booking.props.children).some((node) => node.type === "input" && node.props.type === "datetime-local"), "Booking input descendants must execute");
}
function assertProtectedGone(ui: Ui, scope = "A") {
  assert.equal(ui.render.content().includes(leadPhone(scope)), false, "Old sibling lead phone text must be removed");
  assert.equal(ui.render.nodes().filter((node) => node.type === "a" && node.props.href === `tel:${arrivalPhone(scope)}`).length, 0, "Old sibling arrival phone link must be removed");
  assert.equal(ui.render.nodes().filter((node) => node.type === "form" || node.type === "input" || node.type === "select" || node.type === "fieldset").length, 0,
    "All protected form descendants must disappear, not merely show an error");
  assert.equal(ui.render.nodes().filter((node) => node.type === "section" && Object.values(labels).includes(node.props["aria-label"] as string)).length, 0,
    "All protected sibling sections must close together");
  assert.equal(ui.render.content().includes("Synthetic catalog service"), false);
  assert.equal(ui.render.content().includes("Synthetic patient"), false);
}
type Denial = 401 | 403 | "auth403";
function deny(request: Pending, status: Denial) {
  if (status === "auth403") request.authFail(403); else request.fail(status);
}
type ReadTarget = "booking-doctors" | "booking-services" | "catalog-doctors" | "catalog-services" | "leads" | "arrivals";
async function startRead(ui: Ui, target: ReadTarget) {
  const config: Record<ReadTarget, { origin: string; section: string; paginated?: boolean }> = {
    "booking-doctors": { origin: "BookingFields", section: labels.booking, paginated: true },
    "booking-services": { origin: "ServicePicker", section: "\u0423\u0441\u043b\u0443\u0433\u0438 \u0434\u043b\u044f \u0437\u0430\u043f\u0438\u0441\u0438", paginated: true },
    "catalog-doctors": { origin: "OperatorServiceCatalog", section: labels.catalog },
    "catalog-services": { origin: "Services", section: "\u0423\u0441\u043b\u0443\u0433\u0438 \u043c\u0430\u0441\u0442\u0435\u0440\u0430", paginated: true },
    leads: { origin: "LeadList", section: labels.leads },
    arrivals: { origin: "OperatorArrivals", section: labels.arrivals },
  };
  const { origin, section, paginated } = config[target];
  const candidates = elements(ui.section(section).props.children).filter((node) => node.type === "button"
    && elements(node.props.children).some((child) => child.type === (paginated ? icons.ChevronRight : icons.RefreshCw)));
  assert.ok(candidates.length > 0);
  // The doctor pager precedes the nested service pager in BookingFields.
  ui.invoke(candidates[0]);
  await ui.render.flush();
  return ui.take(origin);
}
async function startAction(ui: Ui, target: "stage" | "call") {
  if (target === "stage") {
    const editor = ui.find((node) => node.type === "form" && elements(node.props.children).some((child) => child.type === "select" && child.props["aria-label"]), ui.section(labels.leads));
    ui.invoke(ui.find((node) => node.type === "select", editor), "onChange", { target: { value: "stage-two" } });
    await ui.render.flush();
    const currentEditor = ui.find((node) => node.type === "form" && elements(node.props.children).some((child) => child.type === "select" && child.props["aria-label"]), ui.section(labels.leads));
    ui.invoke(currentEditor, "onSubmit");
  } else {
    const group = ui.find((node) => node.props.role === "group", ui.section(labels.arrivals));
    const first = elements(group.props.children).find((node) => node.type === "button");
    assert.ok(first); ui.invoke(first);
  }
  await ui.render.flush();
  const mutation = ui.take("event", "PATCH");
  assert.equal(mutation.expectedUserId, ACTOR);
  assert.equal(mutation.body?.[target === "stage" ? "stageId" : "result"], target === "stage" ? "stage-two" : "confirmed");
  return mutation;
}

type QueuedAction = "request" | "call" | "stage" | "booking" | "clinic-assignment" | "clinic-confirmation";
type ActionTransition = "unmount" | "actor" | "path" | "refresh" | "page";
const savedBooking = (request: Pending) => ({
  id: request.body?.requestKey, durationMinutes: 60, status: "scheduled",
  startsAt: "2026-10-18T04:00:00Z", timeZone: "Asia/Almaty", doctorName: "Synthetic doctor",
  service: "Synthetic catalog service", priceMinor: "100",
});
function savedCommand(request: Pending) {
  const body = request.body!, action = String(body.action ?? "propose"), targetId = body.id ?? body.operatorId;
  return { state: "committed", commandId: body.commandId, action, targetId, requestId: action === "propose" ? REQUEST_A : targetId,
    statusAtCommit: ({propose:"requested",accept:"accepted",decline:"declined",withdraw:"declined",end:"ended"} as Record<string,string>)[action], committedAt: "2030-01-07T05:00:00Z" };
}
for (const kind of ["proposal", "transition"] as const) {
  async function pendingCommand(t: TestContext) {
    if (kind === "proposal") { const ui = await clinicMutation(t, "send"); return { ...ui, mutation: await ui.start() }; }
    return queuedAction(t, "request");
  }
  test(`${kind} unresolved command keeps its key after an empty read and permits a new intent only after explicit closure`, async t => {
    const ui = await pendingCommand(t); ui.mutation.release(); ui.mutation.reject(); await ui.render.flush();
    const saved = [...ui.storage.entries()], attempt = JSON.parse(saved[0][1]);
    ui.invoke(ui.button("Проверить результат")); await ui.render.flush(); const read = ui.take("event", "GET");
    assert.ok(read.url.includes(`commandId=${attempt.commandId}`));
    read.succeed({ state: "unconfirmed", commandId: attempt.commandId }); await ui.render.flush();
    assert.deepEqual([...ui.storage.entries()], saved); assert.ok(ui.render.content().includes("Исходный ключ сохранён"));
    ui.invoke(ui.button("Закрыть отправку")); await ui.render.flush(); const close = ui.take("event", "PATCH");
    assert.deepEqual(close.body, { action: "abandon", commandId: attempt.commandId, commandAction: attempt.action, targetId: attempt.targetId });
    close.release(); close.succeed(); await ui.render.flush(); assert.equal(ui.storage.size, 0);
    assert.equal(ui.requests.filter(item => item.method !== "GET" && item.body?.action !== "abandon").length, 1,
      "Neither reading nor fencing may automatically resend the original business action");
    assert.ok(ui.render.content().includes("Повтор отправки закрыт"));
  });
  for (const patch of [{ commandId: REQUEST_B }, { targetId: ACTOR }, { committedAt: undefined }, { statusAtCommit: "wrong" }])
    test(`${kind} malformed business ACK ${JSON.stringify(patch)} stays unresolved and can be confirmed by original-key read`, async t => {
      const ui = await pendingCommand(t); ui.mutation.release();
      ui.mutation.succeed({ ...savedCommand(ui.mutation), ...patch }); await ui.render.flush();
      assert.equal(ui.storage.size, 1); const saved = [...ui.storage.entries()];
      assert.ok(ui.render.content().includes("Результат исходной отправки не подтверждён"));
      ui.invoke(ui.button("Проверить результат")); await ui.render.flush(); const read = ui.take("event", "GET");
      assert.ok(read.url.includes(`commandId=${ui.mutation.body?.commandId}`)); read.succeed(savedCommand(ui.mutation)); await ui.render.flush();
      assert.equal(ui.storage.size, 0); assert.equal(ui.requests.filter(item => item.method !== "GET").length, 1);
      assert.ok(ui.render.content().includes("подтверждён")); assert.ok(saved[0][1].includes(String(ui.mutation.body?.commandId)));
    });
  for (const outcome of ["success", 403] as const)
    test(`${kind} reply after explicit closure cannot clear or unlock a replacement command`, async t => {
      const ui = await pendingCommand(t); ui.mutation.release();
      ui.invoke(ui.button("Закрыть отправку")); await ui.render.flush(); const close = ui.take("event", "PATCH");
      close.release(); close.succeed(); await ui.render.flush();
      if (kind === "proposal") ui.invoke(ui.find(node => node.type === "form"), "onSubmit");
      else ui.invoke(ui.button("Завершить сотрудничество"));
      await ui.render.flush(); const current = ui.take("event", kind === "proposal" ? "POST" : "PATCH");
      assert.notEqual(current.body?.commandId, ui.mutation.body?.commandId);
      const before = [...ui.storage.entries()], writes = ui.render.writes(), count = ui.requests.length;
      if (outcome === "success") ui.mutation.succeed(savedCommand(ui.mutation)); else ui.mutation.fail(outcome);
      await ui.render.beforeEffects();
      assert.deepEqual([...ui.storage.entries()], before); assert.equal(ui.render.writes(), writes); assert.equal(ui.requests.length, count);
      assert.equal(current.settled, false);
    });
}
for (const kind of ["send", "withdraw"] as const)for (const outcome of ["success", 403] as const)
  test(`${kind} held recovery result after A-B-A cannot acknowledge the returned account's command`, async t => {
    const ui = await clinicMutation(t, kind), original = await ui.start(); original.release(); original.reject(); await ui.render.flush();
    ui.invoke(ui.button("Проверить результат")); await ui.render.flush(); const read = ui.take("event", "GET");
    await ui.replaceActor(REQUEST_B); await ui.replaceActor(ACTOR);
    const before = clinicSnapshot(ui), saved = [...ui.storage.entries()];
    if (outcome === "success") read.succeed(savedCommand(original)); else read.fail(outcome);
    await ui.render.beforeEffects(); assertClinicQuiet(ui, before); assert.deepEqual([...ui.storage.entries()], saved);
    assert.ok(ui.render.content().includes("Результат отправки ещё не подтверждён"));
  });
for (const [label, patch] of [
  ["missing identity", { id: undefined }], ["foreign request identity", { id: REQUEST_B }],
  ["missing duration", { durationMinutes: undefined }], ["numeric price", { priceMinor: 100 }],
  ["unknown status", { status: "paid" }], ["missing doctor", { doctorName: undefined }],
  ["missing service", { service: undefined }], ["invalid zone", { timeZone: "Invalid/Zone" }], ["wrong original zone", { timeZone: "UTC" }],
  ["local timestamp", { startsAt: "2026-10-18T09:00:00" }], ["impossible calendar date", { startsAt: "2026-02-30T09:00:00Z" }],
] as const) {
  test(`operator booking malformed 200 ${label} retains its key and recovers through the same intent`, async t => {
    const ui = await queuedAction(t, "booking"); ui.mutation.release();
    const original = [...ui.storage.values()][0], key = JSON.parse(original).requestKey;
    ui.mutation.succeed({ ...savedBooking(ui.mutation), ...patch }); await ui.render.flush();
    assert.equal(ui.render.instances("BookingFields").length, 1, "A malformed reply must not close the unresolved booking as successful");
    assert.equal(ui.storage.size, 1); assert.equal(JSON.parse([...ui.storage.values()][0]).requestKey, key);
    assert.equal(ui.render.content().includes("Запись сохранена:"), false);
    assert.ok(ui.render.content().includes("Сохранение не подтверждено."));
    ui.invoke(ui.find(node => node.type === "form", ui.section(labels.booking)), "onSubmit"); await ui.render.flush();
    const retry = ui.take("event", "POST"); assert.deepEqual(retry.body, ui.mutation.body);
    retry.release(); retry.succeed(savedBooking(retry)); await ui.render.flush();
    assert.equal(ui.storage.size, 0); assert.equal(ui.render.instances("BookingFields").length, 0);
    assert.ok(ui.render.content().includes("Запись сохранена:")); assert.equal(ui.denied(), 0);
  });
}
for (const [status, message] of [["cancelled", "Запись отменена"], ["no_show", "Пациент не пришёл"], ["confirmed", "Запись сохранена"]]) {
  test(`operator booking recovery displays the existing ${status} result without inventing a new active visit`, async t => {
    const ui = await queuedAction(t, "booking"); ui.mutation.release();
    ui.mutation.succeed({ ...savedBooking(ui.mutation), status }); await ui.render.flush();
    assert.equal(ui.storage.size, 0); assert.equal(ui.render.instances("BookingFields").length, 0);
    assert.ok(ui.render.content().includes(message));
    if (status !== "confirmed") assert.equal(ui.render.content().includes("Запись сохранена:"), false);
    assert.equal(ui.requests.filter(request => request.method === "POST").length, 1);
  });
}
test("operator booking explicit cleared existing metadata is acknowledged as requiring review, not a new active visit", async t => {
  const ui = await queuedAction(t, "booking"); ui.mutation.release();
  ui.mutation.succeed({ ...savedBooking(ui.mutation), startsAt: null, doctorName: null, service: "", priceMinor: null, durationMinutes: 720 });
  await ui.render.flush();
  assert.equal(ui.storage.size, 0); assert.equal(ui.render.instances("BookingFields").length, 0);
  assert.ok(ui.render.content().includes("Запись требует проверки"));
  assert.ok(ui.render.content().includes("Время не указано")); assert.ok(ui.render.content().includes("Цена не согласована"));
  assert.equal(ui.render.content().includes("Запись сохранена:"), false);
});
for (const context of [{}, { timeZone: "" }, { timeZone: "Invalid/Zone" }, { timeZone: 5 }]) {
  test(`operator booking invalid context ${JSON.stringify(context)} cannot open fields or imply a valid schedule`, async t => {
    const ui = await runtime(t), Form = ui.load("booking").OperatorBookingForm;
    ui.render.mount(jsx(Form, { actorId: ACTOR, requestId: REQUEST_A, leadId: LEAD, onBooked: () => {}, onAccessDenied: () => {} }));
    await ui.render.flush(); ui.take("OperatorBookingForm").succeed(context); await ui.render.flush();
    assert.equal(ui.render.instances("BookingFields").length, 0);
    assert.ok(ui.render.nodes().some(node => node.props.role === "alert"), "Invalid schedule metadata must be an explicit unavailable result");
  });
}
async function queuedAction(t: TestContext, target: QueuedAction, openStageBooking = false, isSessionCurrent?: () => boolean) {
  const ui = await runtime(t, true);
  let denied = 0;
  const onAccessDenied = () => { denied++; };
  const arrivals = target === "call" || target === "clinic-confirmation";
  const clinic = target === "clinic-assignment" || target === "clinic-confirmation";
  const name = target === "request" ? "OperatorRequests" : arrivals ? "OperatorArrivals" : "OperatorLeads";
  const component = ui.load(target === "request" ? "requests" : arrivals ? "arrivals" : "leads")[name];
  const props = {
    actorId: ACTOR, requestId: REQUEST_A, leadScope: "assigned",
    ...(clinic ? { workspaceId: WORKSPACE } : {}), onAccessDenied, isSessionCurrent,
  };
  ui.render.mount(jsx(component, props));
  await ui.render.flush();
  const origin = name === "OperatorLeads" ? "LeadList" : name;
  const rows = target === "request" ? [{
    id: REQUEST_A, status: "accepted", displayName: "Synthetic clinic", pricePerArrivalMinor: "100", currency: "KZT", leadScope: "assigned",
  }] : arrivals ? [{
    appointmentId: "synthetic-appointment", arrivalId: target === "clinic-confirmation" ? null : "synthetic-arrival", status: "arrived",
    clientName: "Synthetic arrival", clientPhone: arrivalPhone("queued"), startsAt: "2026-10-18T09:00:00Z",
    priceMinor: "100", currency: "KZT",
  }] : [{ id: LEAD, name: "Synthetic patient", phone: leadPhone("queued"), status: "new", stageId: "stage-one" }];
  const initialRead = ui.take(origin);
  initialRead.succeed(list(rows, {
    stageEditingAvailable: true, stages: [{ id: "stage-one", name: "Synthetic stage one" }, { id: "stage-two", name: "Synthetic stage two" }],
  }));
  await ui.render.flush();
  if (target === "stage" && openStageBooking) {
    ui.invoke(ui.find((node) => node.type === "button" && node.props["aria-expanded"] === false, ui.section(labels.leads)));
    await ui.render.flush();
    ui.take("OperatorBookingForm").succeed({ timeZone: "Asia/Almaty" });
    await ui.render.flush();
    ui.take("BookingFields").succeed(doctors());
    await ui.render.flush();
    ui.find((node) => node.type === "form", ui.section(labels.booking));
  }
  if (target === "booking") {
    ui.invoke(ui.find((node) => node.type === "button" && node.props["aria-expanded"] === false, ui.section(labels.leads)));
    await ui.render.flush();
    ui.take("OperatorBookingForm").succeed({ timeZone: "Asia/Almaty" });
    await ui.render.flush();
    ui.take("BookingFields").succeed(doctors());
    await ui.render.flush();
    ui.invoke(ui.find((node) => node.type === "select", ui.section(labels.booking)), "onChange", { target: { value: DOCTOR } });
    await ui.render.flush();
    ui.take("ServicePicker").succeed(services());
    await ui.render.flush();
    ui.invoke(ui.find((node) => node.type === "input" && node.props.type === "checkbox", ui.section(labels.booking)), "onChange");
    ui.invoke(ui.find((node) => node.type === "input" && node.props.type === "datetime-local", ui.section(labels.booking)), "onChange", { target: { value: "2026-10-18T09:00" } });
    await ui.render.flush();
    assert.equal(ui.render.instances("BookingFields").length, 1);
    assert.equal(ui.render.instances("ServicePicker").length, 1);
    assert.notEqual(ui.find((node) => node.type === "button" && node.props.type === "submit", ui.section(labels.booking)).props.disabled, true);
    ui.invoke(ui.find((node) => node.type === "form", ui.section(labels.booking)), "onSubmit");
  } else if (target === "request") {
    const article = ui.find((node) => node.type === "article");
    ui.invoke(ui.find((node) => node.type === "button" && node.props.disabled === false, article));
  } else if (target === "clinic-assignment") {
    ui.invoke(ui.find((node) => node.type === "input" && node.props.type === "checkbox", ui.section(labels.leads)), "onChange", { target: { checked: true } });
  } else if (target === "clinic-confirmation") {
    const article = ui.find((node) => node.type === "article", ui.section(labels.arrivals));
    ui.invoke(ui.find((node) => node.type === "button" && elements(node.props.children).some((child) => child.type === icons.CheckCircle2), article));
  }
  let mutation: Pending;
  if (target === "stage" || target === "call") mutation = await startAction(ui, target);
  else {
    await ui.render.flush();
    mutation = ui.take("event", target === "booking" || target === "clinic-confirmation" ? "POST" : "PATCH");
  }
  assert.equal(mutation.expectedUserId, props.actorId);
  assert.equal(mutation.dispatched, false, "The real event handler must wait at the synthetic auth gate");
  if (target === "request") {
    assert.deepEqual(mutation.body, { id: REQUEST_A, action: "end", commandId: mutation.body?.commandId });
    assert.match(String(mutation.body?.commandId), /^[0-9a-f-]{36}$/i);
  }
  if (target === "clinic-assignment") {
    assert.equal(mutation.url, `/api/crm/clinic-operator-leads?workspaceId=${WORKSPACE}&requestId=${REQUEST_A}&search=`);
    assert.deepEqual(mutation.body, { leadId: LEAD, assigned: true });
  }
  if (target === "clinic-confirmation") {
    assert.equal(mutation.url, `/api/crm/clinic-operator-arrivals?workspaceId=${WORKSPACE}&requestId=${REQUEST_A}`);
    assert.deepEqual(mutation.body, { appointmentId: "synthetic-appointment" });
  }
  if (target === "booking") {
    assert.equal(mutation.url, `/api/crm/operator-bookings?requestId=${REQUEST_A}`);
    assert.equal(ui.storage.size, 1, "The real booking attempt must persist before POST");
    const attempt = JSON.parse([...ui.storage.values()][0]);
    assert.deepEqual({ ...attempt.payload, requestKey: attempt.requestKey }, mutation.body);
    assert.equal(attempt.actorId, ACTOR);
    assert.equal(attempt.requestId, REQUEST_A);
    assert.equal(attempt.payload.leadId, LEAD);
    assert.deepEqual(attempt.payload.serviceIds, [SERVICE]);
    assert.match(attempt.requestKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  }
  const owner = ui.render.instances(name)[0];
  const listOwner = ui.render.instances(origin)[0];
  async function transition(change: ActionTransition) {
    if (change === "unmount") ui.render.update(null);
    else if (change === "actor") ui.render.update(jsx(component, { ...props, actorId: REQUEST_B }));
    else if (change === "path") ui.render.update(jsx(component, {
      ...props, ...(target === "request" || clinic ? { workspaceId: REQUEST_B } : { requestId: REQUEST_B }),
    }));
    else {
      const section = target === "request" ? ui.find((node) => node.type === "section")
        : ui.section(arrivals ? labels.arrivals : labels.leads);
      ui.invoke(ui.find((node) => node.type === "button" && elements(node.props.children)
        .some((child) => child.type === (change === "page" ? icons.ChevronRight : icons.RefreshCw))
        && (target !== "request" || change !== "refresh" || node.props["aria-label"] === "Обновить предложения"), section));
    }
    await ui.render.beforeEffects();
    assert.equal(initialRead.signal?.aborted, false, "Release queued actions before passive list cleanup can abort");
    if (change !== "unmount") assert.equal(ui.render.instances(name)[0], owner, "Keep the real outer component instance across scope changes");
    if (change === "actor" || change === "refresh") assert.equal(ui.render.instances(origin)[0], listOwner, "Actor changes and refreshes must retain the real list owner");
  }
  return { ...ui, mutation, transition, rows, denied: () => denied };
}

for (const target of ["request", "call", "stage", "booking", "clinic-assignment", "clinic-confirmation"] as const) {
  const changes = ["unmount", "actor", "path", "refresh"] as const;
  for (const change of changes) {
    test(`component queued ${target}: ${change} prevents dispatch before passive cleanup`, async (t) => {
      const ui = await queuedAction(t, target);
      await ui.transition(change);
      const before = ui.render.content();
      const writes = ui.render.writes();
      const count = ui.requests.length;
      const dispatched = ui.dispatched.length;
      ui.mutation.release();
      await ui.render.beforeEffects();
      assert.equal(ui.dispatched.length, dispatched, "An obsolete component mutation must never reach the fake network");
      assert.equal(ui.mutation.dispatchGuard?.(), false, "The live predicate must close without passive cleanup");
      assert.equal(ui.mutation.settled, true, "The queued transport must reject cancellation, not leave the action hanging");
      assert.equal(ui.render.content(), before);
      const releasesLiveLease = change === "refresh" && target !== "booking";
      assert.equal(ui.render.writes(), writes + Number(releasesLiveLease),
        "A refreshed live scope may only release its settled lease; other obsolete callbacks make no writes");
      assert.equal(ui.requests.length, count);
      assert.equal(ui.denied(), 0, "Cancellation is not a same-scope authorization denial");
      if (releasesLiveLease && target === "request") {
        await ui.render.flush();
        ui.take("OperatorRequests").succeed(list([{ id: REQUEST_A, status: "accepted",
          displayName: "Synthetic refreshed agreement", clinicBrief: "Synthetic terms",
          pricePerArrivalMinor: "0", currency: "KZT", leadScope: "assigned" }]));
        await ui.render.flush();
        const control = ui.find(node => node.type === "button" && typeof node.props.disabled === "boolean", ui.find(node => node.type === "article"));
        assert.equal(control.props.disabled, true, "The lease settles, but an unresolved durable key still blocks a fresh intent");
        assert.equal(ui.storage.size, 1, "A pre-dispatch cancellation is not a server-side fence against every delayed copy");
        assert.equal(ui.requests.filter(request => request.method === "PATCH").length, 1);
      } else if (releasesLiveLease && (target === "call" || target === "clinic-confirmation")) {
        await ui.render.flush();
        ui.take("OperatorArrivals").succeed(list(ui.rows)); await ui.render.flush();
        const article = ui.find(node => node.type === "article", ui.section(labels.arrivals));
        const controls = elements(article.props.children).filter(node => node.type === "button" && typeof node.props.disabled === "boolean");
        assert.ok(controls.length > 0); assert.ok(controls.every(control => control.props.disabled === false));
        assert.equal(ui.requests.filter(request => request.method !== "GET").length, 1);
      } else if (releasesLiveLease) {
        await ui.render.flush();
        ui.take("LeadList").succeed(list([{ id: LEAD, name: "Synthetic refreshed patient", status: "new", assigned: false }]));
        await ui.render.flush();
        const control = ui.find((node) => target === "clinic-assignment"
          ? node.type === "input" && node.props.type === "checkbox"
          : node.type === "button" && typeof node.props["aria-expanded"] === "boolean", ui.section(labels.leads));
        assert.equal(control.props.disabled, false, "Settling the canceled lookup must unlock the same live scope");
        assert.equal(ui.requests.filter((request) => request.method === "PATCH").length, 1);
      }
    });
  }
  test(`component queued ${target}: a live scope dispatches once and completes normally`, async (t) => {
    const ui = await queuedAction(t, target);
    assert.equal(typeof ui.mutation.dispatchGuard, "function", "The component must pass its live predicate through operatorApi to crmFetch");
    assert.equal(ui.mutation.dispatchGuard!(), true);
    const dispatched = ui.dispatched.length;
    ui.mutation.release();
    assert.equal(ui.dispatched.length, dispatched + 1);
    assert.equal(ui.dispatched.at(-1), ui.mutation);
    ui.mutation.succeed(target === "booking" ? savedBooking(ui.mutation) : undefined);
    await ui.render.flush();
    assert.equal(ui.denied(), 0);
    assert.equal(ui.take(target === "request" ? "OperatorRequests" : target === "call" || target === "clinic-confirmation" ? "OperatorArrivals" : "LeadList").settled, false,
      "Successful live mutations still revalidate the real list");
    if (target === "booking") assert.equal(ui.storage.size, 0, "A confirmed live booking releases its persisted attempt");
  });
}

type ClinicMutation = "send" | "withdraw" | "end";
async function clinicMutation(t: TestContext, target: ClinicMutation) {
  let confirmed = true;
  let confirmations = 0;
  const ui = await runtime(t, true, () => { confirmations++; return confirmed; });
  const Clinic = ui.load("clinic").ClinicOperators;
  let actorId = ACTOR;
  let workspaceId = WORKSPACE;
  let epoch = 0;
  let session = { current: true };
  let rawActor = ACTOR;
  function view() {
    const lifetime = session;
    return jsx(Clinic, { workspaceId, actorId, isSessionCurrent: () => lifetime.current }, epoch);
  }
  function control() {
    return target === "send"
      ? ui.find((node) => node.type === "form")
      : ui.find((node) => node.type === "button" && typeof node.props.disabled === "boolean",
        ui.find((node) => node.type === "article", ui.section("\u041f\u0440\u0435\u0434\u043b\u043e\u0436\u0435\u043d\u0438\u044f \u043e \u0441\u043e\u0442\u0440\u0443\u0434\u043d\u0438\u0447\u0435\u0441\u0442\u0432\u0435")));
  }
  function busyControl() {
    return target === "send" ? ui.find((node) => node.type === "button" && node.props.type === "submit", control()) : control();
  }
  async function prepareOffer() {
    const offer = ui.button("\u041f\u0440\u0435\u0434\u043b\u043e\u0436\u0438\u0442\u044c \u0441\u043e\u0442\u0440\u0443\u0434\u043d\u0438\u0447\u0435\u0441\u0442\u0432\u043e");
    if (offer.props.disabled) return;
    ui.invoke(offer);
    await ui.render.flush();
    ui.invoke(ui.find((node) => node.type === "textarea", control()), "onChange", { target: { value: "Synthetic user-only 0 KZT agreement" } });
    ui.invoke(ui.find((node) => node.type === "input" && node.props.inputMode === "decimal", control()), "onChange", { target: { value: "0" } });
    await ui.render.flush();
  }
  async function populate() {
    await ui.render.flush();
    const directory = ui.take("ClinicOperators");
    const requests = ui.take("OperatorRequests");
    for (const request of [directory, requests]) {
      assert.equal(request.expectedUserId, actorId, "Replacement reads must belong to the newly mounted actor");
      assert.equal(request.dispatchGuard?.(), true, "Replacement reads must use a live owner lifetime");
    }
    directory.succeed(list([{
      id: REQUEST_B, displayName: `Synthetic operator ${epoch}`, status: "approved", acceptingRequests: true,
    }]));
    requests.succeed(list([{
      id: REQUEST_A, status: target === "withdraw" ? "requested" : "accepted",
      displayName: `Synthetic agreement ${epoch}`, clinicBrief: "Synthetic user-only 0 KZT agreement",
      pricePerArrivalMinor: "0", currency: "KZT", leadScope: "assigned",
    }]));
    await ui.render.flush();
    const unresolved = ui.render.nodes().some(node => node.type === "aside" && node.props["aria-label"] === "Неподтверждённая отправка");
    if (target === "send") await prepareOffer();
    if (unresolved) assert.equal((target === "send" ? ui.button("Предложить сотрудничество") : busyControl()).props.disabled, true,
      "Returning to an original account restores its unresolved command, not a fresh intent");
    else assert.notEqual(busyControl().props.disabled, true);
  }
  async function start() {
    ui.invoke(control(), target === "send" ? "onSubmit" : "onClick");
    await ui.render.flush();
    const mutation = ui.take("event", target === "send" ? "POST" : "PATCH");
    assert.equal(mutation.url, `/api/crm/clinic-operator-requests?workspaceId=${workspaceId}`);
    assert.deepEqual(mutation.body, target === "send" ? {
      operatorId: REQUEST_B, clinicBrief: "Synthetic user-only 0 KZT agreement", pricePerArrivalMinor: "0", leadScope: "assigned", commandId: mutation.body?.commandId,
    } : { id: REQUEST_A, action: target, commandId: mutation.body?.commandId });
    assert.match(String(mutation.body?.commandId), /^[0-9a-f-]{36}$/i);
    assert.equal(mutation.dispatched, false, "The real clinic handler must reach the synthetic lookup gate");
    assert.equal(busyControl().props.disabled, true);
    return mutation;
  }
  async function closePending() {
    ui.invoke(ui.button("Закрыть отправку")); await ui.render.flush();
    const closure = ui.take("event", "PATCH"); assert.equal(closure.body?.action, "abandon");
    closure.release(); closure.succeed(); await ui.render.flush();
    if (target === "send" && !ui.render.nodes().some(node => node.type === "form")) await prepareOffer();
  }
  ui.render.mount(view());
  await populate();
  return {
    ...ui, start, control, busyControl, closePending,
    cancelConfirmation() { confirmed = false; },
    confirmations: () => confirmations,
    changeRawActor(nextActor: string) {
      if (rawActor !== nextActor) session.current = false;
      rawActor = nextActor;
    },
    async changeWorkspace(nextWorkspace = REQUEST_B) {
      workspaceId = nextWorkspace;
      ui.render.update(view());
      await ui.render.beforeEffects();
    },
    async replaceWorkspace(nextWorkspace: string) {
      workspaceId = nextWorkspace;
      ui.render.update(view());
      await populate();
    },
    async replaceActor(nextActor: string, remount = true) {
      session.current = false;
      session = { current: true };
      actorId = rawActor = nextActor;
      if (remount) epoch++;
      ui.render.update(view());
      // Owned lists re-read for the new actor even when the component instance survives.
      await populate();
    },
  };
}
function clinicSnapshot(ui: Ui) {
  return { content: ui.render.content(), writes: ui.render.writes(), requests: ui.requests.length, dispatched: ui.dispatched.length };
}
function assertClinicQuiet(ui: Ui, before: ReturnType<typeof clinicSnapshot>) {
  assert.equal(ui.render.content(), before.content, "An obsolete clinic action cannot overwrite the visible view");
  assert.equal(ui.render.writes(), before.writes, "An obsolete clinic action must not attempt state or busy writes");
  assert.equal(ui.requests.length, before.requests, "An obsolete clinic action cannot dispatch or schedule a refresh");
  assert.equal(ui.dispatched.length, before.dispatched);
}

for (const target of ["send", "withdraw"] as const) {
  test(`clinic mutation baseline ${target}: pins the original actor and forwards a live guard`, async (t) => {
    const ui = await clinicMutation(t, target);
    const mutation = await ui.start();
    assert.equal(mutation.expectedUserId, ACTOR, "Clinic writes must pin the original actor, not omit expectedUserId");
    assert.equal(mutation.dispatchGuard?.(), true, "The real handler must forward its live guard to crmFetch");
    ui.changeRawActor(REQUEST_B);
    assert.equal(mutation.expectedUserId, ACTOR, "A queued lookup must never adopt the replacement actor");
  });
  for (const transition of ["A-B", "A-B-A", "unmount", "workspace"] as const) {
    test(`clinic mutation baseline ${target}: ${transition} cancels queued lookup before passive effects`, async (t) => {
      const ui = await clinicMutation(t, target);
      const mutation = await ui.start();
      if (transition === "unmount") ui.render.update(null);
      else if (transition === "workspace") await ui.changeWorkspace();
      else {
        ui.changeRawActor(REQUEST_B);
        if (transition === "A-B-A") ui.changeRawActor(ACTOR);
      }
      const before = clinicSnapshot(ui);
      mutation.release();
      await ui.render.beforeEffects();
      assert.equal(mutation.dispatched, false, "Expired clinic actions must be canceled at the queued lookup gate");
      assert.equal(mutation.settled, true);
      assert.equal(mutation.dispatchGuard?.(), false);
      assertClinicQuiet(ui, before);
    });
  }
  for (const transition of ["expired A-B-A", "unmount"] as const) {
    test(`clinic mutation baseline ${target}: retained event after ${transition} does nothing`, async (t) => {
      const ui = await clinicMutation(t, target);
      const retained = ui.control();
      if (transition === "unmount") ui.render.update(null);
      else { ui.changeRawActor(REQUEST_B); ui.changeRawActor(ACTOR); }
      const before = clinicSnapshot(ui);
      ui.invoke(retained, target === "send" ? "onSubmit" : "onClick");
      await ui.render.beforeEffects();
      assertClinicQuiet(ui, before);
    });
  }
  for (const transition of ["expired A-B-A", "replacement A-B-A"] as const) {
    for (const outcome of ["success", "network", 401, 403] as const) {
      test(`clinic mutation baseline ${target}: late ${outcome} after ${transition} preserves view and busy owner`, async (t) => {
        const ui = await clinicMutation(t, target);
        const obsolete = await ui.start();
        obsolete.release();
        let current: Pending | undefined;
        if (transition === "replacement A-B-A") {
          await ui.replaceActor(REQUEST_B);
          await ui.replaceActor(ACTOR);
          await ui.closePending();
          current = await ui.start();
          current.release();
        } else { ui.changeRawActor(REQUEST_B); ui.changeRawActor(ACTOR); }
        const before = clinicSnapshot(ui);
        if (outcome === "success") obsolete.succeed();
        else if (outcome === "network") obsolete.reject();
        else obsolete.fail(outcome);
        await ui.render.beforeEffects();
        assertClinicQuiet(ui, before);
        assert.equal(ui.busyControl().props.disabled, true, "Old finally must not unlock the current pending action");
        if (current) assert.equal(current.settled, false);
        await ui.render.flush();
        assertClinicQuiet(ui, before);
        if (current) {
          current.fail(409);
          await ui.render.flush();
          await ui.closePending();
          assert.equal(ui.busyControl().props.disabled, false);
        }
      });
    }
  }
}
for (const target of ["send", "withdraw", "end"] as const) {
  test(`clinic mutation baseline ${target}: same actor dispatches once and still revalidates`, async (t) => {
    const ui = await clinicMutation(t, target);
    const mutation = await ui.start();
    const dispatched = ui.dispatched.length;
    mutation.release();
    assert.equal(ui.dispatched.length, dispatched + 1);
    assert.equal(ui.dispatched.at(-1), mutation);
    assert.equal(ui.requests.filter((request) => request.method !== "GET").length, 1);
    mutation.succeed();
    await ui.render.flush();
    assert.equal(ui.take("OperatorRequests").settled, false, "Current clinic writes still refresh the real request list");
    assert.equal(ui.confirmations(), target === "end" ? 1 : 0, "Only ending cooperation asks for confirmation");
  });
}
test("clinic mutation baseline end: canceling confirmation leaves requests and busy state unchanged", async (t) => {
  const ui = await clinicMutation(t, "end");
  ui.cancelConfirmation();
  const before = clinicSnapshot(ui);
  ui.invoke(ui.control());
  await ui.render.flush();
  assertClinicQuiet(ui, before);
  assert.equal(ui.confirmations(), 1);
  assert.equal(ui.busyControl().props.disabled, false);
});

type ClinicMutationUi = Awaited<ReturnType<typeof clinicMutation>>;
type OfferEdit = "brief" | "price" | "leadScope" | "brief-revert" | "price-revert" | "leadScope-revert" | "directory-refresh";
function offerDraft(ui: ClinicMutationUi) {
  return {
    brief: ui.find((node) => node.type === "textarea", ui.control()).props.value,
    price: ui.find((node) => node.type === "input" && node.props.inputMode === "decimal", ui.control()).props.value,
    leadScope: ui.find((node) => node.type === "select", ui.control()).props.value,
  };
}
async function editPendingOffer(ui: ClinicMutationUi, edit: OfferEdit) {
  if (edit === "directory-refresh") {
    const refresh = ui.render.nodes().find((node) => node.type === "button"
      && node.props["aria-label"] === "Обновить операторов");
    assert.ok(refresh);
    ui.invoke(refresh);
    await ui.render.flush();
    ui.take("ClinicOperators").succeed(list([{
      id: REQUEST_B, displayName: "Synthetic refreshed operator", status: "approved", acceptingRequests: true,
    }]));
    await ui.render.flush();
    return;
  }
  const field = edit.startsWith("brief") ? "brief" : edit.startsWith("price") ? "price" : "leadScope";
  function input() {
    return ui.find((node) => field === "brief" ? node.type === "textarea"
      : field === "price" ? node.type === "input" && node.props.inputMode === "decimal" : node.type === "select", ui.control());
  }
  const original = input().props.value;
  const value = field === "brief" ? "Synthetic edited user-only 0 KZT agreement" : field === "price" ? "0.00" : "clinic";
  ui.invoke(input(), "onChange", { target: { value } });
  await ui.render.flush();
  assert.equal(input().props.value, value);
  if (edit.endsWith("-revert")) {
    ui.invoke(input(), "onChange", { target: { value: original } });
    await ui.render.flush();
    assert.equal(input().props.value, original);
  }
}
async function pendingOfferLease(t: TestContext, edit: OfferEdit, outcome: "canceled" | "success" | "network" | 401 | 403) {
  const ui = await clinicMutation(t, "send");
  const retained = ui.control();
  const obsolete = await ui.start();
  if (outcome !== "canceled") obsolete.release();
  await editPendingOffer(ui, edit);
  const draft = offerDraft(ui);
  assert.equal(obsolete.dispatchGuard?.(), false, "An edit or directory refresh must invalidate the old form frame, even after revert");
  assert.equal(ui.busyControl().props.disabled, true, "Changing the form frame must not unlock an unresolved send");
  const before = clinicSnapshot(ui);
  ui.invoke(retained, "onSubmit");
  ui.invoke(ui.control(), "onSubmit");
  ui.invoke(ui.control(), "onSubmit");
  await ui.render.flush();
  assertClinicQuiet(ui, before);
  assert.equal(ui.requests.filter((request) => request.method === "POST").length, 1, "Duplicate submit events must not even queue another lookup");
  if (outcome === "canceled") obsolete.release();
  else if (outcome === "success") obsolete.succeed();
  else if (outcome === "network") obsolete.reject();
  else obsolete.fail(outcome);
  await ui.render.flush();
  assert.equal(obsolete.settled, true);
  assert.equal(obsolete.dispatched, outcome !== "canceled");
  assert.deepEqual(offerDraft(ui), draft, "Settling the old attempt must preserve newer fields rather than close or clear the form");
  const recovery = ui.find(node => node.type === "aside" && node.props["aria-label"] === "Неподтверждённая отправка");
  const recoveryNodes = new Set(elements(recovery.props.children));
  assert.equal(ui.render.nodes().filter((node) => (node.props.role === "status" || node.props.role === "alert") && !recoveryNodes.has(node)).length, 0,
    "The invalidated form frame cannot publish success or error notices");
  assert.equal(ui.requests.length, before.requests, "The old frame cannot refresh the request list");
  assert.equal(ui.busyControl().props.disabled, true, "Settling a transport must not drop the unresolved original key");
  await ui.closePending();
  assert.equal(ui.busyControl().props.disabled, false, "Explicitly fencing the original key permits a genuinely new intent");
  ui.invoke(ui.control(), "onSubmit");
  await ui.render.flush();
  const current = ui.take("event", "POST");
  assert.equal(current.expectedUserId, ACTOR);
  assert.equal(current.dispatchGuard?.(), true);
  assert.deepEqual(current.body, {
    operatorId: REQUEST_B, clinicBrief: draft.brief, pricePerArrivalMinor: "0", leadScope: draft.leadScope, commandId: current.body?.commandId,
  });
  assert.notEqual(current.body?.commandId, obsolete.body?.commandId);
  assert.equal(ui.busyControl().props.disabled, true);
  const dispatched = ui.dispatched.length;
  current.release();
  assert.equal(ui.dispatched.length, dispatched + 1);
  current.succeed();
  await ui.render.flush();
  assert.equal(ui.take("OperatorRequests").settled, false, "A fresh live send still dispatches and revalidates normally");
}
for (const edit of ["brief", "price", "leadScope", "brief-revert", "price-revert", "leadScope-revert", "directory-refresh"] as const) {
  for (const outcome of ["canceled", "success"] as const) {
    test(`clinic pending lease send: ${edit} blocks duplicate ${outcome === "canceled" ? "queued" : "dispatched"} sends and preserves the draft`, async (t) => {
      await pendingOfferLease(t, edit, outcome);
    });
  }
}
for (const outcome of ["network", 401, 403] as const) {
  test(`clinic pending lease send: late ${outcome} releases only the live lease and preserves edited fields`, async (t) => {
    await pendingOfferLease(t, "brief", outcome);
  });
}
for (const transition of ["actor", "workspace", "unmount"] as const) {
  for (const outcome of ["canceled", "success", "network", 401, 403] as const) {
    test(`clinic pending lease send: old ${outcome} after ${transition} replacement cannot unlock the new action`, async (t) => {
      const ui = await clinicMutation(t, "send");
      const owner = ui.render.instances("ClinicOperators")[0];
      const obsolete = await ui.start();
      if (outcome !== "canceled") obsolete.release();
      if (transition === "workspace") await ui.replaceWorkspace(REQUEST_B);
      else await ui.replaceActor(REQUEST_B, transition === "unmount");
      assert.equal(ui.render.instances("ClinicOperators")[0] === owner, transition !== "unmount");
      assert.equal(obsolete.dispatchGuard?.(), false, "A replacement cannot revive the old action's owner");
      const current = await ui.start();
      assert.equal(current.dispatchGuard?.(), true, "The new action must own a live replacement lifetime");
      current.release();
      assert.equal(current.expectedUserId, transition === "workspace" ? ACTOR : REQUEST_B);
      const before = clinicSnapshot(ui);
      if (outcome === "canceled") obsolete.release();
      else if (outcome === "success") obsolete.succeed();
      else if (outcome === "network") obsolete.reject();
      else obsolete.fail(outcome);
      await ui.render.beforeEffects();
      assertClinicQuiet(ui, before);
      assert.equal(ui.busyControl().props.disabled, true, "An expired, moved or unmounted owner cannot release the new lease");
      assert.equal(current.settled, false);
      await ui.render.flush();
      assertClinicQuiet(ui, before);
      current.fail(409);
      await ui.render.flush();
      await ui.closePending();
      assert.equal(ui.busyControl().props.disabled, false);
    });
  }
}
for (const target of ["send", "withdraw", "end"] as const) {
  for (const transition of ["workspace", "workspace A-B-A"] as const) {
    test(`clinic pending lease ${target}: retained handler across same-instance ${transition} stays inert`, async (t) => {
      const ui = await clinicMutation(t, target);
      const clinic = ui.render.instances("ClinicOperators")[0];
      const requests = ui.render.instances("OperatorRequests")[0];
      const retained = ui.control();
      await ui.changeWorkspace();
      if (transition === "workspace A-B-A") await ui.changeWorkspace(WORKSPACE);
      assert.equal(ui.render.instances("ClinicOperators")[0], clinic);
      assert.equal(ui.render.instances("OperatorRequests")[0], requests);
      const before = clinicSnapshot(ui);
      ui.invoke(retained, target === "send" ? "onSubmit" : "onClick");
      await ui.render.beforeEffects();
      assertClinicQuiet(ui, before);
      assert.equal(ui.confirmations(), 0, "An obsolete end handler must not open confirmation");
    });
  }
}
for (const status of [401, 403] as const) {
  test(`clinic pending lease withdraw: still-live ${status} after request refresh invalidates newer live data`, async (t) => {
    const ui = await clinicMutation(t, "withdraw");
    const owner = ui.render.instances("OperatorRequests")[0];
    const obsolete = await ui.start();
    obsolete.release();
    const section = ui.find((node) => node.type === "section" && Boolean(node.props["aria-label"]));
    ui.invoke(ui.find((node) => node.type === "button" && node.props["aria-label"] === "Обновить предложения", section));
    await ui.render.flush();
    ui.take("OperatorRequests").succeed(list([{
      id: REQUEST_A, status: "requested", displayName: "Synthetic refreshed live agreement",
      clinicBrief: "Synthetic user-only 0 KZT agreement", pricePerArrivalMinor: "0", currency: "KZT", leadScope: "assigned",
    }]));
    await ui.render.flush();
    assert.equal(ui.render.instances("OperatorRequests")[0], owner);
    assert.ok(ui.render.content().includes("Synthetic refreshed live agreement"));
    assert.equal(obsolete.dispatchGuard?.(), false);
    const count = ui.requests.length;
    assert.equal(ui.busyControl().props.disabled, true, "Refresh must retain the original unresolved command lease");
    (ui.control().props.onClick as () => void)();
    await ui.render.beforeEffects();
    assert.equal(ui.requests.length, count, "Even a directly retained callback cannot bypass the pending command");
    obsolete.fail(status);
    await ui.render.beforeEffects();
    assert.equal(ui.requests.length, count, "Observe denial before its passive revalidation");
    assert.equal(ui.render.content().includes("Synthetic refreshed live agreement"), false);
    assert.equal(text(ui.find((node) => node.props.role === "alert").props.children), `Synthetic CRM error ${status}`);
    assert.equal(ui.requests.filter(request => request.method === "PATCH").length, 1,
      "Access revocation must invalidate the refreshed view without admitting a second command");
    await ui.render.flush();
    assert.equal(ui.requests.length, count + 1);
    assert.equal(ui.take("OperatorRequests").settled, false);
  });
}

type LeadMutation = "assign" | "unassign" | "stage";
async function composedLeadMutation(t: TestContext, target: LeadMutation) {
  const ui = await runtime(t, true);
  const clinic = target !== "stage";
  const Root = clinic ? ui.load("clinic").ClinicOperators : ui.load("requests").OperatorRequests;
  let actorId = ACTOR;
  let rawActor = ACTOR;
  let epoch = 0;
  let session = { current: true };
  let denied = 0;
  function view() {
    const lifetime = session;
    return jsx(Root, {
      actorId, ...(clinic ? { workspaceId: WORKSPACE } : {}),
      isSessionCurrent: () => lifetime.current, onAccessDenied: () => { denied++; },
    }, epoch);
  }
  function leadRows(label: string) {
    return list([{
      id: LEAD, name: `Synthetic assignment ${label}`, phone: leadPhone(label), status: "new",
      stageId: "stage-one", stageName: "Synthetic stage one", assigned: target === "unassign",
    }], { stageEditingAvailable: true, stages: [{ id: "stage-one", name: "Synthetic stage one" }, { id: "stage-two", name: "Synthetic stage two" }] });
  }
  function control() {
    return clinic
      ? ui.find((node) => node.type === "input" && node.props.type === "checkbox", ui.section(labels.leads))
      : ui.find((node) => node.type === "form" && elements(node.props.children).some((child) => child.type === "select"), ui.section(labels.leads));
  }
  function busyControl() {
    return clinic ? control() : ui.find((node) => node.type === "button" && typeof node.props["aria-expanded"] === "boolean", ui.section(labels.leads));
  }
  function invoke(controlNode = control()) {
    ui.invoke(controlNode, clinic ? "onChange" : "onSubmit", clinic ? { target: { checked: target === "assign" } } : undefined);
  }
  async function populate(label: string) {
    await ui.render.flush();
    if (clinic) ui.take("ClinicOperators").succeed(list([]));
    ui.take("OperatorRequests").succeed(list([{
      id: REQUEST_A, status: "accepted", displayName: `Synthetic agreement ${label}`,
      clinicBrief: "Synthetic agreement", pricePerArrivalMinor: "0", currency: "KZT", leadScope: "assigned",
    }]));
    await ui.render.flush();
    const toggles = ui.render.nodes().filter((node) => node.type === "button" && node.props["aria-expanded"] === false);
    ui.invoke(toggles.at(-1)!);
    await ui.render.flush();
    ui.take("LeadList").succeed(leadRows(label));
    await ui.render.flush();
    if (!clinic) {
      ui.invoke(ui.find((node) => node.type === "select", control()), "onChange", { target: { value: "stage-two" } });
      await ui.render.flush();
    }
    assert.equal(ui.render.instances("OperatorRequests").length, 1);
    assert.equal(ui.render.instances("OperatorLeads").length, 1);
    assert.equal(ui.render.instances("LeadList").length, 1);
    assert.notEqual(busyControl().props.disabled, true);
  }
  async function start() {
    invoke();
    await ui.render.flush();
    const mutation = ui.take("event", "PATCH");
    assert.equal(mutation.url, `/api/crm/${clinic ? `clinic-operator-leads?workspaceId=${WORKSPACE}&` : "operator-leads?"}requestId=${REQUEST_A}&search=`);
    assert.deepEqual(mutation.body, clinic ? { leadId: LEAD, assigned: target === "assign" }
      : { leadId: LEAD, stageId: "stage-two", expectedStageId: "stage-one", expectedStatus: "new" });
    assert.equal(mutation.dispatched, false);
    return mutation;
  }
  async function refresh(label = "refreshed-assignment") {
    ui.invoke(ui.find((node) => node.type === "button" && elements(node.props.children).some((child) => child.type === icons.RefreshCw), ui.section(labels.leads)));
    await ui.render.flush();
    ui.take("LeadList").succeed(leadRows(label));
    await ui.render.flush();
  }
  async function settleLeadRead(label = "settled-assignment") {
    ui.take("LeadList").succeed(leadRows(label));
    await ui.render.flush();
  }
  ui.render.mount(view());
  await populate("initial-assignment");
  return {
    ...ui, control, busyControl, invoke, start, refresh, settleLeadRead, denied: () => denied,
    rawActor(nextActor: string) {
      if (rawActor !== nextActor) session.current = false;
      rawActor = nextActor;
    },
    async replaceActor(nextActor: string) {
      session.current = false;
      session = { current: true };
      actorId = rawActor = nextActor;
      epoch++;
      ui.render.update(view());
      await populate(`replacement-${epoch}`);
    },
  };
}

for (const target of ["assign", "unassign", "stage"] as const) {
  test(`composed lead mutation ${target}: original actor and unchanged live session dispatch once`, async (t) => {
    const ui = await composedLeadMutation(t, target);
    const mutation = await ui.start();
    assert.equal(mutation.expectedUserId, ACTOR, "The real request/lead chain must retain the actor");
    ui.rawActor(ACTOR);
    assert.equal(mutation.dispatchGuard?.(), true, "Same-actor session refresh must keep the current action valid");
    const dispatched = ui.dispatched.length;
    mutation.release();
    assert.equal(ui.dispatched.length, dispatched + 1);
    mutation.succeed();
    await ui.render.flush();
    assert.equal(ui.take("LeadList").settled, false, "Current actions still recheck authorization");
    assert.equal(ui.denied(), 0);
  });
  for (const transition of ["A-B", "logout", "A-B-A"] as const) {
    test(`composed lead mutation ${target}: raw ${transition} cancels queued dispatch without rendering`, async (t) => {
      const ui = await composedLeadMutation(t, target);
      const mutation = await ui.start();
      ui.rawActor(transition === "logout" ? "" : REQUEST_B);
      if (transition === "A-B-A") ui.rawActor(ACTOR);
      const before = clinicSnapshot(ui);
      assert.equal(mutation.expectedUserId, ACTOR);
      assert.equal(mutation.dispatchGuard?.(), false, "A->B->A cannot revive the old session predicate");
      mutation.release();
      await ui.render.beforeEffects();
      assert.equal(mutation.dispatched, false);
      assert.equal(mutation.settled, true);
      assertClinicQuiet(ui, before);
      assert.equal(ui.denied(), 0);
    });
  }
  for (const transition of ["expired-session", "refreshed-frame", "unmount"] as const) {
    test(`composed lead mutation ${target}: retained handler after ${transition} stops before state or lookup`, async (t) => {
      const ui = await composedLeadMutation(t, target);
      const retained = ui.control();
      if (transition === "expired-session") { ui.rawActor(REQUEST_B); ui.rawActor(ACTOR); }
      else if (transition === "refreshed-frame") await ui.refresh();
      else ui.render.update(null);
      const before = clinicSnapshot(ui);
      ui.invoke(retained);
      await ui.render.beforeEffects();
      assertClinicQuiet(ui, before);
    });
  }
  for (const outcome of ["success", "network", 401, 403] as const) {
    test(`composed lead mutation ${target}: late ${outcome} after raw session expiry makes no writes`, async (t) => {
      const ui = await composedLeadMutation(t, target);
      const mutation = await ui.start();
      mutation.release();
      ui.rawActor(REQUEST_B);
      ui.rawActor(ACTOR);
      const before = clinicSnapshot(ui);
      if (outcome === "success") mutation.succeed();
      else if (outcome === "network") mutation.reject();
      else mutation.fail(outcome);
      await ui.render.beforeEffects();
      assertClinicQuiet(ui, before);
      await ui.render.flush();
      assertClinicQuiet(ui, before);
      assert.equal(ui.denied(), 0, "An expired action cannot revoke a replacement session");
    });
    test(`composed lead mutation ${target}: late ${outcome} after replacement A-B-A cannot unlock a newer pending action`, async (t) => {
      const ui = await composedLeadMutation(t, target);
      const obsolete = await ui.start();
      obsolete.release();
      await ui.replaceActor(REQUEST_B);
      await ui.replaceActor(ACTOR);
      const current = await ui.start();
      current.release();
      const before = clinicSnapshot(ui);
      if (outcome === "success") obsolete.succeed();
      else if (outcome === "network") obsolete.reject();
      else obsolete.fail(outcome);
      await ui.render.beforeEffects();
      assertClinicQuiet(ui, before);
      assert.equal(ui.busyControl().props.disabled, true);
      assert.equal(current.settled, false);
      assert.equal(ui.denied(), 0);
      await ui.render.flush();
      assertClinicQuiet(ui, before);
      current.fail(409);
      await ui.render.flush();
      await ui.settleLeadRead();
      assert.equal(ui.busyControl().props.disabled, false, "The new action still owns and releases its own lease");
    });
  }
  for (const status of [401, 403] as const) {
    test(`composed lead mutation ${target}: current ${status} after list refresh still removes protected data`, async (t) => {
      const ui = await composedLeadMutation(t, target);
      const mutation = await ui.start();
      mutation.release();
      await ui.refresh();
      assert.ok(ui.render.content().includes(leadPhone("refreshed-assignment")));
      const count = ui.requests.length;
      mutation.fail(status);
      await ui.render.beforeEffects();
      assert.equal(ui.requests.length, count, "Observe the denial before its passive revalidation");
      assert.equal(ui.render.content().includes(leadPhone("refreshed-assignment")), false);
      assert.equal(ui.denied(), target === "stage" ? 1 : 0);
      assert.equal(ui.render.nodes().filter((node) => node.type === "input" && node.props.type === "checkbox").length, 0);
      await ui.render.flush();
      assert.equal(ui.requests.length, count + 1, "Still-live denial must schedule exactly one authorization read");
      assert.equal(ui.take(target === "stage" ? "OperatorRequests" : "LeadList").settled, false);
    });
  }
  test(`composed lead mutation ${target}: repeated synchronous events queue only one lookup`, async (t) => {
    const ui = await composedLeadMutation(t, target);
    const retained = ui.control();
    ui.invoke(retained);
    ui.invoke(retained);
    await ui.render.beforeEffects();
    assert.equal(ui.requests.filter((request) => request.method === "PATCH").length, 1);
    assert.equal(ui.busyControl().props.disabled, true);
    const mutation = ui.take("event", "PATCH");
    assert.equal(mutation.dispatched, false);
    mutation.release();
    mutation.succeed();
    await ui.render.flush();
    assert.equal(ui.take("LeadList").settled, false);
  });
  for (const dispatched of [false, true]) {
    test(`composed lead mutation ${target}: ${dispatched ? "dispatched" : "queued"} lease survives list refresh and blocks repeated handlers`, async (t) => {
      const ui = await composedLeadMutation(t, target);
      const retained = ui.control();
      const mutation = await ui.start();
      if (dispatched) mutation.release();
      await ui.refresh();
      assert.equal(ui.busyControl().props.disabled, true, "Refreshing data cannot unlock a pending mutation");
      const before = clinicSnapshot(ui);
      ui.invoke(retained);
      await ui.render.beforeEffects();
      assertClinicQuiet(ui, before);
      assert.equal(ui.requests.filter((request) => request.method === "PATCH").length, 1);
      if (dispatched) mutation.succeed(); else mutation.release();
      await ui.render.flush();
      assert.notEqual(ui.busyControl().props.disabled, true, "Only the settled live lease may release the control");
    });
  }
}

async function clinicConfirmation(t: TestContext) {
  const ui = await runtime(t, true);
  const Clinic = ui.load("clinic").ClinicOperators;
  let actorId = ACTOR;
  let epoch = 0;
  let session = { current: true };
  let rawActor = ACTOR;
  function view() {
    const lifetime = session;
    return jsx(Clinic, { workspaceId: WORKSPACE, actorId, isSessionCurrent: () => lifetime.current }, epoch);
  }
  const row = (label: string) => ({
    appointmentId: "synthetic-appointment", arrivalId: null, status: "arrived",
    clientName: `Synthetic clinic patient ${label}`, startsAt: "2026-10-18T09:00:00Z",
    service: "Synthetic clinic service", priceMinor: "100", currency: "KZT",
  });
  async function populate(label: string) {
    await ui.render.flush();
    ui.take("ClinicOperators").succeed(list([]));
    ui.take("OperatorRequests").succeed(list([{
      id: REQUEST_A, status: "accepted", displayName: `Synthetic clinic ${label}`,
      pricePerArrivalMinor: "100", currency: "KZT", leadScope: "assigned",
    }]));
    await ui.render.flush();
    ui.invoke(ui.button("\u041f\u043e\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044c \u043f\u0440\u0438\u0445\u043e\u0434\u044b"));
    await ui.render.flush();
    ui.take("OperatorArrivals").succeed(list([row(label)]));
    await ui.render.flush();
  }
  function confirmationButton() {
    return ui.find((node) => node.type === "button" && elements(node.props.children)
      .some((child) => child.type === icons.CheckCircle2), ui.section(labels.arrivals));
  }
  async function start() {
    ui.invoke(confirmationButton());
    await ui.render.flush();
    const mutation = ui.take("event", "POST");
    assert.equal(mutation.url, `/api/crm/clinic-operator-arrivals?workspaceId=${WORKSPACE}&requestId=${REQUEST_A}`);
    assert.deepEqual(mutation.body, { appointmentId: "synthetic-appointment" });
    assert.equal(mutation.expectedUserId, actorId, "The real clinic/request/arrival chain must preserve its actor");
    assert.equal(mutation.dispatchGuard?.(), true);
    assert.equal(mutation.dispatched, false);
    assert.equal(confirmationButton().props.disabled, true);
    return mutation;
  }
  ui.render.mount(view());
  await populate("A");
  return {
    ...ui, start, confirmationButton,
    changeRawActor(nextActor: string) {
      if (rawActor !== nextActor) session.current = false;
      rawActor = nextActor;
    },
    async replaceActor(nextActor: string) {
      const oldClinic = ui.render.instances("ClinicOperators")[0];
      const oldRequests = ui.render.instances("OperatorRequests")[0];
      const oldArrivals = ui.render.instances("OperatorArrivals")[0];
      session.current = false;
      session = { current: true };
      actorId = rawActor = nextActor;
      epoch++;
      ui.render.update(view());
      await ui.render.beforeEffects();
      assert.notEqual(ui.render.instances("ClinicOperators")[0], oldClinic);
      assert.notEqual(ui.render.instances("OperatorRequests")[0], oldRequests);
      assert.equal(ui.render.instances("OperatorArrivals").length, 0);
      await populate(`epoch-${epoch}`);
      assert.notEqual(ui.render.instances("OperatorArrivals")[0], oldArrivals);
    },
  };
}

async function arrivalCommand(t: TestContext, clinic: boolean) {
  const ui = await runtime(t, true);
  const Arrivals = ui.load("arrivals").OperatorArrivals;
  const props = { actorId: ACTOR, requestId: REQUEST_A, ...(clinic ? { workspaceId: WORKSPACE } : {}) };
  const rows = [0, 1].map(index => ({
    appointmentId: `synthetic-appointment-${index}`, arrivalId: clinic ? null : `synthetic-arrival-${index}`,
    status: "arrived", clientName: `Synthetic lease patient ${index}`, clientPhone: `PRIVATE-${index}`,
    startsAt: "2026-10-18T09:00:00Z", priceMinor: "100", currency: "KZT",
  }));
  ui.render.mount(jsx(Arrivals, props)); await ui.render.flush();
  ui.take("OperatorArrivals").succeed(list(rows)); await ui.render.flush();
  const buttons = () => ui.render.nodes().filter(node => node.type === "button"
    && (clinic ? text(node.props.children).includes("Подтвердить приход") : text(node.props.children) === "Подтвердил"));
  const controls = () => ui.render.nodes().filter(node => node.type === "button"
    && (clinic ? text(node.props.children).includes("Подтвердить приход")
      : ["Подтвердил", "Не подтвердил", "Не дозвонился"].includes(text(node.props.children))));
  const writes = () => ui.requests.filter(request => request.method !== "GET");
  return { ...ui, buttons, controls, writes, rows, props, Arrivals,
    async fresh(page = false) {
      ui.invoke(page ? ui.button("Далее") : ui.button("Обновить приходы")); await ui.render.flush();
      ui.take("OperatorArrivals").succeed(list(rows)); await ui.render.flush();
    } };
}

for (const clinic of [false, true]) {
  const kind = clinic ? "arrival confirmation" : "control call";
  test(`arrival command ${kind}: retained handler dispatches once before the disabled render`, async t => {
    const ui = await arrivalCommand(t, clinic), button = ui.buttons()[0];
    ui.invoke(button); ui.invoke(button); await ui.render.flush();
    assert.equal(ui.writes().length, 1, "The original handler must own the command synchronously");
    const mutation = ui.take("event", clinic ? "POST" : "PATCH");
    mutation.release(); mutation.succeed(); await ui.render.flush();
  });
  for (const page of [false, true]) for (const outcome of ["success", "network"] as const) {
    test(`arrival command ${kind}: ${page ? "page" : "refresh"} retains its row lease until ${outcome}`, async t => {
      const ui = await arrivalCommand(t, clinic), oldButton = ui.buttons()[0];
      ui.invoke(oldButton); await ui.render.flush();
      const mutation = ui.take("event", clinic ? "POST" : "PATCH"); mutation.release();
      await ui.fresh(page);
      assert.equal(ui.buttons()[0].props.disabled, true, "A fresh list cannot reopen an unresolved row command");
      ui.invoke(oldButton); await ui.render.flush(); assert.equal(ui.writes().length, 1);
      const before = ui.requests.length;
      if (outcome === "success") mutation.succeed(); else mutation.reject();
      await ui.render.flush();
      assert.equal(ui.buttons()[0].props.disabled, false, "The settled owning command releases its live row lease");
      assert.equal(ui.requests.length, before, "An obsolete outcome cannot refresh or report into the newer list");
      assert.equal(ui.render.nodes().some(node => node.props.role === "alert"), false);
    });
  }
  test(`arrival command ${kind}: independent rows retain independent pending owners`, async t => {
    const ui = await arrivalCommand(t, clinic);
    ui.invoke(ui.buttons()[0]); await ui.render.flush();
    const first = ui.take("event", clinic ? "POST" : "PATCH"); first.release();
    assert.equal(ui.buttons()[1].props.disabled, false);
    ui.invoke(ui.buttons()[1]); await ui.render.flush();
    const second = ui.take("event", clinic ? "POST" : "PATCH"); second.release();
    assert.ok(ui.controls().every(button => button.props.disabled === true), "A second row cannot unlock the first");
    await ui.fresh(); second.succeed(); await ui.render.flush();
    assert.equal(ui.buttons()[0].props.disabled, true); assert.equal(ui.buttons()[1].props.disabled, false);
    first.reject(); await ui.render.flush(); assert.ok(ui.controls().every(button => button.props.disabled === false));
  });
  for (const change of ["actor", "path", "page", "refresh"] as const) {
    test(`arrival command ${kind}: retained ${change} handler cannot acquire the replacement view`, async t => {
      const ui = await arrivalCommand(t, clinic), oldButton = ui.buttons()[0];
      if (change === "page" || change === "refresh") await ui.fresh(change === "page");
      else {
        ui.render.update(jsx(ui.Arrivals, { ...ui.props, ...(change === "actor" ? { actorId: REQUEST_B } : { requestId: REQUEST_B }) }));
        await ui.render.beforeEffects();
      }
      const before = ui.requests.length, stateWrites = ui.render.writes();
      ui.invoke(oldButton); await ui.render.beforeEffects();
      assert.equal(ui.requests.length, before); assert.equal(ui.render.writes(), stateWrites);
    });
  }
}

for (const transition of ["A-B", "A-B-A"] as const) {
  test(`composed clinic confirmation: raw ${transition} invalidates queued dispatch without a render`, async (t) => {
    const ui = await clinicConfirmation(t);
    const mutation = await ui.start();
    const clinic = ui.render.instances("ClinicOperators")[0];
    const arrivals = ui.render.instances("OperatorArrivals")[0];
    ui.changeRawActor(REQUEST_B);
    if (transition === "A-B-A") ui.changeRawActor(ACTOR);
    const before = ui.render.content();
    const writes = ui.render.writes();
    const count = ui.requests.length;
    const dispatched = ui.dispatched.length;
    assert.equal(mutation.dispatchGuard?.(), false, "An expired session cannot revive when its actor returns");
    mutation.release();
    await ui.render.beforeEffects();
    assert.equal(mutation.settled, true);
    assert.equal(mutation.dispatched, false);
    assert.equal(ui.dispatched.length, dispatched);
    assert.equal(ui.requests.length, count);
    assert.equal(ui.render.writes(), writes, "Cancellation must not write error/busy state or refresh a list");
    assert.equal(ui.render.content(), before);
    assert.equal(ui.render.instances("ClinicOperators")[0], clinic);
    assert.equal(ui.render.instances("OperatorArrivals")[0], arrivals);
  });
  for (const outcome of ["success", "network", 401, 403] as const) {
    test(`composed clinic confirmation: late ${outcome} after ${transition} replacement cannot alter the current confirmation`, async (t) => {
      const ui = await clinicConfirmation(t);
      const obsolete = await ui.start();
      obsolete.release();
      await ui.replaceActor(REQUEST_B);
      if (transition === "A-B-A") await ui.replaceActor(ACTOR);
      const current = await ui.start();
      current.release();
      const clinic = ui.render.instances("ClinicOperators")[0];
      const arrivals = ui.render.instances("OperatorArrivals")[0];
      const before = ui.render.content();
      const writes = ui.render.writes();
      const count = ui.requests.length;
      const dispatched = ui.dispatched.length;
      if (outcome === "success") obsolete.succeed();
      else if (outcome === "network") obsolete.reject();
      else obsolete.fail(outcome);
      await ui.render.beforeEffects();
      assert.equal(ui.render.content(), before);
      assert.equal(ui.render.writes(), writes, "Old success/error/finally callbacks must make no state writes");
      assert.equal(ui.requests.length, count);
      assert.equal(ui.dispatched.length, dispatched);
      assert.equal(ui.render.instances("ClinicOperators")[0], clinic);
      assert.equal(ui.render.instances("OperatorArrivals")[0], arrivals);
      assert.equal(ui.confirmationButton().props.disabled, true, "Old finally cannot unlock the new actor's pending POST");
      assert.equal(current.settled, false);
      await ui.render.flush();
      assert.equal(ui.requests.length, count, "No delayed refresh may escape the obsolete callback");
      current.fail(409);
      await ui.render.flush();
      assert.equal(ui.confirmationButton().props.disabled, false);
      assert.equal(text(ui.find((node) => node.props.role === "alert").props.children), "Synthetic failure 409");
    });
  }
}

test("component queued request: changing the visible page invalidates dispatch before passive cleanup", async (t) => {
  const ui = await queuedAction(t, "request");
  await ui.transition("page");
  const dispatched = ui.dispatched.length;
  ui.mutation.release();
  await ui.render.beforeEffects();
  assert.equal(ui.dispatched.length, dispatched);
  assert.equal(ui.mutation.dispatchGuard?.(), false);
  assert.equal(ui.denied(), 0);
});

for (const outcome of ["success", "network"] as const) {
  test(`component queued booking: dispatched POST unmount preserves its ambiguous attempt on late ${outcome}`, async (t) => {
    const ui = await queuedAction(t, "booking");
    ui.mutation.release();
    assert.equal(ui.mutation.dispatched, true);
    const persisted = [...ui.storage.entries()];
    await ui.transition("unmount");
    const writes = ui.render.writes();
    const count = ui.requests.length;
    if (outcome === "success") ui.mutation.succeed(savedBooking(ui.mutation)); else ui.mutation.reject();
    await ui.render.beforeEffects();
    assert.deepEqual([...ui.storage.entries()], persisted, "Unmount and late outcomes must retain the durable retry key for reconciliation");
    assert.equal(ui.render.writes(), writes, "The old BookingFields and onBooked callback must stay silent after layout cleanup");
    assert.equal(ui.requests.length, count);
    assert.equal(ui.denied(), 0);
  });
}

test("operator booking queued in an expired parent lifetime cannot dispatch or clear its recovery key", async t => {
  let live = true;
  const ui = await queuedAction(t, "booking", false, () => live);
  const receipt = [...ui.storage.entries()], writes = ui.render.writes(), count = ui.requests.length;
  live = false;
  assert.equal(ui.mutation.dispatchGuard?.(), false, "The existing parent lifetime must reach BookingFields");
  ui.mutation.release(); await ui.render.beforeEffects();
  assert.equal(ui.mutation.dispatched, false); assert.equal(ui.requests.length, count);
  assert.equal(ui.render.writes(), writes); assert.deepEqual([...ui.storage.entries()], receipt);
  assert.equal(ui.denied(), 0);
});

for (const outcome of ["success", "network", 403, 503] as const) {
  test(`operator booking expired parent ignores late ${outcome} and retains the original recovery key`, async t => {
    let live = true;
    const ui = await queuedAction(t, "booking", false, () => live);
    ui.mutation.release();
    const receipt = [...ui.storage.entries()], writes = ui.render.writes(), count = ui.requests.length;
    const before = ui.render.content(); live = false;
    if (outcome === "success") ui.mutation.succeed(savedBooking(ui.mutation));
    else if (outcome === "network") ui.mutation.reject(); else ui.mutation.fail(outcome);
    await ui.render.beforeEffects();
    assert.equal(ui.render.writes(), writes); assert.equal(ui.requests.length, count);
    assert.equal(ui.render.content(), before); assert.deepEqual([...ui.storage.entries()], receipt);
    assert.equal(ui.denied(), 0);
  });
}

for (const expired of [false, true]) {
  test(`operator booking retained submit after ${expired ? "raw session expiry" : "unmount"} performs no storage/state/transport work`, async t => {
    let live = true;
    const ui = await populated(t, () => live);
    const form = ui.find(node => node.type === "form", ui.section(labels.booking));
    if (expired) live = false; else ui.render.update(null);
    const writes = ui.render.writes(), count = ui.requests.length;
    ui.invoke(form, "onSubmit"); await ui.render.beforeEffects();
    assert.equal(ui.render.writes(), writes); assert.equal(ui.requests.length, count);
    assert.equal(ui.storage.size, 0); assert.equal(ui.denied(), 0);
  });
}

for (const outcome of ["success", 403, "auth403"] as const) {
  test(`operator booking context ignores late ${outcome} from an expired parent before cleanup`, async t => {
    const ui = await runtime(t), Form = ui.load("booking").OperatorBookingForm;
    let live = true, denied = 0;
    ui.render.mount(jsx(Form, { actorId: ACTOR, requestId: REQUEST_A, leadId: LEAD,
      isSessionCurrent: () => live, onBooked: () => assert.fail("Unexpected booking"), onAccessDenied: () => denied++ }));
    await ui.render.flush(); const read = ui.take("OperatorBookingForm");
    const writes = ui.render.writes(), count = ui.requests.length; live = false;
    if (outcome === "success") read.succeed({ timeZone: "Asia/Almaty" }); else deny(read, outcome);
    await ui.render.beforeEffects();
    assert.equal(ui.render.writes(), writes); assert.equal(ui.requests.length, count);
    assert.equal(ui.render.instances("BookingFields").length, 0); assert.equal(denied, 0);
  });
}

for (const change of ["actor", "request", "lead"] as const) {
  test(`operator booking context ${change} change hides the prior form before passive cleanup`, async t => {
    const ui = await runtime(t), Form = ui.load("booking").OperatorBookingForm;
    const props = { actorId: ACTOR, requestId: REQUEST_A, leadId: LEAD, onBooked: () => {}, onAccessDenied: () => {} };
    ui.render.mount(jsx(Form, props)); await ui.render.flush();
    ui.take("OperatorBookingForm").succeed({ timeZone: "Asia/Almaty" }); await ui.render.flush();
    assert.equal(ui.render.instances("BookingFields").length, 1);
    ui.render.update(jsx(Form, { ...props, [change === "actor" ? "actorId" : change === "request" ? "requestId" : "leadId"]: REQUEST_B }));
    await ui.render.beforeEffects();
    assert.equal(ui.render.instances("BookingFields").length, 0, "An old booking context must not be rendered under new identity props");
  });
}

for (const status of [401, 403]) {
  test(`operator booking current ${status} preserves its potentially committed recovery key while closing access`, async t => {
    const ui = await queuedAction(t, "booking"); ui.mutation.release();
    const receipt = [...ui.storage.entries()]; ui.mutation.fail(status); await ui.render.flush();
    assert.deepEqual([...ui.storage.entries()], receipt, "An access refusal does not prove the original booking was never committed");
    assert.equal(ui.denied(), 1); assert.equal(ui.render.instances("BookingFields").length, 0);
  });
  test(`operator booking reopened context ${status} cannot delete an earlier unresolved receipt`, async t => {
    const ui = await queuedAction(t, "booking"); ui.mutation.release();
    const receipt = [...ui.storage.entries()], Form = ui.load("booking").OperatorBookingForm;
    let denied = 0;
    ui.render.update(jsx(Form, { actorId: ACTOR, requestId: REQUEST_A, leadId: LEAD,
      onBooked: () => assert.fail("Unexpected restored publication"), onAccessDenied: () => denied++ }));
    await ui.render.flush(); ui.take("OperatorBookingForm").fail(status); await ui.render.flush();
    assert.equal(denied, 1); assert.deepEqual([...ui.storage.entries()], receipt);
    assert.equal(ui.render.instances("BookingFields").length, 0);
    ui.mutation.succeed(savedBooking(ui.mutation)); await ui.render.flush();
    assert.deepEqual([...ui.storage.entries()], receipt, "The old successful reply cannot erase a recoverable booking after remount");
  });
}

for (const target of ["stage", "clinic-assignment"] as const) {
  for (const outcome of [403, "success"] as const) {
    test(`component dispatched ${target}: late ${outcome} after same-scope refreshed leads ${outcome === 403 ? "revokes the protected view and rechecks" : "cannot publish stale success"}`, async (t) => {
      const ui = await queuedAction(t, target, target === "stage");
      assert.equal(ui.mutation.dispatchGuard?.(), true);
      ui.mutation.release();
      assert.equal(ui.mutation.dispatched, true, "Exercise a real in-flight response, not a canceled queued action");
      const owner = ui.render.instances("LeadList")[0];
      await ui.transition("refresh");
      await ui.render.flush();
      const refreshed = ui.take("LeadList");
      assert.equal(refreshed.url, `${ui.mutation.url}&offset=0`, "The new GET must retain the mutation's actor/path scope");
      const freshData = list([{
        id: LEAD, name: "Synthetic refreshed patient", phone: leadPhone("refreshed"), status: "new", stageId: "stage-one", assigned: false,
      }], { stageEditingAvailable: true, stages: [{ id: "stage-one", name: "Synthetic stage one" }, { id: "stage-two", name: "Synthetic stage two" }] });
      refreshed.succeed(freshData);
      await ui.render.flush();
      assert.equal(ui.render.instances("LeadList")[0], owner);
      assert.ok(ui.render.content().includes(leadPhone("refreshed")), "A newer same-scope protected list must render before the old response");
      assert.equal(ui.mutation.dispatchGuard?.(), false, "The dispatched action no longer owns the refreshed snapshot");
      if (target === "stage") {
        assert.equal(ui.find((node) => node.type === "button" && node.props["aria-expanded"] === true, ui.section(labels.leads)).props.disabled, true,
          "Refreshing the list cannot unlock the in-flight mutation; the form was opened before it started");
        ui.take("OperatorBookingForm").succeed({ timeZone: "Asia/Almaty" });
        await ui.render.flush();
        ui.take("BookingFields").succeed(doctors());
        await ui.render.flush();
        assert.equal(ui.render.instances("BookingFields").length, 1);
        ui.find((node) => node.type === "form", ui.section(labels.booking));
      } else {
        assert.equal(ui.find((node) => node.type === "input" && node.props.type === "checkbox", ui.section(labels.leads)).props.checked, false);
      }
      const before = ui.render.content();
      const writes = ui.render.writes();
      const count = ui.requests.length;
      if (outcome === "success") ui.mutation.succeed(); else ui.mutation.fail(403);
      await ui.render.beforeEffects();
      assert.equal(ui.requests.length, count, "Observe the outcome before passive revalidation starts");
      assert.equal(ui.render.nodes().filter((node) => node.props.role === "status").length, outcome === 403 ? 1 : 0,
        "An obsolete mutation must never publish a saved-stage success notice");
      if (outcome === "success") {
        assert.equal(ui.render.content(), before);
        assert.equal(ui.render.writes(), writes + 1, "Only the settled live lease may write busy=false; stale success must not publish state");
        assert.equal(ui.denied(), 0);
        const control = ui.find((node) => target === "clinic-assignment"
          ? node.type === "input" && node.props.type === "checkbox"
          : node.type === "button" && typeof node.props["aria-expanded"] === "boolean", ui.section(labels.leads));
        assert.equal(control.props.disabled, false);
        await ui.render.flush();
        assert.equal(ui.requests.length, count, "Stale success cannot refresh the newer authorized list");
        return;
      }
      assert.equal(ui.denied(), 1, "A dispatched same-scope 403 must still invoke denial after a newer GET succeeds");
      assert.equal(ui.render.content().includes(leadPhone("refreshed")), false);
      assert.equal(ui.render.instances("BookingFields").length, 0);
      assert.equal(ui.render.nodes().filter((node) => node.type === "input" && node.props.type === "checkbox").length, 0);
      assert.equal(ui.render.nodes().filter((node) => node.type === "section" && node.props["aria-label"] === labels.booking).length, 0);
      assert.equal(text(ui.find((node) => node.props.role === "alert").props.children), "Synthetic CRM error 403");
      await ui.render.flush();
      const recheck = ui.take("LeadList");
      assert.equal(recheck.url, refreshed.url);
      assert.equal(recheck.settled, false);
      assert.equal(ui.requests.length, count + 1, "Late denial must issue exactly one fresh authorization read");
      assert.equal(ui.render.content().includes(leadPhone("refreshed")), false);
      recheck.succeed(freshData);
      await ui.render.flush();
      assert.equal(ui.denied(), 1);
      assert.equal(ui.requests.length, count + 1);
      assert.equal(ui.render.instances("BookingFields").length, 0, "Fresh authorization must not reopen the revoked booking form");
      assert.equal(ui.render.nodes().filter((node) => node.props.role === "status").length, 0);
      if (target === "clinic-assignment") assert.equal(ui.find((node) => node.type === "input" && node.props.type === "checkbox", ui.section(labels.leads)).props.checked, false);
    });
  }
}

const readTargets: ReadTarget[] = ["booking-doctors", "booking-services", "catalog-doctors", "catalog-services", "leads", "arrivals"];
for (const target of readTargets) {
  for (const status of [401, 403, "auth403"] as const) {
    test(`composed ${target}: ${status} closes actual sibling phone/form descendants before parent revalidation resolves`, async (t) => {
      const ui = await populated(t);
      const deniedRead = await startRead(ui, target);
      const parentCount = ui.requests.filter((request) => request.origin === "OperatorRequests").length;
      deny(deniedRead, status);
      await ui.render.beforeEffects();
      assertProtectedGone(ui);
      assert.equal(ui.denied(), 1, "A current denial must reach the optional portal callback exactly once");
      assert.equal(ui.requests.filter((request) => request.origin === "OperatorRequests").length, parentCount,
        "Observe sibling removal before the replacement parent GET effect");
      await ui.render.flush();
      const replacement = ui.take("OperatorRequests");
      assert.equal(replacement.settled, false, "Parent authorization is deliberately unresolved");
      assertProtectedGone(ui);
      replacement.succeed(list([{ id: REQUEST_A, status: "accepted", displayName: "Synthetic reverified clinic", pricePerArrivalMinor: "100", currency: "KZT", leadScope: "assigned" }]));
      await ui.render.flush();
      assertProtectedGone(ui);
      assert.equal(ui.render.nodes().filter((node) => node.type === "button" && node.props["aria-expanded"] === false).length, 3,
        "Fresh parent data must not reopen the old protected children");
    });
  }
  for (const failure of [409, 503, "network"] as const) {
    test(`composed ${target}: ${failure} never signals access denial or refreshes the parent`, async (t) => {
      const ui = await populated(t);
      const pending = await startRead(ui, target);
      const count = ui.requests.length;
      const parent = ui.render.instances("OperatorRequests")[0];
      if (failure === "network") pending.reject(); else pending.fail(failure);
      await ui.render.flush();
      assert.equal(ui.denied(), 0);
      assert.equal(ui.requests.length, count);
      assert.equal(ui.render.instances("OperatorRequests")[0], parent);
      if (target !== "leads") {
        assert.ok(ui.render.content().includes(leadPhone("A")), "A non-auth child failure must not revoke the sibling lead phone");
        ui.section(labels.booking);
        assert.ok(ui.render.nodes().some((node) => node.type === "input" && node.props.type === "datetime-local"));
      }
    });
  }
}
for (const target of ["stage", "call"] as const) {
  for (const status of [401, 403, "auth403"] as const) {
    test(`composed ${target}: ${status} revokes sibling phone/form descendants`, async (t) => {
      const ui = await populated(t);
      const mutation = await startAction(ui, target);
      deny(mutation, status);
      await ui.render.beforeEffects();
      assertProtectedGone(ui);
      assert.equal(ui.denied(), 1);
      await ui.render.flush();
      assert.equal(ui.take("OperatorRequests").settled, false);
      assertProtectedGone(ui);
    });
  }
  for (const failure of [409, 503, "network"] as const) {
    test(`composed ${target}: ${failure} does not escalate to portal access denial`, async (t) => {
      const ui = await populated(t);
      const mutation = await startAction(ui, target);
      const parentCount = ui.requests.filter((request) => request.origin === "OperatorRequests").length;
      if (failure === "network") mutation.reject(); else mutation.fail(failure);
      await ui.render.flush();
      assert.equal(ui.denied(), 0);
      assert.equal(ui.requests.filter((request) => request.origin === "OperatorRequests").length, parentCount);
      ui.section(labels.catalog);
      ui.section(labels.arrivals);
    });
  }
}

for (const outcome of [401, 403, "auth403", "success"] as const) {
  test(`composed aborted old child GET: late ${outcome} cannot clear a newly populated request scope`, async (t) => {
    const ui = await populated(t);
    const obsolete = await startRead(ui, "booking-doctors");
    const refresh = ui.render.nodes().find((node) => node.type === "button"
      && elements(node.props.children).some((child) => child.type === icons.RefreshCw));
    assert.ok(refresh); ui.invoke(refresh);
    await ui.render.flush();
    assert.equal(obsolete.signal?.aborted, true);
    await ui.open("B", REQUEST_B);
    const before = ui.render.content();
    const fields = ui.render.instances("BookingFields")[0];
    const count = ui.requests.length;
    const writes = ui.render.writes();
    if (outcome === "success") obsolete.succeed(list([{ id: DOCTOR, name: "OBSOLETE_DOCTOR_MUST_NOT_RENDER" }]));
    else deny(obsolete, outcome);
    await ui.render.flush();
    assertVisible(ui, "B");
    assert.equal(ui.render.content(), before);
    assert.equal(ui.render.instances("BookingFields")[0], fields);
    assert.equal(ui.requests.length, count);
    assert.equal(ui.denied(), 0);
    assert.equal(ui.render.writes(), writes, "An aborted old GET must not even attempt state writes or callbacks");
  });
}

for (const transition of ["path", "refresh", "ABA"] as const) {
  for (const outcome of [401, 403, "auth403", "success"] as const) {
    test(`real list currentness: ${transition} suppresses late ${outcome} before passive abort cleanup`, async (t) => {
      const ui = await runtime(t);
      const api = ui.load("api") as { useOperatorList: (path: string, enabled: boolean, callback: () => void) => { data: { items: { name: string }[] } | null; refresh: () => void } };
      let denied = 0;
      const onAccessDenied = () => { denied++; };
      let latest: ReturnType<typeof api.useOperatorList> | undefined;
      function Probe(props: Props) {
        latest = api.useOperatorList(props.path as string, true, onAccessDenied);
        return jsx("p", { children: latest.data?.items.map((item) => item.name).join(",") ?? "pending" });
      }
      ui.render.mount(jsx(Probe, { path: "synthetic-A" }));
      await ui.render.flush();
      const obsolete = ui.take("Probe");
      const instance = ui.render.instances("Probe")[0];
      if (transition === "refresh") latest!.refresh();
      else {
        ui.render.update(jsx(Probe, { path: "synthetic-B" }));
        if (transition === "ABA") ui.render.update(jsx(Probe, { path: "synthetic-A" }));
      }
      await ui.render.beforeEffects();
      assert.equal(ui.render.instances("Probe")[0], instance, "Scope changes must preserve the actual hook owner instance");
      assert.equal(obsolete.signal?.aborted, false, "Exercise the currentness guard before passive cleanup can abort");
      if (outcome === "success") obsolete.succeed(list([{ name: "OBSOLETE_VALUE" }])); else deny(obsolete, outcome);
      await ui.render.beforeEffects();
      assert.equal(denied, 0);
      assert.equal(ui.render.content(), "pending");
      await ui.render.flush();
      const current = ui.take("Probe");
      current.succeed(list([{ name: "CURRENT_VALUE" }]));
      await ui.render.flush();
      assert.equal(ui.render.content(), "CURRENT_VALUE");
      assert.equal(denied, 0);
    });
  }
}

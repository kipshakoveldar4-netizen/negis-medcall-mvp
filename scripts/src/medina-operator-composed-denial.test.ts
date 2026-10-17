import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  requests: "artifacts/negis/src/components/operators/OperatorRequests.tsx",
  leads: "artifacts/negis/src/components/operators/OperatorLeads.tsx",
  booking: "artifacts/negis/src/components/operators/OperatorBookingForm.tsx",
  catalog: "artifacts/negis/src/components/operators/OperatorServiceCatalog.tsx",
  arrivals: "artifacts/negis/src/components/operators/OperatorArrivals.tsx",
  api: "artifacts/negis/src/lib/operatorApi.ts",
  attempts: "artifacts/negis/src/lib/operatorBookingAttempt.ts",
  contracts: "lib/crm/operator-contracts.ts",
};
const compiled = (async () => {
  const result: Record<string, string> = {};
  for (const [name, filename] of Object.entries(files)) {
    const source = sourceRef === undefined ? await readFile(path.join(root, filename), "utf8")
      : execFileSync("git", ["show", `${sourceRef}:${filename}`], { cwd: root, encoding: "utf8" });
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
  | { kind: "effect"; deps: Dependencies; committed: boolean; draft?: { create: Effect; deps: Dependencies }; cleanup?: () => void };
const jsx = (type: unknown, props: Props, key?: unknown): Element => ({ type, props, key });
const Fragment = Symbol("Fragment");
const icons = Object.fromEntries([
  "Check", "X", "RefreshCw", "ChevronLeft", "ChevronRight", "CheckCircle2", "Phone", "PhoneOff", "XCircle",
  "Save", "Search", "CalendarPlus",
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
    useEffect(create: Effect, deps?: Dependencies) {
      slot("effect", () => ({ kind: "effect", deps: undefined, committed: false })).draft = { create, deps };
    },
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
    commit() {
      const pending = slots.filter((item): item is Extract<Slot, { kind: "effect" }> => item.kind === "effect"
        && item.draft !== undefined && (!item.committed || !sameDependencies(item.deps, item.draft.deps)));
      for (const item of pending) item.cleanup?.();
      for (const item of pending) {
        const draft = item.draft!;
        item.deps = draft.deps; item.committed = true;
        item.cleanup = draft.create() || undefined;
      }
      for (const item of slots) if (item.kind === "effect") item.draft = undefined;
      staged = false;
    },
    dispose() {
      if (disposed) return;
      disposed = true; dirty = false; staged = false;
      for (const item of slots) if (item.kind === "effect") item.cleanup?.();
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
  const hooks = Object.fromEntries(["useState", "useRef", "useMemo", "useCallback", "useEffect"].map((name) => [
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
    instance.driver?.dispose();
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
  function render() { rootInstance = reconcile(rootInstance, input); }
  async function drain(commit: boolean) {
    for (let index = 0; index < 32; index++) {
      if (!rootInstance || instances().some((instance) => instance.driver?.dirty())) render();
      if (commit) for (const instance of instances().reverse()) {
        if (instance.driver?.staged()) inside(instance, () => instance.driver!.commit());
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
    dispose() { if (rootInstance) dispose(rootInstance); rootInstance = undefined; },
  };
}

type Pending = {
  url: string;
  method: string;
  origin: string;
  body: Record<string, unknown> | undefined;
  signal?: AbortSignal;
  expectedUserId?: string;
  claimed: boolean;
  settled: boolean;
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
async function runtime(t: TestContext) {
  const source = await compiled;
  const render = renderer();
  t.after(() => render.dispose());
  const requests: Pending[] = [];
  const storage = new Map<string, string>();
  const globals = {
    Error, AbortController,
    window: { ...eventTarget(), confirm: () => true, sessionStorage: {
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
      if (name.endsWith("/crm/operator-contracts")) return load("contracts");
      const componentModules: Record<string, string> = {
        "./OperatorLeads": "leads", "./OperatorBookingForm": "booking", "./OperatorServiceCatalog": "catalog",
        "./OperatorArrivals": "arrivals", "@/lib/operatorApi": "api", "@/lib/operatorBookingAttempt": "attempts",
      };
      if (componentModules[name]) return load(componentModules[name]);
      if (name === "@/lib/api") return {
        CrmApiError: SyntheticCrmApiError,
        crmErrorMessage: (error: number | SyntheticCrmApiError) => `Synthetic CRM error ${typeof error === "number" ? error : error.status}`,
        crmFetch(url: string, init: RequestInit & { expectedUserId?: string }) {
          assert.equal(init.cache, "no-store");
          let resolve!: (response: unknown) => void;
          let reject!: (error: Error) => void;
          const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
          const settle = () => { assert.equal(request.settled, false); request.settled = true; };
          const reply = (payload: unknown, status: number) => {
            settle(); resolve({ ok: status < 400, status, json: async () => payload });
          };
          const request: Pending = {
            url, method: init.method ?? "GET", signal: init.signal ?? undefined,
            origin: render.origin(), expectedUserId: init.expectedUserId,
            body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
            claimed: false, settled: false,
            succeed(data) { reply({ success: true, ...(data === undefined ? {} : { data }) }, 200); },
            fail(status) { reply({ success: false, error: `Synthetic failure ${status}` }, status); },
            authFail(status) { settle(); reject(new SyntheticCrmApiError(status)); },
            reject() { settle(); reject(new Error("Synthetic network failure")); },
          };
          requests.push(request);
          // Intentionally ignore abort at transport level: guards must reject late results.
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
  return { render, requests, take, load, find, invoke, section, button };
}

const REQUEST_A = "11111111-1111-4111-8111-111111111111";
const REQUEST_B = "22222222-2222-4222-8222-222222222222";
const DOCTOR = "33333333-3333-4333-8333-333333333333";
const LEAD = "44444444-4444-4444-8444-444444444444";
const ACTOR = "55555555-5555-4555-8555-555555555555";
const list = (items: unknown[], extra = {}) => ({ items, hasMore: true, ...extra });
const doctors = () => list([{ id: DOCTOR, name: "Synthetic doctor", specialty: "Synthetic specialty" }]);
const services = () => list([{ id: "synthetic-service", name: "Synthetic catalog service", priceMinor: "100", durationMinutes: 30, currency: "KZT" }]);
const leadPhone = (scope: string) => `SYNTHETIC_LEAD_PHONE_${scope}`;
const arrivalPhone = (scope: string) => `SYNTHETIC_ARRIVAL_PHONE_${scope}`;
const labels = {
  booking: "\u0417\u0430\u043f\u0438\u0441\u044c \u043f\u0430\u0446\u0438\u0435\u043d\u0442\u0430",
  leads: "\u0417\u0430\u044f\u0432\u043a\u0438 \u043e\u043f\u0435\u0440\u0430\u0442\u043e\u0440\u0430",
  catalog: "\u041f\u0440\u0430\u0439\u0441 \u043a\u043b\u0438\u043d\u0438\u043a\u0438",
  arrivals: "\u041f\u0440\u0438\u0445\u043e\u0434\u044b \u043f\u0430\u0446\u0438\u0435\u043d\u0442\u043e\u0432",
};
type Ui = Awaited<ReturnType<typeof runtime>>;
async function populated(t: TestContext) {
  const ui = await runtime(t);
  let denied = 0;
  const onAccessDenied = () => { denied++; };
  const Requests = ui.load("requests").OperatorRequests;
  ui.render.mount(jsx(Requests, { actorId: ACTOR, onAccessDenied }));
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

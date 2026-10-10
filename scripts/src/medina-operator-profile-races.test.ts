import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

type OperatorProfile = {
  id: string;
  displayName: string;
  status: "pending" | "approved" | "suspended";
  acceptingRequests: boolean;
};

// Executable simulation of the real Portal, not physical React acceptance.
// Hooks, JSX records, auth and HTTP are controlled below. No DOM, StrictMode,
// child component execution, real crmFetch, environment or network is involved.
// Run: node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-operator-profile-races.test.ts
// Red baseline: node scripts/node_modules/tsx/dist/cli.mjs scripts/src/medina-operator-profile-races.test.ts --baseline
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const baseline = process.argv.includes("--baseline");

function compile(source: string, fileName: string) {
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const errors = result.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error) ?? [];
  assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, {
    getCurrentDirectory: () => root,
    getCanonicalFileName: (name) => name,
    getNewLine: () => "\n",
  }));
  return result.outputText;
}

const compiled = (async () => {
  const portalPath = path.join(root, "artifacts/negis/src/pages/OperatorPortal.tsx");
  const portalOrigin = baseline ? "git show 442e39f:artifacts/negis/src/pages/OperatorPortal.tsx" : portalPath;
  const portal = baseline
    ? execFileSync("git", ["show", "442e39f:artifacts/negis/src/pages/OperatorPortal.tsx"], { cwd: root, encoding: "utf8" })
    : await readFile(portalPath, "utf8");
  const apiPath = path.join(root, "artifacts/negis/src/lib/operatorApi.ts");
  const contractsPath = path.join(root, "lib/crm/operator-contracts.ts");
  return {
    portal: compile(portal, portalPath),
    api: compile(await readFile(apiPath, "utf8"), apiPath),
    contracts: compile(await readFile(contractsPath, "utf8"), contractsPath),
    portalHash: createHash("sha256").update(portal).digest("hex"),
    portalOrigin,
  };
})();

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

const OperatorRequests = Symbol("OperatorRequests boundary");
const RefreshCw = Symbol("RefreshCw");
const jsx = (type: unknown, props: Props, key?: unknown): Element => ({ type, props, key });

function elements(child: Child): Element[] {
  if (Array.isArray(child)) return child.flatMap(elements);
  if (child === null || typeof child !== "object") return [];
  return [child, ...elements(child.props.children)];
}

function text(child: Child): string {
  if (Array.isArray(child)) return child.map(text).join("");
  if (child !== null && typeof child === "object") return text(child.props.children);
  return typeof child === "string" || typeof child === "number" ? String(child) : "";
}

function sameDependencies(left: Dependencies, right: Dependencies) {
  return left !== undefined && right !== undefined && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]));
}

function hookDriver() {
  const slots: Slot[] = [];
  let cursor = 0;
  let rendering = false;
  let hookCount: number | undefined;
  let dirty = true;
  let tree: Child;
  let component: () => Child;

  function slot<K extends Slot["kind"]>(kind: K, create: () => Extract<Slot, { kind: K }>) {
    assert.ok(rendering, "Hooks must be called while rendering the Portal");
    const index = cursor++;
    if (!slots[index]) slots[index] = create();
    assert.equal(slots[index].kind, kind, "Hook order must remain stable");
    return slots[index] as Extract<Slot, { kind: K }>;
  }

  const hooks = {
    useState<T>(initial: T | (() => T)) {
      const current = slot("state", () => {
        const state: Extract<Slot, { kind: "state" }> = {
          kind: "state",
          value: typeof initial === "function" ? (initial as () => T)() : initial,
          set(update) {
            const value = typeof update === "function"
              ? (update as (previous: unknown) => unknown)(state.value) : update;
            if (!Object.is(value, state.value)) {
              state.value = value;
              dirty = true;
            }
          },
        };
        return state;
      });
      return [current.value as T, current.set] as const;
    },
    useRef<T>(initial: T) {
      return slot("ref", () => ({ kind: "ref", value: { current: initial } })).value;
    },
    useMemo<T>(create: () => T, deps?: readonly unknown[]) {
      const current = slot("memo", () => ({ kind: "memo", value: create(), deps }));
      if (!sameDependencies(current.deps, deps)) {
        current.value = create();
        current.deps = deps;
      }
      return current.value as T;
    },
    useCallback<T>(callback: T, deps?: readonly unknown[]) {
      return hooks.useMemo(() => callback, deps);
    },
    useEffect(create: Effect, deps?: readonly unknown[]) {
      const current = slot("effect", () => ({ kind: "effect", create, deps, pending: true }));
      if (!sameDependencies(current.deps, deps)) current.pending = true;
      current.create = create;
      current.deps = deps;
    },
  };

  function commit() {
    dirty = false;
    cursor = 0;
    rendering = true;
    try { tree = component(); } finally { rendering = false; }
    if (hookCount === undefined) hookCount = cursor;
    assert.equal(cursor, hookCount, "Conditional hooks are unsupported");
    const pending = slots.filter((item): item is Extract<Slot, { kind: "effect" }> =>
      item.kind === "effect" && item.pending);
    for (const effect of pending) effect.cleanup?.();
    for (const effect of pending) {
      effect.pending = false;
      effect.cleanup = effect.create() || undefined;
    }
  }

  return {
    hooks,
    mount(value: () => Child) { component = value; },
    // Bounded microtask draining, not sleeps or wall-clock timing. All external
    // promises remain pending until a test explicitly supplies their response.
    async flush() {
      for (let index = 0; index < 40; index++) {
        if (dirty) commit();
        await Promise.resolve();
      }
      assert.equal(dirty, false, "Simulation did not quiesce");
    },
    nodes: () => elements(tree),
    dispose() {
      for (const item of slots) if (item.kind === "effect") item.cleanup?.();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function eventTarget() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener(name: string, callback: () => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(callback);
    },
    removeEventListener(name: string, callback: () => void) { listeners.get(name)?.delete(callback); },
    dispatch(name: string) {
      const callbacks = [...(listeners.get(name) ?? [])];
      assert.ok(callbacks.length, `No listener for ${name}`);
      for (const callback of callbacks) callback();
    },
  };
}

type Session = { user: { id: string } } | null;
type HttpResponse = { ok: boolean; status: number; json(): Promise<unknown> };
type Request = {
  actorId: string | null;
  method: string;
  body: unknown;
  claimed: boolean;
  settled: boolean;
  succeed(value: OperatorProfile | null): void;
  fail(status: number, message?: string): void;
};

const session = (id: string | null): Session => id ? { user: { id } } : null;
const profile = (id: string, status: OperatorProfile["status"] = "approved", acceptingRequests = true): OperatorProfile => ({
  id, displayName: `Synthetic operator ${id}`, status, acceptingRequests,
});

async function fixture(t: TestContext, delayInitialSession = false) {
  const source = await compiled;
  const driver = hookDriver();
  t.after(() => driver.dispose());
  const initial = deferred<{ data: { session: Session } }>();
  let currentSession = session("A");
  let authListener: ((event: string, value: Session) => void) | undefined;
  const requests: Request[] = [];
  const windowEvents = eventTarget();
  const documentEvents = eventTarget();
  let now = 10_000;
  const unexpected = (name: string): never => assert.fail(`Unexpected simulation dependency: ${name}`);
  const globals = {
    Error, AbortController,
    Date: class extends Date { static now() { return now; } },
    window: { ...windowEvents, location: { origin: "https://simulation.invalid" } },
    document: { ...documentEvents, visibilityState: "visible" },
  };
  function evaluate<T>(code: string, filename: string, require: (name: string) => unknown) {
    const exports = {} as T;
    new Script(code, { filename }).runInNewContext({ ...globals, exports, require });
    return exports;
  }
  const contracts = evaluate<{ operatorStatusLabels: Record<string, string> }>(source.contracts, "operator-contracts.simulation.cjs", unexpected);
  const api = evaluate<object>(source.api, "operator-api.simulation.cjs", (name) => {
    if (name === "react") return driver.hooks;
    if (name === "../../../../lib/crm/operator-contracts") return contracts;
    if (name === "@/lib/api") return {
      crmErrorMessage: (status: number) => `Synthetic CRM error ${status}`,
      crmFetch(url: string, init: RequestInit) {
        assert.equal(url, "/api/crm/operator-account", "Only the profile endpoint is simulated");
        const pending = deferred<HttpResponse>();
        const reply = (payload: unknown, status: number) => {
          assert.equal(request.settled, false, "Each request must settle exactly once");
          request.settled = true;
          pending.resolve({ ok: status >= 200 && status < 300, status, json: async () => payload });
        };
        const request: Request = {
          actorId: currentSession?.user.id ?? null,
          method: init.method ?? "GET",
          body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
          claimed: false,
          settled: false,
          succeed(value) { reply({ success: true, data: value }, 200); },
          fail(status, message = `Synthetic refusal ${status}`) {
            reply({ success: false, code: "synthetic_failure", error: message }, status);
          },
        };
        requests.push(request);
        // Deliberately deliver even after signal abort: a response/body may
        // already be completing. Portal itself must reject stale publication.
        return pending.promise;
      },
    };
    return unexpected(name);
  });
  const portal = evaluate<{ default: () => Child }>(source.portal, "OperatorPortal.simulation.cjs", (name) => {
    if (name === "react") return driver.hooks;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: Symbol("Fragment") };
    if (name === "wouter") return { Link: Symbol("Link") };
    if (name === "lucide-react") return { RefreshCw, LogOut: Symbol("LogOut"), Send: Symbol("Send") };
    if (name === "@/lib/operatorApi") return api;
    if (name === "@/components/operators/OperatorRequests") return { OperatorRequests };
    if (name === "../../../../lib/crm/operator-contracts") return contracts;
    if (name === "../../../../lib/auth/password-rules") return { validatePasswordRules: () => unexpected("password validation") };
    if (name === "../../../../lib/auth/staff-logins") return {
      isSyntheticEmail: () => unexpected("email validation"),
      loginOrEmailToAuthEmail: () => unexpected("login conversion"),
    };
    if (name === "@/lib/supabase") return {
      hasSupabaseFrontendEnv: true,
      supabase: { auth: {
        getSession: () => initial.promise,
        onAuthStateChange(callback: typeof authListener) {
          authListener = callback;
          return { data: { subscription: { unsubscribe() { authListener = undefined; } } } };
        },
      } },
    };
    return unexpected(name);
  });
  driver.mount(portal.default);
  if (!delayInitialSession) initial.resolve({ data: { session: currentSession } });
  await driver.flush();

  function refreshButton() {
    const button = driver.nodes().find((node) => node.type === "button"
      && elements(node.props.children).some((child) => child.type === RefreshCw));
    assert.ok(button, "The real status refresh button must be rendered");
    return button;
  }
  function invoke(node: Element, name: string, event?: unknown) {
    assert.notEqual(node.props.disabled, true, "Do not invoke disabled UI controls");
    const handler = node.props[name];
    assert.equal(typeof handler, "function", `Expected ${name} handler`);
    (handler as (value?: unknown) => unknown)(event);
  }

  return {
    requests,
    labels: contracts.operatorStatusLabels,
    flush: driver.flush,
    initialSession(id: string) { initial.resolve({ data: { session: session(id) } }); },
    changeSession(id: string) {
      assert.ok(authListener, "Auth subscription must be installed");
      currentSession = session(id);
      authListener("SIGNED_IN", currentSession);
    },
    focus() { now += 1_000; windowEvents.dispatch("focus"); },
    take(method: string, actorId: string) {
      const request = requests.find((item) => !item.claimed && item.method === method && item.actorId === actorId);
      assert.ok(request, `Expected pending ${method} for ${actorId}`);
      request.claimed = true;
      return request;
    },
    toggle(value: boolean) {
      const checkbox = driver.nodes().find((node) => node.type === "input" && node.props.type === "checkbox");
      assert.ok(checkbox, "The real acceptingRequests checkbox must be rendered");
      invoke(checkbox, "onChange", { target: { checked: value } });
    },
    retry() { invoke(refreshButton(), "onClick"); },
    snapshot() {
      const nodes = driver.nodes();
      const section = nodes.find((node) => node.type === "section");
      const profileNodes = section ? elements(section) : [];
      const heading = profileNodes.find((node) => node.type === "h2");
      const status = profileNodes.find((node) => node.type === "p");
      const checkbox = profileNodes.find((node) => node.type === "input" && node.props.type === "checkbox");
      const cabinet = nodes.find((node) => node.type === OperatorRequests);
      return {
        profileName: heading ? text(heading) : null,
        status: status ? text(status) : null,
        acceptingRequests: checkbox ? Boolean(checkbox.props.checked) : null,
        cabinetActor: cabinet ? cabinet.props.actorId : null,
        message: nodes.filter((node) => node.props.role === "status").map(text).join("\n"),
        busy: Boolean(refreshButton().props.disabled),
      };
    },
  };
}

async function approvedFixture(t: TestContext) {
  const ui = await fixture(t);
  ui.take("GET", "A").succeed(profile("A"));
  await ui.flush();
  assert.equal(ui.snapshot().cabinetActor, "A", "Initial successful GET must open the real cabinet branch");
  assert.equal(ui.snapshot().busy, false);
  return ui;
}

test("simulation R3.1 delayed successful PATCH cannot restore approved after suspended focus GET", async (t) => {
  const source = await compiled;
  t.diagnostic(`Portal: ${source.portalOrigin}; SHA256: ${source.portalHash}; hook/JSX simulation, not React acceptance`);
  const ui = await approvedFixture(t);
  ui.toggle(false);
  await ui.flush();
  const oldSave = ui.take("PATCH", "A");
  assert.deepEqual(oldSave.body, { acceptingRequests: false });
  ui.focus();
  await ui.flush();
  ui.take("GET", "A").succeed(profile("A", "suspended"));
  await ui.flush();
  assert.equal(ui.snapshot().status, ui.labels.suspended);
  assert.equal(ui.snapshot().cabinetActor, null);
  oldSave.succeed(profile("A", "approved", false));
  await ui.flush();
  assert.equal(oldSave.settled, true, "The old successful save really completed");
  assert.deepEqual({ status: ui.snapshot().status, actor: ui.snapshot().cabinetActor }, {
    status: ui.labels.suspended, actor: null,
  }, "Late PATCH must not reopen a cabinet closed by a newer suspended GET");
});

test("simulation R3.2 delayed successful A save cannot replace the loaded B profile", async (t) => {
  const ui = await approvedFixture(t);
  ui.toggle(false);
  await ui.flush();
  const oldSave = ui.take("PATCH", "A");
  ui.changeSession("B");
  await ui.flush();
  ui.take("GET", "B").succeed(profile("B"));
  await ui.flush();
  assert.equal(ui.snapshot().profileName, profile("B").displayName);
  oldSave.succeed(profile("A", "approved", false));
  await ui.flush();
  assert.equal(ui.snapshot().profileName, profile("B").displayName, "Late A success must not publish its profile into B");
  assert.equal(ui.snapshot().cabinetActor, "B");
  assert.equal(ui.snapshot().acceptingRequests, true);
});

for (const status of [401, 403, 503]) {
  test(`simulation R3.3 late A save HTTP ${status} cannot replace B's current GET message`, async (t) => {
    const ui = await approvedFixture(t);
    ui.toggle(false);
    await ui.flush();
    const oldSave = ui.take("PATCH", "A");
    ui.changeSession("B");
    await ui.flush();
    ui.take("GET", "B").fail(503, "Synthetic current B GET failure");
    await ui.flush();
    const before = ui.snapshot();
    assert.equal(before.message, "Synthetic current B GET failure");
    oldSave.fail(status, "Synthetic obsolete A save failure");
    await ui.flush();
    assert.equal(ui.snapshot().message, before.message, "Late A refusal must not replace B's message");
    assert.equal(ui.snapshot().profileName, before.profileName);
    assert.equal(ui.snapshot().cabinetActor, null);
  });
}

for (const outcome of ["success", "refusal"] as const) {
  test(`simulation R3.4 session change unlocks B; late A ${outcome}/finally cannot release B's pending save`, async (t) => {
    const ui = await approvedFixture(t);
    ui.toggle(false);
    await ui.flush();
    const oldSave = ui.take("PATCH", "A");
    assert.equal(ui.snapshot().busy, true);
    ui.changeSession("B");
    await ui.flush();
    ui.take("GET", "B").succeed(profile("B"));
    await ui.flush();
    assert.equal(ui.snapshot().busy, false, "Session change must discard A's busy state so B can act");
    ui.toggle(false);
    await ui.flush();
    const newSave = ui.take("PATCH", "B");
    const before = ui.snapshot();
    assert.equal(before.busy, true);
    if (outcome === "success") oldSave.succeed(profile("A", "approved", false));
    else oldSave.fail(403);
    await ui.flush();
    assert.equal(newSave.settled, false, "B's own action must still be pending");
    assert.deepEqual(ui.snapshot(), before, "No obsolete success, catch or finally may mutate B's UI");
    newSave.succeed(profile("B", "approved", false));
    await ui.flush();
    assert.equal(ui.snapshot().busy, false);
    assert.equal(ui.snapshot().acceptingRequests, false);
  });
}

for (const status of [401, 403, 503]) {
  test(`simulation R3.5 current save HTTP ${status} closes approved until explicit successful GET retry`, async (t) => {
    const ui = await approvedFixture(t);
    ui.toggle(false);
    await ui.flush();
    const save = ui.take("PATCH", "A");
    const count = ui.requests.length;
    save.fail(status);
    await ui.flush();
    const refused = ui.snapshot();
    assert.ok(refused.message, "The current refusal must be explained");
    assert.equal(refused.busy, false, "The explicit retry must be enabled");
    assert.equal(ui.requests.length, count, "A save refusal must not silently issue a new GET");

    // Exercise manual recovery even on the red baseline, then assert the saved
    // refusal snapshot so failure does not prevent testing the retry handler.
    ui.retry();
    await ui.flush();
    assert.equal(ui.requests.length, count + 1, "The real refresh button must issue one fresh GET");
    assert.equal(ui.snapshot().cabinetActor, null, "Cabinet stays closed while retry is pending");
    const fresh = { ...profile("A", "approved", false), displayName: "Synthetic freshly verified A" };
    ui.take("GET", "A").succeed(fresh);
    await ui.flush();
    assert.equal(ui.snapshot().profileName, fresh.displayName);
    assert.equal(ui.snapshot().cabinetActor, "A");
    assert.equal(ui.snapshot().acceptingRequests, false);
    assert.equal(ui.snapshot().message, "");
    assert.deepEqual({ profile: refused.profileName, actor: refused.cabinetActor }, {
      profile: null, actor: null,
    }, `HTTP ${status} must immediately hide the previous approved profile/cabinet until manual verification`);
  });
}

test("simulation R3.6 an ordinary current successful PATCH updates the profile and finishes busy", async (t) => {
  const ui = await approvedFixture(t);
  ui.toggle(false);
  await ui.flush();
  assert.equal(ui.snapshot().busy, true);
  const saved = { ...profile("A", "approved", false), displayName: "Synthetic saved A" };
  ui.take("PATCH", "A").succeed(saved);
  await ui.flush();
  assert.equal(ui.snapshot().profileName, saved.displayName);
  assert.equal(ui.snapshot().status, ui.labels.approved);
  assert.equal(ui.snapshot().acceptingRequests, false);
  assert.equal(ui.snapshot().cabinetActor, "A");
  assert.equal(ui.snapshot().message, "");
  assert.equal(ui.snapshot().busy, false);
  assert.equal(ui.requests.length, 2, "Ordinary save must not require a redundant GET");
});

test("simulation R3.7 a delayed initial getSession A cannot supersede an observed B auth event", async (t) => {
  const ui = await fixture(t, true);
  assert.equal(ui.requests.length, 0);
  ui.changeSession("B");
  await ui.flush();
  ui.take("GET", "B").succeed(profile("B"));
  await ui.flush();
  const before = ui.snapshot();
  assert.equal(before.profileName, profile("B").displayName);
  ui.initialSession("A");
  await ui.flush();
  assert.equal(ui.requests.length, 1, "Stale initial session must not launch an A profile GET after the B auth event");
  assert.deepEqual(ui.snapshot(), before, "B must remain the current account");
});

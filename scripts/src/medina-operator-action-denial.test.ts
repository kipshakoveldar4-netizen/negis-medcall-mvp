import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Real components/list hook/transport in an isolated hook and JSX simulation.
// Nested components are boundary records, not executed React DOM children.
// No environment, authentication, network, database or browser is involved.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");

type Props = Record<string, unknown> & { children?: Child };
type Element = { type: unknown; props: Props; key?: unknown };
type Child = Element | string | number | boolean | null | undefined | Child[];
type Dependencies = readonly unknown[] | undefined;
type Effect = () => void | (() => void);
type Slot =
  | { kind: "state"; value: unknown; set(update: unknown): void }
  | { kind: "ref"; value: { current: unknown } }
  | { kind: "memo"; value: unknown; deps: Dependencies; initialized: boolean }
  | { kind: "effect"; deps: Dependencies; committed: boolean; draft?: { create: Effect; deps: Dependencies }; cleanup?: () => void };
type Kind = "requests" | "confirm" | "call";
type SyntheticList = { items: Record<string, unknown>[]; hasMore: boolean };
type Request = {
  url: string;
  method: string;
  signal?: AbortSignal;
  expectedUserId?: string;
  dispatchGuard?: () => boolean;
  body?: Record<string,string>;
  claimed: boolean;
  settled: boolean;
  succeed(data?: unknown): void;
  fail(status: number): void;
  reject(): void;
};

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
  let hookCount: number | undefined;
  let rendering = false;
  let retry = false;
  let dirty = true;
  let staged = false;
  let disposed = false;
  let setterCalls = 0;
  let tree: Child;
  let component: () => Child;
  function slot<K extends Slot["kind"]>(kind: K, create: () => Extract<Slot, { kind: K }>) {
    assert.ok(rendering, "Hooks must run during render");
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
            setterCalls++;
            if (disposed) return;
            const next = typeof update === "function"
              ? (update as (previous: unknown) => unknown)(state.value) : update;
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
        current.value = create();
        current.deps = deps;
        current.initialized = true;
      }
      return current.value as T;
    },
    useCallback<T>(callback: T, deps?: Dependencies) { return hooks.useMemo(() => callback, deps); },
    useEffect(create: Effect, deps?: Dependencies) {
      slot("effect", () => ({ kind: "effect", deps: undefined, committed: false })).draft = { create, deps };
    },
  };
  function renderBeforeEffects() {
    assert.equal(disposed, false);
    staged = false;
    for (let attempt = 0; attempt < 25; attempt++) {
      for (const item of slots) if (item.kind === "effect") item.draft = undefined;
      cursor = 0;
      dirty = false;
      retry = false;
      rendering = true;
      let candidate: Child;
      try { candidate = component(); } finally { rendering = false; }
      if (hookCount === undefined) hookCount = cursor;
      assert.equal(cursor, hookCount, "Conditional hooks are unsupported");
      if (retry) continue;
      tree = candidate;
      staged = true;
      return;
    }
    assert.fail("Render-phase retries did not converge");
  }
  function commitPassiveEffects() {
    const pending = slots.filter((item): item is Extract<Slot, { kind: "effect" }> =>
      item.kind === "effect" && item.draft !== undefined
      && (!item.committed || !sameDependencies(item.deps, item.draft.deps)));
    for (const item of pending) item.cleanup?.();
    for (const item of pending) {
      const draft = item.draft!;
      item.deps = draft.deps;
      item.committed = true;
      item.cleanup = draft.create() || undefined;
    }
    for (const item of slots) if (item.kind === "effect") item.draft = undefined;
    staged = false;
  }
  async function drain(commit: boolean) {
    for (let index = 0; index < 40; index++) {
      if (dirty && !disposed) renderBeforeEffects();
      if (commit && staged && !disposed) commitPassiveEffects();
      await Promise.resolve();
    }
    assert.equal(dirty, false, "Controlled microtasks must quiesce");
  }
  return {
    hooks,
    mount(value: () => Child) { component = value; },
    invalidate() { dirty = true; },
    renderBeforeEffects,
    flush: () => drain(true),
    drainBeforeEffects: () => drain(false),
    nodes: () => elements(tree),
    setterCalls: () => setterCalls,
    dispose() {
      if (disposed) return;
      disposed = true;
      dirty = false;
      staged = false;
      for (const item of slots) if (item.kind === "effect") item.cleanup?.();
    },
  };
}

function compile(source: string, filename: string) {
  const output = ts.transpileModule(source, {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  assert.equal(output.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
  return output.outputText;
}
const compiled = (async () => {
  const files = {
    requests: "artifacts/negis/src/components/operators/OperatorRequests.tsx",
    arrivals: "artifacts/negis/src/components/operators/OperatorArrivals.tsx",
    api: "artifacts/negis/src/lib/operatorApi.ts",
    contracts: "lib/crm/operator-contracts.ts",
    commandHook: "artifacts/negis/src/lib/useOperatorCommand.ts",
    commandAttempts: "artifacts/negis/src/lib/operatorCommandAttempt.ts",
  };
  const result: Record<string, string> = {};
  for (const [name, filename] of Object.entries(files)) {
    result[name] = compile(await readFile(path.join(root, filename), "utf8"), filename);
  }
  return result;
})();
const icons = Object.fromEntries([
  "Check", "X", "RefreshCw", "ChevronLeft", "ChevronRight", "CheckCircle2", "Phone", "PhoneOff", "XCircle",
].map((name) => [name, Symbol(name)]));
const boundaries = {
  OperatorLeads: Symbol("OperatorLeads"),
  OperatorServiceCatalog: Symbol("OperatorServiceCatalog"),
  OperatorArrivals: Symbol("OperatorArrivals"),
};
const RecoveryBoundary=Symbol("OperatorCommandRecovery");
const ACTION_ACTOR="11111111-1111-4111-8111-111111111111", ACTION_OTHER="22222222-2222-4222-8222-222222222222";
const ACTION_REQUEST="33333333-3333-4333-8333-333333333333", ACTION_WORKSPACE="44444444-4444-4444-8444-444444444444";

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
function dto(kind: Kind, label = "initial"): SyntheticList {
  const item = kind === "requests" ? {
    id: ACTION_REQUEST, status: "accepted", displayName: `Synthetic clinic ${label}`,
    clinicBrief: "Synthetic agreement", pricePerArrivalMinor: "100", currency: "KZT", leadScope: "assigned",
  } : {
    appointmentId: "synthetic-appointment", arrivalId: kind === "call" ? "synthetic-arrival" : null,
    status: "arrived", clientName: `Synthetic patient ${label}`, clientPhone: "SYNTHETIC_PHONE",
    startsAt: "2026-10-11T09:00:00Z", priceMinor: "100", currency: "KZT", service: "Synthetic service",
  };
  return { items: [item], hasMore: true };
}

async function fixture(t: TestContext, kind: Kind) {
  const source = await compiled;
  const driver = hookDriver();
  t.after(() => driver.dispose());
  const requests: Request[] = [];
  let sessionActor = ACTION_ACTOR;
  let sessionRevision = 0;
  function ownerProps(actorId: string) {
    const revision = sessionRevision;
    return { actorId, isSessionCurrent: () => sessionActor === actorId && sessionRevision === revision };
  }
  let props: Props = kind === "requests" ? ownerProps(ACTION_ACTOR)
    : { ...ownerProps(ACTION_ACTOR), requestId: "synthetic-request-A", ...(kind === "confirm" ? { workspaceId: "synthetic-workspace-A" } : {}) };
  const storage=new Map<string,string>();
  const globals = {
    Error, AbortController, crypto:{randomUUID},
    window: { ...eventTarget(), confirm: () => true,sessionStorage:{getItem:(key:string)=>storage.get(key)??null,
      setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)} },
    document: { ...eventTarget(), visibilityState: "visible" },
  };
  function evaluate<T>(code: string, require: (name: string) => unknown) {
    const exports = {} as T;
    new Script(code).runInNewContext({ ...globals, exports, require });
    return exports;
  }
  const unexpected = (name: string): never => assert.fail(`Unexpected simulation dependency: ${name}`);
  const contracts = evaluate<object>(source.contracts, unexpected);
  class SyntheticCrmApiError extends Error {
    constructor(readonly status: number) { super(`Synthetic CRM error ${status}`); }
  }
  const api = evaluate<object>(source.api, (name) => {
    if (name === "react") return { ...driver.hooks, useLayoutEffect: driver.hooks.useEffect };
    if (name === "../../../../lib/crm/operator-contracts") return contracts;
    if (name === "@/lib/api") return {
      CrmApiError: SyntheticCrmApiError,
      crmErrorMessage: (status: number) => `Synthetic CRM error ${status}`,
      crmFetch(url: string, init: RequestInit & { expectedUserId?: string; dispatchGuard?: () => boolean }) {
        assert.equal(init.cache, "no-store");
        let resolve!: (response: unknown) => void;
        let reject!: (error: Error) => void;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        const settle = () => {
          assert.equal(request.settled, false);
          request.settled = true;
        };
        const reply = (payload: unknown, status: number) => {
          settle();
          resolve({ ok: status < 400, status, json: async () => payload });
        };
        const request: Request = {
          url, method: init.method ?? "GET", signal: init.signal ?? undefined,
          expectedUserId: init.expectedUserId, dispatchGuard: init.dispatchGuard, claimed: false, settled: false,
          body:init.body?JSON.parse(String(init.body)):undefined,
          succeed(data) {
            if(data===undefined&&request.body?.commandId){const b=request.body,action=b.commandAction??b.action;
              data=b.action==="abandon"?{state:"abandoned",commandId:b.commandId,action,targetId:b.targetId,closedAt:"2030-01-07T05:00:00Z"}
                :{state:"committed",commandId:b.commandId,action,targetId:b.id,requestId:b.id,statusAtCommit:action==="accept"?"accepted":action==="end"?"ended":"declined",committedAt:"2030-01-07T05:00:00Z"};}
            reply({ success: true, ...(data === undefined ? {} : { data }) }, 200);
          },
          fail(status) { reply({ success: false, error: `Synthetic failure ${status}` }, status); },
          reject() { settle(); reject(new Error("Synthetic network failure")); },
        };
        requests.push(request);
        // Ignore abort deliberately so component guards must reject late outcomes.
        return promise;
      },
    };
    return unexpected(name);
  });
  const commandAttempts=evaluate<object>(source.commandAttempts,unexpected);
  const commandHook=evaluate<object>(source.commandHook,name=>{
    if(name==="react")return{...driver.hooks,useLayoutEffect:driver.hooks.useEffect};
    if(name==="@/lib/operatorApi")return api;if(name==="./operatorCommandAttempt")return commandAttempts;
    if(name.endsWith("/crm/operator-contracts"))return contracts;return unexpected(name);
  });
  const components = evaluate<Record<string, (props: Props) => Child>>(
    kind === "requests" ? source.requests : source.arrivals,
    (name) => {
      if (name === "react") return { ...driver.hooks, useLayoutEffect: driver.hooks.useEffect };
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: Symbol("Fragment") };
      if (name === "lucide-react") return icons;
      if (name === "./OperatorRequests.css") return {};
      if (name === "@/lib/operatorApi") return api;
      if (name === "@/lib/useOperatorCommand") return commandHook;
      if (name === "./OperatorCommandRecovery") return {OperatorCommandRecovery:RecoveryBoundary};
      if (name === "@/lib/serverAuth") return { getSupabaseAccessToken: async (expected: string) =>
        expected === sessionActor ? "synthetic-action-token" : "" };
      if (name === "@/lib/supabase") return { supabase: { auth: { getSession: async () => ({
        data: { session: sessionActor ? { user: { id: sessionActor } } : null }, error: null,
      }) } } };
      if (name === "../../../../../lib/crm/operator-contracts") return contracts;
      if (name === "./OperatorLeads") return { OperatorLeads: boundaries.OperatorLeads };
      if (name === "./OperatorServiceCatalog") return { OperatorServiceCatalog: boundaries.OperatorServiceCatalog };
      if (name === "./OperatorArrivals") return { OperatorArrivals: boundaries.OperatorArrivals };
      return unexpected(name);
    },
  );
  const component = kind === "requests" ? components.OperatorRequests : components.OperatorArrivals;
  driver.mount(() => component(props));
  function take(method: string) {
    const request = requests.find((item) => !item.claimed && item.method === method);
    assert.ok(request, `Expected pending ${method}`);
    request.claimed = true;
    return request;
  }
  function invoke(button: Element) {
    assert.notEqual(button.props.disabled, true);
    assert.equal(typeof button.props.onClick, "function");
    (button.props.onClick as () => void)();
  }
  function iconButton(icon: unknown) {
    const button = driver.nodes().find((node) => node.type === "button"
      && elements(node.props.children).some((child) => child.type === icon));
    assert.ok(button);
    return button;
  }
  function actionButton() {
    return kind === "requests"
      ? driver.nodes().find((node) => node.type === "button" && text(node.props.children).startsWith("\u0417\u0430\u0432\u0435\u0440\u0448"))
      : driver.nodes().find((node) => node.type === "button"
        && elements(node.props.children).some((child) => child.type === icons.CheckCircle2));
  }
  function openNested() {
    if (kind !== "requests") return;
    for (const button of driver.nodes().filter((node) => node.type === "button"
      && node.props["aria-expanded"] === false)) invoke(button);
  }
  function snapshot() {
    const nodes = driver.nodes();
    return {
      content: nodes.filter((node) => node.type === "p" || node.type === "h3").map((node) => text(node.props.children)),
      cards: nodes.filter((node) => node.type === "article").length,
      phones: nodes.filter((node) => node.type === "a").map((node) => node.props.href),
      nested: Object.entries(boundaries).filter(([, type]) => nodes.some((node) => node.type === type)).map(([name]) => name),
      busy: Boolean(actionButton()?.props.disabled),
    };
  }
  await driver.flush();
  take("GET").succeed(dto(kind));
  await driver.flush();
  openNested();
  await driver.flush();
  assert.equal(snapshot().cards, 1);
  if (kind === "requests") assert.equal(snapshot().nested.length, 3);
  if (kind === "call") assert.deepEqual(snapshot().phones, ["tel:SYNTHETIC_PHONE"]);
  async function closeOriginalCommand(){
    const boundary=driver.nodes().find(node=>node.type===RecoveryBoundary);assert.ok(boundary);
    const command=boundary.props.command as {attempt:{commandId:string;action:string;targetId:string;actorId:string};path:string;
      isCurrent(attempt?:unknown):boolean;complete(attempt:unknown,value:unknown):unknown};
    const attempt=command.attempt;assert.ok(attempt);
    const result=(api as {operatorApi(path:string,body:unknown,method:string,signal:undefined,actor:string,guard:()=>boolean):Promise<unknown>})
      .operatorApi(command.path,{action:"abandon",commandId:attempt.commandId,commandAction:attempt.action,targetId:attempt.targetId},"PATCH",undefined,attempt.actorId,()=>command.isCurrent(attempt));
    await driver.flush();take("PATCH").succeed();const value=await result;
    const confirmed=command.complete(attempt,value);assert.ok(confirmed);
    (boundary.props.onResolved as (attempt:unknown,result:unknown)=>void)(attempt,confirmed);await driver.flush();
  }
  return {
    requests, take, snapshot, openNested,
    closeOriginalCommand,
    flush: driver.flush,
    drainBeforeEffects: driver.drainBeforeEffects,
    renderBeforeEffects: driver.renderBeforeEffects,
    dispose: driver.dispose,
    setterCalls: driver.setterCalls,
    async startAction() {
      const button = actionButton();
      assert.ok(button, "The real mutation button must be present");
      invoke(button);
      await driver.flush();
      assert.equal(snapshot().busy, true);
      const mutation = take(kind === "confirm" ? "POST" : "PATCH");
      assert.equal(mutation.expectedUserId, props.actorId,
        "Clinic and operator writes must pin their original actor");
      const arrivals = driver.nodes().find((node) => node.type === boundaries.OperatorArrivals);
      if (arrivals) assert.equal(arrivals.props.actorId, props.actorId,
        "Requests must preserve the actor for the nested Arrivals view in either mode");
      return mutation;
    },
    changeScope() {
      props = kind === "requests" ? { ...props, workspaceId: ACTION_WORKSPACE }
        : { ...props, requestId: "synthetic-request-B" };
      driver.invalidate();
    },
    changeActor() {
      // A replacement owner gets a new lifetime; old callbacks keep the retired revision.
      sessionRevision++;
      sessionActor = ACTION_OTHER;
      props = { ...props, ...ownerProps(ACTION_OTHER) };
      driver.invalidate();
    },
    changeSessionActor(actorId: string) {
      if (sessionActor !== actorId) sessionRevision++;
      sessionActor = actorId;
    },
    refresh() { invoke(iconButton(icons.RefreshCw)); },
    next() { invoke(iconButton(icons.ChevronRight)); },
  };
}

function hidden(view: ReturnType<Awaited<ReturnType<typeof fixture>>["snapshot"]>) {
  assert.equal(view.cards, 0, "Previous agreement/patient cards must be removed");
  assert.deepEqual(view.phones, [], "Previous patient phone links must be removed");
  assert.deepEqual(view.nested, [], "All nested protected boundaries must be removed");
}
const kinds: Kind[] = ["requests", "confirm", "call"];
for (const kind of kinds) {
  for (const status of [401, 403]) {
    test(`${kind}: HTTP ${status} hides old cards before effects and closes nested views on revalidation`, async (t) => {
      const ui = await fixture(t, kind);
      const mutation = await ui.startAction();
      mutation.fail(status);
      await ui.drainBeforeEffects();
      hidden(ui.snapshot());
      assert.ok(ui.snapshot().content.includes(`Synthetic CRM error ${status}`));
      assert.equal(ui.requests.length, 2, "Observe invalidation before the replacement GET effect");
      await ui.flush();
      assert.equal(ui.requests.length, 3, "Only one fresh authorization GET is required");
      ui.take("GET").succeed(dto(kind, "reverified"));
      await ui.flush();
      assert.equal(ui.snapshot().cards, 1, "Only a fresh successful GET can restore cards");
      assert.deepEqual(ui.snapshot().nested, [], "Reverification must not reopen any of the three old nested views");
      assert.equal(ui.snapshot().busy, kind==="requests");
      if(kind==="requests"){await ui.closeOriginalCommand();assert.equal(ui.snapshot().busy,false);}
    });
  }
  for (const failure of [409, 503, "network"] as const) {
    test(`${kind}: non-auth ${failure} respects request-specific refusal without clearing unrelated authority`, async (t) => {
      const ui = await fixture(t, kind);
      const before = ui.snapshot();
      const mutation = await ui.startAction();
      if (failure === "network") mutation.reject(); else mutation.fail(failure);
      await ui.flush();
      const after = ui.snapshot();
      if (kind === "requests" && failure === 409) {
        assert.equal(after.cards, before.cards, "Retain the non-contact agreement summary during its scoped refresh");
        assert.deepEqual(after.phones, []); assert.deepEqual(after.nested, []);
        assert.equal(ui.requests.length, 3, "A current request conflict revalidates its list");
        assert.ok(after.content.includes("Synthetic failure 409"));
        ui.take("GET").succeed(dto(kind, "reverified")); await ui.flush();
        assert.equal(ui.snapshot().cards, 1); assert.deepEqual(ui.snapshot().nested, []);
        assert.equal(ui.snapshot().busy, true);await ui.closeOriginalCommand();assert.equal(ui.snapshot().busy,false);
        return;
      }
      assert.equal(ui.requests.length, 2);
      assert.equal(after.cards, before.cards);
      assert.deepEqual(after.phones, before.phones);
      assert.deepEqual(after.nested, before.nested);
      assert.ok(after.content.includes(failure === "network" ? "Synthetic network failure" : `Synthetic failure ${failure}`));
      assert.equal(after.busy, kind==="requests");
      if(kind==="requests"){await ui.closeOriginalCommand();assert.equal(ui.snapshot().busy,false);}
    });
  }
  test(`${kind}: a current successful mutation still refreshes and releases busy`, async (t) => {
    const ui = await fixture(t, kind);
    (await ui.startAction()).succeed();
    await ui.flush();
    hidden(ui.snapshot());
    assert.equal(ui.requests.length, 3);
    ui.take("GET").succeed(dto(kind, "saved"));
    await ui.flush();
    assert.equal(ui.snapshot().cards, 1);
    assert.equal(ui.snapshot().busy, false);
    assert.deepEqual(ui.snapshot().nested, []);
  });
  for (const outcome of ["success", "denial"] as const) {
    test(`${kind}: late ${outcome} cannot alter a new scope or unlock its pending action`, async (t) => {
      const ui = await fixture(t, kind);
      const obsolete = await ui.startAction();
      ui.changeScope();
      ui.renderBeforeEffects();
      hidden(ui.snapshot());
      await ui.flush();
      ui.take("GET").succeed(dto(kind, "new-scope"));
      await ui.flush();
      ui.openNested();
      await ui.flush();
      const current = await ui.startAction();
      const before = ui.snapshot();
      const count = ui.requests.length;
      if (outcome === "success") obsolete.succeed(); else obsolete.fail(403);
      await ui.flush();
      assert.deepEqual(ui.snapshot(), before);
      assert.equal(ui.requests.length, count, "Obsolete callbacks cannot refresh the new list");
      assert.equal(current.settled, false);
      current.fail(409);
      await ui.flush();
    });
    test(`${kind}: unmounted late ${outcome} makes no state writes and cannot affect a remount`, async (t) => {
      const old = await fixture(t, kind);
      const obsolete = await old.startAction();
      old.dispose();
      const writes = old.setterCalls();
      const fresh = await fixture(t, kind);
      const current = await fresh.startAction();
      const before = fresh.snapshot();
      if (outcome === "success") obsolete.succeed(); else obsolete.fail(403);
      await old.flush();
      assert.equal(old.setterCalls(), writes, "Unmount guards must stop writes, not rely on React ignoring them");
      assert.equal(old.requests.length, 2);
      assert.deepEqual(fresh.snapshot(), before);
      current.fail(409);
      await fresh.flush();
    });
  }
  test(`${kind}: late denial for a different actor cannot invalidate the same path's current view`, async (t) => {
    const ui = await fixture(t, kind);
    const obsolete = await ui.startAction();
    ui.changeActor();
    ui.renderBeforeEffects();
    hidden(ui.snapshot());
    assert.equal(obsolete.dispatchGuard?.(), false, "The original actor's action must remain expired");
    await ui.flush();
    const replacement = ui.take("GET");
    assert.equal(replacement.url, ui.requests[0].url, "Actor replacement must keep the same list path");
    assert.equal(replacement.expectedUserId, ACTION_OTHER);
    assert.equal(replacement.dispatchGuard?.(), true, "The replacement list needs its own live actor lifetime");
    replacement.succeed(dto(kind, "new-actor"));
    await ui.flush();
    ui.openNested();
    await ui.flush();
    const current = await ui.startAction();
    assert.equal(current.dispatchGuard?.(), true);
    const before = ui.snapshot();
    const count = ui.requests.length;
    obsolete.fail(403);
    await ui.flush();
    assert.deepEqual(ui.snapshot(), before);
    assert.equal(ui.requests.length, count);
    assert.equal(current.settled, false);
    current.fail(409);
    await ui.flush();
  });
  for (const transition of ["refresh", "next"] as const) {
    for (const outcome of [401, 403, "success", 500] as const) {
      const denied = outcome === 401 || outcome === 403;
      test(`${kind}: same-scope ${transition} ${denied ? `late ${outcome} hides the newer protected view` : `suppresses obsolete ${outcome}`}`, async (t) => {
        const ui = await fixture(t, kind);
        const obsolete = await ui.startAction();
        ui[transition]();
        ui.renderBeforeEffects();
        hidden(ui.snapshot());
        await ui.flush();
        ui.take("GET").succeed(dto(kind, "pre-revocation"));
        await ui.flush();
        ui.openNested();
        await ui.flush();
        assert.equal(ui.snapshot().busy, true, "Fresh list data must retain the unresolved original command");
        const before = ui.snapshot();
        const count = ui.requests.length;
        if (outcome === "success") obsolete.succeed(); else obsolete.fail(outcome);
        if (denied) {
          await ui.drainBeforeEffects();
          hidden(ui.snapshot());
          assert.ok(ui.snapshot().content.includes(`Synthetic CRM error ${outcome}`));
          assert.equal(ui.requests.length, count, "The refusal must hide the current view before a replacement GET");
          await ui.flush();
          assert.equal(ui.requests.length, count + 1, "Same-scope refusal must revalidate the current page once");
          const replacement = ui.take("GET");
          assert.equal(replacement.url, ui.requests[2].url, "Revalidation must retain the current page offset");
          hidden(ui.snapshot());
          assert.ok(ui.snapshot().content.includes(`Synthetic CRM error ${outcome}`));
          replacement.succeed(dto(kind, "reverified"));
          await ui.flush();
          assert.equal(ui.snapshot().cards, 1);
          assert.deepEqual(ui.snapshot().nested, [], "A late refusal must close all three nested views, even after a newer GET");
          assert.equal(ui.snapshot().busy, kind==="requests");
          if(kind==="requests"){await ui.closeOriginalCommand();assert.equal(ui.snapshot().busy,false);}
        } else {
          await ui.flush();
          assert.deepEqual({ ...ui.snapshot(), busy: before.busy }, before,
            "Only the settled row lease may change; no obsolete content/error is published");
          assert.equal(ui.snapshot().busy, kind==="requests");
          assert.equal(ui.requests.length, count);
          if(kind==="requests")await ui.closeOriginalCommand();
          const next = await ui.startAction();
          next.fail(409);
          await ui.flush();
        }
      });
    }
  }
}

for (const transition of ["A-B", "A-B-A"] as const) {
  for (const outcome of ["success", "network", 401, 403] as const) {
    test(`confirm: raw ${transition} session expiration suppresses late ${outcome} without a render`, async (t) => {
      const ui = await fixture(t, "confirm");
      const obsolete = await ui.startAction();
      ui.changeSessionActor(ACTION_OTHER);
      if (transition === "A-B-A") ui.changeSessionActor(ACTION_ACTOR);
      const before = ui.snapshot();
      const writes = ui.setterCalls();
      const count = ui.requests.length;
      if (outcome === "success") obsolete.succeed();
      else if (outcome === "network") obsolete.reject();
      else obsolete.fail(outcome);
      await ui.drainBeforeEffects();
      assert.deepEqual(ui.snapshot(), before, "Expired success/error/finally must not alter the old rendered view");
      assert.equal(ui.setterCalls(), writes, "Session invalidation must stop writes before React rerenders or unmounts");
      assert.equal(ui.requests.length, count, "An expired confirmation cannot refresh authorization");
      await ui.flush();
      assert.deepEqual(ui.snapshot(), before);
      assert.equal(ui.setterCalls(), writes);
      assert.equal(ui.requests.length, count);
    });
  }
}

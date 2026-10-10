import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Isolated executable simulation of the REAL useOperatorList/operatorApi module.
// This is not React DOM, StrictMode, concurrent rendering or physical-device
// acceptance. Only state/ref/memo/callback/passive-effect ordering is modeled;
// authentication, crmFetch and error formatting are synthetic. No environment,
// network, clinic, cloud or secret is read. Unknown VM imports fail closed.
// Run: node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-operator-list-races.test.ts
// Red baseline: node scripts/node_modules/tsx/dist/cli.mjs scripts/src/medina-operator-list-races.test.ts --baseline
// --baseline uses ONLY git show c9cd207:artifacts/negis/src/lib/operatorApi.ts
// in memory: it never checks out, rewrites or restores any repository file.
// DTO types are local, avoiding imports outside scripts/src (TS6059 rootDir).
type SyntheticItem = { id: string; name: string };
type SyntheticList = {
  items: SyntheticItem[];
  hasMore: boolean;
  stages?: { id: string; name: string }[];
  stageEditingAvailable?: boolean;
};
type ListView = {
  data: SyntheticList | null;
  error: string;
  offset: number;
  refresh(): void;
  previous(): void;
  next(): void;
};
type Api = { useOperatorList(path: string, enabled?: boolean): ListView };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const baseline = process.argv.includes("--baseline");
const pinnedApi = "c9cd207:artifacts/negis/src/lib/operatorApi.ts";

function compile(source: string, fileName: string) {
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
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
  const apiPath = path.join(root, "artifacts/negis/src/lib/operatorApi.ts");
  const api = baseline
    ? execFileSync("git", ["show", pinnedApi], { cwd: root, encoding: "utf8" })
    : await readFile(apiPath, "utf8");
  const contractsPath = path.join(root, "lib/crm/operator-contracts.ts");
  return {
    api: compile(api, apiPath),
    contracts: compile(await readFile(contractsPath, "utf8"), contractsPath),
    origin: baseline ? `git show ${pinnedApi}` : apiPath,
    hash: createHash("sha256").update(api).digest("hex"),
  };
})();

type Dependencies = readonly unknown[] | undefined;
type Effect = () => void | (() => void);
type EffectDraft = { create: Effect; deps: Dependencies };
type Slot =
  | { kind: "state"; value: unknown; set(update: unknown): void }
  | { kind: "ref"; value: { current: unknown } }
  | { kind: "memo"; value: unknown; deps: Dependencies; initialized: boolean }
  | { kind: "effect"; deps: Dependencies; committed: boolean; draft?: EffectDraft; cleanup?: () => void };

function sameDependencies(left: Dependencies, right: Dependencies) {
  return left !== undefined && right !== undefined && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]));
}

function hookDriver<T>() {
  const slots: Slot[] = [];
  let cursor = 0;
  let rendering = false;
  let retry = false;
  let hookCount: number | undefined;
  let dirty = true;
  let staged = false;
  let disposed = false;
  let view: T;
  let component: (() => T) | undefined;
  let discardedRenders = 0;

  function slot<K extends Slot["kind"]>(kind: K, create: () => Extract<Slot, { kind: K }>) {
    assert.ok(rendering, "Hooks must be called while rendering");
    const index = cursor++;
    if (!slots[index]) slots[index] = create();
    assert.equal(slots[index].kind, kind, `Hook ${index} must keep its order/kind`);
    return slots[index] as Extract<Slot, { kind: K }>;
  }

  const hooks = {
    useState<S>(initial: S | (() => S)) {
      const current = slot("state", () => {
        const state: Extract<Slot, { kind: "state" }> = {
          kind: "state",
          value: typeof initial === "function" ? (initial as () => S)() : initial,
          set(update) {
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
      return [current.value as S, current.set] as const;
    },
    useRef<S>(initial: S) {
      return slot("ref", () => ({ kind: "ref", value: { current: initial } })).value as { current: S };
    },
    useMemo<S>(create: () => S, deps?: Dependencies) {
      const current = slot("memo", () => ({ kind: "memo", value: undefined, deps: undefined, initialized: false }));
      if (!current.initialized || !sameDependencies(current.deps, deps)) {
        current.value = create();
        current.deps = deps;
        current.initialized = true;
      }
      return current.value as S;
    },
    useCallback<S>(callback: S, deps?: Dependencies) {
      return hooks.useMemo(() => callback, deps);
    },
    useEffect(create: Effect, deps?: Dependencies) {
      const current = slot("effect", () => ({ kind: "effect", deps: undefined, committed: false }));
      current.draft = { create, deps };
    },
  };

  function renderBeforeEffects() {
    assert.ok(component, "Mount a component before rendering");
    assert.equal(disposed, false, "An unmounted driver cannot render");
    staged = false;
    for (let attempt = 0; attempt < 25; attempt++) {
      // Render-phase state changes discard that render AND its effect drafts.
      // Only the final retry can be observed/committed, and effect dependencies
      // are compared with the last passive commit, not an abandoned draft.
      for (const current of slots) if (current.kind === "effect") current.draft = undefined;
      cursor = 0;
      dirty = false;
      retry = false;
      rendering = true;
      let candidate: T;
      try { candidate = component(); } finally { rendering = false; }
      if (hookCount === undefined) hookCount = cursor;
      assert.equal(cursor, hookCount, "Conditional hooks are unsupported");
      if (retry) {
        discardedRenders++;
        continue;
      }
      view = candidate;
      staged = true;
      return view;
    }
    return assert.fail("Render-phase state retries did not converge");
  }

  function commitPassiveEffects() {
    assert.equal(staged, true, "Render before committing passive effects");
    assert.equal(dirty, false, "Updated state must render again before effect commit");
    const pending = slots.filter((current): current is Extract<Slot, { kind: "effect" }> =>
      current.kind === "effect" && current.draft !== undefined
      && (!current.committed || !sameDependencies(current.deps, current.draft.deps)));
    for (const effect of pending) effect.cleanup?.();
    for (const effect of pending) {
      const draft = effect.draft!;
      effect.deps = draft.deps;
      effect.committed = true;
      effect.cleanup = draft.create() || undefined;
    }
    for (const current of slots) if (current.kind === "effect") current.draft = undefined;
    staged = false;
  }

  return {
    hooks,
    mount(value: () => T) { component = value; dirty = true; },
    invalidate() { dirty = true; },
    renderBeforeEffects,
    commitPassiveEffects,
    view: () => view,
    discardedRenders: () => discardedRenders,
    // Microtasks only: controlled HTTP promises never settle on a timer. The
    // pre-effect drain lets an obsolete response land before effect cleanup.
    async drainBeforeEffects() {
      for (let index = 0; index < 40; index++) {
        if (dirty && !disposed) renderBeforeEffects();
        await Promise.resolve();
      }
      assert.equal(dirty, false, "Pre-effect simulation did not quiesce");
    },
    async flush() {
      for (let index = 0; index < 40; index++) {
        if (dirty && !disposed) renderBeforeEffects();
        if (staged && !disposed) commitPassiveEffects();
        await Promise.resolve();
      }
      assert.equal(dirty, false, "Simulation did not quiesce");
      assert.equal(staged, false, "Passive effects must finish");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      dirty = false;
      staged = false;
      for (const current of slots) if (current.kind === "effect") {
        current.cleanup?.();
        current.cleanup = undefined;
        current.draft = undefined;
      }
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type HttpResponse = { ok: boolean; status: number; json(): Promise<unknown> };
type Request = {
  url: string;
  signal: AbortSignal;
  claimed: boolean;
  settled: boolean;
  succeed(data: SyntheticList): void;
  fail(message: string): void;
  reject(message: string): void;
};

const A = "operator-leads?requestId=synthetic-A";
const B = "operator-leads?requestId=synthetic-B";
const C = "operator-requests";
const dto = (name: string, hasMore = true): SyntheticList => ({
  items: [{ id: `synthetic-${name}`, name: `Synthetic item ${name}` }],
  hasMore,
  stages: [{ id: "synthetic-stage", name: "Synthetic stage" }],
  stageEditingAvailable: true,
});
const requestUrl = (resource: string, offset: number) =>
  `/api/crm/${resource}${resource.includes("?") ? "&" : "?"}offset=${offset}`;

async function fixture(t: TestContext, resource = A, initiallyEnabled = true) {
  const source = await compiled;
  const driver = hookDriver<ListView>();
  t.after(() => driver.dispose());
  const requests: Request[] = [];
  let currentPath = resource;
  let enabled = initiallyEnabled;
  const unexpected = (name: string): never => assert.fail(`Unexpected simulation dependency: ${name}`);
  function evaluate<T>(code: string, filename: string, require: (name: string) => unknown) {
    const exports = {} as T;
    new Script(code, { filename }).runInNewContext({ exports, require, Error, AbortController });
    return exports;
  }
  const contracts = evaluate<{ OPERATOR_PAGE_SIZE: number }>(source.contracts, "operator-contracts.list-simulation.cjs", unexpected);
  assert.ok(Number.isInteger(contracts.OPERATOR_PAGE_SIZE) && contracts.OPERATOR_PAGE_SIZE > 0);
  class SyntheticCrmApiError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) { super(message); }
  }
  const api = evaluate<Api>(source.api, "operator-api.list-simulation.cjs", (name) => {
    if (name === "react") return driver.hooks;
    if (name === "../../../../lib/crm/operator-contracts") return contracts;
    if (name === "@/lib/api") return {
      CrmApiError: SyntheticCrmApiError,
      crmErrorMessage: (status: unknown) => `Synthetic CRM error ${status}`,
      crmFetch(url: string, init: RequestInit) {
        assert.equal(init.method, "GET", "The real operatorApi must make a bodyless GET");
        assert.equal(init.cache, "no-store");
        assert.equal(init.body, undefined);
        assert.ok(init.signal instanceof AbortSignal, "Each effect must forward its AbortSignal");
        const pending = deferred<HttpResponse>();
        const markSettled = () => {
          assert.equal(request.settled, false, "A controlled response must settle once");
          request.settled = true;
        };
        const reply = (payload: unknown, status: number) => {
          markSettled();
          pending.resolve({ ok: status >= 200 && status < 300, status, json: async () => payload });
        };
        const request: Request = {
          url,
          signal: init.signal,
          claimed: false,
          settled: false,
          succeed(data) { reply({ success: true, data }, 200); },
          fail(message) { reply({ success: false, error: message, code: "synthetic_refusal" }, 503); },
          reject(message) { markSettled(); pending.reject(new Error(message)); },
        };
        requests.push(request);
        // Deliberately ignore init.signal: late transport/body completion must
        // be rejected by hook identity, not by a cooperative fetch mock.
        return pending.promise;
      },
    };
    return unexpected(name);
  });
  driver.mount(() => api.useOperatorList(currentPath, enabled));
  const snapshot = () => {
    const { data, error, offset } = driver.view();
    return { data, error, offset };
  };
  return {
    requests,
    pageSize: contracts.OPERATOR_PAGE_SIZE,
    flush: driver.flush,
    drainBeforeEffects: driver.drainBeforeEffects,
    renderBeforeEffects() { driver.renderBeforeEffects(); return snapshot(); },
    snapshot,
    setPath(value: string) { currentPath = value; driver.invalidate(); },
    setEnabled(value: boolean) { enabled = value; driver.invalidate(); },
    refresh() { driver.view().refresh(); },
    next() { driver.view().next(); },
    previous() { driver.view().previous(); },
    dispose: driver.dispose,
    take(resource: string, offset = 0) {
      const url = requestUrl(resource, offset);
      const request = requests.find((item) => !item.claimed && item.url === url);
      assert.ok(request, `Expected fresh request ${url}; received: ${requests.map((item) => item.url).join(", ")}`);
      request.claimed = true;
      return request;
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Snapshot = ReturnType<Fixture["snapshot"]>;
function hidden(view: Snapshot, offset = 0) {
  assert.deepEqual(view, { data: null, error: "", offset }, "Obsolete data AND errors must be hidden before passive effects");
}

async function loadedFixture(t: TestContext, result: "data" | "error" = "data") {
  const ui = await fixture(t);
  await ui.flush();
  const initial = ui.take(A);
  const data = dto("initial-A");
  if (result === "data") initial.succeed(data);
  else initial.fail("Synthetic current A refusal");
  await ui.flush();
  if (result === "data") assert.equal(ui.snapshot().data, data, "The real operatorApi must publish its DTO");
  else assert.equal(ui.snapshot().error, "Synthetic current A refusal", "The real operatorApi refusal must reach the hook");
  return ui;
}

test("simulation driver discards render-phase retries and commits only final passive effects", () => {
  const driver = hookDriver<{ resource: string; offset: number }>();
  const effects: string[] = [];
  let resource = A;
  driver.mount(() => {
    const [page, setPage] = driver.hooks.useState({ resource, offset: 20 });
    if (page.resource !== resource) setPage({ resource, offset: 0 });
    // B appears in both the discarded and final renders. Comparing against
    // draft dependencies instead of A's committed dependencies would skip B.
    driver.hooks.useEffect(() => {
      effects.push(`fetch:${resource}:${page.offset}`);
      const cleanup = `cleanup:${resource}:${page.offset}`;
      return () => { effects.push(cleanup); };
    }, [resource]);
    return { resource, offset: page.offset };
  });
  assert.deepEqual(driver.renderBeforeEffects(), { resource: A, offset: 20 });
  assert.deepEqual(effects, [], "Even mount must be observable before effects");
  driver.commitPassiveEffects();
  resource = B;
  driver.invalidate();
  assert.deepEqual(driver.renderBeforeEffects(), { resource: B, offset: 0 });
  assert.equal(driver.discardedRenders(), 1);
  assert.deepEqual(effects, [`fetch:${A}:20`]);
  driver.commitPassiveEffects();
  assert.deepEqual(effects, [`fetch:${A}:20`, `cleanup:${A}:20`, `fetch:${B}:0`], "Discarded B:20 must never execute");
  driver.dispose();
  assert.equal(effects.at(-1), `cleanup:${B}:0`);
});

test("simulation driver rejects conditional hook counts", () => {
  const driver = hookDriver<number>();
  let conditional = false;
  driver.mount(() => {
    driver.hooks.useState(0);
    if (conditional) driver.hooks.useRef(null);
    return 0;
  });
  driver.renderBeforeEffects();
  driver.commitPassiveEffects();
  conditional = true;
  assert.throws(() => driver.renderBeforeEffects(), /Conditional hooks/);
  driver.dispose();
});

for (const resource of [A, C]) {
  test(`list initial load is hidden before effects and uses the correct URL for ${resource}`, async (t) => {
    const source = await compiled;
    t.diagnostic(`Module: ${source.origin}; SHA256: ${source.hash}; isolated hook simulation, not React acceptance`);
    const ui = await fixture(t, resource);
    hidden(ui.renderBeforeEffects());
    assert.equal(ui.requests.length, 0, "No fetching during render");
    await ui.flush();
    assert.equal(ui.requests.length, 1);
    hidden(ui.snapshot());
    const initial = ui.take(resource);
    assert.equal(initial.signal.aborted, false);
    const data = dto("initial");
    initial.succeed(data);
    await ui.flush();
    assert.deepEqual(ui.snapshot(), { data, error: "", offset: 0 });
    assert.equal(ui.requests.length, 1, "Publishing must not trigger another fetch");
  });
}

for (const stageEditingAvailable of [true, false]) {
  test(`valid empty list preserves hasMore/stages and stageEditingAvailable=${stageEditingAvailable}`, async (t) => {
    const ui = await fixture(t);
    await ui.flush();
    const data: SyntheticList = { items: [], hasMore: false, stages: dto("metadata").stages, stageEditingAvailable };
    ui.take(A).succeed(data);
    await ui.flush();
    assert.equal(ui.snapshot().data, data, "No cloning, discarded metadata or invented empty-result failure");
    assert.deepEqual(ui.snapshot(), { data, error: "", offset: 0 });
  });
}

for (const change of ["path", "offset"] as const) {
  for (const result of ["data", "error"] as const) {
    test(`FIRST ${change} render hides previously loaded ${result} before effect cleanup`, async (t) => {
      const ui = await loadedFixture(t, result);
      if (change === "path") ui.setPath(B);
      else ui.next();
      const first = ui.renderBeforeEffects();
      assert.equal(ui.requests.length, 1, "The observation must precede passive effects");
      hidden(first, change === "path" ? 0 : ui.pageSize);
      await ui.flush();
      const data = dto("current");
      ui.take(change === "path" ? B : A, change === "path" ? 0 : ui.pageSize).succeed(data);
      await ui.flush();
      assert.equal(ui.snapshot().data, data);
    });
  }
}

test("path change from a nonzero page resets offset before commit and never fetches the discarded page", async (t) => {
  const ui = await loadedFixture(t);
  ui.next();
  await ui.flush();
  ui.take(A, ui.pageSize).succeed(dto("A-page-two"));
  await ui.flush();
  ui.setPath(B);
  const first = ui.renderBeforeEffects();
  assert.equal(ui.requests.length, 2);
  assert.equal(first.offset, 0, "A's old page must not carry over to B's first visible render");
  hidden(first);
  await ui.flush();
  assert.equal(ui.requests.length, 3, "Render retry must issue only one B request");
  assert.equal(ui.requests[2].url, requestUrl(B, 0), "No B request at the discarded nonzero offset");
  const data = dto("B-page-one");
  ui.take(B).succeed(data);
  await ui.flush();
  assert.deepEqual(ui.snapshot(), { data, error: "", offset: 0 });
});

test("pagination uses OPERATOR_PAGE_SIZE, previous clamps at zero, and previous at zero never refetches", async (t) => {
  const ui = await loadedFixture(t);
  assert.equal(ui.pageSize, 20, "Exercise the real contract page size");
  ui.previous();
  await ui.flush();
  assert.equal(ui.requests.length, 1, "previous at zero must not invalidate a current snapshot");
  const steps = [
    { action: ui.next, offset: ui.pageSize },
    { action: ui.next, offset: 2 * ui.pageSize },
    { action: ui.previous, offset: ui.pageSize },
    { action: () => { ui.previous(); ui.previous(); }, offset: 0 },
  ];
  for (const [index, step] of steps.entries()) {
    step.action();
    await ui.flush();
    assert.equal(ui.snapshot().offset, step.offset);
    assert.equal(ui.requests.length, index + 2, "One request per committed page, even for batched previous calls");
    const data = dto(`page-${step.offset}`);
    ui.take(A, step.offset).succeed(data);
    await ui.flush();
    assert.equal(ui.snapshot().data, data);
  }
  const before = ui.snapshot();
  const count = ui.requests.length;
  ui.previous();
  await ui.flush();
  assert.equal(ui.requests.length, count);
  assert.deepEqual(ui.snapshot(), before, "Clamping must retain the valid zero-page response");
});

for (const result of ["data", "error"] as const) {
  test(`refresh FIRST render hides ${result}, retains the page and requires a fresh response`, async (t) => {
    const ui = await loadedFixture(t);
    ui.next();
    await ui.flush();
    const current = ui.take(A, ui.pageSize);
    if (result === "data") current.succeed(dto("page-two"));
    else current.fail("Synthetic page-two refusal");
    await ui.flush();
    ui.refresh();
    hidden(ui.renderBeforeEffects(), ui.pageSize);
    assert.equal(ui.requests.length, 2);
    await ui.flush();
    hidden(ui.snapshot(), ui.pageSize);
    const fresh = dto("refreshed-page-two");
    ui.take(A, ui.pageSize).succeed(fresh);
    await ui.flush();
    assert.deepEqual(ui.snapshot(), { data: fresh, error: "", offset: ui.pageSize });
    assert.equal(ui.requests.length, 3);
  });
}

for (const result of ["data", "error"] as const) {
  test(`disable/re-enable retains a nonzero page but never its previous ${result}`, async (t) => {
    const ui = await loadedFixture(t);
    ui.next();
    await ui.flush();
    const current = ui.take(A, ui.pageSize);
    if (result === "data") current.succeed(dto("page-before-disable"));
    else current.fail("Synthetic page-before-disable refusal");
    await ui.flush();
    ui.setEnabled(false);
    hidden(ui.renderBeforeEffects(), ui.pageSize);
    await ui.flush();
    assert.equal(ui.requests.length, 2);
    ui.setEnabled(true);
    hidden(ui.renderBeforeEffects(), ui.pageSize);
    await ui.flush();
    assert.equal(ui.requests.length, 3);
    hidden(ui.snapshot(), ui.pageSize);
    const fresh = dto("retained-page-after-enable");
    ui.take(A, ui.pageSize).succeed(fresh);
    await ui.flush();
    assert.deepEqual(ui.snapshot(), { data: fresh, error: "", offset: ui.pageSize });
  });

  test(`disable FIRST render hides ${result}; re-enable remains hidden until a fresh response`, async (t) => {
    const ui = await loadedFixture(t, result);
    ui.setEnabled(false);
    hidden(ui.renderBeforeEffects());
    await ui.flush();
    assert.equal(ui.requests.length, 1, "Disabled lists must not fetch");
    hidden(ui.snapshot());
    ui.setEnabled(true);
    hidden(ui.renderBeforeEffects());
    await ui.flush();
    assert.equal(ui.requests.length, 2, "Re-enable must verify access with a fresh request");
    hidden(ui.snapshot());
    const fresh = dto("fresh-after-enable");
    ui.take(A).succeed(fresh);
    await ui.flush();
    assert.deepEqual(ui.snapshot(), { data: fresh, error: "", offset: 0 });
  });

  test(`disable/re-enable before passive effects cannot resurrect cached ${result}`, async (t) => {
    const ui = await loadedFixture(t, result);
    ui.setEnabled(false);
    const disabled = ui.renderBeforeEffects();
    ui.setEnabled(true);
    const reenabled = ui.renderBeforeEffects();
    assert.equal(ui.requests.length, 1, "Both transition renders precede passive effects");
    hidden(reenabled);
    hidden(disabled);
    await ui.flush();
    assert.equal(ui.requests.length, 2, "Observed disable/re-enable must invalidate even at the same path/page");
    const data = dto("new-enable-generation");
    ui.take(A).succeed(data);
    await ui.flush();
    assert.equal(ui.snapshot().data, data);
  });

  test(`ABA path renders before passive effects cannot resurrect cached A ${result}`, async (t) => {
    const ui = await loadedFixture(t, result);
    ui.setPath(B);
    const middle = ui.renderBeforeEffects();
    ui.setPath(A);
    const returned = ui.renderBeforeEffects();
    assert.equal(ui.requests.length, 1, "Do not accidentally commit B's effects in this ABA test");
    hidden(returned);
    hidden(middle);
    await ui.flush();
    assert.equal(ui.requests.length, 2, "Returning to the same string path still requires a new generation");
    assert.ok(ui.requests.every((request) => request.url === requestUrl(A, 0)), "The discarded B effect must not execute");
    const fresh = dto("new-A-generation");
    ui.take(A).succeed(fresh);
    await ui.flush();
    assert.equal(ui.snapshot().data, fresh);
  });
}

test("initially disabled list never fetches; enabling starts the first real request", async (t) => {
  const ui = await fixture(t, A, false);
  hidden(ui.renderBeforeEffects());
  await ui.flush();
  assert.equal(ui.requests.length, 0);
  ui.setEnabled(true);
  hidden(ui.renderBeforeEffects());
  await ui.flush();
  assert.equal(ui.requests.length, 1);
  ui.take(A).succeed(dto("first-enabled"));
  await ui.flush();
  assert.equal(ui.snapshot().data?.items[0].id, "synthetic-first-enabled");
});

const outcomes = ["success", "HTTP failure", "network failure"] as const;
type Outcome = typeof outcomes[number];
function settle(request: Request, outcome: Outcome) {
  if (outcome === "success") request.succeed(dto("obsolete-response"));
  else if (outcome === "HTTP failure") request.fail("Synthetic obsolete HTTP failure");
  else request.reject("Synthetic obsolete network failure");
}

const changes = ["path", "offset", "refresh"] as const;
function transition(ui: Fixture, change: typeof changes[number]) {
  if (change === "path") ui.setPath(B);
  else if (change === "offset") ui.next();
  else ui.refresh();
  return { resource: change === "path" ? B : A, offset: change === "offset" ? ui.pageSize : 0 };
}

for (const change of changes) {
  for (const outcome of outcomes) {
    test(`late ${outcome} after ${change} render but BEFORE passive cleanup cannot become current`, async (t) => {
      const ui = await fixture(t);
      await ui.flush();
      const obsolete = ui.take(A);
      const current = transition(ui, change);
      hidden(ui.renderBeforeEffects(), current.offset);
      assert.equal(ui.requests.length, 1);
      settle(obsolete, outcome);
      await ui.drainBeforeEffects();
      assert.equal(obsolete.settled, true, "The obsolete promise really settled while effects were deferred");
      assert.equal(ui.requests.length, 1, "Draining microtasks must not run passive effects");
      hidden(ui.snapshot(), current.offset);
      await ui.flush();
      assert.equal(ui.requests.length, 2);
      const fresh = dto("current-generation");
      ui.take(current.resource, current.offset).succeed(fresh);
      await ui.flush();
      assert.deepEqual(ui.snapshot(), { data: fresh, error: "", offset: current.offset });
    });

    test(`ignored abort late ${outcome} after ${change} cannot overwrite the loaded current response`, async (t) => {
      const ui = await fixture(t);
      await ui.flush();
      const obsolete = ui.take(A);
      const current = transition(ui, change);
      ui.renderBeforeEffects();
      await ui.flush();
      const replacement = ui.take(current.resource, current.offset);
      assert.equal(obsolete.signal.aborted, true, "Changing request identity must clean up the old effect");
      assert.notEqual(replacement.signal, obsolete.signal);
      const fresh = dto("loaded-current-generation");
      replacement.succeed(fresh);
      await ui.flush();
      const before = ui.snapshot();
      assert.deepEqual(before, { data: fresh, error: "", offset: current.offset });
      settle(obsolete, outcome);
      await ui.flush();
      assert.equal(obsolete.settled, true, "Ignored abort must actually deliver the obsolete outcome");
      assert.deepEqual(ui.snapshot(), before, "Obsolete success/catch must not change current data or errors");
      assert.equal(ui.requests.length, 2);
    });
  }

  for (const outcome of ["success", "HTTP failure"] as const) {
    test(`late ${outcome} after ${change} cannot replace a current refusal`, async (t) => {
      const ui = await fixture(t);
      await ui.flush();
      const obsolete = ui.take(A);
      const current = transition(ui, change);
      await ui.flush();
      ui.take(current.resource, current.offset).fail("Synthetic current refusal");
      await ui.flush();
      const before = ui.snapshot();
      assert.deepEqual(before, { data: null, error: "Synthetic current refusal", offset: current.offset });
      settle(obsolete, outcome);
      await ui.flush();
      assert.deepEqual(ui.snapshot(), before);
    });
  }
}

for (const outcome of outcomes) {
  test(`ABA A->B->A before effects rejects the old A pending ${outcome}`, async (t) => {
    const ui = await fixture(t);
    await ui.flush();
    const obsoleteA = ui.take(A);
    ui.setPath(B);
    hidden(ui.renderBeforeEffects());
    ui.setPath(A);
    hidden(ui.renderBeforeEffects());
    settle(obsoleteA, outcome);
    await ui.drainBeforeEffects();
    hidden(ui.snapshot());
    assert.equal(ui.requests.length, 1);
    await ui.flush();
    assert.equal(ui.requests.length, 2, "A's identical URL is not its original request generation");
    const fresh = dto("fresh-ABA-A");
    ui.take(A).succeed(fresh);
    await ui.flush();
    assert.equal(ui.snapshot().data, fresh);
  });

  test(`disable/re-enable before effects rejects the previous enabled pending ${outcome}`, async (t) => {
    const ui = await fixture(t);
    await ui.flush();
    const obsolete = ui.take(A);
    ui.setEnabled(false);
    hidden(ui.renderBeforeEffects());
    ui.setEnabled(true);
    hidden(ui.renderBeforeEffects());
    settle(obsolete, outcome);
    await ui.drainBeforeEffects();
    hidden(ui.snapshot());
    await ui.flush();
    assert.equal(ui.requests.length, 2, "An observed disable invalidates the old enabled generation");
    const fresh = dto("fresh-enable-generation");
    ui.take(A).succeed(fresh);
    await ui.flush();
    assert.equal(ui.snapshot().data, fresh);
  });

  test(`disable cleanup aborts and hides an ignored-abort late ${outcome}`, async (t) => {
    const ui = await fixture(t);
    await ui.flush();
    const obsolete = ui.take(A);
    ui.setEnabled(false);
    hidden(ui.renderBeforeEffects());
    await ui.flush();
    assert.equal(obsolete.signal.aborted, true);
    settle(obsolete, outcome);
    await ui.flush();
    hidden(ui.snapshot());
    assert.equal(ui.requests.length, 1);
    ui.setEnabled(true);
    hidden(ui.renderBeforeEffects());
    await ui.flush();
    assert.equal(ui.requests.length, 2);
    const fresh = dto("enabled-after-ignored-abort");
    ui.take(A).succeed(fresh);
    await ui.flush();
    assert.equal(ui.snapshot().data, fresh);
  });
}

test("unmount cleanup aborts the active controller even when transport ignores abort", async (t) => {
  const ui = await fixture(t);
  await ui.flush();
  const active = ui.take(A);
  assert.equal(active.signal.aborted, false);
  ui.dispose();
  assert.equal(active.signal.aborted, true);
  active.succeed(dto("late-after-unmount"));
  await ui.flush();
  assert.equal(active.settled, true);
  assert.equal(ui.requests.length, 1);
});

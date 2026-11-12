import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Execute the production component, selector, read hook and command lifetime.
// Only the host renderer, clock, storage and API responses are synthetic.
// No browser, network, account, environment file or database is used.
// Run: node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-creator-deadline.test.ts
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const contracts = await import(new URL("../../lib/crm/creator-job-contracts.ts", import.meta.url).href);
const prices = await import(new URL("../../lib/crm/operator-contracts.ts", import.meta.url).href);
type Job = NonNullable<ReturnType<typeof contracts.parseCreatorJob>>;
type Props = Record<string, unknown> & { children?: Child };
type Element = { type: unknown; props: Props; key?: unknown };
type Child = Element | string | number | boolean | null | undefined | Child[];
type Instance = { input: Element };
type Renderer = {
  hooks: Record<string, unknown>;
  mount(value: Child): void;
  flush(): Promise<void>;
  beforeEffects(): Promise<void>;
  nodes(): Element[];
  content(): string;
  instances(name: string): Instance[];
  writes(): number;
  dispose(): void;
};
type Events = { addEventListener(name: string, callback: () => void): void;
  removeEventListener(name: string, callback: () => void): void; dispatch(name: string): void };
type Harness = { renderer(): Renderer; jsx(type: unknown, props: Props, key?: unknown): Element;
  Fragment: symbol; elements(value: Child): Element[]; text(value: Child): string; eventTarget(): Events };

function compile(source: string, filename: string) {
  const output = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
  assert.deepEqual(output.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) ?? [], []);
  return output.outputText;
}
const sources = (async () => {
  const files = { jobs: "artifacts/negis/src/components/contributors/CreatorJobs.tsx",
    hook: "artifacts/negis/src/lib/useCreatorCommand.ts", attempts: "artifacts/negis/src/lib/creatorCommandAttempt.ts" };
  const code: Record<string, string> = {};
  let iconNames: string[] = [];
  for (const [name, filename] of Object.entries(files)) {
    const source = await readFile(path.join(root, filename), "utf8");
    code[name] = compile(source, filename);
    if (name !== "jobs") continue;
    const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    for (const component of ["CreatorJobs", "CreatorJobsSession", "JobPanel", "selectCreatorDeadline"])
      assert.ok(ast.statements.some(node => ts.isFunctionDeclaration(node) && node.name?.text === component));
    const icons = ast.statements.find(node => ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "lucide-react");
    assert.ok(icons && ts.isImportDeclaration(icons));
    const bindings = icons.importClause?.namedBindings;
    assert.ok(bindings && ts.isNamedImports(bindings));
    iconNames = bindings.elements.map(item => (item.propertyName ?? item.name).text);
  }
  return { code, iconNames };
})();
const harness = (async () => {
  // Reuse the existing reconciler via AST without running its unrelated tests.
  const filename = "scripts/src/medina-operator-composed-denial.test.ts";
  const source = await readFile(path.join(root, filename), "utf8");
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const names = new Set(["jsx", "Fragment", "isElement", "elements", "text", "sameDependencies", "hookDriver", "renderer"]);
  const selected = ast.statements.filter(node => {
    if (ts.isFunctionDeclaration(node)) return node.name !== undefined && names.delete(node.name.text);
    if (!ts.isVariableStatement(node) || node.declarationList.declarations.length !== 1) return false;
    const declaration = node.declarationList.declarations[0]!;
    return ts.isIdentifier(declaration.name) && names.delete(declaration.name.text);
  });
  assert.equal(names.size, 0);
  const eventsSource = await readFile(path.join(root, "scripts/src/medina-operator-profile-races.test.ts"), "utf8");
  const eventsAst = ts.createSourceFile("events.ts", eventsSource, ts.ScriptTarget.Latest, true);
  const events = eventsAst.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === "eventTarget");
  assert.equal(events.length, 1);
  const exports = {} as Harness;
  new Script(compile(`${selected.map(node => node.getFullText(ast)).join("\n")}
    ${events[0]!.getFullText(eventsAst)}
    Object.assign(exports, { renderer, jsx, Fragment, elements, text, eventTarget });`, filename))
    .runInNewContext({ assert, exports });
  return exports;
})();

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = id(1), B = id(2), WORKSPACE = id(3);
const NOW = Date.parse("2026-10-28T08:00:00.000Z");
const due = (hours: number) => new Date(NOW + hours * 3600000).toISOString();
function job(n: number, hours = 24, state: Job["state"] = "offered"): Job {
  const accepted = ["in_progress", "submitted", "changes_requested", "approved"].includes(state);
  const submitted = ["submitted", "changes_requested", "approved"].includes(state);
  const value = { id: id(100 + n), revision: id(200 + n), termsRevision: id(300 + n), creatorName: "Synthetic author",
    title: `Synthetic job ${n}`, brief: `Synthetic brief ${n}`, rightsTerms: "Synthetic explicit licence",
    feeMinor: "2500000", currency: "KZT", dueAt: due(hours), state,
    acceptedAt: accepted ? "2026-10-20T08:00:00.000Z" : null,
    approvedAt: state === "approved" ? "2026-10-22T08:00:00.000Z" : null,
    submissionCount: submitted ? 1 : 0, latestSubmission: submitted ? { sequence: 1,
      links: ["https://example.com/synthetic.mp4"], note: "Synthetic result", submittedAt: "2026-10-21T08:00:00.000Z" } : null,
    feedback: state === "changes_requested" ? "Synthetic feedback" : null };
  const parsed = contracts.parseCreatorJob(value);
  assert.ok(parsed, "All fixtures must pass the real DTO parser");
  return parsed;
}
type Pending = { path: string; method: string; actor: string; signal: AbortSignal; valid(): boolean;
  settled: boolean; succeed(value: unknown): void; fail(error: Error): void };

async function runtime(t: TestContext) {
  const helpers = await harness, source = await sources, render = helpers.renderer();
  const requests: Pending[] = [], storage = new Map<string, string>();
  const timers = new Map<number, { at: number; callback: () => void }>();
  let clock = NOW, timerId = 0, actor: string | null = A;
  class ClockDate extends Date {
    constructor(value?: string | number) { super(value === undefined ? clock : value); }
    static now() { return clock; }
  }
  const window = { ...helpers.eventTarget(), sessionStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); },
  }, setTimeout(callback: () => void, delay: number) {
    const token = ++timerId; timers.set(token, { at: clock + delay, callback }); return token;
  }, clearTimeout(token: number) { timers.delete(token); } };
  const document = { ...helpers.eventTarget(), visibilityState: "visible" };
  function operatorApi(route: string, body: unknown, method: string, signal: AbortSignal, expected: string, valid: () => boolean) {
    assert.equal(method, "GET", "The deadline shortcut must never send a command");
    assert.equal(body, undefined);
    assert.equal(expected, actor);
    assert.ok(signal instanceof AbortSignal);
    assert.ok(valid());
    return new Promise<unknown>((resolve, reject) => requests.push({ path: route, method, actor: expected, signal, valid, settled: false,
      succeed(value) { assert.equal(this.settled, false); this.settled = true; resolve(value); },
      fail(error) { assert.equal(this.settled, false); this.settled = true; reject(error); } }));
  }
  const modules: Record<string, Record<string, unknown>> = {};
  function load(name: string): Record<string, unknown> {
    if (modules[name]) return modules[name];
    const exports: Record<string, unknown> = {}; modules[name] = exports;
    const require = (specifier: string): unknown => {
      if (specifier === "react") return render.hooks;
      if (specifier === "react/jsx-runtime") return { jsx: helpers.jsx, jsxs: helpers.jsx, Fragment: helpers.Fragment };
      if (specifier === "lucide-react") return Object.fromEntries(source.iconNames.map(name => [name, Symbol(name)]));
      if (specifier === "@/lib/operatorApi") return { operatorApi, OperatorApiError: Error };
      if (specifier.endsWith("creator-job-contracts")) return contracts;
      if (specifier.endsWith("operator-contracts")) return prices;
      if (specifier.endsWith("creatorCommandAttempt")) return load("attempts");
      if (specifier.endsWith("useCreatorCommand")) return load("hook");
      if (specifier === "./CreatorJobs.css") return {};
      assert.fail(`Unexpected dependency: ${specifier}`);
    };
    new Script(source.code[name]!, { filename: `${name}.js` }).runInNewContext({ exports, require, window, document,
      Date: ClockDate, Intl, Error, AbortController, URL, console,
      fetch: () => assert.fail("Network is forbidden") });
    return exports;
  }
  const production = load("jobs");
  t.after(() => { render.dispose(); assert.equal(timers.size, 0, "Deadline timers must be cleaned up"); });
  function mount(next = A, workspaceId?: string) {
    actor = next;
    render.mount(helpers.jsx(production.CreatorJobs, { actorId: next, workspaceId, isSessionCurrent: () => actor === next }));
  }
  const shortcut = () => render.nodes().find(node => node.type === "button" && node.props.className === "creator-deadline");
  function button(label: string) {
    const node = render.nodes().find(node => node.type === "button" && node.props["aria-label"] === label);
    assert.ok(node, `Missing button: ${label}`); return node;
  }
  function pending(route: string) {
    const request = [...requests].reverse().find(item => item.path === route && !item.settled);
    assert.ok(request, `Missing request: ${route}`); return request;
  }
  return { render, requests, window, timers, mount, shortcut, button, pending, text: helpers.text, elements: helpers.elements,
    select: production.selectCreatorDeadline as (items: readonly Job[], now: number) => Job | null,
    setActor(next: string | null) { actor = next; },
    async page(items: Job[], offset = 0, hasMore = false, workspaceId?: string) {
      const route = workspaceId ? `clinic-creator-jobs?workspaceId=${workspaceId}&offset=${offset}` : `creator-jobs?offset=${offset}`;
      pending(route).succeed({ items, hasMore }); await render.flush();
    },
    async advance(to: number) {
      clock = to;
      for (const [key, timer] of [...timers]) if (timer.at <= clock) { timers.delete(key); timer.callback(); }
      await render.flush();
    },
  };
}
function click(node: Element) { assert.equal(typeof node.props.onClick, "function"); (node.props.onClick as () => void)(); }

test("production selector prefers earliest upcoming over any overdue and includes every unfinished state", async t => {
  const { select } = await runtime(t);
  for (const state of ["offered", "in_progress", "submitted", "changes_requested"] as const) {
    const nearest = job(1, 1, state);
    assert.equal(select([job(2, -100), job(3, 48), nearest, job(4, 0.5, "approved")], NOW), nearest);
  }
});

test("production selector falls back to oldest unfinished overdue, including exact deadline", async t => {
  const { select } = await runtime(t), oldest = job(1, -100, "changes_requested");
  assert.equal(select([job(2, -1), job(3, -200, "declined"), oldest, job(4, 0)], NOW), oldest);
  const exact = job(5, 0);
  assert.equal(select([exact], NOW), exact);
});

test("production selector is empty for empty/final-only pages and ignores invalid dates defensively", async t => {
  const { select } = await runtime(t);
  assert.equal(select([], NOW), null);
  assert.equal(select([job(1, 1, "approved"), job(2, -1, "cancelled"), job(3, 1, "declined")], NOW), null);
  assert.equal(select([{ ...job(4), dueAt: "not-a-date" }], NOW), null);
});

test("equal upcoming/overdue deadlines use deterministic job identity without mutating DTOs", async t => {
  const { select } = await runtime(t);
  for (const hours of [-24, 24]) {
    const first = Object.freeze(job(1, hours)), second = Object.freeze(job(2, hours));
    const items = Object.freeze([second, first]);
    assert.equal(select(items, NOW), first);
    assert.equal(select(Object.freeze([first, second]), NOW), first);
    assert.equal(items[0], second);
  }
});

test("actual shortcut has explicit page scope, original date/zone format and ignores local filters", async t => {
  const r = await runtime(t), nearest = job(1, 1), other = job(2, 48, "in_progress");
  r.mount(); await r.render.flush(); await r.page([other, nearest]);
  assert.ok(r.shortcut());
  assert.match(r.text(r.shortcut()), /Ближайший срок.*На текущей странице/);
  assert.match(r.render.content(), new RegExp(Intl.DateTimeFormat().resolvedOptions().timeZone));
  const timestamp = r.elements(r.shortcut()).find(node => node.type === "time");
  assert.ok(timestamp); assert.equal(timestamp.props.dateTime, nearest.dueAt);
  assert.equal(r.text(timestamp), new Date(nearest.dueAt).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" }));
  const search = r.render.nodes().find(node => node.type === "input" && node.props.type === "search");
  assert.ok(search); (search.props.onChange as (event: unknown) => void)({ target: { value: other.title } });
  const status = r.render.nodes().find(node => node.type === "select" && node.props["aria-label"] === "Статус заданий на текущей странице");
  assert.ok(status); (status.props.onChange as (event: unknown) => void)({ target: { value: "in_progress" } });
  await r.render.flush();
  assert.match(r.render.content(), /Показано 1 из 2/);
  assert.ok(r.text(r.shortcut()).includes(nearest.title));
  assert.equal(r.requests.length, 1, "Filters and shortcut must not infer a global list");
});

test("actual current shortcut opens the real JobPanel through selected and preserves its original actor request", async t => {
  const r = await runtime(t), nearest = job(1, 1, "in_progress");
  r.mount(); await r.render.flush(); await r.page([nearest]);
  click(r.shortcut()!); await r.render.flush();
  const panels = r.render.instances("JobPanel");
  assert.equal(panels.length, 1); assert.equal(panels[0]!.input.props.jobId, nearest.id);
  const request = r.pending(`creator-job-detail?jobId=${nearest.id}&offset=0`);
  assert.equal(request.actor, A); assert.ok(request.valid());
  request.succeed({ job: nearest, companyName: "Synthetic company", history: { offset: 0, items: [], hasMore: false } });
  await r.render.flush();
  assert.ok(r.render.nodes().some(node => node.type === "form" && node.props["aria-label"] === "Результат задания"));
  assert.ok(r.render.content().includes(nearest.rightsTerms));
  assert.equal(r.shortcut()!.props["aria-pressed"], true);
  click(r.button("Закрыть карточку")); await r.render.flush();
  assert.equal(r.render.instances("JobPanel").length, 0);
});

test("retained shortcut/list handlers cannot open a different page even before passive cleanup or after return", async t => {
  const r = await runtime(t), first = job(1, 1), second = job(2, 2);
  r.mount(); await r.render.flush();
  await r.page([first, ...Array.from({ length: 19 }, (_, n) => job(10 + n, 48, "approved"))], 0, true);
  const oldShortcut = r.shortcut()!, oldCard = r.button(`Открыть задание: ${first.title}`);
  click(r.button("Страницы заданий: далее")); await r.render.beforeEffects();
  const before = r.render.writes(); click(oldShortcut); click(oldCard);
  assert.equal(r.render.writes(), before);
  assert.equal(r.render.instances("JobPanel").length, 0);
  assert.equal(r.shortcut(), undefined);
  await r.render.flush(); await r.page([second], 20);
  assert.ok(r.text(r.shortcut()).includes(second.title));
  click(oldShortcut); await r.render.flush();
  assert.equal(r.render.instances("JobPanel").length, 0);
  click(r.button("Страницы заданий: назад")); await r.render.flush(); await r.page([first]);
  const returned = r.render.writes(); click(oldShortcut); assert.equal(r.render.writes(), returned);
  click(r.shortcut()!); await r.render.flush();
  assert.equal(r.render.instances("JobPanel")[0]!.input.props.jobId, first.id);
  assert.deepEqual(r.requests.filter(item => item.path.startsWith("creator-jobs?")).map(item => item.path),
    ["creator-jobs?offset=0", "creator-jobs?offset=20", "creator-jobs?offset=0"]);
});

test("retained shortcut expires on account change before rerender and never revives on account return", async t => {
  const r = await runtime(t);
  r.mount(); await r.render.flush(); await r.page([job(1)]);
  const stale = r.shortcut()!, originalList = r.requests[0]!;
  r.setActor(B);
  const before = r.render.writes(); click(stale); assert.equal(r.render.writes(), before);
  assert.equal(originalList.valid(), false);
  r.mount(B); await r.render.flush(); await r.page([job(2)]);
  click(stale); await r.render.flush(); assert.equal(r.render.instances("JobPanel").length, 0);
  r.mount(A); await r.render.flush(); await r.page([job(3)]);
  const returned = r.render.writes(); click(stale); assert.equal(r.render.writes(), returned);
  click(r.shortcut()!); await r.render.flush();
  assert.equal(r.render.instances("JobPanel")[0]!.input.props.jobId, job(3).id);
  assert.equal([...r.requests].reverse().find(item => item.path.startsWith("creator-job-detail?"))!.actor, A);
});

test("refresh invalidates retained original snapshot even when the replacement contains the same job", async t => {
  const r = await runtime(t), nearest = job(1);
  r.mount(); await r.render.flush(); await r.page([nearest]);
  const stale = r.shortcut()!;
  click(r.button("Обновить задания")); await r.render.beforeEffects();
  const before = r.render.writes(); click(stale); assert.equal(r.render.writes(), before);
  await r.render.flush(); await r.page([nearest]);
  click(stale); await r.render.flush(); assert.equal(r.render.instances("JobPanel").length, 0);
  click(r.shortcut()!); await r.render.flush(); assert.equal(r.render.instances("JobPanel").length, 1);
});

test("deadline boundary recomputes earliest upcoming then truthfully marks oldest overdue without another read", async t => {
  const r = await runtime(t), oldest = job(1, -48), first = job(2, 1), later = job(3, 2);
  r.mount(); await r.render.flush(); await r.page([oldest, later, first]);
  assert.ok(r.text(r.shortcut()).includes(first.title));
  await r.advance(Date.parse(first.dueAt) + 1);
  assert.ok(r.text(r.shortcut()).includes(later.title));
  assert.equal(r.shortcut()!.props["data-expired"], false);
  await r.advance(Date.parse(later.dueAt) + 1);
  assert.ok(r.text(r.shortcut()).includes(oldest.title));
  assert.match(r.text(r.shortcut()), /Срок истёк/);
  assert.doesNotMatch(r.text(r.shortcut()), /Ближайший срок/);
  assert.equal(r.shortcut()!.props["data-expired"], true);
  assert.equal(r.requests.length, 1); assert.equal(r.timers.size, 0);
  click(r.shortcut()!); await r.render.flush();
  assert.equal(r.render.instances("JobPanel")[0]!.input.props.jobId, oldest.id);
});

for (const kind of ["empty", "final-only", "invalid", "loading", "error", "company"] as const) {
  test(`actual ${kind} page never exposes an invented creator deadline`, async t => {
    const r = await runtime(t);
    r.mount(A, kind === "company" ? WORKSPACE : undefined); await r.render.flush();
    if (kind === "empty") await r.page([]);
    if (kind === "final-only") await r.page([job(1, 24, "approved"), job(2, -24, "declined"), job(3, 48, "cancelled")]);
    if (kind === "company") await r.page([job(1)], 0, false, WORKSPACE);
    if (kind === "invalid") {
      r.pending("creator-jobs?offset=0").succeed({ items: [{ ...job(1), dueAt: "2026-02-30T08:00:00.000Z" }], hasMore: false });
      await r.render.flush(); assert.match(r.render.content(), /Не удалось подтвердить данные заданий/);
    }
    if (kind === "error") {
      r.pending("creator-jobs?offset=0").fail(Error("Synthetic local read failure"));
      await r.render.flush(); assert.match(r.render.content(), /Synthetic local read failure/);
    }
    assert.equal(r.shortcut(), undefined); assert.equal(r.timers.size, 0);
    assert.equal(r.requests.length, 1); assert.equal(r.render.instances("JobPanel").length, 0);
  });
}

test("retained shortcut is inert after unmount and deadline timer cleanup", async t => {
  const r = await runtime(t);
  r.mount(); await r.render.flush(); await r.page([job(1)]);
  const stale = r.shortcut()!; assert.equal(r.timers.size, 1);
  r.render.mount(null); await r.render.flush();
  assert.equal(r.timers.size, 0);
  const before = r.render.writes(); click(stale); assert.equal(r.render.writes(), before);
  assert.equal(r.requests.length, 1);
});

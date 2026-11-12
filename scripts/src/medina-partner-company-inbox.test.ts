import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Execute the actual inbox and shared parser; reuse the contributor host fixture.
// Hooks, host scheduling, browser events and request delivery are doubles. This
// is not React DOM/CSS acceptance and never opens a network or reads an env file.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const componentFile = "artifacts/negis/src/components/contributors/PartnerCompanyInbox.tsx";
const contractsFile = "lib/crm/partner-company-contracts.ts";
const clientFile = "artifacts/negis/src/pages/partner-company-client.ts";
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = uuid(1), B = uuid(2);
type State = "pending" | "approved" | "rejected";
type Props = Record<string, unknown> & { children?: Child };
type Element = { type: unknown; props: Props; key?: unknown };
type Child = Element | string | number | boolean | null | undefined | Child[];
type Renderer = {
  hooks: Record<string, unknown>; mount(value: Child): void; flush(): Promise<void>; beforeEffects(): Promise<void>;
  nodes(): Element[]; content(): string; writes(): number; dispose(): void;
};
type Harness = {
  renderer(): Renderer; jsx(type: unknown, props: Props, key?: unknown): Element; Fragment: symbol;
  elements(value: Child): Element[]; text(value: Child): string;
};
type Options = { offset: number; state: State | null; signal: AbortSignal; isCurrent(): boolean };
type WorkspaceOptions = Pick<Options, "signal" | "isCurrent">;
type InboxProps = {
  actorId: string; isSessionCurrent(): boolean; request(options: Options): Promise<unknown>;
  onAccessDenied(): void; onNewApplication(): void;
  onOpenWorkspace?(application: Application, options: WorkspaceOptions): Promise<void>;
};
type WorkspacePending = {
  application: Application; options: WorkspaceOptions; actor: string; claimed: boolean; settled: boolean;
  reply(): void; fail(error?: unknown): void;
};
type Pending = {
  options: Options; actor: string; claimed: boolean; settled: boolean;
  reply(value: unknown): void; fail(error?: unknown): void;
  headers(status?: number): ReturnType<typeof deferred<unknown>>; jsonCalls: number;
};
type ResponseDouble = { status: number; ok: boolean; json(): Promise<unknown> };
type Application = ReturnType<typeof application>;
type Page = { items: Application[]; offset: number; state: State | null; hasMore: boolean };

function compile(source: string, fileName: string) {
  const result = ts.transpileModule(source, { fileName, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
  assert.deepEqual(result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error) ?? [], [], `${fileName} must transpile`);
  return result.outputText;
}

function hostHarness(): Harness {
  // Reuse declarations only, without importing unrelated tests or their runtime.
  const file = "scripts/src/medina-operator-composed-denial.test.ts";
  const ast = ts.createSourceFile(file, readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
  const names = new Set(["jsx", "Fragment", "isElement", "elements", "text", "sameDependencies", "hookDriver", "renderer"]);
  const selected = ast.statements.filter(node => {
    if (ts.isFunctionDeclaration(node)) return node.name !== undefined && names.delete(node.name.text);
    if (!ts.isVariableStatement(node) || node.declarationList.declarations.length !== 1) return false;
    const declaration = node.declarationList.declarations[0]!;
    return ts.isIdentifier(declaration.name) && names.delete(declaration.name.text);
  });
  assert.equal(names.size, 0, `Missing existing host declarations: ${[...names].join(", ")}`);
  const exports = {} as Harness;
  new Script(compile(`${selected.map(n => n.getFullText(ast)).join("\n")}
    Object.assign(exports, { renderer, jsx, Fragment, elements, text });`, file)).runInNewContext({ assert, exports });
  return exports;
}
const host = hostHarness();

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function eventTarget() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener(name: string, callback: () => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(callback);
    },
    removeEventListener(name: string, callback: () => void) { listeners.get(name)?.delete(callback); },
    dispatch(name: string) { for (const callback of [...listeners.get(name) ?? []]) callback(); },
    count: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}
function application(n = 80, state: State = "pending", name = `Synthetic Company ${n}`) {
  return { id: uuid(n), revision: uuid(n + 1000), state,
    company: { name, purpose: "marketing", vertical: null, timeZone: "Asia/Qyzylorda", ownerName: `Private Owner ${n}` },
    workspaceId: state === "approved" ? uuid(n + 2000) : null,
    sourceState: state === "approved" ? "pending_payment" : "captured",
    expiresAt: "2026-12-01T12:00:00Z", submittedAt: "2026-10-01T12:00:00Z",
    reviewedAt: state === "pending" ? null : "2026-10-02T12:00:00Z" };
}
const fullPage = (state: State = "pending") => Array.from({ length: 20 }, (_, i) => application(100 - i, state));

function fixture(t: TestContext, withClient = false, withWorkspace = false) {
  const render = host.renderer(), windowEvents = eventTarget(), documentEvents = eventTarget();
  const requests: Pending[] = [], forbiddenCalls: string[] = [], parserCalls: { expected?: { offset: number; state: State | null } }[] = [];
  const workspaceRequests: WorkspacePending[] = [], parsedPages: Page[] = [];
  const responseGates = new Map<Pending, ReturnType<typeof deferred<ResponseDouble>>>();
  let actor = A, epoch = 1, denied = 0, newApplications = 0;
  const forbidden = (name: string): never => { forbiddenCalls.push(name); assert.fail(`Forbidden capability: ${name}`); };
  const document = { ...documentEvents, visibilityState: "visible", hasFocus: () => true };
  const window = { ...windowEvents, location: { origin: "https://synthetic-inbox.invalid" } };
  for (const name of ["href", "pathname", "search", "hash"]) {
    Object.defineProperty(window.location, name, { get: () => forbidden(`location.${name}`), set: () => forbidden(`location.${name}`) });
  }
  Object.assign(window.location, { assign: () => forbidden("location.assign"), replace: () => forbidden("location.replace"),
    reload: () => forbidden("location.reload") });
  const location = window.location;
  Object.defineProperty(window, "location", { get: () => location, set: () => forbidden("window.location") });
  Object.defineProperty(document, "location", { get: () => forbidden("document.location"), set: () => forbidden("document.location") });
  Object.defineProperty(window, "history", { get: () => forbidden("history") });
  Object.assign(window, { open: () => forbidden("window.open") });
  for (const target of [window, document]) {
    for (const name of ["localStorage", "sessionStorage", "indexedDB", "cookie"]) {
      Object.defineProperty(target, name, { get: () => forbidden(name), set: () => forbidden(name) });
    }
  }
  const modules = new Map<string, Record<string, any>>();
  function load(file: string): Record<string, any> {
    if (modules.has(file)) return modules.get(file)!;
    assert.ok([componentFile, contractsFile, clientFile].includes(file), `Only actual inbox, client and contracts may load: ${file}`);
    const source = readFileSync(path.join(root, file), "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const icons: Record<string, unknown> = {};
    for (const node of ast.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== "lucide-react") continue;
      const bindings = node.importClause?.namedBindings;
      assert.ok(bindings && ts.isNamedImports(bindings));
      for (const binding of bindings.elements) icons[(binding.propertyName ?? binding.name).text] = Symbol(binding.name.text);
    }
    const exports: Record<string, any> = {}; modules.set(file, exports);
    new Script(compile(source, file), { filename: file }).runInNewContext({
      exports, module: { exports }, window, document, AbortController, DOMException, URL, URLSearchParams, Error, Promise,
      fetch: () => forbidden("fetch"), localStorage: new Proxy({}, { get: () => forbidden("localStorage") }),
      sessionStorage: new Proxy({}, { get: () => forbidden("sessionStorage") }),
      console: new Proxy({}, { get: () => forbidden("console") }),
      setTimeout: () => forbidden("timer"), setInterval: () => forbidden("interval"),
      require(name: string): unknown {
        if (name === "react") return { ...render.hooks, useId() {
          return (render.hooks.useRef as (value: string) => { current: string })("synthetic-inbox-detail").current;
        } };
        if (name === "react/jsx-runtime") return { jsx: host.jsx, jsxs: host.jsx, Fragment: host.Fragment };
        if (name === "lucide-react") return icons;
        if (file === clientFile && name === "@/lib/api") return {
          apiUrl: (value: string) => value,
          CrmApiError: class extends Error {
            constructor(readonly status: number, readonly code: string, message: string) { super(message); }
          },
          crmFetch(input: string, init: RequestInit & { expectedUserId: string; dispatchGuard(): boolean }) {
            const pending = requests.at(-1); assert.ok(pending);
            const url = new URL(input, window.location.origin);
            assert.equal(url.origin, window.location.origin); assert.equal(url.pathname, "/api/crm/partner-company");
            assert.deepEqual(Object.fromEntries(url.searchParams), { view: "list", offset: String(pending.options.offset),
              ...(pending.options.state === null ? {} : { state: pending.options.state }) });
            assert.equal(init.method, "GET"); assert.equal(init.body, undefined); assert.equal(init.headers, undefined);
            assert.equal(init.expectedUserId, pending.actor); assert.strictEqual(init.signal, pending.options.signal);
            assert.equal(init.dispatchGuard(), true); assert.equal(init.credentials, "same-origin");
            assert.equal(init.mode, "same-origin"); assert.equal(init.redirect, "error");
            assert.equal(init.cache, "no-store"); assert.equal(init.referrerPolicy, "no-referrer");
            // Ignore abort/guards even at headers and JSON completion.
            return responseGates.get(pending)!.promise;
          },
        };
        if (name === "./partner-company-inbox.css") return {};
        if (name === "../../../../../lib/crm/partner-company-contracts"
          || file === clientFile && name === "../../../../lib/crm/partner-company-contracts") {
          const actual = load(contractsFile);
          return { ...actual, parsePartnerCompanyPage(value: unknown, expected?: { offset: number; state: State | null }) {
            parserCalls.push({ expected });
            const page = actual.parsePartnerCompanyPage(value, expected);
            if (page) parsedPages.push(page);
            return page;
          } };
        }
        return forbidden(`import ${name}`);
      },
    });
    return exports;
  }
  const actualContracts = load(contractsFile);
  const component = load(componentFile).PartnerCompanyInbox;
  assert.equal(typeof component, "function", "Run the actual exported PartnerCompanyInbox");
  function mount() {
    const capturedActor = actor, capturedEpoch = epoch;
    const isSessionCurrent = () => actor === capturedActor && epoch === capturedEpoch;
    const props: InboxProps = {
      actorId: capturedActor, isSessionCurrent,
      request(options) {
        assert.equal(isSessionCurrent(), true, "Cannot borrow the current actor's request closure");
        assert.deepEqual(Object.keys(options).sort(), ["isCurrent", "offset", "signal", "state"], "Only list-read parameters are allowed");
        assert.ok(Number.isInteger(options.offset) && options.offset >= 0 && options.offset <= 1000000);
        assert.ok(options.state === null || ["pending", "approved", "rejected"].includes(options.state));
        assert.ok(options.signal instanceof AbortSignal); assert.equal(options.signal.aborted, false);
        assert.equal(options.isCurrent(), true, "Actual child guard must be valid at dispatch");
        const gate = deferred<unknown>();
        const response = deferred<ResponseDouble>();
        const request: Pending = { options, actor: capturedActor, claimed: false, settled: false, jsonCalls: 0,
          reply(value) {
            assert.equal(request.settled, false); request.settled = true;
            if (withClient) response.resolve({ status: 200, ok: true, async json() { request.jsonCalls++; return { success: true, data: value }; } });
            else gate.resolve(value);
          },
          fail(error = Error("Synthetic unavailable read")) {
            assert.equal(request.settled, false); request.settled = true;
            if (withClient) response.reject(error); else gate.reject(error);
          },
          headers(status = 200) {
            assert.equal(withClient, true, "Headers require the actual client composition");
            assert.equal(request.settled, false); request.settled = true;
            const body = deferred<unknown>();
            response.resolve({ status, ok: status >= 200 && status < 300, json() { request.jsonCalls++; return body.promise; } });
            return body;
          },
        };
        requests.push(request); responseGates.set(request, response);
        // Ignore cancellation, session changes, and child guards on delivery.
        // The real component, not this double, must reject every stale result.
        return withClient ? load(clientFile).companyInboxRequestForActor(capturedActor, isSessionCurrent)(options) : gate.promise;
      },
      onAccessDenied() { denied++; }, onNewApplication() { newApplications++; },
    };
    if (withWorkspace) props.onOpenWorkspace = (application, options) => {
      assert.equal(isSessionCurrent(), true, "Workspace action cannot borrow a different actor lifetime");
      assert.deepEqual(Object.keys(options).sort(), ["isCurrent", "signal"], "Only action cancellation and freshness are delegated");
      assert.equal(application.state, "approved");
      assert.ok(Object.isFrozen(application)); assert.ok(Object.isFrozen(application.company));
      assert.ok(options.signal instanceof AbortSignal); assert.equal(options.signal.aborted, false);
      assert.equal(options.isCurrent(), true, "Actual action guard must be valid at dispatch");
      const gate = deferred<void>();
      const request: WorkspacePending = { application, options, actor: capturedActor, claimed: false, settled: false,
        reply() { assert.equal(request.settled, false); request.settled = true; gate.resolve(); },
        fail(error = Error("Synthetic workspace unavailable")) {
          assert.equal(request.settled, false); request.settled = true; gate.reject(error);
        },
      };
      workspaceRequests.push(request);
      // Deliberately deliver even after abort; freshness belongs to the component.
      return gate.promise;
    };
    render.mount(host.jsx(component, props as unknown as Props));
  }
  mount();
  t.after(async () => {
    render.dispose(); const writes = render.writes();
    for (const request of requests) if (!request.settled) request.fail();
    for (const request of workspaceRequests) if (!request.settled) request.fail();
    for (let i = 0; i < 32; i++) await Promise.resolve();
    assert.equal(render.writes(), writes, "No state publication after disposal");
    assert.equal(windowEvents.count() + documentEvents.count(), 0, "All actual browser listeners are removed");
    assert.deepEqual(forbiddenCalls, [], "No storage, real network, timer, SDK or unexpected dependency access, even if caught");
  });
  function take() {
    const request = requests.find(r => !r.claimed); assert.ok(request, "Expected an actual inbox list read");
    request.claimed = true; return request;
  }
  function takeWorkspace() {
    const request = workspaceRequests.find(r => !r.claimed); assert.ok(request, "Expected an actual workspace callback invocation");
    request.claimed = true; return request;
  }
  function page(request: Pending, items = [application()], hasMore = false): Page {
    return { items, hasMore, offset: request.options.offset, state: request.options.state };
  }
  function reply(request: Pending, items = [application()], hasMore = false) {
    const value = page(request, items, hasMore);
    assert.ok(actualContracts.parsePartnerCompanyPage(value, request.options), "Positive fixture must pass the actual parser");
    request.reply(value);
  }
  function callback(node: Element, event = "onClick") {
    const value = node.props[event]; assert.equal(typeof value, "function", `Expected actual ${event}`);
    return value as (event?: unknown) => void;
  }
  function find(predicate: (node: Element) => boolean) {
    const matches = render.nodes().filter(predicate); assert.equal(matches.length, 1, `Expected one host control; actual: ${render.content()}`);
    return matches[0]!;
  }
  function button(label: string | RegExp) {
    return find(node => node.type === "button" && (typeof label === "string"
      ? node.props["aria-label"] === label || host.text(node) === label
      : label.test(String(node.props["aria-label"] ?? host.text(node)))));
  }
  function workspaceButtons() {
    return render.nodes().filter(node => node.type === "button" && (String(node.props.className).split(" ").includes("pci-open-workspace")
      || /Открыть.*(?:CRM|пространств)/i.test(String(node.props["aria-label"] ?? host.text(node)))));
  }
  function workspaceButton() {
    const buttons = workspaceButtons(); assert.equal(buttons.length, 1, `Expected one workspace action: ${render.content()}`);
    return buttons[0]!;
  }
  function noNavigation() {
    assert.equal(render.nodes().some(node => node.type === "a" || node.type === "form"
      || ["href", "to", "action", "formAction"].some(name => node.props[name] !== undefined)), false,
    "Only the parent callback may authorize navigation; the inbox cannot navigate or submit a form");
  }
  function click(label: string | RegExp) {
    const node = button(label); assert.notEqual(node.props.disabled, true); callback(node)();
  }
  function filterNode() { return find(node => node.type === "select"); }
  async function filter(value: string) { callback(filterNode(), "onChange")({ target: { value }, currentTarget: { value } }); await render.flush(); }
  function row(name = application().company.name) {
    return find(node => node.type === "button" && host.text(node).includes(name));
  }
  async function ready(items = [application()], hasMore = false) { await render.flush(); reply(take(), items, hasMore); await render.flush(); }
  function noPrivate(items = [application()]) {
    for (const item of items) {
      assert.equal(render.content().includes(item.company.name), false, "Private company name must not display");
      assert.equal(render.content().includes(item.company.ownerName), false, "Private owner must not display");
    }
  }
  return { render, requests, parserCalls, parsedPages, workspaceRequests, workspaceButtons, workspaceButton, takeWorkspace, noNavigation,
    document, window: windowEvents, take, page, reply, callback, find, button, click,
    filter, filterNode, row, ready, noPrivate, denied: () => denied, newApplications: () => newApplications,
    switchActor(next: string) { actor = next; epoch++; mount(); },
    invalidate() { epoch++; }, remount: mount,
  };
}

test("actual inbox defaults to all, reads only list parameters, parses the expected page and remains read-only", async t => {
  const h = fixture(t); await h.render.flush(); const request = h.take();
  assert.equal(request.actor, A); assert.equal(request.options.offset, 0); assert.equal(request.options.state, null);
  assert.equal(h.filterNode().props.value, "all");
  h.reply(request); await h.render.flush();
  assert.ok(h.render.content().includes(application().company.name));
  assert.equal(h.parserCalls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.parserCalls[0].expected)), { offset: 0, state: null });
  h.callback(h.row())(); await h.render.flush();
  assert.ok(h.render.content().includes(application().company.ownerName));
  assert.equal(h.requests.length, 1, "Selected details come from the validated list, never a second read or a write");
  assert.equal(h.render.nodes().some(n => n.type === "form" || n.type === "textarea" || n.type === "input"), false);
  assert.equal(h.render.nodes().some(n => n.type === "button" && /^(Одобрить|Отклонить|Сохранить|Удалить)/.test(host.text(n))), false);
  h.click(/Новая заявка/); assert.equal(h.newApplications(), 1);
});

test("native all/pending/approved/rejected filters and twenty-row paging retain exact state and reset offset", async t => {
  const h = fixture(t); await h.ready(fullPage(), true);
  const options = host.elements(h.filterNode()).filter(n => n.type === "option").map(n => n.props.value);
  assert.deepEqual([...options].sort(), ["all", "approved", "pending", "rejected"]);
  assert.equal(h.button(/Предыдущая/).props.disabled, true);
  h.click(/Следующая/); await h.render.beforeEffects(); h.noPrivate(fullPage());
  await h.render.flush(); const second = h.take();
  assert.equal(second.options.offset, 20); assert.equal(second.options.state, null);
  h.reply(second, [application(60)]); await h.render.flush();
  assert.equal(h.button(/Следующая/).props.disabled, true);
  h.click(/Предыдущая/); await h.render.flush();
  const previous = h.take(); assert.equal(previous.options.offset, 0); h.reply(previous, fullPage(), true); await h.render.flush();
  for (const state of ["pending", "approved", "rejected", "all"] as const) {
    await h.filter(state); const read = h.take();
    assert.equal(read.options.offset, 0); assert.equal(read.options.state, state === "all" ? null : state);
    h.reply(read, fullPage(state === "all" ? "pending" : state), true); await h.render.flush();
    h.click(/Следующая/); await h.render.flush(); const next = h.take();
    assert.equal(next.options.offset, 20); assert.equal(next.options.state, state === "all" ? null : state);
    h.reply(next, [application(60, state === "all" ? "pending" : state)]); await h.render.flush();
  }
});

const malformed: { name: string; change(page: Page): unknown }[] = [
  { name: "wrong offset", change: p => ({ ...p, offset: 20 }) },
  { name: "wrong state", change: p => ({ ...p, state: "pending" }) },
  { name: "negative offset", change: p => ({ ...p, offset: -1 }) },
  { name: "fractional offset", change: p => ({ ...p, offset: 0.5 }) },
  { name: "excess offset", change: p => ({ ...p, offset: 1000001 }) },
  { name: "twenty-one rows", change: p => ({ ...p, items: [...fullPage(), application(60)] }) },
  { name: "short hasMore page", change: p => ({ ...p, hasMore: true }) },
  { name: "duplicate IDs", change: p => ({ ...p, items: [application(), application()] }) },
  { name: "ascending rows", change: p => ({ ...p, items: [application(79), application(80)] }) },
  { name: "foreign page field", change: p => ({ ...p, foreignActor: "FOREIGN_SECRET" }) },
  { name: "foreign application field", change: p => ({ ...p, items: [{ ...application(), email: "FOREIGN_SECRET" }] }) },
  { name: "foreign company field", change: p => ({ ...p, items: [{ ...application(), company: { ...application().company, phone: "FOREIGN_SECRET" } }] }) },
  { name: "invalid workspace authority", change: p => ({ ...p, items: [{ ...application(), workspaceId: uuid(900) }] }) },
  { name: "invalid name bounds", change: p => ({ ...p, items: [{ ...application(), company: { ...application().company, name: "x".repeat(121) } }] }) },
  { name: "malformed body", change: () => null },
];
for (const invalid of malformed) {
  test(`actual inbox rejects ${invalid.name} atomically without private display or empty success`, async t => {
    const h = fixture(t); await h.render.flush(); const read = h.take();
    read.reply(invalid.change(h.page(read))); await h.render.flush();
    h.noPrivate(); assert.equal(h.render.content().includes("FOREIGN_SECRET"), false);
    assert.ok(h.render.nodes().some(n => n.props.role === "alert"), "Malformed data is a failed read, not an empty list");
    assert.equal(h.render.content().includes("Заявок пока нет"), false);
    assert.equal(h.denied(), 0); assert.equal(h.requests.length, 1);
  });
}

test("failed read is visibly different from a validated empty page and retry preserves filter", async t => {
  const h = fixture(t); await h.render.flush(); h.take().fail(); await h.render.flush();
  assert.ok(h.render.nodes().some(n => n.props.role === "alert"));
  assert.equal(h.render.content().includes("Заявок пока нет"), false);
  h.click(/Обновить|Повторить/); await h.render.flush(); const retry = h.take();
  assert.equal(retry.options.offset, 0); assert.equal(retry.options.state, null);
  h.reply(retry, []); await h.render.flush();
  assert.equal(h.render.nodes().some(n => n.props.role === "alert"), false);
  assert.ok(/нет|пуст|найден/i.test(h.render.content()), "Validated empty read has an explicit empty state");
});

test("approved detail stays read-only with no application-targeted CRM navigation or workspace bypass", async t => {
  const approved = application(80, "approved"), h = fixture(t); await h.ready([approved]);
  h.callback(h.row(approved.company.name))(); await h.render.flush();
  assert.ok(h.render.content().includes(approved.company.ownerName));
  assert.ok(h.render.content().includes("Одобрена"));
  assert.equal(h.render.nodes().some(n => n.type === "a"), false,
    "The inbox cannot imply that generic CRM navigation selects the approved workspace; Shell team navigation is outside this component");
  assert.equal(h.render.nodes().some(n => n.props.href !== undefined || n.props.to !== undefined
    || n.props.formAction !== undefined), false, "No application-targeted navigation, form action or permission handoff");
  assert.equal(h.render.nodes().some(n => n.type === "button" && /CRM|пространств|перейти|открыть/i.test(host.text(n))), false);
  assert.equal(h.render.content().includes(approved.workspaceId!), false, "An approved workspace ID is not an authorization capability");
  assert.equal(h.requests.length, 1); assert.equal(h.denied(), 0); assert.equal(h.newApplications(), 0);
});

test("retired filter/page/row/refresh/new-form callbacks cannot enter a new actor or revive after A-B-A", async t => {
  const h = fixture(t); await h.ready(fullPage(), true);
  const callbacks = [h.callback(h.filterNode(), "onChange"), h.callback(h.button(/Следующая/)), h.callback(h.row(fullPage()[0].company.name)),
    h.callback(h.button(/Обновить/)), h.callback(h.button(/Новая заявка/))];
  const oldRead = h.requests[0];
  h.switchActor(B); await h.render.beforeEffects(); h.noPrivate(fullPage());
  await h.render.flush(); const b = h.take(); h.reply(b, [application(50, "pending", "Synthetic B Company")]); await h.render.flush();
  const before = h.render.content(), reads = h.requests.length;
  for (const callback of callbacks) callback({ target: { value: "rejected" } });
  await h.render.flush(); assert.equal(h.render.content(), before); assert.equal(h.requests.length, reads);
  assert.equal(h.newApplications(), 0); assert.equal(h.denied(), 0); assert.equal(oldRead.options.isCurrent(), false);
  h.switchActor(A); await h.render.flush(); const a = h.take(); h.reply(a); await h.render.flush();
  const current = h.render.content();
  for (const callback of callbacks) callback({ target: { value: "approved" } });
  await h.render.flush(); assert.equal(h.render.content(), current); assert.equal(h.requests.length, reads + 1);
  assert.equal(oldRead.options.isCurrent(), false); assert.equal(h.newApplications(), 0);
});

for (const outcome of ["success", "401 rejection", "403 rejection"] as const) {
  test(`late ${outcome} from A cannot clear or populate B or the returned A lifetime`, async t => {
    const h = fixture(t); await h.render.flush(); const first = h.take();
    h.switchActor(B); await h.render.flush(); const b = h.take();
    h.reply(b, [application(50, "pending", "Synthetic B Company")]); await h.render.flush();
    h.switchActor(A); await h.render.flush(); const a = h.take();
    h.reply(a, [application(40, "pending", "Synthetic Current A")]); await h.render.flush();
    const before = h.render.content();
    if (outcome === "success") h.reply(first);
    else first.fail(Object.assign(Error(`Synthetic ${outcome}`), { status: outcome === "401 rejection" ? 401 : 403 }));
    await h.render.flush(); assert.equal(h.render.content(), before); h.noPrivate();
    assert.equal(h.denied(), 0); assert.equal(h.requests.length, 3); assert.equal(first.options.isCurrent(), false);
    assert.equal(first.options.signal.aborted, true);
  });
}

test("same actor with a replaced session guard retires callbacks before passive cleanup", async t => {
  const h = fixture(t); await h.ready(); const oldNew = h.callback(h.button(/Новая заявка/)), oldRow = h.callback(h.row());
  h.invalidate(); h.remount(); await h.render.beforeEffects(); h.noPrivate();
  oldNew(); oldRow(); await h.render.flush();
  assert.equal(h.newApplications(), 0); assert.equal(h.denied(), 0);
  assert.equal(h.requests[0].options.isCurrent(), false);
});

for (const trigger of ["focus", "visibility", "manual"] as const) {
  test(`${trigger} refresh hides selected data and retires row callbacks`, async t => {
    const h = fixture(t); await h.ready(); const row = h.callback(h.row()); row(); await h.render.flush();
    const oldRead = h.requests[0];
    if (trigger === "focus") h.window.dispatch("focus");
    else if (trigger === "visibility") h.document.dispatch("visibilitychange");
    else h.click(/Обновить/);
    await h.render.beforeEffects(); h.noPrivate(); await h.render.flush();
    const fresh = h.take(); assert.equal(oldRead.options.isCurrent(), false);
    row(); await h.render.flush(); h.noPrivate();
    h.reply(fresh, [application(50, "pending", "Synthetic Refreshed Company")]); await h.render.flush();
    assert.ok(h.render.content().includes("Synthetic Refreshed Company"));
    assert.equal(h.render.content().includes(application().company.ownerName), false);
  });
}

test("blur and hidden visibility hide private data and invalidate in-flight reads until a fresh focus", async t => {
  const h = fixture(t); await h.ready(); h.callback(h.row())(); await h.render.flush();
  h.window.dispatch("focus"); await h.render.flush(); const inFlight = h.take();
  h.window.dispatch("blur"); await h.render.beforeEffects(); h.noPrivate(); await h.render.flush();
  assert.equal(inFlight.options.isCurrent(), false); assert.equal(inFlight.options.signal.aborted, true);
  h.reply(inFlight); await h.render.flush(); h.noPrivate();
  h.document.visibilityState = "hidden"; h.document.dispatch("visibilitychange"); await h.render.flush();
  assert.equal(h.requests.length, 2, "Hidden/blurred panels never start a background list read");
  h.document.visibilityState = "visible"; h.window.dispatch("focus"); await h.render.flush();
  const fresh = h.take(); h.reply(fresh); await h.render.flush(); assert.ok(h.render.content().includes(application().company.name));
});

test("native filter rejects forged values and rapid duplicate paging cannot create an extra read", async t => {
  const h = fixture(t); await h.ready(fullPage(), true);
  for (const invalid of ["foreign", "", "ALL", "pending&actorId=other"]) {
    await h.filter(invalid); assert.equal(h.requests.length, 1); assert.equal(h.filterNode().props.value, "all");
  }
  const next = h.callback(h.button(/Следующая/)); next(); next(); await h.render.flush();
  assert.equal(h.requests.length, 2); const read = h.take(); assert.equal(read.options.offset, 20);
  h.reply(read, [application(60)]); await h.render.flush();
  next(); await h.render.flush(); assert.equal(h.requests.length, 2, "A retained previous-page callback is permanently inert");
});

test("filter A-B-A and row A-B-A do not revive old row or new-form callbacks", async t => {
  const h = fixture(t); await h.ready(fullPage(), true);
  const rowA = h.callback(h.row(fullPage()[0].company.name));
  const rowB = h.callback(h.row(fullPage()[1].company.name));
  const oldNew = h.callback(h.button(/Новая заявка/));
  rowB(); await h.render.flush();
  h.callback(h.row(fullPage()[0].company.name))(); await h.render.flush();
  const before = h.render.content(); rowA(); rowB(); oldNew(); await h.render.flush();
  assert.equal(h.render.content(), before); assert.equal(h.newApplications(), 0);
  await h.filter("pending"); h.reply(h.take(), fullPage(), true); await h.render.flush();
  await h.filter("all"); h.reply(h.take(), fullPage(), true); await h.render.flush();
  rowA(); rowB(); oldNew(); await h.render.flush();
  assert.equal(h.newApplications(), 0); assert.equal(h.requests.length, 3);
  assert.ok(h.render.nodes().some(n => n.type === "button" && n.props["aria-pressed"] === true
    && host.text(n).includes(fullPage()[0].company.name)));
});

for (const stage of ["headers", "body"] as const) {
  for (const outcome of ["success", "401", "403"] as const) {
    test(`actual client + inbox: late ${stage} ${outcome} cannot change another actor or returned A`, async t => {
      const h = fixture(t, true); await h.render.flush(); const first = h.take();
      const body = stage === "body" ? first.headers() : undefined;
      await h.render.flush(); assert.equal(first.jsonCalls, stage === "body" ? 1 : 0);
      h.switchActor(B); await h.render.flush(); const b = h.take();
      h.reply(b, [application(50, "pending", "Synthetic B Current")]); await h.render.flush();
      h.switchActor(A); await h.render.flush(); const a = h.take();
      h.reply(a, [application(40, "pending", "Synthetic A Current")]); await h.render.flush();
      const before = h.render.content();
      if (stage === "body") {
        if (outcome === "success") body!.resolve({ success: true, data: h.page(first) });
        else body!.reject(Object.assign(Error("Synthetic delayed JSON refusal"), { status: Number(outcome) }));
      } else if (outcome === "success") h.reply(first);
      else first.headers(Number(outcome));
      await h.render.flush();
      assert.equal(h.render.content(), before); h.noPrivate(); assert.equal(h.denied(), 0);
      assert.equal(h.requests.length, 3); assert.equal(first.options.isCurrent(), false);
      assert.equal(first.options.signal.aborted, true);
      assert.equal(first.jsonCalls, stage === "body" ? 1 : 0, "Retired headers cannot start JSON parsing");
    });
  }
}

for (const stage of ["headers", "body"] as const) {
  test(`actual client + inbox: superseded ${stage} cannot change current filter or publish a stale refusal`, async t => {
    const h = fixture(t, true); await h.render.flush(); const first = h.take();
    const body = stage === "body" ? first.headers() : undefined; await h.render.flush();
    await h.filter("approved"); const current = h.take(); h.reply(current, [application(60, "approved")]); await h.render.flush();
    const before = h.render.content();
    if (stage === "headers") first.headers(403);
    else body!.reject(Object.assign(Error("Synthetic previous-filter refusal"), { status: 403 }));
    await h.render.flush(); assert.equal(h.render.content(), before);
    assert.equal(h.filterNode().props.value, "approved"); assert.equal(h.denied(), 0);
    assert.equal(first.options.isCurrent(), false); assert.equal(h.requests.length, 2);
  });
}

test("actual client + inbox: late focus-refresh JSON cannot repopulate a blurred pane", async t => {
  const h = fixture(t, true); await h.ready(); h.window.dispatch("focus"); await h.render.flush();
  const first = h.take(), body = first.headers(); await h.render.flush();
  assert.equal(first.jsonCalls, 1); h.window.dispatch("blur"); await h.render.beforeEffects(); h.noPrivate();
  body.resolve({ success: true, data: h.page(first) }); await h.render.flush(); h.noPrivate();
  assert.equal(h.denied(), 0); assert.equal(first.options.isCurrent(), false);
  h.window.dispatch("focus"); await h.render.flush(); const current = h.take();
  h.reply(current); await h.render.flush(); assert.ok(h.render.content().includes(application().company.name));
});

for (const status of [401, 403, 404]) {
  test(`actual client + inbox: current ${status} headers hide private data without reading the refusal body`, async t => {
    const h = fixture(t, true); await h.ready(); h.window.dispatch("focus"); await h.render.flush();
    const read = h.take(); read.headers(status); await h.render.flush();
    h.noPrivate(); assert.equal(h.denied(), 1); assert.equal(read.jsonCalls, 0);
    assert.equal(h.render.content().includes("Заявок пока нет"), false);
  });
}

for (const status of [401, 403]) {
  test(`current ${status} refusal hides data and notifies access denial only once`, async t => {
    const h = fixture(t); await h.ready(); h.window.dispatch("focus"); await h.render.flush();
    h.take().fail(Object.assign(Error("Synthetic private refusal"), { status })); await h.render.flush(); h.noPrivate();
    assert.equal(h.denied(), 1);
    h.window.dispatch("focus"); await h.render.flush();
    assert.equal(h.requests.length, 2); assert.equal(h.denied(), 1);
  });
}

test("unmounted inbox aborts its read and permanently retires all captured callbacks", async t => {
  const h = fixture(t); await h.ready(fullPage(), true);
  const callbacks = [h.callback(h.row(fullPage()[0].company.name)), h.callback(h.button(/Новая заявка/)), h.callback(h.button(/Обновить/))];
  h.window.dispatch("focus"); await h.render.flush(); const read = h.take();
  h.render.dispose(); const writes = h.render.writes(), count = h.requests.length;
  assert.equal(read.options.signal.aborted, true); assert.equal(read.options.isCurrent(), false);
  for (const callback of callbacks) callback();
  read.fail({ status: 403 }); for (let i = 0; i < 32; i++) await Promise.resolve();
  assert.equal(h.render.writes(), writes); assert.equal(h.requests.length, count);
  assert.equal(h.newApplications(), 0); assert.equal(h.denied(), 0);
});

for (const state of ["pending", "approved", "rejected"] as const) {
  for (const withWorkspace of [false, true]) {
    test(`actual inbox workspace action: ${state}, callback ${withWorkspace ? "present" : "absent"}`, async t => {
      const h = fixture(t, false, withWorkspace), item = application(80, state);
      assert.equal(h.workspaceButtons().length, 0, "Loading cannot offer a workspace action");
      await h.ready([item]);
      assert.equal(h.workspaceButtons().length, state === "approved" && withWorkspace ? 1 : 0);
      assert.equal(h.workspaceRequests.length, 0, "Displaying approved data never invokes a callback automatically");
      assert.equal(h.requests.length, 1); h.noNavigation();
    });
  }
}

for (const outcome of ["empty", "error"] as const) {
  test(`workspace callback presence cannot offer an action on an ${outcome} inbox`, async t => {
    const h = fixture(t, false, true); await h.render.flush(); const read = h.take();
    if (outcome === "empty") h.reply(read, []); else read.fail();
    await h.render.flush(); assert.equal(h.workspaceButtons().length, 0);
    assert.equal(h.workspaceRequests.length, 0); h.noNavigation();
  });
}

for (const trigger of ["filter", "page", "selection"] as const) {
  test(`idle workspace callback cannot revive after ${trigger} A-B-A`, async t => {
    const h = fixture(t, false, true), items = fullPage("approved"); await h.ready(items, true);
    const oldOpen = h.callback(h.workspaceButton());
    if (trigger === "filter") {
      await h.filter("approved"); h.reply(h.take(), items, true); await h.render.flush();
      await h.filter("all"); h.reply(h.take(), items, true); await h.render.flush();
    } else if (trigger === "page") {
      h.click(/Следующая/); await h.render.flush(); h.reply(h.take(), [application(60, "approved")]); await h.render.flush();
      h.click(/Предыдущая/); await h.render.flush(); h.reply(h.take(), items, true); await h.render.flush();
    } else {
      h.callback(h.row(items[1].company.name))(); await h.render.flush();
      h.callback(h.row(items[0].company.name))(); await h.render.flush();
    }
    const before = h.render.content(), writes = h.render.writes(); oldOpen(); await h.render.flush();
    assert.equal(h.workspaceRequests.length, 0); assert.equal(h.render.content(), before); assert.equal(h.render.writes(), writes);
    h.callback(h.workspaceButton())(); const current = h.takeWorkspace();
    assert.equal(current.application.id, items[0].id); current.reply(); await h.render.flush();
    assert.equal(h.denied(), 0); h.noNavigation();
  });
}

test("workspace callback receives the exact immutable parsed selection, never a raw row, ID or another application", async t => {
  const h = fixture(t, false, true), pending = application(82), first = application(81, "approved"), selected = application(80, "approved");
  const expected = structuredClone(selected);
  await h.ready([pending, first, selected]); assert.equal(h.workspaceButtons().length, 0);
  h.callback(h.row(selected.company.name))(); await h.render.flush();
  assert.equal(h.row(selected.company.name).props["aria-pressed"], true);
  // Mutating the raw response must not change the validated action payload.
  selected.company.name = "Synthetic raw response mutation"; selected.revision = uuid(9999); selected.workspaceId = uuid(9998);
  const open = h.callback(h.workspaceButton()); open(); open();
  const action = h.takeWorkspace();
  assert.strictEqual(action.application, h.parsedPages[0].items[2], "Delegate the selected object from the actual parser");
  assert.notStrictEqual(action.application, selected);
  assert.deepEqual(JSON.parse(JSON.stringify(action.application)), expected);
  assert.equal(Reflect.set(action.application, "workspaceId", uuid(9997)), false);
  assert.equal(Reflect.set(action.application.company, "name", "Synthetic forbidden mutation"), false);
  assert.equal(action.actor, A); assert.equal(h.workspaceRequests.length, 1, "Same-turn duplicate clicks are blocked");
  await h.render.flush();
  const busy = h.workspaceButton(); assert.equal(busy.props.disabled, true);
  h.callback(busy)(); open(); await h.render.flush();
  assert.equal(h.workspaceRequests.length, 1, "A retained or disabled busy callback cannot start another action");
  assert.ok(h.render.nodes().some(node => node.props["aria-busy"] === true), "The delegated action has an accessible busy state");
  assert.equal(action.options.isCurrent(), true); assert.equal(action.options.signal.aborted, false);
  h.noNavigation(); action.reply(); await h.render.flush();
  assert.notEqual(h.workspaceButton().props.disabled, true);
  assert.equal(action.options.isCurrent(), false, "Completion permanently retires the action guard");
  assert.equal(h.requests.length, 1, "Opening a workspace is delegated, not another inbox read");
  assert.equal(h.newApplications(), 0); assert.equal(h.denied(), 0); h.noNavigation();
});

for (const status of [401, 403, 404]) {
  test(`current workspace ${status} rejection hides private data and permanently denies the current lifetime`, async t => {
    const h = fixture(t, false, true), item = application(80, "approved"); await h.ready([item]);
    const oldOpen = h.callback(h.workspaceButton()), oldRow = h.callback(h.row(item.company.name));
    oldOpen(); const action = h.takeWorkspace(); await h.render.flush();
    action.fail(Object.assign(Error("SYNTHETIC_PRIVATE_WORKSPACE_REFUSAL"), { status })); await h.render.flush();
    h.noPrivate([item]); assert.equal(h.workspaceButtons().length, 0);
    assert.equal(h.denied(), 1); assert.equal(action.options.isCurrent(), false); assert.equal(action.options.signal.aborted, true);
    assert.equal(h.render.content().includes("SYNTHETIC_PRIVATE_WORKSPACE_REFUSAL"), false, "Raw callback errors never display");
    assert.ok(h.render.nodes().some(node => node.props.role === "alert"));
    oldOpen(); oldRow(); h.window.dispatch("focus"); await h.render.flush();
    assert.equal(h.workspaceRequests.length, 1); assert.equal(h.requests.length, 1); assert.equal(h.denied(), 1);
    h.noPrivate([item]); h.noNavigation();
  });
}

for (const status of [0, 409, 500]) {
  test(`workspace ${status || "transport"} error is private, retryable and stays on the selected application`, async t => {
    const h = fixture(t, false, true), items = [application(81, "approved"), application(80, "approved")];
    await h.ready(items); h.callback(h.row(items[1].company.name))(); await h.render.flush();
    const oldOpen = h.callback(h.workspaceButton()); oldOpen(); const first = h.takeWorkspace(); await h.render.flush();
    first.fail(Object.assign(Error("SYNTHETIC_PRIVATE_WORKSPACE_FAILURE"), { status })); await h.render.flush();
    assert.ok(h.render.nodes().some(node => node.props.role === "alert"), "A failed action has a visible error state");
    assert.equal(h.render.content().includes("SYNTHETIC_PRIVATE_WORKSPACE_FAILURE"), false);
    assert.ok(h.render.content().includes(items[1].company.ownerName)); assert.equal(h.denied(), 0);
    assert.equal(h.row(items[1].company.name).props["aria-pressed"], true);
    assert.equal(first.options.isCurrent(), false); oldOpen(); await h.render.flush();
    assert.equal(h.workspaceRequests.length, 1, "The pre-error callback cannot become the retry");
    const retryButton = h.workspaceButton(); assert.notEqual(retryButton.props.disabled, true);
    h.callback(retryButton)(); const retry = h.takeWorkspace(); await h.render.flush();
    assert.strictEqual(retry.application, first.application); assert.notStrictEqual(retry.options.signal, first.options.signal);
    assert.equal(retry.options.isCurrent(), true); assert.equal(h.workspaceRequests.length, 2);
    retry.reply(); await h.render.flush();
    assert.equal(h.render.nodes().some(node => node.props.role === "alert"), false, "Successful retry clears the action error");
    assert.notEqual(h.workspaceButton().props.disabled, true); assert.equal(h.requests.length, 1); h.noNavigation();
  });
}

const workspaceInvalidations = ["blur", "hidden", "focus", "refresh"] as const;
for (const trigger of workspaceInvalidations) {
  for (const outcome of ["success", "refusal", "error"] as const) {
    test(`workspace ${trigger} invalidation: late ${outcome} and retained callbacks cannot affect a fresh action`, async t => {
      const h = fixture(t, false, true), items = fullPage("approved"); await h.ready(items, true);
      const oldOpen = h.callback(h.workspaceButton()); oldOpen(); const oldAction = h.takeWorkspace(); await h.render.flush();
      if (trigger === "blur") h.window.dispatch("blur");
      else if (trigger === "hidden") { h.document.visibilityState = "hidden"; h.document.dispatch("visibilitychange"); }
      else if (trigger === "focus") h.window.dispatch("focus");
      else h.click(/Обновить/);
      assert.equal(oldAction.options.isCurrent(), false, "Invalidation is synchronous, before the next render");
      assert.equal(oldAction.options.signal.aborted, true);
      await h.render.beforeEffects();
      h.noPrivate(items); assert.equal(h.workspaceButtons().length, 0);
      oldOpen(); await h.render.flush(); assert.equal(h.workspaceRequests.length, 1);
      if (trigger === "blur") h.window.dispatch("focus");
      if (trigger === "hidden") { h.document.visibilityState = "visible"; h.document.dispatch("visibilitychange"); }
      await h.render.flush();
      const read = h.take(); assert.equal(read.options.offset, 0); assert.equal(read.options.state, null);
      h.reply(read, [application(60, "approved")]); await h.render.flush();
      oldOpen(); await h.render.flush(); assert.equal(h.workspaceRequests.length, 1);
      h.callback(h.workspaceButton())(); const current = h.takeWorkspace(); await h.render.flush();
      const before = h.render.content(), writes = h.render.writes(), reads = h.requests.length;
      if (outcome === "success") oldAction.reply();
      else oldAction.fail(Object.assign(Error("SYNTHETIC_STALE_ACTION_ERROR"), { status: outcome === "refusal" ? 403 : 500 }));
      await h.render.flush();
      assert.equal(h.render.content(), before); assert.equal(h.render.writes(), writes, "Stale completion cannot publish or clear current busy state");
      assert.equal(current.options.isCurrent(), true); assert.equal(current.options.signal.aborted, false);
      assert.equal(h.workspaceButton().props.disabled, true); assert.equal(h.denied(), 0);
      assert.equal(h.workspaceRequests.length, 2); assert.equal(h.requests.length, reads);
      oldOpen(); await h.render.flush(); assert.equal(h.workspaceRequests.length, 2); h.noNavigation();
      current.reply(); await h.render.flush(); assert.notEqual(h.workspaceButton().props.disabled, true);
    });
  }
}

for (const trigger of ["filter", "page", "selection"] as const) {
  for (const outcome of ["success", "refusal", "error"] as const) {
    const recovery = outcome === "refusal" ? "blur/focus" : "refresh";
    test(`workspace ${trigger} is blocked while opening; ${recovery} and genuine changes retire callbacks before late ${outcome}`, async t => {
      const h = fixture(t, false, true), items = fullPage("approved"); await h.ready(items, true);
      const control = () => trigger === "filter" ? h.filterNode()
        : trigger === "page" ? h.button(/Следующая/) : h.row(items[1].company.name);
      const event = trigger === "filter" ? "onChange" : "onClick";
      const change = { target: { value: "approved" }, currentTarget: { value: "approved" } };
      const oldTransition = h.callback(control(), event), oldOpen = h.callback(h.workspaceButton());
      assert.notEqual(control().props.disabled, true, "The attempted transition is available before opening");
      oldOpen(); const oldAction = h.takeWorkspace(); await h.render.flush();
      const busyControl = control(), busyOpen = h.callback(h.workspaceButton()), busyTransition = h.callback(busyControl, event);
      assert.equal(busyControl.props.disabled, true, "Opening visibly locks this transition");
      assert.equal(h.workspaceButton().props.disabled, true);
      const blockedContent = h.render.content(), blockedWrites = h.render.writes();
      oldTransition(change); busyTransition(change); oldOpen(); busyOpen(); await h.render.flush();
      assert.equal(h.render.content(), blockedContent); assert.equal(h.render.writes(), blockedWrites, "Blocked callbacks cannot publish");
      assert.equal(h.filterNode().props.value, "all");
      assert.equal(h.row(items[0].company.name).props["aria-pressed"], true);
      assert.equal(h.row(items[1].company.name).props["aria-pressed"], false);
      assert.strictEqual(oldAction.application, h.parsedPages[0].items[0]);
      assert.equal(oldAction.options.isCurrent(), true, "A prohibited transition does not cancel or rebind the current action");
      assert.equal(oldAction.options.signal.aborted, false);
      assert.equal(h.requests.length, 1); assert.equal(h.parsedPages.length, 1); assert.equal(h.workspaceRequests.length, 1);

      assert.notEqual(h.button(/Обновить/).props.disabled, true, "Refresh remains available while opening");
      if (recovery === "refresh") h.click(/Обновить/); else h.window.dispatch("blur");
      assert.equal(oldAction.options.isCurrent(), false, "An allowed cancellation retires the action synchronously");
      assert.equal(oldAction.options.signal.aborted, true);
      await h.render.beforeEffects(); h.noPrivate(items); assert.equal(h.workspaceButtons().length, 0);
      oldOpen(); busyOpen(); oldTransition(change); busyTransition(change); await h.render.flush();
      assert.equal(h.workspaceRequests.length, 1);
      if (recovery === "blur/focus") h.window.dispatch("focus");
      await h.render.flush(); const refreshed = h.take();
      assert.equal(refreshed.options.offset, 0); assert.equal(refreshed.options.state, null);
      h.reply(refreshed, items, true); await h.render.flush();
      assert.equal(h.requests.length, 2); assert.notEqual(control().props.disabled, true);
      const refreshedOpen = h.callback(h.workspaceButton());
      assert.notEqual(h.workspaceButton().props.disabled, true);
      const retired = [oldOpen, busyOpen, oldTransition, busyTransition];
      async function replay() {
        const before = h.render.content(), writes = h.render.writes(), reads = h.requests.length;
        // A different forged filter value would expose a callback that survived the transition.
        for (const callback of retired) callback({ target: { value: "rejected" }, currentTarget: { value: "rejected" } });
        await h.render.flush();
        assert.equal(h.render.content(), before); assert.equal(h.render.writes(), writes);
        assert.equal(h.requests.length, reads); assert.equal(h.workspaceRequests.length, 1);
        assert.equal(oldAction.options.isCurrent(), false); assert.equal(oldAction.options.signal.aborted, true);
      }
      await replay();
      // Real transitions after cancellation retire even callbacks from the refreshed view.
      if (trigger === "filter") {
        await h.filter("approved"); const read = h.take();
        assert.equal(read.options.offset, 0); assert.equal(read.options.state, "approved");
        h.reply(read, items, true); await h.render.flush(); assert.equal(h.filterNode().props.value, "approved");
      } else if (trigger === "page") {
        h.click(/Следующая/); await h.render.flush(); const read = h.take();
        assert.equal(read.options.offset, 20); assert.equal(read.options.state, null);
        h.reply(read, [application(60, "approved")]); await h.render.flush();
        assert.equal(h.row(application(60, "approved").company.name).props["aria-pressed"], true);
      } else {
        h.callback(control(), event)(); await h.render.flush();
        assert.equal(h.row(items[1].company.name).props["aria-pressed"], true);
        assert.equal(h.row(items[0].company.name).props["aria-pressed"], false);
      }
      retired.push(refreshedOpen); await replay();
      if (trigger === "filter") {
        await h.filter("all"); const read = h.take(); assert.equal(read.options.state, null);
        h.reply(read, items, true); await h.render.flush();
      } else if (trigger === "page") {
        h.click(/Предыдущая/); await h.render.flush(); const read = h.take(); assert.equal(read.options.offset, 0);
        h.reply(read, items, true); await h.render.flush();
      } else {
        h.callback(h.row(items[0].company.name))(); await h.render.flush();
      }
      assert.equal(h.filterNode().props.value, "all");
      assert.equal(h.row(items[0].company.name).props["aria-pressed"], true);
      await replay(); assert.equal(h.requests.length, trigger === "selection" ? 2 : 4);
      h.callback(h.workspaceButton())(); const current = h.takeWorkspace(); await h.render.flush();
      assert.equal(current.actor, A); assert.equal(current.application.id, oldAction.application.id);
      assert.notStrictEqual(current.application, oldAction.application, "Matching IDs must not revive the old parsed page or action");
      const before = h.render.content(), writes = h.render.writes(), reads = h.requests.length;
      if (outcome === "success") oldAction.reply();
      else oldAction.fail(Object.assign(Error("SYNTHETIC_STALE_ACTION_ERROR"), { status: outcome === "refusal" ? 403 : 500 }));
      await h.render.flush();
      assert.equal(h.render.content(), before); assert.equal(h.render.writes(), writes, "Late completion cannot clear a newer action");
      assert.equal(current.options.isCurrent(), true); assert.equal(current.options.signal.aborted, false);
      assert.equal(h.workspaceButton().props.disabled, true); assert.equal(h.denied(), 0);
      for (const callback of retired) callback(change);
      await h.render.flush(); assert.equal(h.workspaceRequests.length, 2); assert.equal(h.requests.length, reads);
      assert.equal(h.newApplications(), 0); h.noNavigation();
      current.reply(); await h.render.flush(); assert.notEqual(h.workspaceButton().props.disabled, true);
    });
  }
}

for (const outcome of ["success", 401, 403, 404, 500] as const) {
  test(`workspace account A-B-A: late ${outcome} cannot publish, deny or clear the new A action`, async t => {
    const h = fixture(t, false, true), first = application(80, "approved"); await h.ready([first]);
    const oldOpen = h.callback(h.workspaceButton()); oldOpen(); const oldAction = h.takeWorkspace(); await h.render.flush();
    h.switchActor(B); assert.equal(oldAction.options.isCurrent(), false); assert.equal(oldAction.options.signal.aborted, true);
    await h.render.beforeEffects(); h.noPrivate([first]); assert.equal(h.workspaceButtons().length, 0);
    await h.render.flush(); h.reply(h.take(), [application(60, "approved", "Synthetic Workspace B")]); await h.render.flush();
    oldOpen(); await h.render.flush(); assert.equal(h.workspaceRequests.length, 1);
    h.switchActor(A); await h.render.flush(); h.reply(h.take(), [application(50, "approved", "Synthetic Workspace Current A")]);
    await h.render.flush(); oldOpen(); await h.render.flush(); assert.equal(h.workspaceRequests.length, 1);
    h.callback(h.workspaceButton())(); const current = h.takeWorkspace(); await h.render.flush();
    assert.equal(current.actor, A); assert.equal(current.application.id, uuid(50));
    const before = h.render.content(), writes = h.render.writes();
    if (outcome === "success") oldAction.reply(); else oldAction.fail({ status: outcome });
    await h.render.flush();
    assert.equal(h.render.content(), before); assert.equal(h.render.writes(), writes);
    assert.equal(oldAction.options.isCurrent(), false); assert.equal(current.options.isCurrent(), true);
    assert.equal(h.workspaceButton().props.disabled, true); assert.equal(h.denied(), 0);
    assert.equal(h.workspaceRequests.length, 2); assert.equal(h.requests.length, 3); h.noNavigation();
    current.reply(); await h.render.flush();
  });
}

for (const outcome of ["success", "refusal", "error"] as const) {
  test(`workspace replaced-session guard retires the action and callback before late ${outcome}`, async t => {
    const h = fixture(t, false, true), item = application(80, "approved"); await h.ready([item]);
    const oldOpen = h.callback(h.workspaceButton()); oldOpen(); const action = h.takeWorkspace(); await h.render.flush();
    h.invalidate(); h.remount(); await h.render.beforeEffects(); h.noPrivate([item]);
    assert.equal(action.options.isCurrent(), false); assert.equal(action.options.signal.aborted, true);
    assert.equal(h.workspaceButtons().length, 0); oldOpen(); await h.render.flush();
    const writes = h.render.writes();
    if (outcome === "success") action.reply(); else action.fail({ status: outcome === "refusal" ? 401 : 500 });
    await h.render.flush(); assert.equal(h.render.writes(), writes); h.noPrivate([item]);
    assert.equal(h.denied(), 0); assert.equal(h.workspaceRequests.length, 1); assert.equal(h.requests.length, 1); h.noNavigation();
  });

  test(`workspace unmount permanently aborts the action and ignores late ${outcome} without state writes`, async t => {
    const h = fixture(t, false, true); await h.ready([application(80, "approved")]);
    const oldOpen = h.callback(h.workspaceButton()); oldOpen(); const action = h.takeWorkspace(); await h.render.flush();
    const busyOpen = h.callback(h.workspaceButton()); h.render.dispose(); const writes = h.render.writes();
    assert.equal(action.options.signal.aborted, true); assert.equal(action.options.isCurrent(), false);
    oldOpen(); busyOpen();
    if (outcome === "success") action.reply(); else action.fail({ status: outcome === "refusal" ? 404 : 500 });
    for (let i = 0; i < 32; i++) await Promise.resolve();
    assert.equal(h.render.writes(), writes); assert.equal(h.workspaceRequests.length, 1);
    assert.equal(h.denied(), 0); assert.equal(h.newApplications(), 0); assert.equal(h.requests.length, 1);
  });
}

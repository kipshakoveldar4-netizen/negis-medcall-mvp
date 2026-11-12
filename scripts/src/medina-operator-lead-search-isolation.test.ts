import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Actual explorer, hooks, parser, operatorApi, crmFetch and serverAuth. Only the
// reconciled host, SDK, fetch and booking boundary are synthetic, not DOM/SDK
// acceptance. No network, browser storage, environment or database is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
type Props = Record<string, unknown> & { children?: Child };
type Element = { type: unknown; props: Props; key?: unknown };
type Child = Element | string | number | boolean | null | undefined | Child[];
type Renderer = {
  hooks: Record<string, (...args: any[]) => any>;
  mount(value: Child): void; flush(): Promise<void>; beforeEffects(): Promise<void>;
  nodes(): Element[]; content(): string; writes(): number; dispose(): void;
};
type Host = {
  renderer(): Renderer; jsx(type: unknown, props: Props, key?: unknown): Element;
  Fragment: symbol; elements(value: Child): Element[]; text(value: Child): string;
};
type Mutation = "none" | "unpin-read-actor" | "drop-request-key";
function compile(source: string, filename: string, mutation: Mutation = "none") {
  let mutations = 0;
  const result = ts.transpileModule(source, {
    fileName: filename, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    transformers: { before: [context => {
      const visit: import("typescript").Visitor = node => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === "env" && ts.isMetaProperty(node.expression)) {
          return ts.factory.createObjectLiteralExpression([
            ts.factory.createPropertyAssignment("BASE_URL", ts.factory.createStringLiteral("/")),
            ts.factory.createPropertyAssignment("VITE_API_BASE_URL", ts.factory.createStringLiteral("")),
          ]);
        }
        if (mutation === "unpin-read-actor" && ts.isCallExpression(node) && ts.isIdentifier(node.expression)
          && node.expression.text === "operatorApi" && node.arguments.length >= 6
          && node.arguments[0]!.getText() === "OPERATOR_LEAD_SEARCH_PATH") {
          mutations++;
          return ts.factory.updateCallExpression(node, node.expression, node.typeArguments,
            node.arguments.map((arg, index) => index === 4 ? ts.factory.createIdentifier("undefined") : arg));
        }
        if (mutation === "drop-request-key" && ts.isBinaryExpression(node)
          && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
          && node.left.getText() === "live.current.request" && node.right.getText() === "original") {
          mutations++;
          return ts.factory.createTrue();
        }
        return ts.visitEachChild(node, visit, context);
      };
      return file => ts.visitNode(file, visit) as import("typescript").SourceFile;
    }] },
  });
  assert.deepEqual(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) ?? [], []);
  if (mutation !== "none") assert.equal(mutations, 1, `Remove exactly one existing ${mutation} safeguard in memory`);
  return result.outputText;
}

const host = (async () => {
  // Reuse the workday suite's AST-selected reconciled host, never its tests or
  // production behavior. Keep ownership and cleanup observable across remounts.
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
  assert.equal(names.size, 0, "All existing reconciled host declarations must exist");
  const exports = {} as Host;
  new Script(compile(`${selected.map(node => node.getFullText(ast)).join("\n")}\nObject.assign(exports, {renderer, jsx, Fragment, elements, text});`, filename))
    .runInNewContext({ assert, exports });
  return exports;
})();
const componentFile = "artifacts/negis/src/components/operators/OperatorLeadExplorer.tsx";
const files = {
  component: componentFile,
  operator: "artifacts/negis/src/lib/operatorApi.ts",
  api: "artifacts/negis/src/lib/api.ts",
  auth: "artifacts/negis/src/lib/serverAuth.ts",
};
const contracts = await import(new URL("../../lib/crm/operator-lead-search-contracts.ts", import.meta.url).href);
const prices = await import(new URL("../../lib/crm/operator-contracts.ts", import.meta.url).href);
const { parseOperatorLeadSearchBody, parseOperatorLeadSearchReport } = contracts;
type Group = "all" | "new" | "in_progress" | "booked" | "postponed" | "lost" | "other";
type Query = { search: string; group: Group; requestId: string | null; offset: number };
type Lead = { id: string; requestId: string; name: string; phone: string; status: string; stageId: string | null;
  stageName: string; group: Exclude<Group, "all">; source: string; createdAt: string | null };
type Report = { generatedAt: string; offset: number; filters: Pick<Query, "group" | "requestId">;
  companies: { requestId: string; displayName: string; leadScope: "assigned" | "clinic" }[];
  totals: Record<Group, string>; matched: string; items: Lead[];
  stageOptions: { requestId: string; items: { id: string; name: string }[] }[]; hasMore: boolean };
type BookingReceipt = {
  id: string; startsAt: string | null; service: string | null; doctorName: string | null;
  priceMinor: string | null; durationMinutes: number | null;
  status: "scheduled" | "confirmed" | "arrived" | "no_show" | "cancelled" | null; timeZone: string;
};
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = id(1), B = id(2), C = id(101), D = id(102), FOREIGN = id(999), S0 = id(201), S1 = id(202);
const groups: Group[] = ["all", "new", "in_progress", "booked", "postponed", "lost", "other"];
const initial: Query = { search: "", group: "all", requestId: null, offset: 0 };
const labels = {
  root: "\u0417\u0430\u044f\u0432\u043a\u0438 \u043e\u043f\u0435\u0440\u0430\u0442\u043e\u0440\u0430",
  search: "\u041f\u043e\u0438\u0441\u043a \u0437\u0430\u044f\u0432\u043e\u043a",
  submit: "\u041d\u0430\u0439\u0442\u0438 \u0437\u0430\u044f\u0432\u043a\u0438",
  company: "\u041a\u043e\u043c\u043f\u0430\u043d\u0438\u044f \u0437\u0430\u044f\u0432\u043e\u043a",
  mobileGroup: "\u0413\u0440\u0443\u043f\u043f\u0430 \u0437\u0430\u044f\u0432\u043e\u043a",
  open: "\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u0437\u0430\u044f\u0432\u043a\u0443: ",
  stage: "\u0421\u0442\u0430\u0434\u0438\u044f \u0437\u0430\u044f\u0432\u043a\u0438: ",
  save: "\u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c \u0441\u0442\u0430\u0434\u0438\u044e: ",
};
function report(query: Query = initial, marker = "current", companies: Report["companies"] = [
  { requestId: C, displayName: "Synthetic C", leadScope: "assigned" },
  { requestId: D, displayName: "Synthetic D", leadScope: "clinic" },
]): Report {
  const totals = { all: "126", new: "21", in_progress: "22", booked: "23", postponed: "24", lost: "25", other: "11" };
  const matched = Number(totals[query.group]);
  const items: Lead[] = Array.from({ length: Math.min(20, Math.max(0, matched - query.offset)) }, (_, i) => ({
    id: id(1000 + query.offset + i), requestId: query.requestId ?? (i % 2 ? D : C),
    name: `contact-${marker}-${query.offset + i}`, phone: `+7000${query.offset + i}`,
    status: "in_progress", stageId: S0, stageName: "Synthetic current stage",
    group: query.group === "all" ? groups[1 + i % 6] as Exclude<Group, "all"> : query.group,
    source: "Synthetic source", createdAt: `2026-10-28T10:00:${String(59 - query.offset - i).padStart(2, "0")}Z`,
  }));
  const value: Report = {
    generatedAt: "2026-10-28T12:00:00.123456Z", offset: query.offset,
    filters: { group: query.group, requestId: query.requestId },
    companies,
    totals, matched: String(matched), items, hasMore: matched > query.offset + items.length,
    stageOptions: [...new Set(items.map(item => item.requestId))].sort().map(requestId => ({ requestId,
      items: [{ id: S0, name: "Synthetic current stage" }, { id: S1, name: "Synthetic next stage" }] })),
  };
  assert.ok(parseOperatorLeadSearchReport(value, query), "Each positive fixture must pass the actual production parser");
  return value;
}
function bookingReceipt(overrides: Partial<BookingReceipt> = {}): BookingReceipt {
  const receipt: BookingReceipt = { id: id(5000), startsAt: "2026-10-28T14:30:00Z", service: "Receipt service",
    doctorName: "Receipt doctor", priceMinor: "1234567890123456789", durationMinutes: 30, status: "scheduled", timeZone: "UTC", ...overrides };
  assert.deepEqual(prices.parseOperatorBooking(receipt, receipt.id, receipt.timeZone), receipt,
    "Booking fixtures, including explicit cleared replay fields, must pass the actual production receipt parser");
  return receipt;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function eventTarget() {
  const target = new EventTarget(), listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener(name: string, callback: () => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(callback); target.addEventListener(name, callback);
    },
    removeEventListener(name: string, callback: () => void) {
      listeners.get(name)?.delete(callback); target.removeEventListener(name, callback);
    },
    dispatch(name: string) { target.dispatchEvent(new Event(name)); },
    callbacks(name: string) { return [...listeners.get(name) ?? []]; },
  };
}
class SyntheticResponse extends Response {
  override readonly json: () => Promise<unknown>;
  constructor(status: number, read: () => Promise<unknown>) {
    super(null, { status, headers: { "content-type": "application/json" } }); this.json = read;
  }
}
type Pending = {
  url: string; init: RequestInit; query: Query | null; body: Record<string, unknown> | null;
  settled: boolean; bodyReads: number;
  succeed(data?: unknown): void; fail(status: number, error?: string): void; reject(): void;
  bodyLater(data: unknown, status?: number): () => void; headersOnly(status: number): void;
};
type BookingBoundary = {
  actorId: string; requestId: string; leadId: string; isSessionCurrent(): boolean;
  onAccessDenied(): void; onBooked(value: BookingReceipt): void;
};
async function runtime(t: TestContext, options: { holdSdk?: boolean; mutation?: Mutation } = {}) {
  const h = await host, render = h.renderer();
  const window = eventTarget(), document = { ...eventTarget(), visibilityState: "visible" };
  const requests: Pending[] = [], lookups: Array<ReturnType<typeof deferred<void>>> = [], denials: string[] = [];
  const boundaries: BookingBoundary[] = [], boundaryActions: string[] = [];
  const raw: Record<string, string> = {}, code: Record<string, string> = {}, iconNames = new Set<string>();
  for (const [name, filename] of Object.entries(files)) {
    raw[name] = await readFile(path.join(root, filename), "utf8");
    code[name] = compile(raw[name], filename, name === "component" ? options.mutation : "none");
    const ast = ts.createSourceFile(filename, raw[name], ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    for (const node of ast.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== "lucide-react") continue;
      const bindings = node.importClause?.namedBindings;
      assert.ok(bindings && ts.isNamedImports(bindings));
      bindings.elements.forEach(item => iconNames.add((item.propertyName ?? item.name).text));
    }
  }
  const icons = Object.fromEntries([...iconNames].map(name => [name, Symbol(name)]));
  const hooks: Renderer["hooks"] = { ...render.hooks, useId() { return render.hooks.useRef("synthetic-search").current; } };
  let actor: string | null = A, sdkActor: string | null = A;
  function OperatorBookingForm(props: BookingBoundary) {
    boundaries.push(props);
    const mounted = hooks.useRef(false);
    hooks.useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    return h.jsx("output", { "data-synthetic-booking": props.leadId, onClick() {
      if (mounted.current && props.isSessionCurrent()) boundaryActions.push(`${props.actorId}:${props.requestId}:${props.leadId}`);
    } });
  }
  const modules: Record<string, Record<string, unknown>> = {};
  function load(name: string) {
    if (modules[name]) return modules[name];
    const exports: Record<string, unknown> = {}; modules[name] = exports;
    function require(specifier: string): unknown {
      if (specifier === "react") return hooks;
      if (specifier === "react/jsx-runtime") return { jsx: h.jsx, jsxs: h.jsx, Fragment: h.Fragment };
      if (specifier === "lucide-react") return icons;
      if (specifier === "@/lib/operatorApi") return load("operator");
      if (specifier === "@/lib/api") return load("api");
      if (specifier === "@/lib/serverAuth") return load("auth");
      if (specifier === "@/lib/authSignOut") return { isSignOutPending: () => false, getSignOutRevision: () => 0 };
      if (specifier === "@/lib/supabase") return { hasSupabaseFrontendEnv: true, supabase: { auth: {
        async getSession() {
          const gate = deferred<void>(); lookups.push(gate);
          if (options.holdSdk) await gate.promise;
          return { error: null, data: { session: sdkActor ? { user: { id: sdkActor }, access_token: `synthetic-token-${sdkActor}` } : null } };
        },
      } } };
      if (specifier === "./OperatorBookingForm") return { OperatorBookingForm };
      if (specifier.endsWith("operator-lead-search-contracts")) return contracts;
      if (specifier.endsWith("operator-contracts")) return prices;
      if (specifier.endsWith(".css")) return {};
      assert.fail(`Unexpected dependency; execute its actual module explicitly: ${specifier}`);
    }
    new Script(code[name]!, { filename: `${name}.search-fixture.cjs` }).runInNewContext({
      exports, require, window, document, Error, Date, Intl, Headers, Response, AbortController, DOMException, URL, URLSearchParams,
      fetch(url: string, init: RequestInit) {
        const parsed = new URL(url, "https://synthetic.invalid");
        const reading = init.method === "POST";
        assert.equal(parsed.pathname, reading ? "/api/crm/operator-lead-search" : "/api/crm/operator-leads");
        assert.equal(init.method, reading ? "POST" : "PATCH"); assert.equal(init.cache, "no-store");
        assert.equal(Object.hasOwn(init, "expectedUserId"), false); assert.equal(Object.hasOwn(init, "dispatchGuard"), false);
        if (reading) assert.ok(init.signal instanceof AbortSignal, "Reads must pass cancellation through both real transports");
        const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
        const query = reading ? parseOperatorLeadSearchBody(body) as Query | null : null;
        if (reading) {
          assert.equal(url, "/api/crm/operator-lead-search");
          assert.equal(new Headers(init.headers).get("content-type"), "application/json");
          assert.ok(query);
          assert.deepEqual(body, query);
        }
        return new Promise<Response>((resolve, reject) => {
          const request: Pending = {
            url, init, query, body,
            settled: false, bodyReads: 0,
            succeed(data) {
              assert.equal(request.settled, false); request.settled = true;
              resolve(new SyntheticResponse(200, () => { request.bodyReads++; return Promise.resolve({ success: true, data }); }));
            },
            fail(status, error = "synthetic-request-failure") {
              assert.equal(request.settled, false); request.settled = true;
              resolve(new SyntheticResponse(status, () => { request.bodyReads++; return Promise.resolve({ success: false, error }); }));
            },
            reject() { assert.equal(request.settled, false); request.settled = true; reject(new Error("synthetic-unknown-outcome")); },
            bodyLater(data, status = 200) {
              assert.equal(request.settled, false); request.settled = true;
              const body = deferred<unknown>();
              resolve(new SyntheticResponse(status, () => { request.bodyReads++; return body.promise; }));
              return () => body.resolve(status === 200 ? { success: true, data } : { success: false, error: "synthetic-late-failure" });
            },
            headersOnly(status) {
              assert.equal(request.settled, false); request.settled = true;
              resolve(new SyntheticResponse(status, () => { request.bodyReads++; return new Promise<never>(() => {}); }));
            },
          };
          requests.push(request);
        });
      },
    });
    return exports;
  }
  const production = load("component");
  t.after(() => render.dispose());
  function mount(next = A, guard: () => boolean = () => actor === next) {
    actor = next; sdkActor = next;
    render.mount(h.jsx(production.OperatorLeadExplorer, { actorId: next, isSessionCurrent: guard, onAccessDenied: () => denials.push(next) }));
  }
  function labelled(type: string, label: string) {
    const value = render.nodes().find(node => node.type === type && node.props["aria-label"] === label);
    assert.ok(value, `Missing ${type} ${label}`); return value;
  }
  function iconButton(icon: string) {
    const value = render.nodes().find(node => node.type === "button" && h.elements(node).some(child => child.type === icons[icon]));
    assert.ok(value, `Missing ${icon} button`); return value;
  }
  function group(value: Group) {
    const node = render.nodes().find(node => node.type === "button" && node.props["data-lead-group"] === value);
    assert.ok(node, `Missing ${value} group button`); return node;
  }
  function pending(method = "POST") {
    const request = [...requests].reverse().find(item => item.init.method === method && !item.settled);
    assert.ok(request, `Missing pending ${method}`); return request;
  }
  function searchForm() {
    const value = render.nodes().find(node => node.type === "form" && h.elements(node).some(child => child.props["aria-label"] === labels.submit));
    assert.ok(value, "Missing real search form"); return value;
  }
  const contacts = (): string[] => render.content().match(/contact-[a-zA-Z0-9-]+/g) ?? [];
  const booking = () => render.nodes().filter(node => node.props["data-synthetic-booking"]);
  async function reply(marker = "current") { const request = pending(); request.succeed(report(request.query!, marker)); await render.flush(); }
  function opener(name = contacts()[0]!) { return labelled("button", labels.open + name); }
  async function openCard(name = contacts()[0]!) { click(opener(name)); await render.flush(); return name; }
  async function stageEditor() {
    const name = await openCard(); change(labelled("select", labels.stage + name), S1); await render.flush();
    const form = render.nodes().find(node => node.type === "form" && h.elements(node).some(child => child.props["aria-label"] === labels.save + name));
    assert.ok(form, "Missing real stage editor form");
    const button = labelled("button", labels.save + name); assert.equal(button.props.disabled, false);
    return { form, button, select: labelled("select", labels.stage + name), name };
  }
  async function openBooking(name = contacts()[0]!) {
    await openCard(name); click(iconButton("CalendarPlus")); await render.flush();
    assert.equal(booking().length, 1); assert.equal(boundaries.at(-1)!.isSessionCurrent(), true);
    return { boundary: boundaries.at(-1)!, probe: booking()[0]! };
  }
  return { h, render, window, document, requests, lookups, denials, boundaries, boundaryActions, mount, labelled, iconButton, group,
    pending, contacts, booking, searchForm, openCard, stageEditor, openBooking,
    input: () => labelled("input", labels.search), company: () => labelled("select", labels.company),
    mobileGroup: () => labelled("select", labels.mobileGroup),
    rows: () => render.nodes().filter(node => node.props["data-lead-id"]),
    opener,
    groupTexts: () => groups.map(value => h.text(group(value))),
    setActor(next: string | null) { actor = next; sdkActor = next; },
    setSdkActor(next: string | null) { sdkActor = next; },
    async seed(marker = "current") { mount(); await render.flush(); await reply(marker); assert.ok(contacts().length > 0); },
    reply,
    async search(value: string) { change(labelled("input", labels.search), value); await render.flush(); submit(searchForm()); },
  };
}
function click(node: Element) { assert.equal(typeof node.props.onClick, "function"); (node.props.onClick as () => void)(); }
function change(node: Element, value: string) { assert.equal(typeof node.props.onChange, "function"); (node.props.onChange as (e: unknown) => void)({ target: { value } }); }
function submit(node: Element) { assert.equal(typeof node.props.onSubmit, "function"); (node.props.onSubmit as (e: unknown) => void)({ preventDefault() {} }); }

test("fixture sanity: real parser accepts each group, company, search and terminal-page report", async () => {
  await host;
  for (const group of groups) {
    for (const requestId of [null, C, D]) {
      for (const offset of [0, 20]) report({ search: "synthetic %_ query", group, requestId, offset });
    }
  }
});

test("actual explorer publishes the exact parser-approved page with all seven server totals", async t => {
  const r = await runtime(t); await r.seed();
  assert.ok(r.render.nodes().some(node => node.props["aria-label"] === labels.root));
  assert.equal(r.rows().length, 20); assert.equal(r.group("all").props["aria-pressed"], true);
  assert.deepEqual(r.requests[0]!.query, initial);
  assert.equal(new Headers(r.requests[0]!.init.headers).get("Authorization"), `Bearer synthetic-token-${A}`);
  for (const value of groups) assert.ok(r.h.text(r.group(value)).includes(report().totals[value]));
  const totals = r.groupTexts();
  click(r.iconButton("ChevronRight")); await r.render.beforeEffects(); assert.deepEqual(r.contacts(), []);
  await r.render.flush(); assert.equal(r.pending().query!.offset, 20); await r.reply("page20");
  assert.equal(r.rows().length, 20); assert.deepEqual(r.groupTexts(), totals);
  assert.ok(r.contacts().every(name => name.startsWith("contact-page20-")));
  click(r.group("new")); await r.render.beforeEffects(); assert.deepEqual(r.contacts(), []);
  await r.render.flush(); assert.deepEqual(r.pending().query, { ...initial, group: "new" }); await r.reply("new");
  assert.deepEqual(r.groupTexts(), totals); assert.equal(r.group("new").props["aria-pressed"], true);
  click(r.iconButton("ChevronRight")); await r.render.flush(); await r.reply("last");
  assert.equal(r.rows().length, 1); assert.deepEqual(r.groupTexts(), totals);
});

test("initial false parent guard is checked before SDK lookup", async t => {
  const r = await runtime(t, { holdSdk: true }); r.mount(A, () => false); await r.render.flush();
  assert.equal(r.lookups.length, 0); assert.equal(r.requests.length, 0); assert.deepEqual(r.contacts(), []); assert.deepEqual(r.denials, []);
});

test("mobile group select shares exact totals, rejects unknown options and resets the real report page", async t => {
  const r = await runtime(t); await r.seed();
  const options = () => Array.from(r.h.elements(r.mobileGroup())).filter(node => node.type === "option");
  assert.deepEqual(options().map(node => node.props.value), groups);
  for (const node of options()) assert.ok(r.h.text(node).endsWith(report().totals[node.props.value as Group]));
  const calls = r.requests.length, writes = r.render.writes();
  change(r.mobileGroup(), "forged-group"); change(r.mobileGroup(), "all"); await r.render.flush();
  assert.equal(r.requests.length, calls); assert.equal(r.render.writes(), writes);
  for (const group of groups.slice(1)) {
    click(r.iconButton("ChevronRight")); await r.render.flush(); await r.reply("page20");
    change(r.mobileGroup(), group); await r.render.beforeEffects(); assert.deepEqual(r.contacts(), []);
    await r.render.flush(); assert.deepEqual(r.pending().query, { ...initial, group });
    await r.reply("mobile" + group); assert.equal(r.mobileGroup().props.value, group);
    assert.equal(r.group(group).props["aria-pressed"], true);
    for (const node of options()) assert.ok(r.h.text(node).endsWith(report().totals[node.props.value as Group]));
  }
});

test("account change while the actual SDK lookup waits prevents dispatch before React commits", async t => {
  const r = await runtime(t, { holdSdk: true }); r.mount(); await r.render.flush();
  assert.equal(r.lookups.length, 1); r.setActor(B); const writes = r.render.writes();
  r.lookups[0]!.resolve(); await r.render.flush();
  assert.equal(r.requests.length, 0); assert.equal(r.render.writes(), writes); assert.deepEqual(r.denials, []);
});

test("original actor pin refuses a changed SDK identity even while parent still says current", async t => {
  const r = await runtime(t, { holdSdk: true }); r.mount(); await r.render.flush();
  r.setSdkActor(B); r.lookups[0]!.resolve(); await r.render.flush();
  assert.equal(r.requests.length, 0); assert.deepEqual(r.contacts(), []); assert.deepEqual(r.denials, [A]);
});

test("parent becoming false during SDK lookup prevents dispatch without a React render", async t => {
  const r = await runtime(t, { holdSdk: true }); let current = true;
  r.mount(A, () => current); await r.render.flush(); current = false; const writes = r.render.writes();
  r.lookups[0]!.resolve(); await r.render.flush();
  assert.equal(r.requests.length, 0); assert.equal(r.render.writes(), writes); assert.deepEqual(r.denials, []);
});

test("A to B to A retires both old requests despite noncooperative late successes", async t => {
  const r = await runtime(t); r.mount(); await r.render.flush(); const oldA = r.pending();
  r.mount(B); await r.render.beforeEffects(); assert.deepEqual(r.contacts(), []); await r.render.flush(); const oldB = r.pending();
  r.mount(A); await r.render.flush(); await r.reply("freshA");
  assert.equal(oldA.init.signal?.aborted, true); assert.equal(oldB.init.signal?.aborted, true);
  assert.deepEqual(r.requests.map(item => new Headers(item.init.headers).get("Authorization")), [A, B, A].map(value => `Bearer synthetic-token-${value}`));
  const contacts = r.contacts(), writes = r.render.writes();
  oldA.succeed(report(initial, "retiredA")); oldB.succeed(report(initial, "retiredB")); await r.render.flush();
  assert.deepEqual(r.contacts(), contacts); assert.equal(r.render.writes(), writes); assert.deepEqual(r.denials, []);
});

test("A to B to A during delayed SDK lookup dispatches only the fresh A lifetime", async t => {
  const r = await runtime(t, { holdSdk: true }); r.mount(); await r.render.flush();
  r.mount(B); await r.render.flush(); r.mount(A); await r.render.flush();
  assert.equal(r.lookups.length, 3);
  r.lookups[0]!.resolve(); r.lookups[1]!.resolve(); await r.render.flush();
  assert.equal(r.requests.length, 0); assert.deepEqual(r.denials, []);
  r.lookups[2]!.resolve(); await r.render.flush();
  assert.equal(r.requests.length, 1); assert.equal(new Headers(r.pending().init.headers).get("Authorization"), `Bearer synthetic-token-${A}`);
  await r.reply("freshA"); assert.ok(r.contacts().includes("contact-freshA-0"));
});

test("company filtering dispatches the manifested request as a filter, and never a forged company", async t => {
  const r = await runtime(t); await r.seed();
  const companies = r.h.elements(r.company()).filter(node => node.type === "option").map(node => String(node.props.value));
  assert.ok(companies.includes(C)); assert.ok(companies.includes(D));
  const calls = r.requests.length, writes = r.render.writes(), contacts = r.contacts();
  change(r.company(), FOREIGN); await r.render.flush();
  assert.equal(r.render.writes(), writes); assert.equal(r.requests.length, calls); assert.deepEqual(r.contacts(), contacts);
  change(r.company(), D); await r.render.beforeEffects(); assert.deepEqual(r.contacts(), []);
  await r.render.flush(); assert.deepEqual(r.pending().query, { ...initial, requestId: D }); await r.reply("companyD");
  assert.equal(String(r.company().props.value), D); assert.equal(r.rows().length, 20);
});

test("company selector uses all 25 manifested companies, including those absent from the twenty current rows", async t => {
  const r = await runtime(t), companies: Report["companies"] = Array.from({ length: 25 }, (_, index) => ({
    requestId: id(101 + index), displayName: `Synthetic company ${index}`, leadScope: index === 0 ? "assigned" : "clinic",
  }));
  r.mount(); await r.render.flush(); r.pending().succeed(report(initial, "manifest", companies)); await r.render.flush();
  const options = () => Array.from(r.h.elements(r.company()).filter(node => node.type === "option"), node => String(node.props.value));
  assert.deepEqual(options(), ["", ...companies.map(company => company.requestId)]); assert.equal(r.rows().length, 20);
  const last = companies.at(-1)!.requestId;
  assert.equal(report(initial, "manifest", companies).items.some(item => item.requestId === last), false);
  const oldSelect = r.company(), { boundary } = await r.openBooking();
  change(r.company(), last); assert.equal(boundary.isSessionCurrent(), false); await r.render.beforeEffects();
  assert.deepEqual(r.contacts(), []); assert.equal(r.booking().length, 0); await r.render.flush();
  assert.deepEqual(r.pending().query, { ...initial, requestId: last });
  r.pending().succeed(report({ ...initial, requestId: last }, "lastcompany", companies)); await r.render.flush();
  assert.deepEqual(options(), ["", ...companies.map(company => company.requestId)]); assert.equal(r.company().props.value, last);
  const contacts = r.contacts(), calls = r.requests.length, writes = r.render.writes();
  change(oldSelect, C); change(r.company(), FOREIGN); boundary.onAccessDenied(); boundary.onBooked(bookingReceipt()); await r.render.flush();
  assert.equal(r.render.writes(), writes); assert.equal(r.requests.length, calls); assert.deepEqual(r.contacts(), contacts); assert.deepEqual(r.denials, []);
  const current = await r.openBooking(); assert.equal(current.boundary.requestId, last); assert.equal(current.boundary.actorId, A);
});

test("company C to D to C never revives first C selector, card or booking callbacks", async t => {
  const r = await runtime(t); await r.seed(); change(r.company(), C); await r.render.flush(); await r.reply("firstC");
  const oldSelector = r.company(), oldOpener = r.opener(), { boundary, probe } = await r.openBooking();
  change(r.company(), D); assert.equal(boundary.isSessionCurrent(), false);
  let writes = r.render.writes(); change(oldSelector, C); boundary.onAccessDenied(); boundary.onBooked(bookingReceipt()); assert.equal(r.render.writes(), writes);
  await r.render.beforeEffects(); assert.deepEqual(r.contacts(), []); assert.equal(r.booking().length, 0);
  await r.render.flush(); await r.reply("companyD"); change(r.company(), C); await r.render.flush(); await r.reply("freshC");
  assert.equal(r.company().props.value, C); assert.equal(boundary.isSessionCurrent(), false);
  const contacts = r.contacts(), calls = r.requests.length; writes = r.render.writes();
  change(oldSelector, D); click(oldOpener); click(probe); boundary.onBooked(bookingReceipt()); boundary.onAccessDenied(); await r.render.flush();
  assert.equal(r.render.writes(), writes); assert.equal(r.requests.length, calls); assert.deepEqual(r.contacts(), contacts);
  assert.deepEqual(r.denials, []); assert.deepEqual(r.boundaryActions, []); assert.equal(r.booking().length, 0);
  const current = await r.openBooking(); assert.equal(current.boundary.requestId, C); assert.equal(current.boundary.isSessionCurrent(), true);
});

test("a confirmed empty manifest clears old contacts, companies and booking without retaining stale options", async t => {
  const r = await runtime(t); await r.seed(); const { boundary } = await r.openBooking();
  click(r.iconButton("RefreshCw")); await r.render.flush();
  const empty = report(); empty.companies = []; empty.items = []; empty.stageOptions = []; empty.hasMore = false; empty.matched = "0";
  empty.totals = { all: "0", new: "0", in_progress: "0", booked: "0", postponed: "0", lost: "0", other: "0" };
  assert.ok(parseOperatorLeadSearchReport(empty, initial)); r.pending().succeed(empty); await r.render.flush();
  assert.deepEqual(r.contacts(), []); assert.equal(r.booking().length, 0); assert.equal(boundary.isSessionCurrent(), false);
  assert.deepEqual(Array.from(r.h.elements(r.company()).filter(node => node.type === "option"), node => String(node.props.value)), [""]);
  const writes = r.render.writes(), calls = r.requests.length; change(r.company(), C); boundary.onAccessDenied(); await r.render.flush();
  assert.equal(r.render.writes(), writes); assert.equal(r.requests.length, calls); assert.deepEqual(r.denials, []);
});

for (const status of [200, 401, 403, 503]) {
  test(`late old ${status} headers cannot overwrite, alert or revoke a replacement query`, async t => {
    const r = await runtime(t); r.mount(); await r.render.flush(); const old = r.pending();
    await r.search("replacement"); await r.render.flush(); await r.reply("replacement");
    const contacts = r.contacts(), writes = r.render.writes();
    if (status === 200) old.succeed(report(initial, "retired")); else if (status === 503) old.fail(status); else old.headersOnly(status);
    await r.render.flush(); assert.equal(r.render.writes(), writes); assert.deepEqual(r.contacts(), contacts); assert.deepEqual(r.denials, []);
    if (status === 401 || status === 403) assert.equal(old.bodyReads, 0);
  });
}

for (const status of [200, 503]) {
  test(`late old ${status} JSON cannot overwrite or alert on the replacement page`, async t => {
    const r = await runtime(t); r.mount(); await r.render.flush(); const old = r.pending();
    const release = old.bodyLater(report(initial, "retired"), status); await r.render.flush(); assert.equal(old.bodyReads, 1);
    await r.search("replacement"); await r.render.flush(); await r.reply("replacement");
    const contacts = r.contacts(), writes = r.render.writes(); release(); await r.render.flush();
    assert.equal(r.render.writes(), writes); assert.deepEqual(r.contacts(), contacts); assert.deepEqual(r.denials, []);
  });
}

for (const action of ["search", "input", "group", "mobile-group", "company", "page", "open"] as const) {
  for (const transition of ["query", "actor", "aba"] as const) {
    test(`retained ${action} callback cannot act after ${transition} replacement`, async t => {
      const r = await runtime(t); await r.seed();
      const old = action === "search" ? r.searchForm() : action === "input" ? r.input() : action === "group" ? r.group("new")
        : action === "mobile-group" ? r.mobileGroup() : action === "company" ? r.company() : action === "page" ? r.iconButton("ChevronRight") : r.opener();
      const invoke = () => action === "search" ? submit(old) : action === "input" ? change(old, "retired")
        : action === "mobile-group" ? change(old, "lost") : action === "company" ? change(old, D) : click(old);
      if (transition === "query") {
        click(r.group("in_progress")); await r.render.flush(); await r.reply("replacement");
      } else {
        r.mount(B); await r.render.beforeEffects(); const writes = r.render.writes(); invoke(); assert.equal(r.render.writes(), writes);
        await r.render.flush(); await r.reply("actorB");
        if (transition === "aba") { r.mount(A); await r.render.flush(); await r.reply("freshA"); }
      }
      const contacts = r.contacts(), calls = r.requests.length, writes = r.render.writes(); invoke(); await r.render.flush();
      assert.equal(r.render.writes(), writes); assert.equal(r.requests.length, calls); assert.deepEqual(r.contacts(), contacts);
      assert.equal(r.booking().length, 0); assert.deepEqual(r.denials, []);
    });
  }
  test(`retained ${action} callback checks parent false before any React commit`, async t => {
    const r = await runtime(t); let current = true;
    r.mount(A, () => current); await r.render.flush(); await r.reply();
    const old = action === "search" ? r.searchForm() : action === "input" ? r.input() : action === "group" ? r.group("new")
      : action === "mobile-group" ? r.mobileGroup() : action === "company" ? r.company() : action === "page" ? r.iconButton("ChevronRight") : r.opener();
    current = false; const writes = r.render.writes(), calls = r.requests.length, lookups = r.lookups.length;
    if (action === "search") submit(old); else if (action === "input") change(old, "retired");
    else if (action === "mobile-group") change(old, "lost"); else if (action === "company") change(old, D); else click(old);
    assert.equal(r.render.writes(), writes); await r.render.flush();
    assert.equal(r.requests.length, calls); assert.equal(r.lookups.length, lookups); assert.deepEqual(r.denials, []);
  });
}

for (const status of [401, 403]) {
  test(`${status} current headers clear contacts without reading a body and retire retained actions`, async t => {
    const r = await runtime(t); await r.seed(); const oldGroup = r.group("new"), oldCompany = r.company(), oldOpen = r.opener();
    await r.search("denied"); await r.render.flush(); const denied = r.pending(); denied.headersOnly(status); await r.render.flush();
    assert.equal(denied.bodyReads, 0); assert.deepEqual(r.contacts(), []); assert.equal(r.booking().length, 0); assert.deepEqual(r.denials, [A]);
    assert.ok(r.render.nodes().some(node => node.props.role === "alert"));
    const calls = r.requests.length, lookups = r.lookups.length, writes = r.render.writes();
    click(oldGroup); change(oldCompany, D); click(oldOpen); await r.render.flush();
    assert.equal(r.render.writes(), writes); assert.equal(r.requests.length, calls); assert.equal(r.lookups.length, lookups);
    r.mount(A, () => true); await r.render.flush(); assert.deepEqual(r.contacts(), []); assert.equal(r.requests.length, calls); assert.deepEqual(r.denials, [A]);
  });
  test(`${status} delayed headers cannot deny after parent false before React commits`, async t => {
    const r = await runtime(t); let current = true; r.mount(A, () => current); await r.render.flush();
    const old = r.pending(); current = false; const writes = r.render.writes(); old.headersOnly(status); await r.render.flush();
    assert.equal(old.bodyReads, 0); assert.equal(r.render.writes(), writes); assert.deepEqual(r.denials, []); assert.deepEqual(r.contacts(), []);
  });
}

test("same actor false guard before effects clears and permanently expires an already published report", async t => {
  const r = await runtime(t); await r.seed(); const old = r.opener(), calls = r.requests.length;
  r.mount(A, () => false); await r.render.beforeEffects(); assert.deepEqual(r.contacts(), []); assert.equal(r.booking().length, 0);
  const writes = r.render.writes(); click(old); assert.equal(r.render.writes(), writes);
  await r.render.flush(); r.mount(A, () => true); await r.render.flush();
  assert.deepEqual(r.contacts(), []); assert.equal(r.requests.length, calls); assert.deepEqual(r.denials, []);
});

test("parent false while JSON waits prevents publication even before a React commit", async t => {
  const r = await runtime(t); let current = true; r.mount(A, () => current); await r.render.flush();
  const old = r.pending(), release = old.bodyLater(report()); await r.render.flush(); assert.equal(old.bodyReads, 1);
  current = false; const writes = r.render.writes(); release(); await r.render.flush();
  assert.deepEqual(r.contacts(), []); assert.equal(r.render.writes(), writes); assert.deepEqual(r.denials, []);
  current = true; r.mount(A, () => current); await r.render.flush(); assert.deepEqual(r.contacts(), []); assert.equal(r.requests.length, 1);
});

test("actual explorer rejects a report with an injected search echo", async t => {
  const r = await runtime(t); r.mount(); await r.render.flush();
  const valid = report(initial, "wrongquery");
  const value = { ...valid, filters: { ...valid.filters, search: "foreign-query" } };
  assert.equal(parseOperatorLeadSearchReport(value, initial), null);
  r.pending().succeed(value); await r.render.flush(); assert.deepEqual(r.contacts(), []); assert.equal(r.booking().length, 0);
  assert.ok(r.render.nodes().some(node => node.props.role === "alert")); assert.deepEqual(r.denials, []);
});

test("actual explorer sends a name and phone only in JSON and does not display an echoed error", async t => {
  const r = await runtime(t); await r.seed();
  const search = "Synthetic Alice +77015551234";
  await r.search(search); await r.render.flush();
  const read = r.pending();
  assert.equal(read.url, "/api/crm/operator-lead-search");
  assert.deepEqual(read.body, { ...initial, search });
  read.fail(400, search); await r.render.flush();
  const alert = r.render.nodes().find(node => node.props.role === "alert");
  assert.ok(alert);
  assert.doesNotMatch(JSON.stringify(alert.props.children), /Synthetic Alice|77015551234/);
  assert.deepEqual(r.contacts(), []);
});

test("unmount aborts an actual read and ignores its noncooperative late result", async t => {
  const r = await runtime(t); r.mount(); await r.render.flush(); const old = r.pending();
  r.render.mount(null); await r.render.beforeEffects(); assert.equal(old.init.signal?.aborted, true);
  const writes = r.render.writes(); old.succeed(report(initial, "unmounted")); await r.render.flush();
  assert.equal(r.render.writes(), writes); assert.deepEqual(r.contacts(), []); assert.deepEqual(r.denials, []);
});

test("each semantic group, including lost and other, retains all search-wide totals", async t => {
  const r = await runtime(t); await r.seed(); const totals = r.groupTexts();
  for (const value of groups.slice(1)) {
    click(r.group(value)); await r.render.flush(); assert.deepEqual(r.pending().query, { ...initial, group: value }); await r.reply(value);
    assert.equal(r.group(value).props["aria-pressed"], true); assert.deepEqual(r.groupTexts(), totals);
    assert.equal(r.rows().length, Math.min(20, Number(report().totals[value])));
  }
});

test("booking boundary receives the original actor, selected company and exact lead identity", async t => {
  const r = await runtime(t); await r.seed();
  change(r.company(), D); await r.render.flush(); await r.reply("companyD");
  const { boundary, probe } = await r.openBooking();
  assert.equal(boundary.actorId, A); assert.equal(boundary.requestId, D); assert.equal(boundary.leadId, id(1000));
  const calls = r.requests.length; click(probe);
  assert.deepEqual(r.boundaryActions, [`${A}:${D}:${id(1000)}`]);
  assert.equal(r.requests.length, calls, "The booking probe must not implement booking or transport behavior");
});

const receiptNotices = {
  saved: "\u0417\u0430\u043f\u0438\u0441\u044c \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u0430",
  cancelled: "\u0417\u0430\u043f\u0438\u0441\u044c \u043e\u0442\u043c\u0435\u043d\u0435\u043d\u0430",
  noShow: "\u041f\u0430\u0446\u0438\u0435\u043d\u0442 \u043d\u0435 \u043f\u0440\u0438\u0448\u0451\u043b",
  review: "\u0417\u0430\u043f\u0438\u0441\u044c \u0442\u0440\u0435\u0431\u0443\u0435\u0442 \u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0438",
  genericSaved: "\u0417\u0430\u043f\u0438\u0441\u044c \u043f\u0430\u0446\u0438\u0435\u043d\u0442\u0430 \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u0430",
};

test("booking receipt: a valid scheduled payload survives the actual guarded callback with exact details", async t => {
  const r = await runtime(t); await r.seed(); const { boundary } = await r.openBooking(), receipt = bookingReceipt();
  const calls = r.requests.length; boundary.onBooked(receipt);
  assert.equal(boundary.isSessionCurrent(), false); await r.render.beforeEffects();
  assert.deepEqual(r.contacts(), []); assert.equal(r.booking().length, 0);
  const notice = r.render.content();
  assert.ok(notice.includes(receiptNotices.saved)); assert.ok(notice.includes(receipt.doctorName!)); assert.ok(notice.includes(receipt.service!));
  assert.match(notice, /28\.10\.2026.*14:30/);
  assert.ok(notice.includes(prices.formatArrivalPrice(receipt.priceMinor, "KZT")), "The actual production formatter must preserve the int64 price without floating-point rounding");
  assert.ok(notice.includes(prices.operatorBookingStatusLabels.scheduled));
  await r.render.flush(); assert.equal(r.requests.length, calls + 1); assert.deepEqual(r.pending().query, initial);
  assert.equal(r.requests.filter(item => item.init.method === "PATCH").length, 0); await r.reply("afterreceipt"); assert.deepEqual(r.denials, []);
});

const receiptCases: Array<{ name: string; fields: Partial<BookingReceipt>; expected: string }> = [
  { name: "cancelled", fields: { status: "cancelled" }, expected: receiptNotices.cancelled },
  { name: "no_show", fields: { status: "no_show" }, expected: receiptNotices.noShow },
  { name: "cleared time", fields: { startsAt: null }, expected: receiptNotices.review },
  { name: "cleared doctor", fields: { doctorName: null }, expected: receiptNotices.review },
  { name: "blank doctor", fields: { doctorName: "  " }, expected: receiptNotices.review },
  { name: "cleared service", fields: { service: null }, expected: receiptNotices.review },
  { name: "blank service", fields: { service: "  " }, expected: receiptNotices.review },
  { name: "cleared price", fields: { priceMinor: null }, expected: receiptNotices.review },
  { name: "cleared duration", fields: { durationMinutes: null }, expected: receiptNotices.review },
  { name: "cleared status", fields: { status: null }, expected: receiptNotices.review },
  { name: "cancelled incomplete", fields: { status: "cancelled", startsAt: null, doctorName: null, service: null, priceMinor: null, durationMinutes: null }, expected: receiptNotices.cancelled },
  { name: "no_show incomplete", fields: { status: "no_show", startsAt: null, doctorName: null, service: null, priceMinor: null, durationMinutes: null }, expected: receiptNotices.noShow },
];
for (const { name, fields, expected } of receiptCases) {
  test(`booking receipt: ${name} replay never claims a successfully scheduled appointment`, async t => {
    const r = await runtime(t); await r.seed(); const { boundary } = await r.openBooking(), receipt = bookingReceipt(fields);
    const calls = r.requests.length; boundary.onBooked(receipt); await r.render.beforeEffects();
    assert.deepEqual(r.contacts(), []); assert.equal(r.booking().length, 0);
    assert.ok(r.render.content().includes(expected), `The current receipt must show its actual ${name} outcome`);
    assert.equal(r.render.content().includes(receiptNotices.saved), false); assert.equal(r.render.content().includes(receiptNotices.genericSaved), false);
    await r.render.flush(); assert.equal(r.requests.length, calls + 1); await r.reply("afterreceipt");
    const after = r.requests.length; boundary.onBooked(bookingReceipt()); await r.render.flush();
    assert.equal(r.requests.length, after); assert.ok(r.render.content().includes(expected)); assert.deepEqual(r.denials, []);
    assert.equal(r.requests.filter(item => item.init.method === "PATCH").length, 0, "Displaying a replay receipt must not send another booking or stage mutation");
  });
}

test("booking receipt: an absent payload does not claim success or invalidate the current booking", async t => {
  const r = await runtime(t); await r.seed(); const { boundary } = await r.openBooking();
  const contacts = r.contacts(), calls = r.requests.length;
  (boundary.onBooked as (value?: BookingReceipt) => void)(); await r.render.flush();
  assert.deepEqual(r.contacts(), contacts); assert.equal(r.requests.length, calls); assert.equal(r.booking().length, 1); assert.equal(boundary.isSessionCurrent(), true);
  assert.equal(r.render.content().includes(receiptNotices.saved), false); assert.equal(r.render.content().includes(receiptNotices.genericSaved), false);
});

for (const filter of ["search", "group", "company", "page", "refresh"] as const) {
  test(`${filter} replacement clears contacts before effects and synchronously retires the booking boundary`, async t => {
    const r = await runtime(t); await r.seed(); const { boundary, probe } = await r.openBooking();
    if (filter === "search") await r.search("next"); else if (filter === "group") click(r.group("new"));
    else if (filter === "company") change(r.company(), D); else click(r.iconButton(filter === "page" ? "ChevronRight" : "RefreshCw"));
    assert.equal(boundary.isSessionCurrent(), false, "Dispatching a replacement must retire the old booking before React commits");
    const beforeCommit = r.render.writes(); click(probe); boundary.onBooked(bookingReceipt()); boundary.onAccessDenied(); assert.equal(r.render.writes(), beforeCommit);
    await r.render.beforeEffects(); assert.deepEqual(r.contacts(), []); assert.equal(r.booking().length, 0);
    const writes = r.render.writes(); click(probe); boundary.onBooked(bookingReceipt()); boundary.onAccessDenied(); assert.equal(r.render.writes(), writes);
    await r.render.flush(); await r.reply("replacement");
    const contacts = r.contacts(), calls = r.requests.length, after = r.render.writes();
    click(probe); boundary.onBooked(bookingReceipt()); boundary.onAccessDenied(); await r.render.flush();
    assert.equal(r.render.writes(), after); assert.equal(r.requests.length, calls); assert.deepEqual(r.contacts(), contacts);
    assert.deepEqual(r.boundaryActions, []); assert.deepEqual(r.denials, []);
  });
}

test("close and reopen of the same lead never revives old booking callbacks", async t => {
  const r = await runtime(t); await r.seed(); const { boundary, probe } = await r.openBooking();
  click(r.opener()); await r.render.beforeEffects(); assert.equal(boundary.isSessionCurrent(), false); assert.equal(r.booking().length, 0);
  await r.render.flush(); const current = await r.openBooking(); assert.equal(current.boundary.isSessionCurrent(), true);
  const calls = r.requests.length, writes = r.render.writes(); click(probe); boundary.onBooked(bookingReceipt()); boundary.onAccessDenied(); await r.render.flush();
  assert.equal(r.render.writes(), writes); assert.equal(r.requests.length, calls); assert.deepEqual(r.denials, []); assert.deepEqual(r.boundaryActions, []);
  assert.equal(boundary.isSessionCurrent(), false); click(current.probe); assert.equal(r.boundaryActions.length, 1);
});

for (const transition of ["booking-close-reopen", "unmount", "unmount-remount", "aba"] as const) {
  test(`retained booking callbacks stay retired after ${transition}`, async t => {
    const r = await runtime(t); await r.seed(); const old = await r.openBooking();
    if (transition === "booking-close-reopen") {
      click(r.iconButton("CalendarPlus")); assert.equal(old.boundary.isSessionCurrent(), false);
      const writes = r.render.writes();
      click(old.probe); old.boundary.onBooked(bookingReceipt()); old.boundary.onAccessDenied();
      assert.equal(r.render.writes(), writes);
      await r.render.beforeEffects(); assert.equal(r.booking().length, 0); assert.equal(r.opener().props["aria-expanded"], true);
      await r.render.flush(); click(r.iconButton("CalendarPlus")); await r.render.flush();
    } else if (transition === "aba") {
      r.mount(B); await r.render.flush(); await r.reply("actorB");
      r.mount(A); await r.render.flush(); await r.reply("freshA"); await r.openBooking();
    } else {
      r.render.mount(null); await r.render.beforeEffects(); assert.equal(old.boundary.isSessionCurrent(), false);
      await r.render.flush();
      if (transition === "unmount-remount") { r.mount(A); await r.render.flush(); await r.reply("remounted"); await r.openBooking(); }
    }
    const current = transition === "unmount" ? null : { boundary: r.boundaries.at(-1)!, probe: r.booking()[0]! };
    if (current) { assert.notEqual(current.boundary, old.boundary); assert.equal(current.boundary.isSessionCurrent(), true); }
    const calls = r.requests.length, writes = r.render.writes(), content = r.render.content();
    assert.equal(old.boundary.isSessionCurrent(), false);
    click(old.probe); old.boundary.onBooked(bookingReceipt()); old.boundary.onAccessDenied(); await r.render.flush();
    assert.equal(r.render.writes(), writes); assert.equal(r.requests.length, calls); assert.equal(r.render.content(), content);
    assert.deepEqual(r.denials, []); assert.deepEqual(r.boundaryActions, []);
    if (current) {
      assert.equal(current.boundary.isSessionCurrent(), true); click(current.probe);
      assert.deepEqual(r.boundaryActions, [`${A}:${current.boundary.requestId}:${current.boundary.leadId}`]);
    } else { assert.deepEqual(r.contacts(), []); assert.equal(r.booking().length, 0); }
  });
}

test("booking callbacks check a false parent before React commits and never revive when it returns", async t => {
  const r = await runtime(t); let current = true; r.mount(A, () => current); await r.render.flush(); await r.reply();
  const { boundary, probe } = await r.openBooking(); current = false;
  const writes = r.render.writes(), calls = r.requests.length;
  assert.equal(boundary.isSessionCurrent(), false); click(probe); boundary.onBooked(bookingReceipt()); boundary.onAccessDenied();
  assert.equal(r.render.writes(), writes); assert.deepEqual(r.denials, []); assert.deepEqual(r.boundaryActions, []);
  current = true; r.mount(A, () => current); await r.render.flush();
  assert.equal(boundary.isSessionCurrent(), false); assert.equal(r.requests.length, calls); assert.deepEqual(r.contacts(), []);
});

test("current booking denial clears all contacts and forms and notifies its owner only once", async t => {
  const r = await runtime(t); await r.seed(); const { boundary } = await r.openBooking();
  boundary.onAccessDenied(); assert.equal(boundary.isSessionCurrent(), false); await r.render.beforeEffects();
  assert.deepEqual(r.contacts(), []); assert.equal(r.booking().length, 0); assert.deepEqual(r.denials, [A]);
  const calls = r.requests.length, writes = r.render.writes(); boundary.onAccessDenied(); boundary.onBooked(bookingReceipt()); await r.render.flush();
  assert.equal(r.render.writes(), writes); assert.equal(r.requests.length, calls); assert.deepEqual(r.denials, [A]);
});

test("actual stage save pins original actor and request and sends only exact CAS fields once", async t => {
  const r = await runtime(t); await r.seed(); const editor = await r.stageEditor();
  submit(editor.form); submit(editor.form); await r.render.flush();
  const write = r.pending("PATCH");
  assert.equal(r.requests.filter(item => item.init.method === "PATCH").length, 1);
  assert.equal(write.url, `/api/crm/operator-leads?requestId=${C}`);
  assert.deepEqual(write.body, { leadId: id(1000), stageId: S1, expectedStageId: S0, expectedStatus: "in_progress" });
  assert.equal(new Headers(write.init.headers).get("Authorization"), `Bearer synthetic-token-${A}`);
  write.succeed({}); await r.render.beforeEffects(); assert.deepEqual(r.contacts(), []); assert.equal(r.booking().length, 0);
  await r.render.flush(); assert.equal(r.pending().query!.offset, 0); await r.reply("saved");
  const calls = r.requests.length, writes = r.render.writes(); submit(editor.form); change(editor.select, S0); await r.render.flush();
  assert.equal(r.render.writes(), writes); assert.equal(r.requests.length, calls); assert.ok(r.contacts().includes("contact-saved-0"));
});

test("query replacement retires a retained stage editor before React has unmounted it", async t => {
  const r = await runtime(t); await r.seed(); const editor = await r.stageEditor();
  click(r.group("new")); const writes = r.render.writes(); submit(editor.form); change(editor.select, S0);
  assert.equal(r.render.writes(), writes); await r.render.beforeEffects(); assert.deepEqual(r.contacts(), []);
  await r.render.flush(); assert.equal(r.requests.filter(item => item.init.method === "PATCH").length, 0); await r.reply("replacement");
});

for (const transition of ["query", "actor", "aba", "parentfalse", "close-reopen"] as const) {
  test(`old stage editor cannot save or change state after ${transition}`, async t => {
    const r = await runtime(t); let current = true; r.mount(A, () => current); await r.render.flush(); await r.reply();
    const old = await r.stageEditor();
    if (transition === "parentfalse") current = false;
    else if (transition === "close-reopen") { click(r.opener()); await r.render.flush(); await r.openCard(); }
    else if (transition === "query") { click(r.group("new")); await r.render.flush(); await r.reply("replacement"); }
    else {
      r.mount(B); await r.render.beforeEffects(); const writes = r.render.writes(); submit(old.form); change(old.select, S0); assert.equal(r.render.writes(), writes);
      await r.render.flush(); await r.reply("actorB");
      if (transition === "aba") { r.mount(A); await r.render.flush(); await r.reply("freshA"); }
    }
    const contacts = r.contacts(), calls = r.requests.length, writes = r.render.writes(); submit(old.form); change(old.select, S0); await r.render.flush();
    assert.equal(r.render.writes(), writes); assert.equal(r.requests.length, calls); assert.deepEqual(r.contacts(), contacts); assert.deepEqual(r.denials, []);
  });
}

test("stage save checks the original SDK actor before dispatch, not whichever token arrives later", async t => {
  const r = await runtime(t, { holdSdk: true }); r.mount(); await r.render.flush(); r.lookups[0]!.resolve(); await r.render.flush(); await r.reply();
  const editor = await r.stageEditor(); submit(editor.form); await r.render.flush(); assert.equal(r.lookups.length, 2);
  r.setSdkActor(B); r.lookups[1]!.resolve(); await r.render.flush();
  assert.equal(r.requests.filter(item => item.init.method === "PATCH").length, 0); assert.deepEqual(r.denials, [A]); assert.deepEqual(r.contacts(), []);
});

test("parent false during stage token lookup prevents a write before React commits", async t => {
  const r = await runtime(t, { holdSdk: true }); let current = true; r.mount(A, () => current); await r.render.flush();
  r.lookups[0]!.resolve(); await r.render.flush(); await r.reply(); const editor = await r.stageEditor(); submit(editor.form); await r.render.flush();
  current = false; const writes = r.render.writes(); r.lookups[1]!.resolve(); await r.render.flush();
  assert.equal(r.requests.filter(item => item.init.method === "PATCH").length, 0); assert.equal(r.render.writes(), writes); assert.deepEqual(r.denials, []);
});

for (const transition of ["search", "group", "company", "page", "refresh", "close-reopen", "unmount", "aba"] as const) {
  test(`stage waiting for token lookup cannot dispatch after ${transition}`, async t => {
    const r = await runtime(t, { holdSdk: true }); r.mount(); await r.render.flush();
    r.lookups[0]!.resolve(); await r.render.flush(); await r.reply();
    const old = await r.stageEditor(); submit(old.form); await r.render.flush();
    assert.equal(r.lookups.length, 2); assert.equal(r.requests.length, 1);
    const stageLookup = r.lookups[1]!;
    if (transition === "search") await r.search("replacement");
    else if (transition === "group") click(r.group("new"));
    else if (transition === "company") change(r.company(), D);
    else if (transition === "page" || transition === "refresh") click(r.iconButton(transition === "page" ? "ChevronRight" : "RefreshCw"));
    else if (transition === "close-reopen") { click(r.opener()); await r.render.flush(); await r.openCard(); }
    else if (transition === "unmount") r.render.mount(null);
    else { r.mount(B); await r.render.flush(); r.mount(A); }
    await r.render.flush();
    // Publish the replacement without releasing the retired stage's token lookup.
    for (const lookup of r.lookups.slice(2)) lookup.resolve();
    await r.render.flush();
    if (transition !== "close-reopen" && transition !== "unmount") await r.reply("replacement");
    const contacts = r.contacts(), calls = r.requests.length, lookups = r.lookups.length;
    stageLookup.resolve(); await r.render.flush();
    assert.equal(r.requests.filter(item => item.init.method === "PATCH").length, 0);
    assert.equal(r.requests.length, calls); assert.equal(r.lookups.length, lookups); assert.deepEqual(r.contacts(), contacts); assert.deepEqual(r.denials, []);
    assert.equal(r.render.nodes().some(node => node.props.role === "alert"), false);
    const writes = r.render.writes(); submit(old.form); change(old.select, S0); await r.render.flush();
    assert.equal(r.render.writes(), writes); assert.equal(r.requests.length, calls); assert.equal(r.lookups.length, lookups);
    if (transition === "unmount") { assert.deepEqual(r.contacts(), []); assert.equal(r.booking().length, 0); }
    else {
      const name = transition === "close-reopen" ? old.name : await r.openCard();
      assert.equal(r.labelled("select", labels.stage + name).props.disabled, false);
    }
  });
}

test("unresolved stage send remains locked through filter changes and fresh reads until settlement", async t => {
  const r = await runtime(t); await r.seed(); const old = await r.stageEditor(); submit(old.form); await r.render.flush(); const write = r.pending("PATCH");
  click(r.group("new")); await r.render.flush(); await r.reply("replacement"); const name = await r.openCard();
  const select = r.labelled("select", labels.stage + name); assert.equal(select.props.disabled, true);
  const form = r.render.nodes().find(node => node.type === "form" && r.h.elements(node).some(child => child.props["aria-label"] === labels.save + name));
  assert.ok(form); submit(form); submit(old.form); change(select, S1); await r.render.flush();
  assert.equal(r.requests.filter(item => item.init.method === "PATCH").length, 1);
  const contacts = r.contacts(), calls = r.requests.length; write.reject(); await r.render.flush();
  assert.deepEqual(r.contacts(), contacts); assert.equal(r.requests.length, calls);
  assert.equal(r.labelled("select", labels.stage + name).props.disabled, false);
  assert.equal(r.render.nodes().some(node => node.props.role === "alert"), false);
});

for (const outcome of ["network", "503"] as const) {
  test(`unknown ${outcome} stage outcome requests confirmation without replaying the write`, async t => {
    const r = await runtime(t); await r.seed(); const editor = await r.stageEditor(); submit(editor.form); await r.render.flush(); const write = r.pending("PATCH");
    if (outcome === "network") write.reject(); else write.fail(503);
    await r.render.beforeEffects(); assert.deepEqual(r.contacts(), []); assert.equal(r.booking().length, 0);
    await r.render.flush(); assert.equal(r.requests.filter(item => item.init.method === "PATCH").length, 1);
    assert.ok(r.render.nodes().some(node => node.props.role === "alert")); await r.reply("confirmed");
    submit(editor.form); r.window.dispatch("focus"); await r.render.flush(); await r.reply("focused");
    assert.equal(r.requests.filter(item => item.init.method === "PATCH").length, 1); assert.deepEqual(r.denials, []);
  });
}

for (const outcome of [200, 401, 403, 503, "network"] as const) {
  test(`late ${outcome} stage outcome cannot alter or deny a replacement A to B to A lifetime`, async t => {
    const r = await runtime(t); await r.seed(); const editor = await r.stageEditor(); submit(editor.form); await r.render.flush(); const write = r.pending("PATCH");
    r.mount(B); await r.render.flush(); await r.reply("actorB"); r.mount(A); await r.render.flush(); await r.reply("freshA");
    const contacts = r.contacts(), writes = r.render.writes(), calls = r.requests.length;
    if (outcome === "network") write.reject(); else if (outcome === 200) write.succeed({}); else if (outcome === 401 || outcome === 403) write.headersOnly(outcome); else write.fail(outcome);
    await r.render.flush(); assert.equal(r.render.writes(), writes); assert.equal(r.requests.length, calls); assert.deepEqual(r.contacts(), contacts); assert.deepEqual(r.denials, []);
    if (outcome === 401 || outcome === 403) assert.equal(write.bodyReads, 0);
  });
}

for (const outcome of [200, 401, 403, 503, "network"] as const) {
  test(`dispatched stage ${outcome} after unmount cannot write state, deny or replay`, async t => {
    const r = await runtime(t); await r.seed(); const old = await r.stageEditor(); submit(old.form); await r.render.flush();
    const write = r.pending("PATCH"); assert.equal(r.requests.filter(item => item.init.method === "PATCH").length, 1);
    r.render.mount(null); await r.render.beforeEffects(); await r.render.flush();
    const writes = r.render.writes(), calls = r.requests.length, lookups = r.lookups.length;
    submit(old.form); change(old.select, S0);
    if (outcome === "network") write.reject(); else if (outcome === 200) write.succeed({});
    else if (outcome === 401 || outcome === 403) write.headersOnly(outcome); else write.fail(outcome);
    await r.render.flush(); r.window.dispatch("focus"); r.document.dispatch("visibilitychange"); await r.render.flush();
    assert.equal(r.render.writes(), writes); assert.equal(r.requests.length, calls); assert.equal(r.lookups.length, lookups);
    assert.deepEqual(r.contacts(), []); assert.equal(r.booking().length, 0); assert.equal(r.render.content(), ""); assert.deepEqual(r.denials, []);
    assert.equal(r.requests.filter(item => item.init.method === "PATCH").length, 1);
    if (outcome === 401 || outcome === 403) assert.equal(write.bodyReads, 0);
  });
}

for (const status of [200, 503]) {
  test(`late ${status} stage JSON cannot publish notices, reset or overwrite a replacement query`, async t => {
    const r = await runtime(t); await r.seed(); const editor = await r.stageEditor(); submit(editor.form); await r.render.flush();
    const write = r.pending("PATCH"), release = write.bodyLater({}, status); await r.render.flush(); assert.equal(write.bodyReads, 1);
    click(r.group("new")); await r.render.flush(); await r.reply("replacement");
    const contacts = r.contacts(), calls = r.requests.length; release(); await r.render.flush();
    assert.equal(r.requests.length, calls); assert.deepEqual(r.contacts(), contacts); assert.deepEqual(r.denials, []);
    assert.equal(r.render.nodes().some(node => node.props.role === "alert"), false);
    assert.equal(r.render.content().includes("\u0421\u0442\u0430\u0434\u0438\u044f \u0437\u0430\u044f\u0432\u043a\u0438 \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u0430."), false);
  });
}

for (const replacement of ["filter", "page", "refresh"] as const) {
  test(`counterexample: late old stage 403 cannot revoke a published same-actor ${replacement} replacement`, async t => {
    const r = await runtime(t); await r.seed(); const editor = await r.stageEditor();
    submit(editor.form); await r.render.flush(); const oldWrite = r.pending("PATCH");
    if (replacement === "filter") click(r.group("new"));
    else click(r.iconButton(replacement === "page" ? "ChevronRight" : "RefreshCw"));
    await r.render.flush(); await r.reply("replacement");
    const contacts = r.contacts(), counters = r.groupTexts(), calls = r.requests.length;
    assert.ok(contacts.length > 0, "A fresh authorized report must be published before the old denial arrives");
    assert.deepEqual(r.denials, []);
    oldWrite.headersOnly(403); await r.render.flush();
    assert.equal(oldWrite.bodyReads, 0);
    submit(editor.form); await r.render.flush();
    assert.equal(r.requests.length, calls, "A stale denial must not dispatch a retry or another read");
    assert.equal(r.requests.filter(item => item.init.method === "PATCH").length, 1, "The old mutation must never replay");
    assert.deepEqual({ contacts: r.contacts(), counters: r.groupTexts(), parentDenials: r.denials }, { contacts, counters, parentDenials: [] },
      "The original request is retired even though its actor lifetime still matches");
  });
}

test("stage denial scope: an unchanged request still expires its report after the lead card closes", async t => {
  const r = await runtime(t); await r.seed(); const editor = await r.stageEditor();
  submit(editor.form); await r.render.flush(); const oldWrite = r.pending("PATCH");
  click(r.opener(editor.name)); await r.render.flush();
  assert.ok(r.contacts().length > 0); const calls = r.requests.length;
  oldWrite.headersOnly(403); await r.render.flush();
  assert.equal(oldWrite.bodyReads, 0); assert.deepEqual(r.contacts(), []); assert.deepEqual(r.denials, [A]);
  assert.equal(r.requests.length, calls); assert.equal(r.requests.filter(item => item.init.method === "PATCH").length, 1);
});

for (const status of [401, 403]) {
  test(`${status} current stage headers expire the whole explorer without awaiting a body`, async t => {
    const r = await runtime(t); await r.seed(); const editor = await r.stageEditor(); submit(editor.form); await r.render.flush();
    const write = r.pending("PATCH"); write.headersOnly(status); await r.render.flush();
    assert.equal(write.bodyReads, 0); assert.deepEqual(r.contacts(), []); assert.equal(r.booking().length, 0); assert.deepEqual(r.denials, [A]);
    const writes = r.render.writes(), calls = r.requests.length; submit(editor.form); await r.render.flush(); assert.equal(r.render.writes(), writes); assert.equal(r.requests.length, calls);
  });
}

test("negative control: removing only the request identity guard lets an old search replace a later group", async t => {
  const r = await runtime(t, { mutation: "drop-request-key" }); await r.seed(); const oldSearch = r.searchForm();
  click(r.group("new")); await r.render.flush(); await r.reply("replacement"); const calls = r.requests.length;
  submit(oldSearch); await r.render.flush();
  assert.equal(r.requests.length, calls + 1, "The real in-memory mutant must dispatch an old callback");
  assert.deepEqual(r.pending().query, initial); assert.deepEqual(r.contacts(), []);
  assert.throws(() => assert.equal(r.requests.length, calls, "Retired request callback invariant"), assert.AssertionError);
  await r.reply("mutant"); assert.ok(r.contacts().includes("contact-mutant-0"));
});

test("negative control: removing the actual original read actor pin permits a different SDK token", async t => {
  const r = await runtime(t, { holdSdk: true, mutation: "unpin-read-actor" }); r.mount(); await r.render.flush();
  r.setSdkActor(B); r.lookups[0]!.resolve(); await r.render.flush();
  assert.equal(r.requests.length, 1, "The in-memory mutant must really reach fetch");
  assert.equal(new Headers(r.pending().init.headers).get("Authorization"), `Bearer synthetic-token-${B}`);
  assert.throws(() => assert.equal(r.requests.length, 0, "Original actor isolation invariant"), assert.AssertionError);
  await r.reply("wrongactor"); assert.ok(r.contacts().includes("contact-wrongactor-0"));
});

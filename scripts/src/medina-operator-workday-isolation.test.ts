import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Actual workday, hooks, DTO parser, operatorApi, crmFetch and token helper.
// Reconciled host, SDK, fetch and OperatorLeadExplorer boundary are synthetic, not
// React DOM/browser/installed-SDK acceptance. No network or environment is read.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
type Props = Record<string, unknown> & { children?: Child };
type Element = { type: unknown; props: Props; key?: unknown };
type Child = Element | string | number | boolean | null | undefined | Child[];
type Renderer = {
  hooks: Record<string, (...args: any[]) => any>;
  mount(value: Child): void;
  flush(): Promise<void>;
  beforeEffects(): Promise<void>;
  nodes(): Element[];
  content(): string;
  writes(): number;
  dispose(): void;
};
type Host = {
  renderer(): Renderer;
  jsx(type: unknown, props: Props, key?: unknown): Element;
  Fragment: symbol;
  elements(value: Child): Element[];
  text(value: Child): string;
};
type Mutation = "none" | "unpin-actor" | "skip-parser" | "unguarded-explorer";

// Fixture shapes stay test-local; the actual production parser validates them below.
type CompanyFixture = {
  requestId: string; displayName: string; leadScope: "assigned" | "clinic";
  timeZone: string | null; localDate: string | null; dayStart: string | null; dayEnd: string | null;
};
type VisitFixture = {
  appointmentId: string; requestId: string; startsAt: string; endsAt: string | null;
  status: "scheduled" | "confirmed" | "arrived" | "no_show" | "cancelled" | "unknown";
  clientName: string; clientPhone: string; service: string; doctorName: string;
  clinicConfirmedAt: string | null; operatorCheckResult: "confirmed" | "unconfirmed" | "unreachable" | null;
};
type ReportFixture = {
  generatedAt: string; offset: number; companies: CompanyFixture[];
  summary: { availableLeads: string; assignedLeads: string; clinicLeads: string;
    attributedBookings: string; clinicConfirmedArrivals: string; undatedBookings: string; contacts: "not_tracked";
    bookingStatuses: Record<VisitFixture["status"], string> };
  today: { state: "ready"; total: string; actionable: string; items: VisitFixture[]; hasMore: boolean }
    | { state: "unavailable_timezone"; total: null; actionable: null; items: []; hasMore: false };
};

function compile(source: string, fileName: string, mutation: Mutation = "none") {
  let mutations = 0;
  const result = ts.transpileModule(source, {
    fileName, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    transformers: { before: [context => {
      const visit: import("typescript").Visitor = node => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === "env" && ts.isMetaProperty(node.expression)) {
          return ts.factory.createObjectLiteralExpression([
            ts.factory.createPropertyAssignment("BASE_URL", ts.factory.createStringLiteral("/")),
            ts.factory.createPropertyAssignment("VITE_API_BASE_URL", ts.factory.createStringLiteral("")),
          ]);
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          if (mutation === "skip-parser" && node.expression.text === "parseOperatorWorkday") {
            mutations++;
            return node.arguments[0]!;
          }
          if (mutation === "unpin-actor" && node.expression.text === "operatorApi") {
            assert.ok(node.arguments.length >= 6, "Negative control must remove an existing actor pin, not add behavior");
            mutations++;
            return ts.factory.updateCallExpression(node, node.expression, node.typeArguments,
              node.arguments.map((arg, index) => index === 4 ? ts.factory.createIdentifier("undefined") : arg));
          }
        }
        if (mutation === "unguarded-explorer" && ts.isJsxSelfClosingElement(node)
          && ts.isIdentifier(node.tagName) && node.tagName.text === "OperatorLeadExplorer") {
          const properties = node.attributes.properties.map(attribute => {
            if (!ts.isJsxAttribute(attribute) || attribute.name.getText() !== "isSessionCurrent") return attribute;
            mutations++;
            return ts.factory.updateJsxAttribute(attribute, attribute.name,
              ts.factory.createJsxExpression(undefined, ts.factory.createIdentifier("isSessionCurrent")));
          });
          return ts.factory.updateJsxSelfClosingElement(node, node.tagName, node.typeArguments, ts.factory.createJsxAttributes(properties));
        }
        return ts.visitEachChild(node, visit, context);
      };
      return file => ts.visitNode(file, visit) as import("typescript").SourceFile;
    }] },
  });
  assert.deepEqual(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) ?? [], []);
  if (mutation !== "none") assert.equal(mutations, 1, `Exactly one ${mutation} safeguard must be removed in memory`);
  return result.outputText;
}

const host = (async () => {
  // Reuse only the existing reconciled fixture machinery, not its tests or any
  // application logic. Selection is by AST declaration, not fragile line ranges.
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
  assert.equal(names.size, 0, "All reused host declarations must exist");
  const exports = {} as Host;
  new Script(compile(`${selected.map(node => node.getFullText(ast)).join("\n")}\nObject.assign(exports, { renderer, jsx, Fragment, elements, text });`, filename))
    .runInNewContext({ assert, exports });
  return exports;
})();

const componentFile = "artifacts/negis/src/components/operators/OperatorWorkday.tsx";
const productionFiles = {
  component: componentFile,
  operator: "artifacts/negis/src/lib/operatorApi.ts",
  api: "artifacts/negis/src/lib/api.ts",
  auth: "artifacts/negis/src/lib/serverAuth.ts",
};
const sources = (async () => {
  const raw: Record<string, string> = {}, code: Record<string, string> = {};
  const icons = new Set<string>();
  for (const [name, filename] of Object.entries(productionFiles)) {
    raw[name] = await readFile(path.join(root, filename), "utf8");
    code[name] = compile(raw[name], filename);
    const ast = ts.createSourceFile(filename, raw[name], ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    for (const node of ast.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== "lucide-react") continue;
      const bindings = node.importClause?.namedBindings;
      assert.ok(bindings && ts.isNamedImports(bindings));
      bindings.elements.forEach(item => icons.add((item.propertyName ?? item.name).text));
    }
  }
  return { raw, code, icons: [...icons] };
})();
const prices = await import(new URL("../../lib/crm/operator-contracts.ts", import.meta.url).href);
const contracts = await import(new URL("../../lib/crm/operator-workday-contracts.ts", import.meta.url).href);
const { parseOperatorWorkday } = contracts;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = id(1), B = id(2), C = id(101), D = id(102), FOREIGN = id(999);
function company(requestId: string): CompanyFixture {
  return { requestId, displayName: `Company ${requestId}`, leadScope: requestId === C ? "assigned" : "clinic",
    timeZone: "UTC", localDate: "2026-10-28", dayStart: "2026-10-28T00:00:00Z", dayEnd: "2026-10-29T00:00:00Z" };
}
function report(offset = 0, marker = "current", companies = [company(C), company(D)], total = 21): ReportFixture {
  const value: ReportFixture = {
    generatedAt: "2026-10-28T12:00:00.123456Z", offset, companies,
    summary: { availableLeads: companies.length ? "7" : "0", assignedLeads: companies.length ? "3" : "0",
      clinicLeads: companies.length ? "4" : "0", attributedBookings: String(total), clinicConfirmedArrivals: "0", undatedBookings: "0", contacts: "not_tracked",
      bookingStatuses: { scheduled: String(total), confirmed: "0", arrived: "0", no_show: "0", cancelled: "0", unknown: "0" } },
    today: { state: "ready", total: String(total), actionable: String(total), hasMore: total > offset + 20,
      items: Array.from({ length: Math.min(20, Math.max(0, total - offset)) }, (_, index) => ({
        appointmentId: id(1000 + offset + index), requestId: companies[index % companies.length]!.requestId,
        startsAt: `2026-10-28T10:00:${String(offset + index).padStart(2, "0")}Z`, endsAt: null,
        status: "scheduled", clientName: `contact-${marker}-${offset + index}`, clientPhone: `+7000${offset + index}`,
        service: `service-${marker}`, doctorName: "Synthetic doctor", clinicConfirmedAt: null, operatorCheckResult: null,
      })) },
  };
  assert.ok(parseOperatorWorkday(value, offset), "Success fixtures must pass the exact production DTO parser");
  return value;
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
type Pending = {
  url: string; init: RequestInit; settled: boolean; bodyReads: number;
  succeed(data: unknown): void;
  bodyLater(data: unknown): () => void;
  headersOnly(status: number): void;
  fail(status: number): void;
};
class SyntheticResponse extends Response {
  override readonly json: () => Promise<unknown>;
  constructor(status: number, readJson: () => Promise<unknown>) {
    super(null, { status, headers: { "content-type": "application/json" } });
    this.json = readJson;
  }
}
type Boundary = { actorId: string; isSessionCurrent(): boolean; onAccessDenied(): void };
async function runtime(t: TestContext, options: { holdSdk?: boolean; mutation?: Mutation } = {}) {
  const h = await host, source = await sources, render = h.renderer();
  const window = eventTarget(), document = { ...eventTarget(), visibilityState: "visible" };
  const requests: Pending[] = [], lookups: Array<ReturnType<typeof deferred<void>>> = [], denials: string[] = [];
  const boundaries: Boundary[] = [], childActions: string[] = [], renderGuards: boolean[] = [];
  let nextProbe = 0;
  let actor: string | null = A, sdkActor: string | null = A;
  const icons = Object.fromEntries(source.icons.map(name => [name, Symbol(name)]));
  const hooks: Renderer["hooks"] = { ...render.hooks, useId() { return render.hooks.useRef("synthetic-workday-caption").current; } };
  const modules: Record<string, Record<string, unknown>> = {};
  function OperatorLeadExplorer(props: Boundary) {
    assert.deepEqual(Object.keys(props).sort(), ["actorId", "isSessionCurrent", "onAccessDenied"], "Only the independent profile boundary belongs to Workday");
    boundaries.push(props);
    renderGuards.push(props.isSessionCurrent());
    const mounted = hooks.useRef(false), instance = hooks.useRef(null);
    if (instance.current === null) instance.current = ++nextProbe;
    const [draft, setDraft] = hooks.useState("");
    hooks.useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    // Opaque local draft and mount identity only; no lead/filter business logic.
    return h.jsx("output", { "data-synthetic-explorer": true, "data-instance": instance.current, "data-actor": props.actorId,
      children: [h.jsx("input", { "data-boundary-draft": true, value: draft, onChange(event: { target: { value: string } }) {
        if (mounted.current && props.isSessionCurrent()) setDraft(event.target.value);
      } }), h.jsx("button", { "data-boundary-probe": true, onClick() {
        if (mounted.current && props.isSessionCurrent()) childActions.push(`${props.actorId}:${instance.current}`);
      }, children: `synthetic-child:${props.actorId}` })] });
  }
  function load(name: string): Record<string, unknown> {
    if (modules[name]) return modules[name];
    const exports: Record<string, unknown> = {};
    modules[name] = exports;
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
      if (specifier === "./OperatorLeadExplorer") return { OperatorLeadExplorer };
      if (specifier.endsWith("operator-workday-contracts")) return contracts;
      if (specifier.endsWith("operator-contracts")) return prices;
      if (specifier.endsWith(".css")) return {};
      assert.fail(`Unexpected dependency; wire the actual module explicitly: ${specifier}`);
    }
    const code = name === "component" && options.mutation && options.mutation !== "none"
      ? compile(source.raw.component!, componentFile, options.mutation) : source.code[name]!;
    new Script(code, { filename: `${name}.workday-fixture.cjs` }).runInNewContext({
      exports, require, window, document, Error, Date, Intl, Headers, Response, AbortController, DOMException, URL, URLSearchParams,
      fetch(url: string, init: RequestInit) {
        assert.match(url, /^\/api\/crm\/operator-workday\?offset=\d+$/);
        assert.equal(init.method, "GET"); assert.equal(init.cache, "no-store"); assert.equal(init.body, undefined);
        assert.equal(Object.hasOwn(init, "expectedUserId"), false); assert.equal(Object.hasOwn(init, "dispatchGuard"), false);
        assert.ok(init.signal instanceof AbortSignal, "Actual component must pass its cancellation signal through both transports");
        return new Promise<Response>(resolve => {
          const request: Pending = {
            url, init, settled: false, bodyReads: 0,
            succeed(data) {
              assert.equal(request.settled, false); request.settled = true;
              resolve(new SyntheticResponse(200, () => { request.bodyReads++; return Promise.resolve({ success: true, data }); }));
            },
            bodyLater(data) {
              assert.equal(request.settled, false); request.settled = true;
              const body = deferred<{ success: true; data: unknown }>();
              resolve(new SyntheticResponse(200, () => { request.bodyReads++; return body.promise; }));
              return () => body.resolve({ success: true, data });
            },
            headersOnly(status) {
              assert.equal(request.settled, false); request.settled = true;
              resolve(new SyntheticResponse(status, () => { request.bodyReads++; return new Promise<never>(() => {}); }));
            },
            fail(status) {
              assert.equal(request.settled, false); request.settled = true;
              resolve(new SyntheticResponse(status, () => { request.bodyReads++; return Promise.resolve({ success: false, error: "Synthetic Today unavailable" }); }));
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
    render.mount(h.jsx(production.OperatorWorkday, { actorId: next, isSessionCurrent: guard,
      onAccessDenied: () => denials.push(next), onCooperations() {} }));
  }
  function button(icon: string) {
    const result = render.nodes().find(node => node.type === "button" && h.elements(node).some(child => child.type === icons[icon]));
    assert.ok(result, `Missing ${icon} button`); return result;
  }
  function pending() {
    const result = [...requests].reverse().find(request => !request.settled);
    assert.ok(result, "Missing pending workday fetch"); return result;
  }
  function contactText(): string[] { return render.content().match(/contact-[a-zA-Z0-9-]+/g) ?? []; }
  function child() { return render.nodes().filter(node => node.props["data-synthetic-explorer"]); }
  function draft() {
    const input = render.nodes().find(node => node.props["data-boundary-draft"]);
    assert.ok(input, "Missing independently mounted Explorer draft probe"); return input;
  }
  function explorer() {
    assert.equal(child().length, 1);
    assert.equal(boundaries.at(-1)!.isSessionCurrent(), true, "Mounted Explorer needs a live guarded profile scope");
    return { instance: child()[0]!.props["data-instance"], actor: child()[0]!.props["data-actor"], draft: draft().props.value };
  }
  return { render, requests, lookups, denials, boundaries, childActions, renderGuards, window, document, mount, button, pending, contactText, child, draft, explorer,
    probes: () => render.nodes().filter(node => node.props["data-boundary-probe"]),
    setActor(next: string | null) { actor = next; sdkActor = next; },
    setSdkActor(next: string | null) { sdkActor = next; },
    async seed(value = report()) { mount(); await render.flush(); pending().succeed(value); await render.flush(); assert.ok(contactText().length > 0); },
    async reply(value: unknown) { pending().succeed(value); await render.flush(); },
  };
}
function click(node: Element) { assert.equal(typeof node.props.onClick, "function"); (node.props.onClick as () => void)(); }
function change(node: Element, value: string) { (node.props.onChange as (event: unknown) => void)({ target: { value } }); }

test("positive control: actual next-page handler sends an original-actor uncached read and replaces contacts", async t => {
  const r = await runtime(t); await r.seed();
  change(r.draft(), "opaque-independent-draft"); await r.render.flush(); const explorer = r.explorer();
  assert.equal(r.child().length, 1); assert.equal(r.boundaries.at(-1)!.actorId, A);
  assert.equal(r.button("ChevronRight").props.disabled, false);
  click(r.button("ChevronRight")); await r.render.beforeEffects();
  assert.deepEqual(r.contactText(), []); assert.deepEqual(r.explorer(), explorer);
  await r.render.flush();
  assert.equal(r.pending().url, "/api/crm/operator-workday?offset=20");
  assert.equal(new Headers(r.pending().init.headers).get("Authorization"), `Bearer synthetic-token-${A}`);
  await r.reply(report(20, "page20"));
  assert.ok(r.contactText().includes("contact-page20-20")); assert.deepEqual(r.explorer(), explorer);
  assert.equal(r.button("ChevronRight").props.disabled, true); assert.equal(r.button("ChevronLeft").props.disabled, false);
});

test("a valid profile mounts only the independent Explorer boundary before the first Today report", async t => {
  const r = await runtime(t); r.mount(); await r.render.beforeEffects();
  assert.equal(r.renderGuards[0], true, "A valid initial child render must not be mistaken for a retired parent before layout setup");
  assert.deepEqual(r.contactText(), []); assert.equal(r.explorer().actor, A);
  change(r.draft(), "draft-before-today"); await r.render.flush(); const explorer = r.explorer();
  assert.equal(r.requests.length, 1); assert.equal(r.lookups.length, 1);
  assert.equal(r.render.nodes().some(node => node.type === "select"), false, "The parent must not own a company selector");
  await r.reply(report()); assert.deepEqual(r.explorer(), explorer);
});

for (const outcome of ["503", "malformed"] as const) {
  test(`Today ${outcome} after refresh removes only its own contacts and preserves the mounted Explorer draft`, async t => {
    const r = await runtime(t); await r.seed();
    change(r.draft(), "independent-draft"); await r.render.flush();
    const explorer = r.explorer(), boundary = r.boundaries.at(-1)!, probe = r.probes()[0]!;
    click(r.button("RefreshCw")); await r.render.beforeEffects();
    assert.deepEqual(r.contactText(), []); assert.deepEqual(r.explorer(), explorer); assert.equal(boundary.isSessionCurrent(), true);
    await r.render.flush();
    if (outcome === "503") { r.pending().fail(503); await r.render.flush(); }
    else await r.reply(report(20, "wrongpage"));
    assert.deepEqual(r.contactText(), []); assert.deepEqual(r.explorer(), explorer); assert.deepEqual(r.denials, []);
    assert.ok(r.render.nodes().some(node => node.props.role === "alert"));
    click(probe); assert.deepEqual(r.childActions, [`${A}:${explorer.instance}`]);
    click(r.button("RefreshCw")); await r.render.flush(); await r.reply(report(0, "recovered"));
    assert.ok(r.contactText().includes("contact-recovered-0")); assert.deepEqual(r.explorer(), explorer);
  });
}

for (const outcome of ["company-disappeared", "empty-today", "empty-manifest"] as const) {
  test(`Today ${outcome} cannot remove or reset the independently authorized Explorer`, async t => {
    const r = await runtime(t); await r.seed();
    change(r.draft(), "independent-draft"); await r.render.flush();
    const explorer = r.explorer(), boundary = r.boundaries.at(-1)!;
    click(r.button("RefreshCw")); await r.render.flush();
    await r.reply(outcome === "company-disappeared" ? report(0, "survivor", [company(C)])
      : report(0, "empty", outcome === "empty-manifest" ? [] : [company(C), company(D)], 0));
    assert.deepEqual(r.explorer(), explorer); assert.equal(boundary.isSessionCurrent(), true);
    assert.equal(r.render.nodes().some(node => node.type === "select"), false);
    if (outcome === "company-disappeared") assert.ok(r.contactText().includes("contact-survivor-0"));
    else assert.deepEqual(r.contactText(), []);
    assert.deepEqual(r.denials, []);
  });
}

for (const state of ["initial-pending", "page-pending", "refresh-pending", "today-error"] as const) {
  test(`a retained live-profile Explorer denial targets the current ${state} request and expires both siblings once`, async t => {
    const r = await runtime(t);
    if (state === "initial-pending") { r.mount(); await r.render.flush(); } else await r.seed();
    const boundary = r.boundaries.at(-1)!, probe = r.probes()[0]!;
    if (state !== "initial-pending") {
      click(r.button(state === "page-pending" ? "ChevronRight" : "RefreshCw")); await r.render.flush();
    }
    const current = r.pending();
    if (state === "today-error") { current.fail(503); await r.render.flush(); }
    assert.equal(boundary.isSessionCurrent(), true);
    boundary.onAccessDenied(); await r.render.beforeEffects();
    assert.deepEqual(r.contactText(), []); assert.equal(r.child().length, 0);
    assert.equal(current.init.signal?.aborted, true); assert.equal(boundary.isSessionCurrent(), false); assert.deepEqual(r.denials, [A]);
    const writes = r.render.writes(), calls = r.requests.length;
    click(probe); boundary.onAccessDenied(); await r.render.flush();
    assert.equal(r.render.writes(), writes); assert.deepEqual(r.childActions, []); assert.deepEqual(r.denials, [A]); assert.equal(r.requests.length, calls);
    if (!current.settled) { current.succeed(report(state === "page-pending" ? 20 : 0, "denied-late")); await r.render.flush(); }
    assert.deepEqual(r.contactText(), []); assert.equal(r.child().length, 0);
  });
}

test("valid terminal current status and an independent clinic confirmation remain separate", async t => {
  const r = await runtime(t), value = report(20, "terminal");
  value.summary.bookingStatuses = { scheduled: "20", confirmed: "0", arrived: "0", no_show: "0", cancelled: "1", unknown: "0" };
  value.summary.clinicConfirmedArrivals = "1";
  if (value.today.state === "ready") {
    value.today.actionable = "20"; value.today.items[0]!.status = "cancelled";
    value.today.items[0]!.clinicConfirmedAt = "2026-10-28T11:00:00Z";
    value.today.items[0]!.endsAt = "2026-10-28T11:00:00Z";
  }
  assert.ok(parseOperatorWorkday(value, 20));
  await r.seed(); click(r.button("ChevronRight")); await r.render.flush(); await r.reply(value);
  assert.ok(r.contactText().includes("contact-terminal-20"));
  const status = r.render.nodes().find(node => String(node.props.className).split(" ").includes("operator-workday__status--cancelled"));
  assert.ok(status); assert.match(r.render.content(), /Приход подтверждён/);
});

test("missing company timezone makes Today unavailable, not a zero, without inventing agenda contacts", async t => {
  const r = await runtime(t), value = report();
  value.companies[0] = { ...value.companies[0]!, timeZone: null, localDate: null, dayStart: null, dayEnd: null };
  value.today = { state: "unavailable_timezone", total: null, actionable: null, items: [], hasMore: false };
  assert.ok(parseOperatorWorkday(value, 0));
  r.mount(); await r.render.flush(); const explorer = r.explorer(); await r.reply(value);
  assert.deepEqual(r.contactText(), []); assert.deepEqual(r.explorer(), explorer);
  assert.match(r.render.content(), /Записи на сегодня недоступны/);
});

test("Today retains confirmed company-local calendar dates and times independently of the Explorer", async t => {
  const r = await runtime(t), value = report();
  value.companies[0] = { ...value.companies[0]!, timeZone: "Pacific/Honolulu", dayStart: "2026-10-28T10:00:00Z", dayEnd: "2026-10-29T10:00:00Z" };
  assert.ok(parseOperatorWorkday(value, 0));
  await r.seed(value);
  const times = r.render.nodes().filter(node => node.type === "time");
  assert.ok(times.some(node => node.props.dateTime === "2026-10-28"));
  assert.ok(times.some(node => node.props.dateTime === "2026-10-28T10:00:00Z" && node.props.children === "00:00"));
  assert.ok(times.some(node => node.props.dateTime === "2026-10-28T10:00:01Z" && node.props.children === "10:00"));
  assert.match(r.render.content(), /Pacific\/Honolulu/); assert.equal(r.explorer().actor, A);
});

for (const action of ["page", "refresh"] as const) {
  test(`retained old ${action} handler cannot adopt a replacement page or clear its contacts`, async t => {
    const r = await runtime(t); await r.seed();
    const old = r.button(action === "page" ? "ChevronRight" : "RefreshCw"), explorer = r.explorer();
    click(r.button("ChevronRight")); await r.render.flush(); await r.reply(report(20, "replacement"));
    const contacts = r.contactText(), writes = r.render.writes(), calls = r.requests.length;
    click(old);
    await r.render.flush();
    assert.equal(r.render.writes(), writes); assert.equal(r.requests.length, calls);
    assert.deepEqual(r.contactText(), contacts); assert.deepEqual(r.explorer(), explorer);
    assert.equal(r.requests.at(-1)!.url, "/api/crm/operator-workday?offset=20");
  });
}

for (const action of ["page", "refresh"] as const) {
  test(`retained A ${action} handler cannot write before B effects or clear B after publication`, async t => {
    const r = await runtime(t); await r.seed();
    const old = r.button(action === "page" ? "ChevronRight" : "RefreshCw"), oldBoundary = r.boundaries.at(-1)!;
    const invoke = () => click(old);
    r.mount(B); await r.render.beforeEffects();
    let writes = r.render.writes(); invoke(); assert.equal(r.render.writes(), writes);
    assert.deepEqual(r.contactText(), []); assert.equal(oldBoundary.isSessionCurrent(), false); assert.equal(r.explorer().actor, B);
    await r.render.flush();
    assert.equal(new Headers(r.pending().init.headers).get("Authorization"), `Bearer synthetic-token-${B}`);
    await r.reply(report(0, "actorB"));
    const contacts = r.contactText(), calls = r.requests.length; writes = r.render.writes();
    invoke(); await r.render.flush();
    assert.equal(r.render.writes(), writes); assert.equal(r.requests.length, calls);
    assert.deepEqual(r.contactText(), contacts); assert.equal(r.boundaries.at(-1)!.actorId, B);
  });
}

for (const action of ["page", "refresh"] as const) {
  test(`retained original A ${action} handler stays retired after A to B to A on the same page`, async t => {
    const r = await runtime(t); await r.seed();
    const old = r.button(action === "page" ? "ChevronRight" : "RefreshCw");
    r.mount(B); await r.render.flush(); await r.reply(report(0, "actorB"));
    r.mount(A); await r.render.flush(); await r.reply(report(0, "freshA"));
    const contacts = r.contactText(), calls = r.requests.length, writes = r.render.writes();
    click(old);
    await r.render.flush();
    assert.equal(r.render.writes(), writes); assert.equal(r.requests.length, calls);
    assert.deepEqual(r.contactText(), contacts); assert.deepEqual(r.denials, []);
  });
}

for (const replacement of ["B", "A-to-B-to-A"] as const) {
  test(`retired Explorer guards, draft handlers and denial callbacks cannot affect replacement ${replacement}`, async t => {
    const r = await runtime(t); await r.seed();
    change(r.draft(), "original-profile-draft"); await r.render.flush();
    const original = r.explorer(), boundary = r.boundaries.at(-1)!, probe = r.probes()[0]!, draft = r.draft();
    r.mount(B); await r.render.beforeEffects();
    assert.equal(boundary.isSessionCurrent(), false); assert.equal(r.explorer().actor, B);
    assert.notEqual(r.explorer().instance, original.instance); assert.equal(r.explorer().draft, "");
    let writes = r.render.writes();
    boundary.onAccessDenied(); click(probe); change(draft, "retired-draft");
    assert.equal(r.render.writes(), writes); assert.deepEqual(r.denials, []);
    await r.render.flush(); await r.reply(report(0, "actorB"));
    if (replacement === "A-to-B-to-A") {
      const oldB = r.boundaries.at(-1)!;
      r.mount(A); await r.render.beforeEffects();
      assert.equal(boundary.isSessionCurrent(), false); assert.equal(oldB.isSessionCurrent(), false);
      writes = r.render.writes(); boundary.onAccessDenied(); oldB.onAccessDenied();
      assert.equal(r.render.writes(), writes); assert.deepEqual(r.denials, []);
      await r.render.flush(); await r.reply(report(0, "freshA"));
    }
    const explorer = r.explorer(), contacts = r.contactText(), calls = r.requests.length;
    writes = r.render.writes(); boundary.onAccessDenied(); click(probe); change(draft, "retired-again"); await r.render.flush();
    assert.equal(boundary.isSessionCurrent(), false); assert.equal(r.render.writes(), writes); assert.equal(r.requests.length, calls);
    assert.deepEqual(r.explorer(), explorer); assert.deepEqual(r.contactText(), contacts);
    assert.deepEqual(r.childActions, []); assert.deepEqual(r.denials, []);
  });
}

test("original actor is checked before SDK lookup when the initial parent guard is false", async t => {
  const r = await runtime(t, { holdSdk: true });
  r.mount(A, () => false); await r.render.flush();
  assert.equal(r.lookups.length, 0); assert.equal(r.requests.length, 0);
  assert.deepEqual(r.contactText(), []); assert.equal(r.child().length, 0); assert.deepEqual(r.denials, []);
});

test("account change during actual token lookup prevents old-actor dispatch without denying the later actor", async t => {
  const r = await runtime(t, { holdSdk: true }); r.mount(); await r.render.flush();
  assert.equal(r.lookups.length, 1); assert.equal(r.requests.length, 0);
  r.setActor(B); const writes = r.render.writes();
  r.lookups[0]!.resolve(); await r.render.flush();
  assert.equal(r.requests.length, 0); assert.equal(r.render.writes(), writes); assert.deepEqual(r.denials, []);
  r.mount(B); await r.render.flush(); assert.equal(r.lookups.length, 2);
  r.lookups[1]!.resolve(); await r.render.flush();
  assert.equal(new Headers(r.pending().init.headers).get("Authorization"), `Bearer synthetic-token-${B}`);
  await r.reply(report(0, "actorB")); assert.ok(r.contactText().includes("contact-actorB-0"));
});

test("SDK actor mismatch is refused even when the parent has not yet observed the account change", async t => {
  const r = await runtime(t, { holdSdk: true }); r.mount(); await r.render.flush();
  r.setSdkActor(B); r.lookups[0]!.resolve(); await r.render.flush();
  assert.equal(r.requests.length, 0); assert.deepEqual(r.contactText(), []); assert.equal(r.child().length, 0);
  assert.deepEqual(r.denials, [A]); assert.ok(r.render.nodes().some(node => node.props.role === "alert"));
});

test("A to B to A has distinct lifetimes and noncooperative late successes cannot revive either old scope", async t => {
  const r = await runtime(t); r.mount(); await r.render.flush(); const oldA = r.pending();
  r.mount(B); await r.render.beforeEffects(); assert.deepEqual(r.contactText(), []);
  await r.render.flush(); const oldB = r.pending();
  r.mount(A); await r.render.flush(); const freshA = r.pending();
  assert.notEqual(oldA, freshA); assert.equal(oldA.init.signal?.aborted, true); assert.equal(oldB.init.signal?.aborted, true);
  assert.deepEqual(r.requests.map(request => new Headers(request.init.headers).get("Authorization")),
    [A, B, A].map(actor => `Bearer synthetic-token-${actor}`));
  await r.reply(report(0, "freshA")); const contacts = r.contactText(), writes = r.render.writes();
  oldA.succeed(report(0, "retiredA")); oldB.succeed(report(0, "retiredB")); await r.render.flush();
  assert.deepEqual(r.contactText(), contacts); assert.equal(r.render.writes(), writes); assert.deepEqual(r.denials, []);
});

test("a same-actor false guard clears contacts and permanently expires the existing lifetime", async t => {
  const r = await runtime(t); await r.seed(); const calls = r.requests.length, oldBoundary = r.boundaries.at(-1)!;
  const oldProbe = r.probes()[0]!, oldDraft = r.draft();
  r.mount(A, () => false); await r.render.beforeEffects();
  assert.deepEqual(r.contactText(), []); assert.equal(r.child().length, 0); assert.equal(oldBoundary.isSessionCurrent(), false);
  await r.render.flush(); r.mount(A, () => true); await r.render.flush();
  r.window.dispatch("focus"); r.document.dispatch("visibilitychange"); await r.render.flush();
  assert.equal(r.requests.length, calls); assert.deepEqual(r.contactText(), []); assert.equal(r.child().length, 0);
  const writes = r.render.writes(); click(oldProbe); change(oldDraft, "expired"); oldBoundary.onAccessDenied(); await r.render.flush();
  assert.equal(r.render.writes(), writes); assert.deepEqual(r.childActions, []); assert.deepEqual(r.denials, []);
});

test("the passed Explorer guard observes a live parent refusal without a render and cannot revive after the guard returns true", async t => {
  const r = await runtime(t); let current = true;
  r.mount(A, () => current); await r.render.flush(); await r.reply(report());
  const boundary = r.boundaries.at(-1)!;
  current = false; assert.equal(boundary.isSessionCurrent(), false);
  current = true; assert.equal(boundary.isSessionCurrent(), false, "A refused profile lifetime must remain retired");
  r.mount(A, () => true); await r.render.beforeEffects();
  assert.deepEqual(r.contactText(), []); assert.equal(r.child().length, 0);
  const writes = r.render.writes(); boundary.onAccessDenied(); await r.render.flush();
  assert.equal(r.render.writes(), writes); assert.deepEqual(r.denials, []);
});

test("same-actor guard failure while SDK lookup waits prevents dispatch and late state writes", async t => {
  const r = await runtime(t, { holdSdk: true }); r.mount(); await r.render.flush();
  assert.equal(r.lookups.length, 1); r.mount(A, () => false); await r.render.beforeEffects();
  const writes = r.render.writes(); r.lookups[0]!.resolve(); await r.render.flush();
  assert.equal(r.requests.length, 0); assert.equal(r.render.writes(), writes); assert.deepEqual(r.denials, []);
});

test("same-actor guard failure while actual operatorApi awaits JSON permanently retires that body", async t => {
  const r = await runtime(t); r.mount(); await r.render.flush();
  const old = r.pending(), release = old.bodyLater(report(0, "latebody"));
  await r.render.flush(); assert.equal(old.bodyReads, 1, "The real transport must already be waiting for json()");
  r.mount(A, () => false); await r.render.beforeEffects(); const writes = r.render.writes();
  release(); await r.render.flush(); assert.equal(r.render.writes(), writes); assert.deepEqual(r.contactText(), []);
  r.mount(A, () => true); await r.render.flush();
  assert.deepEqual(r.contactText(), []); assert.equal(r.requests.length, 1); assert.deepEqual(r.denials, []);
});

for (const status of [401, 403]) {
  test(`${status} headers without a body expire access, clear the child, and notify exactly once`, async t => {
    const r = await runtime(t); await r.seed();
    const oldNext = r.button("ChevronRight"), oldDraft = r.draft(), oldProbe = r.probes()[0]!, oldRefresh = r.button("RefreshCw"), oldChild = r.boundaries.at(-1)!;
    click(oldRefresh); await r.render.flush(); const denied = r.pending();
    denied.headersOnly(status); await r.render.flush();
    assert.equal(denied.bodyReads, 0, "Access denial must not await a missing response body");
    assert.equal(denied.init.signal?.aborted, true); assert.deepEqual(r.contactText(), []); assert.equal(r.child().length, 0);
    assert.equal(oldChild.isSessionCurrent(), false); assert.deepEqual(r.denials, [A]);
    const renderedDenialAlert = r.render.nodes().some(node => node.props.role === "alert");
    const writes = r.render.writes(), calls = r.requests.length, lookups = r.lookups.length;
    click(oldNext); change(oldDraft, "retired-draft"); click(oldProbe); click(oldRefresh); oldChild.onAccessDenied();
    assert.equal(r.render.writes(), writes, "Retained handlers cannot write to the denied request");
    r.window.dispatch("focus"); r.document.dispatch("visibilitychange");
    await r.render.flush();
    r.mount(A, () => true); await r.render.flush();
    assert.equal(r.requests.length, calls); assert.equal(r.lookups.length, lookups);
    assert.deepEqual(r.childActions, []);
    assert.deepEqual(r.denials, [A]); assert.deepEqual(r.contactText(), []); assert.equal(r.child().length, 0);
    assert.equal(renderedDenialAlert, true, "Denial must render its alert without relying on a later parent render");
  });
}

test("focus immediately hides Today contacts but preserves Explorer; late old-page JSON cannot replace a newly confirmed page", async t => {
  const r = await runtime(t); await r.seed();
  change(r.draft(), "focus-draft"); await r.render.flush(); const explorer = r.explorer();
  click(r.button("ChevronRight")); await r.render.flush();
  const old = r.pending(), release = old.bodyLater(report(20, "latepage"));
  await r.render.flush(); assert.equal(old.bodyReads, 1);
  r.window.dispatch("focus"); await r.render.beforeEffects();
  assert.deepEqual(r.contactText(), []); assert.deepEqual(r.explorer(), explorer); assert.equal(old.init.signal?.aborted, true);
  await r.render.flush(); await r.reply(report(20, "focused"));
  click(r.button("ChevronLeft")); await r.render.flush(); await r.reply(report(0, "newpage"));
  const contacts = r.contactText(), writes = r.render.writes(); release(); await r.render.flush();
  assert.equal(r.render.writes(), writes); assert.deepEqual(r.contactText(), contacts); assert.deepEqual(r.denials, []);
  assert.deepEqual(r.explorer(), explorer);
});

test("visibility restoration revalidates the current page; a hidden event does not dispatch", async t => {
  const r = await runtime(t); await r.seed();
  change(r.draft(), "visibility-draft"); await r.render.flush(); const explorer = r.explorer();
  const calls = r.requests.length; r.document.visibilityState = "hidden"; r.document.dispatch("visibilitychange"); await r.render.flush();
  assert.equal(r.requests.length, calls); assert.ok(r.contactText().length > 0);
  r.document.visibilityState = "visible"; r.document.dispatch("visibilitychange"); await r.render.beforeEffects();
  assert.deepEqual(r.contactText(), []); assert.deepEqual(r.explorer(), explorer);
  await r.render.flush(); assert.equal(r.requests.length, calls + 1); await r.reply(report(0, "visible"));
  assert.ok(r.contactText().includes("contact-visible-0"));
  assert.deepEqual(r.explorer(), explorer);
});

test("retained original focus callback cannot clear or revalidate a later actor", async t => {
  const r = await runtime(t); await r.seed();
  const callbacks = r.window.callbacks("focus"); assert.ok(callbacks.length > 0);
  r.mount(B); await r.render.flush(); await r.reply(report(0, "actorB"));
  const contacts = r.contactText(), calls = r.requests.length, writes = r.render.writes();
  callbacks.forEach(callback => callback()); await r.render.flush();
  assert.equal(r.requests.length, calls); assert.equal(r.render.writes(), writes); assert.deepEqual(r.contactText(), contacts);
});

for (const status of [401, 403]) {
  test(`late old ${status} headers cannot revoke or clear the replacement page`, async t => {
    const r = await runtime(t); r.mount(); await r.render.flush(); const old = r.pending();
    r.window.dispatch("focus"); await r.render.flush(); await r.reply(report());
    click(r.button("ChevronRight")); await r.render.flush(); await r.reply(report(20, "replacement"));
    const contacts = r.contactText(), writes = r.render.writes(); old.headersOnly(status); await r.render.flush();
    assert.equal(old.bodyReads, 0); assert.deepEqual(r.denials, []);
    assert.equal(r.render.writes(), writes); assert.deepEqual(r.contactText(), contacts);
  });
}

for (const invalid of ["wrong-offset", "private-root", "private-company", "foreign-visit", "duplicate-company", "partial-manifest",
  "missing-status-buckets", "extra-status-bucket", "noncanonical-status-count", "status-sum-mismatch",
  "terminal-actionable-contradiction", "today-plus-undated-overflow", "nonpositive-duration", "visible-confirmed-overflow", "visible-status-overflow"] as const) {
  test(`actual workday refuses ${invalid} without Today contacts while preserving the independent profile boundary`, async t => {
    const r = await runtime(t); r.mount(); await r.render.flush();
    change(r.draft(), "independent-draft"); await r.render.flush(); const explorer = r.explorer();
    const value = report() as ReportFixture & Record<string, unknown>;
    if (invalid === "wrong-offset") value.offset = 20;
    if (invalid === "private-root") value.accessToken = "synthetic-forbidden";
    if (invalid === "private-company") Object.assign(value.companies[0]!, { workspaceId: FOREIGN });
    if (invalid === "foreign-visit" && value.today.state === "ready") value.today.items[0]!.requestId = FOREIGN;
    if (invalid === "duplicate-company") value.companies.push(value.companies[0]!);
    if (invalid === "partial-manifest") value.companies.pop();
    if (invalid === "missing-status-buckets") delete (value.summary as Partial<ReportFixture["summary"]>).bookingStatuses;
    if (invalid === "extra-status-bucket") Object.assign(value.summary.bookingStatuses, { deleted: "0" });
    if (invalid === "noncanonical-status-count") value.summary.bookingStatuses.scheduled = "021";
    if (invalid === "status-sum-mismatch") value.summary.bookingStatuses.scheduled = "20";
    if (invalid === "today-plus-undated-overflow") value.summary.undatedBookings = "1";
    if (value.today.state === "ready") {
      if (invalid === "terminal-actionable-contradiction") {
        value.today.items[0]!.status = "cancelled";
        value.summary.bookingStatuses.scheduled = "20"; value.summary.bookingStatuses.cancelled = "1";
      }
      if (invalid === "nonpositive-duration") value.today.items[0]!.endsAt = value.today.items[0]!.startsAt;
      if (invalid === "visible-confirmed-overflow") value.today.items[0]!.clinicConfirmedAt = "2026-10-28T11:00:00Z";
      if (invalid === "visible-status-overflow") {
        value.summary.bookingStatuses.scheduled = "0"; value.summary.bookingStatuses.confirmed = "21";
      }
    }
    assert.equal(parseOperatorWorkday(value, 0), null, "This must genuinely be an invalid DTO");
    await r.reply(value);
    assert.deepEqual(r.contactText(), []); assert.deepEqual(r.explorer(), explorer); assert.deepEqual(r.denials, []);
    assert.ok(r.render.nodes().some(node => node.props.role === "alert"));
  });
}

test("unmount aborts transport and noncooperative late success cannot write or leave focus listeners", async t => {
  const r = await runtime(t); r.mount(); await r.render.flush(); const old = r.pending();
  const boundary = r.boundaries.at(-1)!, probe = r.probes()[0]!, draft = r.draft();
  r.render.mount(null); await r.render.beforeEffects(); assert.equal(old.init.signal?.aborted, true);
  assert.equal(boundary.isSessionCurrent(), false);
  const writes = r.render.writes(); boundary.onAccessDenied(); click(probe); change(draft, "unmounted");
  old.succeed(report(0, "unmounted")); await r.render.flush();
  assert.equal(r.render.writes(), writes); assert.deepEqual(r.contactText(), []); assert.deepEqual(r.denials, []);
  assert.deepEqual(r.childActions, []);
  assert.equal(r.window.callbacks("focus").length, 0); assert.equal(r.document.callbacks("visibilitychange").length, 0);
  r.window.dispatch("focus"); r.document.dispatch("visibilitychange"); await r.render.flush(); assert.equal(r.requests.length, 1);
});

test("negative control: removing only the original actor pin really dispatches another actor's SDK token", async t => {
  const r = await runtime(t, { holdSdk: true, mutation: "unpin-actor" });
  r.mount(); await r.render.flush(); r.setSdkActor(B); r.lookups[0]!.resolve(); await r.render.flush();
  assert.equal(r.requests.length, 1, "The in-memory mutant must actually reach fetch");
  assert.equal(new Headers(r.pending().init.headers).get("Authorization"), `Bearer synthetic-token-${B}`);
  assert.throws(() => assert.equal(r.requests.length, 0, "Original-actor isolation invariant"), assert.AssertionError);
  await r.reply(report(0, "wrongactor")); assert.ok(r.contactText().includes("contact-wrongactor-0"));
});

test("negative control: bypassing only the actual parser really publishes wrong-page contacts", async t => {
  const r = await runtime(t, { mutation: "skip-parser" }); r.mount(); await r.render.flush();
  const value = report(20, "wrongpage");
  assert.equal(parseOperatorWorkday(value, 0), null);
  await r.reply(value);
  assert.ok(r.contactText().includes("contact-wrongpage-20"), "The in-memory mutant must publish the rejected page's contact");
  assert.throws(() => assert.deepEqual(r.contactText(), [], "Page isolation invariant"), assert.AssertionError);
});

test("negative control: replacing only the Explorer lifetime guard with the raw parent guard revives a retired boundary", async t => {
  const r = await runtime(t, { mutation: "unguarded-explorer" }); await r.seed();
  const boundary = r.boundaries.at(-1)!;
  r.mount(A, () => false); await r.render.beforeEffects();
  assert.deepEqual(r.contactText(), []); assert.equal(r.child().length, 0);
  assert.equal(boundary.isSessionCurrent(), true, "The in-memory mutant must actually retain the unsafe original parent guard");
  assert.throws(() => assert.equal(boundary.isSessionCurrent(), false, "Retired Explorer lifetime invariant"), assert.AssertionError);
});

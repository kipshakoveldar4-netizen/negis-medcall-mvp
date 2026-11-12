import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const operatorFile = "artifacts/negis/src/lib/operatorApi.ts";
// Only the target module changes for the red baseline; all callers stay identical.
const sourceRef = process.env.MEDINA_OPERATOR_HEADER_SOURCE_REF;
if (sourceRef !== undefined) {
  assert.match(sourceRef, /^[0-9a-f]{40}$/i, "Baseline must be a full commit SHA");
  assert.equal(execFileSync("git", ["cat-file", "-t", sourceRef], { cwd: root, encoding: "utf8" }).trim(), "commit");
}

type Props = Record<string, unknown> & { children?: Child };
type Element = { type: unknown; props: Props; key?: unknown };
type Child = Element | string | number | boolean | null | undefined | Child[];
type Renderer = {
  hooks: Record<string, unknown>;
  mount(value: Child): void;
  flush(): Promise<void>;
  beforeEffects(): Promise<void>;
  nodes(): Element[];
  content(): string;
  instances(name: string): unknown[];
  dispose(): void;
};
type Pending = {
  url: string;
  method: string;
  origin: string;
  claimed: boolean;
  settled: boolean;
  reply(response: Response): void;
  succeed(data?: unknown): void;
};
type Ui = {
  render: Renderer;
  requests: Pending[];
  storage: Map<string, string>;
  take(origin: string, method?: string): Pending;
  load(name: string): Record<string, unknown>;
  find(predicate: (node: Element) => boolean, within?: Element): Element;
  invoke(node: Element, event?: string, value?: unknown): void;
  section(label: string): Element;
};
type ReadTarget = "booking-doctors" | "booking-services" | "catalog-doctors" | "catalog-services" | "leads" | "arrivals";
type Harness = {
  renderer(): Renderer;
  jsx(type: unknown, props: Props): Element;
  Fragment: symbol;
  icons: Record<string, symbol>;
  elements(child: Child): Element[];
  eventTarget(): object;
  populated(t: TestContext): Promise<Ui & { denied(): number }>;
  assertVisible(ui: Ui, scope: string): void;
  assertProtectedGone(ui: Ui): void;
  startRead(ui: Ui, target: ReadTarget): Promise<Pending>;
  doctors(): unknown;
  services(): unknown;
  labels: Record<string, string>;
};
type Api = {
  operatorApi<T>(path: string, body?: unknown): Promise<T>;
  OperatorApiError: new (message: string, status: number) => Error & { status: number };
};
type Crm = { crmErrorMessage(status: number): string };

function compile(source: string, filename: string, transformers?: import("typescript").CustomTransformers) {
  const output = ts.transpileModule(source, {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    transformers,
  });
  assert.equal(output.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
  return output.outputText;
}

const compiled = (async () => {
  const files = {
    api: operatorFile,
    crm: "artifacts/negis/src/lib/api.ts",
    requests: "artifacts/negis/src/components/operators/OperatorRequests.tsx",
    leads: "artifacts/negis/src/components/operators/OperatorLeads.tsx",
    booking: "artifacts/negis/src/components/operators/OperatorBookingForm.tsx",
    catalog: "artifacts/negis/src/components/operators/OperatorServiceCatalog.tsx",
    arrivals: "artifacts/negis/src/components/operators/OperatorArrivals.tsx",
    attempts: "artifacts/negis/src/lib/operatorBookingAttempt.ts",
    contracts: "lib/crm/operator-contracts.ts",
    commandHook: "artifacts/negis/src/lib/useOperatorCommand.ts",
    commandAttempts: "artifacts/negis/src/lib/operatorCommandAttempt.ts",
    commandRecovery: "artifacts/negis/src/components/operators/OperatorCommandRecovery.tsx",
  };
  const result: Record<string, string> = {};
  for (const [name, filename] of Object.entries(files)) {
    const source = name === "api" && sourceRef !== undefined
      ? execFileSync("git", ["show", `${sourceRef}:${filename}`], { cwd: root, encoding: "utf8" })
      : await readFile(path.join(root, filename), "utf8");
    // Supply empty Vite build configuration, without reading the environment.
    // No transport, error handling, hook or component behavior is rewritten.
    const config: import("typescript").TransformerFactory<import("typescript").SourceFile> = (context) => {
      const visit: import("typescript").Visitor = (node) => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === "env"
          && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword) {
          return context.factory.createObjectLiteralExpression();
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (file) => ts.visitNode(file, visit) as import("typescript").SourceFile;
    };
    result[name] = compile(source, filename, name === "crm" ? { before: [config] } : undefined);
  }
  return result;
})();

const harness = (async () => {
  const filename = "scripts/src/medina-operator-composed-denial.test.ts";
  const source = await readFile(path.join(root, filename), "utf8");
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.ES2022, true);
  // Reuse only the existing host renderer and UI setup/assertion helpers.
  // Its tests, synthetic crmFetch and synthetic error formatter never execute.
  const names = new Set([
    "jsx", "Fragment", "icons", "isElement", "elements", "text", "sameDependencies", "hookDriver", "renderer", "eventTarget",
    "REQUEST_A", "REQUEST_B", "DOCTOR", "LEAD", "ACTOR", "SERVICE", "WORKSPACE", "list", "doctors", "services",
    "leadPhone", "arrivalPhone", "labels", "populated", "assertVisible", "assertProtectedGone", "startRead",
  ]);
  const selected = file.statements.filter((node) => {
    if (ts.isFunctionDeclaration(node)) return node.name !== undefined && names.delete(node.name.text);
    if (ts.isVariableStatement(node)) {
      const declarations = node.declarationList.declarations;
      return declarations.length === 1 && ts.isIdentifier(declarations[0].name) && names.delete(declarations[0].name.text);
    }
    return false;
  });
  assert.equal(names.size, 0, `Missing composed harness helpers: ${[...names].join(", ")}`);
  const exports = {} as Harness;
  const exported = "renderer, jsx, Fragment, icons, elements, eventTarget, populated, assertVisible, assertProtectedGone, startRead, doctors, services, labels";
  new Script(compile(`${selected.map((node) => node.getFullText(file)).join("\n")}\nObject.assign(exports, { ${exported} });`, filename))
    .runInNewContext({ assert, exports, runtime });
  return exports;
})();

async function runtime(t: TestContext): Promise<Ui> {
  const source = await compiled;
  const helpers = await harness;
  const render = helpers.renderer();
  t.after(() => render.dispose());
  const requests: Pending[] = [];
  const storage = new Map<string, string>();
  const modules = new Map<string, Record<string, unknown>>();
  const endpoints: Record<string, string> = {
    OperatorRequests: "operator-inbox", LeadList: "operator-leads", OperatorArrivals: "operator-arrivals",
    OperatorBookingForm: "operator-bookings", BookingFields: "operator-services", ServicePicker: "operator-services",
    OperatorServiceCatalog: "operator-services", Services: "operator-services",
  };
  const globals = {
    Error, AbortController, DOMException, Headers, Response, crypto: { randomUUID },
    window: { ...helpers.eventTarget(), sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    } },
    document: { ...helpers.eventTarget(), visibilityState: "visible" },
    // This is the sole response boundary. No sockets, auth services or DBs.
    fetch(url: string, init: RequestInit) {
      assert.equal(init.cache, "no-store");
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic-header-test-token");
      let resolve!: (response: Response) => void;
      const promise = new Promise<Response>((yes) => { resolve = yes; });
      const endpoint = url.split("?")[0].replace("/api/crm/", "");
      const request: Pending = {
        url, method: init.method ?? "GET", origin: endpoint === "operator-inbox" ? "OperatorRequests" : endpoint,
        claimed: false, settled: false,
        reply(response) { assert.equal(request.settled, false); request.settled = true; resolve(response); },
        succeed(data) { request.reply(reply({ success: true, ...(data === undefined ? {} : { data }) })); },
      };
      requests.push(request);
      return promise;
    },
  };
  function load(name: string): Record<string, unknown> {
    const cached = modules.get(name);
    if (cached) return cached;
    assert.ok(source[name], `Missing runtime module ${name}`);
    const exports: Record<string, unknown> = {};
    modules.set(name, exports);
    const require = (dependency: string): unknown => {
      if (dependency === "react") return render.hooks;
      if (dependency === "react/jsx-runtime") return { jsx: helpers.jsx, jsxs: helpers.jsx, Fragment: helpers.Fragment };
      if (dependency === "lucide-react") return helpers.icons;
      if (dependency === "./OperatorRequests.css") return {};
      if (dependency.endsWith("/crm/operator-contracts")) return load("contracts");
      if (dependency === "@/lib/serverAuth") return { getSupabaseAccessToken: async () => "synthetic-header-test-token" };
      if (dependency === "@/lib/supabase") return { supabase: { auth: { getSession: async () => {
        assert.fail("Unexpected signed-out SDK lookup in header-only fixture");
      } } } };
      const aliases: Record<string, string> = {
        "@/lib/api": "crm", "@/lib/operatorApi": "api", "@/lib/operatorBookingAttempt": "attempts",
        "./OperatorLeads": "leads", "./OperatorBookingForm": "booking", "./OperatorServiceCatalog": "catalog", "./OperatorArrivals": "arrivals",
        "@/lib/useOperatorCommand": "commandHook", "./operatorCommandAttempt": "commandAttempts", "./OperatorCommandRecovery": "commandRecovery",
      };
      if (aliases[dependency]) return load(aliases[dependency]);
      assert.fail(`Unexpected runtime dependency ${dependency}`);
    };
    new Script(source[name], { filename: name }).runInNewContext({ ...globals, exports, require });
    return exports;
  }
  function take(origin: string, method = "GET") {
    const request = requests.find((item) => !item.claimed && item.method === method
      && item.url.split("?")[0] === `/api/crm/${endpoints[origin]}`
      && (endpoints[origin] !== "operator-services" || item.url.includes("doctorId=") === ["Services", "ServicePicker"].includes(origin)));
    assert.ok(request, `Expected ${method} from ${origin}`);
    request.claimed = true;
    return request;
  }
  function find(predicate: (node: Element) => boolean, within?: Element) {
    const matches = (within ? helpers.elements(within.props.children) : render.nodes()).filter(predicate);
    assert.equal(matches.length, 1, `Expected one host control, got ${matches.length}`);
    return matches[0];
  }
  function invoke(node: Element, event = "onClick", value?: unknown) {
    assert.notEqual(node.props.disabled, true);
    assert.equal(typeof node.props[event], "function");
    (node.props[event] as (event: unknown) => void)(value ?? { preventDefault() {} });
  }
  return { render, requests, storage, take, load, find, invoke,
    section: (label) => find((node) => node.type === "section" && node.props["aria-label"] === label) };
}

function reply(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function bodyFixture(t: TestContext, status: number, mode: "held" | "throwing") {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let completed = false;
  let jsonCalls = 0;
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), { status });
  const json = response.json.bind(response);
  Object.defineProperty(response, "json", { value: () => {
    jsonCalls++;
    if (mode === "throwing") throw new Error("Synthetic synchronous json failure");
    return json();
  } });
  function finish(payload: unknown = { success: false, error: "Synthetic body detail" }) {
    if (completed) return;
    completed = true;
    controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
    controller.close();
  }
  t.after(() => finish());
  return { response, finish, jsonCalls: () => jsonCalls, completed: () => completed };
}

function observe(promise: Promise<unknown>) {
  const state = { settled: false, value: undefined as unknown, error: undefined as unknown };
  void promise.then((value) => { state.settled = true; state.value = value; }, (error) => { state.settled = true; state.error = error; });
  return state;
}

async function drain() {
  // Bounded event-loop progress, never a race against the denied body's finish.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function assertDenial(ui: Ui, error: unknown, status: number) {
  const api = ui.load("api") as Api;
  assert.ok(error instanceof api.OperatorApiError);
  assert.equal(error.status, status);
  assert.equal(error.message, (ui.load("crm") as Crm).crmErrorMessage(status));
}

for (const status of [401, 403]) {
  for (const mode of ["held", "throwing"] as const) {
    for (const method of ["GET", "POST"]) {
      test(`headers ${status} ${method} ${mode}: actual transport rejects without invoking json`, async (t) => {
        const ui = await runtime(t);
        const api = ui.load("api") as Api;
        const body = bodyFixture(t, status, mode);
        const state = observe(api.operatorApi("operator-inbox", method === "POST" ? { synthetic: true } : undefined));
        await drain();
        assert.equal(ui.requests.length, 1);
        assert.equal(ui.requests[0].method, method);
        ui.requests[0].reply(body.response);
        await drain();
        assert.equal(body.completed(), false, "Denial must precede body completion");
        assert.equal(state.settled, true, "Headers alone must settle the caller");
        assertDenial(ui, state.error, status);
        assert.equal(body.jsonCalls(), 0, "Denied response json must never be invoked");
        assert.equal(body.response.bodyUsed, false);
        body.finish({ success: true, data: "must not become data" });
        await drain();
        assertDenial(ui, state.error, status);
      });
    }
    for (const target of ["booking-doctors", "booking-services", "catalog-doctors", "catalog-services", "leads", "arrivals"] as const) {
      test(`headers ${status} ${mode} ${target}: real hook/UI remove contact and form before body completion`, async (t) => {
        const helpers = await harness;
        const ui = await helpers.populated(t);
        const pending = await helpers.startRead(ui, target);
        const parents = ui.requests.filter((request) => request.origin === "OperatorRequests").length;
        const body = bodyFixture(t, status, mode);
        pending.reply(body.response);
        await ui.render.beforeEffects();
        assert.equal(body.completed(), false);
        helpers.assertProtectedGone(ui);
        assert.equal(body.jsonCalls(), 0);
        assert.equal(ui.denied(), 1);
        assert.equal(ui.requests.filter((request) => request.origin === "OperatorRequests").length, parents,
          "Observe protected descendant removal before the parent revalidation effect");
        await ui.render.flush();
        assert.equal(ui.take("OperatorRequests").settled, false);
        body.finish({ success: true, data: helpers.doctors() });
        await ui.render.flush();
        helpers.assertProtectedGone(ui);
        assert.equal(ui.denied(), 1, "Late body completion cannot publish data or repeat denial");
      });
    }
  }
  test(`headers ${status}: body authorization_unavailable cannot override status copy`, async (t) => {
    const ui = await runtime(t);
    const state = observe((ui.load("api") as Api).operatorApi("operator-inbox"));
    await drain();
    ui.requests[0].reply(reply({ success: false, code: "authorization_unavailable", error: "Synthetic private detail" }, status));
    await drain();
    assertDenial(ui, state.error, status);
  });
}

const data = { items: [{ id: "synthetic-row" }], hasMore: false };
for (const [label, status, payload, expected] of [
  ["valid DTO", 200, { success: true, data }, data],
  ["empty DTO", 200, { success: true, data: { items: [], hasMore: false } }, { items: [], hasMore: false }],
  ["missing GET data", 200, { success: true }, undefined],
  ["false success", 200, { success: false }, undefined],
  ["conflict detail", 409, { success: false, error: "Synthetic conflict" }, "Synthetic conflict"],
  ["authorization unavailable", 503, { success: false, code: "authorization_unavailable", error: "Synthetic private detail" }, "\u0421\u0435\u0440\u0432\u0438\u0441 \u0432\u0445\u043e\u0434\u0430 \u043d\u0435 \u043e\u0442\u0432\u0435\u0442\u0438\u043b. \u041f\u043e\u043f\u0440\u043e\u0431\u0443\u0439\u0442\u0435 \u043e\u0431\u043d\u043e\u0432\u0438\u0442\u044c \u0434\u0430\u043d\u043d\u044b\u0435 \u0447\u0443\u0442\u044c \u043f\u043e\u0437\u0436\u0435."],
  ["server status wins over success", 500, { success: true, data }, undefined],
] as const) {
  test(`non-denial ${status} ${label}: body parsing and envelope semantics are preserved`, async (t) => {
    const ui = await runtime(t);
    const body = bodyFixture(t, status, "held");
    const api = ui.load("api") as Api;
    const state = observe(api.operatorApi("operator-inbox"));
    await drain();
    ui.requests[0].reply(body.response);
    await drain();
    assert.equal(body.jsonCalls(), 1);
    assert.equal(state.settled, false, "Non-denials must still await their body");
    body.finish(payload);
    await drain();
    assert.equal(state.settled, true);
    if (status === 200 && expected !== undefined) {
      assert.deepEqual(state.value, expected);
      assert.equal(state.error, undefined);
    } else {
      assert.ok(state.error instanceof api.OperatorApiError);
      assert.equal(state.error.status, status);
      assert.equal(state.error.message, expected ?? (ui.load("crm") as Crm).crmErrorMessage(status));
    }
  });
}

for (const raw of ["", "{invalid"]) {
  test(`non-denial malformed/empty JSON ${JSON.stringify(raw)} still rejects safely`, async (t) => {
    const ui = await runtime(t);
    const state = observe((ui.load("api") as Api).operatorApi("operator-inbox"));
    await drain();
    ui.requests[0].reply(new Response(raw, { status: 200 }));
    await drain();
    assertDenial(ui, state.error, 200);
  });
}

for (const status of [200, 409, 503]) {
  test(`non-denial ${status}: real composed siblings stay open and never signal denial`, async (t) => {
    const helpers = await harness;
    const ui = await helpers.populated(t);
    const pending = await helpers.startRead(ui, "catalog-services");
    const count = ui.requests.length;
    const body = bodyFixture(t, status, "held");
    pending.reply(body.response);
    await ui.render.flush();
    assert.equal(body.jsonCalls(), 1);
    assert.equal(ui.denied(), 0);
    ui.section(helpers.labels.booking);
    body.finish(status === 200 ? { success: true, data: helpers.services() } : { success: false, error: "Synthetic retry detail" });
    await ui.render.flush();
    assert.equal(ui.denied(), 0);
    assert.equal(ui.requests.length, count);
    ui.section(helpers.labels.booking);
    assert.ok(ui.render.content().includes("SYNTHETIC_LEAD_PHONE_A"));
    assert.ok(ui.render.nodes().some((node) => node.type === "a" && node.props.href === "tel:SYNTHETIC_ARRIVAL_PHONE_A"));
    if (status === 200) helpers.assertVisible(ui, "A");
  });
}

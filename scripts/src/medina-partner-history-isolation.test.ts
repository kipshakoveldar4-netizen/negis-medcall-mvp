import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Actual component, hooks, parser, operatorApi, crmFetch and token helper.
// The reused reconciled host, SDK sessions, event targets and fetch are synthetic.
// This is not React DOM, installed-SDK or browser acceptance. No network is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const contracts = await import(new URL("../../lib/crm/partner-history-contracts.ts", import.meta.url).href);
const prices = await import(new URL("../../lib/crm/operator-contracts.ts", import.meta.url).href);

type Props = Record<string, unknown> & { children?: Child };
type Element = { type: unknown; props: Props; key?: unknown };
type Child = Element | string | number | boolean | null | undefined | Child[];
type Events = {
  addEventListener(name: string, callback: () => void): void;
  removeEventListener(name: string, callback: () => void): void;
  dispatch(name: string): void;
};
type Renderer = {
  hooks: Record<string, unknown>;
  mount(value: Child): void;
  flush(): Promise<void>;
  beforeEffects(): Promise<void>;
  nodes(): Element[];
  content(): string;
  writes(): number;
  dispose(): void;
};
type Harness = {
  renderer(): Renderer;
  jsx(type: unknown, props: Props, key?: unknown): Element;
  Fragment: symbol;
  elements(value: Child): Element[];
  text(value: Child): string;
};

function compile(source: string, fileName: string) {
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
        return ts.visitEachChild(node, visit, context);
      };
      return file => ts.visitNode(file, visit) as import("typescript").SourceFile;
    }] },
  });
  assert.deepEqual(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) ?? [], []);
  return result.outputText;
}

const sources = (async () => {
  const files = {
    component: "artifacts/negis/src/components/contributors/PartnerHistory.tsx",
    operator: "artifacts/negis/src/lib/operatorApi.ts",
    api: "artifacts/negis/src/lib/api.ts",
    auth: "artifacts/negis/src/lib/serverAuth.ts",
  };
  const code: Record<string, string> = {};
  const icons: string[] = [];
  for (const [name, file] of Object.entries(files)) {
    const source = await readFile(path.join(root, file), "utf8");
    code[name] = compile(source, file);
    if (name !== "component") continue;
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declaration = ast.statements.find(node => ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "lucide-react");
    assert.ok(declaration && ts.isImportDeclaration(declaration));
    const bindings = declaration.importClause?.namedBindings;
    assert.ok(bindings && ts.isNamedImports(bindings));
    icons.push(...bindings.elements.map(node => (node.propertyName ?? node.name).text));
  }
  return { code, icons };
})();

const harness = (async () => {
  // Select fixture machinery only; never import or execute its unrelated tests.
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
  const exports = {} as Harness;
  new Script(compile(`${selected.map(node => node.getFullText(ast)).join("\n")}
    Object.assign(exports, { renderer, jsx, Fragment, elements, text });`, filename))
    .runInNewContext({ assert, exports });
  return exports;
})();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function eventTarget(): Events {
  const target = new EventTarget();
  return {
    addEventListener(name, callback) { target.addEventListener(name, callback); },
    removeEventListener(name, callback) { target.removeEventListener(name, callback); },
    dispatch(name) { target.dispatchEvent(new Event(name)); },
  };
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = id(1), B = id(2);
function history(offset = 0, month: string | null = null, count = 20, amountMinor = "123456789", hasMore = count === 20) {
  const value = {
    state: "ready", generatedAt: "2026-10-28T12:00:00.123456Z", offset, month, hasMore,
    items: Array.from({ length: count }, (_, index) => ({
      id: id(100 + offset + index), kind: "first_payment",
      occurredAt: `${month ?? "2026-10"}-20T12:00:${String(59 - index).padStart(2, "0")}Z`,
      amountMinor, currency: "KZT",
    })),
  };
  assert.ok(contracts.parsePartnerHistory(value, { offset, month }), "Success fixtures must pass the actual parser");
  return value;
}

type Pending = {
  url: string;
  init: RequestInit;
  settled: boolean;
  bodyReads: number;
  succeed(data: unknown): void;
  bodyLater(data: unknown): () => void;
  headersOnly(status: number): void;
};

class SyntheticResponse extends Response {
  override readonly json: () => Promise<unknown>;

  constructor(status: number, readJson: () => Promise<unknown>) {
    super(null, { status, headers: { "content-type": "application/json" } });
    this.json = readJson;
  }
}

async function runtime(t: TestContext, options: { holdSdk?: boolean } = {}) {
  const host = await harness, source = await sources, render = host.renderer();
  const window = eventTarget();
  const document = { ...eventTarget(), visibilityState: "visible" };
  const requests: Pending[] = [], lookups: Array<ReturnType<typeof deferred<void>>> = [], denials: string[] = [];
  let actor: string | null = A, sdkActor: string | null = A;
  const icons = Object.fromEntries(source.icons.map(name => [name, Symbol(name)]));
  const hooks = { ...render.hooks, useId() {
    return (render.hooks.useRef as (value: string) => { current: string })("synthetic-history-caption").current;
  } };
  const modules: Record<string, Record<string, unknown>> = {};
  function load(name: string): Record<string, unknown> {
    if (modules[name]) return modules[name];
    const exports: Record<string, unknown> = {};
    modules[name] = exports;
    const require = (specifier: string): unknown => {
      if (specifier === "react") return hooks;
      if (specifier === "react/jsx-runtime") return { jsx: host.jsx, jsxs: host.jsx, Fragment: host.Fragment };
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
      if (specifier.endsWith("partner-history-contracts")) return contracts;
      if (specifier.endsWith("operator-contracts")) return prices;
      if (specifier === "./PartnerHistory.css") return {};
      assert.fail(`Unexpected dependency: ${specifier}`);
    };
    new Script(source.code[name]!, { filename: `${name}.history-fixture.cjs` }).runInNewContext({
      exports, require, window, document, Error, Date, Intl, Headers, Response, AbortController, DOMException, URL, URLSearchParams,
      fetch(url: string, init: RequestInit) {
        assert.match(url, /^\/api\/crm\/partner-history\?offset=\d+(?:&month=\d{4}-\d{2})?$/);
        assert.equal(init.method, "GET"); assert.equal(init.cache, "no-store"); assert.equal(init.body, undefined);
        assert.equal(Object.hasOwn(init, "expectedUserId"), false);
        assert.equal(Object.hasOwn(init, "dispatchGuard"), false);
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
    render.mount(host.jsx(production.PartnerHistory, { userId: next, isActorCurrent: guard, onAccessDenied: () => denials.push(next) }));
  }
  function button(icon: string) {
    const result = render.nodes().find(node => node.type === "button" && host.elements(node).some(child => child.type === icons[icon]));
    assert.ok(result, `Missing ${icon} button`); return result;
  }
  function monthInput() {
    const result = render.nodes().find(node => node.type === "input" && node.props.type === "month");
    assert.ok(result, "Missing month filter"); return result;
  }
  function pending() {
    const result = [...requests].reverse().find(request => !request.settled);
    assert.ok(result, "Missing pending fetch"); return result;
  }
  function money() { return render.nodes().filter(node => node.type === "td" && String(node.props.className).split(" ").includes("ph-amount")); }
  return {
    render, requests, lookups, denials, window, document, mount, button, monthInput, pending, money,
    moneyText: () => money().map(host.text),
    setActor(next: string | null) { actor = next; sdkActor = next; },
    setSdkActor(next: string | null) { sdkActor = next; },
    async seed(value = history()) { mount(); await render.flush(); pending().succeed(value); await render.flush(); assert.equal(money().length, value.items.length); },
    async reply(value: unknown) { pending().succeed(value); await render.flush(); },
  };
}

function click(node: Element) { assert.equal(typeof node.props.onClick, "function"); (node.props.onClick as () => void)(); }
function change(node: Element, value: string) { (node.props.onChange as (event: unknown) => void)({ target: { value } }); }

test("positive control: actual current next-page handler sends a pinned, uncached read and replaces money", async t => {
  const r = await runtime(t); await r.seed();
  const next = r.button("ChevronRight"); assert.equal(next.props.disabled, false);
  click(next); await r.render.beforeEffects(); assert.equal(r.money().length, 0);
  await r.render.flush();
  assert.equal(r.pending().url, "/api/crm/partner-history?offset=20");
  assert.equal(new Headers(r.pending().init.headers).get("Authorization"), `Bearer synthetic-token-${A}`);
  await r.reply(history(20)); assert.equal(r.money().length, 20);
});

test("retained old pagination handler cannot adopt a replacement page", async t => {
  const r = await runtime(t); await r.seed();
  const oldNext = r.button("ChevronRight");
  click(oldNext); await r.render.flush(); await r.reply(history(20));
  const writes = r.render.writes(), calls = r.requests.length;
  click(oldNext);
  await r.render.flush();
  assert.deepEqual({ writes: r.render.writes() - writes, calls: r.requests.length - calls, money: r.money().length,
    lastUrl: r.requests.at(-1)!.url }, { writes: 0, calls: 0, money: 20, lastUrl: "/api/crm/partner-history?offset=20" },
  "An old page-0 handler must not advance the new page-20 request");
});

test("retained old month handler cannot adopt a replacement filter", async t => {
  const r = await runtime(t); await r.seed();
  const oldMonth = r.monthInput(); change(oldMonth, "2026-10");
  await r.render.flush(); await r.reply(history(0, "2026-10"));
  const writes = r.render.writes(), calls = r.requests.length;
  change(oldMonth, "2026-09");
  await r.render.flush();
  assert.deepEqual({ writes: r.render.writes() - writes, calls: r.requests.length - calls, month: r.monthInput().props.value,
    money: r.money().length, lastUrl: r.requests.at(-1)!.url },
  { writes: 0, calls: 0, month: "2026-10", money: 20, lastUrl: "/api/crm/partner-history?offset=0&month=2026-10" },
  "An old unfiltered handler must not change the current October request");
});

test("retained old manual refresh cannot clear money from a replacement page", async t => {
  const r = await runtime(t); await r.seed();
  const oldRefresh = r.button("RefreshCw");
  click(r.button("ChevronRight")); await r.render.flush(); await r.reply(history(20));
  const writes = r.render.writes(), calls = r.requests.length;
  click(oldRefresh);
  await r.render.flush();
  assert.deepEqual({ writes: r.render.writes() - writes, calls: r.requests.length - calls, money: r.money().length },
    { writes: 0, calls: 0, money: 20 }, "An old page-0 refresh must not clear the current page-20 response");
});

test("account change during the actual SDK lookup prevents the old actor's fetch before dispatch", async t => {
  const r = await runtime(t, { holdSdk: true });
  r.mount(); await r.render.flush();
  assert.equal(r.lookups.length, 1); assert.equal(r.requests.length, 0);
  r.setActor(B);
  const writes = r.render.writes(); r.lookups[0]!.resolve(); await r.render.flush();
  assert.equal(r.requests.length, 0); assert.equal(r.render.writes(), writes); assert.equal(r.money().length, 0);
  assert.deepEqual(r.denials, [], "A retired read must not revoke the later actor");
  r.mount(B); await r.render.flush(); assert.equal(r.lookups.length, 2);
  r.lookups[1]!.resolve(); await r.render.flush();
  assert.equal(new Headers(r.pending().init.headers).get("Authorization"), `Bearer synthetic-token-${B}`);
  await r.reply(history(0, null, 1)); assert.equal(r.money().length, 1);
});

test("SDK account mismatch alone is rejected even before the parent guard observes the account change", async t => {
  const r = await runtime(t, { holdSdk: true });
  r.mount(); await r.render.flush(); r.setSdkActor(B);
  r.lookups[0]!.resolve(); await r.render.flush();
  assert.equal(r.requests.length, 0); assert.equal(r.money().length, 0); assert.deepEqual(r.denials, [A]);
  assert.ok(r.render.nodes().some(node => node.props.role === "alert"));
  assert.equal(r.monthInput().props.disabled, true);
});

test("A to B to A creates distinct lifetimes and late responses cannot revive either retired scope", async t => {
  const r = await runtime(t);
  r.mount(A); await r.render.flush(); const oldA = r.pending();
  r.mount(B); await r.render.beforeEffects(); assert.equal(r.money().length, 0);
  await r.render.flush(); const oldB = r.pending();
  r.mount(A); await r.render.flush(); const freshA = r.pending();
  assert.notEqual(freshA, oldA);
  assert.equal(oldA.init.signal?.aborted, true); assert.equal(oldB.init.signal?.aborted, true);
  assert.deepEqual(r.requests.map(request => new Headers(request.init.headers).get("Authorization")),
    [A, B, A].map(actor => `Bearer synthetic-token-${actor}`));
  await r.reply(history(0, null, 1, "222222222"));
  const money = r.moneyText(), writes = r.render.writes();
  oldA.succeed(history(0, null, 1, "111111111")); oldB.succeed(history(0, null, 1, "333333333"));
  await r.render.flush();
  assert.deepEqual(r.moneyText(), money); assert.equal(r.render.writes(), writes); assert.deepEqual(r.denials, []);
});

for (const action of ["pagination", "month", "refresh"] as const) {
  test(`retained A ${action} handler cannot mutate or clear B before effects or after B publishes`, async t => {
    const r = await runtime(t); await r.seed();
    const old = action === "month" ? r.monthInput() : r.button(action === "pagination" ? "ChevronRight" : "RefreshCw");
    const invoke = () => action === "month" ? change(old, "2026-09") : click(old);
    r.mount(B); await r.render.beforeEffects();
    let writes = r.render.writes(); invoke(); assert.equal(r.render.writes(), writes);
    await r.render.flush();
    assert.equal(new Headers(r.pending().init.headers).get("Authorization"), `Bearer synthetic-token-${B}`);
    await r.reply(history(0, null, 1, "444444444"));
    const money = r.moneyText(), calls = r.requests.length; writes = r.render.writes();
    invoke(); await r.render.flush();
    assert.equal(r.render.writes(), writes); assert.equal(r.requests.length, calls); assert.deepEqual(r.moneyText(), money);
  });
}

for (const action of ["pagination", "month", "refresh"] as const) {
  test(`retained original A ${action} handler stays retired after A to B to A returns to the same page`, async t => {
    const r = await runtime(t); await r.seed();
    const old = action === "month" ? r.monthInput() : r.button(action === "pagination" ? "ChevronRight" : "RefreshCw");
    r.mount(B); await r.render.flush(); await r.reply(history(0));
    r.mount(A); await r.render.flush(); await r.reply(history(0, null, 20, "999999999"));
    const money = r.moneyText(), calls = r.requests.length, writes = r.render.writes();
    if (action === "month") change(old, "2026-09");
    else click(old);
    await r.render.flush();
    assert.equal(r.render.writes(), writes); assert.equal(r.requests.length, calls);
    assert.deepEqual(r.moneyText(), money); assert.deepEqual(r.denials, []);
  });
}

test("a newly false guard for the same actor clears money and permanently expires the existing scope", async t => {
  const r = await runtime(t); await r.seed(); const calls = r.requests.length;
  r.mount(A, () => false); await r.render.beforeEffects();
  assert.equal(r.money().length, 0); assert.equal(r.monthInput().props.disabled, true);
  await r.render.flush(); r.mount(A, () => true); await r.render.flush();
  r.window.dispatch("focus"); r.document.dispatch("visibilitychange"); await r.render.flush();
  assert.equal(r.requests.length, calls); assert.equal(r.money().length, 0); assert.deepEqual(r.denials, []);
});

test("a same-actor false guard while SDK resolution is pending prevents dispatch and late state writes", async t => {
  const r = await runtime(t, { holdSdk: true });
  r.mount(); await r.render.flush(); assert.equal(r.lookups.length, 1);
  r.mount(A, () => false); await r.render.beforeEffects();
  const writes = r.render.writes(); r.lookups[0]!.resolve(); await r.render.flush();
  assert.equal(r.requests.length, 0); assert.equal(r.render.writes(), writes); assert.equal(r.money().length, 0);
});

test("a new same-actor false guard while the actual transport awaits JSON retires the late body permanently", async t => {
  const r = await runtime(t); r.mount(); await r.render.flush();
  const old = r.pending(), releaseBody = old.bodyLater(history(0, null, 1));
  await r.render.flush(); assert.equal(old.bodyReads, 1, "The real operatorApi must already be awaiting this body");
  r.mount(A, () => false); await r.render.beforeEffects();
  const writes = r.render.writes(); releaseBody(); await r.render.flush();
  assert.equal(r.render.writes(), writes); assert.equal(r.money().length, 0); assert.deepEqual(r.denials, []);
  r.mount(A, () => true); await r.render.flush();
  assert.equal(r.money().length, 0); assert.equal(r.monthInput().props.disabled, true); assert.equal(r.requests.length, 1);
});

test("an old unfiltered response cannot publish after a new month and page are confirmed", async t => {
  const r = await runtime(t); r.mount(); await r.render.flush(); const old = r.pending();
  change(r.monthInput(), "2026-10"); await r.render.beforeEffects();
  assert.equal(old.init.signal?.aborted, true); assert.equal(r.money().length, 0);
  await r.render.flush(); await r.reply(history(0, "2026-10"));
  click(r.button("ChevronRight")); await r.render.flush();
  assert.equal(r.pending().url, "/api/crm/partner-history?offset=20&month=2026-10");
  await r.reply(history(20, "2026-10", 1, "555555555"));
  const money = r.moneyText(), writes = r.render.writes();
  old.succeed(history(0, null, 1, "111111111")); await r.render.flush();
  assert.deepEqual(r.moneyText(), money); assert.equal(r.render.writes(), writes);
  assert.equal(r.monthInput().props.value, "2026-10"); assert.equal(r.requests.length, 3);
});

test("a pending old page cannot replace a later month, even when its fetch ignores abort", async t => {
  const r = await runtime(t); await r.seed();
  click(r.button("ChevronRight")); await r.render.flush(); const oldPage = r.pending();
  change(r.monthInput(), "2026-09"); await r.render.flush();
  await r.reply(history(0, "2026-09", 1, "666666666"));
  const money = r.moneyText(), writes = r.render.writes();
  oldPage.succeed(history(20, null, 1, "111111111")); await r.render.flush();
  assert.equal(oldPage.init.signal?.aborted, true);
  assert.deepEqual(r.moneyText(), money); assert.equal(r.render.writes(), writes);
});

for (const trigger of ["focus", "visibility"] as const) {
  test(`${trigger} revalidation clears money before a replacement response or passive cleanup`, async t => {
    const r = await runtime(t); await r.seed();
    const original = r.requests[0]!;
    if (trigger === "focus") r.window.dispatch("focus");
    else r.document.dispatch("visibilitychange");
    await r.render.beforeEffects();
    assert.equal(r.money().length, 0); assert.equal(original.init.signal?.aborted, true);
    assert.equal(r.requests.length, 1, "Replacement fetch waits for the new passive effect");
    await r.render.flush(); assert.equal(r.requests.length, 2);
    await r.reply(history(0, null, 1, "777777777")); assert.equal(r.money().length, 1);
  });
}

for (const trigger of ["focus", "visibility", "manual"] as const) {
  test(`current filtered page still revalidates via ${trigger} after changing month and page`, async t => {
    const r = await runtime(t); await r.seed();
    change(r.monthInput(), "2026-10"); await r.render.flush(); await r.reply(history(0, "2026-10"));
    click(r.button("ChevronRight")); await r.render.flush(); await r.reply(history(20, "2026-10"));
    if (trigger === "manual") click(r.button("RefreshCw"));
    else if (trigger === "focus") r.window.dispatch("focus");
    else r.document.dispatch("visibilitychange");
    await r.render.beforeEffects(); assert.equal(r.money().length, 0);
    await r.render.flush();
    assert.equal(r.requests.length, 4);
    assert.equal(r.pending().url, "/api/crm/partner-history?offset=20&month=2026-10");
    assert.equal(new Headers(r.pending().init.headers).get("Authorization"), `Bearer synthetic-token-${A}`);
    await r.reply(history(20, "2026-10", 1, "888888888")); assert.equal(r.money().length, 1);
  });
}

test("hidden visibility does not revalidate, while focus after an actor change clears and expires money", async t => {
  const r = await runtime(t); await r.seed();
  r.document.visibilityState = "hidden";
  r.document.dispatch("visibilitychange"); await r.render.flush();
  assert.equal(r.money().length, 20); assert.equal(r.requests.length, 1);
  r.setActor(B); r.window.dispatch("focus"); await r.render.beforeEffects();
  assert.equal(r.money().length, 0); await r.render.flush(); assert.equal(r.requests.length, 1);
  r.setActor(A); r.mount(A); await r.render.flush();
  assert.equal(r.money().length, 0); assert.equal(r.monthInput().props.disabled, true);
  assert.equal(r.requests.length, 1);
});

for (const status of [401, 403]) {
  test(`${status} headers without a body clear money, notify once and cannot revive the expired lifetime`, async t => {
    const r = await runtime(t); await r.seed();
    const oldNext = r.button("ChevronRight"), oldMonth = r.monthInput(), oldRefresh = r.button("RefreshCw");
    click(oldRefresh); await r.render.flush(); const rejected = r.pending();
    rejected.headersOnly(status); await r.render.flush();
    assert.equal(rejected.bodyReads, 0, "Authorization headers must be handled without awaiting json()");
    assert.equal(rejected.init.signal?.aborted, true); assert.equal(r.money().length, 0);
    assert.deepEqual(r.denials, [A]); assert.equal(r.monthInput().props.disabled, true);
    assert.ok(r.render.nodes().some(node => node.props.role === "alert"));
    const calls = r.requests.length, lookups = r.lookups.length;
    click(oldNext); change(oldMonth, "2026-09"); click(oldRefresh);
    r.window.dispatch("focus"); r.document.dispatch("visibilitychange");
    r.mount(A, () => true); await r.render.flush();
    assert.equal(r.money().length, 0); assert.equal(r.requests.length, calls); assert.equal(r.lookups.length, lookups);
    assert.deepEqual(r.denials, [A]);
  });
}

test("late old 403 headers cannot revoke or clear a replacement month's confirmed money", async t => {
  const r = await runtime(t); r.mount(); await r.render.flush(); const old = r.pending();
  change(r.monthInput(), "2026-10"); await r.render.flush(); await r.reply(history(0, "2026-10", 1));
  const money = r.moneyText(), writes = r.render.writes();
  old.headersOnly(403); await r.render.flush();
  assert.equal(old.bodyReads, 0); assert.deepEqual(r.denials, []);
  assert.deepEqual(r.moneyText(), money); assert.equal(r.render.writes(), writes);
});

for (const invalid of ["wrong-offset", "wrong-month", "foreign-item-month", "extra-ready-key", "extra-item-key", "short-more-page"] as const) {
  test(`strict parser refuses ${invalid} instead of publishing money on the current filtered page`, async t => {
    const r = await runtime(t); await r.seed();
    change(r.monthInput(), "2026-10"); await r.render.flush(); await r.reply(history(0, "2026-10"));
    click(r.button("ChevronRight")); await r.render.flush();
    const value = history(20, "2026-10", 1);
    if (invalid === "wrong-offset") value.offset = 0;
    if (invalid === "wrong-month") value.month = null;
    if (invalid === "foreign-item-month") value.items[0]!.occurredAt = "2026-09-20T12:00:59Z";
    if (invalid === "short-more-page") value.hasMore = true;
    const payload = invalid === "extra-ready-key" ? { ...value, privateAuth: "synthetic-forbidden-field" }
      : invalid === "extra-item-key" ? { ...value, items: [{ ...value.items[0], workspaceId: B }] } : value;
    await r.reply(payload);
    assert.equal(r.money().length, 0); assert.deepEqual(r.denials, []);
    assert.ok(r.render.nodes().some(node => node.props.role === "alert"));
    assert.equal(r.button("ChevronRight").props.disabled, true); assert.equal(r.button("ChevronLeft").props.disabled, true);
    assert.equal(r.requests.length, 3);
  });
}

test("unmount aborts the pending transport and a noncooperative late response performs no state write", async t => {
  const r = await runtime(t); r.mount(); await r.render.flush(); const old = r.pending();
  r.render.mount(null); await r.render.beforeEffects();
  assert.equal(old.init.signal?.aborted, true);
  const writes = r.render.writes(); old.succeed(history(0, null, 1)); await r.render.flush();
  assert.equal(r.render.writes(), writes); assert.equal(r.money().length, 0); assert.deepEqual(r.denials, []);
  r.window.dispatch("focus"); r.document.dispatch("visibilitychange"); await r.render.flush();
  assert.equal(r.requests.length, 1);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Local, bounded host-tree regression, not React DOM/StrictMode or SDK acceptance.
// The complete production root/Application and pure contracts execute unchanged.
// Auth, operatorApi, Shell and private child boundaries are synthetic. No child
// link/ledger/history/jobs/terms internals, HTTP, database, CSS/layout or real Auth are tested.
// Run: node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-contributor-design-navigation.test.ts
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
type Props = Record<string, unknown> & { children?: Child };
type Element = { type: unknown; props: Props; key?: unknown };
type Child = Element | string | number | boolean | null | undefined | Child[];
type Instance = { id: number; input: Element };
type Renderer = {
  hooks: Record<string, unknown>;
  mount(value: Child): void;
  flush(): Promise<void>;
  beforeEffects(): Promise<void>;
  nodes(): Element[];
  content(): string;
  instances(name: string): Instance[];
  dispose(): void;
};
type Harness = {
  renderer(): Renderer;
  jsx(type: unknown, props: Props, key?: unknown): Element;
  Fragment: symbol;
  elements(child: Child): Element[];
  eventTarget(): {
    addEventListener(name: string, callback: () => void): void;
    removeEventListener(name: string, callback: () => void): void;
    dispatch(name: string): void;
  };
};

function compile(source: string, filename: string) {
  const result = ts.transpileModule(source, {
    fileName: filename, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  assert.deepEqual(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) ?? [], []);
  return result.outputText;
}

const sources = (async () => {
  const filenames = {
    portal: "artifacts/negis/src/pages/ContributorPortal.tsx",
    contracts: "lib/crm/contributor-contracts.ts",
    passwords: "lib/auth/password-rules.ts",
    logins: "lib/auth/staff-logins.ts",
  };
  const code: Record<string, string> = {};
  let portalHash = "";
  let iconNames: string[] = [];
  for (const [name, filename] of Object.entries(filenames)) {
    const source = await readFile(path.join(root, filename), "utf8");
    if (name === "portal") {
      portalHash = createHash("sha256").update(source).digest("hex");
      const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      for (const component of ["ContributorPortal", "Application"]) {
        assert.ok(ast.statements.some(node => ts.isFunctionDeclaration(node) && node.name?.text === component),
          `Execute the actual ${component}, not a copied implementation`);
      }
      const icons = ast.statements.find(node => ts.isImportDeclaration(node)
        && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "lucide-react");
      assert.ok(icons && ts.isImportDeclaration(icons));
      const bindings = icons.importClause?.namedBindings;
      assert.ok(bindings && ts.isNamedImports(bindings));
      iconNames = bindings.elements.map(item => (item.propertyName ?? item.name).text);
    }
    code[name] = compile(source, filename);
  }
  return { code, portalHash, iconNames };
})();

const harness = (async () => {
  const filename = "scripts/src/medina-operator-composed-denial.test.ts";
  const source = await readFile(path.join(root, filename), "utf8");
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  // Same AST fixture reuse as medina-operator-header-denial: never import its
  // tests/runtime or duplicate hooks, reconciliation, effects or cleanup logic.
  const names = new Set([
    "jsx", "Fragment", "isElement", "elements", "text", "sameDependencies", "hookDriver", "renderer",
  ]);
  const selected = ast.statements.filter(node => {
    if (ts.isFunctionDeclaration(node)) return node.name !== undefined && names.delete(node.name.text);
    if (!ts.isVariableStatement(node) || node.declarationList.declarations.length !== 1) return false;
    const declaration = node.declarationList.declarations[0]!;
    return ts.isIdentifier(declaration.name) && names.delete(declaration.name.text);
  });
  assert.equal(names.size, 0, `Missing existing host helpers: ${[...names].join(", ")}`);
  const eventsFile = "scripts/src/medina-operator-profile-races.test.ts";
  const eventsSource = await readFile(path.join(root, eventsFile), "utf8");
  const eventsAst = ts.createSourceFile(eventsFile, eventsSource, ts.ScriptTarget.Latest, true);
  const events = eventsAst.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === "eventTarget");
  assert.equal(events.length, 1, "Reuse the existing dispatchable browser-event fixture");
  const exports = {} as Harness;
  new Script(compile(`${selected.map(node => node.getFullText(ast)).join("\n")}
    ${events[0]!.getFullText(eventsAst)}
    Object.assign(exports, { renderer, jsx, Fragment, elements, eventTarget });`, filename))
    .runInNewContext({ assert, exports });
  return exports;
})();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Session = { user: { id: string } } | null;
const session = (actor: string | null): Session => actor ? { user: { id: actor } } : null;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = id(1), B = id(2), REQUEST = id(90);
type ContributorStatus = "pending" | "approved" | "suspended";
type ContributorProfile = ReturnType<typeof profile>;
function profile(actor = A, partnerStatus: ContributorStatus | null = "approved",
  creatorStatus: ContributorStatus | null = "approved") {
  return { id: actor === A ? id(11) : id(12), revision: id(30), displayName: `Synthetic contributor ${actor === A ? "A" : "B"}`,
    portfolioUrls: [] as string[], partnerStatus, creatorStatus };
}
type Pending = {
  path: string;
  method: string;
  body: unknown;
  actor: string;
  signal: AbortSignal;
  valid(): boolean;
  claimed: boolean;
  settled: boolean;
  succeed(value: unknown): void;
  fail(error: Error): void;
};
type NavigationItem = { id: string; label: string; href?: string };
type TermsOptions = {
  method: "GET" | "POST";
  body?: unknown;
  requestId?: string;
  signal: AbortSignal;
  isCurrent(): boolean;
};

async function runtime(t: TestContext, delayInitialSession = false) {
  const source = await sources, helpers = await harness, render = helpers.renderer();
  const { jsx } = helpers;
  const initial = deferred<{ data: { session: Session }; error: null }>();
  const listeners = new Set<(event: string, value: Session) => void>();
  const requests: Pending[] = [];
  const forbiddenCalls: string[] = [];
  const boundaryRenders: string[] = [];
  let signOutCalls = 0, authReads = 0;
  function forbidden(name: string): never { forbiddenCalls.push(name); assert.fail(`Unexpected external dependency: ${name}`); }
  const globals = {
    Error, AbortController, URL, URLSearchParams, TextEncoder,
    fetch: () => forbidden("fetch"), WebSocket: () => forbidden("WebSocket"),
    window: helpers.eventTarget(), document: { ...helpers.eventTarget(), visibilityState: "visible" },
  };
  function emit(actor: string | null) {
    assert.equal(listeners.size, 1, "Use the production root's auth subscription");
    for (const listener of [...listeners]) listener(actor ? "SIGNED_IN" : "SIGNED_OUT", session(actor));
  }
  const auth = {
    getSession() { authReads++; return initial.promise; },
    onAuthStateChange(callback: (event: string, value: Session) => void) {
      listeners.add(callback);
      return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } };
    },
    async signOut() { signOutCalls++; emit(null); return { error: null }; },
  };
  function operatorApi(route: string, body: unknown, method: string, signal: AbortSignal, actor: string, valid: () => boolean) {
    assert.ok(signal instanceof AbortSignal, "Preserve the production abort signal");
    assert.equal(typeof valid, "function", "Preserve the production actor/operation guard");
    const pending = deferred<unknown>();
    const request: Pending = {
      path: route, body, method, signal, actor, valid, claimed: false, settled: false,
      // Deliberately ignore abort at response time: actual caller guards must
      // reject an already-dispatched response after refresh or an actor change.
      succeed(value) { assert.equal(request.settled, false); request.settled = true; pending.resolve(value); },
      fail(error) { assert.equal(request.settled, false); request.settled = true; pending.reject(error); },
    };
    requests.push(request);
    return pending.promise;
  }
  function PortalShell(props: Props): Child {
    const items = props.items as NavigationItem[];
    return jsx("main", { "data-shell": true, "data-display-name": props.displayName, "data-active-id": props.activeId,
      children: [jsx("h1", { children: props.title as Child }), jsx("span", { children: props.displayName as Child }),
        jsx("nav", { children: items.map(item => item.href
          ? jsx("a", { "data-nav-id": item.id, href: item.href, children: item.label }, item.id)
          : jsx("button", { "data-nav-id": item.id, onClick: () => (props.onNavigate as (id: string) => void)(item.id),
            children: item.label }, item.id)) }),
        jsx("div", { "data-shell-actions": true, children: props.actions as Child }),
        props.onSignOut ? jsx("button", { "data-sign-out": true, onClick: props.onSignOut }) : null,
        props.children],
    });
  }
  function PartnerLedger(_props: Props) { boundaryRenders.push("PartnerLedger"); return jsx("section", { "data-private-panel": "ledger" }); }
  function PartnerHistory(_props: Props) { boundaryRenders.push("PartnerHistory"); return jsx("section", { "data-private-panel": "history" }); }
  function PartnerLink(_props: Props) { boundaryRenders.push("PartnerLink"); return jsx("section", { "data-private-panel": "link" }); }
  function CreatorJobs(_props: Props) { boundaryRenders.push("CreatorJobs"); return jsx("section", { "data-private-panel": "jobs" }); }
  function PartnerTerms(_props: Props) { boundaryRenders.push("PartnerTerms"); return jsx("section", { "data-private-panel": "terms" }); }
  const modules = new Map<string, Record<string, unknown>>();
  function load(name: string): Record<string, unknown> {
    const cached = modules.get(name);
    if (cached) return cached;
    assert.ok(source.code[name], `Missing actual module ${name}`);
    const exports: Record<string, unknown> = {};
    modules.set(name, exports);
    const require = (dependency: string): unknown => {
      if (dependency === "react") return render.hooks;
      if (dependency === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: helpers.Fragment };
      if (dependency === "lucide-react") return Object.fromEntries(source.iconNames.map(icon => [icon, Symbol(icon)]));
      if (dependency === "wouter") return { Link: (props: Props) => jsx("a", props) };
      // Observer-only synthetic facade; this harness does not exercise auth writes.
      if (dependency === "@/lib/supabase") return { supabase: { auth },
        sessionAuth: { onAuthStateChange: auth.onAuthStateChange }, hasSupabaseFrontendEnv: true };
      if (dependency === "@/contexts/AuthContext") return { useAuth: () => ({ signOut: async () => { await auth.signOut(); } }) };
      if (dependency === "@/lib/operatorApi") return { operatorApi };
      if (dependency === "@/components/portals/PortalShell") return { PortalShell };
      if (dependency === "@/components/contributors/PartnerLedger") return { PartnerLedger };
      if (dependency === "@/components/contributors/PartnerHistory") return { PartnerHistory };
      if (dependency === "@/components/contributors/PartnerLink") return { PartnerLink };
      if (dependency === "@/components/contributors/PartnerTerms") return { PartnerTerms };
      if (dependency === "@/components/contributors/CreatorJobs") return { CreatorJobs };
      if (dependency === "../../../../lib/crm/contributor-contracts") return load("contracts");
      if (dependency === "../../../../lib/auth/password-rules") return load("passwords");
      if (dependency === "../../../../lib/auth/staff-logins") return load("logins");
      return forbidden(dependency);
    };
    new Script(source.code[name]!, { filename: `${name}.actual.cjs` }).runInNewContext({ ...globals, exports, require });
    return exports;
  }
  t.after(() => {
    render.dispose();
    assert.equal(listeners.size, 0, "Actual root unsubscribes on disposal");
    assert.deepEqual(forbiddenCalls, [], "No network, SDK implementation or unexpected imports execute");
  });
  function find(predicate: (node: Element) => boolean, within?: Element) {
    const matches = (within ? helpers.elements(within.props.children) : render.nodes()).filter(predicate);
    assert.equal(matches.length, 1, `Expected exactly one host control, got ${matches.length}`);
    return matches[0]!;
  }
  function invoke(node: Element, event = "onClick", value?: unknown) {
    assert.notEqual(node.props.disabled, true);
    const callback = node.props[event];
    assert.equal(typeof callback, "function", `Missing actual ${event} handler`);
    return (callback as (event: unknown) => unknown)(value ?? { preventDefault() {} });
  }
  function take(route = "contributor-account", method = "GET", actor?: string) {
    const matches = requests.filter(item => !item.claimed && item.path === route && item.method === method
      && (actor === undefined || item.actor === actor));
    assert.equal(matches.length, 1, `Expected one ${method} ${route} for ${actor ?? "current actor"}`);
    const request = matches[0]!; request.claimed = true;
    return request;
  }
  function boundary(name: "PartnerLedger" | "PartnerHistory" | "CreatorJobs" | "PartnerTerms" | "PartnerLink") {
    const instances = render.instances(name);
    assert.equal(instances.length, 1, `${name} must actually render through Application`);
    return instances[0]!.input.props;
  }
  function shell() { return find(node => node.props["data-shell"] === true); }
  function nav(id: string) { return find(node => node.props["data-nav-id"] === id); }
  function refresh() {
    return find(node => node.type === "button", find(node => node.props["data-shell-actions"] === true));
  }
  async function navigate(id: string) { invoke(nav(id)); await render.flush(); }
  async function mode(value: "partner" | "creator") {
    const buttons = render.nodes().filter(node => node.type === "button" && typeof node.props["aria-pressed"] === "boolean");
    assert.equal(buttons.length, 2, "Use the actual mode controls");
    invoke(buttons[value === "partner" ? 0 : 1]!);
    await render.flush();
    const selected = render.nodes().filter(node => node.type === "button" && node.props["aria-pressed"] === true);
    assert.equal(selected.length, 1);
    assert.equal(selected[0]!.props.href, undefined, "Mode changes are handlers, not invented URLs");
  }
  render.mount(jsx(load("portal").default, {}));
  await render.flush();
  assert.equal(authReads, 1, "The actual root performs its initial Auth lookup");
  if (!delayInitialSession) { initial.resolve({ data: { session: session(A) }, error: null }); await render.flush(); }
  return { render, requests, boundaryRenders, emit, initial, take, boundary, find, invoke, shell, nav, refresh,
    mode, navigate, signOutCalls: () => signOutCalls, sourceHash: source.portalHash,
    dispatchFocus() { globals.window.dispatch("focus"); } };
}
type Ui = Awaited<ReturnType<typeof runtime>>;
function assertNoPrivate(ui: Ui) {
  assert.equal(ui.render.nodes().filter(node => node.props["data-private-panel"] !== undefined).length, 0);
  for (const name of ["PartnerLedger", "PartnerHistory", "CreatorJobs", "PartnerTerms", "PartnerLink"]) assert.equal(ui.render.instances(name).length, 0, name);
}
function assertActorGone(ui: Ui, previous: ContributorProfile) {
  assertNoPrivate(ui);
  assert.equal(ui.shell().props["data-display-name"], undefined, "Shell must not retain another account's displayName");
  assert.ok(!ui.render.content().includes(previous.displayName));
  for (const url of previous.portfolioUrls) assert.ok(!ui.render.nodes().some(node => node.props.href === url));
}
async function populated(t: TestContext, value = profile()) {
  const ui = await runtime(t), request = ui.take();
  assert.equal(request.actor, A); assert.equal(request.valid(), true);
  assert.equal(request.body, undefined);
  request.succeed(value); await ui.render.flush();
  assert.equal(ui.shell().props["data-display-name"], value.displayName);
  return ui;
}

test("actual approved-both Application switches partner -> creator -> profile and back without invented data", async t => {
  const value = profile();
  const ui = await populated(t, value);
  t.diagnostic(`Actual ContributorPortal/Application SHA256 ${ui.sourceHash}; synthetic host tree, Auth and private child boundaries`);
  assert.equal(ui.boundary("PartnerLedger").userId, A);
  assert.equal((ui.boundary("PartnerLedger").isActorCurrent as () => boolean)(), true);
  assert.equal(ui.boundary("PartnerHistory").userId, A);
  assert.equal((ui.boundary("PartnerHistory").isActorCurrent as () => boolean)(), true);
  assert.equal(ui.boundary("PartnerLink").actorId, A);
  assert.equal(ui.boundary("PartnerLink").profileId, value.id);
  assert.equal((ui.boundary("PartnerLink").isSessionCurrent as () => boolean)(), true);
  const historyInstance = ui.render.instances("PartnerHistory")[0]!.id;
  assert.equal(ui.render.instances("CreatorJobs").length, 0);
  assert.equal(ui.nav("operator").props.href, "/operator");
  const title = ui.find(node => node.type === "h1").props.children;
  await ui.mode("creator");
  assert.notEqual(ui.find(node => node.type === "h1").props.children, title);
  assert.equal(ui.boundary("CreatorJobs").actorId, A);
  assert.equal((ui.boundary("CreatorJobs").isSessionCurrent as () => boolean)(), true);
  assert.equal(ui.render.instances("PartnerLedger").length, 0);
  assert.equal(ui.render.instances("PartnerHistory").length, 0);
  assert.equal(ui.render.instances("PartnerLink").length, 0);
  assert.equal(ui.render.nodes().some(node => node.props["data-nav-id"] === "terms"), false);
  await ui.navigate("profile");
  assertNoPrivate(ui);
  assert.equal(ui.shell().props["data-active-id"], "profile");
  assert.equal(ui.shell().props["data-display-name"], value.displayName);
  assert.equal(ui.render.nodes().filter(node => node.type === "a" && node.props["data-nav-id"] === undefined).length, 0,
    "Empty portfolio must not gain demonstration links");
  assert.doesNotMatch(ui.render.content(), /(?:\d[\d ,.]*)\s*(?:KZT|USD|\u20b8|\u20bd|\$)/i,
    "Root must not fabricate financial amounts outside the real ledger/jobs");
  await ui.mode("partner");
  assert.equal(ui.shell().props["data-active-id"], "overview", "Mode handler resets profile to overview");
  ui.boundary("PartnerLedger");
  ui.boundary("PartnerHistory");
  assert.notEqual(ui.render.instances("PartnerHistory")[0]!.id, historyInstance, "Returning to partner mode mounts fresh history");
  assert.equal(ui.requests.length, 1, "Navigation itself does not invent mutations or fetches");
});

for (const status of [null, "pending", "suspended"] as const) {
  test(`actual partner-only/unapproved creator (${status}) never mounts jobs, including profile/portfolio navigation`, async t => {
    const ui = await populated(t, profile(A, "approved", status));
    await ui.mode("creator");
    assertNoPrivate(ui);
    await ui.navigate("portfolio");
    assertNoPrivate(ui);
    await ui.navigate("profile");
    assertNoPrivate(ui);
    await ui.navigate("overview");
    assertNoPrivate(ui);
    assert.equal(ui.boundaryRenders.includes("CreatorJobs"), false, "No hidden or transient creator component invocation");
    assert.equal(ui.requests.length, 1);
    await ui.mode("partner"); ui.boundary("PartnerLedger"); ui.boundary("PartnerHistory");
  });
}

for (const status of [null, "pending", "suspended"] as const) {
  test(`actual approved creator/unapproved partner (${status}) cannot mount partner ledger, history or terms`, async t => {
    const ui = await populated(t, profile(A, status, "approved"));
    if (status === null) ui.boundary("CreatorJobs");
    else assertNoPrivate(ui);
    await ui.mode("partner"); assertNoPrivate(ui);
    await ui.navigate("terms"); assertNoPrivate(ui);
    await ui.navigate("profile"); assertNoPrivate(ui);
    await ui.navigate("overview"); assertNoPrivate(ui);
    for (const name of ["PartnerLedger", "PartnerHistory", "PartnerTerms", "PartnerLink"]) {
      assert.equal(ui.boundaryRenders.includes(name), false, `No hidden or transient ${name} invocation`);
    }
    await ui.mode("creator"); ui.boundary("CreatorJobs");
    assert.equal(ui.render.instances("PartnerHistory").length, 0);
    assert.equal(ui.requests.length, 1);
  });
}

for (const outcome of ["revoked", "failed", "malformed"] as const) {
  test(`actual focus revalidation removes visible creator jobs after a ${outcome} profile response`, async t => {
    const value = profile(A, null, "approved"), ui = await populated(t, value);
    ui.boundary("CreatorJobs");
    ui.dispatchFocus(); await ui.render.flush();
    const read = ui.take();
    assert.equal(read.actor, A); assert.equal(read.valid(), true);
    ui.boundary("CreatorJobs");
    if (outcome === "failed") read.fail(new Error("Synthetic profile recheck failure"));
    else read.succeed(outcome === "revoked" ? profile(A, null, "suspended") : { ...value, revision: "not-a-revision" });
    await ui.render.flush(); assertNoPrivate(ui);
    if (outcome === "revoked") assert.equal(ui.shell().props["data-display-name"], value.displayName);
    else {
      assertActorGone(ui, value);
      assert.ok(ui.render.nodes().some(node => node.props.role === "alert"));
    }
    await ui.navigate("profile"); await ui.navigate("overview"); assertNoPrivate(ui);
    assert.equal(ui.requests.length, 2, "Navigation cannot bypass the failed/revoked profile gate");
  });
}

for (const outcome of ["revoked", "failed", "malformed"] as const) {
  test(`actual focus revalidation removes partner ledger and history after a ${outcome} profile response`, async t => {
    const value = profile(), ui = await populated(t, value);
    ui.boundary("PartnerLedger"); ui.boundary("PartnerHistory");
    ui.dispatchFocus(); await ui.render.flush();
    const read = ui.take();
    assert.equal(read.actor, A); assert.equal(read.valid(), true);
    ui.boundary("PartnerLedger"); ui.boundary("PartnerHistory");
    if (outcome === "failed") read.fail(new Error("Synthetic partner profile recheck failure"));
    else read.succeed(outcome === "revoked" ? profile(A, "suspended", "approved") : { ...value, revision: "not-a-revision" });
    await ui.render.flush(); assertNoPrivate(ui);
    if (outcome === "revoked") assert.equal(ui.shell().props["data-display-name"], value.displayName);
    else {
      assertActorGone(ui, value);
      assert.ok(ui.render.nodes().some(node => node.props.role === "alert"));
    }
    await ui.navigate("profile"); await ui.navigate("overview"); assertNoPrivate(ui);
    assert.equal(ui.requests.length, 2, "Navigation cannot restore history after failed/revoked profile validation");
  });
}

test("actual explicit refresh removes partner history before passive effects and remounts it only after profile approval", async t => {
  const value = profile(), ui = await populated(t, value);
  const application = ui.render.instances("Application")[0]!.id;
  const historyInstance = ui.render.instances("PartnerHistory")[0]!.id;
  const ledgerInstance = ui.render.instances("PartnerLedger")[0]!.id;
  const previousRead = ui.requests[0]!;
  ui.invoke(ui.refresh());
  assert.equal(previousRead.valid(), false, "Explicit refresh immediately invalidates the previous profile generation");
  await ui.render.beforeEffects(); assertActorGone(ui, value);
  assert.equal(ui.render.instances("Application")[0]!.id, application, "Refresh cleans children without changing the Auth lifetime");
  await ui.render.flush();
  assert.equal(previousRead.signal.aborted, true);
  const read = ui.take();
  assert.equal(read.actor, A); assert.equal(read.valid(), true); assertNoPrivate(ui);
  read.succeed(value); await ui.render.flush();
  assert.equal(ui.boundary("PartnerHistory").userId, A);
  assert.equal((ui.boundary("PartnerHistory").isActorCurrent as () => boolean)(), true);
  ui.boundary("PartnerLedger");
  assert.notEqual(ui.render.instances("PartnerHistory")[0]!.id, historyInstance);
  assert.notEqual(ui.render.instances("PartnerLedger")[0]!.id, ledgerInstance);
  assert.equal(ui.requests.length, 2);
});

for (const privatePanel of ["PartnerHistory", "PartnerLink"] as const) test(`actual ${privatePanel} denial clears all private UI and invalidates a late profile read until explicit refresh`, async t => {
  const value = profile(), ui = await populated(t, value);
  const history = ui.boundary(privatePanel);
  const historyInstance = ui.render.instances("PartnerHistory")[0]!.id;
  assert.equal(privatePanel === "PartnerLink" ? history.actorId : history.userId, A);
  assert.equal((privatePanel === "PartnerLink" ? history.isSessionCurrent as () => boolean : history.isActorCurrent as () => boolean)(), true);
  assert.equal(typeof history.onAccessDenied, "function");
  ui.dispatchFocus(); await ui.render.flush();
  const late = ui.take();
  assert.equal(late.actor, A); assert.equal(late.valid(), true);
  ui.boundary("PartnerHistory");
  (history.onAccessDenied as () => void)();
  assert.equal(late.valid(), false, "Child denial invalidates the in-flight parent profile generation");
  await ui.render.beforeEffects(); assertActorGone(ui, value);
  await ui.render.flush();
  assert.ok(ui.render.nodes().some(node => node.props.role === "alert"));
  late.succeed(value); await ui.render.flush(); assertActorGone(ui, value);
  await ui.mode("partner"); assertNoPrivate(ui);
  await ui.navigate("terms"); assertNoPrivate(ui);
  await ui.navigate("profile"); await ui.navigate("overview"); assertNoPrivate(ui);
  assert.equal(ui.requests.length, 2, "Denial cannot silently reload or restore private panels");
  ui.invoke(ui.refresh()); await ui.render.flush();
  const read = ui.take();
  assert.equal(read.actor, A); assert.equal(read.valid(), true);
  read.succeed(value); await ui.render.flush();
  ui.boundary("PartnerLedger");
  assert.equal(ui.boundary("PartnerHistory").userId, A);
  assert.notEqual(ui.render.instances("PartnerHistory")[0]!.id, historyInstance);
  assert.equal(ui.render.nodes().some(node => node.props.role === "alert"), false);
});

test("actual own-link request preserves profile, verified actor selector, child guard and original session lifetime", async t => {
  const value = profile(), ui = await populated(t, value), link = ui.boundary("PartnerLink");
  const request = link.request as (options: { signal: AbortSignal; isCurrent(): boolean }) => Promise<unknown>;
  const controller = new AbortController(); let childCurrent = true;
  const loading = request({ signal: controller.signal, isCurrent: () => childCurrent });
  const read = ui.take("partner-link?profileId=" + value.id);
  assert.equal(read.actor, A); assert.equal(read.method, "GET"); assert.equal(read.body, undefined);
  assert.strictEqual(read.signal, controller.signal); assert.equal(read.valid(), true);
  childCurrent = false; assert.equal(read.valid(), false);
  childCurrent = true; ui.emit(B); ui.emit(A);
  assert.equal(read.valid(), false, "An A-B-A transition cannot revive the previous link request");
  await ui.render.flush(); assertActorGone(ui, value);
  const marker = Object.freeze({ fixture: "retired-only" }); read.succeed(marker);
  assert.strictEqual(await loading, marker, "Child owns response publication; original guard is permanently false");
  assert.equal(read.valid(), false);
});

test("actual terms navigation and request/resolve/denial callbacks retain actor, body, signal and lifetime guards", async t => {
  const value = profile(), ui = await populated(t, value);
  const previousLedgerKey = ui.render.instances("PartnerLedger")[0]!.input.key;
  const previousHistoryKey = ui.render.instances("PartnerHistory")[0]!.input.key;
  const shortcut = ui.find(node => node.type === "button" && node.props["data-nav-id"] === undefined
    && node.props["aria-pressed"] === undefined && node.props["data-sign-out"] === undefined
    && node.props["aria-label"] === undefined);
  ui.invoke(shortcut); await ui.render.flush();
  assert.equal(ui.shell().props["data-active-id"], "terms");
  assert.equal(ui.render.instances("PartnerLedger").length, 0);
  assert.equal(ui.render.instances("PartnerHistory").length, 0);
  const terms = ui.boundary("PartnerTerms");
  assert.equal(terms.actorId, A); assert.equal(terms.profileId, value.id); assert.equal(terms.side, "partner");
  const request = terms.request as (options: TermsOptions) => Promise<unknown>;
  const controller = new AbortController();
  let childCurrent = true;
  const reading = request({ method: "GET", requestId: REQUEST, signal: controller.signal, isCurrent: () => childCurrent });
  const query = `partner-terms?${new URLSearchParams({ profileId: value.id, requestId: REQUEST })}`;
  const read = ui.take(query);
  assert.equal(read.actor, A); assert.strictEqual(read.signal, controller.signal); assert.equal(read.valid(), true);
  childCurrent = false; assert.equal(read.valid(), false, "Retain the child's operation guard");
  childCurrent = true;
  const receipt = Object.freeze({ state: "unconfirmed" });
  read.succeed(receipt); assert.strictEqual(await reading, receipt);
  const body = Object.freeze({ profileId: value.id, requestId: REQUEST });
  const writing = request({ method: "POST", body, signal: controller.signal, isCurrent: () => childCurrent });
  const write = ui.take("partner-terms", "POST");
  assert.strictEqual(write.body, body); assert.strictEqual(write.signal, controller.signal);
  assert.equal(write.actor, A); assert.equal(write.valid(), true);
  write.succeed(receipt); assert.strictEqual(await writing, receipt);
  (terms.onResolved as () => void)();
  await ui.navigate("overview");
  const ledger = ui.render.instances("PartnerLedger")[0]!;
  assert.notEqual(ledger.input.key, previousLedgerKey, "Real terms receipt invalidates the ledger revision");
  ui.boundary("PartnerHistory");
  assert.notEqual(ui.render.instances("PartnerHistory")[0]!.input.key, previousHistoryKey,
    "Real terms receipt also invalidates the history revision");
  await ui.navigate("terms");
  (ui.boundary("PartnerTerms").onAccessDenied as () => void)();
  await ui.render.flush(); assertActorGone(ui, value);
  assert.ok(ui.render.nodes().some(node => node.props.role === "alert"));
  ui.invoke(ui.refresh()); await ui.render.flush();
  const refreshed = ui.take(); assert.equal(refreshed.actor, A); assert.equal(refreshed.valid(), true);
  refreshed.succeed(value); await ui.render.flush(); ui.boundary("PartnerTerms");
});

for (const panel of ["partner", "history", "creator", "terms", "profile"] as const) {
  test(`actual root account change clears ${panel} and displayName before passive effects; late A response cannot enter B`, async t => {
    const previous = { ...profile(), portfolioUrls: ["https://example.com/contributor-a/"] };
    const ui = await populated(t, previous);
    if (panel === "creator") await ui.mode("creator");
    if (panel === "terms") await ui.navigate("terms");
    if (panel === "profile") await ui.navigate("profile");
    const name = panel === "partner" ? "PartnerLedger" : panel === "history" ? "PartnerHistory"
      : panel === "creator" ? "CreatorJobs" : "PartnerTerms";
    const old = panel === "profile" ? ui.render.instances("Application")[0]!.input.props : ui.boundary(name);
    const guard = (old.isActorCurrent ?? old.isSessionCurrent) as () => boolean;
    const oldRefresh = ui.refresh();
    const application = ui.render.instances("Application")[0]!.id;
    // Focus revalidation preserves the approved UI while a read is in flight.
    // Account change must hide an actually visible private panel, not one
    // already removed by the explicit refresh handler.
    ui.dispatchFocus(); await ui.render.flush();
    const late = ui.take(); assert.equal(late.valid(), true);
    assert.equal(ui.shell().props["data-display-name"], previous.displayName);
    if (panel === "profile") assert.ok(ui.render.nodes().some(node => node.props.href === previous.portfolioUrls[0]));
    else ui.boundary(name);
    ui.emit(B);
    assert.equal(guard(), false, "Root Auth callback invalidates stale child handlers immediately");
    await ui.render.beforeEffects();
    assertActorGone(ui, previous);
    assert.notEqual(ui.render.instances("Application")[0]!.id, application, "Actual epoch key remounts Application");
    await ui.render.flush();
    assert.equal(late.signal.aborted, true); assert.equal(late.valid(), false);
    const next = ui.take("contributor-account", "GET", B);
    const count = ui.requests.length;
    ui.invoke(oldRefresh);
    if (typeof old.onAccessDenied === "function") (old.onAccessDenied as () => void)();
    await ui.render.flush(); assert.equal(ui.requests.length, count, "Old UI callbacks cannot operate on account B");
    late.succeed(previous); await ui.render.flush(); assertActorGone(ui, previous);
    const current = profile(B, "approved", null);
    next.succeed(current); await ui.render.flush();
    assert.equal(ui.shell().props["data-display-name"], current.displayName);
    assert.equal(ui.boundary("PartnerLedger").userId, B, "Mode/section selection is not inherited from A");
    assert.equal(ui.boundary("PartnerHistory").userId, B, "History receives B's original actor, not stale A identity");
    assert.equal((ui.boundary("PartnerHistory").isActorCurrent as () => boolean)(), true);
    assert.equal(guard(), false);
    if (typeof old.onAccessDenied === "function") (old.onAccessDenied as () => void)();
    await ui.render.flush();
    assert.equal(ui.shell().props["data-display-name"], current.displayName, "Stale child denial cannot clear approved B");
    assert.equal(ui.boundary("PartnerHistory").userId, B);
    assert.equal(ui.requests.length, count);
    await ui.mode("creator"); assertNoPrivate(ui);
    await ui.navigate("profile");
    assert.ok(!ui.render.content().includes(previous.displayName));
    assert.ok(!ui.render.nodes().some(node => node.props.href === previous.portfolioUrls[0]));
    ui.invoke(ui.find(node => node.props["data-sign-out"] === true));
    await ui.render.beforeEffects(); assertActorGone(ui, previous);
    assert.ok(!ui.render.content().includes(current.displayName));
    await ui.render.flush();
    assert.equal(ui.signOutCalls(), 1); assert.equal(ui.render.instances("Application").length, 0);
  });
}

test("actual PartnerHistory original-actor guard never revives after sign-out and same-actor re-entry or disposal", async t => {
  const value = profile(), ui = await populated(t, value);
  const old = ui.boundary("PartnerHistory");
  const guard = old.isActorCurrent as () => boolean;
  assert.equal(old.userId, A); assert.equal(guard(), true);
  ui.emit(null);
  assert.equal(guard(), false, "Actual Auth callback invalidates history before passive cleanup");
  await ui.render.beforeEffects(); assertActorGone(ui, value);
  await ui.render.flush();
  assert.equal(ui.render.instances("Application").length, 0);
  (old.onAccessDenied as () => void)();
  await ui.render.flush(); assertNoPrivate(ui);
  assert.equal(ui.requests.length, 1);
  ui.emit(A); await ui.render.flush();
  const read = ui.take();
  assert.equal(read.actor, A); assert.equal(read.valid(), true);
  read.succeed(value); await ui.render.flush();
  const current = ui.boundary("PartnerHistory");
  const currentGuard = current.isActorCurrent as () => boolean;
  assert.equal(current.userId, A); assert.equal(currentGuard(), true);
  assert.equal(guard(), false, "Matching actor IDs cannot revive the previous Auth lifetime");
  (old.onAccessDenied as () => void)();
  await ui.render.flush();
  assert.equal(ui.boundary("PartnerHistory").userId, A);
  assert.equal(ui.shell().props["data-display-name"], value.displayName);
  assert.equal(ui.render.nodes().some(node => node.props.role === "alert"), false);
  ui.render.dispose();
  assert.equal(currentGuard(), false, "Disposal invalidates the propagated root lifetime guard");
  (current.onAccessDenied as () => void)();
  assertNoPrivate(ui);
  assert.equal(ui.requests.length, 2, "Disposed child callbacks cannot start profile work");
});

test("actual root ignores delayed initial Auth after an event and rejects A -> B -> A stale profile responses", async t => {
  const ui = await runtime(t, true);
  assert.equal(ui.render.instances("Application").length, 0);
  ui.emit(A); await ui.render.flush(); const firstA = ui.take();
  ui.emit(B); await ui.render.beforeEffects(); assertNoPrivate(ui);
  await ui.render.flush(); const firstB = ui.take("contributor-account", "GET", B);
  ui.emit(A); await ui.render.flush(); const secondA = ui.take("contributor-account", "GET", A);
  ui.initial.resolve({ data: { session: session(B) }, error: null });
  firstA.succeed(profile()); firstB.succeed(profile(B));
  await ui.render.flush();
  assert.equal(firstA.valid(), false); assert.equal(firstB.valid(), false); assert.equal(secondA.valid(), true);
  assert.equal(ui.shell().props["data-display-name"], undefined); assertNoPrivate(ui);
  secondA.succeed(profile()); await ui.render.flush(); ui.boundary("PartnerLedger"); ui.boundary("PartnerHistory");
  assert.equal(ui.requests.length, 3, "Late bootstrap Auth must not replace the last observed account");
});

test("actual empty-account form submits parsed fields only and a late mutation cannot restore a signed-out profile", async t => {
  const ui = await runtime(t);
  ui.take().succeed(null); await ui.render.flush(); assertNoPrivate(ui);
  const name = ui.find(node => node.type === "input" && node.props.maxLength === 120);
  ui.invoke(name, "onChange", { target: { value: "  Local contributor  " } });
  const portfolio = ui.find(node => node.type === "textarea");
  ui.invoke(portfolio, "onChange", { target: { value: "" } });
  const choices = ui.render.nodes().filter(node => node.type === "input" && node.props.type === "checkbox");
  assert.equal(choices.length, 2);
  ui.invoke(choices[0]!, "onChange", { target: { checked: false } });
  await ui.render.flush();
  const form = ui.find(node => node.type === "form");
  ui.invoke(form, "onSubmit"); await ui.render.flush();
  const mutation = ui.take("contributor-account", "POST");
  assert.equal(mutation.actor, A); assert.equal(mutation.valid(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(mutation.body)), {
    displayName: "Local contributor", partner: false, creator: true, portfolioUrls: [],
  }, "Real submit contract adds no URLs, amounts, identity or approval fields");
  ui.invoke(form, "onSubmit"); await ui.render.flush();
  assert.equal(ui.requests.filter(item => item.method === "POST").length, 1, "Actual mutation guard prevents duplicate submit");
  ui.emit(null); await ui.render.beforeEffects(); assertNoPrivate(ui);
  await ui.render.flush();
  assert.equal(mutation.signal.aborted, true); assert.equal(mutation.valid(), false);
  mutation.succeed({ ...profile(A, null, "pending"), displayName: "Local contributor" });
  await ui.render.flush();
  assert.equal(ui.shell().props["data-display-name"], undefined);
  assert.ok(!ui.render.content().includes("Local contributor"));
  assert.equal(ui.render.instances("Application").length, 0);
});

test("actual profile portfolio renders only supplied public links with safe external-link attributes", async t => {
  const value = { ...profile(), portfolioUrls: ["https://example.com/portfolio/"] };
  const ui = await populated(t, value);
  await ui.mode("creator"); await ui.navigate("portfolio"); assertNoPrivate(ui);
  const link = ui.find(node => node.type === "a" && node.props["data-nav-id"] === undefined);
  assert.equal(link.props.href, value.portfolioUrls[0]);
  assert.equal(link.props.target, "_blank"); assert.equal(link.props.rel, "noopener noreferrer");
});

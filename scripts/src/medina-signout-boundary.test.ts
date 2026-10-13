import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Real marker, token resolver and App functions, each in isolated VM modules.
// Storage, SDK promises, auth snapshots and component mounts are local fixtures;
// this does not run AuthProvider, React DOM, a browser, env files or a network.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const markerKey = "negis_signout_pending_v1";

function compile(source: string, fileName: string) {
  const result = ts.transpileModule(source, {
    fileName, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    transformers: { before: [(context) => {
      const visit: import("typescript").Visitor = (node) => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === "env" && ts.isMetaProperty(node.expression)) {
          return ts.factory.createObjectLiteralExpression([
            ts.factory.createPropertyAssignment("BASE_URL", ts.factory.createStringLiteral("/")),
          ]);
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (file) => ts.visitNode(file, visit) as import("typescript").SourceFile;
    }] },
  });
  const errors = result.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error) ?? [];
  assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, {
    getCurrentDirectory: () => root, getCanonicalFileName: (name) => name, getNewLine: () => "\n",
  }));
  return result.outputText;
}

const compiled = (async () => {
  const read = (file: string) => readFile(path.join(root, file), "utf8");
  const app = await read("artifacts/negis/src/App.tsx");
  return {
    marker: compile(await read("artifacts/negis/src/lib/authSignOut.ts"), "authSignOut.ts"),
    token: compile(await read("artifacts/negis/src/lib/serverAuth.ts"), "serverAuth.ts"),
    routes: compile(await read("artifacts/negis/src/lib/workspaceRoutes.ts"), "workspaceRoutes.ts"),
    // Only expose the private function; its body and all local callees stay real.
    app: compile(`${app}\nexport { SessionContent };`, "App.tsx"),
  };
})();

function evaluate<T>(code: string, filename: string, bindings: Record<string, unknown> = {}, imports: Record<string, unknown> = {}) {
  const exports = {} as T;
  new Script(code, { filename }).runInNewContext({
    exports,
    fetch: () => assert.fail("Network access is forbidden in this fixture"),
    require(name: string) {
      assert.ok(Object.hasOwn(imports, name), `Unexpected dependency: ${name}`);
      return imports[name];
    },
    ...bindings,
  });
  return exports;
}

type Marker = {
  getSignOutRevision(): number;
  isSignOutPending(): boolean;
  markSignOutPending(): void;
  clearSignOutPending(): boolean;
};
function storage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  const writes: Array<{ key: string; value: string }> = [];
  const removals: string[] = [];
  const failures = { get: false, set: false, remove: false };
  return {
    values, writes, removals, failures,
    getItem(key: string) {
      if (failures.get) throw new Error("Synthetic storage read failure");
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (failures.set) throw new Error("Synthetic storage write failure");
      writes.push({ key, value }); values.set(key, value);
    },
    removeItem(key: string) {
      removals.push(key);
      if (failures.remove) throw new Error("Synthetic storage removal failure");
      values.delete(key);
    },
  };
}
type Stores = { sessionStorage: ReturnType<typeof storage>; localStorage: ReturnType<typeof storage> };
const stores = (): Stores => ({ sessionStorage: storage(), localStorage: storage() });
async function loadMarker(window?: object) {
  return evaluate<Marker>((await compiled).marker, "authSignOut.fixture.cjs", window ? { window } : {});
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type SessionReply = { error: Error | null; data: { session: { user: { id: string }; access_token: string } | null } };
const reply = (actor = "A", token = " synthetic-A ", error: Error | null = null): SessionReply => ({
  error, data: { session: { user: { id: actor }, access_token: token } },
});
async function tokenFixture(marker: Marker, configured = true) {
  const calls: Array<ReturnType<typeof deferred<SessionReply>>> = [];
  const resolver = evaluate<{ getSupabaseAccessToken(expected?: string): Promise<string> }>(
    (await compiled).token, "serverAuth.fixture.cjs", {}, {
      "@/lib/authSignOut": marker,
      "@/lib/supabase": { hasSupabaseFrontendEnv: configured, supabase: { auth: {
        getSession() { const call = deferred<SessionReply>(); calls.push(call); return call.promise; },
      } } },
    },
  );
  return { token: resolver.getSupabaseAccessToken, calls };
}

test("B1 marker is a boolean tombstone, prefers sessionStorage and never writes credentials", async () => {
  const window = stores();
  window.sessionStorage.values.set("unrelated", "synthetic-unrelated-value");
  const marker = await loadMarker(window);
  assert.deepEqual(Object.keys(marker).sort(), ["clearSignOutPending", "getSignOutRevision", "isSignOutPending", "markSignOutPending"]);
  assert.equal(marker.isSignOutPending(), false);
  assert.equal(marker.markSignOutPending(), undefined);
  assert.equal(marker.isSignOutPending(), true);
  assert.equal(typeof marker.isSignOutPending(), "boolean");
  assert.deepEqual(window.sessionStorage.writes, [{ key: markerKey, value: "1" }]);
  assert.deepEqual(window.localStorage.writes, []);
  assert.equal(window.sessionStorage.values.get("unrelated"), "synthetic-unrelated-value");
  assert.equal(marker.clearSignOutPending(), true);
  assert.equal(marker.isSignOutPending(), false);
  assert.equal(window.sessionStorage.values.has(markerKey), false);
  assert.equal(window.sessionStorage.values.get("unrelated"), "synthetic-unrelated-value");
});

for (const store of ["sessionStorage", "localStorage"] as const) {
  test(`B2 ${store} accepts only the exact '1' marker`, async () => {
    for (const value of ["", "0", "true", "false", " 1 ", '"1"', '{"access_token":"synthetic"}', "1"]) {
      const window = stores(); window[store].values.set(markerKey, value);
      const marker = await loadMarker(window);
      assert.equal(marker.isSignOutPending(), value === "1", JSON.stringify(value));
      assert.equal(marker.clearSignOutPending(), true);
    }
  });
}

test("B3 reload into a new module preserves deny until the existing clear helper succeeds", async () => {
  const window = stores();
  const first = await loadMarker(window); first.markSignOutPending();
  const reloaded = await loadMarker(window);
  assert.notEqual(reloaded.isSignOutPending, first.isSignOutPending);
  const f = await tokenFixture(reloaded);
  assert.equal(await f.token("A"), ""); assert.equal(f.calls.length, 0);
  assert.equal(reloaded.isSignOutPending(), true);
  assert.equal(reloaded.clearSignOutPending(), true);
  const fresh = await loadMarker(window);
  assert.equal(fresh.isSignOutPending(), false);
  const issued = f.token("A"); f.calls[0].resolve(reply());
  assert.equal(await issued, "synthetic-A");
});

for (const failure of ["property-access", "storage-methods"] as const) {
  test(`B4 sessionStorage ${failure} failure falls back to localStorage across reload`, async () => {
    const window = stores();
    if (failure === "property-access") Object.defineProperty(window, "sessionStorage", {
      get() { throw new Error("Synthetic storage accessor failure"); },
    });
    else Object.assign(window.sessionStorage.failures, { get: true, set: true, remove: true });
    const marker = await loadMarker(window); marker.markSignOutPending();
    assert.deepEqual(window.localStorage.writes, [{ key: markerKey, value: "1" }]);
    const reloaded = await loadMarker(window);
    assert.equal(reloaded.isSignOutPending(), true);
    const f = await tokenFixture(reloaded);
    assert.equal(await f.token(), ""); assert.equal(f.calls.length, 0);
    assert.equal(reloaded.clearSignOutPending(), true);
    assert.equal(reloaded.isSignOutPending(), false);
    assert.equal((await loadMarker(window)).isSignOutPending(), false);
  });
}

for (const failure of ["property-access", "storage-methods"] as const) {
  test(`B5 both stores ${failure} failures retain a memory fence only for this document`, async () => {
    const window = stores();
    for (const name of ["sessionStorage", "localStorage"] as const) {
      if (failure === "property-access") Object.defineProperty(window, name, {
        get() { throw new Error("Synthetic storage accessor failure"); },
      });
      else Object.assign(window[name].failures, { get: true, set: true, remove: true });
    }
    const marker = await loadMarker(window); marker.markSignOutPending();
    const f = await tokenFixture(marker);
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.equal(marker.isSignOutPending(), true);
      assert.equal(await f.token("A"), "");
    }
    assert.equal(f.calls.length, 0);
    assert.equal((await loadMarker(window)).isSignOutPending(), false, "Unavailable storage cannot survive a new document");
    assert.equal(marker.isSignOutPending(), true, "Reload simulation must not reset the original module's memory");
    assert.equal(marker.clearSignOutPending(), true);
    assert.equal(marker.isSignOutPending(), false);
  });
}

test("B6 storage removal alone cannot clear live memory; clear removes only the tombstones", async () => {
  const window = stores(); const marker = await loadMarker(window);
  marker.markSignOutPending(); window.sessionStorage.values.delete(markerKey);
  assert.equal(marker.isSignOutPending(), true);
  window.localStorage.values.set(markerKey, "1");
  window.localStorage.values.set("unrelated", "synthetic-unrelated-value");
  assert.equal(marker.clearSignOutPending(), true);
  assert.deepEqual(window.sessionStorage.removals, [markerKey]);
  assert.deepEqual(window.localStorage.removals, [markerKey]);
  assert.equal(window.localStorage.values.get("unrelated"), "synthetic-unrelated-value");
  assert.equal(marker.clearSignOutPending(), true, "Clear is idempotent");
});

test("B7 failed tombstone removal returns false and keeps token access denied until helper retry", async () => {
  const window = stores(); const marker = await loadMarker(window);
  marker.markSignOutPending(); window.localStorage.values.set(markerKey, "1");
  window.localStorage.failures.remove = true;
  assert.equal(marker.clearSignOutPending(), false);
  assert.equal(marker.isSignOutPending(), true);
  assert.equal((await loadMarker(window)).isSignOutPending(), true);
  const f = await tokenFixture(marker);
  assert.equal(await f.token("A"), ""); assert.equal(f.calls.length, 0);
  window.localStorage.failures.remove = false;
  assert.equal(marker.clearSignOutPending(), true);
  const pending = f.token("A"); f.calls[0].resolve(reply());
  assert.equal(await pending, "synthetic-A");
});

test("B8 absent window still retains a memory fence without browser globals", async () => {
  const marker = await loadMarker();
  assert.equal(marker.isSignOutPending(), false);
  marker.markSignOutPending(); assert.equal(marker.isSignOutPending(), true);
  assert.equal(marker.clearSignOutPending(), true);
});

test("B9 revision is in-memory, increments on every mark and is not reset by clear", async () => {
  const window = stores(); const marker = await loadMarker(window);
  assert.equal(marker.getSignOutRevision(), 0);
  marker.markSignOutPending(); assert.equal(marker.getSignOutRevision(), 1);
  marker.markSignOutPending(); assert.equal(marker.getSignOutRevision(), 2);
  assert.equal(marker.clearSignOutPending(), true);
  assert.equal(marker.getSignOutRevision(), 2);
  marker.markSignOutPending(); assert.equal(marker.getSignOutRevision(), 3);
  const reloaded = await loadMarker(window);
  assert.equal(reloaded.getSignOutRevision(), 0);
  assert.equal(reloaded.isSignOutPending(), true, "Only the boolean tombstone persists across reload");
  assert.equal(reloaded.clearSignOutPending(), true);
  assert.ok(window.sessionStorage.writes.every(({ key, value }) => key === markerKey && value === "1"));
  assert.deepEqual(window.localStorage.writes, []);
});

test("T1 no pending marker allows a trimmed token; unavailable configuration never calls SDK", async () => {
  const marker = await loadMarker(stores()); const f = await tokenFixture(marker);
  const pending = f.token("A"); assert.equal(f.calls.length, 1); f.calls[0].resolve(reply());
  assert.equal(await pending, "synthetic-A");
  const unconfigured = await tokenFixture(marker, false);
  assert.equal(await unconfigured.token("A"), ""); assert.equal(unconfigured.calls.length, 0);
});

for (const expected of [undefined, "A", "B"]) {
  test(`T2 pending marker refuses ${expected ?? "unpinned"} lookup without calling SDK`, async () => {
    const marker = await loadMarker(stores()); marker.markSignOutPending();
    const f = await tokenFixture(marker);
    assert.equal(await f.token(expected), ""); assert.equal(f.calls.length, 0);
    assert.equal(marker.isSignOutPending(), true);
  });
}

test("T3 logout starting during getSession refuses even a matching token after the await", async () => {
  const marker = await loadMarker(stores()); const f = await tokenFixture(marker);
  const pending = f.token("A"); assert.equal(f.calls.length, 1);
  marker.markSignOutPending(); f.calls[0].resolve(reply());
  assert.equal(await pending, "");
  assert.equal(await f.token("A"), ""); assert.equal(f.calls.length, 1);
  assert.equal(marker.clearSignOutPending(), true);
  const fresh = f.token("A"); f.calls[1].resolve(reply("A", " synthetic-A-rotated "));
  assert.equal(await fresh, "synthetic-A-rotated");
});

for (const reason of ["actor-mismatch", "sdk-error", "no-session", "empty-token"] as const) {
  test(`T4 ${reason} still denies without pending and cannot clear a concurrent logout`, async () => {
    const marker = await loadMarker(stores()); const f = await tokenFixture(marker);
    const response = reason === "actor-mismatch" ? reply("B", "synthetic-B")
      : reason === "sdk-error" ? reply("A", "synthetic-A", new Error("Synthetic SDK failure"))
      : reason === "no-session" ? { error: null, data: { session: null } } : reply("A", "   ");
    const ordinary = f.token("A"); f.calls[0].resolve(response);
    assert.equal(await ordinary, ""); assert.equal(marker.isSignOutPending(), false);
    const raced = f.token("A"); marker.markSignOutPending(); f.calls[1].resolve(response);
    assert.equal(await raced, ""); assert.equal(marker.isSignOutPending(), true);
    assert.equal(await f.token("A"), ""); assert.equal(f.calls.length, 2);
    assert.equal(marker.clearSignOutPending(), true);
    const recovered = f.token("A"); f.calls[2].resolve(reply());
    assert.equal(await recovered, "synthetic-A");
  });
}

test("T5 a rejected SDK promise propagates but never opens the concurrent logout fence", async () => {
  const marker = await loadMarker(stores()); const f = await tokenFixture(marker);
  const pending = f.token("A"); const rejected = assert.rejects(pending, /Synthetic SDK rejection/);
  marker.markSignOutPending(); f.calls[0].reject(new Error("Synthetic SDK rejection"));
  await rejected;
  assert.equal(marker.isSignOutPending(), true);
  assert.equal(await f.token("A"), ""); assert.equal(f.calls.length, 1);
});

for (const expected of [undefined, "A"]) {
  test(`T6 completed mark+clear before SDK reply still denies the old ${expected ?? "unpinned"} lookup`, async () => {
    const marker = await loadMarker(stores()); const f = await tokenFixture(marker);
    const old = f.token(expected); assert.equal(f.calls.length, 1);
    const revision = marker.getSignOutRevision();
    marker.markSignOutPending(); assert.equal(marker.clearSignOutPending(), true);
    assert.equal(marker.isSignOutPending(), false);
    assert.equal(marker.getSignOutRevision(), revision + 1);
    // Start a new lookup before the stale one resolves to prove only the old
    // request is invalidated, not every request in an otherwise-open document.
    const fresh = f.token(expected); assert.equal(f.calls.length, 2);
    f.calls[1].resolve(reply("A", "synthetic-A-fresh"));
    assert.equal(await fresh, "synthetic-A-fresh");
    f.calls[0].resolve(reply("A", "synthetic-A-stale"));
    assert.equal(await old, ""); assert.equal(marker.isSignOutPending(), false);
  });
}

test("T7 a persisted tombstone appearing during SDK lookup denies even without a local revision change", async () => {
  const window = stores(); const marker = await loadMarker(window); const f = await tokenFixture(marker);
  const pending = f.token("A"); assert.equal(f.calls.length, 1);
  const revision = marker.getSignOutRevision();
  const otherModule = await loadMarker(window); otherModule.markSignOutPending();
  assert.equal(marker.getSignOutRevision(), revision);
  assert.equal(marker.isSignOutPending(), true);
  f.calls[0].resolve(reply()); assert.equal(await pending, "");
  assert.equal(await f.token("A"), ""); assert.equal(f.calls.length, 1);
  assert.equal(marker.clearSignOutPending(), true);
  const fresh = f.token("A"); f.calls[1].resolve(reply());
  assert.equal(await fresh, "synthetic-A");
});

type Props = Record<string, any>;
type Component = (props: Props) => unknown;
type Element = { type: string | symbol | Component; props: Props };
const jsx = (type: Element["type"], props: Props): Element => ({ type, props });
function nodes(value: any): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  return [value, ...nodes(value.props.children)];
}

async function uiFixture(marker: Marker, location: string) {
  const routes = evaluate<object>((await compiled).routes, "workspaceRoutes.fixture.cjs");
  const mounts: string[] = [];
  const imports: string[] = [];
  const loads: Promise<unknown>[] = [];
  const idleCallbacks: Array<() => void> = [];
  const effects: Array<() => void | (() => void)> = [];
  let cleanups: Array<() => void> = [];
  let signOutFailed = false;
  const attempts: Array<ReturnType<typeof deferred<{ error: Error | null }>>> = [];
  let completion: Promise<void> = Promise.resolve();
  const signOut = () => {
    marker.markSignOutPending(); signOutFailed = false;
    const attempt = deferred<{ error: Error | null }>(); attempts.push(attempt);
    completion = attempt.promise.then(({ error }) => {
      signOutFailed = error !== null || !marker.clearSignOutPending();
    });
    return completion;
  };
  const auth = () => ({
    isSigningOut: marker.isSignOutPending(), signOutFailed, signOut,
    // Deliberately retain a stale, otherwise eligible identity/demo snapshot.
    isLoading: false, user: { id: "A" }, userRole: "owner", workspacePurpose: "clinic_services",
    rolePermissions: { dashboard: true }, isDemoMode: true, isImpersonation: true,
    impersonationClinicName: "Synthetic workspace",
  });
  function stub(name: string, tag?: string): Component {
    const component = (props: Props) => tag ? jsx(tag, { ...props, children: tag === "form" ? jsx("input", {}) : props.children }) : null;
    Object.defineProperty(component, "name", { value: name });
    return component;
  }
  const passthrough = (props: Props) => props.children;
  const modules: Record<string, unknown> = {
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: Symbol("Fragment") },
    react: {
      Suspense: passthrough,
      useEffect: (effect: () => void | (() => void)) => effects.push(effect),
      lazy(load: () => Promise<{ default: Component }>) {
        let loaded: Component | undefined, started = false;
        return function LazyRoute(props: Props) {
          if (!started) { started = true; loads.push(load().then((module) => { loaded = module.default; })); }
          return loaded ? jsx(loaded, props) : null;
        };
      },
    },
    wouter: {
      Router: passthrough,
      Switch: (props: Props) => nodes(props.children).find((node) => node.props.path === location)
        ?? nodes(props.children).find((node) => !node.props.path) ?? null,
      Route: (props: Props) => props.component ? jsx(props.component, {}) : props.children,
      Redirect: stub("Redirect"), useLocation: () => [location, () => assert.fail("Unexpected navigation")],
    },
    "@tanstack/react-query": { QueryClient: class {}, QueryClientProvider: passthrough },
    sonner: { Toaster: stub("Toaster") },
    "@/components/ui/tooltip": { TooltipProvider: passthrough },
    "@/contexts/AuthContext": { useAuth: auth, AuthProvider: () => assert.fail("AuthProvider is owned by the main agent") },
    "@/lib/workspaceRoutes": routes,
    "lucide-react": { LoaderCircle: stub("LoaderCircle", "svg"), RotateCw: stub("RotateCw", "svg") },
    "@/pages/Landing": { default: stub("Landing", "form") },
    "@/pages/DemoPlaceholder": { default: stub("DemoPlaceholder", "form") },
    "@/pages/not-found": { default: stub("NotFound") },
    "@/components/layout/UpdatePrompt": { UpdatePrompt: stub("UpdatePrompt") },
    "@/components/FbPixelInit": { default: stub("FbPixelInit") },
    "@/components/WorkspacePicker": { WorkspacePicker: stub("WorkspacePicker", "nav") },
    "@/components/layout/RouteErrorBoundary": { RouteErrorBoundary: passthrough },
  };
  const allowedPages = new Set([
    "Login", "Onboarding", "JoinWorkspace", "JoinRequest", "OperatorPortal", "ClientBasePage", "StatsPage",
    "Dashboard", "AiControlCenter", "AdvertisingHub", "AdsAutomation", "AppointmentsPage", "ContentStudio",
    "SiteBlog", "AdminCenter", "LeadsPage", "ClientsPage", "SalesPage", "ServicesPage", "DemoCrmModules",
    "MarketplacePage", "DirectoryPage", "Privacy", "Terms", "DataDeletion", "ResetPassword",
  ]);
  const app = evaluate<{ SessionContent: Component }>((await compiled).app, "App.fixture.cjs", {
    window: { requestIdleCallback: (callback: () => void) => idleCallbacks.push(callback) },
    require(name: string) {
      if (name.startsWith("@/pages/") && allowedPages.has(name.slice("@/pages/".length))) {
        const page = name.slice("@/pages/".length); imports.push(page);
        return { default: stub(page, "form"), AppointmentsPage: stub(page, "form"),
          DemoCalls: stub("DemoCalls", "form"), DemoChat: stub("DemoChat", "form"), DemoTasks: stub("DemoTasks", "form") };
      }
      assert.ok(Object.hasOwn(modules, name), `Unexpected UI dependency: ${name}`);
      return modules[name];
    },
  });
  function mount(value: any): any {
    if (Array.isArray(value)) return value.map(mount);
    if (!value || typeof value !== "object" || !("props" in value)) return value;
    if (typeof value.type === "function") { mounts.push(value.type.name); return mount(value.type(value.props)); }
    return { ...value, props: { ...value.props, children: mount(value.props.children) } };
  }
  let tree: unknown;
  function render() {
    for (const cleanup of cleanups) cleanup(); cleanups = [];
    mounts.length = 0; effects.length = 0;
    tree = mount(jsx(app.SessionContent, {}));
    for (const effect of effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
    return tree;
  }
  return {
    mounts, imports, idleCallbacks, attempts, signOut, render,
    nodes: () => nodes(tree),
    async settle() { await completion; await tick(); await Promise.all(loads); },
    async warm() { for (const callback of idleCallbacks.splice(0)) callback(); await tick(); await Promise.all(loads); },
    dispose() { for (const cleanup of cleanups) cleanup(); cleanups = []; },
  };
}

function assertClosed(f: Awaited<ReturnType<typeof uiFixture>>, failed: boolean) {
  for (const component of ["Router", "Login", "Landing", "DemoPlaceholder", "ImpersonationBanner",
    "WorkspacePicker", "RoutePrefetcher", "FbPixelInit", "UpdatePrompt"]) {
    assert.equal(f.mounts.includes(component), false, `${component} must not mount behind the sign-out boundary`);
  }
  assert.equal(f.nodes().some((node) => ["form", "input", "nav", "a"].includes(String(node.type))), false);
  assert.equal(f.mounts.includes("LoaderCircle"), !failed);
  assert.equal(f.mounts.includes("RotateCw"), failed);
  const buttons = f.nodes().filter((node) => node.type === "button");
  assert.equal(buttons.length, failed ? 1 : 0);
  if (failed) {
    assert.equal(buttons[0].props.type, "button");
    assert.equal(typeof buttons[0].props.onClick, "function");
  }
}

for (const location of ["/login", "/profile", "/"]) {
  test(`U1 ${location} unmounts the whole shell on pending/failure, permits retry and restores shell on success`, async (t) => {
    const marker = await loadMarker(stores()); const f = await uiFixture(marker, location); t.after(() => f.dispose());
    f.render(); await f.settle(); f.render();
    for (const component of ["Router", "WorkspacePicker", "RoutePrefetcher", "ImpersonationBanner"]) {
      assert.ok(f.mounts.includes(component), `${component} positive mount control`);
    }
    assert.ok(f.nodes().some((node) => node.type === "form"), "Login/demo entry positive control");
    assert.ok(f.idleCallbacks.length > 0, "Eligible stale identity really schedules prefetch");
    const importsBefore = f.imports.length;
    void f.signOut(); f.render(); assertClosed(f, false);
    await f.warm(); assert.equal(f.imports.length, importsBefore, "Cancelled pre-logout idle callbacks must not load pages");
    f.attempts[0].resolve({ error: new Error("Synthetic logout failure") }); await f.settle();
    f.render(); assertClosed(f, true); assert.equal(marker.isSignOutPending(), true);
    await f.warm(); assert.equal(f.imports.length, importsBefore);
    f.nodes().find((node) => node.type === "button")!.props.onClick();
    assert.equal(f.attempts.length, 2, "The real retry handler calls signOut");
    f.render(); assertClosed(f, false); assert.equal(marker.isSignOutPending(), true);
    f.attempts[1].resolve({ error: null }); await f.settle();
    assert.equal(marker.isSignOutPending(), false); f.render(); await f.settle(); f.render();
    assert.ok(f.mounts.includes("Router")); assert.ok(f.mounts.includes("WorkspacePicker"));
    assert.ok(f.mounts.includes("RoutePrefetcher")); assert.ok(!f.mounts.includes("LoaderCircle"));
    assert.ok(f.nodes().some((node) => node.type === "form"));
    await f.warm(); assert.ok(f.imports.length > importsBefore, "Successful completion restores real route prefetch");
  });

  test(`U2 reloaded pending ${location} never mounts login/demo or schedules prefetch`, async (t) => {
    const window = stores(); const first = await loadMarker(window); first.markSignOutPending();
    const marker = await loadMarker(window); const f = await uiFixture(marker, location); t.after(() => f.dispose());
    f.render(); assertClosed(f, false);
    await f.warm(); assert.deepEqual(f.imports, []); assert.equal(f.idleCallbacks.length, 0);
    assert.equal(marker.isSignOutPending(), true);
  });
}

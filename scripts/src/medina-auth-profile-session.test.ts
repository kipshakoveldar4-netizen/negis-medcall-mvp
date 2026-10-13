import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// The real AuthProvider/useAuth run with local hooks, storage, SDK and requests.
// No browser, React DOM, environment files, credentials or network are loaded.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const read = (file: string) => readFile(path.join(root, file), "utf8");
const source = await read("artifacts/negis/src/contexts/AuthContext.tsx");
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

type Node = { type: any; props: Record<string, any> };
const jsx = (type: any, props: Node["props"]): Node => ({ type, props });
function evaluate(code: string, imports: Record<string, unknown> = {}, bindings: Record<string, unknown> = {}) {
  const exports: Record<string, any> = {};
  const compiled = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    // Supply an inert build-time env while preserving the entire provider logic.
    transformers: { before: [(context) => {
      const visit: import("typescript").Visitor = (node) => {
        if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
          return ts.factory.createObjectLiteralExpression([
            ts.factory.createPropertyAssignment("env", ts.factory.createObjectLiteralExpression([
              ts.factory.createPropertyAssignment("DEV", ts.factory.createFalse()),
            ])),
          ]);
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (file) => ts.visitNode(file, visit) as import("typescript").SourceFile;
    }] },
  }).outputText;
  new Script(compiled).runInNewContext({
    exports, URLSearchParams, Response, ...bindings,
    require(name: string) {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      assert.ok(name in imports, `Unmocked import: ${name}`);
      return imports[name];
    },
  });
  return exports;
}

const terms = evaluate(await read("lib/vertical/terms.ts"));
const purposes = evaluate(await read("lib/crm/workspace-purpose.ts"), { "../vertical/terms": terms });
const permissions = evaluate(await read("artifacts/negis/src/lib/permissions.ts"));
const sameDeps = (left?: unknown[], right?: unknown[]) => Boolean(left && right && left.length === right.length
  && left.every((value, index) => Object.is(value, right[index])));
type Instance = { slots: any[]; cursor: number; disposed: boolean };

function hookRenderer() {
  const instances = new Map<string, Instance>();
  const writes: { instance: Instance; value: unknown }[] = [];
  let current: Instance;
  let rootNode: Node;
  let dirty = true;
  let mounted = true;

  function render(value: any, address: string): any {
    if (Array.isArray(value)) return value.map((child, index) => render(child, `${address}/${index}`));
    if (!value || typeof value !== "object" || !("props" in value)) return value;
    if (value.type?.context) {
      const context = value.type.context;
      const previous = context.current;
      context.current = value.props.value;
      const output = render(value.props.children, `${address}/provider`);
      context.current = previous;
      return output;
    }
    if (typeof value.type !== "function") return render(value.props.children, `${address}/children`);
    let instance = instances.get(address);
    if (!instance) {
      instance = { slots: [], cursor: 0, disposed: false };
      instances.set(address, instance);
    }
    current = instance;
    instance.cursor = 0;
    return render(value.type(value.props), `${address}/child`);
  }

  function effect(create: () => any, deps?: unknown[], layout = false) {
    const index = current.cursor++;
    const old = current.slots[index];
    current.slots[index] = { create, deps, layout, cleanup: old?.cleanup, pending: !old || !sameDeps(old.deps, deps) };
  }
  const hooks = {
    createContext(initial: unknown) {
      const context: any = { current: initial };
      context.Provider = { context };
      return context;
    },
    useContext(context: any) { return context.current; },
    useState(initial: any) {
      const instance = current, index = instance.cursor++;
      instance.slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [instance.slots[index].value, (update: any) => {
        const value = typeof update === "function" ? update(instance.slots[index].value) : update;
        writes.push({ instance, value });
        if (!instance.disposed && !Object.is(value, instance.slots[index].value)) {
          instance.slots[index].value = value;
          dirty = true;
        }
      }];
    },
    useRef(initial: any) { const index = current.cursor++; return current.slots[index] ??= { current: initial }; },
    useMemo(create: () => any, deps?: unknown[]) {
      const index = current.cursor++;
      if (!current.slots[index] || !sameDeps(current.slots[index].deps, deps)) current.slots[index] = { value: create(), deps };
      return current.slots[index].value;
    },
    useCallback(callback: any, deps?: unknown[]) { return hooks.useMemo(() => callback, deps); },
    useEffect: effect,
    useLayoutEffect: (create: () => any, deps?: unknown[]) => effect(create, deps, true),
  };
  function commit() {
    if (!mounted || !dirty) return;
    dirty = false;
    render(rootNode, "root");
    for (const layout of [true, false]) {
      const pending = [...instances.values()].flatMap((instance) => instance.slots)
        .filter((slot) => slot?.pending && slot.layout === layout);
      for (const slot of pending) slot.cleanup?.();
      for (const slot of pending) { slot.pending = false; slot.cleanup = slot.create(); }
    }
  }
  return {
    hooks, writes, commit,
    mount(type: any, child: any) { rootNode = jsx(type, { children: jsx(child, {}) }); },
    async flush() {
      for (let pass = 0; pass < 80; pass++) { commit(); await Promise.resolve(); }
      assert.equal(dirty, false, "synthetic hooks must settle after rerender");
    },
    dispose() {
      if (!mounted) return;
      mounted = false;
      dirty = false;
      for (const instance of instances.values()) {
        instance.disposed = true;
        for (const slot of instance.slots) slot?.cleanup?.();
      }
      instances.clear();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function memoryStorage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  const writes: { key: string; value: string | null }[] = [];
  return {
    values, writes,
    getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) { values.set(key, value); writes.push({ key, value }); },
    removeItem(key: string) { values.delete(key); writes.push({ key, value: null }); },
  };
}

const actorA = "00000000-0000-4000-8000-000000000101";
const actorB = "00000000-0000-4000-8000-000000000102";
const workspaceA = "00000000-0000-4000-8000-000000000103";
const workspaceB = "00000000-0000-4000-8000-000000000104";
const unknownWorkspace = "00000000-0000-4000-8000-000000000105";
const selectorKey = "negis_workspace_selector";
const localSession = (id: string | null) => id ? {
  user: { id, email: `${id === actorA ? "a" : "b"}@example.test`,
    user_metadata: { purpose: "marketing", workspacePurpose: "marketing", vertical: "dental", role: "owner" },
    app_metadata: { purpose: "clinic_services" } },
} : null;
const membership = (patch: Record<string, unknown> = {}) => ({
  staffUserId: "staff-profile-local-a", workspaceId: workspaceA, workspaceName: "Local clinic",
  role: "owner", permissions: ["view_clients", "manage_staff"], vertical: "beauty", purpose: "clinic_services", ...patch,
});
const mortgage = () => membership({ staffUserId: "staff-profile-local-b", workspaceId: workspaceB,
  workspaceName: "Local mortgage", role: "lead_manager", permissions: ["view_leads"], vertical: null, purpose: "mortgage_leads" });
const success = (memberships: Record<string, unknown>[]) => ({ success: true, mode: "supabase", data: {
  memberships, workspaceId: memberships.length === 1 ? memberships[0].workspaceId : null,
  requiresWorkspaceSelection: memberships.length > 1,
  // Only memberships[].purpose is authoritative, not a sibling profile hint.
  purpose: "marketing", vertical: "dental",
} });

type Snapshot = {
  user: { id: string } | null; session: unknown; clinicId: string | null; userRole: string | null;
  rolePermissions: Record<string, boolean>; vertical: string; workspacePurpose: string | null;
  availableWorkspaces: { id: string; name: string; role: string; vertical: string; purpose: string }[];
  isLoading: boolean; isStaffMode: boolean; isDemoMode: boolean; isImpersonation: boolean;
  selectWorkspace: (id: string) => void; clearWorkspaceSelection: () => void; signOut: () => Promise<void>;
};
type Init = RequestInit & { accessToken?: string; expectedUserId?: string };
type PendingRequest = { url: string; init: Init; actor: string | undefined; reply: (body: unknown, status?: number) => void;
  resolve: (response: Response) => void; reject: (error: unknown) => void };
type Options = { initialActor?: string | null; deferSession?: boolean; storage?: Record<string, string> };

function setup(options: Options = {}) {
  const renderer = hookRenderer();
  const storage = memoryStorage(options.storage);
  const sessionStorage = memoryStorage();
  const sessionGate = deferred<{ data: { session: ReturnType<typeof localSession> } }>();
  const callbacks = new Set<(event: string, session: ReturnType<typeof localSession>) => void>();
  const requests: PendingRequest[] = [];
  const tokenCalls: (string | undefined)[] = [];
  const tokenOwners = new Map<string, string>();
  const cacheClears: string[] = [];
  const caches = { crm: new Map<string, unknown>(), lists: new Map<string, unknown>() };
  const toasts: { kind: string; message: string }[] = [];
  const locations: string[] = [];
  let snapshot!: Snapshot;
  let sdkActor = options.initialActor === undefined ? actorA : options.initialActor;
  let tokenReply: ((expected?: string) => Promise<string>) | undefined;
  let logoutGate: ReturnType<typeof deferred<void>> | undefined;
  let signOutCalls = 0;
  let getSessionCalls = 0;
  if (!options.deferSession) sessionGate.resolve({ data: { session: localSession(sdkActor) } });

  function emit(id: string | null, event = id ? "SIGNED_IN" : "SIGNED_OUT") {
    sdkActor = id;
    for (const callback of [...callbacks]) callback(event, localSession(id));
  }
  const sdk = {
    onAuthStateChange(callback: typeof callbacks extends Set<infer T> ? T : never) {
      callbacks.add(callback);
      return { data: { subscription: { unsubscribe: () => callbacks.delete(callback) } } };
    },
    getSession() { getSessionCalls += 1; return sessionGate.promise; },
    async signOut() {
      signOutCalls += 1;
      if (logoutGate) await logoutGate.promise;
      emit(null);
      return { error: null };
    },
  };
  const auth = evaluate(source, {
    react: { ...renderer.hooks, default: renderer.hooks },
    "@/lib/supabase": { supabase: { auth: sdk } },
    "../../../../lib/vertical/terms": terms,
    "../../../../lib/crm/workspace-purpose": purposes,
    wouter: { useLocation: () => ["/dashboard", (location: string) => locations.push(location)] },
    sonner: { toast: new Proxy({}, { get: (_target, kind) => (message: string) => toasts.push({ kind: String(kind), message }) }) },
    "@/lib/permissions": permissions,
    "@/lib/demoStorage": { WORKSPACE_SELECTOR_KEY: selectorKey,
      clearListReadCache() { cacheClears.push("lists"); caches.lists.clear(); } },
    "@/lib/api": {
      apiUrl: (url: string) => url,
      clearCrmCache() { cacheClears.push("crm"); caches.crm.clear(); },
      crmFetch(url: string, init: Init = {}) {
        assert.equal(url, "/api/crm/auth-context", "only an isolated auth bootstrap may be dispatched");
        const gate = deferred<Response>();
        requests.push({ url, init, actor: tokenOwners.get(init.accessToken ?? ""), resolve: gate.resolve, reject: gate.reject,
          reply(body: unknown, status = 200) { gate.resolve(Response.json(body, { status })); } });
        return gate.promise;
      },
    },
    "@/lib/serverAuth": { async getSupabaseAccessToken(expected?: string) {
      tokenCalls.push(expected);
      const token = tokenReply ? await tokenReply(expected) : expected && expected !== sdkActor ? "" : `local-fixture-token:${expected}`;
      if (expected) tokenOwners.set(token, expected);
      return token;
    } },
  }, {
    localStorage: storage, sessionStorage,
    window: { localStorage: storage, sessionStorage,
      location: { search: "", origin: "https://example.test", pathname: "/dashboard" }, history: { replaceState() {} } },
    document: { title: "Local auth fixture" },
    fetch: () => { throw new Error("Network is forbidden in the local AuthProvider fixture"); },
  });
  function Probe() { snapshot = auth.useAuth(); return null; }
  renderer.mount(auth.AuthProvider, Probe);
  return {
    renderer, storage, sessionGate, requests, tokenCalls, cacheClears, caches, toasts, locations, emit,
    snapshot: () => snapshot,
    subscriptions: () => callbacks.size,
    sdkCalls: () => ({ signOut: signOutCalls, getSession: getSessionCalls }),
    token(reply?: typeof tokenReply) { tokenReply = reply; },
    holdSignOut() { logoutGate = deferred<void>(); return logoutGate; },
    request(actor: string, index = 0) {
      const request = requests.filter((entry) => entry.actor === actor)[index];
      assert.ok(request, `missing bootstrap ${index + 1} for isolated actor ${actor}`);
      return request;
    },
    seedCaches() { caches.crm.set("local-old-read", ["old CRM row"]); caches.lists.set("local-old-list", ["old list row"]); },
    async respond(request: PendingRequest, body: unknown, status = 200) { request.reply(body, status); await renderer.flush(); },
  };
}
type Fixture = ReturnType<typeof setup>;
async function withFixture(run: (fixture: Fixture) => Promise<void>, options: Options = {}) {
  const fixture = setup(options);
  try { await fixture.renderer.flush(); await run(fixture); }
  finally { fixture.renderer.dispose(); }
}
async function confirm(fixture: Fixture, memberships = [membership()]) {
  await fixture.respond(fixture.request(actorA), success(memberships));
  assert.equal(fixture.snapshot().isLoading, false);
}
function context(fixture: Fixture) {
  const { user, session, clinicId, userRole, rolePermissions, vertical, workspacePurpose, availableWorkspaces,
    isLoading, isStaffMode, isDemoMode, isImpersonation } = fixture.snapshot();
  return clone({ user, session, clinicId, userRole, rolePermissions, vertical, workspacePurpose, availableWorkspaces,
    isLoading, isStaffMode, isDemoMode, isImpersonation });
}
function assertUnselected(fixture: Fixture, choices = false) {
  const value = fixture.snapshot();
  assert.equal(value.clinicId, null);
  assert.equal(value.userRole, null);
  assert.deepEqual(clone(value.rolePermissions), {});
  assert.equal(value.workspacePurpose, null);
  assert.equal(value.vertical, terms.DEFAULT_VERTICAL);
  if (!choices) assert.deepEqual(clone(value.availableWorkspaces), []);
}
function assertCachesEmpty(fixture: Fixture, start: number) {
  assert.equal(fixture.caches.crm.size, 0);
  assert.equal(fixture.caches.lists.size, 0);
  assert.ok(fixture.cacheClears.slice(start).includes("crm"));
  assert.ok(fixture.cacheClears.slice(start).includes("lists"));
}
function effects(fixture: Fixture) {
  return { context: context(fixture), storage: [...fixture.storage.values], storageWrites: fixture.storage.writes.length,
    writes: fixture.renderer.writes.length, toasts: fixture.toasts.length, locations: fixture.locations.length,
    cacheClears: fixture.cacheClears.length };
}

test("mortgage purpose comes only from the signed-in user's server membership", async () => {
  await withFixture(async (fixture) => {
    assertUnselected(fixture);
    assert.deepEqual(fixture.tokenCalls, [actorA], "bootstrap token lookup must name the expected user");
    await confirm(fixture, [mortgage()]);
    const value = fixture.snapshot();
    assert.equal(value.user?.id, actorA);
    assert.equal(value.clinicId, workspaceB);
    assert.equal(value.userRole, "lead_manager");
    assert.equal(value.workspacePurpose, "mortgage_leads");
    assert.equal(value.vertical, terms.DEFAULT_VERTICAL);
    assert.equal(value.rolePermissions.crm, true);
    assert.equal(value.rolePermissions.admin, false);
    assert.deepEqual(clone(value.availableWorkspaces), [{ id: workspaceB, name: "Local mortgage", role: "lead_manager",
      vertical: terms.DEFAULT_VERTICAL, purpose: "mortgage_leads" }]);
  }, { storage: { negis_workspace_purpose: "marketing", [selectorKey]: unknownWorkspace } });
});

for (const purpose of ["clinic_services", "marketing"] as const) {
  test(`explicit server ${purpose} purpose is accepted without inferring it from vertical or metadata`, async () => {
    await withFixture(async (fixture) => {
      await confirm(fixture, [membership({ purpose, vertical: "dental", role: "marketer" })]);
      assert.equal(fixture.snapshot().workspacePurpose, purpose);
      assert.equal(fixture.snapshot().vertical, "dental");
      assert.equal(fixture.snapshot().availableWorkspaces[0].purpose, purpose);
    });
  });
}

test("the user's clinic/mortgage picker swaps purpose, vertical and role and clearing restores null/default", async () => {
  await withFixture(async (fixture) => {
    await confirm(fixture, [membership(), mortgage()]);
    assertUnselected(fixture, true);
    assert.deepEqual(clone(fixture.snapshot().availableWorkspaces.map((entry) => entry.purpose)), ["clinic_services", "mortgage_leads"]);
    assert.equal(fixture.toasts.length, 0, "a valid multi-workspace picker is not denied access");
    fixture.snapshot().selectWorkspace(workspaceA);
    await fixture.renderer.flush();
    assert.equal(fixture.snapshot().workspacePurpose, "clinic_services");
    assert.equal(fixture.snapshot().vertical, "beauty");
    assert.equal(fixture.snapshot().userRole, "owner");
    fixture.snapshot().selectWorkspace(workspaceB);
    await fixture.renderer.flush();
    assert.equal(fixture.snapshot().workspacePurpose, "mortgage_leads");
    assert.equal(fixture.snapshot().vertical, terms.DEFAULT_VERTICAL);
    assert.equal(fixture.snapshot().userRole, "lead_manager");
    assert.equal(fixture.storage.getItem(selectorKey), workspaceB);
    fixture.snapshot().selectWorkspace(workspaceA);
    await fixture.renderer.flush();
    assert.equal(fixture.snapshot().workspacePurpose, "clinic_services");
    assert.equal(fixture.snapshot().vertical, "beauty");
    fixture.snapshot().clearWorkspaceSelection();
    await fixture.renderer.flush();
    assertUnselected(fixture, true);
    assert.equal(fixture.storage.getItem(selectorKey), null);
    assert.equal(fixture.snapshot().availableWorkspaces.length, 2);
    assert.equal(fixture.snapshot().user?.id, actorA);
    assert.equal(fixture.requests.length, 1, "picker selection uses verified memberships, not another bootstrap");
  });
});

test("a picker cannot apply a workspace outside the current server memberships", async () => {
  await withFixture(async (fixture) => {
    await confirm(fixture, [membership(), mortgage()]);
    fixture.snapshot().selectWorkspace(workspaceB);
    await fixture.renderer.flush();
    const before = context(fixture);
    fixture.snapshot().selectWorkspace(unknownWorkspace);
    await fixture.renderer.flush();
    assert.deepEqual(context(fixture), before);
    assert.equal(fixture.storage.getItem(selectorKey), workspaceB);
  });
});

test("invalid raw membership purposes deny access instead of falling back to clinic_services", async () => {
  for (const purpose of [null, "", "mortgage", "CLINIC_SERVICES", "clinic_services ", 42, { purpose: "clinic_services" }, ["marketing"]]) {
    await withFixture(async (fixture) => {
      await confirm(fixture, [membership({ purpose })]);
      assertUnselected(fixture);
      assert.equal(fixture.snapshot().user?.id, actorA);
      fixture.snapshot().selectWorkspace(workspaceA);
      await fixture.renderer.flush();
      assertUnselected(fixture);
    }, { storage: { [selectorKey]: workspaceA } });
  }
});

test("missing purpose in a successful frontend response is denied even with valid sibling profile hints", async () => {
  await withFixture(async (fixture) => {
    const entry = membership();
    delete (entry as Record<string, unknown>).purpose;
    await confirm(fixture, [entry]);
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().isStaffMode, false);
    assert.match(fixture.toasts.at(-1)?.message ?? "", /\u043f\u0440\u043e\u0444\u0438\u043b\u044c/);
  });
});

test("a successful current-account response with missing/invalid purpose cannot retain a previously confirmed profile", async () => {
  for (const purpose of [undefined, "unrecognized"] as const) {
    await withFixture(async (fixture) => {
      await confirm(fixture, [mortgage()]);
      const oldSelect = fixture.snapshot().selectWorkspace;
      fixture.emit(actorA, "USER_UPDATED");
      await fixture.renderer.flush();
      await fixture.respond(fixture.request(actorA, 1), success([mortgage()].map((entry) => ({ ...entry, purpose }))));
      assertUnselected(fixture);
      oldSelect(workspaceB);
      await fixture.renderer.flush();
      assertUnselected(fixture);
    });
  }
});

test("account A to B clears context, both caches and membership refs synchronously before B token/response", async () => {
  await withFixture(async (fixture) => {
    await confirm(fixture, [membership(), mortgage()]);
    fixture.snapshot().selectWorkspace(workspaceA);
    await fixture.renderer.flush();
    const oldSelect = fixture.snapshot().selectWorkspace;
    fixture.seedCaches();
    const clearStart = fixture.cacheClears.length;
    const tokenGate = deferred<string>();
    fixture.token((expected) => expected === actorB ? tokenGate.promise : Promise.resolve("local-unused-token"));
    fixture.emit(actorB);
    assertCachesEmpty(fixture, clearStart);
    fixture.renderer.commit();
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().user?.id, actorB);
    assert.equal(fixture.snapshot().isLoading, true);
    assert.equal(fixture.snapshot().isStaffMode, false);
    assert.equal(fixture.requests.length, 1, "B token is still pending");
    oldSelect(workspaceA);
    fixture.renderer.commit();
    assertUnselected(fixture);
    tokenGate.resolve("local-b-gated-token");
    await fixture.renderer.flush();
    assert.deepEqual(fixture.tokenCalls, [actorA, actorB]);
    assertUnselected(fixture);
    await fixture.respond(fixture.request(actorB), success([mortgage()]));
    assert.equal(fixture.snapshot().workspacePurpose, "mortgage_leads");
  });
});

for (const timing of ["while B is pending", "after B is confirmed"] as const) {
  test(`late A bootstrap success cannot overwrite B ${timing}`, async () => {
    await withFixture(async (fixture) => {
      const previous = fixture.request(actorA);
      fixture.emit(actorB);
      await fixture.renderer.flush();
      if (timing === "after B is confirmed") await fixture.respond(fixture.request(actorB), success([mortgage()]));
      const before = effects(fixture);
      await fixture.respond(previous, success([membership()]));
      assert.deepEqual(effects(fixture), before, "expired success must not write state, selector, cache or toast");
      assert.equal(fixture.snapshot().user?.id, actorB);
      if (timing === "while B is pending") {
        assertUnselected(fixture);
        await fixture.respond(fixture.request(actorB), success([mortgage()]));
      }
      assert.equal(fixture.snapshot().workspacePurpose, "mortgage_leads");
    });
  });
}

test("late A denial or unavailable response cannot revoke B or announce A's failure", async () => {
  for (const status of [200, 401, 403, 503]) {
    await withFixture(async (fixture) => {
      const previous = fixture.request(actorA);
      fixture.emit(actorB);
      await fixture.renderer.flush();
      await fixture.respond(fixture.request(actorB), success([mortgage()]));
      const before = effects(fixture);
      await fixture.respond(previous, status === 200 ? success([]) : { success: false }, status);
      assert.deepEqual(effects(fixture), before, `expired status ${status}`);
    });
  }
});

for (const result of ["success", "denial"] as const) {
  test(`ABA auth events reject the first A generation's late ${result} even though its user ID matches again`, async () => {
    await withFixture(async (fixture) => {
      const firstA = fixture.request(actorA);
      fixture.emit(actorB);
      await fixture.renderer.flush();
      const firstB = fixture.request(actorB);
      fixture.emit(actorA);
      await fixture.renderer.flush();
      const currentA = fixture.request(actorA, 1);
      assertUnselected(fixture);
      const pending = effects(fixture);
      await fixture.respond(firstA, result === "success" ? success([membership()]) : { success: false }, result === "success" ? 200 : 403);
      assert.deepEqual(effects(fixture), pending);
      await fixture.respond(currentA, success([mortgage()]));
      const confirmed = effects(fixture);
      await fixture.respond(firstB, success([membership({ purpose: "marketing" })]));
      assert.deepEqual(effects(fixture), confirmed);
      assert.equal(fixture.snapshot().user?.id, actorA);
      assert.equal(fixture.snapshot().workspacePurpose, "mortgage_leads");
      assert.deepEqual(fixture.tokenCalls, [actorA, actorB, actorA]);
    });
  });
}

test("SIGNED_OUT invalidates pending bootstrap success and denial without restoring context", async () => {
  for (const status of [200, 403]) {
    await withFixture(async (fixture) => {
      const previous = fixture.request(actorA);
      fixture.emit(null);
      await fixture.renderer.flush();
      assertUnselected(fixture);
      assert.equal(fixture.snapshot().user, null);
      assert.equal(fixture.snapshot().session, null);
      assert.equal(fixture.snapshot().isLoading, false);
      const before = effects(fixture);
      await fixture.respond(previous, status === 200 ? success([mortgage()]) : { success: false }, status);
      assert.deepEqual(effects(fixture), before);
    });
  }
});

test("signOut clears the confirmed profile and invalidates rechecks before a pending SDK logout resolves", async () => {
  await withFixture(async (fixture) => {
    await confirm(fixture, [membership(), mortgage()]);
    fixture.snapshot().selectWorkspace(workspaceB);
    await fixture.renderer.flush();
    fixture.emit(actorA, "USER_UPDATED");
    await fixture.renderer.flush();
    const recheck = fixture.request(actorA, 1);
    const gate = fixture.holdSignOut();
    fixture.seedCaches();
    const clearStart = fixture.cacheClears.length;
    const signingOut = fixture.snapshot().signOut();
    assertCachesEmpty(fixture, clearStart);
    await fixture.renderer.flush();
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().user, null);
    assert.equal(fixture.snapshot().session, null);
    assert.equal(fixture.sdkCalls().signOut, 1);
    const before = effects(fixture);
    await fixture.respond(recheck, success([membership()]));
    assert.deepEqual(effects(fixture), before);
    gate.resolve();
    await signingOut;
    await fixture.renderer.flush();
    assertUnselected(fixture);
  });
});

test("same-account USER_UPDATED plus 503 preserves confirmed role, purpose, choices and both caches", async () => {
  await withFixture(async (fixture) => {
    await confirm(fixture, [membership(), mortgage()]);
    fixture.snapshot().selectWorkspace(workspaceB);
    await fixture.renderer.flush();
    fixture.seedCaches();
    const before = context(fixture), clearStart = fixture.cacheClears.length;
    fixture.emit(actorA, "USER_UPDATED");
    await fixture.renderer.flush();
    assert.deepEqual(context(fixture), before, "confirmed context remains during the same-user recheck");
    await fixture.respond(fixture.request(actorA, 1), { success: false }, 503);
    assert.deepEqual(context(fixture), before);
    assert.equal(fixture.caches.crm.size, 1);
    assert.equal(fixture.caches.lists.size, 1);
    assert.equal(fixture.cacheClears.length, clearStart);
    assert.equal(fixture.storage.getItem(selectorKey), workspaceB);
  });
});

test("new-account 503 cannot inherit A's confirmed role, purpose, choices, refs or cached data", async () => {
  await withFixture(async (fixture) => {
    await confirm(fixture, [membership(), mortgage()]);
    fixture.snapshot().selectWorkspace(workspaceB);
    await fixture.renderer.flush();
    const oldSelect = fixture.snapshot().selectWorkspace;
    fixture.seedCaches();
    const clearStart = fixture.cacheClears.length;
    fixture.emit(actorB, "USER_UPDATED");
    await fixture.renderer.flush();
    assertUnselected(fixture);
    assertCachesEmpty(fixture, clearStart);
    await fixture.respond(fixture.request(actorB), { success: false }, 503);
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().user?.id, actorB);
    assert.equal(fixture.snapshot().isLoading, false);
    oldSelect(workspaceB);
    await fixture.renderer.flush();
    assertUnselected(fixture);
  });
});

test("same-user owner downgrade to lead_manager applies new permissions and clears both read caches", async () => {
  await withFixture(async (fixture) => {
    const owned = mortgage();
    await confirm(fixture, [{ ...owned, role: "owner", permissions: ["view_clients", "manage_staff"] }]);
    assert.equal(fixture.snapshot().rolePermissions.admin, true);
    fixture.seedCaches();
    const clearStart = fixture.cacheClears.length;
    fixture.emit(actorA, "USER_UPDATED");
    await fixture.renderer.flush();
    await fixture.respond(fixture.request(actorA, 1), success([owned]));
    assert.equal(fixture.snapshot().userRole, "lead_manager");
    assert.equal(fixture.snapshot().workspacePurpose, "mortgage_leads");
    assert.equal(fixture.snapshot().rolePermissions.admin, false);
    assert.equal(fixture.snapshot().rolePermissions.dashboard, false);
    assert.equal(fixture.snapshot().rolePermissions.crm, true);
    assert.equal(fixture.snapshot().availableWorkspaces[0].role, "lead_manager");
    assertCachesEmpty(fixture, clearStart);
  });
});

test("same-user authoritative membership revocation clears purpose, role, choices, refs and both caches", async () => {
  await withFixture(async (fixture) => {
    await confirm(fixture, [mortgage()]);
    const oldSelect = fixture.snapshot().selectWorkspace;
    fixture.seedCaches();
    const clearStart = fixture.cacheClears.length;
    fixture.emit(actorA, "USER_UPDATED");
    await fixture.renderer.flush();
    await fixture.respond(fixture.request(actorA, 1), success([]));
    assertUnselected(fixture);
    assertCachesEmpty(fixture, clearStart);
    assert.equal(fixture.snapshot().user?.id, actorA);
    oldSelect(workspaceB);
    await fixture.renderer.flush();
    assertUnselected(fixture);
  });
});

test("same-user overlapping bootstrap generations cannot let an older denial revoke the newer confirmed profile", async () => {
  await withFixture(async (fixture) => {
    await confirm(fixture);
    fixture.emit(actorA, "USER_UPDATED");
    await fixture.renderer.flush();
    const old = fixture.request(actorA, 1);
    fixture.emit(actorA, "USER_UPDATED");
    await fixture.renderer.flush();
    await fixture.respond(fixture.request(actorA, 2), success([mortgage()]));
    const before = effects(fixture);
    await fixture.respond(old, { success: false }, 403);
    assert.deepEqual(effects(fixture), before);
  });
});

test("a callback-confirmed B session cannot be overwritten by a delayed initial getSession A/null snapshot", async () => {
  for (const initial of [actorA, null]) {
    await withFixture(async (fixture) => {
      assert.equal(fixture.subscriptions(), 1);
      assert.equal(fixture.sdkCalls().getSession, 1);
      assert.equal(fixture.requests.length, 0);
      fixture.emit(actorB);
      await fixture.renderer.flush();
      await fixture.respond(fixture.request(actorB), success([mortgage()]));
      const before = effects(fixture);
      fixture.sessionGate.resolve({ data: { session: localSession(initial) } });
      await fixture.renderer.flush();
      assert.deepEqual(effects(fixture), before);
      assert.equal(fixture.requests.length, 1, "late initial snapshot cannot dispatch a previous actor bootstrap");
      assert.deepEqual(fixture.tokenCalls, [actorB]);
    }, { deferSession: true });
  }
});

test("a pending expected-user token lookup cannot dispatch or apply A after the auth callback switches to B", async () => {
  await withFixture(async (fixture) => {
    const gate = deferred<string>();
    fixture.token((expected) => expected === actorA ? gate.promise : Promise.resolve("local-b-token"));
    fixture.sessionGate.resolve({ data: { session: localSession(actorA) } });
    await fixture.renderer.flush();
    assert.deepEqual(fixture.tokenCalls, [actorA]);
    assert.equal(fixture.requests.length, 0);
    fixture.emit(actorB);
    await fixture.renderer.flush();
    await fixture.respond(fixture.request(actorB), success([mortgage()]));
    const before = effects(fixture);
    gate.resolve("local-delayed-a-token");
    await fixture.renderer.flush();
    assert.deepEqual(effects(fixture), before);
    assert.deepEqual(fixture.tokenCalls, [actorA, actorB]);
    assert.equal(fixture.requests.length, 1);
  }, { deferSession: true });
});

test("a response body resolved after rerender cannot apply the previous account's parsed profile", async () => {
  await withFixture(async (fixture) => {
    const body = deferred<string>();
    fixture.request(actorA).resolve({ ok: true, status: 200, text: () => body.promise } as Response);
    await fixture.renderer.flush();
    fixture.emit(actorB);
    await fixture.renderer.flush();
    await fixture.respond(fixture.request(actorB), success([mortgage()]));
    const before = effects(fixture);
    body.resolve(JSON.stringify(success([membership()])));
    await fixture.renderer.flush();
    assert.deepEqual(effects(fixture), before);
  });
});

test("provider unmount unsubscribes and pending bootstrap success/denial cannot even attempt a state write", async () => {
  for (const status of [200, 403, 503]) {
    await withFixture(async (fixture) => {
      const pending = fixture.request(actorA);
      fixture.renderer.dispose();
      assert.equal(fixture.subscriptions(), 0);
      const before = effects(fixture);
      fixture.emit(actorB);
      await fixture.respond(pending, status === 200 ? success([mortgage()]) : { success: false }, status);
      assert.deepEqual(effects(fixture), before);
      assert.equal(fixture.requests.length, 1);
    });
  }
});

test("provider unmount during the initial getSession gate cannot dispatch bootstrap or set state", async () => {
  await withFixture(async (fixture) => {
    fixture.renderer.dispose();
    const before = effects(fixture);
    fixture.sessionGate.resolve({ data: { session: localSession(actorA) } });
    await fixture.renderer.flush();
    assert.deepEqual(effects(fixture), before);
    assert.equal(fixture.subscriptions(), 0);
    assert.equal(fixture.requests.length, 0);
    assert.deepEqual(fixture.tokenCalls, []);
  }, { deferSession: true });
});

test("legacy demo restoration after a signed-out boundary resets mortgage profile and refuses stale memberships", async () => {
  await withFixture(async (fixture) => {
    await confirm(fixture, [mortgage()]);
    const oldSelect = fixture.snapshot().selectWorkspace;
    fixture.emit(actorA, "USER_UPDATED");
    await fixture.renderer.flush();
    const oldReply = fixture.request(actorA, 1);
    fixture.storage.setItem("negis_demo_user", JSON.stringify({ id: "local-profile-demo-user", name: "Local demo", purpose: "mortgage_leads" }));
    fixture.storage.setItem("negis_demo_workspace", JSON.stringify({ id: "local-profile-demo-workspace", name: "Local demo", purpose: "mortgage_leads", vertical: "beauty" }));
    fixture.storage.setItem("negis_demo_session", JSON.stringify({ mode: "demo", authenticated: true, createdAt: "2026-01-01T00:00:00Z" }));
    fixture.emit(null);
    await fixture.renderer.flush();
    assert.equal(fixture.snapshot().isDemoMode, true);
    assert.equal(fixture.snapshot().workspacePurpose, "clinic_services", "legacy demo uses its explicit clinic profile, not previous mortgage purpose");
    assert.equal(fixture.snapshot().vertical, terms.DEFAULT_VERTICAL);
    assert.deepEqual(clone(fixture.snapshot().availableWorkspaces), []);
    const before = effects(fixture);
    await fixture.respond(oldReply, success([mortgage()]));
    assert.deepEqual(effects(fixture), before);
    oldSelect(workspaceB);
    await fixture.renderer.flush();
    assert.equal(fixture.snapshot().clinicId, "local-profile-demo-workspace");
    assert.equal(fixture.snapshot().workspacePurpose, "clinic_services");
    await fixture.snapshot().signOut();
    await fixture.renderer.flush();
    assertUnselected(fixture);
    assert.equal(fixture.snapshot().user, null);
    assert.equal(fixture.snapshot().isDemoMode, false);
    assert.equal(fixture.storage.getItem("negis_demo_workspace"), null);
  });
});

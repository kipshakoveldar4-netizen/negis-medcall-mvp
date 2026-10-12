import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Execute the current page and transport with local hooks/SDK fixtures only.
// No application bootstrap, environment, browser, credentials or network.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const read = (file: string) => readFile(path.join(root, file), "utf8");
const adminSource = await read("artifacts/negis/src/pages/AdminCenter.tsx");
const apiSource = await read("artifacts/negis/src/lib/api.ts");
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

type Node = { type: any; props: Record<string, any>; key?: unknown };
const jsx = (type: any, props: Node["props"], key?: unknown): Node => ({ type, props, key });
function nodes(value: any): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  return [value, ...nodes(value.props.children), ...nodes(value.props.actions), ...nodes(value.props.action)];
}
function label(value: any): string {
  if (Array.isArray(value)) return value.map(label).join("");
  if (value && typeof value === "object") return label(value.props?.children);
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function evaluate(source: string, bindings: Record<string, unknown> = {}, imports: Record<string, unknown> = {}) {
  const exports: Record<string, any> = {};
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  new Script(code).runInNewContext({ exports, AbortController, AbortSignal, DOMException, Headers, Response,
    URLSearchParams, ...bindings,
    require(name: string) {
      if (name in imports) return imports[name];
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "lucide-react" || name.startsWith("@/components/")) {
        return new Proxy({}, { get: (_target, property) => String(property) });
      }
      throw new Error(`Unmocked import: ${name}`);
    },
  });
  return exports;
}
function select(source: string, names: string[]) {
  const ast = ts.createSourceFile("fixture.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return ast.statements.filter((node) =>
    ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && names.includes(node.name?.text ?? ""))
    || (ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => names.includes(item.name.getText(ast)))))
    .map((node) => node.getText(ast)).join("\n") + `\nexports.selected = { ${names.join(", ")} };`;
}

// Insert an observation point, not replacement logic, into the actual closure.
function observeContent(source: string) {
  const ast = ts.createSourceFile("AdminCenter.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const content = ast.statements.find((node) => ts.isFunctionDeclaration(node)
    && node.name?.text === "AdminCenterContent") as import("typescript").FunctionDeclaration | undefined;
  assert.ok(content?.body, "AdminCenterContent must exist in the final local UI implementation");
  const returned = content.body.statements.filter(ts.isReturnStatement).at(-1);
  assert.ok(returned, "content must render after defining its real action closures");
  const capture = `\n__capture({ serverAdminAuth, staff, createdStaff, issuedInvite, invitations,
    batchResults, batchEmails, staffPassword, inviteForm, loading, joinRequests, joinCode,
    setActiveTab, setInviteForm, setStaffPassword, setBatchEmails,
    checkServerAdminAccess, loadStaff, loadInvitations, sendInvitation, createStaffWithPassword,
    createStaffBatch, resetStaffPassword, reissueInvitation, updateStaffStatus,
    crmFetch, crmRequest, adminCrmRequest });\n`;
  return source.slice(0, returned.getStart(ast)) + capture + source.slice(returned.getStart(ast))
    + "\nexports.fixture = { AdminCenterSession, AdminCenterContent };";
}

const sameDeps = (left?: unknown[], right?: unknown[]) => Boolean(left && right && left.length === right.length
  && left.every((value, index) => Object.is(value, right[index])));
type Instance = { type: any; key: unknown; props: any; slots: any[]; cursor: number; output: any; disposed: boolean };
function hookRenderer() {
  const instances = new Map<string, Instance>();
  const writes: { instance: Instance; value: any }[] = [];
  let current: Instance;
  let rootNode: Node;
  let tree: any;
  let dirty = true;
  let mounted = true;
  const own = new Set<any>();
  function cleanup(instance: Instance) {
    instance.disposed = true;
    for (const slot of instance.slots) slot?.cleanup?.();
  }
  function render(node: Node, address: string): any {
    let instance = instances.get(address);
    if (instance && (instance.type !== node.type || instance.key !== node.key)) {
      for (const [key, old] of [...instances]) {
        if (key === address || key.startsWith(`${address}/`)) { cleanup(old); instances.delete(key); }
      }
      instance = undefined;
    }
    if (!instance) {
      instance = { type: node.type, key: node.key, props: node.props, slots: [], cursor: 0, output: null, disposed: false };
      instances.set(address, instance);
    }
    current = instance; instance.cursor = 0; instance.props = node.props;
    instance.output = node.type(node.props);
    const childAddress = `${address}/child`;
    if (instance.output && own.has(instance.output.type)) return render(instance.output, childAddress);
    for (const [key, old] of [...instances]) {
      if (key === childAddress || key.startsWith(`${childAddress}/`)) { cleanup(old); instances.delete(key); }
    }
    return instance.output;
  }
  function effect(create: () => any, deps?: unknown[], layout = false) {
    const index = current.cursor++;
    const old = current.slots[index];
    current.slots[index] = { create, deps, layout, cleanup: old?.cleanup, pending: !old || !sameDeps(old.deps, deps) };
  }
  const hooks = {
    useState(initial: any) {
      const instance = current, index = instance.cursor++;
      instance.slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [instance.slots[index].value, (update: any) => {
        const value = typeof update === "function" ? update(instance.slots[index].value) : update;
        writes.push({ instance, value });
        if (!instance.disposed && !Object.is(value, instance.slots[index].value)) {
          instance.slots[index].value = value; dirty = true;
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
  return {
    hooks, writes,
    mount(type: any, children: any[]) { children.forEach((child) => own.add(child)); own.add(type); rootNode = jsx(type, {}); },
    invalidate() { dirty = true; },
    async flush() {
      for (let pass = 0; pass < 100; pass++) {
        if (mounted && dirty) {
          dirty = false; tree = render(rootNode, "root");
          for (const layout of [true, false]) {
            const pending = [...instances.values()].flatMap((item) => item.slots)
              .filter((item) => item?.pending && item.layout === layout);
            for (const item of pending) item.cleanup?.();
            for (const item of pending) { item.pending = false; item.cleanup = item.create(); }
          }
        }
        await Promise.resolve();
      }
      assert.equal(dirty, false, "hook renderer must settle");
    },
    instance(name: string) {
      const found = [...instances.values()].find((item) => item.type.name === name);
      assert.ok(found, `missing mounted ${name}`); return found;
    },
    replaySessionLayout() {
      const session = this.instance("AdminCenterSession");
      const effects = session.slots.filter((item) => item?.layout);
      assert.ok(effects.length, "session must own a layout lifetime");
      for (const item of effects) item.cleanup?.();
      for (const item of effects) item.cleanup = item.create();
    },
    tree: () => tree,
    dispose() { mounted = false; dirty = false; for (const instance of instances.values()) cleanup(instance); instances.clear(); },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const actorA = "00000000-0000-4000-8000-000000000001";
const actorB = "00000000-0000-4000-8000-000000000002";
const workspaceA = "00000000-0000-4000-8000-000000000003";
const workspaceB = "00000000-0000-4000-8000-000000000004";
const roster = [{ id: "staff-local", authUserId: "roster-user", name: "Owner-only local roster",
  email: "local.roster@example.test", role: "receptionist", status: "active", permissions: [] }];
const invitation = { id: "invite-local", email: "invited@example.test", role: "receptionist", status: "pending" };
const ok = (data: unknown = {}) => Response.json({ success: true, mode: "supabase", data });
const authBody = (patch: Record<string, unknown> = {}) => ({ success: true, mode: "supabase",
  data: { workspaceId: workspaceA, role: "owner", staffUserId: "owner-local", isAdmin: true, ...patch } });
type Init = RequestInit & { expectedUserId?: string; accessToken?: string };
type Reply = (url: string, init: Init) => Promise<Response>;
const permissions = evaluate(await read("artifacts/negis/src/lib/permissions.ts"));
const logins = evaluate(await read("lib/auth/staff-logins.ts"));
const terms = evaluate(await read("lib/vertical/terms.ts"));

function setup() {
  const renderer = hookRenderer();
  const callbacks = new Set<(event: string, session: any) => void>();
  const calls: { path: string; init: Init }[] = [];
  const dispatches: { path: string; init: Init }[] = [];
  const tokenCalls: (string | undefined)[] = [];
  const toasts: { kind: string; message: string }[] = [];
  const stored = new Map<string, string>();
  const storageWrites: string[] = [];
  let snapshot: any;
  let auth = { user: { id: actorA, email: "owner@example.test" }, userRole: "owner", clinicId: workspaceA,
    vertical: "clinic", rolePermissions: { admin: true }, session: {}, availableWorkspaces: [], isDemoMode: false };
  let sdkActor = actorA;
  let tokenReply: ((expected?: string) => Promise<string>) | undefined;
  let transportReply: Reply | undefined;
  const getToken = async (expected?: string) => {
    tokenCalls.push(expected);
    if (tokenReply) return tokenReply(expected);
    return expected && expected !== sdkActor ? "" : "local-fixture-token";
  };
  const transport = async (url: string, init: Init) => {
    dispatches.push({ path: url, init });
    if (transportReply) return transportReply(url, init);
    const resource = url.split("?")[0].split("/").pop();
    if (resource === "auth-context") return Response.json(authBody({ workspaceId: auth.clinicId,
      role: auth.userRole, isAdmin: ["owner", "admin"].includes(auth.userRole) }));
    if (resource === "staff") return ok({ staff: roster });
    if (resource === "staff-invitations") return ok({ invitations: [invitation], acceptUrl: "https://example.test/local-invite" });
    if (resource === "staff-credentials") return ok({ login: "issued.local" });
    if (resource === "join-code") return ok({ code: "LOCAL123" });
    return ok({ requests: [], launches: [], runs: [], insights: [] });
  };
  // Keep the real crmFetch token-wait/abort behavior without loading import.meta.env
  // or resolving a real SDK. Every possible fetch is this in-memory dispatcher.
  const api = evaluate(select(apiSource, ["CrmApiError", "crmErrorMessage", "crmFetch", "clearCrmCache",
    "inflightGets", "getCache", "REFERENCE_TTL_MS", "LIST_TTL_MS", "cacheEpoch", "isUncacheable", "ttlFor"]), {
    resolveAccessToken: (_explicit?: string, expected?: string) => getToken(expected),
    apiUrl: (url: string) => url, fetch: transport,
  }).selected;
  const importedFetch = (url: string, init: Init = {}) => { calls.push({ path: url, init }); return api.crmFetch(url, init); };
  const module = evaluate(observeContent(adminSource), {
    __capture: (value: any) => { snapshot = value; },
    crypto: { getRandomValues: (bytes: Uint32Array) => { bytes.fill(17); return bytes; } },
    window: { location: { search: "" }, confirm: () => true, localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { storageWrites.push(key); stored.set(key, value); },
    } },
    navigator: { clipboard: { writeText: async () => {} } },
  }, {
    react: renderer.hooks, wouter: { Link: "Link", useLocation: () => ["/admin", () => {}] },
    sonner: { toast: new Proxy({}, { get: (_target, kind) => (message: string) => toasts.push({ kind: String(kind), message }) }) },
    "@/contexts/AuthContext": { useAuth: () => auth },
    "@/lib/supabase": { hasSupabaseFrontendEnv: true, supabase: { auth: { onAuthStateChange(callback: any) {
      callbacks.add(callback); return { data: { subscription: { unsubscribe: () => callbacks.delete(callback) } } };
    } } } },
    "@/lib/api": { ...api, crmFetch: importedFetch, apiUrl: (url: string) => url },
    "@/lib/serverAuth": { getSupabaseAccessToken: getToken },
    "@/lib/demoStorage": { readWorkspaceId: () => auth.clinicId, workspaceScopedKey: (key: string) => `${auth.clinicId}:${key}` },
    "@/lib/permissions": permissions,
    "../../../../lib/auth/staff-logins": logins,
    "../../../../lib/vertical/terms": terms,
    "../../../../lib/crm/join-codes": { formatJoinCode: (value: string) => value },
    "../../../../lib/meta/cities": { KZ_META_CITY_OPTIONS: [], getKzMetaCityOption: () => null },
  });
  renderer.mount(module.default, [module.fixture.AdminCenterSession, module.fixture.AdminCenterContent]);
  return {
    renderer, calls, dispatches, tokenCalls, toasts, storageWrites, snapshot: () => snapshot,
    access: () => renderer.instance("AdminCenterContent").props.access,
    emit(id: string | null, event = id ? "SIGNED_IN" : "SIGNED_OUT") {
      sdkActor = id || "";
      for (const callback of [...callbacks]) callback(event, id ? { user: { id } } : null);
    },
    setAuth(patch: Partial<typeof auth>) { auth = { ...auth, ...patch }; renderer.invalidate(); },
    reply(value?: Reply) { transportReply = value; },
    token(value?: typeof tokenReply) { tokenReply = value; },
    subscriptions: () => callbacks.size,
  };
}
type Fixture = ReturnType<typeof setup>;
async function ready() {
  const fixture = setup(); await fixture.renderer.flush();
  assert.equal(fixture.snapshot().serverAdminAuth.status, "confirmed");
  return fixture;
}
async function staffTab(fixture: Fixture) {
  fixture.snapshot().setActiveTab("staff"); await fixture.renderer.flush();
  assert.deepEqual(clone(fixture.snapshot().staff), roster);
}
function contentWrites(fixture: Fixture, instance: Instance, start: number) {
  return fixture.renderer.writes.slice(start).filter((write) => write.instance === instance);
}
function authPanel(fixture: Fixture) {
  return nodes(fixture.renderer.tree()).find((node) => node.props["data-testid"] === "server-admin-auth");
}

const staffUi = {
  add: "\u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c \u0441\u043e\u0442\u0440\u0443\u0434\u043d\u0438\u043a\u0430",
  passwordMode: "\u041b\u043e\u0433\u0438\u043d \u0438 \u043f\u0430\u0440\u043e\u043b\u044c",
  inviteMode: "\u0421\u0441\u044b\u043b\u043a\u0430-\u043f\u0440\u0438\u0433\u043b\u0430\u0448\u0435\u043d\u0438\u0435",
  generate: "\u0421\u0433\u0435\u043d\u0435\u0440\u0438\u0440\u043e\u0432\u0430\u0442\u044c",
  invite: "\u041e\u0442\u043f\u0440\u0430\u0432\u0438\u0442\u044c \u043f\u0440\u0438\u0433\u043b\u0430\u0448\u0435\u043d\u0438\u0435",
  bulk: "\u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c \u0441\u0440\u0430\u0437\u0443 \u043d\u0435\u0441\u043a\u043e\u043b\u044c\u043a\u0438\u0445",
  bulkSubmit: "\u0417\u0430\u0432\u0435\u0441\u0442\u0438 \u0432\u0441\u0435\u0445",
  checkAccess: "\u041f\u0440\u043e\u0432\u0435\u0440\u0438\u0442\u044c \u0434\u043e\u0441\u0442\u0443\u043f",
  staffName: "\u0418\u043c\u044f \u0441\u043e\u0442\u0440\u0443\u0434\u043d\u0438\u043a\u0430",
  staffEmail: "\u041f\u043e\u0447\u0442\u0430 \u0441\u043e\u0442\u0440\u0443\u0434\u043d\u0438\u043a\u0430",
  copySingle: "\u0421\u043a\u043e\u043f\u0438\u0440\u043e\u0432\u0430\u0442\u044c \u043b\u043e\u0433\u0438\u043d \u0438 \u043f\u0430\u0440\u043e\u043b\u044c",
  copyBulk: "\u0421\u043a\u043e\u043f\u0438\u0440\u043e\u0432\u0430\u0442\u044c \u0441\u043f\u0438\u0441\u043e\u043a",
  copyInvite: "\u0421\u043a\u043e\u043f\u0438\u0440\u043e\u0432\u0430\u0442\u044c \u0441\u0441\u044b\u043b\u043a\u0443",
};
function buttons(fixture: Fixture, text: string) {
  return nodes(fixture.renderer.tree()).filter((node) => node.type === "button" && label(node).trim() === text);
}
function button(fixture: Fixture, text: string) {
  const matches = buttons(fixture, text);
  assert.equal(matches.length, 1, "expected exactly one rendered action");
  assert.equal(typeof matches[0].props.onClick, "function");
  assert.ok(!matches[0].props.disabled, "rendered action must remain usable");
  return matches[0];
}
function staffCreation(fixture: Fixture) {
  return nodes(fixture.renderer.tree()).find((node) => node.type === "section"
    && nodes(node.props.children).some((child) => child.type === "h2" && label(child) === staffUi.add));
}
function formControls(fixture: Fixture) {
  const section = staffCreation(fixture);
  assert.ok(section, "confirmed staff access must render the creation section");
  return nodes(section).filter((node) => ["input", "select", "textarea"].includes(node.type));
}
async function tab(fixture: Fixture, activeTab: "overview" | "staff") {
  fixture.snapshot().setActiveTab(activeTab); await fixture.renderer.flush();
}
function renderedText(fixture: Fixture) {
  return label(fixture.renderer.tree()) + nodes(fixture.renderer.tree())
    .map((node) => typeof node.props.value === "string" ? node.props.value : "").join("\n");
}
function assertStaffHidden(fixture: Fixture, markers: string[] = []) {
  assert.equal(staffCreation(fixture), undefined, "staff creation must be absent, not merely disabled");
  for (const text of Object.values(staffUi).filter((value) => value !== staffUi.checkAccess)) {
    assert.equal(buttons(fixture, text).length, 0, "staff modes, actions and credential-copy controls must be hidden");
  }
  assert.equal(nodes(fixture.renderer.tree()).filter((node) => node.type === "input" || node.type === "textarea"
    || (node.type === "select" && !["overview", "staff"].includes(node.props.value))).length, 0,
  "single/password/invitation/bulk inputs and role selectors must be absent");
  for (const marker of markers) {
    assert.ok(!renderedText(fixture).includes(marker), "synthetic credential results and drafts must not remain rendered");
  }
}
async function assertBothStaffViewsHidden(fixture: Fixture, markers: string[] = []) {
  await tab(fixture, "staff"); assertStaffHidden(fixture, markers);
  await tab(fixture, "overview"); assertStaffHidden(fixture, markers);
}
function staffResults(fixture: Fixture) {
  const { createdStaff, issuedInvite, batchResults } = fixture.snapshot();
  return clone({ createdStaff, issuedInvite, batchResults });
}
async function seedStaffResults(fixture: Fixture) {
  await staffTab(fixture);
  fixture.snapshot().setInviteForm({ email: "single.fixture", role: "receptionist" });
  fixture.snapshot().setStaffPassword("LocalFixtureOnly234"); await fixture.renderer.flush();
  await button(fixture, staffUi.add).props.onClick(); await fixture.renderer.flush();
  button(fixture, staffUi.bulk).props.onClick(); await fixture.renderer.flush();
  formControls(fixture).find((node) => node.type === "textarea")!.props.onChange({ target: {
    value: "first.bulk@example.test\nsecond.bulk@example.test",
  } });
  await fixture.renderer.flush();
  button(fixture, staffUi.bulkSubmit).props.onClick(); await fixture.renderer.flush();
  button(fixture, staffUi.inviteMode).props.onClick(); await fixture.renderer.flush();
  formControls(fixture).find((node) => node.type === "input" && node.props.type === "email")!.props.onChange({ target: {
    value: "issued.fixture@example.test",
  } });
  await fixture.renderer.flush();
  await button(fixture, staffUi.invite).props.onClick(); await fixture.renderer.flush();
  const results = staffResults(fixture);
  assert.ok(results.createdStaff?.password, "exercise real single creation with a fake local response");
  assert.ok(results.issuedInvite?.acceptUrl, "exercise real invitation creation with a fake local response");
  assert.equal(results.batchResults.length, 2, "exercise both sequential bulk rows");
  assert.ok(results.batchResults.every((row: any) => row.kind === "created" && row.password));
  const markers: string[] = [results.createdStaff.email, results.createdStaff.password, results.issuedInvite.email,
    results.issuedInvite.acceptUrl, ...results.batchResults.flatMap((row: any) => [row.source, row.login, row.password])];
  for (const marker of markers) assert.ok(renderedText(fixture).includes(marker), "synthetic result must first be visible");
  for (const text of [staffUi.copySingle, staffUi.copyBulk, staffUi.copyInvite]) button(fixture, text);
  return { results, markers };
}

test("raw SDK A-B-A changes the outer epoch and permanently expires the old lifetime before context catches up", async () => {
  const fixture = await ready();
  try {
    const session = fixture.renderer.instance("AdminCenterSession");
    const access = fixture.access();
    const key = session.key;
    fixture.emit(actorA, "TOKEN_REFRESHED"); await fixture.renderer.flush();
    assert.equal(fixture.renderer.instance("AdminCenterSession").key, key, "same-actor refresh must not remount");
    fixture.emit(actorB); fixture.emit(actorA);
    assert.equal(access.isCurrent(), false, "batched A-B-A cannot revive A's previous controller");
    await fixture.renderer.flush();
    assert.notEqual(fixture.renderer.instance("AdminCenterSession").key, key);
    assert.deepEqual(JSON.parse(String(fixture.renderer.instance("AdminCenterSession").key)), [actorA, workspaceA, "owner", false, 2]);
    assert.equal(fixture.access().isCurrent(), true);
    assert.equal(access.isCurrent(), false);
  } finally { fixture.renderer.dispose(); }
});

test("actor, workspace and same-actor role changes each remount content and expire captured access", async () => {
  for (const patch of [{ user: { id: actorB, email: "head@example.test" } }, { clinicId: workspaceB }, { userRole: "manager" }]) {
    const fixture = await ready();
    try {
      const old = fixture.renderer.instance("AdminCenterContent"), access = fixture.access();
      const key = fixture.renderer.instance("AdminCenterSession").key;
      fixture.setAuth(patch); await fixture.renderer.flush();
      assert.equal(access.isCurrent(), false);
      assert.equal(old.disposed, true);
      assert.notEqual(fixture.renderer.instance("AdminCenterContent"), old);
      assert.notEqual(fixture.renderer.instance("AdminCenterSession").key, key);
    } finally { fixture.renderer.dispose(); }
  }
});

test("disposal unsubscribes and rejects retained requests; StrictMode recreation owns a fresh content lifetime", async () => {
  const fixture = await ready();
  const access = fixture.access(), old = fixture.renderer.instance("AdminCenterContent");
  const closure = fixture.snapshot();
  const baseline = fixture.calls.length;
  fixture.renderer.replaySessionLayout(); await fixture.renderer.flush();
  assert.equal(access.isCurrent(), false);
  assert.equal(old.disposed, true);
  assert.equal(fixture.access().isCurrent(), true);
  assert.notEqual(fixture.renderer.instance("AdminCenterContent"), old);
  const afterReplay = fixture.calls.length;
  await assert.rejects(closure.crmFetch("/api/crm/staff"), { name: "AbortError" });
  assert.equal(fixture.calls.length, afterReplay, "retained StrictMode callback cannot enter transport");
  assert.ok(afterReplay >= baseline);
  const nextAccess = fixture.access(), nextClosure = fixture.snapshot();
  fixture.renderer.dispose();
  assert.equal(nextAccess.isCurrent(), false);
  assert.equal(fixture.subscriptions(), 0);
  await assert.rejects(nextClosure.crmFetch("/api/crm/staff"), { name: "AbortError" });
  assert.equal(fixture.calls.length, afterReplay);
});

test("both raw fetch and parsed request bind no-store, expected actor and the session abort signal", async () => {
  const fixture = await ready();
  try {
    const closure = fixture.snapshot();
    await closure.crmFetch("/api/crm/staff", { cache: "force-cache", expectedUserId: actorB });
    const first = fixture.calls.at(-1)!;
    await closure.crmRequest("/api/crm/staff");
    const second = fixture.calls.at(-1)!;
    await closure.adminCrmRequest("/api/crm/meta-launches");
    const admin = fixture.calls.at(-1)!;
    for (const call of [first, second, admin]) {
      assert.equal(call.init.expectedUserId, actorA);
      assert.equal(call.init.cache, "no-store");
      assert.ok(call.init.signal);
      assert.equal(call.init.signal.aborted, false);
    }
    assert.equal(first.init.signal, second.init.signal, "one controller belongs to this content lifetime");
    assert.equal(admin.init.signal, first.init.signal);
    fixture.emit(actorB);
    assert.equal(first.init.signal!.aborted, true);
    const count = fixture.calls.length;
    await assert.rejects(closure.crmRequest("/api/crm/staff"), { name: "AbortError" });
    assert.equal(fixture.calls.length, count);
  } finally { fixture.renderer.dispose(); }
});

test("caller abort and lifetime abort are both preserved without replacing the expected actor", async () => {
  const fixture = await ready();
  try {
    const caller = new AbortController(), pending = deferred<Response>();
    fixture.reply(() => pending.promise);
    const requested = fixture.snapshot().crmFetch("/api/crm/staff", { signal: caller.signal, expectedUserId: actorB });
    await fixture.renderer.flush();
    const call = fixture.calls.at(-1)!;
    assert.equal(call.init.expectedUserId, actorA);
    caller.abort(); pending.resolve(ok());
    await assert.rejects(requested, { name: "AbortError" });
    assert.equal(call.init.signal?.aborted, true);
    assert.equal(fixture.access().isCurrent(), true, "one cancelled operation must not retire the view");
    const count = fixture.calls.length;
    await assert.rejects(fixture.snapshot().crmFetch("/api/crm/staff", { signal: caller.signal }), { name: "AbortError" });
    assert.equal(fixture.calls.length, count, "already-aborted operation cannot enter base transport");
  } finally { fixture.renderer.dispose(); }
});

test("raw sign-out invalidates captured requests immediately and cannot dispatch using stale context", async () => {
  const fixture = await ready();
  try {
    const access = fixture.access(), closure = fixture.snapshot();
    const count = fixture.dispatches.length;
    fixture.emit(null);
    assert.equal(access.isCurrent(), false);
    await assert.rejects(closure.crmFetch("/api/crm/staff"), { name: "AbortError" });
    await fixture.renderer.flush();
    assert.equal(fixture.dispatches.length, count);
    assert.equal(fixture.snapshot().serverAdminAuth.status, "reauth");
    assert.equal(access.isCurrent(), false);
  } finally { fixture.renderer.dispose(); }
});

test("a deferred admin token lookup cannot dispatch or publish auth state after a raw SDK actor change", async () => {
  const fixture = await ready();
  try {
    const pending = deferred<string>(); fixture.token(() => pending.promise);
    const old = fixture.renderer.instance("AdminCenterContent");
    const tokensBefore = fixture.tokenCalls.length;
    const checked = fixture.snapshot().checkServerAdminAccess(); await fixture.renderer.flush();
    assert.equal(fixture.snapshot().serverAdminAuth.status, "checking");
    assert.equal(fixture.tokenCalls.length, tokensBefore + 1, "auth token lookup must actually be suspended");
    assert.equal(fixture.tokenCalls.at(-1), actorA);
    const dispatchCount = fixture.dispatches.length, start = fixture.renderer.writes.length;
    fixture.emit(actorB); pending.resolve("local-fixture-token");
    await checked;
    assert.equal(fixture.dispatches.length, dispatchCount);
    assert.deepEqual(contentWrites(fixture, old, start), []);
    assert.deepEqual(fixture.toasts, []);
  } finally { fixture.renderer.dispose(); }
});

test("real base crmFetch cancels a deferred token before a staff credential POST can dispatch", async () => {
  const fixture = await ready();
  try {
    fixture.snapshot().setInviteForm({ email: "new@example.test", role: "receptionist" });
    fixture.snapshot().setStaffPassword("LocalFixture234"); await fixture.renderer.flush();
    const pending = deferred<string>(); fixture.token(() => pending.promise);
    const old = fixture.renderer.instance("AdminCenterContent");
    const tokensBefore = fixture.tokenCalls.length;
    const created = fixture.snapshot().createStaffWithPassword(); await fixture.renderer.flush();
    const call = fixture.calls.at(-1)!;
    assert.match(call.path, /\/staff-credentials\?/); assert.equal(call.init.method, "POST");
    assert.equal(call.init.expectedUserId, actorA);
    assert.equal(fixture.tokenCalls.length, tokensBefore + 1, "the real base transport must reach its token wait");
    const dispatchCount = fixture.dispatches.length, start = fixture.renderer.writes.length;
    fixture.emit(actorB); pending.resolve("local-fixture-token"); await created;
    assert.equal(call.init.signal?.aborted, true);
    assert.equal(fixture.dispatches.length, dispatchCount, "token resolution must not release a late POST");
    assert.deepEqual(contentWrites(fixture, old, start), []);
    assert.deepEqual(fixture.toasts, []);
  } finally { fixture.renderer.dispose(); }
});

test("a late roster response cannot update its expired content, even when base transport ignores abort", async () => {
  const fixture = await ready();
  try {
    const pending = deferred<Response>();
    fixture.reply((url) => url.includes("/staff?") ? pending.promise : Promise.resolve(ok()));
    const old = fixture.renderer.instance("AdminCenterContent");
    const loaded = fixture.snapshot().loadStaff(); await fixture.renderer.flush();
    const start = fixture.renderer.writes.length;
    fixture.emit(actorB); pending.resolve(ok({ staff: roster })); await loaded;
    assert.deepEqual(contentWrites(fixture, old, start), []);
    assert.deepEqual(fixture.toasts, []);
  } finally { fixture.renderer.dispose(); }
});

test("late parsed requests reject at the body boundary instead of publishing an old auth result", async () => {
  for (const action of ["crmRequest", "adminCrmRequest", "checkServerAdminAccess"] as const) {
    const fixture = await ready();
    try {
      const pending = deferred<string>();
      fixture.reply(async () => ({ ok: true, status: 200, text: () => pending.promise }) as Response);
      const old = fixture.renderer.instance("AdminCenterContent");
      const requested = action === "checkServerAdminAccess" ? fixture.snapshot()[action]()
        : fixture.snapshot()[action]("/api/crm/auth-context");
      await fixture.renderer.flush();
      const start = fixture.renderer.writes.length;
      fixture.emit(actorB); pending.resolve(JSON.stringify(authBody()));
      if (action === "checkServerAdminAccess") await requested;
      else await assert.rejects(requested, { name: "AbortError" });
      assert.deepEqual(contentWrites(fixture, old, start), [], action);
      assert.deepEqual(fixture.toasts, [], action);
    } finally { fixture.renderer.dispose(); }
  }
});

test("deferred body parsing cannot publish old credentials or continue a bulk POST under the next actor", async () => {
  for (const action of ["createStaffWithPassword", "createStaffBatch"] as const) {
    const fixture = await ready();
    try {
      fixture.snapshot().setInviteForm({ email: "first@example.test", role: "receptionist" });
      fixture.snapshot().setStaffPassword("LocalFixture234");
      fixture.snapshot().setBatchEmails("first@example.test\nsecond@example.test"); await fixture.renderer.flush();
      const body = deferred<string>();
      fixture.reply(async () => ({ ok: true, status: 200, text: () => body.promise }) as Response);
      const old = fixture.renderer.instance("AdminCenterContent");
      const saved = fixture.snapshot()[action](); await fixture.renderer.flush();
      const posts = fixture.dispatches.filter((call) => call.init.method === "POST");
      assert.equal(posts.length, 1, "bulk must be sequential");
      const start = fixture.renderer.writes.length;
      fixture.emit(actorB); body.resolve(JSON.stringify({ success: true, data: { login: "old.issued" } })); await saved;
      assert.deepEqual(contentWrites(fixture, old, start), []);
      assert.equal(fixture.dispatches.filter((call) => call.init.method === "POST").length, 1);
      assert.deepEqual(fixture.toasts, []);
    } finally { fixture.renderer.dispose(); }
  }
});

test("a late bulk transport success or failure never starts the next row or emits stale toasts", async () => {
  for (const failure of [false, true]) {
    const fixture = await ready();
    try {
      fixture.snapshot().setBatchEmails("first@example.test\nsecond@example.test"); await fixture.renderer.flush();
      const pending = deferred<Response>(); fixture.reply(() => pending.promise);
      const old = fixture.renderer.instance("AdminCenterContent");
      const saved = fixture.snapshot().createStaffBatch(); await fixture.renderer.flush();
      assert.equal(fixture.dispatches.filter((call) => call.init.method === "POST").length, 1);
      const start = fixture.renderer.writes.length;
      fixture.emit(actorB);
      if (failure) pending.reject(new Error("Local transport failure")); else pending.resolve(ok({ login: "old.issued" }));
      await saved;
      assert.equal(fixture.dispatches.filter((call) => call.init.method === "POST").length, 1);
      assert.deepEqual(contentWrites(fixture, old, start), []);
      assert.deepEqual(fixture.toasts, []);
    } finally { fixture.renderer.dispose(); }
  }
});

test("role/workspace remount, disposal and StrictMode replay stop a deferred bulk before its next POST", async () => {
  for (const boundary of ["role", "workspace", "dispose", "strict-mode"] as const) {
    const fixture = await ready();
    try {
      fixture.snapshot().setBatchEmails("first@example.test\nsecond@example.test"); await fixture.renderer.flush();
      const pending = deferred<Response>();
      fixture.reply((url, init) => init.method === "POST" ? pending.promise
        : Promise.resolve(url.includes("/auth-context") ? Response.json(authBody({ workspaceId: boundary === "workspace" ? workspaceB : workspaceA })) : ok()));
      const old = fixture.renderer.instance("AdminCenterContent"), access = fixture.access();
      const saved = fixture.snapshot().createStaffBatch(); await fixture.renderer.flush();
      assert.equal(fixture.dispatches.filter((call) => call.init.method === "POST").length, 1);
      if (boundary === "role") fixture.setAuth({ userRole: "manager" });
      else if (boundary === "workspace") fixture.setAuth({ clinicId: workspaceB });
      else if (boundary === "dispose") fixture.renderer.dispose();
      else fixture.renderer.replaySessionLayout();
      await fixture.renderer.flush();
      assert.equal(access.isCurrent(), false, boundary);
      assert.equal(old.disposed, true, boundary);
      const start = fixture.renderer.writes.length;
      pending.resolve(ok({ login: "old.issued" })); await saved;
      assert.equal(fixture.dispatches.filter((call) => call.init.method === "POST").length, 1, boundary);
      assert.deepEqual(contentWrites(fixture, old, start), [], boundary);
      assert.deepEqual(fixture.toasts, [], boundary);
    } finally { fixture.renderer.dispose(); }
  }
});

test("expired invitation reissue cannot turn its completed PATCH into a new actor POST", async () => {
  const fixture = await ready();
  try {
    const pending = deferred<Response>(); fixture.reply(() => pending.promise);
    const old = fixture.renderer.instance("AdminCenterContent");
    const reissued = fixture.snapshot().reissueInvitation(invitation); await fixture.renderer.flush();
    assert.equal(fixture.dispatches.at(-1)!.init.method, "PATCH");
    const count = fixture.dispatches.length, start = fixture.renderer.writes.length;
    fixture.emit(actorB); pending.resolve(ok()); await reissued;
    assert.equal(fixture.dispatches.length, count);
    assert.deepEqual(contentWrites(fixture, old, start), []);
    assert.deepEqual(fixture.toasts, []);
  } finally { fixture.renderer.dispose(); }
});

test("an expired password reset cannot expose credentials through its network-failure fallback", async () => {
  const fixture = await ready();
  try {
    const pending = deferred<Response>(); fixture.reply(() => pending.promise);
    const old = fixture.renderer.instance("AdminCenterContent");
    const reset = fixture.snapshot().resetStaffPassword(roster[0]); await fixture.renderer.flush();
    const start = fixture.renderer.writes.length;
    fixture.renderer.dispose(); pending.reject(new Error("Local transport failure")); await reset;
    assert.deepEqual(contentWrites(fixture, old, start), []);
    assert.deepEqual(fixture.toasts, []);
  } finally { fixture.renderer.dispose(); }
});

test("old owner roster, confirmed auth, invitations and issued credentials never carry into a new actor instance", async () => {
  const fixture = await ready();
  try {
    await staffTab(fixture);
    fixture.snapshot().setInviteForm({ email: "new@example.test", role: "receptionist" });
    fixture.snapshot().setStaffPassword("LocalFixture234"); await fixture.renderer.flush();
    await fixture.snapshot().createStaffWithPassword(); await fixture.renderer.flush();
    fixture.snapshot().setBatchEmails("bulk@example.test"); await fixture.renderer.flush();
    await fixture.snapshot().createStaffBatch(); await fixture.renderer.flush();
    fixture.snapshot().setInviteForm({ email: "invited@example.test", role: "receptionist" }); await fixture.renderer.flush();
    await fixture.snapshot().sendInvitation(); await fixture.renderer.flush();
    assert.ok(fixture.snapshot().createdStaff);
    assert.equal(fixture.snapshot().batchResults[0].kind, "created");
    assert.equal(fixture.snapshot().invitations.length, 1);
    assert.ok(fixture.snapshot().issuedInvite?.acceptUrl, "exercise a real issued invitation before switching actor");
    const old = fixture.renderer.instance("AdminCenterContent"), access = fixture.access();
    const pending = deferred<Response>(); fixture.reply(() => pending.promise);
    fixture.emit(actorB);
    fixture.setAuth({ user: { id: actorB, email: "head@example.test" }, userRole: "manager" });
    await fixture.renderer.flush();
    assert.equal(old.disposed, true); assert.equal(access.isCurrent(), false);
    const next = fixture.snapshot();
    assert.equal(next.serverAdminAuth.status, "checking");
    assert.deepEqual(clone(next.staff), []); assert.deepEqual(clone(next.invitations), []);
    assert.equal(next.createdStaff, null); assert.equal(next.issuedInvite, null); assert.equal(next.batchResults, null);
    assert.equal(next.staffPassword, ""); assert.equal(next.batchEmails, ""); assert.equal(next.inviteForm.email, "");
    assert.doesNotMatch(label(fixture.renderer.tree()), /Owner-only local roster|LocalFixture234|issued\.local/);
    pending.resolve(Response.json(authBody({ isAdmin: false, role: "manager", staffUserId: "head-local" })));
    await fixture.renderer.flush();
    assert.equal(fixture.snapshot().serverAdminAuth.status, "forbidden");
    assert.deepEqual(clone(fixture.snapshot().staff), []);
    assert.deepEqual(fixture.storageWrites, [], "one-time staff credentials must not be persisted");
  } finally { fixture.renderer.dispose(); }
});

test("auth-context distinguishes explicit non-admin/403 from malformed or unavailable replies and reauthentication", async () => {
  const cases: { name: string; response: () => Promise<Response>; status: string }[] = [
    { name: "explicit non-admin", response: async () => Response.json(authBody({ isAdmin: false, role: "manager" })), status: "forbidden" },
    { name: "unselected non-admin", response: async () => Response.json(authBody({ isAdmin: false, workspaceId: null, role: null, staffUserId: null })), status: "forbidden" },
    { name: "403", response: async () => Response.json({ success: false }, { status: 403 }), status: "forbidden" },
    { name: "401", response: async () => Response.json({ success: false }, { status: 401 }), status: "reauth" },
    { name: "503", response: async () => Response.json({ success: false }, { status: 503 }), status: "unavailable" },
    { name: "malformed JSON", response: async () => new Response("not json"), status: "unavailable" },
    { name: "missing data", response: async () => Response.json({ success: true }), status: "unavailable" },
    { name: "missing isAdmin", response: async () => Response.json({ success: true, data: { workspaceId: workspaceA, role: "owner" } }), status: "unavailable" },
    { name: "non-boolean isAdmin", response: async () => Response.json(authBody({ isAdmin: "yes" })), status: "unavailable" },
    { name: "non-admin wrong workspace", response: async () => Response.json(authBody({ isAdmin: false, workspaceId: workspaceB })), status: "unavailable" },
    { name: "admin wrong workspace", response: async () => Response.json(authBody({ workspaceId: workspaceB })), status: "unavailable" },
    { name: "admin missing staff identity", response: async () => Response.json(authBody({ staffUserId: null })), status: "unavailable" },
    { name: "admin incompatible role", response: async () => Response.json(authBody({ role: "manager" })), status: "unavailable" },
    { name: "transport unavailable", response: async () => { throw new Error("Local unavailable fixture"); }, status: "unavailable" },
  ];
  for (const scenario of cases) {
    const fixture = setup(); fixture.reply(scenario.response);
    try {
      await fixture.renderer.flush();
      assert.equal(fixture.snapshot().serverAdminAuth.status, scenario.status, scenario.name);
      const text = label(authPanel(fixture));
      if (scenario.status === "forbidden") {
        assert.match(text, /\u041d\u0435\u0434\u043e\u0441\u0442\u0430\u0442\u043e\u0447\u043d\u043e \u043f\u0440\u0430\u0432/, scenario.name);
        assert.doesNotMatch(text, /\u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u0435\u043d/, scenario.name);
      }
      assert.deepEqual(clone(fixture.snapshot().staff), []);
    } finally { fixture.renderer.dispose(); }
  }
  const fixture = setup(); fixture.token(async () => "");
  try {
    await fixture.renderer.flush();
    assert.equal(fixture.snapshot().serverAdminAuth.status, "reauth");
    assert.equal(fixture.dispatches.length, 0, "missing token cannot send an auth request");
  } finally { fixture.renderer.dispose(); }
});

for (const role of ["owner", "admin"] as const) {
  test(`server-confirmed ${role} retains the overview staff action and single/password/invitation/bulk controls`, async () => {
    const fixture = setup(); fixture.setAuth({ userRole: role });
    try {
      await fixture.renderer.flush();
      assert.equal(fixture.snapshot().serverAdminAuth.status, "confirmed");
      assert.equal(fixture.snapshot().serverAdminAuth.role, role);
      assert.equal(staffCreation(fixture), undefined, "overview must not itself render the form");
      button(fixture, staffUi.add).props.onClick(); await fixture.renderer.flush();
      for (const text of [staffUi.add, staffUi.passwordMode, staffUi.inviteMode, staffUi.generate, staffUi.bulk]) button(fixture, text);
      assert.equal(button(fixture, staffUi.passwordMode).props["aria-pressed"], true);
      const passwordControls = formControls(fixture);
      assert.equal(passwordControls.filter((node) => node.type === "input").length, 3, "login, name and password remain available");
      assert.equal(passwordControls.filter((node) => node.type === "select").length, 1, "single staff role selector remains");
      for (const control of passwordControls) assert.equal(typeof control.props.onChange, "function");
      assert.ok(passwordControls.some((node) => node.props.placeholder === staffUi.staffName));
      assert.equal(buttons(fixture, staffUi.invite).length, 0);

      button(fixture, staffUi.inviteMode).props.onClick(); await fixture.renderer.flush();
      assert.equal(button(fixture, staffUi.inviteMode).props["aria-pressed"], true);
      button(fixture, staffUi.invite);
      const inviteControls = formControls(fixture);
      assert.equal(inviteControls.filter((node) => node.type === "input").length, 1);
      assert.ok(inviteControls.some((node) => node.props.type === "email" && node.props.placeholder === staffUi.staffEmail));
      assert.equal(buttons(fixture, staffUi.add).length, 0);
      assert.equal(buttons(fixture, staffUi.generate).length, 0);

      button(fixture, staffUi.bulk).props.onClick(); await fixture.renderer.flush();
      button(fixture, staffUi.bulkSubmit);
      assert.equal(formControls(fixture).filter((node) => node.type === "textarea").length, 1);
      assert.equal(formControls(fixture).filter((node) => node.type === "select").length, 2, "single and bulk role selectors remain");
      button(fixture, staffUi.passwordMode).props.onClick(); await fixture.renderer.flush();
      button(fixture, staffUi.add); button(fixture, staffUi.generate); button(fixture, staffUi.bulkSubmit);
      await tab(fixture, "overview"); button(fixture, staffUi.add);
      assert.equal(fixture.dispatches.filter((call) => call.init.method === "POST").length, 0, "navigation and mode toggles create no staff");
      assert.deepEqual(fixture.storageWrites, []);
    } finally { fixture.renderer.dispose(); }
  });
}

for (const serverRole of ["manager", "receptionist", "marketer", "doctor", "lead_manager"] as const) {
  test(`server non-admin ${serverRole} hides staff creation and the overview action for matching or stale client owner roles`, async () => {
    for (const clientRole of [serverRole, "owner"]) {
      const fixture = setup(); fixture.setAuth({ userRole: clientRole });
      fixture.reply(async () => Response.json(authBody({ role: serverRole, isAdmin: false })));
      try {
        await fixture.renderer.flush();
        assert.equal(fixture.snapshot().serverAdminAuth.status, "forbidden", clientRole);
        await assertBothStaffViewsHidden(fixture);
        assert.equal(fixture.dispatches.filter((call) => call.init.method === "POST").length, 0);
        assert.deepEqual(fixture.storageWrites, []);
      } finally { fixture.renderer.dispose(); }
    }
  });
}

test("initial checking hides staff creation and the overview action even for a client owner", async () => {
  const fixture = setup(), pending = deferred<string>(); fixture.token(() => pending.promise);
  try {
    await fixture.renderer.flush();
    assert.equal(fixture.snapshot().serverAdminAuth.status, "checking");
    await assertBothStaffViewsHidden(fixture);
    assert.equal(fixture.dispatches.length, 0, "pending token lookup has not dispatched any request");
    pending.resolve("local-fixture-token"); await fixture.renderer.flush();
    assert.equal(fixture.snapshot().serverAdminAuth.status, "confirmed");
    button(fixture, staffUi.add).props.onClick(); await fixture.renderer.flush();
    assert.ok(staffCreation(fixture), "successful confirmation restores the form");
  } finally { fixture.renderer.dispose(); }
});

const deniedStaffChecks = [
  { status: "reauth", response: () => Response.json({ success: false }, { status: 401 }) },
  { status: "forbidden", response: () => Response.json(authBody({ role: "manager", isAdmin: false })) },
  { status: "unavailable", response: () => Response.json({ success: false }, { status: 503 }) },
] as const;
for (const scenario of deniedStaffChecks) {
  test(`${scenario.status} hides owner staff controls and synthetic results throughout a real pending recheck`, async () => {
    const fixture = await ready();
    try {
      const { results, markers } = await seedStaffResults(fixture);
      const content = fixture.renderer.instance("AdminCenterContent");
      const pending = deferred<string>(); fixture.token(() => pending.promise);
      fixture.reply(async () => scenario.response());
      const dispatchCount = fixture.dispatches.length, tokenCount = fixture.tokenCalls.length;
      button(fixture, staffUi.checkAccess).props.onClick(); await fixture.renderer.flush();
      assert.equal(fixture.snapshot().serverAdminAuth.status, "checking");
      assert.equal(fixture.tokenCalls.length, tokenCount + 1, "the actual recheck must be awaiting its token");
      assert.equal(fixture.dispatches.length, dispatchCount, "controls hide before any recheck reply");
      assertStaffHidden(fixture, markers);
      await assertBothStaffViewsHidden(fixture, markers);
      assert.deepEqual(staffResults(fixture), results, "results still exist in state, so absence must come from rendering access");
      assert.equal(fixture.renderer.instance("AdminCenterContent"), content, "recheck must exercise the existing confirmed lifetime");
      pending.resolve("local-fixture-token"); await fixture.renderer.flush();
      assert.equal(fixture.snapshot().serverAdminAuth.status, scenario.status);
      await assertBothStaffViewsHidden(fixture, markers);
      assert.deepEqual(staffResults(fixture), results);
      const recheckCalls = fixture.dispatches.slice(dispatchCount);
      assert.equal(recheckCalls.filter((call) => call.path.includes("/auth-context?")).length, 1);
      assert.ok(recheckCalls.every((call) => !call.init.method || call.init.method === "GET"),
        "auth recheck and existing tab reads must not create, invite or change credentials");
      assert.deepEqual(fixture.storageWrites, []);
    } finally { fixture.renderer.dispose(); }
  });
}

for (const role of ["owner", "admin"] as const) {
  test(`previously confirmed ${role} immediately hides both modes, bulk, drafts and results during recheck and restores on confirmation`, async () => {
    for (const mode of [staffUi.passwordMode, staffUi.inviteMode]) {
      const fixture = setup(); fixture.setAuth({ userRole: role });
      try {
        await fixture.renderer.flush();
        assert.equal(fixture.snapshot().serverAdminAuth.status, "confirmed");
        const { results, markers } = await seedStaffResults(fixture);
        button(fixture, mode).props.onClick();
        fixture.snapshot().setInviteForm({ email: "draft.fixture@example.test", role: "receptionist" });
        fixture.snapshot().setStaffPassword("LocalDraftFixture234");
        fixture.snapshot().setBatchEmails("draft.bulk@example.test"); await fixture.renderer.flush();
        const drafts = mode === staffUi.passwordMode
          ? ["draft.fixture@example.test", "LocalDraftFixture234", "draft.bulk@example.test"]
          : ["draft.fixture@example.test", "draft.bulk@example.test"];
        for (const draft of drafts) assert.ok(renderedText(fixture).includes(draft), "draft input must first be rendered");
        const content = fixture.renderer.instance("AdminCenterContent");
        const pending = deferred<Response>();
        fixture.reply(async () => pending.promise);
        const dispatchCount = fixture.dispatches.length;
        button(fixture, staffUi.checkAccess).props.onClick(); await fixture.renderer.flush();
        assert.equal(fixture.snapshot().serverAdminAuth.status, "checking");
        assert.equal(fixture.dispatches.length, dispatchCount + 1, "auth transport is genuinely pending");
        assertStaffHidden(fixture, [...markers, ...drafts]);
        await assertBothStaffViewsHidden(fixture, [...markers, ...drafts]);
        assert.deepEqual(staffResults(fixture), results);
        assert.equal(fixture.renderer.instance("AdminCenterContent"), content);
        fixture.reply(); pending.resolve(Response.json(authBody({ role }))); await fixture.renderer.flush();
        assert.equal(fixture.snapshot().serverAdminAuth.status, "confirmed");
        assert.equal(fixture.snapshot().serverAdminAuth.role, role);
        button(fixture, staffUi.add).props.onClick(); await fixture.renderer.flush();
        button(fixture, mode); button(fixture, staffUi.bulkSubmit);
        button(fixture, mode === staffUi.passwordMode ? staffUi.add : staffUi.invite);
        for (const text of [staffUi.copySingle, staffUi.copyBulk, staffUi.copyInvite]) button(fixture, text);
        for (const marker of [...markers, ...drafts]) assert.ok(renderedText(fixture).includes(marker), "confirmation restores the existing local form state");
        assert.deepEqual(fixture.storageWrites, []);
      } finally { fixture.renderer.dispose(); }
    }
  });
}

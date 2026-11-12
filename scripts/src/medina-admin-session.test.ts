import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  // App modules share one Error prototype in the browser, including imported API errors.
  new Script(code).runInNewContext({ exports, Error, AbortController, AbortSignal, DOMException, Headers, Response,
    URLSearchParams, ...bindings,
    require(name: string) {
      if (name in imports) return imports[name];
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "./OperatorRequests.css") return {}; // No DOM/style surface in this hook harness.
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
    activeTab, batchRole, batchResults, batchEmails, staffPassword, inviteForm, loading, joinRequests, joinCode,
    mortgageChannels, mortgageChannelsLoading, mortgageChannelsError, mortgageChannelBusy,
    loadMortgageChannels, disableMortgageChannel,
    setActiveTab, setInviteForm, setStaffPassword, setBatchEmails,
    checkServerAdminAccess, loadStaff, loadInvitations, sendInvitation, createStaffWithPassword,
    createStaffBatch, resetStaffPassword, reissueInvitation, updateStaffStatus,
    loadMetaInsightsDiagnostics, saveMetaConfig, metaAccount, metaConfigMode,
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
  const trees: any[] = [];
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
    hooks, writes, trees,
    mount(type: any, children: any[], props: any = {}) {
      children.forEach((child) => own.add(child)); own.add(type); rootNode = jsx(type, props);
    },
    invalidate() { dirty = true; },
    async flush() {
      for (let pass = 0; pass < 100; pass++) {
        if (mounted && dirty) {
          dirty = false; tree = render(rootNode, "root"); trees.push(tree);
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
const channelRows = [
  { id: "channel-local", provider: "wazzup", keyMasked: "\u2026abcd", enabled: true,
    leadsFiled: 17, repeatsSeen: 23, lastInboundAt: null },
  { id: "channel-local", provider: "whatsapp_cloud", keyMasked: "\u2026efgh", enabled: true,
    leadsFiled: 29, repeatsSeen: 31, lastInboundAt: "2026-10-14T10:00:00Z" },
  { id: "channel-disabled", provider: "whatsapp_cloud", keyMasked: "\u2026ijkl", enabled: false,
    leadsFiled: 0, repeatsSeen: 0, lastInboundAt: null },
];
type Init = RequestInit & { expectedUserId?: string; accessToken?: string };
type Reply = (url: string, init: Init) => Promise<Response>;
const permissions = evaluate(await read("artifacts/negis/src/lib/permissions.ts"));
const logins = evaluate(await read("lib/auth/staff-logins.ts"));
const terms = evaluate(await read("lib/vertical/terms.ts"));
const cities = evaluate(await read("lib/meta/cities.ts"));

function setup(search = "") {
  const renderer = hookRenderer();
  const callbacks = new Set<(event: string, session: any) => void>();
  const calls: { path: string; init: Init }[] = [];
  const dispatches: { path: string; init: Init }[] = [];
  const tokenCalls: (string | undefined)[] = [];
  const toasts: { kind: string; message: string }[] = [];
  const stored = new Map<string, string>();
  const storageWrites: string[] = [];
  const locations: string[] = [];
  const copies: string[] = [];
  const snapshots: any[] = [];
  let snapshot: any;
  let auth = { user: { id: actorA, email: "owner@example.test" }, userRole: "owner", clinicId: workspaceA,
    workspacePurpose: "clinic_services" as "clinic_services" | "marketing" | "mortgage_leads" | null,
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
    if (resource === "whatsapp-channels") return init.method === "PATCH"
      ? ok({ item: { id: JSON.parse(String(init.body)).id, enabled: false } }) : ok({ channels: channelRows });
    if (resource === "clinic-operator-requests" && ["POST", "PATCH"].includes(String(init.method))) {
      const body = JSON.parse(String(init.body)), action = init.method === "POST" ? "propose" : body.action;
      return ok({ state: "committed", commandId: body.commandId, action,
        targetId: action === "propose" ? body.operatorId : body.id,
        requestId: action === "propose" ? "00000000-0000-4000-8000-000000000022" : body.id,
        statusAtCommit: action === "propose" ? "requested" : action === "withdraw" ? "declined" : "ended",
        committedAt: "2026-10-27T00:00:00Z" });
    }
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
  const sessionAuth = { onAuthStateChange(callback: Parameters<typeof callbacks.add>[0]) {
    callbacks.add(callback); return { data: { subscription: { unsubscribe: () => callbacks.delete(callback) } } };
  } };
  const module = evaluate(observeContent(adminSource), {
    __capture: (value: any) => { snapshot = value; snapshots.push(value); },
    crypto: { getRandomValues: (bytes: Uint32Array) => { bytes.fill(17); return bytes; } },
    window: { location: { search }, confirm: () => true, localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { storageWrites.push(key); stored.set(key, value); },
    } },
    navigator: { clipboard: { writeText: async (value: string) => { copies.push(value); } } },
  }, {
    react: renderer.hooks, wouter: { Link: "Link", useLocation: () => ["/admin", (url: string) => locations.push(url)] },
    sonner: { toast: new Proxy({}, { get: (_target, kind) => (message: string) => toasts.push({ kind: String(kind), message }) }) },
    "@/contexts/AuthContext": { useAuth: () => auth },
    "@/lib/supabase": { hasSupabaseFrontendEnv: true, supabase: { auth: sessionAuth }, sessionAuth },
    "@/lib/api": { ...api, crmFetch: importedFetch, apiUrl: (url: string) => url },
    "@/lib/serverAuth": { getSupabaseAccessToken: getToken },
    "@/lib/demoStorage": { readWorkspaceId: () => auth.clinicId, workspaceScopedKey: (key: string) => `${auth.clinicId}:${key}` },
    "@/lib/permissions": permissions,
    "../../../../lib/auth/staff-logins": logins,
    "../../../../lib/vertical/terms": terms,
    "../../../../lib/crm/join-codes": { formatJoinCode: (value: string) => value },
    "../../../../lib/meta/cities": cities,
  });
  renderer.mount(module.default, [module.fixture.AdminCenterSession, module.fixture.AdminCenterContent]);
  return {
    renderer, calls, dispatches, tokenCalls, toasts, storageWrites, locations, copies, snapshots,
    api, fetch: importedFetch, getToken, snapshot: () => snapshot,
    sdkSession: async () => ({ data: { session: sdkActor ? { user: { id: sdkActor } } : null }, error: null }),
    access: () => renderer.instance("AdminCenterContent").props.access,
    emit(id: string | null, event = id ? "SIGNED_IN" : "SIGNED_OUT") {
      sdkActor = id || "";
      for (const callback of [...callbacks]) callback(event, id ? { user: { id } } : null);
    },
    setAuth(patch: Partial<typeof auth>) { auth = { ...auth, ...patch }; renderer.invalidate(); },
    mountSession() {
      renderer.mount(module.fixture.AdminCenterSession, [module.fixture.AdminCenterContent], {
        actorId: auth.user.id, workspaceId: auth.clinicId, userRole: auth.userRole,
        isDemoMode: auth.isDemoMode, workspacePurpose: auth.workspacePurpose,
      });
    },
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

const clinicSources = Promise.all([
  read("artifacts/negis/src/components/admin/ClinicOperators.tsx"),
  read("artifacts/negis/src/components/operators/OperatorRequests.tsx"),
  read("artifacts/negis/src/components/operators/OperatorArrivals.tsx"),
  read("artifacts/negis/src/lib/operatorApi.ts"),
  read("lib/crm/operator-contracts.ts"),
]);
const commandAttemptSource = await read("artifacts/negis/src/lib/operatorCommandAttempt.ts");
const commandHookSource = await read("artifacts/negis/src/lib/useOperatorCommand.ts");
const commandContracts = evaluate(await read("lib/crm/operator-contracts.ts"));
const commandError = evaluate(select(await read("artifacts/negis/src/lib/operatorApi.ts"), ["OperatorApiError"])).selected;
function commandHook(renderer: ReturnType<typeof hookRenderer>) {
  const values = new Map<string, string>();
  return evaluate(commandHookSource, { crypto: { randomUUID } }, {
    react: renderer.hooks,
    "@/lib/operatorApi": commandError,
    "./operatorCommandAttempt": evaluate(commandAttemptSource, { window: { sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    } } }),
    "../../../../lib/crm/operator-contracts": commandContracts,
  });
}
async function clinicArrival(fixture: Fixture) {
  const [clinicSource, requestSource, arrivalSource, operatorSource, contractsSource] = await clinicSources;
  const contracts = evaluate(contractsSource);
  const children = [hookRenderer(), hookRenderer(), hookRenderer()];
  const requestId = "00000000-0000-4000-8000-000000000010";
  const arrival = { appointmentId: "00000000-0000-4000-8000-000000000011", arrivalId: null,
    status: "arrived", clientName: "Synthetic clinic arrival", startsAt: "2090-10-20T09:00:00Z" };
  let refreshes = 0;
  const list = (items: unknown[]) => ({ data: { items, hasMore: false }, offset: 0, error: "",
    refresh: () => { refreshes++; }, next() {}, previous() {} });
  fixture.snapshot().setActiveTab("operators"); await fixture.renderer.flush();
  const clinicProps = nodes(fixture.renderer.tree()).find(node => node.type === "ClinicOperators")?.props;
  assert.ok(clinicProps, "Use the clinic props produced by the actual AdminCenterContent");
  const directory = list([]);
  const clinic = evaluate(clinicSource, {}, {
    react: children[0].hooks, "@/lib/operatorApi": { useOperatorList: () => directory },
    "@/lib/useOperatorCommand": commandHook(children[0]),
    "../../../../../lib/crm/operator-contracts": contracts,
  });
  children[0].mount(clinic.ClinicOperators, [], clinicProps); await children[0].flush();
  const requestProps = nodes(children[0].tree()).find(node => node.type === "OperatorRequests")?.props;
  assert.ok(requestProps, "Traverse the actual ClinicOperators forwarding JSX");
  const requestsList = list([{ id: requestId, status: "accepted", displayName: "Synthetic operator",
    clinicBrief: "Local fixture only", pricePerArrivalMinor: "0", currency: "KZT", leadScope: "assigned" }]);
  const requests = evaluate(requestSource, {}, {
    react: children[1].hooks, "@/lib/operatorApi": { useOperatorList: () => requestsList },
    "@/lib/useOperatorCommand": commandHook(children[1]),
    "./OperatorCommandRecovery": { OperatorCommandRecovery: "OperatorCommandRecovery" },
    "@/lib/serverAuth": { getSupabaseAccessToken: fixture.getToken },
    "@/lib/supabase": { supabase: { auth: { getSession: fixture.sdkSession } } },
    "./OperatorLeads": { OperatorLeads: "OperatorLeads" },
    "./OperatorServiceCatalog": { OperatorServiceCatalog: "OperatorServiceCatalog" },
    "./OperatorArrivals": { OperatorArrivals: "OperatorArrivals" },
    "../../../../../lib/crm/operator-contracts": contracts,
  });
  children[1].mount(requests.OperatorRequests, [], requestProps); await children[1].flush();
  const open = nodes(children[1].tree()).find(node => node.type === "button"
    && label(node).trim() === "\u041f\u043e\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044c \u043f\u0440\u0438\u0445\u043e\u0434\u044b");
  assert.ok(open); open.props.onClick(); await children[1].flush();
  const arrivalProps = nodes(children[1].tree()).find(node => node.type === "OperatorArrivals")?.props;
  assert.ok(arrivalProps, "Open the actual request's arrival panel");
  const operator = evaluate(select(operatorSource, ["OperatorApiError", "operatorApi"]), {
    crmFetch: fixture.fetch, CrmApiError: fixture.api.CrmApiError, crmErrorMessage: fixture.api.crmErrorMessage,
  }).selected;
  const ast = ts.createSourceFile("OperatorArrivals.tsx", arrivalSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "OperatorArrivals") as import("typescript").FunctionDeclaration;
  const returned = component.body!.statements.filter(ts.isReturnStatement).at(-1)!;
  let confirm!: (item: typeof arrival) => Promise<void>;
  const arrivalsList = list([arrival]);
  const arrivals = evaluate(arrivalSource.slice(0, returned.getStart(ast))
    + "\n__observeConfirm(confirm);\n" + arrivalSource.slice(returned.getStart(ast)), {
    __observeConfirm: (handler: typeof confirm) => { confirm = handler; },
    window: { addEventListener() {}, removeEventListener() {} },
    document: { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" },
  }, {
    react: children[2].hooks, "@/lib/operatorApi": { ...operator, useOperatorList: () => arrivalsList },
    "../../../../../lib/crm/operator-contracts": contracts,
  });
  children[2].mount(arrivals.OperatorArrivals, [], arrivalProps); await children[2].flush();
  return { clinicProps, requestProps, arrivalProps, arrival, confirm: () => confirm(arrival),
    renderer: children[2], refreshes: () => refreshes, dispose: () => children.forEach(child => child.dispose()) };
}
const clinicPosts = (fixture: Fixture) => fixture.dispatches.filter(call =>
  call.path.startsWith("/api/crm/clinic-operator-arrivals?") && call.init.method === "POST");

test("clinic arrival keeps the actor and live session through every actual parent", async () => {
  const fixture = await ready(), ui = await clinicArrival(fixture);
  try {
    for (const props of [ui.clinicProps, ui.requestProps, ui.arrivalProps]) {
      assert.equal(props.actorId, actorA);
      assert.equal(props.isSessionCurrent, fixture.access().isCurrent);
    }
    await ui.confirm();
    const posts = clinicPosts(fixture);
    assert.equal(posts.length, 1);
    assert.equal(fixture.tokenCalls.at(-1), actorA);
    assert.deepEqual(JSON.parse(String(posts[0].init.body)), { appointmentId: ui.arrival.appointmentId });
    assert.equal(Object.hasOwn(posts[0].init, "expectedUserId"), false);
    assert.equal(Object.hasOwn(posts[0].init, "dispatchGuard"), false);
    assert.equal(ui.refreshes(), 1);
  } finally { ui.dispose(); fixture.renderer.dispose(); }
});

test("clinic arrival queued before raw SDK account/logout/A-B-A changes never dispatches", async () => {
  for (const boundary of ["actor", "logout", "roundtrip"]) {
    const fixture = await ready(), ui = await clinicArrival(fixture), token = deferred<string>();
    let work: Promise<void> | undefined;
    try {
      fixture.token(async () => token.promise);
      work = ui.confirm(); await ui.renderer.flush();
      assert.equal(clinicPosts(fixture).length, 0);
      fixture.emit(boundary === "logout" ? null : actorB);
      if (boundary === "roundtrip") fixture.emit(actorA);
      const writes = ui.renderer.writes.length;
      token.resolve("local-fixture-token"); await work; await ui.renderer.flush();
      assert.equal(clinicPosts(fixture).length, 0, boundary);
      assert.equal(ui.renderer.writes.length, writes, "Expired work cannot publish an error or release another action's busy state");
      assert.equal(ui.refreshes(), 0);
    } finally { token.resolve("local-fixture-token"); await work; ui.dispose(); fixture.renderer.dispose(); }
  }
});

test("clinic arrival retained handlers stop before state writes or token lookup after session expiry", async () => {
  for (const boundary of ["actor", "logout", "roundtrip"]) {
    const fixture = await ready(), ui = await clinicArrival(fixture);
    try {
      fixture.emit(boundary === "logout" ? null : actorB);
      if (boundary === "roundtrip") fixture.emit(actorA);
      const writes = ui.renderer.writes.length, lookups = fixture.tokenCalls.length;
      await ui.confirm(); await ui.renderer.flush();
      assert.equal(ui.renderer.writes.length, writes, boundary);
      assert.equal(fixture.tokenCalls.length, lookups);
      assert.equal(clinicPosts(fixture).length, 0);
      assert.equal(ui.refreshes(), 0);
    } finally { ui.dispose(); fixture.renderer.dispose(); }
  }
});

test("clinic arrival refuses a different SDK actor even before auth events reach the parent", async () => {
  const fixture = await ready(), ui = await clinicArrival(fixture), lookup = deferred<void>();
  let work: Promise<void> | undefined;
  try {
    const auth = evaluate(await read("artifacts/negis/src/lib/serverAuth.ts"), {}, {
      "@/lib/supabase": { hasSupabaseFrontendEnv: true, supabase: { auth: { async getSession() {
        await lookup.promise;
        return { data: { session: { user: { id: actorB }, access_token: "synthetic-B-not-a-real-token" } }, error: null };
      } } } },
      "@/lib/authSignOut": { isSignOutPending: () => false, getSignOutRevision: () => 0 },
    });
    fixture.token(expected => auth.getSupabaseAccessToken(expected));
    work = ui.confirm(); await ui.renderer.flush();
    assert.equal(clinicPosts(fixture).length, 0);
    lookup.resolve(); await work; await ui.renderer.flush();
    assert.equal(fixture.access().isCurrent(), true, "No raw event or parent rerender is needed to reproduce this token mismatch");
    assert.equal(fixture.tokenCalls.at(-1), actorA);
    assert.equal(clinicPosts(fixture).length, 0);
    assert.equal(ui.refreshes(), 1, "A live-scope authentication refusal still invalidates the list");
  } finally { lookup.resolve(); await work; ui.dispose(); fixture.renderer.dispose(); }
});

test("clinic arrival accepts same-actor token refresh while the original session remains live", async () => {
  const fixture = await ready(), ui = await clinicArrival(fixture), lookup = deferred<string>();
  let work: Promise<void> | undefined;
  try {
    fixture.token(() => lookup.promise);
    work = ui.confirm(); await ui.renderer.flush();
    fixture.emit(actorA, "TOKEN_REFRESHED");
    assert.equal(fixture.access().isCurrent(), true);
    lookup.resolve("synthetic-A-rotated"); await work; await ui.renderer.flush();
    assert.equal(clinicPosts(fixture).length, 1);
    assert.equal(new Headers(clinicPosts(fixture)[0].init.headers).get("Authorization"), "Bearer synthetic-A-rotated");
    assert.equal(ui.refreshes(), 1);
  } finally { lookup.resolve("synthetic-A-rotated"); await work; ui.dispose(); fixture.renderer.dispose(); }
});

test("clinic arrival late outcomes after raw account transitions cannot publish before React commits", async () => {
  for (const boundary of ["actor", "roundtrip"]) for (const status of [200, 401, 403, "network"] as const) {
    const fixture = await ready(), ui = await clinicArrival(fixture), reply = deferred<Response>();
    let work: Promise<void> | undefined;
    try {
      fixture.reply(async () => reply.promise);
      work = ui.confirm(); await ui.renderer.flush();
      assert.equal(clinicPosts(fixture).length, 1);
      fixture.emit(actorB); if (boundary === "roundtrip") fixture.emit(actorA);
      const writes = ui.renderer.writes.length;
      if (status === "network") reply.reject(new Error("Synthetic transport failure"));
      else reply.resolve(Response.json({ success: status === 200 }, { status }));
      await work; await ui.renderer.flush();
      assert.equal(ui.renderer.writes.length, writes, `${boundary}/${status}`);
      assert.equal(ui.refreshes(), 0);
      assert.equal(clinicPosts(fixture).length, 1, "Already dispatched writes are not represented as canceled");
    } finally { reply.resolve(ok()); await work; ui.dispose(); fixture.renderer.dispose(); }
  }
});

type ClinicAction = "send" | "withdraw" | "end";
async function clinicAction(fixture: Fixture, kind: ClinicAction, confirm?: () => boolean) {
  const [clinicSource, requestSource, , operatorSource, contractsSource] = await clinicSources;
  const contracts = evaluate(contractsSource);
  const children = [hookRenderer(), hookRenderer()];
  const operator = evaluate(select(operatorSource, ["OperatorApiError", "operatorApi"]), {
    crmFetch: fixture.fetch, CrmApiError: fixture.api.CrmApiError, crmErrorMessage: fixture.api.crmErrorMessage,
  }).selected;
  const profileId = "00000000-0000-4000-8000-000000000020";
  const requestId = "00000000-0000-4000-8000-000000000021";
  let refreshes = 0;
  const list = (items: unknown[]) => ({ data: { items, hasMore: false }, offset: 0, error: "",
    refresh: () => { refreshes++; }, next() {}, previous() {} });
  fixture.snapshot().setActiveTab("operators"); await fixture.renderer.flush();
  const clinicProps = nodes(fixture.renderer.tree()).find(node => node.type === "ClinicOperators")?.props;
  assert.ok(clinicProps);
  // A list response retains its identity across local form renders.
  const directory = list([{ id: profileId, displayName: "Synthetic operator" }]);
  const stableClinic = evaluate(clinicSource, {}, {
    react: children[0].hooks, "@/lib/operatorApi": { ...operator, useOperatorList: () => directory },
    "@/lib/useOperatorCommand": commandHook(children[0]),
    "../../../../../lib/crm/operator-contracts": contracts,
  });
  children[0].mount(stableClinic.ClinicOperators, [], clinicProps); await children[0].flush();
  const requestProps = nodes(children[0].tree()).find(node => node.type === "OperatorRequests")?.props;
  assert.ok(requestProps);
  let action!: (...args: any[]) => Promise<void>;
  let target = children[0];
  if (kind === "send") {
    const offer = nodes(target.tree()).find(node => node.type === "button" && label(node).trim() === "Предложить сотрудничество");
    assert.ok(offer); offer.props.onClick(); await target.flush();
    for (const [type, value] of [["textarea", "Synthetic technical agreement"], ["input", "0"]]) {
      const field = nodes(target.tree()).find(node => node.type === type);
      assert.ok(field); field.props.onChange({ target: { value } });
    }
    await target.flush();
    action = nodes(target.tree()).find(node => node.type === "form")!.props.onSubmit;
  } else {
    target = children[1];
    const ast = ts.createSourceFile("OperatorRequests.tsx", requestSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "OperatorRequests") as import("typescript").FunctionDeclaration;
    const returned = component.body!.statements.filter(ts.isReturnStatement).at(-1)!;
    const requests = list([{ id: requestId, status: kind === "withdraw" ? "requested" : "accepted",
      displayName: "Synthetic collaboration", clinicBrief: "Synthetic technical agreement",
      pricePerArrivalMinor: "0", currency: "KZT", leadScope: "assigned" }]);
    const module = evaluate(requestSource.slice(0, returned.getStart(ast)) + "\n__observeAction(change);\n" + requestSource.slice(returned.getStart(ast)), {
      __observeAction: (handler: typeof action) => { action = handler; },
      window: { confirm: confirm ?? (() => true) },
    }, {
      react: target.hooks, "@/lib/operatorApi": { ...operator, useOperatorList: () => requests },
      "@/lib/useOperatorCommand": commandHook(target),
      "./OperatorCommandRecovery": { OperatorCommandRecovery: "OperatorCommandRecovery" },
      "@/lib/serverAuth": { getSupabaseAccessToken: fixture.getToken },
      "@/lib/supabase": { supabase: { auth: { getSession: fixture.sdkSession } } },
      "./OperatorLeads": { OperatorLeads: "OperatorLeads" },
      "./OperatorServiceCatalog": { OperatorServiceCatalog: "OperatorServiceCatalog" },
      "./OperatorArrivals": { OperatorArrivals: "OperatorArrivals" },
      "../../../../../lib/crm/operator-contracts": contracts,
    });
    target.mount(module.OperatorRequests, [], requestProps); await target.flush();
  }
  const retained = action;
  return { kind, profileId, requestId, renderer: target, refreshes: () => refreshes,
    invoke: () => kind === "send" ? retained({ preventDefault() {} }) : retained(requestId, kind),
    dispose: () => children.forEach(child => child.dispose()) };
}
const clinicActions = (fixture: Fixture) => fixture.dispatches.filter(call =>
  call.path.startsWith("/api/crm/clinic-operator-requests?") && ["POST", "PATCH"].includes(String(call.init.method)));

test("clinic collaboration actual parent chain pins every mutation to the original actor", async () => {
  for (const kind of ["send", "withdraw", "end"] as const) {
    const fixture = await ready(), ui = await clinicAction(fixture, kind);
    try {
      await ui.invoke(); await ui.renderer.flush();
      assert.equal(fixture.tokenCalls.at(-1), actorA);
      assert.equal(clinicActions(fixture).length, 1);
      const call = clinicActions(fixture)[0];
      assert.equal(call.init.method, kind === "send" ? "POST" : "PATCH");
      const commandId = JSON.parse(String(call.init.body)).commandId;
      assert.match(commandId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
      assert.deepEqual(JSON.parse(String(call.init.body)), kind === "send"
        ? { commandId, operatorId: ui.profileId, clinicBrief: "Synthetic technical agreement", pricePerArrivalMinor: "0", leadScope: "assigned" }
        : { commandId, id: ui.requestId, action: kind });
      assert.equal(ui.refreshes(), kind === "send" ? 0 : 1);
    } finally { ui.dispose(); fixture.renderer.dispose(); }
  }
});

test("clinic collaboration queued token waits stop at raw account/logout/A-B-A boundaries", async () => {
  for (const kind of ["send", "withdraw", "end"] as const) for (const boundary of ["actor", "logout", "roundtrip"]) {
    const fixture = await ready(), ui = await clinicAction(fixture, kind), token = deferred<string>();
    let work: Promise<void> | undefined;
    try {
      fixture.token(() => token.promise); work = ui.invoke(); await ui.renderer.flush();
      assert.equal(clinicActions(fixture).length, 0);
      fixture.emit(boundary === "logout" ? null : actorB); if (boundary === "roundtrip") fixture.emit(actorA);
      const writes = ui.renderer.writes.length;
      token.resolve("synthetic-token"); await work; await ui.renderer.flush();
      assert.equal(clinicActions(fixture).length, 0, `${kind}/${boundary}`);
      assert.equal(ui.renderer.writes.length, writes);
      assert.equal(ui.refreshes(), 0);
    } finally { token.resolve("synthetic-token"); await work; ui.dispose(); fixture.renderer.dispose(); }
  }
});

test("clinic collaboration expired retained handlers stop before state or token lookup", async () => {
  for (const kind of ["send", "withdraw", "end"] as const) for (const boundary of ["actor", "logout", "roundtrip"]) {
    const fixture = await ready(), ui = await clinicAction(fixture, kind);
    try {
      fixture.emit(boundary === "logout" ? null : actorB); if (boundary === "roundtrip") fixture.emit(actorA);
      const writes = ui.renderer.writes.length, lookups = fixture.tokenCalls.length;
      await ui.invoke(); await ui.renderer.flush();
      assert.equal(ui.renderer.writes.length, writes, `${kind}/${boundary}`);
      assert.equal(fixture.tokenCalls.length, lookups);
      assert.equal(clinicActions(fixture).length, 0);
    } finally { ui.dispose(); fixture.renderer.dispose(); }
  }
});

test("clinic collaboration late outcomes cannot mutate UI after raw SDK expiry", async () => {
  for (const kind of ["send", "withdraw", "end"] as const) for (const outcome of [200, 401, 403, "network"] as const) {
    const fixture = await ready(), ui = await clinicAction(fixture, kind), reply = deferred<Response>();
    let work: Promise<void> | undefined;
    try {
      fixture.reply(() => reply.promise); work = ui.invoke(); await ui.renderer.flush();
      assert.equal(clinicActions(fixture).length, 1);
      fixture.emit(actorB); fixture.emit(actorA);
      const writes = ui.renderer.writes.length;
      if (outcome === "network") reply.reject(new Error("Synthetic transport failure"));
      else reply.resolve(Response.json({ success: outcome === 200 }, { status: outcome }));
      await work; await ui.renderer.flush();
      assert.equal(ui.renderer.writes.length, writes, `${kind}/${outcome}`);
      assert.equal(ui.refreshes(), 0);
      assert.equal(clinicActions(fixture).length, 1);
    } finally { reply.resolve(ok()); await work; ui.dispose(); fixture.renderer.dispose(); }
  }
});

test("clinic collaboration allows token refresh for the same actor", async () => {
  for (const kind of ["send", "withdraw", "end"] as const) {
    const fixture = await ready(), ui = await clinicAction(fixture, kind), token = deferred<string>();
    let work: Promise<void> | undefined;
    try {
      fixture.token(() => token.promise); work = ui.invoke(); await ui.renderer.flush();
      fixture.emit(actorA, "TOKEN_REFRESHED"); token.resolve("synthetic-rotated-token");
      await work; await ui.renderer.flush();
      assert.equal(clinicActions(fixture).length, 1);
      assert.equal(new Headers(clinicActions(fixture)[0].init.headers).get("Authorization"), "Bearer synthetic-rotated-token");
      assert.equal(fixture.tokenCalls.at(-1), actorA);
    } finally { token.resolve("synthetic-rotated-token"); await work; ui.dispose(); fixture.renderer.dispose(); }
  }
});

test("clinic collaboration refuses a different SDK actor before the parent receives an auth event", async () => {
  for (const kind of ["send", "withdraw", "end"] as const) {
    const fixture = await ready(), ui = await clinicAction(fixture, kind), lookup = deferred<void>();
    let work: Promise<void> | undefined;
    try {
      const auth = evaluate(await read("artifacts/negis/src/lib/serverAuth.ts"), {}, {
        "@/lib/supabase": { hasSupabaseFrontendEnv: true, supabase: { auth: { async getSession() {
          await lookup.promise;
          return { data: { session: { user: { id: actorB }, access_token: "synthetic-other-actor" } }, error: null };
        } } } },
        "@/lib/authSignOut": { isSignOutPending: () => false, getSignOutRevision: () => 0 },
      });
      fixture.token(expected => auth.getSupabaseAccessToken(expected));
      work = ui.invoke(); await ui.renderer.flush();
      assert.equal(clinicActions(fixture).length, 0);
      lookup.resolve(); await work; await ui.renderer.flush();
      assert.equal(fixture.access().isCurrent(), true, "Actor mismatch must be refused even without a parent auth event");
      assert.equal(fixture.tokenCalls.at(-1), actorA);
      assert.equal(clinicActions(fixture).length, 0);
    } finally { lookup.resolve(); await work; ui.dispose(); fixture.renderer.dispose(); }
  }
});

test("clinic collaboration rechecks expiry after the end confirmation dialog", async () => {
  const fixture = await ready();
  const ui = await clinicAction(fixture, "end", () => { fixture.emit(actorB); fixture.emit(actorA); return true; });
  try {
    const writes = ui.renderer.writes.length, lookups = fixture.tokenCalls.length;
    await ui.invoke(); await ui.renderer.flush();
    assert.equal(ui.renderer.writes.length, writes);
    assert.equal(fixture.tokenCalls.length, lookups);
    assert.equal(clinicActions(fixture).length, 0);
  } finally { ui.dispose(); fixture.renderer.dispose(); }
});

test("clinic collaboration repeated submit retains one real pending token lookup and POST", async () => {
  const fixture = await ready(), ui = await clinicAction(fixture, "send"), token = deferred<string>();
  let work: Promise<void> | undefined;
  try {
    fixture.token(() => token.promise);
    const lookups = fixture.tokenCalls.length;
    work = ui.invoke(); await ui.invoke(); await ui.renderer.flush();
    assert.equal(fixture.tokenCalls.length, lookups + 1);
    assert.equal(clinicActions(fixture).length, 0);
    token.resolve("synthetic-token"); await work; await ui.renderer.flush();
    assert.equal(clinicActions(fixture).length, 1);
  } finally { token.resolve("synthetic-token"); await work; ui.dispose(); fixture.renderer.dispose(); }
});

const clinicLeadSource = read("artifacts/negis/src/components/operators/OperatorLeads.tsx");
async function clinicAssignment(fixture: Fixture) {
  const [clinicSource, requestSource, , operatorSource, contractsSource] = await clinicSources;
  const leadSource = await clinicLeadSource;
  const contracts = evaluate(contractsSource);
  const children = [hookRenderer(), hookRenderer(), hookRenderer(), hookRenderer()];
  const operator = evaluate(select(operatorSource, ["OperatorApiError", "operatorApi"]), {
    crmFetch: fixture.fetch, CrmApiError: fixture.api.CrmApiError, crmErrorMessage: fixture.api.crmErrorMessage,
  }).selected;
  const requestId = "00000000-0000-4000-8000-000000000030";
  const lead = { id: "00000000-0000-4000-8000-000000000031", name: "Synthetic assignment",
    phone: "+70000000000", status: "new", assigned: false };
  let refreshes = 0;
  const list = (items: unknown[]) => ({ data: { items, hasMore: false }, offset: 0, error: "",
    refresh: () => { refreshes++; }, next() {}, previous() {} });
  fixture.snapshot().setActiveTab("operators"); await fixture.renderer.flush();
  const clinicProps = nodes(fixture.renderer.tree()).find(node => node.type === "ClinicOperators")?.props;
  assert.ok(clinicProps);
  const directory = list([]);
  const clinic = evaluate(clinicSource, {}, {
    react: children[0].hooks, "@/lib/operatorApi": { ...operator, useOperatorList: () => directory },
    "@/lib/useOperatorCommand": commandHook(children[0]),
    "../../../../../lib/crm/operator-contracts": contracts,
  });
  children[0].mount(clinic.ClinicOperators, [], clinicProps); await children[0].flush();
  const requestProps = nodes(children[0].tree()).find(node => node.type === "OperatorRequests")?.props;
  assert.ok(requestProps);
  const requestsList = list([{ id: requestId, status: "accepted", displayName: "Synthetic operator",
    clinicBrief: "Synthetic agreement", pricePerArrivalMinor: "0", currency: "KZT", leadScope: "assigned" }]);
  const requests = evaluate(requestSource, { window: { confirm: () => true } }, {
    react: children[1].hooks, "@/lib/operatorApi": { ...operator, useOperatorList: () => requestsList },
    "@/lib/useOperatorCommand": commandHook(children[1]),
    "./OperatorCommandRecovery": { OperatorCommandRecovery: "OperatorCommandRecovery" },
    "@/lib/serverAuth": { getSupabaseAccessToken: fixture.getToken },
    "@/lib/supabase": { supabase: { auth: { getSession: fixture.sdkSession } } },
    "./OperatorLeads": { OperatorLeads: "OperatorLeads" },
    "./OperatorServiceCatalog": { OperatorServiceCatalog: "OperatorServiceCatalog" },
    "./OperatorArrivals": { OperatorArrivals: "OperatorArrivals" },
    "../../../../../lib/crm/operator-contracts": contracts,
  });
  children[1].mount(requests.OperatorRequests, [], requestProps); await children[1].flush();
  const open = nodes(children[1].tree()).find(node => node.type === "button" && label(node).trim() === "Назначить заявки");
  assert.ok(open); open.props.onClick(); await children[1].flush();
  const leadProps = nodes(children[1].tree()).find(node => node.type === "OperatorLeads")?.props;
  assert.ok(leadProps);
  const ast = ts.createSourceFile("OperatorLeads.tsx", leadSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "LeadList") as import("typescript").FunctionDeclaration;
  const returned = component.body!.statements.filter(ts.isReturnStatement).at(-1)!;
  let action!: (item: typeof lead, assigned: boolean) => Promise<void>;
  const observed = leadSource.slice(0, returned.getStart(ast)) + "\n__observeAssign(assign);\n" + leadSource.slice(returned.getStart(ast));
  const imports = (renderer: ReturnType<typeof hookRenderer>) => ({
    react: renderer.hooks, "@/lib/operatorApi": { ...operator, useOperatorList: () => leadsList },
    "./OperatorBookingForm": { OperatorBookingForm: "OperatorBookingForm" },
    "../../../../../lib/crm/operator-contracts": contracts,
  });
  const bindings = { __observeAssign: (handler: typeof action) => { action = handler; },
    window: { addEventListener() {}, removeEventListener() {} },
    document: { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" } };
  const leadsList = list([lead]);
  const outer = evaluate(leadSource, bindings, imports(children[2]));
  children[2].mount(outer.OperatorLeads, [], leadProps); await children[2].flush();
  const listProps = nodes(children[2].tree()).find(node => typeof node.type === "function" && node.type.name === "LeadList")?.props;
  assert.ok(listProps);
  const inner = evaluate(observed + "\nexports.fixture = { LeadList };", bindings, imports(children[3]));
  children[3].mount(inner.fixture.LeadList, [], listProps); await children[3].flush();
  const retained = action;
  return { lead, requestId, props: [clinicProps, requestProps, leadProps, listProps], renderer: children[3],
    invoke: (assigned = true) => retained(lead, assigned), refreshes: () => refreshes,
    dispose: () => children.forEach(child => child.dispose()) };
}
const clinicAssignments = (fixture: Fixture) => fixture.dispatches.filter(call =>
  call.path.startsWith("/api/crm/clinic-operator-leads?") && call.init.method === "PATCH");

test("clinic assignment parent chain preserves the actor and live session for assigning and removing", async () => {
  for (const assigned of [true, false]) {
    const fixture = await ready(), ui = await clinicAssignment(fixture);
    try {
      for (const props of ui.props) {
        assert.equal(props.actorId, actorA);
        assert.equal(props.isSessionCurrent, fixture.access().isCurrent);
      }
      await ui.invoke(assigned); await ui.renderer.flush();
      assert.equal(fixture.tokenCalls.at(-1), actorA);
      assert.equal(clinicAssignments(fixture).length, 1);
      assert.deepEqual(JSON.parse(String(clinicAssignments(fixture)[0].init.body)), { leadId: ui.lead.id, assigned });
      assert.equal(ui.refreshes(), 1);
    } finally { ui.dispose(); fixture.renderer.dispose(); }
  }
});

test("clinic assignment queued transport stops on raw SDK account logout and A-B-A boundaries", async () => {
  for (const assigned of [true, false]) for (const boundary of ["actor", "logout", "roundtrip"]) {
    const fixture = await ready(), ui = await clinicAssignment(fixture), token = deferred<string>();
    let work: Promise<void> | undefined;
    try {
      fixture.token(() => token.promise); work = ui.invoke(assigned); await ui.renderer.flush();
      assert.equal(clinicAssignments(fixture).length, 0);
      fixture.emit(boundary === "logout" ? null : actorB); if (boundary === "roundtrip") fixture.emit(actorA);
      const writes = ui.renderer.writes.length;
      token.resolve("synthetic-original-token"); await work; await ui.renderer.flush();
      assert.equal(clinicAssignments(fixture).length, 0, `${assigned}/${boundary}`);
      assert.equal(ui.renderer.writes.length, writes);
      assert.equal(ui.refreshes(), 0);
    } finally { token.resolve("synthetic-original-token"); await work; ui.dispose(); fixture.renderer.dispose(); }
  }
});

test("clinic assignment expired retained handlers stop before token lookups or state writes", async () => {
  for (const boundary of ["actor", "logout", "roundtrip"]) {
    const fixture = await ready(), ui = await clinicAssignment(fixture);
    try {
      fixture.emit(boundary === "logout" ? null : actorB); if (boundary === "roundtrip") fixture.emit(actorA);
      const writes = ui.renderer.writes.length, lookups = fixture.tokenCalls.length;
      await ui.invoke(); await ui.renderer.flush();
      assert.equal(ui.renderer.writes.length, writes, boundary);
      assert.equal(fixture.tokenCalls.length, lookups);
      assert.equal(clinicAssignments(fixture).length, 0);
    } finally { ui.dispose(); fixture.renderer.dispose(); }
  }
});

test("clinic assignment late outcomes cannot refresh or publish after raw SDK expiry", async () => {
  for (const boundary of ["actor", "logout", "roundtrip"]) for (const outcome of [200, 401, 403, "network"] as const) {
    const fixture = await ready(), ui = await clinicAssignment(fixture), reply = deferred<Response>();
    let work: Promise<void> | undefined;
    try {
      fixture.reply(() => reply.promise); work = ui.invoke(); await ui.renderer.flush();
      assert.equal(clinicAssignments(fixture).length, 1);
      fixture.emit(boundary === "logout" ? null : actorB); if (boundary === "roundtrip") fixture.emit(actorA);
      const writes = ui.renderer.writes.length;
      if (outcome === "network") reply.reject(new Error("Synthetic assignment transport failure"));
      else reply.resolve(Response.json({ success: outcome === 200 }, { status: outcome }));
      await work; await ui.renderer.flush();
      assert.equal(ui.renderer.writes.length, writes, `${boundary}/${outcome}`);
      assert.equal(ui.refreshes(), 0);
      assert.equal(clinicAssignments(fixture).length, 1, "Already sent writes are not claimed to be canceled");
    } finally { reply.resolve(ok()); await work; ui.dispose(); fixture.renderer.dispose(); }
  }
});

test("clinic assignment still permits same-actor token refresh", async () => {
  const fixture = await ready(), ui = await clinicAssignment(fixture), token = deferred<string>();
  let work: Promise<void> | undefined;
  try {
    fixture.token(() => token.promise); work = ui.invoke(); await ui.renderer.flush();
    fixture.emit(actorA, "TOKEN_REFRESHED"); token.resolve("synthetic-rotated-token");
    await work; await ui.renderer.flush();
    assert.equal(clinicAssignments(fixture).length, 1);
    assert.equal(fixture.tokenCalls.at(-1), actorA);
    assert.equal(new Headers(clinicAssignments(fixture)[0].init.headers).get("Authorization"), "Bearer synthetic-rotated-token");
    assert.equal(ui.refreshes(), 1);
  } finally { token.resolve("synthetic-rotated-token"); await work; ui.dispose(); fixture.renderer.dispose(); }
});

test("clinic assignment rejects a different real serverAuth actor before parent auth events", async () => {
  const fixture = await ready(), ui = await clinicAssignment(fixture), lookup = deferred<void>();
  let work: Promise<void> | undefined;
  try {
    const auth = evaluate(await read("artifacts/negis/src/lib/serverAuth.ts"), {}, {
      "@/lib/supabase": { hasSupabaseFrontendEnv: true, supabase: { auth: { async getSession() {
        await lookup.promise;
        return { data: { session: { user: { id: actorB }, access_token: "synthetic-other-actor" } }, error: null };
      } } } },
      "@/lib/authSignOut": { isSignOutPending: () => false, getSignOutRevision: () => 0 },
    });
    fixture.token(expected => auth.getSupabaseAccessToken(expected));
    work = ui.invoke(); await ui.renderer.flush(); lookup.resolve(); await work; await ui.renderer.flush();
    assert.equal(fixture.access().isCurrent(), true);
    assert.equal(fixture.tokenCalls.at(-1), actorA);
    assert.equal(clinicAssignments(fixture).length, 0);
    assert.equal(ui.refreshes(), 1, "Live-scope authentication refusal still refreshes protected data");
  } finally { lookup.resolve(); await work; ui.dispose(); fixture.renderer.dispose(); }
});

test("clinic assignment repeated invocation owns one pending lookup and PATCH", async () => {
  const fixture = await ready(), ui = await clinicAssignment(fixture), token = deferred<string>();
  let work: Promise<void> | undefined, duplicate: Promise<void> | undefined;
  try {
    fixture.token(() => token.promise); const lookups = fixture.tokenCalls.length;
    work = ui.invoke(); duplicate = ui.invoke(); await ui.renderer.flush();
    assert.equal(fixture.tokenCalls.length, lookups + 1);
    token.resolve("synthetic-original-token"); await work; await duplicate; await ui.renderer.flush();
    assert.equal(clinicAssignments(fixture).length, 1);
  } finally { token.resolve("synthetic-original-token"); await work; await duplicate; ui.dispose(); fixture.renderer.dispose(); }
});

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
  fixture.snapshot().setInviteForm({ email: "single.fixture", role: fixture.snapshot().inviteForm.role });
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
    assert.deepEqual(JSON.parse(String(fixture.renderer.instance("AdminCenterSession").key)), [actorA, workspaceA, "owner", false, "clinic_services", 2]);
    assert.equal(fixture.access().isCurrent(), true);
    assert.equal(access.isCurrent(), false);
  } finally { fixture.renderer.dispose(); }
});

test("actor, workspace, role and purpose changes each remount content and expire captured access", async () => {
  for (const patch of [{ user: { id: actorB, email: "head@example.test" } }, { clinicId: workspaceB }, { userRole: "manager" },
    { workspacePurpose: "mortgage_leads" as const }, { workspacePurpose: "marketing" as const }, { workspacePurpose: null }]) {
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

const metaSaveLabel = "\u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c Meta config";
const metaServerNotice = "\u0421\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u043e \u0432 Supabase";
// Safe public response from lib/crm/server.ts's exact Meta binding conflict branch.
const metaConflictBody = {
  success: false,
  code: "meta_account_binding_conflict",
  error: "\u041f\u0440\u0438\u0432\u044f\u0437\u043a\u0430 Meta \u0443\u0436\u0435 \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0430 \u0434\u0440\u0443\u0433\u0438\u043c \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435\u043c",
  details: ["\u041e\u0431\u043d\u043e\u0432\u0438\u0442\u0435 \u0441\u043f\u0438\u0441\u043e\u043a \u043f\u0440\u0438\u0432\u044f\u0437\u043e\u043a \u0438 \u043f\u0440\u043e\u0432\u0435\u0440\u044c\u0442\u0435 \u0441\u043e\u0445\u0440\u0430\u043d\u0451\u043d\u043d\u044b\u0435 \u0434\u0430\u043d\u043d\u044b\u0435 \u043f\u0435\u0440\u0435\u0434 \u043f\u043e\u0432\u0442\u043e\u0440\u043e\u043c."],
};
type MetaSaveOutcome = "conflict" | "success";
function metaSaveResponse(outcome: MetaSaveOutcome) {
  return outcome === "conflict" ? Response.json(metaConflictBody, { status: 409 }) : ok();
}
function metaSaveCalls(fixture: Fixture) {
  return fixture.calls.filter((call) => call.path === "/api/crm/meta-accounts");
}
function editMetaField(fixture: Fixture, field: string, value: string) {
  const control = nodes(fixture.renderer.tree()).find((node) => node.props.label === field);
  assert.equal(typeof control?.props.onChange, "function", "actual Meta field must be rendered");
  control!.props.onChange(value);
}
async function metaDraft(fixture: Fixture, name: string) {
  fixture.snapshot().setActiveTab("meta"); await fixture.renderer.flush();
  editMetaField(fixture, "Ad Account ID", "act_local_g5_fixture");
  editMetaField(fixture, "Account name", name); await fixture.renderer.flush();
  assert.equal(typeof fixture.snapshot().saveMetaConfig, "function");
  return clone(fixture.snapshot().metaAccount);
}

for (const initialMode of ["none", "supabase"]) {
  test("G5 actual Meta save conflict warns without server success from " + initialMode, async () => {
    const fixture = await ready();
    try {
      const draft = await metaDraft(fixture, "Synthetic G5 conflict draft");
      if (initialMode === "supabase") {
        await button(fixture, metaSaveLabel).props.onClick(); await fixture.renderer.flush();
      }
      assert.equal(fixture.snapshot().metaConfigMode, initialMode);
      const start = fixture.toasts.length, snapshots = fixture.snapshots.length;
      const pending = deferred<Response>(); fixture.reply(async () => pending.promise);
      const saved = button(fixture, metaSaveLabel).props.onClick(); await fixture.renderer.flush();
      assert.equal(fixture.snapshot().loading.meta, true);
      assert.equal(buttons(fixture, metaSaveLabel)[0].props.disabled, true);
      assert.equal(fixture.toasts.length, start, "pending save cannot claim success");
      pending.resolve(metaSaveResponse("conflict")); await saved; await fixture.renderer.flush();
      assert.deepEqual(fixture.toasts.slice(start), [{ kind: "warning", message: metaConflictBody.error }]);
      assert.equal(fixture.snapshot().metaConfigMode, "local");
      assert.deepEqual(clone(fixture.snapshot().metaAccount), draft, "conflict preserves the local draft, not an invented row");
      assert.equal(fixture.snapshot().loading.meta, false);
      button(fixture, metaSaveLabel);
      assert.ok(!label(fixture.renderer.tree()).includes(metaServerNotice));
      assert.ok(fixture.snapshots.slice(snapshots).filter((snapshot) => snapshot.loading.meta === false)
        .every((snapshot) => snapshot.metaConfigMode !== "supabase"), "settled conflict must never advertise a server save");
      const call = metaSaveCalls(fixture).at(-1)!;
      assert.equal(fixture.dispatches.filter((entry) => entry.path === call.path).length, initialMode === "supabase" ? 2 : 1);
      assert.equal(fixture.tokenCalls.at(-1), actorA);
      assert.equal(call.init.method, "POST"); assert.equal(call.init.expectedUserId, actorA);
      assert.equal(call.init.cache, "no-store"); assert.equal(call.init.signal?.aborted, false);
      assert.deepEqual(JSON.parse(String(call.init.body)), { workspaceId: workspaceA, ...draft,
        metadata: { permissions: draft.permissions, manualApprovalOnly: true, liveLaunchEnabled: false } });
    } finally { fixture.renderer.dispose(); }
  });
}

test("G5 actual Meta save retries a conflict under the same current actor without inventing a row", async () => {
  const fixture = await ready();
  try {
    const draft = await metaDraft(fixture, "Synthetic G5 retry draft"), access = fixture.access();
    const content = fixture.renderer.instance("AdminCenterContent");
    fixture.reply(async () => metaSaveResponse("conflict"));
    await button(fixture, metaSaveLabel).props.onClick(); await fixture.renderer.flush();
    assert.equal(fixture.snapshot().metaConfigMode, "local");
    assert.deepEqual(fixture.toasts, [{ kind: "warning", message: metaConflictBody.error }]);
    fixture.emit(actorA, "TOKEN_REFRESHED"); await fixture.renderer.flush();
    assert.equal(fixture.renderer.instance("AdminCenterContent"), content); assert.equal(access.isCurrent(), true);
    const pending = deferred<Response>(); fixture.reply(async () => pending.promise);
    const retried = button(fixture, metaSaveLabel).props.onClick(); await fixture.renderer.flush();
    assert.equal(fixture.snapshot().metaConfigMode, "local"); assert.equal(fixture.snapshot().loading.meta, true);
    assert.equal(fixture.toasts.length, 1);
    pending.resolve(metaSaveResponse("success")); await retried; await fixture.renderer.flush();
    const saves = metaSaveCalls(fixture);
    assert.equal(saves.length, 2, "no automatic retry, lookup or fabricated row");
    assert.equal(fixture.dispatches.filter((call) => call.path === "/api/crm/meta-accounts").length, 2);
    assert.ok(saves.every((call) => call.init.method === "POST" && call.init.expectedUserId === actorA
      && call.init.cache === "no-store" && call.init.signal === saves[0].init.signal));
    assert.equal(saves[0].init.body, saves[1].init.body);
    assert.equal(JSON.parse(String(saves[1].init.body)).id, undefined);
    assert.deepEqual(clone(fixture.snapshot().metaAccount), draft);
    assert.equal(fixture.snapshot().metaConfigMode, "supabase"); assert.equal(fixture.snapshot().loading.meta, false);
    assert.deepEqual(fixture.toasts.map((toast) => toast.kind), ["warning", "success"]);
    assert.ok(label(fixture.renderer.tree()).includes(metaServerNotice)); button(fixture, metaSaveLabel);
  } finally { fixture.renderer.dispose(); }
});

for (const boundary of ["actor", "workspace", "role", "purpose", "sdk-roundtrip"] as const) {
  for (const outcome of ["conflict", "success"] as const) {
    test("G5 old Meta " + outcome + " cannot publish across " + boundary + " while the new save is busy", async () => {
      for (const phase of ["transport", "body"]) {
        const fixture = await ready();
        const response = deferred<Response>(), body = deferred<string>(), nextResponse = deferred<Response>();
        try {
          await metaDraft(fixture, "Synthetic G5 old draft");
          const old = fixture.renderer.instance("AdminCenterContent"), closure = fixture.snapshot(), access = fixture.access();
          let bodyReads = 0;
          const reply = metaSaveResponse(outcome);
          fixture.reply(async () => phase === "transport" ? response.promise : ({
            ok: reply.ok, status: reply.status, text: () => { bodyReads++; return body.promise; },
          }) as Response);
          const saved = button(fixture, metaSaveLabel).props.onClick(); await fixture.renderer.flush();
          const oldCall = metaSaveCalls(fixture).at(-1)!;
          assert.equal(fixture.snapshot().loading.meta, true);
          assert.equal(bodyReads, phase === "body" ? 1 : 0, "suspend the actual requested boundary");
          fixture.reply();
          if (boundary === "actor") {
            fixture.emit(actorB); fixture.setAuth({ user: { id: actorB, email: "other@example.test" } });
          }
          if (boundary === "workspace") fixture.setAuth({ clinicId: workspaceB });
          if (boundary === "role") fixture.setAuth({ userRole: "admin" });
          if (boundary === "purpose") fixture.setAuth({ workspacePurpose: "marketing" });
          if (boundary === "sdk-roundtrip") { fixture.emit(actorB); fixture.emit(actorA); }
          await fixture.renderer.flush();
          assert.equal(old.disposed, true); assert.equal(access.isCurrent(), false);
          assert.equal(oldCall.init.signal?.aborted, true);
          assert.equal(fixture.snapshot().serverAdminAuth.status, "confirmed");
          await metaDraft(fixture, "Synthetic G5 new draft");
          // Give the new lifetime the opposite mode so either stale outcome is observable.
          const currentOutcome = outcome === "conflict" ? "success" : "conflict";
          fixture.reply(async () => metaSaveResponse(currentOutcome));
          await button(fixture, metaSaveLabel).props.onClick(); await fixture.renderer.flush();
          const mode = currentOutcome === "success" ? "supabase" : "local";
          assert.equal(fixture.snapshot().metaConfigMode, mode);
          fixture.reply(async () => nextResponse.promise);
          const currentSave = button(fixture, metaSaveLabel).props.onClick(); await fixture.renderer.flush();
          editMetaField(fixture, "Account name", "Synthetic G5 unsaved new draft"); await fixture.renderer.flush();
          const draft = clone(fixture.snapshot().metaAccount), loading = clone(fixture.snapshot().loading);
          const start = fixture.renderer.writes.length, toastStart = clone(fixture.toasts);
          const storageStart = fixture.storageWrites.length, callStart = fixture.calls.length, tokenStart = fixture.tokenCalls.length;
          assert.equal(loading.meta, true);
          await closure.saveMetaConfig("configured");
          response.resolve(metaSaveResponse(outcome)); body.resolve(await reply.text());
          await saved; await fixture.renderer.flush();
          assert.equal(fixture.renderer.writes.length, start, phase + ": expired work must not attempt state writes");
          assert.equal(fixture.calls.length, callStart); assert.equal(fixture.tokenCalls.length, tokenStart);
          assert.equal(fixture.storageWrites.length, storageStart); assert.deepEqual(fixture.toasts, toastStart);
          assert.equal(fixture.snapshot().metaConfigMode, mode);
          assert.deepEqual(clone(fixture.snapshot().metaAccount), draft);
          assert.deepEqual(clone(fixture.snapshot().loading), loading);
          assert.equal(buttons(fixture, metaSaveLabel)[0].props.disabled, true, "old finally must not release the new busy state");
          const currentCall = metaSaveCalls(fixture).at(-1)!;
          assert.equal(currentCall.init.expectedUserId, boundary === "actor" ? actorB : actorA);
          assert.equal(JSON.parse(String(currentCall.init.body)).workspaceId, boundary === "workspace" ? workspaceB : workspaceA);
          assert.equal(currentCall.init.signal?.aborted, false);
          nextResponse.resolve(metaSaveResponse(currentOutcome)); await currentSave; await fixture.renderer.flush();
          assert.equal(fixture.snapshot().loading.meta, false);
          assert.equal(fixture.snapshot().metaConfigMode, mode);
          assert.deepEqual(clone(fixture.snapshot().metaAccount), draft); button(fixture, metaSaveLabel);
        } finally {
          fixture.renderer.dispose();
          response.resolve(ok()); body.resolve("{}"); nextResponse.resolve(ok());
        }
      }
    });
  }
}

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

test("role/workspace/purpose remount, disposal and StrictMode replay stop a deferred bulk before its next POST", async () => {
  for (const boundary of ["role", "workspace", "purpose", "dispose", "strict-mode"] as const) {
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
      else if (boundary === "purpose") fixture.setAuth({ workspacePurpose: "mortgage_leads" });
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

const prohibitedTabs = ["overview", "operators", "creators", "doctors", "roles", "clinic", "integrations",
  "ai", "meta", "release", "diagnostics"];
const mortgageUi = {
  team: "\u041a\u043e\u043c\u0430\u043d\u0434\u0430",
  member: "\u0423\u0447\u0430\u0441\u0442\u043d\u0438\u043a",
  return: "\u0412\u0435\u0440\u043d\u0443\u0442\u044c\u0441\u044f \u0432 \u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u0435",
  copyId: "\u0421\u043a\u043e\u043f\u0438\u0440\u043e\u0432\u0430\u0442\u044c \u0438\u0434\u0435\u043d\u0442\u0438\u0444\u0438\u043a\u0430\u0442\u043e\u0440 \u043f\u0440\u043e\u0441\u0442\u0440\u0430\u043d\u0441\u0442\u0432\u0430",
};
function assertMortgageTree(tree: any) {
  const all = nodes(tree);
  for (const name of ["PlanCalculator", "VerticalSwitch", "ClinicOperators", "CreatorJobs", "DoctorSchedule", "WhatsAppChannels",
    "TikTokSetupCheck", "TikTokConnection", "TikTokVideoUpload", "MetricCard", "ReleaseBanner"]) {
    assert.ok(all.every((node) => (typeof node.type === "function" ? node.type.name : node.type) !== name),
      `${name} must never be mounted for mortgage`);
  }
  assert.equal(all.filter((node) => node.type === "details").length, 0, "platform diagnostics must be absent");
  assert.doesNotMatch(label(tree), /\u043a\u043b\u0438\u043d\u0438\u043a|Meta\/Facebook|Release checklist/i);
}
function assertMortgageNetwork(fixture: Fixture) {
  for (const call of fixture.calls) {
    assert.match(call.path, /^\/api\/crm\/(auth-context|staff|staff-invitations|staff-credentials|staff-join-requests|join-code|whatsapp-channels)\?/,
      "mortgage may only dispatch authentication, team or existing channel requests");
  }
}

test("mortgage starts on staff, rejects every prohibited query/tab and never mounts or fetches clinic/advertising tools", async () => {
  for (const requested of ["", "staff", "unknown", ...prohibitedTabs]) {
    const fixture = setup(requested ? `?tab=${requested}` : "");
    fixture.setAuth({ workspacePurpose: "mortgage_leads" });
    try {
      await fixture.renderer.flush();
      assert.equal(fixture.snapshot().serverAdminAuth.status, "confirmed");
      assert.ok(fixture.snapshots.every((snapshot) => snapshot.activeTab === "staff"),
        "even the first content frame must be staff, before effects run");
      assert.ok(authPanel(fixture)); assert.ok(staffCreation(fixture));
      const header = nodes(fixture.renderer.tree()).find((node) => node.type === "p" && label(node) === logins.loginFromEmail("owner@example.test"))!;
      assert.equal(label(header), logins.loginFromEmail("owner@example.test"));
      assert.ok(!label(header).includes(workspaceA), "The support copy action retains the ID without cluttering the team header");
      assert.doesNotMatch(label(header), /\u0412\u043b\u0430\u0434\u0435\u043b\u0435\u0446:/);
      assert.equal(fixture.snapshot().inviteForm.role, "lead_manager");
      assert.equal(fixture.snapshot().batchRole, "lead_manager");
      const nav = nodes(fixture.renderer.tree()).find((node) => node.type === "nav")!;
      assert.deepEqual(nodes(nav).filter((node) => node.type === "button").map(label), [mortgageUi.team, "WhatsApp"]);
      const selector = nodes(fixture.renderer.tree()).find((node) => node.type === "select" && node.props.value === "staff")!;
      assert.deepEqual(nodes(selector).filter((node) => node.type === "option").map((node) => node.props.value), ["staff", "whatsapp"]);
      const callsBefore = fixture.calls.length;
      for (const prohibited of prohibitedTabs) {
        fixture.snapshot().setActiveTab(prohibited);
        selector.props.onChange({ target: { value: prohibited } });
        await fixture.renderer.flush();
        assert.equal(fixture.snapshot().activeTab, "staff");
      }
      await fixture.snapshot().loadMetaInsightsDiagnostics(); await fixture.renderer.flush();
      assert.equal(fixture.calls.length, callsBefore, "blocked tab changes and diagnostic callbacks dispatch nothing");
      for (const tree of fixture.renderer.trees) assertMortgageTree(tree);
      assertMortgageNetwork(fixture);
      assert.equal(fixture.dispatches.filter((call) => call.init.method === "POST").length, 0);
      button(fixture, mortgageUi.return).props.onClick();
      assert.deepEqual(fixture.locations, ["/leads"]);
      await button(fixture, mortgageUi.copyId).props.onClick();
      assert.deepEqual(fixture.copies, [workspaceA]);
      assert.deepEqual(fixture.storageWrites, []);
    } finally { fixture.renderer.dispose(); }
  }
});

for (const role of ["owner", "admin"] as const) {
  test(`mortgage ${role} role pickers intersect the profile roles with server-confirmed assignment rights`, async () => {
    const fixture = setup(); fixture.setAuth({ workspacePurpose: "mortgage_leads" });
    fixture.reply(async (url) => {
      if (url.includes("/auth-context?")) return Response.json(authBody({ role }));
      if (url.includes("/staff?")) return ok({ staff: roster });
      if (url.includes("/staff-join-requests?")) return ok({ requests: [{ id: "join-local", status: "pending", email: "join@example.test" }] });
      return ok({ login: "mortgage.issued", invitations: [], code: "LOCAL123" });
    });
    try {
      await fixture.renderer.flush();
      assert.equal(fixture.snapshot().serverAdminAuth.role, role, "server role, not the stale client owner, controls choices");
      button(fixture, staffUi.bulk).props.onClick();
      button(fixture, "\u041e\u0434\u043e\u0431\u0440\u0438\u0442\u044c").props.onClick(); await fixture.renderer.flush();
      const choices = role === "owner" ? ["lead_manager", "admin"] : ["lead_manager"];
      const pickers = () => nodes(fixture.renderer.tree()).filter((node) => node.type === "select" && node.props.value !== "staff");
      assert.equal(pickers().length, 5, "mobile/desktop membership, join approval, single and bulk all have role pickers");
      for (const picker of pickers()) {
        assert.deepEqual(nodes(picker).filter((node) => node.type === "option" && node.props.value)
          .map((node) => node.props.value), choices);
      }
      const single = formControls(fixture).find((node) => node.type === "select")!;
      single.props.onChange({ target: { value: choices.at(-1) } }); await fixture.renderer.flush();
      const controls = formControls(fixture).filter((node) => node.type === "input");
      controls[0].props.onChange({ target: { value: "new.mortgage" } });
      controls[2].props.onChange({ target: { value: "LocalMortgage234" } }); await fixture.renderer.flush();
      await button(fixture, staffUi.add).props.onClick(); await fixture.renderer.flush();
      const created = fixture.dispatches.find((call) => call.path.includes("/staff-credentials?") && call.init.method === "POST")!;
      assert.equal(JSON.parse(String(created.init.body)).role, choices.at(-1), "owner can create admin, admin can create only lead_manager");
      assert.equal(fixture.snapshot().inviteForm.role, "lead_manager", "successful creation resets to the mortgage default");
      button(fixture, staffUi.inviteMode).props.onClick(); await fixture.renderer.flush();
      for (const picker of pickers()) {
        assert.deepEqual(nodes(picker).filter((node) => node.type === "option" && node.props.value)
          .map((node) => node.props.value), choices);
      }
      formControls(fixture).find((node) => node.props.type === "email")!.props.onChange({ target: { value: "new.mortgage@example.test" } });
      await fixture.renderer.flush(); await button(fixture, staffUi.invite).props.onClick(); await fixture.renderer.flush();
      assert.equal(fixture.snapshot().inviteForm.role, "lead_manager", "invitation reset keeps the same allowed default");
      assertMortgageNetwork(fixture); assert.deepEqual(fixture.storageWrites, []);
    } finally { fixture.renderer.dispose(); }
  });
}

test("mortgage retains the server-admin gate and hides credentials during checking and every auth failure", async () => {
  for (const scenario of deniedStaffChecks) {
    const fixture = setup(); fixture.setAuth({ workspacePurpose: "mortgage_leads" });
    try {
      await fixture.renderer.flush();
      const { results, markers } = await seedStaffResults(fixture);
      const pending = deferred<Response>(); fixture.reply(() => pending.promise);
      button(fixture, staffUi.checkAccess).props.onClick(); await fixture.renderer.flush();
      assert.equal(fixture.snapshot().serverAdminAuth.status, "checking");
      assertStaffHidden(fixture, markers); assert.ok(authPanel(fixture));
      fixture.reply(async () => scenario.response()); pending.resolve(scenario.response()); await fixture.renderer.flush();
      assert.equal(fixture.snapshot().serverAdminAuth.status, scenario.status);
      assertStaffHidden(fixture, markers); assert.deepEqual(staffResults(fixture), results);
      assertMortgageTree(fixture.renderer.tree()); assertMortgageNetwork(fixture);
      if (scenario.status === "reauth") {
        button(fixture, "\u0412\u043e\u0439\u0442\u0438 \u0441\u043d\u043e\u0432\u0430").props.onClick();
        assert.deepEqual(fixture.locations, ["/login"]);
      }
      assert.deepEqual(fixture.storageWrites, []);
    } finally { fixture.renderer.dispose(); }
  }
});

test("live scope independently rejects a same-account/workspace purpose change before outer remount", async () => {
  for (const workspacePurpose of ["mortgage_leads", "marketing", null] as const) {
    const fixture = setup(); fixture.mountSession(); await fixture.renderer.flush();
    try {
      const old = fixture.renderer.instance("AdminCenterContent"), access = fixture.access();
      const closure = fixture.snapshot(), count = fixture.calls.length;
      fixture.setAuth({ workspacePurpose }); await fixture.renderer.flush();
      assert.equal(fixture.renderer.instance("AdminCenterContent"), old, "pin the session props to isolate the live-scope comparison");
      assert.equal(access.isCurrent(), false);
      await assert.rejects(closure.crmFetch("/api/crm/staff"), { name: "AbortError" });
      await assert.rejects(closure.crmRequest("/api/crm/staff"), { name: "AbortError" });
      await closure.checkServerAdminAccess();
      assert.equal(fixture.calls.length, count, "retained callbacks cannot dispatch for the changed profile");
    } finally { fixture.renderer.dispose(); }
  }
});

test("purpose transitions cancel pending token waits for auth and credentials without late POSTs or state writes", async () => {
  for (const action of ["checkServerAdminAccess", "createStaffWithPassword", "createStaffBatch"] as const) {
    const fixture = await ready();
    try {
      fixture.snapshot().setInviteForm({ email: "pending.fixture", role: "receptionist" });
      fixture.snapshot().setStaffPassword("LocalPending234");
      fixture.snapshot().setBatchEmails("first@example.test\nsecond@example.test"); await fixture.renderer.flush();
      const pending = deferred<string>(); fixture.token(() => pending.promise);
      const old = fixture.renderer.instance("AdminCenterContent"), access = fixture.access();
      const saved = fixture.snapshot()[action](); await fixture.renderer.flush();
      const call = fixture.calls.at(-1)!;
      fixture.token(); fixture.setAuth({ workspacePurpose: "mortgage_leads" }); await fixture.renderer.flush();
      assert.equal(access.isCurrent(), false); assert.equal(old.disposed, true);
      if (action !== "checkServerAdminAccess") assert.equal(call.init.signal?.aborted, true);
      const count = fixture.dispatches.length, start = fixture.renderer.writes.length;
      pending.resolve("local-fixture-token"); await saved;
      assert.equal(fixture.dispatches.length, count, "old token resolution dispatches nothing");
      assert.equal(fixture.dispatches.filter((entry) => entry.init.method === "POST").length, 0);
      assert.deepEqual(contentWrites(fixture, old, start), []); assert.deepEqual(fixture.toasts, []);
      assert.equal(fixture.snapshot().activeTab, "staff");
      assert.deepEqual(staffResults(fixture), { createdStaff: null, issuedInvite: null, batchResults: null });
      assertMortgageTree(fixture.renderer.tree());
    } finally { fixture.renderer.dispose(); }
  }
});

test("a pending clinic Meta diagnostic body cannot publish into the same workspace's mortgage profile", async () => {
  const fixture = setup(), body = deferred<string>();
  fixture.reply(async (url) => url.includes("/meta-")
    ? ({ ok: true, status: 200, text: () => body.promise }) as Response
    : Response.json(authBody()));
  try {
    await fixture.renderer.flush();
    assert.equal(fixture.snapshot().serverAdminAuth.status, "confirmed");
    const meta = fixture.dispatches.filter((call) => call.path.includes("/meta-"));
    assert.equal(meta.length, 3, "the real clinic diagnostics effect is awaiting its three response bodies");
    const old = fixture.renderer.instance("AdminCenterContent"), access = fixture.access();
    fixture.reply(); fixture.setAuth({ workspacePurpose: "mortgage_leads" });
    const count = fixture.calls.length; await fixture.renderer.flush();
    assert.equal(access.isCurrent(), false); assert.equal(old.disposed, true);
    assert.ok(meta.every((call) => call.init.signal?.aborted));
    assert.ok(fixture.calls.slice(count).every((call) => !call.path.includes("/meta-")));
    const start = fixture.renderer.writes.length;
    body.resolve(JSON.stringify({ success: true, data: { launches: [{ id: "expired-clinic" }], runs: [], insights: [] } }));
    await fixture.renderer.flush();
    assert.deepEqual(contentWrites(fixture, old, start), []); assert.deepEqual(fixture.toasts, []);
    assertMortgageTree(fixture.renderer.tree());
  } finally { fixture.renderer.dispose(); }
});

test("same-account/workspace purpose round trips remount and never restore old credentials or drafts", async () => {
  for (const initial of ["clinic_services", "mortgage_leads"] as const) {
    const fixture = setup(); fixture.setAuth({ workspacePurpose: initial }); await fixture.renderer.flush();
    try {
      const { markers } = await seedStaffResults(fixture);
      const old = fixture.renderer.instance("AdminCenterContent"), access = fixture.access();
      const key = fixture.renderer.instance("AdminCenterSession").key;
      const nextPurpose = initial === "clinic_services" ? "mortgage_leads" : "clinic_services";
      for (const workspacePurpose of [nextPurpose, initial] as const) {
        fixture.setAuth({ workspacePurpose }); await fixture.renderer.flush();
        assert.equal(old.disposed, true); assert.equal(access.isCurrent(), false);
        assert.notEqual(fixture.renderer.instance("AdminCenterContent"), old);
        assert.equal(fixture.snapshot().activeTab, workspacePurpose === "mortgage_leads" ? "staff" : "overview");
        assert.deepEqual(staffResults(fixture), { createdStaff: null, issuedInvite: null, batchResults: null });
        assert.equal(fixture.snapshot().staffPassword, ""); assert.equal(fixture.snapshot().batchEmails, "");
        assert.equal(fixture.snapshot().inviteForm.email, "");
        assert.equal(fixture.snapshot().inviteForm.role, workspacePurpose === "mortgage_leads" ? "lead_manager" : "receptionist");
        for (const marker of markers) assert.ok(!renderedText(fixture).includes(marker));
      }
      assert.equal(fixture.renderer.instance("AdminCenterSession").key, key, "returning to the same key must still create a fresh lifetime");
      assert.deepEqual(fixture.storageWrites, []);
    } finally { fixture.renderer.dispose(); }
  }
});

test("creator jobs receive the existing verified company session and cannot revive after raw SDK A-B-A", async () => {
  const fixture = await ready();
  try {
    fixture.snapshot().setActiveTab("creators"); await fixture.renderer.flush();
    const props = nodes(fixture.renderer.tree()).find(node => node.type === "CreatorJobs")?.props;
    assert.ok(props, "Traverse actual AdminCenter forwarding JSX");
    assert.equal(props.actorId, fixture.access().actorId); assert.equal(props.workspaceId, fixture.access().workspaceId);
    assert.equal(props.isSessionCurrent(), true);
    fixture.emit("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"); assert.equal(props.isSessionCurrent(), false);
    fixture.emit(props.actorId); assert.equal(props.isSessionCurrent(), false, "Original session stays retired after returning to A");
    assert.deepEqual(fixture.storageWrites, []);
  } finally { fixture.renderer.dispose(); }
});

test("clinic and salon keep overview, diagnostics, billing, vertical switch and specialist query tabs", async () => {
  for (const vertical of ["clinic", "beauty"]) {
    const fixture = setup(); fixture.setAuth({ vertical, workspacePurpose: "clinic_services" });
    try {
      await fixture.renderer.flush();
      assert.equal(fixture.snapshot().activeTab, "overview");
      const all = nodes(fixture.renderer.tree());
      for (const name of ["PlanCalculator", "VerticalSwitch", "MetricCard"]) assert.ok(all.some((node) => node.type === name));
      assert.ok(all.some((node) => node.type === "details"));
      assert.ok(fixture.dispatches.some((call) => call.path.includes("/meta-launches?")));
      const nav = all.find((node) => node.type === "nav")!;
      assert.equal(nodes(nav).filter((node) => node.type === "button").length, prohibitedTabs.length + 2);
      const specialistLabel = terms.capitalize(terms.termsFor(vertical).specialistPlural);
      button(fixture, specialistLabel).props.onClick(); await fixture.renderer.flush();
      assert.ok(nodes(fixture.renderer.tree()).some((node) => node.type === "DoctorSchedule"));
      fixture.snapshot().setActiveTab("whatsapp"); await fixture.renderer.flush();
      assert.ok(nodes(fixture.renderer.tree()).some((node) => node.type === "WhatsAppChannels"), "clinic keeps its existing toggle panel");
      assert.equal(nodes(fixture.renderer.tree()).some((node) => node.props["data-testid"] === "mortgage-whatsapp-channels"), false);
    } finally { fixture.renderer.dispose(); }
    const linked = setup("?tab=doctors"); linked.setAuth({ vertical, workspacePurpose: "clinic_services" });
    try {
      await linked.renderer.flush(); assert.equal(linked.snapshot().activeTab, "doctors");
      assert.ok(nodes(linked.renderer.tree()).some((node) => node.type === "DoctorSchedule"));
    } finally { linked.renderer.dispose(); }
  }
});

const disableIntake = "\u0412\u044b\u043a\u043b\u044e\u0447\u0438\u0442\u044c \u043f\u0440\u0438\u0451\u043c \u0437\u0430\u044f\u0432\u043e\u043a";
const refreshChannels = "\u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c";
function channelPanel(fixture: Fixture) {
  return nodes(fixture.renderer.tree()).find((node) => node.props["data-testid"] === "mortgage-whatsapp-channels");
}
function channelCalls(fixture: Fixture) {
  return fixture.calls.filter((call) => call.path.includes("/whatsapp-channels?"));
}
async function readyChannels() {
  const fixture = setup("?tab=whatsapp");
  fixture.setAuth({ workspacePurpose: "mortgage_leads" });
  await fixture.renderer.flush();
  assert.ok(channelPanel(fixture)); assert.equal(fixture.snapshot().mortgageChannels.length, 3);
  return fixture;
}

test("mortgage channel navigation and reads require both owner/admin client role and server confirmation", async () => {
  for (const role of ["owner", "admin", "lead_manager", "manager", "receptionist", "doctor", "marketer", "agent", "booking_agent"]) {
    const fixture = setup("?tab=whatsapp");
    fixture.setAuth({ workspacePurpose: "mortgage_leads", userRole: role });
    const pending = deferred<Response>();
    fixture.reply(async (url) => url.includes("/auth-context?") ? pending.promise : ok());
    try {
      await fixture.renderer.flush();
      assert.equal(channelPanel(fixture), undefined); assert.equal(channelCalls(fixture).length, 0);
      fixture.reply(); pending.resolve(Response.json(authBody())); await fixture.renderer.flush();
      const allowed = role === "owner" || role === "admin";
      const nav = nodes(fixture.renderer.tree()).find((node) => node.type === "nav")!;
      assert.deepEqual(nodes(nav).filter((node) => node.type === "button").map(label), allowed ? [mortgageUi.team, "WhatsApp"] : [mortgageUi.team]);
      const selector = nodes(fixture.renderer.tree()).find((node) => node.type === "select" && ["staff", "whatsapp"].includes(node.props.value))!;
      assert.deepEqual(nodes(selector).filter((node) => node.type === "option").map((node) => node.props.value), allowed ? ["staff", "whatsapp"] : ["staff"]);
      assert.equal(Boolean(channelPanel(fixture)), allowed);
      assert.equal(channelCalls(fixture).length, allowed ? 1 : 0);
      selector.props.onChange({ target: { value: "staff" } }); await fixture.renderer.flush();
      selector.props.onChange({ target: { value: "whatsapp" } }); await fixture.renderer.flush();
      assert.equal(fixture.snapshot().activeTab, allowed ? "whatsapp" : "staff");
      assert.equal(channelCalls(fixture).length, allowed ? 2 : 0);
      await fixture.snapshot().disableMortgageChannel(channelRows[0]);
      if (!allowed) assert.equal(channelCalls(fixture).length, 0, "a forged callback cannot give manager roles channel access");
      assertMortgageTree(fixture.renderer.tree()); assertMortgageNetwork(fixture);
    } finally { fixture.renderer.dispose(); }
  }
  for (const scenario of deniedStaffChecks) {
    const fixture = setup("?tab=whatsapp"); fixture.setAuth({ workspacePurpose: "mortgage_leads" });
    fixture.reply(async () => scenario.response());
    try {
      await fixture.renderer.flush();
      assert.equal(channelPanel(fixture), undefined); assert.equal(channelCalls(fixture).length, 0);
      await fixture.snapshot().loadMortgageChannels(); await fixture.snapshot().disableMortgageChannel(channelRows[0]);
      assert.equal(channelCalls(fixture).length, 0);
    } finally { fixture.renderer.dispose(); }
  }
  for (const workspacePurpose of ["clinic_services", "marketing", null] as const) {
    const fixture = setup("?tab=whatsapp"); fixture.setAuth({ workspacePurpose });
    try {
      await fixture.renderer.flush(); assert.equal(channelPanel(fixture), undefined);
      await fixture.snapshot().loadMortgageChannels(); await fixture.snapshot().disableMortgageChannel(channelRows[0]);
      assert.equal(channelCalls(fixture).length, 0, "only mortgage purpose may dispatch through the new panel");
      assert.ok(nodes(fixture.renderer.tree()).some((node) => node.type === "WhatsAppChannels"));
    } finally { fixture.renderer.dispose(); }
  }
});

test("mortgage displays only masked DTO fields and disables existing channels without any enable or binding controls", async () => {
  const fixture = await readyChannels();
  const pending = deferred<Response>();
  try {
    fixture.reply(async (_url, init) => init.method === "PATCH" ? pending.promise : ok({ channels: channelRows.map((row) => ({ ...row,
      phone: "synthetic-phone-marker", credential: "synthetic-credential-marker", chats: ["synthetic-chat-marker"] })) }));
    await fixture.snapshot().loadMortgageChannels(); await fixture.renderer.flush();
    const panel = channelPanel(fixture)!;
    for (const marker of ["\u2026abcd", "\u2026efgh", "\u2026ijkl", "17", "23", "29", "31"]) assert.ok(label(panel).includes(marker));
    assert.doesNotMatch(label(panel), /synthetic-(phone|credential|chat)-marker/);
    assert.equal(nodes(panel).some((node) => ["input", "textarea", "select", "a", "Link"].includes(node.type)), false);
    assert.deepEqual(nodes(panel).filter((node) => node.type === "button").map(label), [refreshChannels, disableIntake, disableIntake]);
    assert.deepEqual(Object.keys(fixture.snapshot().mortgageChannels[0]).sort(), Object.keys(channelRows[0]).sort());
    const action = buttons(fixture, disableIntake)[0];
    action.props.onClick(); action.props.onClick(); await fixture.renderer.flush();
    const patches = channelCalls(fixture).filter((call) => call.init.method === "PATCH");
    assert.equal(patches.length, 1, "synchronous busy guard prevents duplicate mutations");
    assert.deepEqual(JSON.parse(String(patches[0].init.body)), { id: "channel-local", provider: "wazzup", enabled: false });
    assert.match(patches[0].path, new RegExp(`workspaceId=${workspaceA}$`));
    assert.equal(patches[0].init.expectedUserId, actorA); assert.equal(patches[0].init.cache, "no-store");
    assert.equal(patches[0].init.signal?.aborted, false);
    assert.equal(buttons(fixture, refreshChannels)[0].props.disabled, true);
    assert.ok(buttons(fixture, disableIntake).every((entry) => entry.props.disabled));
    assert.equal(fixture.snapshot().mortgageChannels[0].enabled, true, "no optimistic success");
    const count = channelCalls(fixture).length;
    await fixture.snapshot().loadMortgageChannels(); assert.equal(channelCalls(fixture).length, count);
    pending.resolve(ok({ item: { id: "channel-local", enabled: false } })); await fixture.renderer.flush();
    assert.deepEqual(clone(fixture.snapshot().mortgageChannels.map((row: any) => row.enabled)), [false, true, false], "provider and id together identify a channel");
    assert.equal(buttons(fixture, disableIntake).length, 1);
    assert.equal(fixture.toasts.filter((entry) => entry.kind === "success").length, 1);
    await fixture.snapshot().disableMortgageChannel(fixture.snapshot().mortgageChannels[0]);
    await fixture.snapshot().disableMortgageChannel({ ...channelRows[2], enabled: true });
    fixture.reply(async () => ok({ item: { id: "channel-local", enabled: false } }));
    await buttons(fixture, disableIntake)[0].props.onClick(); await fixture.renderer.flush();
    const writes = channelCalls(fixture).filter((call) => call.init.method === "PATCH");
    assert.equal(writes.length, 2); assert.ok(writes.every((call) => JSON.parse(String(call.init.body)).enabled === false));
    assert.equal(JSON.parse(String(writes[1].init.body)).provider, "whatsapp_cloud");
    assert.equal(buttons(fixture, disableIntake).length, 0, "disabled channels have no action at all");
    assert.deepEqual(fixture.storageWrites, []);
  } finally { fixture.renderer.dispose(); }
});

test("mortgage channel reads distinguish empty data, API errors, demo responses and malformed DTOs", async () => {
  for (const reply of [
    () => Response.json({ success: false, error: "Local refusal" }, { status: 502 }),
    () => ok(), () => Response.json({ success: true, mode: "demo", data: { channels: [] } }),
    () => Response.json({ mode: "supabase", data: { channels: [] } }),
    () => ok({ channels: [{ ...channelRows[0], enabled: "true" }] }),
    () => ok({ channels: [{ ...channelRows[0], leadsFiled: -1 }] }),
    () => ok({ channels: [{ ...channelRows[0], provider: "unknown" }] }),
    () => { throw new Error("Local transport failure"); },
  ]) {
    const fixture = await readyChannels(); fixture.reply(async () => reply());
    try {
      await fixture.snapshot().loadMortgageChannels(); await fixture.renderer.flush();
      assert.equal(fixture.snapshot().mortgageChannels, null);
      assert.ok(nodes(channelPanel(fixture)).some((node) => node.props.role === "alert"));
      assert.equal(buttons(fixture, disableIntake).length, 0); assert.equal(fixture.toasts.some((entry) => entry.kind === "success"), false);
      assert.equal(fixture.snapshot().mortgageChannelsLoading, false);
      fixture.reply(async () => ok({ channels: [] }));
      await fixture.snapshot().loadMortgageChannels(); await fixture.renderer.flush();
      assert.deepEqual(clone(fixture.snapshot().mortgageChannels), []); assert.equal(fixture.snapshot().mortgageChannelsError, "");
      assert.equal(nodes(channelPanel(fixture)).some((node) => node.props.role === "alert"), false);
    } finally { fixture.renderer.dispose(); }
  }
});

test("mortgage channel mutations never report success for rejected or unconfirmed disables", async () => {
  for (const reply of [
    () => Response.json({ success: false, error: "Local refusal" }, { status: 400 }),
    () => Response.json({ success: false, error: "Local refusal" }, { status: 404 }),
    () => Response.json({ success: false, error: "Local refusal" }, { status: 502 }),
    () => Response.json({ success: false }), () => ok(),
    () => ok({ item: { id: "channel-local", enabled: true } }),
    () => ok({ item: { id: "another-channel", enabled: false } }),
    () => Response.json({ success: true, mode: "demo", data: { item: { id: "channel-local", enabled: false } } }),
    () => { throw new Error("Local transport failure"); },
  ]) {
    const fixture = await readyChannels(); fixture.reply(async () => reply());
    try {
      await fixture.snapshot().disableMortgageChannel(channelRows[0]); await fixture.renderer.flush();
      assert.equal(fixture.snapshot().mortgageChannels[0].enabled, true);
      assert.ok(fixture.snapshot().mortgageChannelsError);
      assert.equal(fixture.toasts.filter((entry) => entry.kind === "error").length, 1);
      assert.equal(fixture.toasts.some((entry) => entry.kind === "success"), false);
      assert.equal(fixture.snapshot().mortgageChannelBusy, null); assert.equal(buttons(fixture, disableIntake)[0].props.disabled, false);
    } finally { fixture.renderer.dispose(); }
  }
});

test("a confirmed mortgage disable wins over older reads and only the latest refresh may publish", async () => {
  const fixture = await readyChannels(); const body = deferred<string>();
  try {
    fixture.reply(async (_url, init) => init.method === "PATCH" ? ok({ item: { id: "channel-local", enabled: false } })
      : ({ ok: true, status: 200, text: () => body.promise }) as Response);
    const read = fixture.snapshot().loadMortgageChannels(); await fixture.renderer.flush();
    await fixture.snapshot().disableMortgageChannel(channelRows[0]); await fixture.renderer.flush();
    body.resolve(JSON.stringify({ success: true, mode: "supabase", data: { channels: channelRows } })); await read; await fixture.renderer.flush();
    assert.equal(fixture.snapshot().mortgageChannels[0].enabled, false); assert.equal(fixture.snapshot().mortgageChannelsLoading, false);
    const older = deferred<Response>(); let count = 0;
    fixture.reply(async () => ++count === 1 ? older.promise : ok({ channels: [] }));
    const first = fixture.snapshot().loadMortgageChannels();
    await fixture.snapshot().loadMortgageChannels(); await fixture.renderer.flush();
    older.resolve(Response.json({ success: false }, { status: 502 })); await first; await fixture.renderer.flush();
    assert.deepEqual(clone(fixture.snapshot().mortgageChannels), []); assert.equal(fixture.snapshot().mortgageChannelsError, "");
  } finally { fixture.renderer.dispose(); }
});

test("mortgage channel GET/PATCH revocations clear the panel, abort sibling reads and reject retained actions", async () => {
  for (const status of [401, 403]) for (const method of ["GET", "PATCH"]) {
    const fixture = await readyChannels(); const body = deferred<string>();
    try {
      const closure = fixture.snapshot();
      fixture.reply(async () => ({ ok: true, status: 200, text: () => body.promise }) as Response);
      const sibling = closure.loadMortgageChannels(); await fixture.renderer.flush();
      const siblingCall = channelCalls(fixture).at(-1)!;
      fixture.reply(async () => Response.json({ success: false, error: "Local membership revoked" }, { status }));
      if (method === "GET") await closure.loadMortgageChannels(); else await closure.disableMortgageChannel(channelRows[0]);
      await fixture.renderer.flush();
      assert.equal(fixture.snapshot().serverAdminAuth.status, status === 401 ? "reauth" : "forbidden");
      assert.equal(fixture.snapshot().mortgageChannels, null); assert.equal(channelPanel(fixture), undefined);
      assert.equal(siblingCall.init.signal?.aborted, true);
      const count = channelCalls(fixture).length, start = fixture.renderer.writes.length;
      await closure.loadMortgageChannels(); await closure.disableMortgageChannel(channelRows[0]);
      body.resolve(JSON.stringify({ success: true, mode: "supabase", data: { channels: channelRows } })); await sibling;
      await fixture.renderer.flush();
      assert.equal(channelCalls(fixture).length, count); assert.equal(fixture.renderer.writes.length, start);
      assert.equal(fixture.toasts.some((entry) => entry.kind === "success"), false);
    } finally { fixture.renderer.dispose(); }
  }
});

test("an older mortgage read auth denial still revokes a newer pending disable", async () => {
  for (const status of [401, 403]) {
    const fixture = await readyChannels(); const readReply = deferred<Response>(), patchReply = deferred<Response>();
    try {
      fixture.reply(async (_url, init) => init.method === "PATCH" ? patchReply.promise : readReply.promise);
      const read = fixture.snapshot().loadMortgageChannels(); await fixture.renderer.flush();
      const patch = fixture.snapshot().disableMortgageChannel(channelRows[0]); await fixture.renderer.flush();
      const patchCall = channelCalls(fixture).at(-1)!;
      readReply.resolve(Response.json({ success: false }, { status })); await read; await fixture.renderer.flush();
      assert.equal(channelPanel(fixture), undefined); assert.equal(patchCall.init.signal?.aborted, true);
      const start = fixture.renderer.writes.length;
      patchReply.resolve(ok({ item: { id: "channel-local", enabled: false } })); await patch; await fixture.renderer.flush();
      assert.equal(fixture.renderer.writes.length, start); assert.equal(fixture.toasts.some((entry) => entry.kind === "success"), false);
    } finally { fixture.renderer.dispose(); }
  }
});

test("mortgage channel work cannot cross account/workspace/role/purpose, auth recheck, tab or StrictMode lifetimes", async () => {
  for (const boundary of ["actor", "workspace", "role", "purpose", "sdk-roundtrip", "recheck", "tab", "strict"] as const) {
    for (const method of ["GET", "PATCH"]) {
      const fixture = await readyChannels(); const body = deferred<string>();
      try {
        const closure = fixture.snapshot(), old = fixture.renderer.instance("AdminCenterContent");
        fixture.reply(async () => ({ ok: true, status: 200, text: () => body.promise }) as Response);
        const work = method === "GET" ? closure.loadMortgageChannels() : closure.disableMortgageChannel(channelRows[0]);
        await fixture.renderer.flush(); const call = channelCalls(fixture).at(-1)!;
        fixture.reply();
        if (boundary === "actor") fixture.setAuth({ user: { id: actorB, email: "other@example.test" } });
        if (boundary === "workspace") fixture.setAuth({ clinicId: workspaceB });
        if (boundary === "role") fixture.setAuth({ userRole: "lead_manager" });
        if (boundary === "purpose") fixture.setAuth({ workspacePurpose: "clinic_services" });
        if (boundary === "sdk-roundtrip") { fixture.emit(actorB); fixture.emit(actorA); }
        if (boundary === "recheck") await closure.checkServerAdminAccess();
        if (boundary === "tab") closure.setActiveTab("staff");
        if (boundary === "strict") fixture.renderer.replaySessionLayout();
        await fixture.renderer.flush();
        assert.equal(call.init.signal?.aborted, true, `${boundary} ${method} must cancel body consumption`);
        const count = channelCalls(fixture).length, start = fixture.renderer.writes.length, toasts = fixture.toasts.length;
        body.resolve(JSON.stringify({ success: true, mode: "supabase", data: method === "GET" ? { channels: channelRows } : { item: { id: "channel-local", enabled: false } } }));
        await work; await fixture.renderer.flush();
        assert.equal(channelCalls(fixture).length, count);
        assert.deepEqual(contentWrites(fixture, old, start), []); assert.equal(fixture.toasts.length, toasts);
      } finally { fixture.renderer.dispose(); }
    }
  }
});

test("mortgage channel pending token waits never dispatch after account/workspace/role/purpose changes", async () => {
  for (const patch of [{ user: { id: actorB, email: "other@example.test" } }, { clinicId: workspaceB },
    { userRole: "lead_manager" }, { workspacePurpose: "clinic_services" as const }]) {
    const fixture = await readyChannels(); const token = deferred<string>();
    try {
      fixture.token(() => token.promise);
      const work = fixture.snapshot().disableMortgageChannel(channelRows[0]); await fixture.renderer.flush();
      fixture.token(); fixture.setAuth(patch); await fixture.renderer.flush();
      const count = fixture.dispatches.length;
      token.resolve("local-fixture-token"); await work; await fixture.renderer.flush();
      assert.equal(fixture.dispatches.length, count); assert.equal(fixture.toasts.some((entry) => entry.kind === "success"), false);
      assert.equal(fixture.dispatches.some((call) => call.path.includes("/whatsapp-channels?") && call.init.method === "PATCH"), false);
    } finally { fixture.renderer.dispose(); }
  }
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Executable source simulation: no DOM, real auth, collection/cache execution,
// environment reads or network. The strictAccess collection has its own tests.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const read = (file: string) => readFile(path.join(root, "artifacts/negis/src", file), "utf8");
const leads = await read("pages/LeadsPage.tsx");
const pipeline = await read("lib/leadPipeline.ts");
const teamAnalytics = await read("components/crm/lead-team-analytics.tsx");
const crmBrowserMocks = await readFile(path.join(root, "scripts/fixtures/crm-browser-mocks.ts"), "utf8");
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

function evaluate(source: string, bindings: Record<string, unknown> = {}, imports: Record<string, unknown> = {}) {
  const exports: Record<string, any> = {};
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  new Script(code).runInNewContext({ exports, ...bindings, AbortController, DOMException,
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

const { permissionsForRole, roleLabels } = evaluate(await read("lib/permissions.ts"));
const { staffRoleLabels } = evaluate(await readFile(path.join(root, "lib/vertical/terms.ts"), "utf8"));
const workspaceRoutes = evaluate(await read("lib/workspaceRoutes.ts"));

function select(source: string, names: string[]) {
  const ast = ts.createSourceFile("fixture.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return ast.statements.filter((node) =>
    (ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""))
    || (ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => names.includes(item.name.getText(ast)))))
    .map((node) => node.getText(ast)).join("\n") + `\nexports.selected = { ${names.join(", ")} };`;
}

type Node = { type: unknown; props: Record<string, any>; key?: unknown };
function jsx(type: unknown, props: Node["props"], key?: unknown): Node { return { type, props, key }; }
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
const sameDeps = (left?: unknown[], right?: unknown[]) => Boolean(left && right && left.length === right.length
  && left.every((value, index) => Object.is(value, right[index])));
const { teamBookingConversion, fixture: teamContract } = evaluate(
  teamAnalytics + "\nexports.fixture = { readAnalytics, safeSum };", {}, {
    react: {}, "@/lib/permissions": { roleLabels },
  });

function hookDriver() {
  const slots: any[] = [];
  let cursor = 0, dirty = true;
  let tree: any;
  let component = () => tree;
  function effect(create: () => unknown, deps?: unknown[], layout = false) {
    const index = cursor++;
    const old = slots[index];
    slots[index] = { create, deps, layout, cleanup: old?.cleanup, pending: !old || !sameDeps(old.deps, deps) };
  }
  const hooks = {
    useState(initial: any) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, (update: any) => {
        const next = typeof update === "function" ? update(slots[index].value) : update;
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true; }
      }];
    },
    useRef(initial: any) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useMemo(create: () => unknown, deps?: unknown[]) {
      const index = cursor++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: create(), deps };
      return slots[index].value;
    },
    useEffect: effect,
    useLayoutEffect: (create: () => unknown, deps?: unknown[]) => effect(create, deps, true),
  };
  return {
    hooks, mount(render: () => any) { component = render; dirty = true; },
    invalidate() { dirty = true; },
    async flush() {
      for (let pass = 0; pass < 40; pass++) {
        if (dirty) {
          dirty = false; cursor = 0; tree = component();
          const pending = slots.filter((item) => item?.pending);
          for (const item of pending) item.cleanup?.();
          for (const item of pending) { item.pending = false; item.cleanup = item.create(); }
        }
        await Promise.resolve();
      }
      assert.equal(dirty, false, "hook simulation must settle");
    },
    replayLayout() {
      const effects = slots.filter((item) => item?.layout);
      for (const item of effects) item.cleanup?.();
      for (const item of effects) item.cleanup = item.create();
    },
    tree: () => tree, nodes: () => nodes(tree),
    dispose() { for (const item of slots) item?.cleanup?.(); },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const actor = "00000000-0000-4000-8000-000000000001";
const workspace = "00000000-0000-4000-8000-000000000002";
const stageId = "00000000-0000-4000-8000-000000000003";
const stages = [
  { id: stageId, stageKey: "new", name: "Новая", semanticGroup: "new", isDefault: true, isActive: true, sortOrder: 10 },
  { id: "00000000-0000-4000-8000-000000000004", stageKey: "in_progress", name: "В работе", semanticGroup: "in_progress", isDefault: true, isActive: true, sortOrder: 20 },
  { id: "00000000-0000-4000-8000-000000000005", stageKey: "booked", name: "Записана", semanticGroup: "booked", isDefault: true, isActive: true, sortOrder: 30 },
  { id: "00000000-0000-4000-8000-000000000006", stageKey: "postponed", name: "Отложена", semanticGroup: "postponed", isDefault: true, isActive: true, sortOrder: 35 },
  { id: "00000000-0000-4000-8000-000000000007", stageKey: "lost", name: "Потеряна", semanticGroup: "lost", isDefault: true, isActive: true, sortOrder: 40 },
];
const lead = { id: "lead-1", name: "Local contact", phone: "+77000000000", status: "new", stageId,
  source: "website", campaign: "Preserve campaign", sourceId: workspace, responsibleUserId: actor,
  metaCampaignLaunchId: actor, notes: "Original note" };
type Access = { actorId: string; workspaceId: string; isCurrent: () => boolean;
  request: (path: string, init?: RequestInit) => Promise<Response>; loadTeamAnalytics: (days: number) => Promise<Response> };
type TeamAccess = Pick<Access, "isCurrent" | "loadTeamAnalytics">;

function setup(role = "lead_manager") {
  const driver = hookDriver();
  const callbacks = new Set<(event: string, session: any) => void>();
  let auth = { userRole: role, clinicId: workspace, user: { id: actor }, session: {}, rolePermissions: { crm: true, tasks: true },
    isDemoMode: false, isImpersonation: false, vertical: "clinic", workspacePurpose: "clinic_services", availableWorkspaces: [] };
  const requests: { path: string; init?: RequestInit & { expectedUserId?: string } }[] = [];
  const updates: { patch: any; payload: any }[] = [];
  const toasts: string[] = [];
  let collection: any;
  let items: any[] = [clone(lead)];
  let loadError = false;
  let reply: ((path: string) => Promise<Response>) | undefined;
  let saved: Promise<boolean> | undefined;
  const crmFetch = async (url: string, init?: RequestInit) => {
    requests.push({ path: url, init });
    if (reply) return reply(url);
    const resource = url.split("?")[0].split("/").pop();
    const data = resource === "lead-stages" ? { stages } : resource === "lead-assignees"
      ? { assignees: [{ id: actor, name: "Colleague", role: "receptionist", status: "active" }] }
      : resource === "meta-launches" ? { launches: [] } : { sources: [] };
    return Response.json({ success: true, mode: "supabase", data });
  };
  const sessionAuth = { onAuthStateChange(callback: Parameters<typeof callbacks.add>[0]) {
    callbacks.add(callback); return { data: { subscription: { unsubscribe: () => callbacks.delete(callback) } } };
  } };
  const module = evaluate(leads + "\nexports.fixture = { LeadsPageSession, LeadsPageContent, leadPatchToApi, loadTaxonomyList };", {
    window: { localStorage: { getItem: () => "admin", setItem: () => {} } },
  }, {
    react: driver.hooks,
    wouter: { Link: "Link", useLocation: () => ["/leads", () => {}] },
    sonner: { toast: new Proxy({}, { get: (_target, name) => () => toasts.push(String(name)) }) },
    "@/contexts/AuthContext": { useAuth: () => auth },
    "@/lib/supabase": { hasSupabaseFrontendEnv: true, supabase: { auth: sessionAuth }, sessionAuth },
    "@/lib/api": { crmFetch, apiUrl: (url: string) => url, clearCrmCache: () => {} },
    "@/lib/leadPipeline": evaluate(pipeline),
    "@/lib/phone": { formatPhone: (phone: string) => phone, phoneDigits: (phone: string) => phone.replace(/\D/g, ""),
      toTelHref: () => "tel:local", toWhatsappHref: () => "https://example.test" },
    "@/lib/demoStorage": {
      isRealWorkspace: () => true, readWorkspaceId: () => workspace, workspaceScopedKey: (key: string) => key,
      readDemoStorage: (_key: string, initial: unknown) => initial, writeDemoStorage: () => { throw new Error("Unexpected demo write"); },
      useDemoCollection: (_key: string, _seed: unknown, options: any) => {
        collection = options;
        return { items, loaded: true, loadError, setItems: () => {}, addItem: () => { throw new Error("Unexpected POST"); },
          updateItem: async (_id: string, patch: any) => {
            updates.push({ patch: clone(patch), payload: clone(options.patchToApi(patch)) });
            return saved ? await saved : true;
          } };
      },
    },
  });
  const access: Access = { actorId: actor, workspaceId: workspace, isCurrent: () => true, request: crmFetch,
    loadTeamAnalytics: async (days) => Response.json(teamPayload(days)) };
  return {
    driver, module, access, requests, updates, toasts, collection: () => collection,
    content() { driver.mount(() => module.fixture.LeadsPageContent({ access })); },
    lifetime() { driver.mount(() => module.fixture.LeadsPageSession({ actorId: actor, workspaceId: workspace })); },
    emit(id: string) { for (const callback of [...callbacks]) callback("SIGNED_IN", { user: { id } }); },
    setAuth(patch: Partial<typeof auth>) { auth = { ...auth, ...patch }; driver.invalidate(); },
    refuse() { loadError = true; items = []; driver.invalidate(); },
    empty() { items = []; driver.invalidate(); },
    setLeads(next: any[]) { items = next; driver.invalidate(); },
    reply(value: typeof reply) { reply = value; }, save(value: Promise<boolean>) { saved = value; },
  };
}
function button(driver: ReturnType<typeof hookDriver>, name: string) {
  const found = driver.nodes().find((node) => node.type === "button" && label(node.props.children) === name);
  assert.ok(found, `missing button: ${name}`); return found;
}

function teamPayload(days = 30) {
  return { success: true, mode: "supabase", data: { analytics: {
    timeZone: "Asia/Qyzylorda",
    generatedAt: "2026-10-15T10:00:00Z",
    period: { days, from: new Date(Date.parse("2026-10-15T10:00:00Z") - days * 86400000).toISOString(), to: "2026-10-15T10:00:00Z" },
    totalLeads: 20, unassignedLeads: 5, otherAssigneeLeads: 4, activityStatus: "available",
    members: [
      { staffId: "manager", name: "Manager fixture", role: "lead_manager", status: "active",
        assigned: { total: 9, new: 1, inProgress: 1, booked: 3, postponed: 1, lost: 1, other: 2 },
        activity: { updatedEvents: 13, createdEvents: 7, touchedLeads: 6, lastRecordedAt: "2026-10-14T09:00:00Z" } },
      { staffId: "admin", name: "Admin fixture", role: "admin", status: "paused",
        assigned: { total: 2, new: 0, inProgress: 0, booked: 0, postponed: 0, lost: 0, other: 2 }, activity: null },
      { staffId: "owner", name: "Owner fixture", role: "owner", status: "active",
        assigned: { total: 0, new: 0, inProgress: 0, booked: 0, postponed: 0, lost: 0, other: 0 },
        activity: { updatedEvents: 0, createdEvents: 0, touchedLeads: 0, lastRecordedAt: null } },
    ],
  } } };
}

function inconsistentTeamPayloads() {
  type Snapshot = ReturnType<typeof teamPayload>["data"]["analytics"];
  const cases: Array<[string, (analytics: Snapshot) => void]> = [
    ["duplicate staff IDs", (value) => { value.members[2].staffId = value.members[0].staffId; }],
    ["reversed period", (value) => { value.period.from = "2026-10-15T10:00:01Z"; }],
    ["period after generation", (value) => { value.period.to = "2026-10-15T10:00:01Z"; }],
    ["stage sum too high", (value) => { value.members[0].assigned.other += 1; }],
    ["stage sum too low", (value) => { value.members[0].assigned.other -= 1; }],
    ["postponed sum too high", (value) => { value.members[0].assigned.postponed += 1; }],
    ["postponed sum too low", (value) => { value.members[0].assigned.postponed -= 1; }],
    ["booked exceeds assigned", (value) => { value.members[0].assigned.booked = 10; }],
    ["lead census too high", (value) => { value.totalLeads += 1; }],
    ["lead census too low", (value) => { value.totalLeads -= 1; }],
    ["unassigned census mismatch", (value) => { value.unassignedLeads += 1; }],
    ["other assignee census mismatch", (value) => { value.otherAssigneeLeads += 1; }],
    ["empty staff without census adjustment", (value) => { value.members = []; }],
    ["stage sum overflow", (value) => {
      value.members = [value.members[0]];
      value.members[0].assigned = { total: Number.MAX_SAFE_INTEGER, new: Number.MAX_SAFE_INTEGER,
        inProgress: 0, booked: 1, postponed: 0, lost: 0, other: 0 };
      value.totalLeads = Number.MAX_SAFE_INTEGER; value.unassignedLeads = 0; value.otherAssigneeLeads = 0;
    }],
    ["lead census overflow", (value) => {
      value.members = [value.members[0]];
      value.members[0].assigned = { total: Number.MAX_SAFE_INTEGER, new: 0,
        inProgress: 0, booked: Number.MAX_SAFE_INTEGER, postponed: 0, lost: 0, other: 0 };
      value.totalLeads = Number.MAX_SAFE_INTEGER; value.unassignedLeads = 1; value.otherAssigneeLeads = 0;
    }],
    ["staff total sum overflow", (value) => {
      value.members[0].assigned = { total: Number.MAX_SAFE_INTEGER, new: 0,
        inProgress: 0, booked: Number.MAX_SAFE_INTEGER, postponed: 0, lost: 0, other: 0 };
      value.totalLeads = Number.MAX_SAFE_INTEGER; value.unassignedLeads = 0; value.otherAssigneeLeads = 0;
    }],
  ];
  return cases.map(([name, change]) => {
    const payload = teamPayload(); change(payload.data.analytics); return { name, payload };
  });
}

function teamResults(driver: ReturnType<typeof hookDriver>) {
  const section = driver.nodes().find((node) => node.props["aria-label"] === "Результаты по назначенным заявкам");
  assert.ok(section); return section;
}

function teamSummary(driver: ReturnType<typeof hookDriver>) {
  const summary = nodes(teamResults(driver)).find((node) => node.type === "dl"); assert.ok(summary);
  const values = nodes(summary).filter((node) => node.type === "dd").map(label);
  return Object.fromEntries(nodes(summary).filter((node) => node.type === "dt")
    .map((node, index) => [label(node), values[index]]));
}

function teamSetup(props: { initiallyExpanded?: boolean; heading?: string } = {}, initialAccess?: TeamAccess) {
  const driver = hookDriver();
  let current = true;
  const requests: Array<{ days: number; response: ReturnType<typeof deferred<Response>> }> = [];
  const access: TeamAccess = initialAccess ?? { isCurrent: () => current,
    loadTeamAnalytics: (days) => {
      const response = deferred<Response>(); requests.push({ days, response }); return response.promise;
    } };
  let propAccess = access;
  const module = evaluate(teamAnalytics, {}, { react: driver.hooks,
    "@/lib/permissions": { roleLabels },
  });
  driver.mount(() => module.LeadTeamAnalytics({ ...props, access: propAccess }));
  return {
    driver, requests, access,
    async toggle(open: boolean) {
      const details = driver.nodes().find((node) => node.type === "details"); assert.ok(details);
      details.props.onToggle({ currentTarget: { open } }); await driver.flush();
    },
    async period(days: number) {
      const select = driver.nodes().find((node) => node.type === "select"); assert.ok(select);
      select.props.onChange({ target: { value: String(days) } }); await driver.flush();
    },
    async refresh() {
      const refresh = driver.nodes().find((node) => node.props["aria-label"] === "Обновить работу команды"); assert.ok(refresh);
      refresh.props.onClick(); await driver.flush();
    },
    async resolve(index: number, payload = teamPayload(), status = 200) {
      requests[index].response.resolve(Response.json(payload, { status })); await driver.flush();
    },
    invalidate() { current = false; driver.invalidate(); },
    replaceAccess(next: TeamAccess) { propAccess = next; driver.invalidate(); },
    text: () => label(driver.tree()),
    cells(name = "Manager fixture") {
      const row = driver.nodes().find((node) => node.type === "tr" && label(node).includes(name)); assert.ok(row);
      return nodes(row).filter((node) => node.type === "td").map(label);
    },
  };
}

function browserTeamSetup(role = "owner", purpose = "mortgage_leads") {
  const snapshot = { timeZone: "Asia/Qyzylorda", members: [
    { id: "manager", name: "Manager fixture", role: "lead_manager", status: "active" },
    { id: "empty", name: "Empty fixture", role: "admin", status: "inactive" },
  ], contacts: [] as Array<{ responsibleUserId: string | null; status: string }>,
  metrics: { totalLeads: 0, unassignedLeads: 0 } };
  const storage = () => {
    const values = new Map<string, string>();
    return { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
  };
  let snapshotReads = 0;
  const module = evaluate(crmBrowserMocks + "\nexports.fixture = { teamMembers };", {
    window: { location: { pathname: "/analytics", search: `?fixtureRole=${role}&fixturePurpose=${purpose}` } },
    localStorage: storage(), sessionStorage: storage(), URL, URLSearchParams, Response,
  }, {
    "./booking-retry": {}, "./operator-dispatch-fixture": {}, "./mortgage-outcomes-browser-store": {},
    "./operator-browser-store": { createOperatorBrowserFixture: () => ({}) },
    "./clinic-arrival-browser-store": { isClinicArrivalFixtureLocation: () => false },
    "./appointment-create-browser-store": { isAppointmentCreateFixtureLocation: () => false },
    "./content-studio-browser-store": { isContentStudioFixtureLocation: () => false },
    "./advertising-demo-browser-store": { isAdvertisingDemoFixtureLocation: () => false },
    "../../artifacts/negis/src/lib/leadPipeline": evaluate(pipeline),
    "./mortgage-browser-store": { mortgageFixtureAdmin: { id: "admin", name: "Admin fixture" },
      mortgageBrowserRequest: async () => { snapshotReads += 1; return Response.json({ success: true, mode: "supabase", data: snapshot }); } },
  });
  return { module, snapshot, reads: () => snapshotReads,
    request: (resource = "lead-team-analytics", method = "GET") => module.crmFetch(`/api/crm/${resource}?days=30`, { method }) as Promise<Response> };
}

test("lead manager routes, home and both menus are leads-only; other route permissions are unchanged", async () => {
  const authSource = await read("contexts/AuthContext.tsx");
  const names = ["ALL_PERMISSIONS", "routePermissionsForStaffRole"];
  const current = evaluate(select(authSource, names), { permissionsForRole }).selected;
  const previous = evaluate(select(execFileSync("git", ["show", "HEAD:artifacts/negis/src/contexts/AuthContext.tsx"],
    { cwd: root, encoding: "utf8" }), names), { permissionsForRole }).selected;
  assert.deepEqual(clone(current.routePermissionsForStaffRole("lead_manager")),
    Object.fromEntries(Object.keys(current.ALL_PERMISSIONS).map((key) => [key, key === "crm"])));
  for (const role of ["owner", "admin", "manager", "receptionist", "doctor", "marketer"]) {
    assert.deepEqual(clone(current.routePermissionsForStaffRole(role)), clone(previous.routePermissionsForStaffRole(role)), role);
  }
  const app = await read("App.tsx");
  for (const location of ["/leads", "/clients", "/sales", "/dashboard", "/appointments", "/reports"]) {
    let redirected = "";
    const routes = evaluate(select(app, ["ROUTE_PERMISSIONS", "firstAllowedRoute", "ProtectedPage"]), {
      ...workspaceRoutes,
      useAuth: () => ({ userRole: "lead_manager", rolePermissions: current.ALL_PERMISSIONS, isLoading: false, workspacePurpose: "clinic_services" }),
      useLocation: () => [location, (url: string) => { redirected = url; }], useEffect: (run: () => void) => run(),
    }).selected;
    const tree = routes.ProtectedPage({ component: "Screen", permission: location === "/dashboard" ? "dashboard" : "crm" });
    assert.equal(tree?.type === "Screen", location === "/leads");
    assert.equal(redirected, location === "/leads" ? "" : "/leads");
  }
  const landing = evaluate(select(await read("pages/Landing.tsx"), ["roleRoute"])).selected;
  assert.equal(landing.roleRoute("lead_manager"), "/leads");
  for (const vertical of ["clinic", "beauty", "dental"] as const) assert.equal(staffRoleLabels(vertical).lead_manager, "Менеджер заявок");
  for (const file of ["Sidebar", "MobileNav"]) {
    const driver = hookDriver();
    const nav = evaluate(await read(`components/layout/${file}.tsx`), {}, {
      react: driver.hooks, wouter: { Link: "Link", useLocation: () => ["/leads", () => {}] },
      "react-dom": { flushSync: (callback: () => void) => callback() },
      "@/contexts/AuthContext": { useAuth: () => ({ userRole: "lead_manager", rolePermissions: current.ALL_PERMISSIONS,
        user: null, vertical: "clinic", workspacePurpose: "clinic_services", availableWorkspaces: [] }) },
      "@/lib/workspaceRoutes": workspaceRoutes,
      "@/lib/demoStorage": { isRealWorkspace: () => true },
      "@/lib/supabase": { hasSupabaseFrontendEnv: false, supabase: {} },
      "../../../../../lib/vertical/terms": { termsFor: () => ({}), capitalize: (word: string) => word },
      "../../../../../lib/auth/staff-logins": { loginFromEmail: () => "" }, "./ProfileDialog": { ProfileDialog: "ProfileDialog" },
    });
    driver.mount(() => nav[file]()); await driver.flush();
    if (file === "MobileNav") { button(driver, "Ещё").props.onClick(); await driver.flush(); }
    const links = driver.nodes().filter((node) => node.type === "Link").map((node) => node.props.href);
    assert.deepEqual(links, file === "Sidebar" ? ["/leads"] : []);
    assert.doesNotMatch(label(driver.tree()), /Клиенты|Продажи|Аналитика|Записи|Настройки|Статистика/);
    driver.dispose();
  }
});

test("restricted lead list/detail/edit omit forbidden controls and serialize only allowed fields", async () => {
  const fixture = setup(); fixture.content(); await fixture.driver.flush();
  assert.equal(fixture.collection().strictAccess, fixture.access);
  assert.deepEqual(fixture.requests.map((call) => call.path.split("?")[0]).sort(), ["/api/crm/lead-sources", "/api/crm/lead-stages"]);
  assert.doesNotMatch(label(fixture.driver.tree()), /Добавить заявку|Создать клиента|Записать|Админ режим/);
  button(fixture.driver, "Подробнее").props.onClick(); await fixture.driver.flush();
  assert.equal(fixture.driver.nodes().some((node) => ["TaskPanel", "ChangeLogPanel"].includes(String(node.type))), false);
  assert.equal(fixture.driver.nodes().some((node) => node.type === "Link"), false);
  fixture.driver.nodes().filter((node) => node.type === "button" && label(node.props.children) === "В работе")
    .at(-1)!.props.onClick(); await fixture.driver.flush();
  assert.deepEqual(Object.keys(fixture.updates[0].payload).sort(), ["stageId", "status"]);
  button(fixture.driver, "Изменить").props.onClick(); await fixture.driver.flush();
  const controls = fixture.driver.nodes().filter((node) => ["input", "select", "textarea"].includes(String(node.type)) && node.props.type !== "search");
  assert.deepEqual(controls.map((node) => node.type), ["input", "input", "select", "textarea"]);
  assert.deepEqual(clone(controls[2].props.children.map((node: Node) => label(node))), stages.map((stage) => stage.name));
  controls[0].props.onChange({ target: { value: "Edited local contact" } });
  controls[3].props.onChange({ target: { value: "Edited note" } }); await fixture.driver.flush();
  button(fixture.driver, "Сохранить").props.onClick(); await fixture.driver.flush();
  assert.deepEqual(fixture.updates[1].payload, { name: "Edited local contact", phone: lead.phone, notes: "Edited note", status: "new", stageId });
  for (const key of ["responsibleUserId", "source", "sourceId", "campaign", "metaCampaignLaunchId", "clientId"]) {
    assert.equal(key in fixture.updates[1].patch, false, key);
    assert.equal(key in fixture.updates[1].payload, false, key);
  }
  fixture.empty(); await fixture.driver.flush();
  assert.doesNotMatch(label(fixture.driver.tree()), /Добавить заявку/);
  fixture.driver.dispose();
});

test("existing roles retain add, attribution, assignment, conversion, history and task controls", async () => {
  const fixture = setup("manager"); fixture.content(); await fixture.driver.flush();
  assert.equal(fixture.collection().strictAccess, undefined);
  assert.ok(fixture.requests.some((call) => call.path.startsWith("/api/crm/meta-launches")));
  assert.ok(fixture.requests.some((call) => call.path.startsWith("/api/crm/lead-assignees")));
  button(fixture.driver, "Добавить заявку"); button(fixture.driver, "Создать клиента");
  button(fixture.driver, "Подробнее").props.onClick(); await fixture.driver.flush();
  assert.ok(fixture.driver.nodes().some((node) => node.type === "TaskPanel"));
  assert.ok(fixture.driver.nodes().some((node) => node.type === "ChangeLogPanel"));
  button(fixture.driver, "Изменить").props.onClick(); await fixture.driver.flush();
  assert.ok(fixture.driver.nodes().some((node) => node.props["data-testid"] === "lead-responsible-select"));
  assert.ok(fixture.driver.nodes().some((node) => node.props["data-testid"] === "lead-campaign-select"));
  fixture.driver.dispose();
});

test("mortgage owner/admin keep manual assignment but cannot book, sell, convert or load ads", async () => {
  for (const role of ["owner", "admin"]) {
    const fixture = setup(role);
    fixture.setAuth({ workspacePurpose: "mortgage_leads" });
    fixture.content(); await fixture.driver.flush();
    assert.equal(fixture.collection().strictAccess, fixture.access);
    assert.equal(fixture.collection().allowScopedCreate, true);
    assert.ok(fixture.requests.some((call) => call.path.startsWith("/api/crm/lead-assignees")));
    assert.ok(fixture.requests.every((call) => !call.path.startsWith("/api/crm/meta-launches")));
    button(fixture.driver, "Добавить заявку");
    assert.equal(fixture.driver.nodes().some((node) => node.type === "Link"), false);
    button(fixture.driver, "Подробнее").props.onClick(); await fixture.driver.flush();
    assert.equal(fixture.driver.nodes().some((node) => ["TaskPanel", "ChangeLogPanel", "SiteInquiryDeletion"].includes(String(node.type))), false);
    assert.deepEqual(fixture.driver.nodes().filter((node) => node.type === "Link").map((node) => node.props.href), [`/clients?leadId=${encodeURIComponent(lead.id)}`]);
    button(fixture.driver, "Изменить").props.onClick(); await fixture.driver.flush();
    assert.ok(fixture.driver.nodes().some((node) => node.props["data-testid"] === "lead-responsible-select"));
    assert.ok(fixture.driver.nodes().every((node) => node.props["data-testid"] !== "lead-campaign-select"));
    button(fixture.driver, "Сохранить").props.onClick(); await fixture.driver.flush();
    assert.equal(fixture.updates[0].payload.responsibleUserId, actor);
    assert.equal("campaign" in fixture.updates[0].payload, false);
    assert.equal("metaCampaignLaunchId" in fixture.updates[0].payload, false);
    fixture.refuse(); await fixture.driver.flush();
    assert.doesNotMatch(label(fixture.driver.tree()), /Local contact|Изменить заявку/);
    fixture.driver.dispose();
  }
});

test("mortgage details link to the existing scoped contact instead of medical conversion or an AI placeholder", async () => {
  for (const role of ["owner", "admin", "lead_manager"]) {
    const fixture = setup(role); fixture.setAuth({ workspacePurpose: "mortgage_leads" });
    fixture.content(); await fixture.driver.flush();
    button(fixture.driver, "Подробнее").props.onClick(); await fixture.driver.flush();
    const link = fixture.driver.nodes().find((node) => node.type === "Link" && label(node) === "Открыть карточку клиента");
    assert.equal(link?.props.href, `/clients?leadId=${encodeURIComponent(lead.id)}`);
    assert.equal(fixture.driver.nodes().some((node) => node.props.label === "Клиент"), false);
    assert.doesNotMatch(label(fixture.driver.tree()), /AI-рекомендация|Следующий шаг|Создать клиента/);
    fixture.driver.dispose();
  }
  const clinical = setup("owner"); clinical.content(); await clinical.driver.flush();
  button(clinical.driver, "Подробнее").props.onClick(); await clinical.driver.flush();
  assert.ok(clinical.driver.nodes().some((node) => node.props.label === "Клиент"));
  assert.match(label(clinical.driver.tree()), /AI-рекомендация/); clinical.driver.dispose();
});

test("mortgage save and reference lifetime cannot continue after profile or role changes", async () => {
  for (const patch of [{ workspacePurpose: "clinic_services" }, { userRole: "lead_manager" }]) {
    const fixture = setup("admin");
    fixture.setAuth({ workspacePurpose: "mortgage_leads" });
    fixture.lifetime(); await fixture.driver.flush();
    const oldAccess = fixture.driver.tree().props.access as Access;
    assert.equal(oldAccess.isCurrent(), true);
    fixture.setAuth(patch); await fixture.driver.flush();
    assert.equal(oldAccess.isCurrent(), false);
    await assert.rejects(oldAccess.request("/api/crm/leads"), /Lead session ended/);
    assert.equal(fixture.requests.length, 0);
    fixture.driver.dispose();
  }
});

test('mortgage manual-distribution filters show unassigned or one manager without changing records', async () => {
  const fixture = setup('admin'); fixture.setAuth({ workspacePurpose: 'mortgage_leads' });
  fixture.setLeads([{ ...lead, id: 'a', name: 'Manager A contact' },
    { ...lead, id: 'b', name: 'Manager B contact', responsibleUserId: workspace },
    { ...lead, id: 'u', name: 'Unassigned contact', responsibleUserId: undefined }]);
  fixture.content(); await fixture.driver.flush();
  const select = () => fixture.driver.nodes().find((node) => node.props['aria-label'] === 'Фильтр по ответственному')!;
  assert.ok(select());
  select().props.onChange({ target: { value: 'unassigned' } }); await fixture.driver.flush();
  assert.match(label(fixture.driver.tree()), /Unassigned contact/);
  assert.doesNotMatch(label(fixture.driver.tree()), /Manager [AB] contact/);
  select().props.onChange({ target: { value: actor } }); await fixture.driver.flush();
  assert.match(label(fixture.driver.tree()), /Manager A contact/);
  assert.doesNotMatch(label(fixture.driver.tree()), /Manager B contact|Unassigned contact/);
  assert.deepEqual(fixture.updates, []);
  fixture.driver.dispose();
});

test("mortgage summaries follow responsibility while stage and search only narrow the list", async () => {
  for (const role of ["owner", "admin"]) {
    const fixture = setup(role);
    fixture.setAuth({ workspacePurpose: "mortgage_leads" });
    fixture.setLeads([
      { ...lead, id: "a-new", name: "A new" },
      { ...lead, id: "a-progress", name: "A progress", stageId: undefined, status: "in_progress" },
      { ...lead, id: "a-booked", name: "A booked", stageId: undefined, status: "booked" },
      { ...lead, id: "a-postponed", name: "A postponed", stageId: stages[3].id, semanticGroup: "postponed" },
      { ...lead, id: "a-lost", name: "A lost", stageId: undefined, status: "lost" },
      { ...lead, id: "b-new", name: "B new", responsibleUserId: workspace },
      { ...lead, id: "b-lost", name: "B lost", stageId: undefined, status: "lost", responsibleUserId: workspace },
      { ...lead, id: "b-postponed", name: "B postponed", stageId: undefined, status: "Отложенные", responsibleUserId: workspace },
      { ...lead, id: "u-progress", name: "Unassigned progress", stageId: undefined, status: "in_progress", responsibleUserId: undefined },
      { ...lead, id: "u-booked", name: "Unassigned booked", stageId: undefined, status: "booked", responsibleUserId: null },
      { ...lead, id: "u-lost", name: "Unassigned lost", stageId: undefined, status: "lost", responsibleUserId: "" },
      { ...lead, id: "u-postponed", name: "Unassigned postponed", stageId: undefined, status: "deferred", responsibleUserId: null },
    ]);
    fixture.content(); await fixture.driver.flush();
    // Summary order: total, new, in progress, booked, postponed, lost.
    const summary = () => fixture.driver.nodes().filter((node) => node.type === "MetricCard").map((node) => node.props.value);
    const selectResponsible = async (value: string) => {
      const select = fixture.driver.nodes().find((node) => node.props["aria-label"] === "Фильтр по ответственному");
      assert.ok(select);
      select.props.onChange({ target: { value } }); await fixture.driver.flush();
    };
    const search = async (value: string) => {
      const input = fixture.driver.nodes().find((node) => node.type === "input" && node.props.type === "search");
      assert.ok(input);
      input.props.onChange({ target: { value } }); await fixture.driver.flush();
    };

    assert.deepEqual(summary(), [12, 2, 2, 2, 3, 3], role);
    await selectResponsible(actor);
    assert.deepEqual(summary(), [5, 1, 1, 1, 1, 1], role);
    button(fixture.driver, "Новая").props.onClick(); await fixture.driver.flush();
    assert.match(label(fixture.driver.tree()), /A new/);
    assert.doesNotMatch(label(fixture.driver.tree()), /A progress|A booked|A postponed|A lost|B new|Unassigned/);
    assert.deepEqual(summary(), [5, 1, 1, 1, 1, 1], "stage selection must not zero other summaries");

    await search("no matching lead");
    assert.doesNotMatch(label(fixture.driver.tree()), /A new/);
    assert.deepEqual(summary(), [5, 1, 1, 1, 1, 1], "search must keep its existing list-only policy");
    await search("a NEW");
    assert.match(label(fixture.driver.tree()), /A new/);
    assert.deepEqual(summary(), [5, 1, 1, 1, 1, 1]);
    await search("");
    button(fixture.driver, "Все").props.onClick(); await fixture.driver.flush();

    await selectResponsible("unassigned");
    assert.deepEqual(summary(), [4, 0, 1, 1, 1, 1]);
    assert.match(label(fixture.driver.tree()), /Unassigned progress|Unassigned booked|Unassigned lost/);
    assert.doesNotMatch(label(fixture.driver.tree()), /A new|B new/);
    await selectResponsible(workspace);
    assert.deepEqual(summary(), [3, 1, 0, 0, 1, 1]);
    await selectResponsible("missing-staff");
    assert.deepEqual(summary(), [0, 0, 0, 0, 0, 0]);
    await selectResponsible("all");
    assert.deepEqual(summary(), [12, 2, 2, 2, 3, 3]);
    assert.deepEqual(fixture.updates, []);
    fixture.driver.dispose();
  }
});

test("booking conversion rounds one decimal and distinguishes zero rates from invalid denominators", () => {
  for (const [booked, assigned, expected] of [
    [3, 11, 27.3], [3, 9, 33.3], [1, 6, 16.7], [2, 3, 66.7], [0, 2, 0], [9, 9, 100],
    [0, Number.MAX_SAFE_INTEGER, 0], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 100],
  ]) assert.equal(teamBookingConversion(booked, assigned), expected, `${booked}/${assigned}`);
  for (const [booked, assigned] of [
    [0, 0], [1, 0], [0, -1], [-1, 9], [10, 9], [1.5, 9], [1, 9.5],
    [NaN, 9], [1, NaN], [Infinity, 9], [1, Infinity],
    [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER], [1, Number.MAX_SAFE_INTEGER + 1],
  ]) assert.equal(teamBookingConversion(booked, assigned), null, `${booked}/${assigned}`);
});

test("team analytics parser accepts count bases and safe sums but rejects inconsistent cohorts and periods", () => {
  for (const days of [7, 30, 90]) {
    const payload = teamPayload(days);
    assert.deepEqual(clone(teamContract.readAnalytics(payload, days)), payload.data.analytics);
    assert.throws(() => teamContract.readAnalytics(payload, days === 7 ? 30 : 7), /Invalid team analytics response/);
  }
  assert.equal(teamContract.safeSum([]), 0);
  assert.equal(teamContract.safeSum([Number.MAX_SAFE_INTEGER - 1, 1]), Number.MAX_SAFE_INTEGER);
  assert.equal(teamContract.safeSum([Number.MAX_SAFE_INTEGER, 1]), null);
  const boundary = teamPayload();
  boundary.data.analytics.members = [boundary.data.analytics.members[0]];
  boundary.data.analytics.members[0].assigned = { total: Number.MAX_SAFE_INTEGER, new: 0,
    inProgress: 0, booked: Number.MAX_SAFE_INTEGER, postponed: 0, lost: 0, other: 0 };
  boundary.data.analytics.totalLeads = Number.MAX_SAFE_INTEGER;
  boundary.data.analytics.unassignedLeads = 0; boundary.data.analytics.otherAssigneeLeads = 0;
  assert.deepEqual(clone(teamContract.readAnalytics(boundary, 30)), boundary.data.analytics);
  for (const { name, payload } of inconsistentTeamPayloads()) {
    assert.throws(() => teamContract.readAnalytics(payload, 30), /Inconsistent team analytics response/, name);
  }
});

test("team analytics parser requires nonnegative safe integers for every snapshot and activity count", () => {
  const groups = [
    ["totalLeads", "unassignedLeads", "otherAssigneeLeads"],
    ["total", "new", "inProgress", "booked", "postponed", "lost", "other"],
    ["updatedEvents", "createdEvents", "touchedLeads"],
  ];
  for (const [index, keys] of groups.entries()) {
    for (const key of keys) {
      for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "3", null, undefined]) {
        const payload = teamPayload();
        const analytics = payload.data.analytics;
        const record: Record<string, unknown> = index === 0 ? analytics
          : index === 1 ? analytics.members[0].assigned : analytics.members[0].activity!;
        record[key] = invalid;
        assert.throws(() => teamContract.readAnalytics(payload, 30), /Invalid team analytics response/, `${index}/${key}/${invalid}`);
      }
    }
  }
});

test("only an absent postponed counter defaults to zero when the old assigned census already reconciles", () => {
  const legacy = teamPayload();
  for (const member of legacy.data.analytics.members) {
    member.assigned.inProgress += member.assigned.postponed;
    Reflect.deleteProperty(member.assigned, "postponed");
  }
  const before = JSON.stringify(legacy);
  const parsed = teamContract.readAnalytics(legacy, 30);
  assert.deepEqual(clone(parsed.members.map((member: any) => member.assigned.postponed)), [0, 0, 0]);
  assert.equal(parsed.members[0].assigned.new, 1);
  assert.equal(parsed.members[0].assigned.inProgress, 2);
  assert.equal(parsed.members[0].assigned.other, 2);
  assert.equal(JSON.stringify(legacy), before, "normalization must not mutate the server payload");
  const gap = teamPayload(); Reflect.deleteProperty(gap.data.analytics.members[0].assigned, "postponed");
  assert.throws(() => teamContract.readAnalytics(gap, 30), /Inconsistent team analytics response/,
    "missing postponed cannot absorb an unexplained assigned remainder");
  gap.data.analytics.members[0].assigned.other += 2;
  assert.throws(() => teamContract.readAnalytics(gap, 30), /Inconsistent team analytics response/);

  const empty = teamPayload();
  empty.data.analytics.totalLeads = 9;
  for (const member of empty.data.analytics.members) {
    member.assigned = { total: 0, new: 0, inProgress: 0, booked: 0, postponed: 0, lost: 0, other: 0 };
    Reflect.deleteProperty(member.assigned, "postponed");
  }
  assert.ok(teamContract.readAnalytics(empty, 30).members.every((member: any) => member.assigned.postponed === 0));
  empty.data.analytics.members = [];
  assert.deepEqual(clone(teamContract.readAnalytics(empty, 30).members), []);
});

test("old reconciled responses render zero postponed without failing or changing conversion", async () => {
  const fixture = teamSetup({ initiallyExpanded: true }); await fixture.driver.flush();
  const payload = teamPayload();
  for (const member of payload.data.analytics.members) {
    member.assigned.inProgress += member.assigned.postponed;
    Reflect.deleteProperty(member.assigned, "postponed");
  }
  await fixture.resolve(0, payload);
  assert.deepEqual(fixture.cells().slice(0, 7), ["9", "1", "2", "3", "0", "1", "2"]);
  assert.equal(teamSummary(fixture.driver)["Отложенные"], "0");
  assert.equal(teamSummary(fixture.driver)["Конверсия в запись"], "27,3%");
  assert.doesNotMatch(fixture.text(), /Не удалось загрузить/);
  fixture.driver.dispose();
});

test("fixed browser analytics fixtures reconcile and the taxonomy route exposes all five stages", async () => {
  for (const role of ["owner", "admin", "lead_manager"]) {
    const fixture = browserTeamSetup(role);
    const fixed = fixture.module.fixture.teamMembers;
    for (const member of fixed) {
      const { total, new: fresh, inProgress, booked, postponed, lost, other } = member.assigned;
      assert.equal(Number.isSafeInteger(postponed), true);
      assert.equal(total, fresh + inProgress + booked + postponed + lost + other);
    }
    assert.equal(fixed.reduce((sum: number, member: any) => sum + member.assigned.postponed, 0), 1);
    const response = await fixture.request("lead-stages"); assert.equal(response.status, 200);
    const body = await response.json() as { data: {
      stages: Array<{ stageKey: string; name: string; semanticGroup: string }>; items: unknown[];
    } };
    assert.deepEqual(body.data.stages.map((stage: any) => [stage.stageKey, stage.name, stage.semanticGroup]), [
      ["new", "Новая", "new"], ["in_progress", "В работе", "in_progress"], ["booked", "Записана", "booked"],
      ["postponed", "Отложена", "postponed"], ["lost", "Потеряна", "lost"],
    ]);
    assert.deepEqual(body.data.items, body.data.stages);
  }
});

test("dynamic browser analytics counts exact postponed aliases and remains mortgage owner/admin GET only", async () => {
  for (const role of ["owner", "admin"]) {
    const fixture = browserTeamSetup(role);
    const statuses = ["new", "in_progress", "booked", "postponed", "Отложена", "Отложенные", "Отложено", "Отложен",
      " DEFERRED ", "lost", "unknown", "deferred_custom", "Отложенные по просьбе"];
    fixture.snapshot.contacts = statuses.map((status) => ({ status, responsibleUserId: "manager" }));
    fixture.snapshot.contacts.push({ status: "Отложена", responsibleUserId: null }, { status: "postponed", responsibleUserId: "foreign-assignee" });
    fixture.snapshot.metrics.totalLeads = fixture.snapshot.contacts.length;
    fixture.snapshot.metrics.unassignedLeads = 1;
    const response = await fixture.request(); assert.equal(response.status, 200);
    const parsed = teamContract.readAnalytics(await response.json(), 30);
    assert.deepEqual(clone(parsed.members[0].assigned),
      { total: 13, new: 1, inProgress: 1, booked: 1, postponed: 6, lost: 1, other: 3 });
    assert.deepEqual(clone(parsed.members[1].assigned),
      { total: 0, new: 0, inProgress: 0, booked: 0, postponed: 0, lost: 0, other: 0 });
    assert.equal(parsed.unassignedLeads, 1); assert.equal(parsed.otherAssigneeLeads, 1);
    assert.equal(teamBookingConversion(parsed.members[0].assigned.booked, parsed.members[0].assigned.total), 7.7);
    assert.equal((await fixture.request("lead-team-analytics", "POST")).status, 403);
    for (const deniedRole of ["lead_manager", "manager", "doctor", "marketer"]) {
      fixture.module.useAuth().userRole = deniedRole;
      assert.equal((await fixture.request()).status, 403, deniedRole);
    }
    assert.equal(fixture.reads(), 1, "denied roles and writes must not load the team snapshot");
  }
  const clinic = browserTeamSetup("owner", "clinic_services");
  assert.equal((await clinic.request()).status, 403); assert.equal(clinic.reads(), 0);
  const manager = browserTeamSetup("lead_manager");
  assert.equal((await manager.request()).status, 403); assert.equal(manager.reads(), 0);
});

test("team analytics mounts below summaries only for mortgage owner/admin and is keyed by scope", async () => {
  for (const purpose of ["mortgage_leads", "clinic_services", "marketing"]) {
    for (const role of ["owner", "admin", "lead_manager", "manager", "marketer"]) {
      const fixture = setup(role); fixture.setAuth({ workspacePurpose: purpose });
      fixture.content(); await fixture.driver.flush();
      const component = fixture.driver.nodes().find((node) => node.type === "LeadTeamAnalytics");
      const allowed = purpose === "mortgage_leads" && ["owner", "admin"].includes(role);
      assert.equal(Boolean(component), allowed, `${purpose}/${role}`);
      if (component) {
        assert.equal(component.props.access, fixture.access);
        assert.equal(component.key, JSON.stringify([actor, workspace, role]));
        assert.equal(component.props.initiallyExpanded, undefined, "LeadsPage retains default lazy loading");
        assert.equal(component.props.heading, undefined, "LeadsPage retains the default heading");
        const summary = fixture.driver.nodes().findIndex((node) => node.props["aria-label"] === "Сводка по заявкам");
        assert.ok(fixture.driver.nodes().indexOf(component) > summary);
      }
      assert.equal(fixture.requests.some((request) => request.path.includes("lead-team-analytics")), false);
      fixture.driver.dispose();
    }
  }
});

test("team analytics is lazy, uses bound access, renders factual snapshots and clears on collapse", async () => {
  const fixture = teamSetup(); await fixture.driver.flush();
  assert.equal(fixture.requests.length, 0);
  assert.match(fixture.text(), /Работа команды/);
  assert.doesNotMatch(fixture.text(), /Manager fixture|Всего заявок/);
  await fixture.toggle(true);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].days, 30);
  assert.deepEqual(Object.keys(fixture.access).sort(), ["isCurrent", "loadTeamAnalytics"]);
  assert.match(fixture.text(), /Загрузка работы команды/);
  await fixture.resolve(0);
  assert.match(fixture.text(), /Текущие заявки · все время/);
  assert.match(fixture.text(), /Не назначены5Другие ответственные4/);
  assert.match(fixture.text(), /последние 30 дней/);
  assert.match(fixture.text(), /Журнал сохранений: возможны пропуски/);
  for (const text of ["Активен", "Неактивен", "Менеджер заявок", "Администратор", "Владелец"]) {
    assert.ok(fixture.text().includes(text), text);
  }
  assert.deepEqual(fixture.cells().slice(0, 10), ["9", "1", "1", "3", "1", "1", "2", "13", "7", "6"]);
  assert.notEqual(fixture.cells()[10], "-");
  assert.deepEqual(fixture.cells("Admin fixture").slice(7), ["-", "-", "-", "-"]);
  assert.deepEqual(fixture.cells("Owner fixture").slice(7), ["0", "0", "0", "-"]);
  assert.match(fixture.text(), /Конверсия в запись27,3%/);
  assert.doesNotMatch(fixture.text(), /CPL|ROI|звонк|платеж|балл|первый ответ/i);
  const scroller = fixture.driver.nodes().find((node) => node.props.role === "region"); assert.ok(scroller);
  assert.match(scroller.props.className, /max-w-full.*overflow-x-auto/);
  const identityHeadings = nodes(scroller).filter((node) => node.type === "th" && (node.props.rowSpan === 2 || node.props.scope === "row"));
  assert.equal(identityHeadings.length, 4, "employee header and every member name stay visible while scrolling");
  for (const heading of identityHeadings) {
    assert.match(heading.props.className, /\bsticky\b.*\bleft-0\b/);
    assert.match(heading.props.className, /\bmin-w-44\b.*\bmax-w-56\b/);
    assert.equal(heading.props.style.background, "var(--negis-surface)");
    assert.match(heading.props.className, heading.props.rowSpan === 2 ? /\bz-20\b/ : /\bz-10\b/);
  }
  await fixture.toggle(false);
  assert.doesNotMatch(fixture.text(), /Manager fixture|Всего заявок/);
  await fixture.toggle(true);
  assert.equal(fixture.requests.length, 2);
  assert.doesNotMatch(fixture.text(), /Manager fixture/);
  fixture.driver.dispose();
});

test("team results use the weighted assigned cohort with count-labelled member meters, zero and no denominator", async () => {
  const fixture = teamSetup(); await fixture.driver.flush(); await fixture.toggle(true); await fixture.resolve(0);
  assert.deepEqual(teamSummary(fixture.driver), {
    "Назначено сотрудникам": "11", "Записаны": "3", "Конверсия в запись": "27,3%", "Отложенные": "1", "Потеряны": "1",
  }, "3/11 excludes unassigned/other assignees and does not average member percentages or use activity counts");
  const results = teamResults(fixture.driver);
  assert.match(label(results), /Текущие назначенные заявки · всё время/);
  assert.doesNotMatch(label(results), /7 дней|30 дней|90 дней|последние|Правки|Создания/);
  const cohort = nodes(results).find((node) => node.props["aria-label"] === "Конверсия в запись по сотрудникам");
  assert.ok(cohort);
  for (const [name, count, rate, value] of [
    ["Manager fixture", "3 из 9", "33,3%", 33.3],
    ["Admin fixture", "0 из 2", "0%", 0],
    ["Owner fixture", "0 из 0", "—", null],
  ] as const) {
    const member: Node | undefined = nodes(cohort).find((node) => node.type === "dl" && label(node).includes(name)); assert.ok(member);
    assert.match(label(member), new RegExp(count));
    assert.equal(label(nodes(member).find((node) => node.type === "strong")), rate);
    const basis: Node | undefined = nodes(member).find((node) => typeof node.props.title === "string"); assert.ok(basis);
    assert.match(basis.props.title, /все текущие заявки сотрудника/);
    assert.match(basis.props.title, /текущий снимок, не история переходов за период/);
    const meters: Node[] = nodes(member).filter((node) => node.type === "meter");
    if (value === null) {
      assert.equal(meters.length, 0, "missing denominator is not a zero-valued meter");
      assert.ok(nodes(member).some((node) => node.props["aria-hidden"] === "true"));
    } else {
      assert.equal(meters.length, 1);
      assert.equal(meters[0].props.value, value); assert.equal(meters[0].props.min, 0); assert.equal(meters[0].props.max, 100);
      assert.equal(meters[0].props["aria-label"], `Конверсия в запись: ${name}; ${count}`);
      assert.equal(label(meters[0]), rate);
    }
  }
  const zero = teamPayload(); zero.data.analytics.members[0].assigned.booked = 0;
  zero.data.analytics.members[0].assigned.other += 3;
  await fixture.refresh(); await fixture.resolve(1, zero);
  assert.equal(teamSummary(fixture.driver)["Конверсия в запись"], "0%", "a nonempty assigned cohort can have a valid zero rate");
  assert.deepEqual(nodes(teamResults(fixture.driver)).filter((node) => node.type === "meter").map((node) => node.props.value), [0, 0]);
  fixture.driver.dispose();
});

test("postponed is a separate labelled count and never removed from the booked conversion denominator", async () => {
  const fixture = teamSetup({ initiallyExpanded: true }); await fixture.driver.flush();
  const payload = teamPayload();
  payload.data.analytics.members[0].assigned = { total: 9, new: 0, inProgress: 0, booked: 3, postponed: 6, lost: 0, other: 0 };
  payload.data.analytics.members[1].assigned = { total: 2, new: 0, inProgress: 0, booked: 0, postponed: 2, lost: 0, other: 0 };
  await fixture.resolve(0, payload);
  assert.deepEqual(fixture.cells().slice(0, 7), ["9", "0", "0", "3", "6", "0", "0"]);
  assert.deepEqual(teamSummary(fixture.driver), {
    "Назначено сотрудникам": "11", "Записаны": "3", "Конверсия в запись": "27,3%", "Отложенные": "8", "Потеряны": "0",
  });
  assert.deepEqual(fixture.driver.nodes().filter((node) => node.type === "meter").map((node) => node.props.value), [33.3, 0]);
  assert.ok(fixture.driver.nodes().some((node) => node.type === "th" && label(node) === "Отложенные"));
  const group = fixture.driver.nodes().find((node) => node.type === "th" && node.props.scope === "colgroup"); assert.ok(group);
  assert.equal(group.props.colSpan, 7);
  fixture.driver.dispose();
});

test("team analytics expansion is opt-in and autoload captures the original bound access", async () => {
  const lazy = teamSetup({ initiallyExpanded: false, heading: "Local result heading" }); await lazy.driver.flush();
  assert.equal(lazy.requests.length, 0);
  assert.equal(label(lazy.driver.nodes().find((node) => node.type === "summary")), "Local result heading");
  lazy.driver.dispose();

  const fixture = teamSetup({ initiallyExpanded: true, heading: "Результаты по заявкам и конверсия" });
  await fixture.driver.flush();
  assert.equal(fixture.driver.nodes().find((node) => node.type === "details")?.props.open, true);
  assert.equal(fixture.requests.length, 1); assert.equal(fixture.requests[0].days, 30);
  assert.match(fixture.text(), /Результаты по заявкам и конверсия/);
  await fixture.toggle(true);
  assert.equal(fixture.requests.length, 1, "native initial toggle must not dispatch twice");
  let reboundRequests = 0;
  fixture.replaceAccess({ isCurrent: () => true, loadTeamAnalytics: async () => {
    reboundRequests += 1; return Response.json(teamPayload());
  } });
  await fixture.driver.flush(); await fixture.resolve(0);
  await fixture.period(7); await fixture.resolve(1, teamPayload(7));
  assert.equal(fixture.requests[1].days, 7); assert.equal(reboundRequests, 0);
  fixture.driver.dispose();

  const expired = teamSetup({ initiallyExpanded: true }); expired.invalidate(); await expired.driver.flush();
  assert.equal(expired.driver.tree(), null); assert.equal(expired.requests.length, 0); expired.driver.dispose();
});

test("expanded team analytics autoload uses the real bound session and expired callbacks cannot dispatch", async () => {
  const session = setup("owner"); session.setAuth({ workspacePurpose: "mortgage_leads" });
  session.reply(async () => Response.json(teamPayload())); session.lifetime(); await session.driver.flush();
  const access: Access = session.driver.tree().props.access;
  const fixture = teamSetup({ initiallyExpanded: true }, access); await fixture.driver.flush();
  assert.equal(session.requests.length, 1);
  assert.equal(session.requests[0].path, `/api/crm/lead-team-analytics?workspaceId=${workspace}&days=30`);
  assert.equal(session.requests[0].init?.cache, "no-store");
  assert.equal(session.requests[0].init?.expectedUserId, actor);
  assert.equal(session.requests[0].init?.signal?.aborted, false);
  assert.equal(teamSummary(fixture.driver)["Конверсия в запись"], "27,3%");
  const period = fixture.driver.nodes().find((node) => node.type === "select"); assert.ok(period);
  const refresh = fixture.driver.nodes().find((node) => node.props["aria-label"] === "Обновить работу команды"); assert.ok(refresh);
  const details = fixture.driver.nodes().find((node) => node.type === "details"); assert.ok(details);
  session.emit("actor-b"); session.emit(actor);
  assert.equal(access.isCurrent(), false); assert.equal(session.requests[0].init?.signal?.aborted, true);
  period.props.onChange({ target: { value: "7" } }); refresh.props.onClick(); details.props.onToggle({ currentTarget: { open: false } });
  fixture.driver.invalidate(); await fixture.driver.flush();
  assert.equal(fixture.driver.tree(), null); assert.equal(session.requests.length, 1);
  fixture.driver.dispose(); session.driver.dispose();
});

test("mortgage analytics puts expanded staff results first and binds autoload to its workspace access", async () => {
  const source = await read("pages/MortgageAnalytics.tsx");
  for (const [role, clinicId] of [["owner", workspace], ["admin", workspace], ["lead_manager", workspace],
    ["manager", workspace], ["marketer", workspace], ["owner", null]] as const) {
    const driver = hookDriver();
    const requests: string[] = [];
    let current = true;
    const isCurrent = () => current;
    const module = evaluate(source + "\nexports.fixture = { MortgageAnalyticsAccess, MortgageAnalyticsReport };", { URLSearchParams }, {
      react: driver.hooks,
      "@/contexts/AuthContext": { useAuth: () => ({ clinicId, userRole: role, user: { id: actor } }) },
      "@/lib/permissions": { roleLabels },
      "@/lib/mortgage-workspace": { MortgageScope: "MortgageScope", useMortgageWorkspace: () => ({
        isCurrent, loading: true, error: "", data: null, refresh: () => {},
        request: async (url: string) => { requests.push(url); return Response.json(teamPayload()); },
      }) },
    });
    driver.mount(() => module.fixture.MortgageAnalyticsAccess()); await driver.flush();
    if (!clinicId || !["owner", "admin"].includes(role)) {
      assert.equal(driver.nodes().some((node) => node.type === module.fixture.MortgageAnalyticsReport), false);
      assert.match(label(driver.tree()), clinicId ? /Отчёт доступен владельцу и администратору/ : /пространство не выбрано/);
      assert.equal(requests.length, 0); driver.dispose(); continue;
    }
    assert.equal(driver.tree().key, JSON.stringify([clinicId, role, actor]));
    driver.mount(() => module.fixture.MortgageAnalyticsReport({ workspaceId: clinicId })); await driver.flush();
    const team = driver.nodes().find((node) => node.type === "LeadTeamAnalytics"); assert.ok(team);
    assert.equal(team.key, clinicId); assert.equal(team.props.initiallyExpanded, true);
    assert.equal(team.props.heading, "Результаты по заявкам и конверсия");
    assert.equal(team.props.access.isCurrent, isCurrent);
    const workload = driver.nodes().findIndex((node) => node.props["aria-labelledby"] === "mortgage-member-report");
    assert.ok(workload > driver.nodes().indexOf(team), "staff results precede workload even while workload is loading");
    const child = teamSetup(team.props, team.props.access); await child.driver.flush();
    assert.deepEqual(requests, [`/api/crm/lead-team-analytics?workspaceId=${clinicId}&days=30`]);
    assert.equal(teamSummary(child.driver)["Конверсия в запись"], "27,3%");
    current = false; driver.invalidate(); child.driver.invalidate(); await driver.flush(); await child.driver.flush();
    assert.equal(driver.nodes().some((node) => node.type === "LeadTeamAnalytics"), false);
    assert.equal(child.driver.tree(), null);
    child.driver.dispose(); driver.dispose();
  }
});

test("team analytics period changes clear data and ignore superseded responses and JSON bodies", async () => {
  const fixture = teamSetup(); await fixture.driver.flush(); await fixture.toggle(true); await fixture.resolve(0);
  const oldBody = deferred<unknown>();
  await fixture.refresh();
  assert.doesNotMatch(fixture.text(), /Manager fixture|Всего заявок/);
  fixture.requests[1].response.resolve({ ok: true, json: () => oldBody.promise } as Response);
  await fixture.driver.flush();
  await fixture.period(7);
  assert.equal(fixture.requests[2].days, 7);
  assert.doesNotMatch(fixture.text(), /Manager fixture/);
  await fixture.resolve(2, teamPayload(7));
  oldBody.resolve(teamPayload()); await fixture.driver.flush();
  assert.match(fixture.text(), /последние 7 дней/);
  assert.doesNotMatch(fixture.text(), /последние 30 дней/);
  await fixture.period(90);
  assert.equal(fixture.requests[3].days, 90);
  assert.doesNotMatch(fixture.text(), /Manager fixture|Всего заявок/);
  await fixture.period(30);
  await fixture.resolve(4);
  const stale = teamPayload(90); stale.data.analytics.members[0].name = "Stale fixture";
  await fixture.resolve(3, stale);
  assert.match(fixture.text(), /Manager fixture/);
  assert.doesNotMatch(fixture.text(), /Stale fixture|последние 90 дней/);
  const count = fixture.requests.length;
  await fixture.period(14);
  assert.equal(fixture.requests.length, count, "only 7/30/90 can dispatch");
  fixture.driver.dispose();
});

test("team analytics refresh failures and invalid/demo contracts clear prior data without invented zeroes", async () => {
  const demo = teamPayload(); demo.mode = "demo";
  const invalid = teamPayload(); invalid.data.analytics.members[0].assigned.other = -1;
  for (const [payload, status] of [[teamPayload(), 403], [teamPayload(), 502], [demo, 200], [invalid, 200], [teamPayload(7), 200]] as const) {
    const fixture = teamSetup(); await fixture.driver.flush(); await fixture.toggle(true); await fixture.resolve(0);
    assert.match(fixture.text(), /Manager fixture/);
    await fixture.refresh();
    assert.doesNotMatch(fixture.text(), /Manager fixture|Всего заявок/);
    await fixture.resolve(1, payload, status);
    assert.doesNotMatch(fixture.text(), /Manager fixture|Всего заявок/);
    assert.match(fixture.text(), status === 403 ? /Нет доступа/ : /Не удалось загрузить/);
    assert.ok(fixture.driver.nodes().some((node) => node.props.role === "alert"));
    fixture.driver.dispose();
  }
});

test("team analytics rejects inconsistent staff results without leaving stale conversion or meters", async () => {
  for (const { name, payload } of inconsistentTeamPayloads()) {
    const fixture = teamSetup({ initiallyExpanded: true }); await fixture.driver.flush(); await fixture.resolve(0);
    assert.equal(teamSummary(fixture.driver)["Конверсия в запись"], "27,3%", name);
    await fixture.refresh(); await fixture.resolve(1, payload);
    assert.match(fixture.text(), /Не удалось загрузить работу команды/, name);
    assert.doesNotMatch(fixture.text(), /Manager fixture|Всего заявок|Конверсия в запись|27,3%|33,3%/, name);
    assert.equal(fixture.driver.nodes().some((node) => node.type === "meter" || node.type === "table"), false, name);
    assert.ok(fixture.driver.nodes().some((node) => node.props.role === "alert"), name);
    fixture.driver.dispose();
  }
});

test("team conversion stays an all-time snapshot across activity windows and unavailable activity", async () => {
  const fixture = teamSetup({ initiallyExpanded: true }); await fixture.driver.flush(); await fixture.resolve(0);
  const snapshot = label(teamResults(fixture.driver));
  for (const days of [7, 30, 90]) {
    await fixture.period(days);
    const available = teamPayload(days);
    available.data.analytics.members[0].activity!.updatedEvents = days;
    available.data.analytics.members[0].activity!.createdEvents = days + 1;
    available.data.analytics.members[0].activity!.touchedLeads = days + 2;
    await fixture.resolve(fixture.requests.length - 1, available);
    assert.match(fixture.text(), new RegExp(`Ручные события · последние ${days} дней`));
    assert.deepEqual(fixture.cells().slice(7, 10), [String(days), String(days + 1), String(days + 2)]);
    assert.equal(label(teamResults(fixture.driver)), snapshot, `${days}-day activity must not change conversion`);
    await fixture.refresh();
    const unavailable = clone(available); unavailable.data.analytics.activityStatus = "unavailable";
    await fixture.resolve(fixture.requests.length - 1, unavailable);
    assert.match(fixture.text(), /Активность недоступна/);
    for (const name of ["Manager fixture", "Admin fixture", "Owner fixture"]) {
      assert.deepEqual(fixture.cells(name).slice(7), ["-", "-", "-", "-"], name);
    }
    assert.equal(label(teamResults(fixture.driver)), snapshot, "unavailable activity must not zero or hide current conversion");
  }
  fixture.driver.dispose();
});

test("team analytics unavailable activity is not zero and empty members keep snapshot counters", async () => {
  const fixture = teamSetup(); await fixture.driver.flush(); await fixture.toggle(true);
  const payload = teamPayload(); payload.data.analytics.activityStatus = "unavailable";
  await fixture.resolve(0, payload);
  assert.deepEqual(fixture.cells().slice(7), ["-", "-", "-", "-"]);
  assert.match(fixture.text(), /Активность недоступна/);
  assert.equal(fixture.cells()[4], "1", "postponed remains separate from other statuses");
  assert.equal(fixture.cells()[6], "2", "other statuses remain visible");
  await fixture.refresh();
  const empty = teamPayload(); empty.data.analytics.members = []; empty.data.analytics.otherAssigneeLeads = 15;
  await fixture.resolve(1, empty);
  assert.match(fixture.text(), /Сотрудников нет/);
  assert.match(fixture.text(), /Всего заявок20Не назначены5Другие ответственные15/);
  assert.deepEqual(teamSummary(fixture.driver), {
    "Назначено сотрудникам": "0", "Записаны": "0", "Конверсия в запись": "—", "Отложенные": "0", "Потеряны": "0",
  });
  assert.equal(fixture.driver.nodes().some((node) => node.type === "table"), false);
  assert.equal(fixture.driver.nodes().some((node) => node.type === "meter"), false);
  fixture.driver.dispose();
});

test("team analytics captures access once and ignores invalidated scopes and late JSON after cleanup", async () => {
  const fixture = teamSetup(); await fixture.driver.flush();
  fixture.replaceAccess({ isCurrent: () => true,
    loadTeamAnalytics: async () => { throw new Error("Unbound loader"); } });
  await fixture.driver.flush(); await fixture.toggle(true);
  assert.equal(fixture.requests[0].days, 30);
  fixture.invalidate(); await fixture.driver.flush();
  assert.equal(fixture.driver.tree(), null);
  let parsed = false;
  fixture.requests[0].response.resolve({ ok: true, json: async () => { parsed = true; return teamPayload(); } } as Response);
  await fixture.driver.flush(); assert.equal(parsed, false); assert.equal(fixture.driver.tree(), null);
  fixture.driver.dispose();

  for (const initiallyExpanded of [false, true]) {
    for (const cleanup of ["invalidate", "unmount", "collapse"]) {
      const pending = teamSetup({ initiallyExpanded }); await pending.driver.flush(); await pending.toggle(true);
      const body = deferred<unknown>(); let parsing = false;
      pending.requests[0].response.resolve({ ok: true, json: () => { parsing = true; return body.promise; } } as Response);
      await pending.driver.flush(); assert.equal(parsing, true);
      if (cleanup === "invalidate") { pending.invalidate(); await pending.driver.flush(); }
      else if (cleanup === "unmount") pending.driver.dispose();
      else await pending.toggle(false);
      body.resolve(teamPayload()); await pending.driver.flush();
      assert.doesNotMatch(pending.text(), /Manager fixture|Всего заявок|Конверсия в запись|27,3%|33,3%/, cleanup);
      pending.driver.dispose();
    }
  }
  const expired = teamSetup(); expired.invalidate(); await expired.driver.flush();
  assert.equal(expired.driver.tree(), null); assert.equal(expired.requests.length, 0); expired.driver.dispose();
});

test("mortgage routes intersect roles and never mount medical, advertising or unsupported pages", async () => {
  const app = await read("App.tsx");
  for (const role of ["owner", "admin", "lead_manager", "manager", "marketer", "doctor"]) {
    for (const location of ["/leads", "/admin", "/clients", "/sales", "/appointments", "/booking", "/dashboard", "/tasks", "/analytics", "/ads", "/ads-automation/history", "/site-blog", "/services", "/reports"]) {
      let redirected = "";
      const routes = evaluate(select(app, ["ROUTE_PERMISSIONS", "firstAllowedRoute", "ProtectedPage"]), {
        ...workspaceRoutes,
        useAuth: () => ({ userRole: role, rolePermissions: { crm: true, admin: role !== "lead_manager", ads: true, dashboard: true, booking: true }, isLoading: false, workspacePurpose: "mortgage_leads" }),
        useLocation: () => [location, (url: string) => { redirected = url; }], useEffect: (run: () => void) => run(),
      }).selected;
      const allowed = workspaceRoutes.workspaceAllowsRoute("mortgage_leads", role, location);
      const purposeRoute = ["/leads", "/clients", "/appointments", "/booking", "/dashboard", "/tasks", "/analytics"].includes(location);
      const tree = routes.ProtectedPage({ component: "Screen", permission: purposeRoute ? "crm" : routes.ROUTE_PERMISSIONS[location] ?? "dashboard" });
      assert.equal(tree?.type === "Screen", allowed, `${role}: ${location}`);
      const supportedRole = ["owner", "admin", "lead_manager"].includes(role);
      assert.equal(redirected, allowed || !supportedRole ? "" : "/dashboard");
      if (!supportedRole) assert.match(label(tree), /Доступ к пространству ограничен/);
    }
  }
  assert.equal(workspaceRoutes.workspaceAllowsRoute(null, "owner", "/leads"), false);
  const landing = evaluate(select(await read("pages/Landing.tsx"), ["roleRoute"])).selected;
  for (const role of ["owner", "admin", "lead_manager"]) assert.equal(landing.roleRoute(role, "mortgage_leads"), "/dashboard");
});

test("access refusal closes contact detail/edit and a late invalid save has no toast", async () => {
  for (const editing of [false, true]) {
    const fixture = setup(); fixture.content(); await fixture.driver.flush();
    button(fixture.driver, "Подробнее").props.onClick(); await fixture.driver.flush();
    if (editing) { button(fixture.driver, "Изменить").props.onClick(); await fixture.driver.flush(); }
    fixture.refuse(); await fixture.driver.flush();
    assert.doesNotMatch(label(fixture.driver.tree()), /Local contact|Изменить заявку/);
    fixture.driver.dispose();
  }
  const fixture = setup(); fixture.content(); await fixture.driver.flush();
  button(fixture.driver, "Подробнее").props.onClick(); await fixture.driver.flush();
  button(fixture.driver, "Изменить").props.onClick(); await fixture.driver.flush();
  const pending = deferred<boolean>(); fixture.save(pending.promise);
  button(fixture.driver, "Сохранить").props.onClick(); await fixture.driver.flush();
  fixture.access.isCurrent = () => false; pending.resolve(true); await fixture.driver.flush();
  assert.deepEqual(fixture.toasts, []);
  assert.equal(button(fixture.driver, "Сохраняю…").props.disabled, true, "expired callback does not update state in finally");
  fixture.driver.dispose();
});

test("lifetime aborts immediately on account change, never revives on A-B-A, and replay owns a fresh controller", async () => {
  const fixture = setup(); fixture.lifetime(); await fixture.driver.flush();
  const first: Access = fixture.driver.tree().props.access;
  assert.equal(first.isCurrent(), true);
  await first.request("/api/crm/lead-stages");
  const init = fixture.requests[0].init!;
  assert.equal(init.cache, "no-store"); assert.equal(init.expectedUserId, actor);
  assert.equal(init.signal?.aborted, false);
  await first.loadTeamAnalytics(30);
  assert.equal(fixture.requests[1].path, `/api/crm/lead-team-analytics?workspaceId=${encodeURIComponent(workspace)}&days=30`);
  assert.equal(fixture.requests[1].init?.cache, "no-store");
  assert.equal(fixture.requests[1].init?.expectedUserId, actor);
  assert.equal(fixture.requests[1].init?.signal, init.signal);
  fixture.emit("actor-b"); fixture.emit(actor);
  assert.equal(first.isCurrent(), false); assert.equal(init.signal?.aborted, true);
  await assert.rejects(first.request("/api/crm/leads"), { name: "AbortError" });
  await assert.rejects(first.loadTeamAnalytics(7), { name: "AbortError" });
  assert.equal(fixture.requests.length, 2, "expired analytics loader must not dispatch");
  fixture.driver.replayLayout(); await fixture.driver.flush();
  const next: Access = fixture.driver.tree().props.access;
  assert.equal(next.isCurrent(), true); assert.equal(first.isCurrent(), false);
  await next.loadTeamAnalytics(90);
  assert.equal(fixture.requests[2].path.endsWith("&days=90"), true);
  assert.notEqual(fixture.requests[2].init?.signal, init.signal);
  assert.equal(fixture.requests[2].init?.signal?.aborted, false);
  fixture.setAuth({ clinicId: "workspace-b" }); await fixture.driver.flush();
  assert.equal(next.isCurrent(), false);
  await assert.rejects(next.loadTeamAnalytics(30), { name: "AbortError" });
  fixture.driver.dispose(); assert.equal(next.isCurrent(), false);
});

test("guarded reference and team analytics requests reject late response and late body parse", async () => {
  for (const request of [(access: Access) => access.request("/api/crm/lead-stages"), (access: Access) => access.loadTeamAnalytics(30)]) {
    const fixture = setup(); fixture.lifetime(); await fixture.driver.flush();
    const access: Access = fixture.driver.tree().props.access;
    const pending = deferred<Response>(); fixture.reply(() => pending.promise);
    const requested = request(access);
    fixture.emit("actor-b"); pending.resolve(Response.json({ success: true }));
    await assert.rejects(requested, { name: "AbortError" }); fixture.driver.dispose();
  }

  const fixture = setup();
  const body = deferred<string>(); let alive = true;
  const parsed = fixture.module.fixture.loadTaxonomyList({ endpoint: "/api/crm/lead-stages", workspaceId: workspace,
    listKey: "stages", mapItem: (value: unknown) => value, isCurrent: () => alive,
    request: async () => ({ ok: true, text: () => body.promise }),
  });
  alive = false; body.resolve(JSON.stringify({ success: true, mode: "supabase", data: { stages } }));
  await assert.rejects(parsed, { name: "AbortError" });
});

test("outer key changes for batched A-B-A auth events and workspace/role switches", async () => {
  const fixture = setup(); fixture.driver.mount(() => fixture.module.default()); await fixture.driver.flush();
  const initial = fixture.driver.tree().key;
  fixture.emit("actor-b"); fixture.emit(actor); await fixture.driver.flush();
  assert.notEqual(fixture.driver.tree().key, initial);
  assert.deepEqual(JSON.parse(fixture.driver.tree().key), [actor, workspace, "lead_manager", "clinic_services", 2]);
  fixture.setAuth({ clinicId: "workspace-b", userRole: "manager" }); await fixture.driver.flush();
  assert.deepEqual(JSON.parse(fixture.driver.tree().key), [actor, "workspace-b", "manager", "clinic_services", 2]);
  fixture.setAuth({ workspacePurpose: "mortgage_leads" }); await fixture.driver.flush();
  assert.deepEqual(JSON.parse(fixture.driver.tree().key), [actor, "workspace-b", "manager", "mortgage_leads", 2]);
  fixture.driver.dispose();
});

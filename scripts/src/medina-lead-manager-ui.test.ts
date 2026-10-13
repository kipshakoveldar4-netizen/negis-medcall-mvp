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

const { permissionsForRole } = evaluate(await read("lib/permissions.ts"));
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
];
const lead = { id: "lead-1", name: "Local contact", phone: "+77000000000", status: "new", stageId,
  source: "website", campaign: "Preserve campaign", sourceId: workspace, responsibleUserId: actor,
  metaCampaignLaunchId: actor, notes: "Original note" };
type Access = { actorId: string; workspaceId: string; isCurrent: () => boolean; request: (path: string, init?: RequestInit) => Promise<Response> };

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
  const module = evaluate(leads + "\nexports.fixture = { LeadsPageSession, LeadsPageContent, leadPatchToApi, loadTaxonomyList };", {
    window: { localStorage: { getItem: () => "admin", setItem: () => {} } },
  }, {
    react: driver.hooks,
    wouter: { Link: "Link", useLocation: () => ["/leads", () => {}] },
    sonner: { toast: new Proxy({}, { get: (_target, name) => () => toasts.push(String(name)) }) },
    "@/contexts/AuthContext": { useAuth: () => auth },
    "@/lib/supabase": { hasSupabaseFrontendEnv: true, supabase: { auth: { onAuthStateChange(callback: any) {
      callbacks.add(callback); return { data: { subscription: { unsubscribe: () => callbacks.delete(callback) } } };
    } } } },
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
  const access: Access = { actorId: actor, workspaceId: workspace, isCurrent: () => true, request: crmFetch };
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
      "@/contexts/AuthContext": { useAuth: () => ({ userRole: "lead_manager", rolePermissions: current.ALL_PERMISSIONS,
        user: null, vertical: "clinic", workspacePurpose: "clinic_services", availableWorkspaces: [] }) },
      "@/lib/workspaceRoutes": workspaceRoutes,
      "@/lib/demoStorage": { isRealWorkspace: () => true },
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
    assert.equal(fixture.driver.nodes().some((node) => node.type === "Link"), false);
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

test("mortgage routes intersect roles and never mount medical, advertising or unsupported pages", async () => {
  const app = await read("App.tsx");
  for (const role of ["owner", "admin", "lead_manager", "manager", "marketer", "doctor"]) {
    for (const location of ["/leads", "/admin", "/clients", "/sales", "/appointments", "/booking", "/dashboard", "/ads", "/ads-automation/history", "/site-blog", "/services", "/reports"]) {
      let redirected = "";
      const routes = evaluate(select(app, ["ROUTE_PERMISSIONS", "firstAllowedRoute", "ProtectedPage"]), {
        ...workspaceRoutes,
        useAuth: () => ({ userRole: role, rolePermissions: { crm: true, admin: role !== "lead_manager", ads: true, dashboard: true, booking: true }, isLoading: false, workspacePurpose: "mortgage_leads" }),
        useLocation: () => [location, (url: string) => { redirected = url; }], useEffect: (run: () => void) => run(),
      }).selected;
      const allowed = workspaceRoutes.workspaceAllowsRoute("mortgage_leads", role, location);
      const tree = routes.ProtectedPage({ component: "Screen", permission: location === "/leads" ? "crm" : location === "/admin" ? "admin" : "dashboard" });
      assert.equal(tree?.type === "Screen", allowed, `${role}: ${location}`);
      const supportedRole = ["owner", "admin", "lead_manager"].includes(role);
      assert.equal(redirected, allowed || !supportedRole ? "" : "/leads");
      if (!supportedRole) assert.match(label(tree), /Доступ к пространству ограничен/);
    }
  }
  assert.equal(workspaceRoutes.workspaceAllowsRoute(null, "owner", "/leads"), false);
  const landing = evaluate(select(await read("pages/Landing.tsx"), ["roleRoute"])).selected;
  for (const role of ["owner", "admin", "lead_manager"]) assert.equal(landing.roleRoute(role, "mortgage_leads"), "/leads");
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
  fixture.emit("actor-b"); fixture.emit(actor);
  assert.equal(first.isCurrent(), false); assert.equal(init.signal?.aborted, true);
  await assert.rejects(first.request("/api/crm/leads"), { name: "AbortError" });
  fixture.driver.replayLayout(); await fixture.driver.flush();
  const next: Access = fixture.driver.tree().props.access;
  assert.equal(next.isCurrent(), true); assert.equal(first.isCurrent(), false);
  fixture.setAuth({ clinicId: "workspace-b" }); await fixture.driver.flush();
  assert.equal(next.isCurrent(), false);
  fixture.driver.dispose(); assert.equal(next.isCurrent(), false);
});

test("guarded reference requests reject late response and late body parse", async () => {
  const fixture = setup(); fixture.lifetime(); await fixture.driver.flush();
  const access: Access = fixture.driver.tree().props.access;
  const pending = deferred<Response>(); fixture.reply(() => pending.promise);
  const requested = access.request("/api/crm/lead-stages");
  fixture.emit("actor-b"); pending.resolve(Response.json({ success: true }));
  await assert.rejects(requested, { name: "AbortError" }); fixture.driver.dispose();

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

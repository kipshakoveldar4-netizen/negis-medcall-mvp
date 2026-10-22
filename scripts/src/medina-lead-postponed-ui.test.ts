import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

// Execute the actual UI with synthetic hooks and records, without app startup,
// environment reads, browser storage, network or a clinic connection.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const read = (file: string) => readFile(path.join(root, "artifacts/negis/src", file), "utf8");
const leadsSource = await read("pages/LeadsPage.tsx");
const formSource = await read("components/mortgage/MortgageContactForm.tsx");
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
type Node = { type: any; props: Record<string, any>; key?: unknown };
const jsx = (type: any, props: Node["props"], key?: unknown): Node => ({ type, props, key });

function evaluate(source: string, imports: Record<string, unknown> = {}, bindings: Record<string, unknown> = {}) {
  const exports: Record<string, any> = {};
  const compiled = ts.transpileModule(source, { fileName: "local-fixture.tsx", reportDiagnostics: true, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } });
  assert.deepEqual(compiled.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error), []);
  new Script(compiled.outputText).runInNewContext({ exports, AbortController, DOMException, URLSearchParams,
    fetch: () => assert.fail("Unexpected network call"), ...bindings,
    require(name: string) {
      if (Object.hasOwn(imports, name)) return imports[name];
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "lucide-react" || name.startsWith("@/components/")) {
        return new Proxy({}, { get: (_target, key) => String(key) });
      }
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return exports;
}

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
function hookDriver() {
  const slots: any[] = [];
  let cursor = 0, dirty = true, tree: any;
  let render = () => tree;
  const sameDeps = (a?: unknown[], b?: unknown[]) => Boolean(a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index])));
  const hooks = {
    useState(initial: any) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, (update: any) => {
        const next = typeof update === "function" ? update(slots[index].value) : update;
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true; }
      }];
    },
    useRef(initial: any) { return slots[cursor++] ??= { current: initial }; },
    useMemo(create: () => unknown, deps?: unknown[]) {
      const index = cursor++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: create(), deps };
      return slots[index].value;
    },
    useEffect(create: () => unknown, deps?: unknown[]) {
      const index = cursor++, old = slots[index];
      slots[index] = { create, deps, cleanup: old?.cleanup, pending: !old || !sameDeps(old.deps, deps) };
    },
    useId: () => "local-form",
  };
  return {
    hooks, mount(component: () => any) { render = component; dirty = true; },
    async flush() {
      for (let pass = 0; pass < 40; pass++) {
        if (dirty) {
          dirty = false; cursor = 0; tree = render();
          const pending = slots.filter((item) => item?.pending);
          for (const item of pending) { item.cleanup?.(); item.pending = false; item.cleanup = item.create(); }
        }
        await Promise.resolve();
      }
      assert.equal(dirty, false, "local render settles");
    },
    nodes: () => nodes(tree),
  };
}
function find(driver: ReturnType<typeof hookDriver>, predicate: (node: Node) => boolean) {
  const node = driver.nodes().find(predicate);
  assert.ok(node, "expected UI control");
  return node;
}
const button = (driver: ReturnType<typeof hookDriver>, text: string) => find(driver, (node) => node.type === "button" && label(node) === text);
const pipeline = evaluate(await read("lib/leadPipeline.ts"));
const dashboard = evaluate(await read("lib/dashboardData.ts"), { "./leadPipeline": pipeline });
const primitives = evaluate(await read("components/mortgage/MortgagePrimitives.tsx"), { wouter: { Link: "Link" } });
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const stages = pipeline.FALLBACK_LEAD_STAGES.map((stage: any, index: number) => ({ ...stage, id: uuid(index + 10) }));
const postponed = stages.find((stage: any) => stage.stageKey === "postponed");
const records = ["new", "in_progress", "booked", "lost", "postponed", "Отложенные", "deferred appointment"].map((status, index) => ({
  id: `lead-${index}`, name: `Local contact ${index}`, phone: "+77000000000", status, source: "manual", campaign: "",
  notes: "Local note", createdAt: "2026-10-20T12:00:00Z",
}));

function leadUi(persistedStages = stages, role = "lead_manager") {
  const driver = hookDriver();
  const updates: Array<{ patch: any; payload: any }> = [];
  let current = true;
  const request = async (url: string) => ({ ok: true, text: async () => JSON.stringify({ success: true, mode: "supabase", data:
    url.includes("lead-stages?") ? { stages: persistedStages } : url.includes("lead-assignees?") ? { assignees: [] } : { sources: [] },
  }) });
  const module = evaluate(leadsSource + "\nexports.fixture = { LeadsPageContent };", {
    react: driver.hooks, wouter: { Link: "Link" }, sonner: { toast: { success() {}, error() {} } },
    "@/contexts/AuthContext": { useAuth: () => ({ user: { id: uuid(1) }, clinicId: uuid(2), userRole: role,
      workspacePurpose: "mortgage_leads", rolePermissions: { crm: true, tasks: true }, session: {}, isDemoMode: false, isImpersonation: false }) },
    "@/lib/leadPipeline": pipeline,
    "@/lib/api": { crmFetch: request },
    "@/lib/supabase": { hasSupabaseFrontendEnv: false },
    "@/lib/phone": { formatPhone: (value: string) => value, toTelHref: () => "tel:local", toWhatsappHref: () => "https://example.test" },
    "@/lib/demoStorage": { isRealWorkspace: () => true, readWorkspaceId: () => uuid(2), workspaceScopedKey: (key: string) => key,
      useDemoCollection: (_key: string, _seed: unknown, options: any) => ({ items: clone(records), loaded: true, loadError: false,
        addItem: () => assert.fail("Unexpected create"), setItems: () => assert.fail("Unexpected collection replacement"),
        updateItem: async (_id: string, patch: any) => { updates.push({ patch: clone(patch), payload: clone(options.patchToApi(patch)) }); return true; },
      }),
    },
  }, { window: { localStorage: { getItem: () => null } } });
  const access = { actorId: uuid(1), workspaceId: uuid(2), isCurrent: () => current, request };
  driver.mount(() => module.fixture.LeadsPageContent({ access }));
  return { driver, updates, invalidate() { current = false; } };
}

test("postponed is the fifth canonical group and its fallback sits between booked and lost", () => {
  assert.equal(pipeline.isLeadSemanticGroup("postponed"), true);
  assert.equal(pipeline.isLeadSemanticGroup("deferred"), false);
  const fallback = pipeline.FALLBACK_LEAD_STAGES;
  assert.deepEqual(clone(fallback.map((stage: any) => stage.stageKey)), ["new", "in_progress", "booked", "postponed", "lost"]);
  assert.equal(fallback[3].id, "fallback:postponed");
  assert.equal(fallback[3].name, "Отложена");
  assert.equal(fallback[3].semanticGroup, "postponed");
  assert.equal(fallback[3].sortOrder, 35);
  assert.equal(fallback[3].color, "#64748b");
});

test("legacy deferred aliases win before work, booking and loss branches", () => {
  for (const status of ["отложен", "Отложена", "ОТЛОЖЕННЫЕ", "postponed", "deferred", "отложена запись", "postponed contact", "deferred appointment cancelled"]) {
    assert.equal(pipeline.normalizeLegacyLeadStatus(status), "postponed", status);
    assert.equal(pipeline.semanticGroupForLead({ status }), "postponed", status);
  }
  for (const status of ["new", "in_progress", "booked", "lost"]) assert.equal(pipeline.normalizeLegacyLeadStatus(status), status);
  assert.equal(pipeline.semanticGroupForLead({ status: "new", semantic_group: "postponed" }), "postponed");
  assert.equal(pipeline.semanticGroupForLead({ status: "new", stage: { semantic_group: "postponed" } }), "postponed");
  assert.equal(pipeline.semanticGroupForLead({ status: "Отложена", semanticGroup: "booked" }), "booked", "persisted semantics retain precedence");
});

test("stage parser accepts persisted postponed definitions in either field casing", () => {
  assert.deepEqual(clone(pipeline.leadStageDefinitionFromUnknown(postponed)), postponed);
  const parsed = pipeline.leadStageDefinitionFromUnknown({ id: postponed.id, stage_key: "postponed", name: "Отложена",
    semantic_group: "postponed", sort_order: "35", is_default: "true", is_active: true });
  assert.equal(parsed.stageKey, "postponed");
  assert.equal(parsed.semanticGroup, "postponed");
  assert.equal(parsed.sortOrder, 35);
  assert.equal(pipeline.leadStageDefinitionFromUnknown({ ...postponed, semanticGroup: "unknown" }), null);
});

test("dashboard new queue excludes canonical, deferred and structured postponed leads", () => {
  const queue = dashboard.buildNewLeadsQueue([...records, { id: "structured", status: "new", semanticGroup: "postponed" }], 20);
  assert.deepEqual(clone(queue.map((item: any) => item.id)), ["lead-0"]);
});

test("actual leads UI renders six responsive cards with exclusive counts and a slate postponed pill", async () => {
  const { driver } = leadUi(); await driver.flush();
  const section = find(driver, (node) => node.props["aria-label"] === "Сводка по заявкам");
  assert.match(section.props.className, /grid-cols-2.*md:grid-cols-3.*2xl:grid-cols-6/);
  const metrics = nodes(section).filter((node) => node.type === "MetricCard").map((node) => node.props);
  assert.equal(metrics.length, 6);
  assert.deepEqual(metrics.map((metric) => metric.value), [7, 1, 1, 1, 3, 1]);
  assert.equal(metrics[4].label, "Отложенные");
  assert.equal(metrics[4].tone, "muted");
  assert.equal(metrics.slice(1).reduce((sum, metric) => sum + metric.value, 0), metrics[0].value);
  const pill = find(driver, (node) => node.type?.name === "StatusPill" && label(node) === "Отложена");
  assert.equal(pill.props.tone, "slate");
});

test("filters expose persisted active stages only, before and after the postponed migration", async () => {
  for (const available of [stages.filter((stage: any) => stage.stageKey !== "postponed"), stages,
    stages.map((stage: any) => stage.stageKey === "postponed" ? { ...stage, isActive: false } : stage)]) {
    const { driver } = leadUi(available); await driver.flush();
    const deferredFilters = driver.nodes().filter((node) => node.type === "button" && label(node) === "Отложена");
    assert.equal(deferredFilters.length, available.some((stage: any) => stage.stageKey === "postponed" && stage.isActive) ? 1 : 0);
    if (deferredFilters.length) {
      deferredFilters[0].props.onClick(); await driver.flush();
      const rows = driver.nodes().filter((node) => node.type === "tr" && String(node.key).startsWith("lead-"));
      assert.deepEqual(rows.map((node) => node.key), ["lead-4", "lead-5", "lead-6"]);
    }
  }
});

test("quick edit and form save send the postponed stage/key for both allowed roles", async () => {
  for (const role of ["lead_manager", "owner"]) {
    const { driver, updates, invalidate } = leadUi(stages, role); await driver.flush();
    const row = find(driver, (node) => node.type === "tr" && node.key === "lead-0");
    nodes(row).find((node) => node.props["aria-label"] === "Подробнее")!.props.onClick(); await driver.flush();
    await driver.nodes().filter((node) => node.type === "button" && label(node) === "Отложена").at(-1)!.props.onClick();
    assert.equal(updates[0].payload.status, "postponed");
    assert.equal(updates[0].payload.stageId, postponed.id);
    assert.equal(updates[0].patch.semanticGroup, "postponed");
    assert.equal(updates[0].patch.stageKey, "postponed");
    button(driver, "Изменить").props.onClick(); await driver.flush();
    find(driver, (node) => node.props["data-testid"] === "lead-stage-select").props.onChange({ target: { value: postponed.id } });
    await driver.flush(); button(driver, "Сохранить").props.onClick(); await driver.flush();
    assert.equal(updates[1].payload.status, "postponed");
    assert.equal(updates[1].payload.stageId, postponed.id);
    if (role === "lead_manager") {
      assert.deepEqual(Object.keys(updates[1].payload).sort(), ["name", "notes", "phone", "stageId", "status"]);
      assert.equal(driver.nodes().some((node) => label(node) === "Добавить заявку"), false);
    }
    const nextRow = find(driver, (node) => node.type === "tr" && node.key === "lead-0");
    nodes(nextRow).find((node) => node.props["aria-label"] === "Подробнее")!.props.onClick(); await driver.flush();
    invalidate();
    await driver.nodes().filter((node) => node.type === "button" && label(node) === "Отложена").at(-1)!.props.onClick();
    assert.equal(updates.length, 2, "ended sessions cannot change statuses");
  }
});

test("mortgage dropdown, row badge and edit submission preserve canonical postponed", async () => {
  assert.equal(primitives.mortgageContactStatus("postponed"), "Отложена");
  const badge = primitives.MortgageContactBadge({ status: "postponed" });
  assert.equal(label(badge), "Отложена");
  assert.match(badge.props.className, /badge-muted/);
  const driver = hookDriver(), submissions: any[] = [];
  const module = evaluate(formSource, {
    react: driver.hooks,
    "@/lib/phone": { phoneDigits: (value: string) => value.replace(/\D/g, "") },
    "@/contexts/AuthContext": { useAuth: () => ({ clinicId: uuid(2), userRole: "lead_manager" }) },
    "./MortgagePrimitives": primitives,
  });
  driver.mount(() => module.MortgageContactForm({ contact: { ...records[4], status: "postponed" },
    request: () => assert.fail("Editing must not request assignees"), isCurrent: () => true,
    onSubmit: async (fields: any) => { submissions.push(fields); }, onClose() {},
  }));
  await driver.flush();
  const select = find(driver, (node) => node.type === "select");
  assert.equal(select.props.value, "postponed");
  const options = nodes(select).filter((node) => node.type === "option");
  assert.deepEqual(options.map((node) => node.props.value), ["new", "in_progress", "booked", "postponed", "lost"]);
  assert.equal(label(options[3]), "Отложена");
  await find(driver, (node) => node.type === "form").props.onSubmit({ preventDefault() {} }); await driver.flush();
  assert.equal(submissions.length, 1);
  assert.equal("status" in submissions[0], false, "an unchanged postponed selection must preserve the persisted stage");
  assert.deepEqual(Object.keys(submissions[0]).sort(), ["name", "notes", "phone"]);
  select.props.onChange({ target: { value: "in_progress" } }); await driver.flush();
  await find(driver, (node) => node.type === "form").props.onSubmit({ preventDefault() {} }); await driver.flush();
  assert.equal(submissions.length, 2);
  assert.equal(submissions[1].status, "in_progress");
  assert.deepEqual(Object.keys(submissions[1]).sort(), ["name", "notes", "phone", "status"]);
});

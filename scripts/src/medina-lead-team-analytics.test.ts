import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const load = (file: string) => import(pathToFileURL(path.join(root, file)).href);
const { setSupabaseServerClientFactoryForTests } = await load("lib/supabase/server.ts");
const { attachWorkspaceContext } = await load("lib/crm/server.ts");
const { handleLeadTeamAnalytics } = await load("lib/crm/lead-team-analytics.ts");
const { mortgageRouteAllowed } = await load("lib/crm/workspace-policy.ts");
const { resolveCrmRoute } = await load("lib/crm/authorization.ts");

type Row = Record<string, any>;
const workspace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const foreign = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const managerA = id(1), managerB = id(2), owner = id(3), stage = id(4);
const recent = new Date(Date.now() - 60_000).toISOString();
afterEach(() => setSupabaseServerClientFactoryForTests(null));

function fixture(options: { failTable?: string; failAfter?: number; auditCountDrift?: boolean; shortPage?: boolean; duplicate?: boolean; count?: number } = {}) {
  const rows: Record<string, Row[]> = {
    staff_users: [
      { id: managerA, workspace_id: workspace, full_name: "Менеджер А", role: "lead_manager", status: "active" },
      { id: managerB, workspace_id: workspace, full_name: "Менеджер Б", role: "lead_manager", status: "inactive" },
      { id: owner, workspace_id: workspace, full_name: "Владелец", role: "owner", status: "active" },
      { id: id(5), workspace_id: foreign, full_name: "Чужой сотрудник", role: "lead_manager", status: "active" },
    ],
    lead_stages: [{ id: stage, workspace_id: workspace, semantic_group: "in_progress" }],
    leads: [
      { id: id(10), workspace_id: workspace, responsible_user_id: managerA, status: "new" },
      { id: id(11), workspace_id: workspace, responsible_user_id: managerA, status: "custom", stage_id: stage },
      { id: id(12), workspace_id: workspace, responsible_user_id: managerB, status: "lost" },
      { id: id(13), workspace_id: workspace, responsible_user_id: null, status: "new" },
      { id: id(14), workspace_id: workspace, responsible_user_id: id(99), status: "new" },
      { id: id(15), workspace_id: workspace, responsible_user_id: managerA, status: "unknown" },
      { id: id(16), workspace_id: foreign, responsible_user_id: managerA, status: "new" },
    ],
    audit_logs: [
      ...[20, 21].map((n) => ({ id: id(n), workspace_id: workspace, entity_type: "lead", entity_id: id(10),
        actor_kind: "manual", actor_staff_user_id: managerB, action: "updated", created_at: recent })),
      { id: id(22), workspace_id: workspace, entity_type: "lead", entity_id: id(11), actor_kind: "manual",
        actor_staff_user_id: managerB, action: "created", created_at: recent },
      { id: id(23), workspace_id: foreign, entity_type: "lead", entity_id: id(10), actor_kind: "manual",
        actor_staff_user_id: managerB, action: "updated", created_at: recent },
      { id: id(24), workspace_id: workspace, entity_type: "lead", entity_id: id(10), actor_kind: "integration",
        actor_staff_user_id: managerB, action: "updated", created_at: recent },
      { id: id(25), workspace_id: workspace, entity_type: "client", entity_id: id(10), actor_kind: "manual",
        actor_staff_user_id: managerB, action: "updated", created_at: recent },
      { id: id(26), workspace_id: workspace, entity_type: "lead", entity_id: id(10), actor_kind: "manual",
        actor_staff_user_id: managerB, action: "updated", created_at: "2020-01-01T00:00:00.000Z" },
    ],
  };
  const queries: Row[] = [];
  setSupabaseServerClientFactoryForTests(() => ({
    from(table: string) {
      const query: Row = { table, filters: [], columns: "", range: null };
      queries.push(query);
      const builder: Row = {
        select(columns: string, config?: { count?: string }) { query.columns = columns; query.exact = config?.count === "exact"; return builder; },
        eq(key: string, value: unknown) { query.filters.push((row: Row) => row[key] === value); return builder; },
        in(key: string, values: unknown[]) { query.filters.push((row: Row) => values.includes(row[key])); return builder; },
        gte(key: string, value: string) { query.filters.push((row: Row) => Date.parse(row[key]) >= Date.parse(value)); return builder; },
        lte(key: string, value: string) { query.filters.push((row: Row) => Date.parse(row[key]) <= Date.parse(value)); return builder; },
        order(column: string, config: unknown) { query.order = { column, config }; return builder; },
        range(start: number, end: number) { query.range = [start, end]; return builder; },
        then(resolve: (value: unknown) => unknown) {
          if (options.failTable === table && (query.range?.[0] ?? 0) >= (options.failAfter ?? 0)) {
            return Promise.resolve({ data: null, error: { message: "private DB failure" }, count: null }).then(resolve);
          }
          const filtered = (rows[table] ?? []).filter((row) => query.filters.every((f: (row: Row) => boolean) => f(row)));
          const [start, end] = query.range ?? [0, filtered.length];
          let data = filtered.slice(start, end + 1);
          if (options.shortPage && table === "leads") data = data.slice(0, -1);
          if (options.duplicate && table === "leads" && data.length > 1) data[1] = data[0];
          const count = table === "leads" ? options.count ?? filtered.length
            : table === "audit_logs" && options.auditCountDrift && start > 0 ? filtered.length + 1 : filtered.length;
          return Promise.resolve({ data, error: null, count: query.exact ? count : null }).then(resolve);
        },
      };
      return builder;
    },
  }));
  return { rows, queries };
}

async function call({ role = "owner", purpose = "mortgage_leads", method = "GET", days = undefined as unknown, context = true } = {}) {
  const req: any = { method, query: { days, workspaceId: foreign }, body: { workspaceId: foreign }, headers: {} };
  if (context) attachWorkspaceContext(req, { workspaceId: workspace, userId: id(80), staffUserId: owner,
    role, purpose, permissions: [] } as any);
  const res: any = { statusCode: 0, body: null, headers: {}, status(code: number) { this.statusCode = code; return this; },
    setHeader(key: string, value: unknown) { this.headers[key] = value; return this; }, json(body: unknown) { this.body = body; return this; } };
  await handleLeadTeamAnalytics(req, res);
  return res;
}

test("snapshot is tenant scoped, includes inactive staff and never attributes edits to today's assignee", async () => {
  const f = fixture();
  const res = await call();
  assert.equal(res.statusCode, 200);
  const a = res.body.data.analytics;
  assert.equal(a.totalLeads, 6);
  assert.equal(a.unassignedLeads, 1);
  assert.equal(a.otherAssigneeLeads, 1);
  assert.equal(a.members.length, 3);
  const first = a.members.find((row: Row) => row.staffId === managerA);
  const second = a.members.find((row: Row) => row.staffId === managerB);
  assert.deepEqual(first.assigned, { total: 3, new: 1, inProgress: 1, booked: 0, lost: 0, other: 1 });
  assert.equal(first.activity.updatedEvents, 0);
  assert.equal(second.status, "inactive");
  assert.deepEqual(second.activity, { updatedEvents: 2, createdEvents: 1, touchedLeads: 2, lastRecordedAt: recent });
  assert.equal(res.headers["Cache-Control"], "private, no-store");
  assert.ok(f.queries.every((q) => !/phone|notes|email|metadata|\*/.test(q.columns)));
  assert.ok(f.queries.every((q) => q.exact && q.order.column === "id" && q.order.config.ascending === true));
  assert.doesNotMatch(JSON.stringify(res.body), /Чужой сотрудник/);
});

test("all pages past the PostgREST ceiling are included", async () => {
  const f = fixture();
  f.rows.leads = Array.from({ length: 1_203 }, (_, n) => ({ id: id(n + 100), workspace_id: workspace, responsible_user_id: managerA, status: "new" }));
  const res = await call({ role: "admin", days: "7" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.analytics.totalLeads, 1_203);
  assert.deepEqual(f.queries.filter((q) => q.table === "leads").map((q) => q.range), [[0, 499], [500, 999], [1000, 1499]]);
});

test("roles, purpose, context, method and period deny before any storage access", async () => {
  const f = fixture();
  for (const role of ["lead_manager", "manager", "receptionist", "doctor", "marketer"]) assert.equal((await call({ role })).statusCode, 403);
  assert.equal((await call({ purpose: "clinic_services" })).statusCode, 403);
  assert.equal((await call({ context: false })).statusCode, 403);
  assert.equal((await call({ method: "POST" })).statusCode, 405);
  for (const days of ["0", "365", "30x", ["30"], 30, ""]) assert.equal((await call({ days })).statusCode, 400);
  assert.equal(f.queries.length, 0);
});

test("incomplete, duplicated, oversized or failed snapshot cannot return a plausible partial total", async () => {
  for (const options of [{ shortPage: true }, { duplicate: true }, { count: 20_001 }, { failTable: "staff_users" }, { failTable: "lead_stages" }, { failTable: "leads" }]) {
    fixture(options);
    const res = await call();
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.data, undefined);
    assert.doesNotMatch(JSON.stringify(res.body), /private DB failure/);
  }
});

test("journal outage is unavailable, never zero edits or a failed workload snapshot", async () => {
  fixture({ failTable: "audit_logs" });
  const res = await call();
  assert.equal(res.statusCode, 200);
  const a = res.body.data.analytics;
  assert.equal(a.totalLeads, 6);
  assert.equal(a.activityStatus, "unavailable");
  assert.ok(a.members.every((row: Row) => row.activity === null));
});

test("audit pagination counts every event and discards all partial activity after a second-page outage or drift", async () => {
  for (const options of [{}, { failTable: "audit_logs", failAfter: 500 }, { auditCountDrift: true }]) {
    const f = fixture(options);
    f.rows.audit_logs = Array.from({ length: 1_003 }, (_, n) => ({ id: id(n + 2000), workspace_id: workspace,
      entity_type: "lead", entity_id: id(10 + n % 3), actor_kind: "manual", actor_staff_user_id: managerA,
      action: "updated", created_at: recent }));
    const res = await call();
    assert.equal(res.statusCode, 200);
    const a = res.body.data.analytics;
    if ("failTable" in options || "auditCountDrift" in options) {
      assert.equal(a.activityStatus, "unavailable");
      assert.ok(a.members.every((row: Row) => row.activity === null));
    } else {
      assert.equal(a.activityStatus, "available");
      assert.equal(a.members.find((row: Row) => row.staffId === managerA).activity.updatedEvents, 1_003);
      assert.equal(a.members.find((row: Row) => row.staffId === managerA).activity.touchedLeads, 3);
    }
  }
});

test("rolling period includes both boundaries, excludes old/future events and finds latest independent of row order", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-15T12:00:00.000Z") });
  const f = fixture();
  const times = ["2026-10-15T17:00:00+05:00", "2026-10-08T12:00:00.000Z", "2026-10-09T12:00:00.000Z",
    "2026-10-08T11:59:59.999Z", "2026-10-15T12:00:00.001Z"];
  f.rows.audit_logs = times.map((at, n) => ({ id: id(3000 + n), workspace_id: workspace, entity_type: "lead",
    entity_id: id(10), actor_kind: "manual", actor_staff_user_id: managerB, action: "updated", created_at: at }));
  const res = await call({ days: "7" });
  const a = res.body.data.analytics;
  assert.deepEqual(a.period, { days: 7, from: "2026-10-08T12:00:00.000Z", to: "2026-10-15T12:00:00.000Z" });
  assert.deepEqual(a.members.find((row: Row) => row.staffId === managerB).activity, {
    updatedEvents: 3, createdEvents: 0, touchedLeads: 1, lastRecordedAt: "2026-10-15T12:00:00.000Z",
  });
});

test("authorization registry and mortgage policy admit only owner/admin GET", () => {
  const route = resolveCrmRoute(["lead-team-analytics"]);
  assert.deepEqual(route?.authorization.roles, ["owner", "admin"]);
  assert.deepEqual(route?.authorization.methods, ["GET"]);
  for (const role of ["owner", "admin"]) assert.equal(mortgageRouteAllowed(role, "lead-team-analytics", "GET"), true);
  for (const role of ["lead_manager", "manager", "doctor"]) assert.equal(mortgageRouteAllowed(role, "lead-team-analytics", "GET"), false);
  assert.equal(mortgageRouteAllowed("owner", "lead-team-analytics", "POST"), false);
});

test("real catch-all rechecks account, role, revoked membership and foreign selectors on each request", async () => {
  const f = fixture();
  f.rows.staff_users.find((row) => row.id === owner)!.auth_user_id = id(80);
  f.rows.staff_users.find((row) => row.id === managerA)!.auth_user_id = id(82);
  f.rows.workspace_settings = [{ workspace_id: workspace, key: "workspace_purpose", value: { purpose: "mortgage_leads" } }];
  const env = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY };
  const fetchBefore = globalThis.fetch;
  let actor = id(80);
  process.env.SUPABASE_URL = "https://local.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "local-fixture-only";
  globalThis.fetch = (async (url: unknown) => {
    assert.match(String(url), /\/auth\/v1\/user$/);
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: actor }) };
  }) as typeof fetch;
  try {
    const router = await load("api/crm/[...path].ts");
    const run = async (selector = workspace) => {
      f.queries.length = 0;
      const res: any = { statusCode: 0, body: null, status(code: number) { this.statusCode = code; return this; },
        setHeader() { return this; }, json(body: unknown) { this.body = body; return this; } };
      await router.default({ method: "GET", headers: { authorization: "Bearer local.fixture.token" },
        query: { path: ["lead-team-analytics"], workspaceId: selector }, body: { workspaceId: foreign } }, res);
      return res;
    };
    assert.equal((await run()).statusCode, 200);
    actor = id(82);
    assert.equal((await run()).statusCode, 403);
    assert.ok(f.queries.every((q) => ["staff_users", "workspace_settings"].includes(q.table)));
    actor = id(80);
    f.rows.staff_users.find((row) => row.id === owner)!.role = "lead_manager";
    assert.equal((await run()).statusCode, 403);
    f.rows.staff_users.find((row) => row.id === owner)!.role = "owner";
    f.rows.staff_users.find((row) => row.id === owner)!.status = "inactive";
    assert.equal((await run()).statusCode, 403);
    assert.ok(f.queries.every((q) => q.table === "staff_users"));
    f.rows.staff_users.find((row) => row.id === owner)!.status = "active";
    assert.equal((await run(foreign)).statusCode, 403);
    assert.ok(f.queries.every((q) => q.table === "staff_users"));
  } finally {
    globalThis.fetch = fetchBefore;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

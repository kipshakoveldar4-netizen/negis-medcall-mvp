import assert from "node:assert/strict";
import test, { after, afterEach, before, beforeEach } from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const load = (file: string) => import(pathToFileURL(path.join(root, file)).href);
type Row = Record<string, any>;
type Context = { workspaceId: string; staffUserId: string; userId: string; role: string; purpose?: string; permissions: string[] };
type Response = {
  statusCode: number; body: Row; headers: Row;
  status(code: number): Response; setHeader(name: string, value: unknown): Response; json(body: Row): Response;
};
type RpcCall = { name: string; args: Row };
const workspace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const foreign = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const managerA = id(1), managerB = id(2), owner = id(3), admin = id(6), authUser = id(80);
const verified: Context = { workspaceId: workspace, staffUserId: owner, userId: authUser,
  role: "owner", purpose: "mortgage_leads", permissions: [] };
const scope = { p_workspace_id: workspace, p_staff_user_id: owner, p_auth_user_id: authUser };
const generatedAt = "2026-10-15T12:00:00.000Z", recent = "2026-10-15T11:59:00.000Z";
const privateDetail = "fixture-private SELECT internal_column service_role phone notes email metadata";
const originalFetch = globalThis.fetch;
let setFactory: (factory: (() => any) | null) => void;
let attach: (req: Row, context: Context) => void;
let handle: (req: Row, res: Response) => Promise<unknown>;
let mortgageRouteAllowed: (role: string, route: string, method: string) => boolean;
let resolveCrmRoute: (segments: string[]) => any;
let calls: RpcCall[], forbiddenCalls: string[], factoryCalls: number, fetchCalls: number;
let result: { data: unknown; error: Row | null }, rpcThrow: unknown;

const emptyAssigned = () => ({ total: 0, new: 0, inProgress: 0, booked: 0, postponed: 0, lost: 0, other: 0 });
const emptyActivity = () => ({ updatedEvents: 0, createdEvents: 0, touchedLeads: 0, lastRecordedAt: null as string | null });
function snapshot(days = 30) {
  return {
    workspaceId: workspace, timeZone: "Asia/Almaty", generatedAt,
    period: { days, from: new Date(Date.parse(generatedAt) - days * 86_400_000).toISOString(), to: generatedAt },
    totalLeads: 10, unassignedLeads: 1, otherAssigneeLeads: 1, activityStatus: "available",
    members: [
      { staffId: admin, name: "Admin", role: "admin", status: "active",
        assigned: { ...emptyAssigned(), total: 1, new: 1 },
        activity: { updatedEvents: 1, createdEvents: 0, touchedLeads: 1, lastRecordedAt: recent as string | null } },
      { staffId: managerA, name: "Manager A", role: "lead_manager", status: "active",
        assigned: { total: 6, new: 1, inProgress: 1, booked: 1, postponed: 1, lost: 1, other: 1 }, activity: emptyActivity() },
      { staffId: managerB, name: "Manager B", role: "lead_manager", status: "inactive",
        assigned: { ...emptyAssigned(), total: 1, lost: 1 },
        activity: { updatedEvents: 2, createdEvents: 1, touchedLeads: 2, lastRecordedAt: recent as string | null } },
      { staffId: owner, name: "Owner", role: "owner", status: "active", assigned: emptyAssigned(), activity: emptyActivity() },
    ],
  };
}

// Native-PG agent owns the former row-based semantics: tenant isolation across
// staff/stages/leads/audit; inactive/owner/admin inclusion; unassigned/other
// assignees; structured-stage priority; exact English/Russian legacy aliases
// (including postponed/deferred), trim/case and near-miss exclusion; zero buckets;
// recorded actor versus current assignee; manual lead created/updated events only;
// event counts versus distinct touched leads; inclusive rolling boundaries and
// latest timestamp independent of row order; >1,000 rows/events without truncation;
// atomic completeness under drift/failure and unavailable (not zero) audit data.
// These fixtures are aggregate DTOs, not a second implementation of the SQL.
before(async () => {
  globalThis.fetch = (async () => { fetchCalls++; throw new Error("Analytics tests forbid network access"); }) as typeof fetch;
  ({ setSupabaseServerClientFactoryForTests: setFactory } = await load("lib/supabase/server.ts"));
  ({ attachWorkspaceContext: attach } = await load("lib/crm/server.ts"));
  ({ handleLeadTeamAnalytics: handle } = await load("lib/crm/lead-team-analytics.ts"));
  ({ mortgageRouteAllowed } = await load("lib/crm/workspace-policy.ts"));
  ({ resolveCrmRoute } = await load("lib/crm/authorization.ts"));
});
function rpcClient() {
  return new Proxy({ async rpc(name: string, args: Row) {
    calls.push({ name, args: structuredClone(args) });
    if (rpcThrow !== undefined) throw rpcThrow;
    return result;
  } }, { get(target, key, receiver) {
    if (key === "rpc") return Reflect.get(target, key, receiver);
    forbiddenCalls.push(String(key));
    throw new Error(`Only analytics RPC is allowed, not ${String(key)}`);
  } });
}
beforeEach(() => {
  calls = []; forbiddenCalls = []; factoryCalls = 0; fetchCalls = 0; rpcThrow = undefined;
  result = { data: snapshot(), error: null };
  setFactory(() => { factoryCalls++; return rpcClient(); });
});
afterEach(() => {
  try {
    assert.equal(fetchCalls, 0, "no network attempts, even swallowed ones");
    assert.deepEqual(forbiddenCalls, [], "no direct tables, pagination, auth or provider fallback, even if caught");
  } finally { setFactory(null); }
});
after(() => { globalThis.fetch = originalFetch; setFactory?.(null); });

function response(): Response {
  return { statusCode: 0, body: {}, headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    json(body) { this.body = body; return this; } };
}
async function call(options: { role?: string; purpose?: string; method?: string; days?: unknown;
  context?: Context | null; query?: Row; body?: unknown; headers?: Row } = {}) {
  const req: Row = { method: options.method ?? "GET", query: { days: options.days, ...options.query },
    body: options.body, headers: options.headers ?? {} };
  if (options.context !== null) attach(req, options.context ?? { ...verified,
    role: options.role ?? verified.role, purpose: options.purpose ?? verified.purpose });
  const res = response();
  await handle(req, res);
  assert.equal(res.headers["cache-control"], "private, no-store");
  assert.match(String(res.headers["content-type"]), /^application\/json\b/);
  return res;
}
function oneRpc(days = 30, context = verified) {
  assert.deepEqual(calls, [{ name: "read_lead_team_analytics", args: {
    p_workspace_id: context.workspaceId, p_staff_user_id: context.staffUserId, p_auth_user_id: context.userId, p_days: days,
  } }]);
  assert.equal(factoryCalls, 1);
}
function untouched() { assert.equal(factoryCalls, 0); assert.deepEqual(calls, []); }
function failure(res: Response, status: number, code?: string) {
  assert.equal(res.statusCode, status, JSON.stringify(res.body));
  assert.equal(res.body.success, false);
  if (code) assert.equal(res.body.code, code);
  assert.ok(Object.keys(res.body).every(key => ["success", "code", "error"].includes(key)), "no partial aggregate or raw error");
  assert.equal(res.body.data, undefined);
  assert.doesNotMatch(JSON.stringify(res.body), /fixture-private|SELECT|internal_column|service_role|phone|notes|email|metadata/);
}
function success(res: Response, internal: Row) {
  const { workspaceId: _workspaceId, ...expected } = internal;
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { success: true, mode: "supabase", data: { analytics: expected } });
}

for (const role of ["owner", "admin"]) for (const days of [undefined, "7", "30", "90"]) {
  test(`${role} GET ${days ?? "default"} calls only the RPC with all verified identity arguments`, async () => {
    const period = Number(days ?? 30), context = { ...verified, role,
      ...(role === "admin" ? { staffUserId: admin, userId: id(81) } : {}) };
    const expected = snapshot(period);
    result.data = expected;
    success(await call({ context, days,
      query: { workspaceId: foreign, workspace_id: foreign, staffUserId: id(90), staff_user_id: id(91),
        userId: id(92), auth_user_id: id(93), p_workspace_id: foreign, p_staff_user_id: id(94), p_auth_user_id: id(95),
        p_days: 90, from: privateDetail, to: privateDetail, page: 5, limit: 1, offset: 1_000 },
      body: { ...verified, workspaceId: foreign, staffUserId: id(96), userId: id(97), days: "90" },
      headers: { "x-workspace-id": foreign, "x-staff-user-id": id(98), "x-user-id": id(99) },
    }), expected);
    oneRpc(period, context);
  });
}
test("nonempty DTO preserves every bucket, inactive/admin members and recorded activity without recomputing it", async () => {
  const expected = snapshot();
  success(await call(), expected); oneRpc();
  assert.deepEqual(result.data, expected);
});
test("empty snapshot is an explicit successful zero DTO, not unavailable storage", async () => {
  const expected = { ...snapshot(), totalLeads: 0, unassignedLeads: 0, otherAssigneeLeads: 0, members: [] };
  result.data = expected;
  success(await call(), expected); oneRpc();
});
test("staff with no assignments retain all explicit zero buckets including postponed", async () => {
  const expected = snapshot();
  expected.totalLeads = expected.unassignedLeads = expected.otherAssigneeLeads = 0;
  for (const member of expected.members) { member.assigned = emptyAssigned(); member.activity = emptyActivity(); }
  result.data = expected;
  success(await call(), expected); oneRpc();
});
test("exact 20,000 lead and 30,000 event caps succeed without table reads or pagination", async () => {
  const expected = snapshot();
  expected.totalLeads = 20_000;
  expected.members[1].assigned.total = 19_996;
  expected.members[1].assigned.new = 19_991;
  expected.members[1].activity = { updatedEvents: 29_996, createdEvents: 0, touchedLeads: 3, lastRecordedAt: recent };
  result.data = expected;
  success(await call(), expected); oneRpc();
});
test("unavailable audit retains workload and null activity, never fabricated zero edits", async () => {
  const expected: Row = snapshot();
  expected.activityStatus = "unavailable";
  for (const member of expected.members) member.activity = null;
  result.data = expected;
  success(await call(), expected); oneRpc();
});
test("activity can refer to leads no longer assigned to a member", async () => {
  const expected = snapshot();
  expected.members[3].activity = { updatedEvents: 2, createdEvents: 1, touchedLeads: 3, lastRecordedAt: recent };
  result.data = expected;
  success(await call(), expected); oneRpc();
});
for (const status of ["", "legacy", "pending", "s".repeat(100)]) {
  test(`legacy status string of length ${status.length} remains valid`, async () => {
    const expected = snapshot(); expected.members[2].status = status; result.data = expected;
    success(await call(), expected); oneRpc();
  });
}
test("unknown raw fields at every DTO level are stripped, never echoed or used as identity", async () => {
  const expected = snapshot(), raw: Row = structuredClone(expected);
  for (const value of [raw, raw.period, ...raw.members.flatMap((member: Row) => [member, member.assigned, member.activity])]) {
    Object.assign(value, { phone: privateDetail, notes: privateDetail, email: privateDetail,
      metadata: { privateDetail }, workspace_id: foreign, auth_user_id: id(99), rawRows: [{ privateDetail }] });
  }
  const before = structuredClone(raw);
  result.data = raw;
  const res = await call();
  success(res, expected); oneRpc();
  assert.doesNotMatch(JSON.stringify(res.body), /fixture-private|phone|notes|email|metadata|rawRows|auth_user_id|workspace_id|workspaceId/);
  assert.deepEqual(raw, before, "normalization must not mutate the RPC response");
});
test("staff UUIDs and names normalize without changing member identity or ordering ties", async () => {
  const expected = snapshot(), data: Row = structuredClone(expected);
  expected.members[0].staffId = foreign;
  data.members[0].staffId = foreign.toUpperCase();
  data.members[0].name = "  Admin  ";
  data.members.reverse(); result.data = data;
  success(await call(), expected); oneRpc();
});

for (const role of ["lead_manager", "manager", "receptionist", "doctor", "marketer", "", "OWNER", "unknown"]) {
  test(`role ${JSON.stringify(role)} refuses before obtaining a client`, async () => {
    failure(await call({ role }), 403, "workspace_access_denied"); untouched();
  });
}
for (const purpose of ["clinic_services", "", "unknown", undefined]) {
  test(`purpose ${String(purpose)} refuses before obtaining a client`, async () => {
    failure(await call({ context: { ...verified, purpose } }), 403, "workspace_access_denied"); untouched();
  });
}
test("unattached request identity, role, purpose and headers cannot authorize a call", async () => {
  failure(await call({ context: null, query: verified, body: verified,
    headers: { "x-workspace-id": workspace, "x-staff-user-id": owner, "x-user-id": authUser, "x-workspace-role": "owner" } }),
  403, "workspace_access_denied"); untouched();
});
for (const key of ["workspaceId", "staffUserId", "userId"]) for (const value of ["", "bad", null, undefined, [owner], 42]) {
  test(`malformed context ${key} ${JSON.stringify(value)} refuses before storage`, async () => {
    failure(await call({ context: { ...verified, [key]: value } as Context }), 403, "workspace_access_denied"); untouched();
  });
}
for (const method of ["POST", "PATCH", "PUT", "DELETE", "OPTIONS", "HEAD", "get", ""]) {
  test(`method ${JSON.stringify(method)} refuses before storage`, async () => {
    failure(await call({ method }), 405, "method_not_allowed"); untouched();
  });
}
for (const days of ["", "0", "365", "31", "30x", "07", " 7", "7 ", "7.0", "1e1", "-7", 7, 30, null, ["30"], ["7", "30"], {}, true]) {
  test(`invalid query days ${JSON.stringify(days)} refuses before storage`, async () => {
    failure(await call({ days }), 400, "invalid_period"); untouched();
  });
}

for (const [code, status, publicCode] of [
  ["P7001", 403, "workspace_access_denied"], ["P7008", 503, "timezone_not_configured"], ["P8303", 400, "invalid_period"], ["P8304", 502, "analytics_incomplete"],
  ["PGRST202", 503, undefined], ["42883", 503, undefined],
  ["42P01", 502, undefined], ["XX000", 502, undefined], ["42501", 502, undefined], ["23505", 502, undefined],
] as const) {
  test(`RPC error ${code} maps to safe ${status} without partial data or fallback`, async () => {
    result = { data: { ...snapshot(), privateDetail }, error: { code, message: privateDetail, details: privateDetail, hint: privateDetail } };
    failure(await call(), status, publicCode); oneRpc();
  });
}
test("missing client returns safe 503 without RPC or fallback", async () => {
  setFactory(() => { factoryCalls++; return null; });
  failure(await call(), 503); assert.equal(factoryCalls, 1); assert.deepEqual(calls, []);
});
for (const thrown of [new Error(privateDetail), { message: privateDetail }, privateDetail, null]) {
  test(`thrown RPC ${String(thrown)} returns a safe failure, not zero data`, async () => {
    rpcThrow = thrown;
    failure(await call(), 502); oneRpc();
  });
}

for (const data of [null, undefined, false, true, 3, privateDetail, [], [snapshot()], {},
  { analytics: snapshot() }, { data: { analytics: snapshot() } }]) {
  test(`malformed aggregate root ${JSON.stringify(data)?.slice(0, 70)} fails closed`, async () => {
    result.data = data;
    failure(await call(), 502, "analytics_incomplete"); oneRpc();
  });
}
function replace(data: Row, field: string, value: unknown, remove = false) {
  const keys = field.split(".");
  let parent = data;
  for (const key of keys.slice(0, -1)) parent = parent[key];
  if (remove) delete parent[keys.at(-1)!]; else parent[keys.at(-1)!] = value;
}
const requiredFields = ["workspaceId", "timeZone", "generatedAt", "period", "period.days", "period.from", "period.to", "totalLeads", "unassignedLeads",
  "otherAssigneeLeads", "activityStatus", "members", "members.1.staffId", "members.1.name", "members.1.role", "members.1.status",
  "members.1.assigned", ...Object.keys(emptyAssigned()).map(key => `members.1.assigned.${key}`),
  "members.1.activity", ...Object.keys(emptyActivity()).map(key => `members.1.activity.${key}`)];
test("missing or malformed report zones fail without reading settings separately", async () => {
  for (const zone of [undefined, null, 5, {}, [], "", " UTC ", "Invalid/Zone"]) {
    const data: Row = snapshot(); data.timeZone = zone; result.data = data;
    failure(await call(), 502, "analytics_incomplete");
  }
  assert.equal(calls.length, 8);
  assert.ok(calls.every(call => call.name === "read_lead_team_analytics"));
});
for (const field of requiredFields) {
  test(`missing aggregate field ${field} fails closed without defaults`, async () => {
    const data = snapshot(); replace(data, field, undefined, true); result.data = data;
    failure(await call(), 502, "analytics_incomplete"); oneRpc();
  });
}
const counterFields = ["totalLeads", "unassignedLeads", "otherAssigneeLeads",
  ...Object.keys(emptyAssigned()).map(key => `members.1.assigned.${key}`),
  ...["updatedEvents", "createdEvents", "touchedLeads"].map(key => `members.2.activity.${key}`)];
for (const field of counterFields) for (const value of [-1, 0.5, "1", null, true, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid counter ${field} ${String(value)} is not coerced or clamped`, async () => {
    const data = snapshot(); replace(data, field, value); result.data = data;
    failure(await call(), 502, "analytics_incomplete"); oneRpc();
  });
}
const malformed: [string, (data: Row) => void][] = [
  ["cross-workspace RPC reply", data => { data.workspaceId = foreign; }],
  ["malformed RPC workspace", data => { data.workspaceId = "bad"; }],
  ["non-string RPC workspace", data => { data.workspaceId = [workspace]; }],
  ["null period", data => { data.period = null; }],
  ["array period", data => { data.period = []; }],
  ["null members", data => { data.members = null; }],
  ["object members", data => { data.members = {}; }],
  ["null member after valid members", data => { data.members.push(null); }],
  ["array member", data => { data.members[1] = []; }],
  ["duplicate staff ID", data => { data.members.push(structuredClone(data.members[1])); }],
  ["case-insensitive duplicate staff UUID", data => {
    data.members[1].staffId = workspace; data.members[2].staffId = workspace.toUpperCase();
  }],
  ["invalid staff UUID", data => { data.members[1].staffId = "bad"; }],
  ["null staff UUID", data => { data.members[1].staffId = null; }],
  ["non-string name", data => { data.members[1].name = { privateDetail }; }],
  ["blank name", data => { data.members[1].name = "  "; }],
  ["invalid role", data => { data.members[1].role = "doctor"; }],
  ["null role", data => { data.members[1].role = null; }],
  ["array role", data => { data.members[1].role = ["owner"]; }],
  ["long status", data => { data.members[1].status = "s".repeat(101); }],
  ["null status", data => { data.members[1].status = null; }],
  ["numeric status", data => { data.members[1].status = 0; }],
  ["null assigned", data => { data.members[1].assigned = null; }],
  ["array assigned", data => { data.members[1].assigned = []; }],
  ["null available activity", data => { data.members[1].activity = null; }],
  ["array activity", data => { data.members[1].activity = []; }],
  ["unknown activity status", data => { data.activityStatus = "partial"; }],
  ["null activity status", data => { data.activityStatus = null; }],
  ["array activity status", data => { data.activityStatus = ["available"]; }],
  ["unavailable with zero activity", data => { data.activityStatus = "unavailable"; }],
  ["unavailable with mixed activity", data => {
    data.activityStatus = "unavailable"; data.members[1].activity = null;
  }],
  ["assigned buckets below member total", data => { data.members[1].assigned.new = 0; }],
  ["assigned buckets above member total", data => { data.members[1].assigned.new = 2; }],
  ["overall total too low", data => { data.totalLeads--; }],
  ["overall total too high", data => { data.totalLeads++; }],
  ["unassigned exceeds total", data => { data.unassignedLeads = 11; }],
  ["other-assignee exceeds total", data => { data.otherAssigneeLeads = 11; }],
  ["empty members lose assigned totals", data => { data.members = []; }],
  ["lead cap exceeded with consistent partition", data => {
    data.totalLeads = 20_001; data.members[1].assigned.total = 19_997; data.members[1].assigned.new = 19_992;
  }],
  ["member lead cap exceeded", data => { data.members[1].assigned.total = data.members[1].assigned.new = 20_001; }],
  ["unsafe assigned sum", data => {
    data.members[1].assigned = { ...emptyAssigned(), total: Number.MAX_SAFE_INTEGER, new: Number.MAX_SAFE_INTEGER, lost: 1 };
  }],
  ["unsafe workspace sum", data => { data.totalLeads = data.unassignedLeads = data.otherAssigneeLeads = Number.MAX_SAFE_INTEGER; }],
  ["touched exceeds recorded events", data => { data.members[2].activity.touchedLeads = 4; }],
  ["zero events with touched leads", data => { data.members[1].activity.touchedLeads = 1; }],
  ["events without lastRecordedAt", data => { data.members[2].activity.lastRecordedAt = null; }],
  ["timestamp without events", data => { data.members[1].activity.lastRecordedAt = recent; }],
  ["event counter cap exceeded", data => { data.members[2].activity.updatedEvents = 30_001; }],
  ["per-member event sum exceeds cap", data => { data.members[2].activity.updatedEvents = 30_000; }],
  ["team event sum exceeds cap", data => { data.members[2].activity.updatedEvents = 29_999; }],
  ["unsafe event sum", data => { data.members[2].activity.updatedEvents = Number.MAX_SAFE_INTEGER; }],
  ["null generatedAt", data => { data.generatedAt = null; }],
  ["generatedAt differs from period.to", data => { data.generatedAt = recent; }],
  ["generatedAt differs by one microsecond", data => { data.generatedAt = data.generatedAt.replace('.000Z', '.000001Z'); }],
  ["rolling period shorter by one microsecond", data => { data.period.from = data.period.from.replace('.000Z', '.000001Z'); }],
  ["rolling period longer by one microsecond", data => { data.generatedAt = data.period.to = data.period.to.replace('.000Z', '.000001Z'); }],
  ["period start after end", data => { data.period.from = "2026-10-16T12:00:00.000Z"; }],
  ["wrong rolling duration", data => { data.period.from = "2026-09-16T12:00:00.000Z"; }],
  ["same start and end", data => { data.period.from = data.period.to; }],
  ["unsupported response days", data => { data.period.days = 365; }],
  ["string response days", data => { data.period.days = "30"; }],
  ["response days differ from request", data => { Object.assign(data, snapshot(7)); }],
  ["fractional response days", data => { data.period.days = 30.5; }],
  ["negative response days", data => { data.period.days = -30; }],
  ["recorded activity before period", data => { data.members[2].activity.lastRecordedAt = "2026-09-15T11:59:59.999Z"; }],
  ["recorded activity after period", data => { data.members[2].activity.lastRecordedAt = "2026-10-15T12:00:00.001Z"; }],
];
for (const [label, mutate] of malformed) {
  test(`malformed aggregate: ${label} rejects the whole snapshot`, async () => {
    const data: Row = snapshot(); mutate(data); result.data = { ...data, rawRows: [{ privateDetail }] };
    failure(await call(), 502, "analytics_incomplete"); oneRpc();
  });
}
for (const field of ["generatedAt", "period.from", "period.to", "members.2.activity.lastRecordedAt"]) {
  for (const value of ["not-a-date", "", "2026-10-15", "2026-10-15T12:00:00", "2026-02-30T12:00:00Z", 42]) {
    test(`invalid timestamp ${field} ${String(value)} fails closed`, async () => {
      const data = snapshot(); replace(data, field, value); result.data = data;
      failure(await call(), 502, "analytics_incomplete"); oneRpc();
    });
  }
}
test("RPC timestamps, not the application clock, define the exact period and inclusive activity boundaries", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-20T12:00:00.000Z") });
  const expected = snapshot(7);
  expected.members[2].activity.lastRecordedAt = expected.period.from;
  expected.members[0].activity.lastRecordedAt = expected.period.to;
  result.data = expected;
  success(await call({ days: "7" }), expected); oneRpc(7);
});
test("explicit timezone offsets and PostgreSQL microseconds normalize to ISO instants", async () => {
  const expected = snapshot(), data: Row = structuredClone(expected);
  data.generatedAt = data.period.to = "2026-10-15T17:00:00.000000+05:00";
  data.period.from = "2026-09-15T17:00:00.000000+05:00";
  data.members[2].activity.lastRecordedAt = data.members[0].activity.lastRecordedAt = "2026-10-15T16:59:00.000000+05:00";
  result.data = data;
  success(await call(), expected); oneRpc();
});

test("matching nonzero PostgreSQL microseconds are valid before ISO millisecond normalization", async () => {
  const expected = snapshot(), data: Row = structuredClone(expected);
  for (const field of ["generatedAt", "period.to", "period.from"]) {
    replace(expected, field, field === "period.from" ? "2026-09-15T12:00:00.123Z" : "2026-10-15T12:00:00.123Z");
    replace(data, field, field === "period.from" ? "2026-09-15T17:00:00.123456+05:00" : "2026-10-15T17:00:00.123456+05:00");
  }
  result.data = data; success(await call(), expected); oneRpc();
});
test("DST offset change still requires exactly days times 86,400,000 milliseconds", async () => {
  const data: Row = snapshot(7);
  data.generatedAt = data.period.to = "2026-11-02T12:00:00-05:00";
  data.period.from = "2026-10-26T12:00:00-04:00";
  data.members[0].activity.lastRecordedAt = data.members[2].activity.lastRecordedAt = data.period.to;
  result.data = data;
  failure(await call({ days: "7" }), 502, "analytics_incomplete"); oneRpc(7);
});
test("calendar rollover is rejected even when normalized dates would form a plausible 30-day period", async () => {
  const data: Row = snapshot();
  data.generatedAt = data.period.to = "2026-02-30T12:00:00Z";
  data.period.from = "2026-01-31T12:00:00Z";
  data.members[0].activity.lastRecordedAt = data.members[2].activity.lastRecordedAt = "2026-02-01T12:00:00Z";
  result.data = data;
  failure(await call(), 502, "analytics_incomplete"); oneRpc();
});

test("authorization registry and mortgage policy admit only owner/admin GET", () => {
  const route = resolveCrmRoute(["lead-team-analytics"]);
  assert.deepEqual(route?.authorization.roles, ["owner", "admin"]);
  assert.deepEqual(route?.authorization.methods, ["GET"]);
  for (const role of ["owner", "admin"]) assert.equal(mortgageRouteAllowed(role, "lead-team-analytics", "GET"), true);
  for (const role of ["lead_manager", "manager", "doctor"]) assert.equal(mortgageRouteAllowed(role, "lead-team-analytics", "GET"), false);
  assert.equal(mortgageRouteAllowed("owner", "lead-team-analytics", "POST"), false);
  untouched();
});
test("real catch-all rechecks account, role, revocation, purpose and foreign selector before analytics RPC", async () => {
  const env = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY };
  const fetchBefore = globalThis.fetch;
  let actor = authUser, role = "owner", active = true, purpose = "mortgage_leads", authStatus = 200, authCalls = 0;
  const authQueries: Row[] = [];
  // Only router authorization is stubbed here. No lead/stage/audit row fixtures.
  setFactory(() => {
    factoryCalls++;
    const client = rpcClient();
    return new Proxy(client, { get(target, key) {
      if (key !== "from") return Reflect.get(target, key);
      return (table: string) => {
        if (!["staff_users", "workspace_settings"].includes(table)) {
          forbiddenCalls.push(table); throw new Error("No analytics table fallback");
        }
        const query: Row = { table, filters: [] }; authQueries.push(query);
        const builder: Row = {
          select(columns: string) { query.columns = columns; return builder; },
          eq(name: string, value: unknown) { query.filters.push(["eq", name, value]); return builder; },
          in(name: string, value: unknown) { query.filters.push(["in", name, value]); return builder; },
          then(resolve: (value: unknown) => unknown) {
            if (table === "staff_users") {
              assert.deepEqual(query.filters, [["eq", "auth_user_id", actor], ["eq", "status", "active"]]);
              assert.equal(query.columns, "id, workspace_id, role, status");
              return Promise.resolve({ data: active ? [{ id: owner, workspace_id: workspace, role, status: "active" }] : [], error: null }).then(resolve);
            }
            assert.deepEqual(query.filters, [["in", "workspace_id", [workspace]], ["eq", "key", "workspace_purpose"]]);
            assert.equal(query.columns, "workspace_id, value");
            return Promise.resolve({ data: [{ workspace_id: workspace, value: { purpose } }], error: null }).then(resolve);
          },
        };
        return builder;
      };
    } });
  });
  process.env.SUPABASE_URL = "https://local.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "local-fixture-only";
  globalThis.fetch = (async (url: unknown) => {
    assert.equal(String(url), "https://local.example.test/auth/v1/user");
    authCalls++;
    return { ok: authStatus === 200, status: authStatus, text: async () => JSON.stringify({ id: actor }) };
  }) as typeof fetch;
  try {
    const router = await load("api/crm/[...path].ts");
    const run = async (selector = workspace, token = true) => {
      calls.length = 0; authQueries.length = 0;
      const res = response();
      await router.default({ method: "GET", headers: token ? { authorization: "Bearer local.fixture.token" } : {},
        query: { path: ["lead-team-analytics"], workspaceId: selector, staffUserId: id(99), userId: id(98) },
        body: { workspaceId: foreign, staffUserId: id(97), userId: id(96) } }, res);
      return res;
    };
    const denied = async (status = 403, selector = workspace) => {
      failure(await run(selector), status);
      assert.deepEqual(calls, [], "router refusal must never reach analytics RPC");
    };
    success(await run(), snapshot());
    assert.deepEqual(calls, [{ name: "read_lead_team_analytics", args: { ...scope, p_days: 30 } }]);
    role = "lead_manager"; await denied();
    assert.deepEqual(authQueries.map(query => query.table), ["staff_users"]);
    role = "owner"; active = false; await denied();
    assert.deepEqual(authQueries.map(query => query.table), ["staff_users"]);
    active = true; await denied(403, foreign);
    assert.deepEqual(authQueries.map(query => query.table), ["staff_users"]);
    purpose = "clinic_services"; await denied();
    purpose = "mortgage_leads"; actor = id(82);
    success(await run(), snapshot());
    assert.deepEqual(calls, [{ name: "read_lead_team_analytics", args: { ...scope, p_auth_user_id: actor, p_days: 30 } }]);
    authStatus = 401; await denied(401);
    const priorAuthCalls = authCalls;
    failure(await run(workspace, false), 401);
    assert.equal(authCalls, priorAuthCalls); assert.deepEqual(authQueries, []); assert.deepEqual(calls, []);
    assert.equal(authCalls, 7, "identity is revalidated for every authenticated request");
  } finally {
    globalThis.fetch = fetchBefore;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test, { after, afterEach, before, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const load = (file: string) => import(pathToFileURL(path.join(root, file)).href);
type Row = Record<string, unknown>;
type Context = {
  workspaceId: string; staffUserId: string; userId: string;
  purpose?: string; role: string; permissions: string[];
};
type Request = { method?: string; query: Row; body?: unknown; headers: Row };
type Response = {
  statusCode: number; body: Row; headers: Record<string, unknown>;
  status(code: number): Response; json(body: Row): Response;
  setHeader(name: string, value: unknown): Response;
};
type RpcResult = { data: unknown; error: Row | null };
type RpcCall = { name: string; args: Row };
type MortgageModule = {
  validateMortgageActivity(body: unknown, method: string): Row | null;
  handleMortgageWorkspace(req: Request, res: Response): Promise<unknown>;
};

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const workspaceId = id(1), staffUserId = id(2), userId = id(3), leadId = id(4);
const requestId = id(5), activityId = id(6), foreignId = id(99);
const startsAt = "2026-10-15T09:00:00+05:00";
const endsAt = "2026-10-15T09:30:00+05:00";
const expectedUpdatedAt = "2026-10-14T12:00:00.123Z";
const verified: Context = { workspaceId, staffUserId, userId, purpose: "mortgage_leads", role: "owner", permissions: [] };
const task = (changes: Row = {}) => ({ requestId, kind: "task", leadId, title: "Call client", ...changes });
const meeting = (changes: Row = {}) => ({ ...task(), kind: "meeting", startsAt, endsAt, ...changes });
const patch = (changes: Row = {}) => {
  const { requestId: _requestId, ...draft } = task();
  return { ...draft, id: activityId, expectedUpdatedAt, ...changes };
};
const canonicalTask = {
  kind: "task", leadId, title: "Call client", notes: "", status: "open", priority: "normal",
  startsAt: null, endsAt: null, dueAt: null,
};
const scope = { p_workspace_id: workspaceId, p_staff_user_id: staffUserId, p_auth_user_id: userId };
const privateDetail = "fixture-private: mortgage_activities SQL SELECT internal_column service_role";
const snapshot = () => ({
  generatedAt: "2026-10-20T12:00:00.123456Z", period: { days: 30, from: "2026-09-20T12:00:00.123456Z", to: "2026-10-20T12:00:00.123456Z" },
  timeZone: "Asia/Qyzylorda", contacts: [{
    id: leadId, name: "Offline client", phone: "", notes: "", status: "new", source: "manual",
    createdAt: expectedUpdatedAt, updatedAt: expectedUpdatedAt, responsibleUserId: staffUserId,
    responsibleName: "Offline manager",
  }], contactsTotal: 1, activities: [], activitiesTruncated: false,
  members: [{ id: staffUserId, name: "Offline manager", role: "lead_manager", status: "active" }], events: [],
  metrics: { totalLeads: 1, unassignedLeads: 0, inProgressLeads: 0, meetingsToday: 0, overdueTasks: 0, activeManagers: 1 },
  memberMetrics: [], periodDays: 30, page: 0, pageSize: 50,
});

let mortgage: MortgageModule;
let attachWorkspaceContext: (req: Request, context: Context) => void;
let setFactory: (factory: (() => unknown) | null) => void;
let rpcCalls: RpcCall[] = [];
let result: RpcResult;
let rpcThrow: unknown;
let factoryCalls = 0;
let directCalls = 0;
let fetchCalls = 0;
const originalFetch = globalThis.fetch;

before(async () => {
  // Install before source imports; no environment, credentials, Auth or network fixtures.
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("Offline mortgage tests forbid fetch");
  }) as typeof fetch;
  ({ setSupabaseServerClientFactoryForTests: setFactory } = await load("lib/supabase/server.ts"));
  ({ attachWorkspaceContext } = await load("lib/crm/server.ts"));
  mortgage = await load("lib/crm/mortgage-workspace.ts") as MortgageModule;
});

beforeEach(() => {
  rpcCalls = []; factoryCalls = 0; directCalls = 0; rpcThrow = undefined;
  result = { data: snapshot(), error: null };
  setFactory(() => {
    factoryCalls++;
    return new Proxy({
      async rpc(name: string, args: Row) {
        rpcCalls.push({ name, args: structuredClone(args) });
        if (rpcThrow !== undefined) throw rpcThrow;
        return result;
      },
    }, {
      get(target, key, receiver) {
        if (key === "rpc") return Reflect.get(target, key, receiver);
        directCalls++;
        throw new Error(`Only the mortgage RPC layer is permitted, not ${String(key)}`);
      },
    });
  });
});

afterEach(() => {
  try {
    assert.equal(fetchCalls, 0, "global fetch attempts must stay zero, including handled failures");
    assert.equal(directCalls, 0, "no direct SQL/table/browser fallback is permitted");
  } finally { setFactory(null); }
});

after(() => {
  globalThis.fetch = originalFetch;
  setFactory?.(null);
  assert.equal(fetchCalls, 0, "entire offline suite made zero fetch calls");
});

function response(): Response {
  return {
    statusCode: 0, body: {}, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
  };
}

async function call(options: { method?: string; query?: Row; body?: unknown; context?: Context | null; headers?: Row } = {}) {
  const req: Request = {
    method: options.method ?? "GET", query: options.query ?? {}, body: options.body,
    headers: options.headers ?? {},
  };
  // This is the real post-route-guard attachment, not simulated membership validation.
  if (options.context !== null) attachWorkspaceContext(req, options.context ?? verified);
  const res = response();
  await mortgage.handleMortgageWorkspace(req, res);
  assert.equal(res.headers["cache-control"], "private, no-store");
  return res;
}

function failure(res: Response, status: number, code?: string) {
  assert.equal(res.statusCode, status, JSON.stringify(res.body));
  assert.equal(res.body.success, false);
  assert.equal(typeof res.body.error, "string");
  assert.ok(res.body.error);
  if (code !== undefined) assert.equal(res.body.code, code);
  assert.equal("data" in res.body, false);
  assert.equal("details" in res.body, false);
  assert.equal("hint" in res.body, false);
  assert.doesNotMatch(JSON.stringify(res.body), /fixture-private|mortgage_activities|internal_column|service_role|SELECT/);
}

function untouched() {
  assert.equal(factoryCalls, 0, "denials and invalid input must not obtain a storage client");
  assert.deepEqual(rpcCalls, []);
}

test("validator returns only canonical shared-contract activity fields without mutating the draft", () => {
  const draft = task({ title: "  Call client  ", notes: "  Follow up  ", priority: "high", dueAt: startsAt });
  const before = structuredClone(draft);
  assert.deepEqual(mortgage.validateMortgageActivity(draft, "POST"), {
    ...canonicalTask, notes: "Follow up", priority: "high", dueAt: startsAt,
  });
  assert.deepEqual(draft, before);
  assert.deepEqual(mortgage.validateMortgageActivity(meeting(), "POST"), {
    ...canonicalTask, kind: "meeting", startsAt, endsAt,
  });
});

for (const [label, body] of [
  ["null", null], ["array", [task()]], ["string", JSON.stringify(task())],
  ["missing kind", task({ kind: undefined })], ["unsupported kind", task({ kind: "appointment" })],
  ["padded meeting kind", task({ kind: " meeting " })], ["padded task kind", task({ kind: " task " })],
  ["object kind", task({ kind: { value: "task" } })], ["unknown key", task({ extra: true })],
  ["blank title", task({ title: "  " })], ["nonstring title", task({ title: 123 })],
  ["oversized title", task({ title: "x".repeat(201) })], ["nonstring notes", task({ notes: {} })],
  ["oversized notes", task({ notes: "x".repeat(10001) })], ["invalid priority", task({ priority: "urgent" })],
] as [string, unknown][]) {
  test(`validator rejects ${label}`, () => {
    assert.equal(mortgage.validateMortgageActivity(body, "POST"), null);
  });
}

test("validator accepts bounded title/notes and each contract priority", () => {
  for (const priority of ["low", "normal", "high"]) {
    const value = mortgage.validateMortgageActivity(task({ title: "x".repeat(200), notes: "n".repeat(10000), priority }), "POST");
    assert.ok(value);
    assert.equal(value.priority, priority);
    assert.equal(String(value.title).length, 200);
    assert.equal(String(value.notes).length, 10000);
  }
});

for (const key of [
  "workspaceId", "workspace_id", "staffUserId", "staff_user_id", "userId", "authUserId", "auth_user_id",
  "actorId", "actorStaffUserId", "actor_staff_user_id", "responsibleUserId", "responsible_user_id", "role", "purpose",
]) {
  test(`validator and handler reject caller authority injection through ${key}`, async () => {
    for (const method of ["POST", "PATCH"]) {
      const body = method === "POST" ? task({ [key]: foreignId }) : patch({ [key]: foreignId });
      assert.equal(mortgage.validateMortgageActivity(body, method), null);
      failure(await call({ method, body }), 400, "invalid_activity");
    }
    untouched();
  });
}

for (const [label, value] of [
  ["missing", undefined], ["malformed", "not-a-uuid"], ["nil", "00000000-0000-0000-0000-000000000000"],
  ["invalid variant", "00000000-0000-4000-0000-000000000004"], ["array", [leadId]], ["number", 4],
] as [string, unknown][]) {
  test(`validator rejects ${label} lead and request UUIDs`, () => {
    assert.equal(mortgage.validateMortgageActivity(task({ leadId: value }), "POST"), null);
    assert.equal(mortgage.validateMortgageActivity(task({ requestId: value }), "POST"), null);
    assert.equal(mortgage.validateMortgageActivity(patch({ id: value }), "PATCH"), null);
  });
}

for (const status of ["open", "in_progress", "done", "cancelled"]) {
  test(`task accepts contract status ${status}`, () => {
    assert.equal(mortgage.validateMortgageActivity(task({ status }), "POST")?.status, status);
  });
}
for (const status of ["open", "done", "cancelled", "missed"]) {
  test(`meeting accepts contract status ${status}`, () => {
    assert.equal(mortgage.validateMortgageActivity(meeting({ status }), "POST")?.status, status);
  });
}
test("activity status sets do not admit cross-kind or unknown statuses", () => {
  for (const status of ["missed", "completed", "constructor"]) {
    assert.equal(mortgage.validateMortgageActivity(task({ status }), "POST"), null, String(status));
  }
  for (const status of ["in_progress", "completed", "constructor"]) {
    assert.equal(mortgage.validateMortgageActivity(meeting({ status }), "POST"), null, status);
  }
});
for (const [label, status] of [["number", 1], ["array", ["done"]], ["object", {}], ["boolean", false], ["null", null]] as [string, unknown][]) {
  test(`validator rejects ${label} status rather than silently defaulting it to open`, () => {
    assert.equal(mortgage.validateMortgageActivity(task({ status }), "POST"), null, "task status");
    assert.equal(mortgage.validateMortgageActivity(meeting({ status }), "POST"), null, "meeting status");
  });
}

for (const instant of ["2026-10-15T04:00:00Z", startsAt, "2026-10-14T23:00:00-05:00", "2028-02-29T09:00:00+05:00"]) {
  test(`validator accepts explicit-offset valid instant ${instant}`, () => {
    assert.equal(mortgage.validateMortgageActivity(task({ dueAt: instant }), "POST")?.dueAt, instant);
    assert.ok(mortgage.validateMortgageActivity(patch({ expectedUpdatedAt: instant }), "PATCH"));
  });
}

for (const [label, value] of [
  ["offset-free local time", "2026-10-15T09:00:00"], ["date only", "2026-10-15"],
  ["invalid month", "2026-13-15T09:00:00Z"], ["invalid offset", "2026-10-15T09:00:00+25:00"],
  ["non-leap February 29", "2026-02-29T09:00:00Z"], ["February 30", "2026-02-30T09:00:00+05:00"],
  ["April 31", "2026-04-31T09:00:00Z"], ["hour 24", "2026-10-15T24:00:00Z"],
  ["numeric timestamp", 1792036800000], ["array timestamp", [startsAt]],
] as [string, unknown][]) {
  test(`validator rejects ${label} for dueAt, meeting bounds and PATCH version`, () => {
    assert.equal(mortgage.validateMortgageActivity(task({ dueAt: value }), "POST"), null, "dueAt");
    assert.equal(mortgage.validateMortgageActivity(meeting({ startsAt: value }), "POST"), null, "startsAt");
    assert.equal(mortgage.validateMortgageActivity(meeting({ endsAt: value }), "POST"), null, "endsAt");
    assert.equal(mortgage.validateMortgageActivity(patch({ expectedUpdatedAt: value }), "PATCH"), null, "expectedUpdatedAt");
  });
}

for (const [minutes, valid] of [[5, true], [1440, true], [4, false], [1441, false], [0, false], [-5, false]] as const) {
  test(`meeting duration ${minutes} minutes is ${valid ? "accepted" : "rejected"}`, () => {
    const body = meeting({ endsAt: new Date(Date.parse(startsAt) + minutes * 60000).toISOString() });
    const value = mortgage.validateMortgageActivity(body, "POST");
    if (valid) assert.ok(value); else assert.equal(value, null);
  });
}
test("meeting duration uses instants across offsets and rejects sub-five-minute precision", () => {
  assert.ok(mortgage.validateMortgageActivity(meeting({ endsAt: "2026-10-14T23:05:00-05:00" }), "POST"));
  assert.equal(mortgage.validateMortgageActivity(meeting({ endsAt: "2026-10-15T04:04:59.999Z" }), "POST"), null);
  assert.equal(mortgage.validateMortgageActivity(meeting({ endsAt: "2026-10-16T04:00:00.001Z" }), "POST"), null);
});
test("kind-specific dates cannot be mixed and meetings require both endpoints", () => {
  for (const body of [meeting({ startsAt: undefined }), meeting({ endsAt: null }), meeting({ dueAt: startsAt }),
    task({ startsAt }), task({ endsAt })]) {
    assert.equal(mortgage.validateMortgageActivity(body, "POST"), null);
  }
  assert.deepEqual(mortgage.validateMortgageActivity(task({ dueAt: null, startsAt: null, endsAt: null }), "POST"), canonicalTask);
});
test("POST requires a supplied stable requestId and forbids PATCH identity/version fields", () => {
  for (const body of [task({ requestId: undefined }), task({ id: activityId }), task({ expectedUpdatedAt })]) {
    assert.equal(mortgage.validateMortgageActivity(body, "POST"), null);
  }
  assert.deepEqual(mortgage.validateMortgageActivity(task(), "POST"), mortgage.validateMortgageActivity(task(), "POST"));
});
test("PATCH requires both UUID id and explicit-offset expectedUpdatedAt", async () => {
  for (const body of [patch({ id: undefined }), patch({ expectedUpdatedAt: undefined }), patch({ expectedUpdatedAt: null }),
    patch({ expectedUpdatedAt: "2026-10-14T12:00:00" })]) {
    assert.equal(mortgage.validateMortgageActivity(body, "PATCH"), null);
    failure(await call({ method: "PATCH", body }), 400, "invalid_activity");
  }
  untouched();
  assert.deepEqual(mortgage.validateMortgageActivity(patch(), "PATCH"), canonicalTask);
});

for (const role of ["owner", "admin", "lead_manager"]) {
  test(`verified mortgage ${role} context can read with only context IDs forwarded`, async () => {
    const res = await call({ context: { ...verified, role }, query: {
      workspaceId: foreignId, staffUserId: foreignId, userId: foreignId, actorId: foreignId,
    } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, mode: "supabase", data: result.data });
    assert.deepEqual(rpcCalls, [{ name: "read_mortgage_workspace", args: {
      ...scope, p_query: "", p_page: 0, p_lead_id: null, p_from: null, p_to: null, p_days: 30,
    } }]);
  });
}

for (const [label, context] of [
  ["unauthenticated", null], ["clinic purpose", { ...verified, purpose: "clinic_services" }],
  ["marketing purpose", { ...verified, purpose: "marketing" }], ["missing purpose", { ...verified, purpose: undefined }],
  ["unsupported manager", { ...verified, role: "manager" }], ["unknown role", { ...verified, role: "constructor" }],
  ["invalid workspace UUID", { ...verified, workspaceId: "not-uuid" }],
  ["invalid staff UUID", { ...verified, staffUserId: "not-uuid" }],
  ["invalid auth UUID", { ...verified, userId: "not-uuid" }],
] as [string, Context | null][]) {
  test(`${label} is denied for all supported methods before storage`, async () => {
    for (const method of ["GET", "POST", "PATCH"]) {
      failure(await call({ context, method, body: method === "PATCH" ? patch() : task() }), 403, "workspace_access_denied");
    }
    untouched();
  });
}
test("caller fields and bearer-looking text cannot supply a verified context", async () => {
  const authority = { ...verified, permissions: ["manage_leads"], status: "active" };
  failure(await call({ context: null, headers: { authorization: "Bearer offline.unverified.value" },
    query: { ...authority, __medinaWorkspaceContext: authority }, body: { ...task(), ...authority } }), 403, "workspace_access_denied");
  untouched();
});

test("GET forwards validated bounded filters and returns the RPC snapshot unchanged", async () => {
  const data = snapshot();
  result = { data, error: null };
  const to = "2027-10-16T09:00:00+05:00";
  const res = await call({ query: { q: "  Offline client  ", page: "100000", days: "90", leadId, from: startsAt, to } });
  assert.deepEqual(rpcCalls, [{ name: "read_mortgage_workspace", args: {
    ...scope, p_query: "Offline client", p_page: 100000, p_lead_id: leadId, p_from: startsAt, p_to: to, p_days: 90,
  } }]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, mode: "supabase", data });
});
test("GET accepts each allowed period, search boundary, and a single date bound", async () => {
  for (const days of [7, 30, 90]) {
    assert.equal((await call({ query: { q: "q".repeat(100), days: String(days), from: startsAt } })).statusCode, 200);
    assert.equal(rpcCalls.at(-1)?.args.p_days, days);
    assert.equal(rpcCalls.at(-1)?.args.p_to, null);
  }
  assert.equal((await call({ query: { to: endsAt } })).statusCode, 200);
  assert.equal(rpcCalls.at(-1)?.args.p_from, null);
});

for (const [label, query] of [
  ["oversized search", { q: "q".repeat(101) }], ["negative page", { page: "-1" }],
  ["fractional page", { page: "0.5" }], ["unbounded page", { page: "100001" }],
  ["nonnumeric page", { page: "NaN" }], ["infinite page", { page: "Infinity" }],
  ["unlisted period", { days: "14" }], ["zero period", { days: "0" }],
  ["invalid lead UUID", { leadId: "not-a-uuid" }], ["offset-free from", { from: "2026-10-15T09:00:00" }],
  ["invalid to", { to: "not-a-date" }], ["empty from", { from: "" }],
  ["reversed range", { from: endsAt, to: startsAt }], ["empty range", { from: startsAt, to: startsAt }],
  ["over-366-day range", { from: startsAt, to: "2027-10-16T09:00:00.001+05:00" }],
  ["impossible calendar date", { from: "2026-02-30T09:00:00Z" }],
  ["repeated search", { q: ["first", "second"] }], ["repeated lead filter", { leadId: [leadId, foreignId] }],
  ["array page", { page: ["1"] }], ["array period", { days: ["30"] }],
] as [string, Row][]) {
  test(`GET rejects ${label} before RPC`, async () => {
    failure(await call({ query }), 400, "invalid_filter");
    untouched();
  });
}

test("POST forwards canonical payload and the unchanged caller requestId on retry", async () => {
  const data = { activity: { id: activityId, ...canonicalTask }, replayed: false };
  result = { data, error: null };
  const body = task({ title: "  Call client  ", notes: "  Follow up  " });
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await call({ method: "POST", body, query: { workspaceId: foreignId, actorId: foreignId } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, mode: "supabase", data });
  }
  const expected = { name: "save_mortgage_activity", args: {
    ...scope, p_activity_id: null, p_expected_updated_at: null, p_request_id: requestId,
    p_payload: { ...canonicalTask, notes: "Follow up" },
  } };
  assert.deepEqual(rpcCalls, [expected, expected]);
  assert.equal(body.requestId, requestId);
  // This checks transport stability, not database idempotency or authorization guarantees.
});
test("POST meeting uses only save_mortgage_activity with the canonical meeting payload", async () => {
  const body = meeting({ status: "done", priority: "high" });
  assert.equal((await call({ method: "POST", body })).statusCode, 200);
  assert.deepEqual(rpcCalls, [{ name: "save_mortgage_activity", args: {
    ...scope, p_activity_id: null, p_expected_updated_at: null, p_request_id: requestId,
    p_payload: { ...canonicalTask, kind: "meeting", startsAt, endsAt, status: "done", priority: "high" },
  } }]);
});
test("PATCH forwards id/version separately from canonical payload and uses verified actor IDs", async () => {
  const body = patch({ title: "  Call client  ", status: "in_progress", dueAt: endsAt });
  assert.equal((await call({ method: "PATCH", body, query: {
    workspaceId: foreignId, staffUserId: foreignId, authUserId: foreignId,
  } })).statusCode, 200);
  assert.deepEqual(rpcCalls, [{ name: "save_mortgage_activity", args: {
    ...scope, p_activity_id: activityId, p_expected_updated_at: expectedUpdatedAt, p_request_id: null,
    p_payload: { ...canonicalTask, status: "in_progress", dueAt: endsAt },
  } }]);
});

// These are HTTP mappings only. PostgreSQL tests own revocation, assignment and concurrency enforcement.
const mappedErrors: [string, number, string][] = [
  ["P7001", 403, "workspace_access_denied"], ["P7002", 404, "resource_not_found"],
  ["P7003", 400, "invalid_activity"], ["P7004", 409, "meeting_conflict"],
  ["P7005", 409, "activity_changed"], ["P7006", 409, "lead_requires_assignment"],
  ["P7007", 409, "request_conflict"], ["P7008", 503, "timezone_not_configured"],
  ...["PGRST202", "42883", "42P01"].map((code): [string, number, string] => [code, 503, "schema_not_ready"]),
];
for (const [dbCode, status, code] of mappedErrors) {
  test(`RPC ${dbCode} maps to ${status}/${code} without leaking database details`, async () => {
    result = { data: null, error: { code: dbCode, message: privateDetail, details: privateDetail, hint: privateDetail } };
    for (const method of ["GET", "POST", "PATCH"]) {
      failure(await call({ method, body: method === "PATCH" ? patch() : task() }), status, code);
    }
    assert.equal(rpcCalls.length, 3);
  });
}
test("unknown RPC failures fail closed with the same generic public error", async () => {
  const bodies: Row[] = [];
  for (const code of ["XX000", "23505", undefined]) {
    result = { data: null, error: { code, message: privateDetail, details: privateDetail, hint: privateDetail } };
    const res = await call();
    failure(res, 502, "mortgage_unavailable"); bodies.push(res.body);
  }
  assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(bodies[1], bodies[2]);
});
test("thrown RPC exceptions never expose database details or attempt a fallback", async () => {
  rpcThrow = new Error(privateDetail);
  for (const method of ["GET", "POST", "PATCH"]) {
    failure(await call({ method, body: method === "PATCH" ? patch() : task() }), 502, "mortgage_unavailable");
  }
  assert.equal(rpcCalls.length, 3);
});
for (const [label, data] of [["null", null], ["array", []], ["string", privateDetail], ["number", 42], ["boolean", true]] as [string, unknown][]) {
  test(`malformed ${label} RPC data fails closed, not as empty success`, async () => {
    result = { data, error: null };
    failure(await call(), 502);
    assert.equal(rpcCalls.length, 1);
  });
}
test("missing storage is an explicit 503, never mock or browser data", async () => {
  setFactory(() => { factoryCalls++; return null; });
  for (const method of ["GET", "POST", "PATCH"]) {
    failure(await call({ method, body: method === "PATCH" ? patch() : task() }), 503, "storage_not_configured");
  }
  assert.deepEqual(rpcCalls, []);
});
for (const method of ["PUT", "DELETE", "HEAD", "OPTIONS", "TRACE"]) {
  test(`${method} is rejected without obtaining storage`, async () => {
    failure(await call({ method, body: task() }), 405);
    untouched();
  });
}
test("browser mortgage transport has no direct table/RPC/SQL fallback", async () => {
  const source = await readFile(path.join(root, "artifacts/negis/src/lib/mortgage-workspace.tsx"), "utf8");
  assert.doesNotMatch(source, /\.(?:from|rpc|schema)\s*\(/);
  assert.doesNotMatch(source, /\b(?:read_mortgage_workspace|save_mortgage_activity)\b/);
});

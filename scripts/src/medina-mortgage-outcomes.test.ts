import assert from "node:assert/strict";
import path from "node:path";
import test, { after, afterEach, before, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const load = (file: string) => import(pathToFileURL(path.join(root, file)).href);
type Row = Record<string, unknown>;
type Context = { workspaceId: string; staffUserId: string; userId: string; role: string; purpose?: string; permissions: string[] };
type Request = { method?: string; query: Row; body?: unknown; headers: Row };
type Response = {
  statusCode: number; body: Row; headers: Row;
  status(code: number): Response; json(body: Row): Response; setHeader(name: string, value: unknown): Response;
};
type Outcomes = {
  handleMortgageOutcomes(req: Request, res: Response, resource: "contracts" | "results"): Promise<unknown>;
  validateMortgageContract(body: unknown, method: string): Row | null;
};
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const workspaceId = id(1), staffUserId = id(2), userId = id(3), leadId = id(4), requestId = id(5), contractId = id(6);
const verified: Context = { workspaceId, staffUserId, userId, role: "owner", purpose: "mortgage_leads", permissions: [] };
const scope = { p_workspace_id: workspaceId, p_staff_user_id: staffUserId, p_auth_user_id: userId };
const signedAt = "2026-10-15T09:00:00.123456+05:00", canonicalTime = "2026-10-15T04:00:00.123Z";
const draft = (changes: Row = {}) => ({ leadId, requestId, signedAt, reference: "  Synthetic reference  ", ...changes });
const correction = (changes: Row = {}) => ({ leadId, requestId, id: contractId, reason: "  Duplicate synthetic record  ", ...changes });
const privateDetail = "fixture-private: SELECT mortgage_signed_contracts internal_column service_role";
let outcomes: Outcomes;
let attach: (req: Request, context: Context) => void;
let setFactory: (factory: (() => unknown) | null) => void;
let calls: { name: string; args: Row }[] = [];
let result: { data: unknown; error: Row | null };
let rpcThrow: unknown;
let factoryCalls = 0, directCalls = 0, fetchCalls = 0;
const originalFetch = globalThis.fetch;

before(async () => {
  // Install before source imports. No environment, Auth, browser or provider fixture.
  globalThis.fetch = (async () => { fetchCalls++; throw new Error("Offline outcome tests forbid fetch"); }) as typeof fetch;
  ({ setSupabaseServerClientFactoryForTests: setFactory } = await load("lib/supabase/server.ts"));
  ({ attachWorkspaceContext: attach } = await load("lib/crm/server.ts"));
  outcomes = await load("lib/crm/mortgage-outcomes.ts") as Outcomes;
});
beforeEach(() => {
  calls = []; factoryCalls = 0; directCalls = 0; rpcThrow = undefined;
  result = { data: { id: contractId, replayed: false }, error: null };
  setFactory(() => {
    factoryCalls++;
    return new Proxy({ async rpc(name: string, args: Row) {
      calls.push({ name, args: structuredClone(args) });
      if (rpcThrow !== undefined) throw rpcThrow;
      return result;
    } }, { get(target, key, receiver) {
      if (key === "rpc") return Reflect.get(target, key, receiver);
      directCalls++;
      throw new Error(`Only client.rpc may be used, not ${String(key)}`);
    } });
  });
});
afterEach(() => {
  try {
    assert.equal(fetchCalls, 0, "no network attempts, even swallowed ones");
    assert.equal(directCalls, 0, "no table/auth/provider fallback");
  } finally { setFactory(null); }
});
after(() => { globalThis.fetch = originalFetch; setFactory?.(null); });

async function call(options: {
  resource?: "contracts" | "results"; method?: string; body?: unknown; query?: Row;
  context?: Context | null; headers?: Row;
} = {}) {
  const req: Request = { method: options.method, query: options.query ?? { leadId }, body: options.body, headers: options.headers ?? {} };
  if (options.context !== null) attach(req, options.context ?? verified);
  const res: Response = {
    statusCode: 0, body: {}, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
  };
  await outcomes.handleMortgageOutcomes(req, res, options.resource ?? "contracts");
  assert.equal(res.headers["cache-control"], "private, no-store");
  return res;
}
function failure(res: Response, status: number, code: string) {
  assert.equal(res.statusCode, status, JSON.stringify(res.body));
  assert.equal(res.body.success, false); assert.equal(res.body.code, code);
  assert.deepEqual(Object.keys(res.body).sort(), status === 405 ? ["code", "success"] : ["code", "error", "success"]);
  assert.doesNotMatch(JSON.stringify(res.body), /fixture-private|SELECT|mortgage_signed_contracts|internal_column|service_role/);
}
function untouched() { assert.equal(factoryCalls, 0); assert.deepEqual(calls, []); }

test("POST validator canonicalizes timestamp/reference, preserves input, and returns only contract fields", () => {
  const input = draft(), before = structuredClone(input);
  assert.deepEqual(outcomes.validateMortgageContract(input, "POST"), {
    leadId, requestId, id: null, payload: { signedAt: canonicalTime, reference: "Synthetic reference" },
  });
  assert.deepEqual(input, before);
  assert.deepEqual(outcomes.validateMortgageContract(draft({ reference: "" }), "POST"), {
    leadId, requestId, id: null, payload: { signedAt: canonicalTime, reference: "" },
  });
});
test("PATCH is a reasoned correction, not a payment/refund or signing attribution update", () => {
  const input = correction(), before = structuredClone(input);
  assert.deepEqual(outcomes.validateMortgageContract(input, "PATCH"), {
    leadId, requestId, id: contractId, payload: { reason: "Duplicate synthetic record" },
  });
  assert.deepEqual(input, before);
  for (const method of ["GET", "PUT", "DELETE"]) assert.equal(outcomes.validateMortgageContract(input, method), null);
});

for (const [label, body] of [
  ["null", null], ["array", [draft()]], ["JSON string", JSON.stringify(draft())], ["boolean", true],
  ["empty", {}], ["bad lead", draft({ leadId: "bad" })], ["lead array", draft({ leadId: [leadId] })],
  ["missing request", draft({ requestId: undefined })], ["bad request", draft({ requestId: "bad" })],
  ["numeric reference", draft({ reference: 10 })], ["missing reference", draft({ reference: undefined })],
  ["long reference", draft({ reference: "r".repeat(101) })],
] as [string, unknown][]) test(`POST rejects ${label} before obtaining client`, async () => {
  assert.equal(outcomes.validateMortgageContract(body, "POST"), null);
  failure(await call({ method: "POST", body }), 400, "invalid_contract"); untouched();
});

for (const key of ["amount", "paid", "paidAmount", "paid_amount", "status", "paymentStatus", "refund", "commission",
  "responsibleUserId", "responsible_user_id", "responsibleStaffId", "responsible_staff_user_id", "assigneeId", "recordedByStaffId",
  "workspaceId", "workspace_id", "staffUserId", "staff_user_id", "userId", "auth_user_id", "id", "reason", "unknown"]) {
  test(`POST body whitelist rejects ${key} without partial RPC`, async () => {
    const body = draft({ [key]: id(99) });
    assert.equal(outcomes.validateMortgageContract(body, "POST"), null);
    failure(await call({ method: "POST", body }), 400, "invalid_contract"); untouched();
  });
}
for (const [label, body] of [
  ["no reason", correction({ reason: undefined })], ["blank reason", correction({ reason: "  " })],
  ["null reason", correction({ reason: null })], ["object reason", correction({ reason: {} })],
  ["long reason", correction({ reason: "r".repeat(501) })], ["bad contract", correction({ id: "bad" })],
  ["missing contract", correction({ id: undefined })], ["bad lead", correction({ leadId: null })],
  ["bad request", correction({ requestId: [] })],
  ...["amount", "paid", "status", "responsible_user_id", "assigneeId", "signedAt", "reference", "workspaceId", "staffUserId", "userId"]
    .map(key => [`forbidden ${key}`, correction({ [key]: id(99) })] as [string, unknown]),
] as [string, unknown][]) test(`PATCH rejects ${label} before obtaining client`, async () => {
  assert.equal(outcomes.validateMortgageContract(body, "PATCH"), null);
  failure(await call({ method: "PATCH", body }), 400, "invalid_contract"); untouched();
});

for (const value of ["2026-10-15", "2026-10-15T09:00:00", "2026-02-30T09:00:00Z", "2025-02-29T09:00:00Z",
  "2026-13-01T09:00:00Z", "2026-10-15T24:00:00Z", "2026-10-15T09:60:00Z", "2026-10-15T09:00:60Z",
  "2026-10-15T09:00:00+24:00", "2026-10-15T09:00:00+05:60", "2026-10-15T09:00:00.1234567Z",
  "infinity", "not-a-date", 42, null]) test(`POST rejects invalid timestamp ${String(value)}`, async () => {
  failure(await call({ method: "POST", body: draft({ signedAt: value }) }), 400, "invalid_contract"); untouched();
});
for (const value of ["2024-02-29T09:00:00Z", "2026-10-15T09:00:00-03:30", signedAt]) {
  test(`POST accepts explicit instant ${value}`, async () => {
    const res = await call({ method: "POST", body: draft({ signedAt: value }) });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, [{ name: "save_mortgage_contract", args: { ...scope,
      p_lead_id: leadId, p_contract_id: null, p_request_id: requestId,
      p_payload: { signedAt: new Date(value).toISOString(), reference: "Synthetic reference" },
    } }]);
  });
}

for (const role of ["owner", "admin", "lead_manager"]) {
  test(`${role} contract GET/POST use only verified context IDs, never spoofed query/body identities`, async () => {
    const context = { ...verified, role }, query = { leadId, workspaceId: id(91), staffUserId: id(92), userId: id(93),
      p_workspace_id: id(94), p_staff_user_id: id(95), p_auth_user_id: id(96) };
    result.data = { records: [], truncated: false };
    assert.deepEqual((await call({ context, query, body: { workspaceId: id(97), staffUserId: id(98), userId: id(99) } })).body,
      { success: true, mode: "supabase", data: result.data });
    assert.deepEqual(calls, [{ name: "read_mortgage_contracts", args: { ...scope, p_lead_id: leadId } }]);
    calls = [];
    result.data = { id: contractId, replayed: true };
    const body = draft(), before = structuredClone(body);
    assert.equal((await call({ method: "POST", context, query, body })).statusCode, 200);
    assert.deepEqual(body, before);
    assert.deepEqual(calls, [{ name: "save_mortgage_contract", args: { ...scope, p_lead_id: leadId,
      p_contract_id: null, p_request_id: requestId, p_payload: { signedAt: canonicalTime, reference: "Synthetic reference" },
    } }]);
  });
}
for (const role of ["owner", "admin"]) test(`${role} PATCH sends only correction reason and context identity`, async () => {
  assert.equal((await call({ method: "PATCH", context: { ...verified, role }, body: correction(), query: { workspaceId: id(99) } })).statusCode, 200);
  assert.deepEqual(calls, [{ name: "save_mortgage_contract", args: { ...scope, p_lead_id: leadId,
    p_contract_id: contractId, p_request_id: requestId, p_payload: { reason: "Duplicate synthetic record" },
  } }]);
});
test("lead manager cannot correct or view team results even with owner-like permissions", async () => {
  const context = { ...verified, role: "lead_manager", permissions: ["manage_staff", "view_analytics"] };
  failure(await call({ context, method: "PATCH", body: correction() }), 403, "workspace_access_denied");
  failure(await call({ context, resource: "results" }), 403, "workspace_access_denied"); untouched();
});
for (const role of ["manager", "doctor", "operator", "receptionist", "marketer", "master", "unknown", ""]) {
  test(`${role || "empty role"} cannot access either outcome resource`, async () => {
    for (const resource of ["contracts", "results"] as const) for (const method of ["GET", "POST", "PATCH"]) {
      failure(await call({ resource, method, context: { ...verified, role }, body: draft() }), 403, "workspace_access_denied");
    }
    untouched();
  });
}
for (const purpose of [undefined, "", "clinic_services", "salon_services", "unknown"]) test(`purpose ${String(purpose)} denies before storage`, async () => {
  for (const resource of ["contracts", "results"] as const) {
    failure(await call({ resource, context: { ...verified, purpose } }), 403, "workspace_access_denied");
  }
  untouched();
});
test("no attached context cannot be replaced by request IDs, purpose, role or headers", async () => {
  failure(await call({ context: null, query: { ...verified, leadId }, body: verified,
    headers: { "x-workspace-id": workspaceId, "x-staff-user-id": staffUserId, "x-user-id": userId, "x-workspace-role": "owner" } }),
  403, "workspace_access_denied"); untouched();
});
for (const key of ["workspaceId", "staffUserId", "userId"]) test(`malformed attached ${key} denies both resources`, async () => {
  for (const value of ["", "bad", null, undefined]) for (const resource of ["contracts", "results"] as const) {
    failure(await call({ resource, context: { ...verified, [key]: value } as Context }), 403, "workspace_access_denied");
  }
  untouched();
});
for (const value of [undefined, null, "bad", [leadId], 42]) test(`GET rejects invalid leadId ${String(value)}`, async () => {
  failure(await call({ query: { leadId: value } }), 400, "invalid_contract"); untouched();
});
for (const method of ["PUT", "DELETE", "OPTIONS", "HEAD", "post"]) test(`contracts reject ${method}`, async () => {
  failure(await call({ method, body: draft() }), 405, "method_not_allowed"); untouched();
});
for (const method of ["POST", "PATCH", "PUT", "DELETE"]) test(`results reject ${method}`, async () => {
  failure(await call({ resource: "results", method, body: draft() }), 405, "method_not_allowed"); untouched();
});
for (const role of ["owner", "admin"]) for (const days of [undefined, "7", "30", "90"]) test(`${role} results period ${days ?? "default"} uses scoped RPC`, async () => {
  result.data = { timeZone: "Asia/Almaty", members: [], period: { days: Number(days ?? 30) } };
  assert.equal((await call({ resource: "results", context: { ...verified, role },
    query: { days, workspaceId: id(90), staffUserId: id(91), userId: id(92) }, body: { days: "90", ...verified } })).statusCode, 200);
  assert.deepEqual(calls, [{ name: "read_mortgage_results", args: { ...scope, p_days: Number(days ?? 30) } }]);
});
for (const days of ["", "0", "31", "365", "07", " 7", "7 ", "7.0", 7, null, ["7"], ["7", "30"], {}]) {
  test(`results reject invalid days ${JSON.stringify(days)}`, async () => {
    failure(await call({ resource: "results", query: { days } }), 400, "invalid_period"); untouched();
  });
}

test("results require the RPC-owned valid timezone without an extra settings query", async () => {
  for (const timeZone of [undefined, null, 5, {}, [], "", " UTC ", "Invalid/Zone"]) {
    result.data = { timeZone, members: [] };
    failure(await call({ resource: "results" }), 502, "outcomes_unavailable");
  }
  assert.equal(calls.length, 8);
  assert.ok(calls.every(call => call.name === "read_mortgage_results"));
});

const errors: [string, number, string][] = [
  ["P7001", 403, "workspace_access_denied"], ["P7002", 404, "resource_not_found"],
  ["P7008", 503, "timezone_not_configured"],
  ["P7803", 400, "invalid_contract"], ["P7804", 409, "contract_already_recorded"],
  ["P7805", 409, "contract_already_corrected"], ["P7806", 409, "lead_requires_assignment"],
  ["P7807", 409, "request_conflict"], ["PGRST202", 503, "schema_not_ready"],
  ["42883", 503, "schema_not_ready"], ["42P01", 503, "schema_not_ready"],
  ["XX000", 502, "outcomes_unavailable"], ["23505", 502, "outcomes_unavailable"],
];
for (const [code, status, publicCode] of errors) test(`${code} maps to sanitized ${status}/${publicCode} for every RPC`, async () => {
  result = { data: { privateDetail }, error: { code, message: privateDetail, details: privateDetail, hint: privateDetail } };
  failure(await call({ method: "POST", body: draft() }), status, publicCode);
  failure(await call(), status, publicCode);
  failure(await call({ resource: "results" }), status, publicCode);
  assert.deepEqual(calls.map(c => c.name), ["save_mortgage_contract", "read_mortgage_contracts", "read_mortgage_results"]);
  assert.equal(factoryCalls, 3);
});
test("storage unavailable is explicit and never falls back to tables or fake success", async () => {
  setFactory(() => { factoryCalls++; return null; });
  failure(await call(), 503, "storage_not_configured"); assert.deepEqual(calls, []);
});
for (const value of [new Error(privateDetail), { message: privateDetail }, privateDetail]) test(`thrown RPC ${typeof value} is sanitized`, async () => {
  rpcThrow = value;
  failure(await call({ method: "POST", body: draft() }), 502, "outcomes_unavailable");
  assert.equal(calls.length, 1);
});
for (const data of [null, undefined, false, 3, "private response", [], [{ id: contractId }]]) test(`invalid RPC response ${JSON.stringify(data)} fails closed`, async () => {
  result = { data, error: null };
  failure(await call(), 502, "outcomes_unavailable"); assert.equal(calls.length, 1);
});

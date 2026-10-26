import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const contracts = await import(new URL("../../lib/crm/creator-job-contracts.ts", import.meta.url).href);
const source = await readFile(path.join(root, "lib/crm/creator-jobs.ts"), "utf8");
const id = "10000000-0000-4000-8000-000000000001", other = "20000000-0000-4000-8000-000000000002";
const actor = "30000000-0000-4000-8000-000000000003", workspace = "40000000-0000-4000-8000-000000000004", staff = "50000000-0000-4000-8000-000000000005";
const stamp = "2026-10-27T08:00:00.000Z";
const context = { userId: actor, workspaceId: workspace, staffUserId: staff, role: "owner" };
const terms = { creatorId: other, title: "QA job", brief: "QA brief", rightsTerms: "QA explicit rights", feeMinor: "9007199254740993", currency: "KZT", dueAt: stamp };
const job = { id, revision: id, termsRevision: id, creatorName: "QA author", title: terms.title, brief: terms.brief, rightsTerms: terms.rightsTerms,
  feeMinor: terms.feeMinor, currency: terms.currency, dueAt: stamp, state: "offered", acceptedAt: null, approvedAt: null, submissionCount: 0, latestSubmission: null, feedback: null };
const receipt = { requestId: id, appliedRevision: id, replayed: false, job };
const create = { requestId: id, action: "create", terms };
const accept = { requestId: id, jobId: id, revision: id, action: "accept", payload: { termsRevision: id } };
const approved = { ...job, state: "approved", acceptedAt: stamp, approvedAt: stamp, submissionCount: 1,
  latestSubmission: { sequence: 1, links: ["https://example.com/qa.mp4"], note: "", submittedAt: stamp } };
type Options = { clinic?: boolean; receipt?: boolean; method?: string; body?: unknown; query?: Record<string, unknown>; context?: unknown;
  actor?: string | null; data?: unknown; error?: unknown; configured?: boolean; thrown?: boolean };
async function api(options: Options = {}) {
  const calls: unknown[] = [], headers: Record<string, unknown> = {}, exports: Record<string, any> = {};
  let status = 0, body: any, clients = 0, auth = 0;
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Script(code).runInNewContext({ exports, Object, Error, require(name: string) {
    if (name === "../auth/server") return { isUuidValue: (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v),
      requireAuthenticatedUser: async () => { auth++; if (options.actor === null) throw Error("AUTH_REQUIRED"); return { id: options.actor ?? actor }; } };
    if (name === "./server") return { readWorkspaceContext: () => options.context === undefined ? context : options.context };
    if (name === "./creator-job-contracts") return contracts;
    if (name === "../supabase/server") return { getSupabaseServerClient: () => { clients++; return options.configured === false ? null : {
      rpc: async (rpc: string, params: unknown) => { calls.push([rpc, JSON.parse(JSON.stringify(params))]);
        if (options.thrown) throw Error("private-service-key-and-database-detail");
        return { data: Object.hasOwn(options, "data") ? options.data : rpc === "read_growth_creator_jobs" ? { items: [job], hasMore: false } : receipt, error: options.error ?? null }; },
      from: () => { throw Error("Direct table access forbidden"); },
    }; } };
    throw Error("Unexpected import " + name);
  } });
  const res = { setHeader: (k: string, v: unknown) => { headers[k] = v; }, status: (s: number) => { status = s; return res; },
    json: (v: unknown) => { body = JSON.parse(JSON.stringify(v)); return res; } };
  await exports.handleCreatorJobs({ method: options.method ?? "GET", query: options.query ?? {}, body: options.body }, res, options.clinic ?? false, options.receipt ?? false);
  return { status, body, headers, calls, clients, auth };
}
test("creator list uses only verified Auth, no workspace membership, selectors or direct table access", async () => {
  const result = await api(); assert.equal(result.status, 200); assert.equal(result.auth, 1);
  assert.deepEqual(result.calls, [["read_growth_creator_jobs", { p_actor: actor, p_workspace: null, p_staff: null, p_offset: 0 }]]);
  assert.equal(result.headers["Cache-Control"], "no-store");
  await assert.rejects(api({ actor: null }), /AUTH_REQUIRED/);
});
test("clinic list binds all three identities to the verified owner/admin context", async () => {
  const result = await api({ clinic: true, query: { workspaceId: workspace, offset: "20" } });
  assert.equal(result.status, 200); assert.equal(result.auth, 0);
  assert.deepEqual(result.calls, [["read_growth_creator_jobs", { p_actor: actor, p_workspace: workspace, p_staff: staff, p_offset: 20 }]]);
  for (const bad of [null, { ...context, role: "doctor" }, { ...context, role: "manager" }, { ...context, userId: "invalid" }, { ...context, staffUserId: null }]) {
    const denied = await api({ clinic: true, context: bad }); assert.equal(denied.status, 403); assert.equal(denied.clients, 0);
  }
});
test("caller parameters never override the clinic's verified workspace or author identity", async () => {
  for (const query of [{ workspaceId: other }, { authUserId: other }, { p_actor: other }, { role: "owner" }]) {
    const denied = await api({ clinic: true, query }); assert.ok([400, 403].includes(denied.status)); assert.equal(denied.clients, 0);
  }
  for (const query of [{ workspaceId: workspace }, { creatorId: other }, { p_workspace: workspace }]) {
    const denied = await api({ query }); assert.equal(denied.status, 400); assert.equal(denied.clients, 0);
  }
});
test("pages and GET bodies are closed before any database client exists", async () => {
  for (const offset of ["01", "-1", "1.5", "1000001", ["0"], {}, 20, null]) { const result = await api({ query: { offset } }); assert.equal(result.status, 400); assert.equal(result.clients, 0); }
  for (const body of [{ p_actor: other }, [], "forged"]) { const result = await api({ body }); assert.equal(result.status, 400); assert.equal(result.clients, 0); }
});
test("company create preserves explicit exact terms and uses the verified actor/workspace/staff", async () => {
  const result = await api({ clinic: true, method: "POST", body: create }); assert.equal(result.status, 200);
  assert.deepEqual(result.calls, [["execute_growth_creator_job", { p_actor: actor, p_workspace: workspace, p_staff: staff,
    p_job: null, p_revision: null, p_request: id, p_action: "create", p_payload: terms }]]);
  for (const key of ["authUserId", "workspaceId", "p_staff", "role", "paid"]) {
    const denied = await api({ clinic: true, method: "POST", body: { ...create, [key]: other } }); assert.equal(denied.status, 400); assert.equal(denied.clients, 0);
  }
});
test("creator acceptance has no clinic authority and cannot be used to create or review a job", async () => {
  const result = await api({ method: "POST", body: accept }); assert.equal(result.status, 200);
  assert.deepEqual(result.calls, [["execute_growth_creator_job", { p_actor: actor, p_workspace: null, p_staff: null,
    p_job: id, p_revision: id, p_request: id, p_action: "accept", p_payload: { termsRevision: id } }]]);
  assert.equal((await api({ method: "POST", body: create })).status, 403);
  for (const action of ["approve", "cancel"]) { const result = await api({ method: "POST", body: { ...accept, action, payload: {} } }); assert.equal(result.status, 403); assert.equal(result.clients, 0); }
  const wrongSide = await api({ clinic: true, method: "POST", body: accept }); assert.equal(wrongSide.status, 403); assert.equal(wrongSide.clients, 0);
});
test("commands require the original key, exact job revision and a closed action payload", async () => {
  for (const change of [{ requestId: null }, { jobId: "invalid" }, { revision: null }, { authUserId: other },
    { payload: { termsRevision: id, paid: true } }, { payload: { termsRevision: null } }]) {
    const result = await api({ method: "POST", body: { ...accept, ...change } }); assert.equal(result.status, 400); assert.equal(result.clients, 0);
  }
});
test("outcome reads bind the request key and distinguish authoritative absence from failure", async () => {
  const result = await api({ receipt: true, query: { requestId: id }, data: null }); assert.equal(result.status, 200); assert.equal(result.body.data, null);
  assert.deepEqual(result.calls, [["read_growth_creator_command", { p_actor: actor, p_workspace: null, p_staff: null, p_request: id }]]);
  const clinic = await api({ receipt: true, clinic: true, query: { requestId: id } }); assert.equal(clinic.status, 200);
  assert.deepEqual(clinic.calls, [["read_growth_creator_command", { p_actor: actor, p_workspace: workspace, p_staff: staff, p_request: id }]]);
  for (const requestId of [undefined, "bad", [id]]) { const result = await api({ receipt: true, query: { requestId } }); assert.equal(result.status, 400); assert.equal(result.clients, 0); }
});
test("unsupported methods cannot reach Auth, storage or an alternate writer", async () => {
  for (const method of ["PATCH", "PUT", "DELETE", "HEAD"]) { const result = await api({ method }); assert.equal(result.status, 405); assert.equal(result.clients, 0); assert.equal(result.auth, 0); }
  assert.equal((await api({ receipt: true, method: "POST", body: accept })).status, 405);
});
for (const [code, status] of [["P1101", 403], ["P1102", 400], ["P1103", 409], ["P1104", 409], ["PGRST202", 503], ["42P01", 503], ["55P03", 503], ["57014", 503], ["unknown", 503]] as const)
  test(`creator RPC ${code} is sanitized without retry or false success`, async () => {
    const result = await api({ method: "POST", body: accept, error: { code, message: "private-service-key-and-database-detail" } });
    assert.equal(result.status, status); assert.equal(result.body.success, false); assert.equal(result.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(result.body), /private|service-key|database-detail/); assert.equal(result.headers["Cache-Control"], "no-store");
  });
test("storage outage and thrown/unconfirmed replies are not interpreted as committed or absent", async () => {
  for (const options of [{ configured: false }, { thrown: true }, { data: {} }]) {
    const result = await api({ method: "POST", body: accept, ...options }); assert.equal(result.status, 503); assert.equal(result.body.code, "creator_job_outcome_unconfirmed");
  }
  assert.equal((await api({ receipt: true, query: { requestId: id }, thrown: true })).status, 503);
  for (const data of [null, {}, { items: [], hasMore: true }, { items: [job, job], hasMore: false }]) assert.equal((await api({ data })).status, 503);
});
test("a plausible receipt for another request/job or changed immutable terms is not accepted", async () => {
  for (const data of [{ ...receipt, requestId: other }, { ...receipt, job: { ...job, id: other } }])
    assert.equal((await api({ method: "POST", body: accept, data })).status, 503);
  assert.equal((await api({ clinic: true, method: "POST", body: create, data: { ...receipt, job: { ...job, feeMinor: "1" } } })).status, 503);
  const lower = "abcdefab-cdef-4abc-8abc-abcdefabcdef", upper = lower.toUpperCase();
  assert.notEqual(lower, upper);
  assert.equal((await api({ method: "POST", body: { ...accept, requestId: upper }, data: { ...receipt, requestId: lower } })).status, 200);
});
test("a legitimate same-key replay returns the current approved job, not the original offered snapshot", async () => {
  const data = { ...receipt, replayed: true, job: { ...approved, revision: other } };
  const result = await api({ clinic: true, method: "POST", body: create, data }); assert.equal(result.status, 200);
  assert.equal(result.body.data.appliedRevision, id); assert.equal(result.body.data.job.revision, other); assert.equal(result.body.data.job.state, "approved");
});

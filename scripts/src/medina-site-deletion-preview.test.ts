import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { before, after, beforeEach, afterEach } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const load = (file: string) => import(pathToFileURL(path.join(root, file)).href);
const preview = await load("lib/crm/site-inquiry-deletion.ts");
const server = await load("lib/crm/server.ts");
const supabase = await load("lib/supabase/server.ts");
const db = new PGlite();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const env = { MEDINA_PUBLIC_SITE_WORKSPACE_ID: id(1), MEDINA_SITE_INTAKE_KEY: "medina-test" };
const inquiry = { name: "Private fixture", phone: "+77071234567", business: "Private business", service: "call-center", pagePath: "/ru/", consentVersion: "v1", consent: true };
const row = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, params)).rows[0];
let leadId: string;
let queried: string[];
let failedTable = "";
let rowCap = 200;

// Only SELECT is implemented: a handler write/RPC is a test failure. Queries
// run against the actual migrations, with no service credentials or network.
function client() {
  return { from(table: string) {
    assert.match(table, /^[a-z_]+$/);
    queried.push(table);
    const predicates: string[] = [], params: unknown[] = [];
    let columns = "", limit = 1000, single = false, count = false, order = "";
    const query = {
      select(value: string, options?: { count?: string }) {
        assert.match(value, /^[a-z_,]+$/); columns = value; count = options?.count === "exact"; return query;
      },
      eq(key: string, value: unknown) { return filter(key, "=", value); },
      neq(key: string, value: unknown) { return filter(key, "<>", value); },
      limit(value: number) { limit = value; return query; },
      order(key: string) { assert.equal(key, "id"); order = " order by id"; return query; },
      maybeSingle() { single = true; return query; },
      async then(resolve: (value: unknown) => unknown) {
        if (table === failedTable) return resolve({ data: null, error: { message: "PRIVATE_DATABASE_ERROR", code: "PGRST205" } });
        const where = predicates.length ? ` where ${predicates.join(" and ")}` : "";
        const result = await db.query(`select ${columns} from public.${table}${where}${order} limit ${Math.min(limit, rowCap)}`, params);
        const total = count ? (await row(`select count(*)::int as n from public.${table}${where}`, params)).n : null;
        return resolve({ data: single ? result.rows[0] ?? null : result.rows, count: total, error: null });
      },
    };
    function filter(key: string, operator: string, value: unknown) {
      assert.match(key, /^[a-z_]+$/); params.push(value); predicates.push(`${key}${operator}$${params.length}`); return query;
    }
    return query;
  } };
}

async function call(options: { role?: string; workspace?: string; query?: Record<string, unknown>; method?: string; config?: Record<string, string> } = {}) {
  const req = { method: options.method ?? "GET", query: { leadId, ...options.query }, headers: {} };
  const role = options.role ?? "owner";
  if (role !== "anonymous") server.attachWorkspaceContext(req, {
    workspaceId: options.workspace ?? id(1), role, userId: id(90), staffUserId: id(91), permissions: [],
  });
  let status = 0; let payload: Record<string, unknown> = {};
  const headers: Record<string, unknown> = {};
  const res = { setHeader(key: string, value: unknown) { headers[key] = value; },
    status(value: number) { status = value; return res; }, json(value: Record<string, unknown>) { payload = value; } };
  await preview.createSiteInquiryDeletionPreviewHandler(() => options.config ?? env)(req, res);
  assert.equal(headers["Cache-Control"], "no-store");
  const serialized = JSON.stringify(payload);
  for (const secret of [inquiry.phone, inquiry.name, inquiry.business, "PRIVATE_DATABASE_ERROR"]) assert.ok(!serialized.includes(secret));
  return { status, payload, data: payload.data as Record<string, unknown> | undefined };
}

before(async () => {
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to service_role;");
  const numbers = new Set([9, 10, 11, 12, 13, 14, 19, 20, 26, 27, 30, 31, 32, 33, 34, 36, 40, 45, 52, 53, 54, 55, 56, 57, 58]);
  for (const file of (await readdir(path.join(root, "migrations"))).sort()) {
    if (!numbers.has(Number(file.slice(0, 3)))) continue;
    await db.exec((await readFile(path.join(root, "migrations", file), "utf8")).replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/i, ""));
  }
  await db.query("insert into public.workspaces(id,name) values($1,'Marketing'),($2,'Other')", [id(1), id(2)]);
  await db.query("insert into public.crm_intake_sites(id,site_key,workspace_id,consent_version,allowed_page_paths,enabled) values($1,'medina-test',$2,'v1',array['/ru/'],true),($3,'other-test',$4,'v1',array['/ru/'],true)", [id(10), id(1), id(11), id(2)]);
});
beforeEach(async () => {
  await db.exec("begin"); queried = []; failedTable = ""; rowCap = 200;
  supabase.setSupabaseServerClientFactoryForTests(client);
  for (const key of [100, 101]) await db.query("select public.accept_crm_site_inquiry('medina-test',$1,$2::jsonb)", [id(key), JSON.stringify(inquiry)]);
  leadId = String((await row("select lead_id from public.crm_site_inquiries where site_id=$1 limit 1", [id(10)])).lead_id);
});
afterEach(async () => { supabase.setSupabaseServerClientFactoryForTests(null); await db.exec("rollback"); });
after(() => db.close());

test("owner OR admin gets exact lead/receipt scope without contacts or an enabled delete action", async () => {
  const receiptIds = (await db.query<{ id: string }>("select id from public.crm_site_inquiries order by id")).rows.map(row => row.id);
  for (const role of ["owner", "admin"]) {
    const result = await call({ role }); assert.equal(result.status, 200);
    assert.deepEqual(result.data, { leadId, receiptIds, receiptCount: 2, reviewRequired: false,
      reviewReasons: [], confirmationRequired: true, deletionEnabled: false });
  }
  assert.equal((await row("select count(*)::int as n from public.leads")).n, 1);
  assert.equal((await row("select count(*)::int as n from public.crm_site_inquiries")).n, 2);
});

test("anonymous, non-admin and owner of a non-marketing workspace cannot read the scope", async () => {
  for (const role of ["anonymous", "doctor", "receptionist", "operator"]) {
    assert.equal((await call({ role })).status, role === "anonymous" ? 401 : 403);
  }
  assert.equal((await call({ workspace: id(2), query: { workspaceId: id(1) } })).status, 403);
  assert.deepEqual(queried, []);
});

test("query injection and write methods are refused without touching storage", async () => {
  for (const query of [{ leadId: "" }, { leadId: [leadId] }, { phone: inquiry.phone }, { siteId: id(11) }, { role: "owner" }, { confirmed: "true" }]) {
    assert.equal((await call({ query })).status, 400);
  }
  for (const method of ["POST", "PATCH", "DELETE"]) assert.equal((await call({ method })).status, 405);
  assert.deepEqual(queried, []);
});

test("marketing configuration is mandatory but disabling intake does not hide old receipts", async () => {
  assert.equal((await call({ config: {} })).status, 503);
  assert.deepEqual(queried, []);
  assert.equal((await call({ config: { ...env, MEDINA_SITE_INTAKE_KEY: "other-test" } })).status, 503);
  await db.query("update public.crm_intake_sites set enabled=false where id=$1", [id(10)]);
  assert.equal((await call({ config: { ...env, MEDINA_PUBLIC_SITE_ENABLED: "false", MEDINA_SITE_INTAKE_ENABLED: "false" } })).status, 200);
});

test("another workspace's same-phone lead, non-site lead and orphan receipt do not expand scope", async () => {
  await db.query("select public.accept_crm_site_inquiry('other-test',$1,$2::jsonb)", [id(102), JSON.stringify(inquiry)]);
  const foreign = await row("select id from public.leads where workspace_id=$1", [id(2)]);
  assert.equal((await call({ query: { leadId: foreign.id } })).status, 404);
  await db.query("insert into public.leads(id,workspace_id,full_name,phone) values($1,$2,'Existing',$3)", [id(120), id(1), inquiry.phone]);
  assert.equal((await call({ query: { leadId: id(120) } })).status, 404);
  await db.query("insert into public.crm_site_inquiries(site_id,request_key,inquiry) values($1,$2,$3)", [id(10), id(103), inquiry]);
  const result = await call(); assert.equal(result.data?.receiptCount, 2);
  assert.equal((await row("select count(*)::int as n from public.leads")).n, 3);
  assert.equal((await row("select count(*)::int as n from public.crm_site_inquiries")).n, 4);
});

test("converted lead with an appointment requires separate review and remains intact", async () => {
  await db.query("insert into public.clients(id,workspace_id,full_name) values($1,$2,'Client')", [id(130), id(1)]);
  await db.query("update public.leads set client_id=$1 where id=$2", [id(130), leadId]);
  await db.query("insert into public.appointments(workspace_id,client_id,client_name,starts_at) values($1,$2,'Client',now())", [id(1), id(130)]);
  const result = await call(); assert.equal(result.status, 200);
  assert.equal(result.data?.reviewRequired, true); assert.deepEqual(result.data?.reviewReasons, ["linked_client"]);
  assert.equal(result.data?.deletionEnabled, false);
  assert.equal((await row("select count(*)::int as n from public.appointments")).n, 1);
});

test("sales, tasks, messenger copies and audit history require separate review", async () => {
  await db.query("insert into public.deals(workspace_id,lead_id,title) values($1,$2,'Sale')", [id(1), leadId]);
  await db.query("insert into public.tasks(workspace_id,lead_id,title) values($1,$2,'Task')", [id(1), leadId]);
  for (const table of ["wazzup_inbound_messages", "whatsapp_cloud_inbound_messages"]) {
    await db.query(`insert into public.${table}(workspace_id,lead_id,message_id,channel_id) values($1,$2,'message','channel')`, [id(1), leadId]);
  }
  await db.query("insert into public.audit_logs(workspace_id,action,entity_type,entity_id) values($1,'updated','lead',$2)", [id(1), leadId]);
  const result = await call(); assert.equal(result.status, 200);
  assert.deepEqual(result.data?.reviewReasons, ["deals", "tasks", "wazzup_inbound_messages", "whatsapp_cloud_inbound_messages", "audit_history"]);
  assert.equal(result.data?.reviewRequired, true);
});

test("operator assignment and booking require review even when assignment has been revoked", async () => {
  await db.query("insert into public.staff_users(id,workspace_id,full_name,email,role) values($1,$2,'Owner','fixture@example.invalid','owner')", [id(140), id(1)]);
  await db.query("insert into public.growth_operator_profiles(id,auth_user_id,display_name,status,accepting_requests,approved_by,approved_at) values($1,$2,'Operator','approved',true,$3,now())", [id(141), id(142), id(90)]);
  await db.query("insert into public.growth_operator_requests(id,workspace_id,operator_id,requested_by_staff_user_id,clinic_brief,price_per_arrival_minor) values($1,$2,$3,$4,'Brief',10000)", [id(143), id(1), id(141), id(140)]);
  await db.query("insert into public.growth_operator_lead_assignments(operator_request_id,workspace_id,lead_id,assigned,changed_by_staff_user_id) values($1,$2,$3,false,$4)", [id(143), id(1), leadId, id(140)]);
  const result = await call(); assert.equal(result.status, 200);
  assert.deepEqual(result.data?.reviewReasons, ["growth_operator_lead_assignments"]);
  await db.query("insert into public.clinic_doctors(id,workspace_id,full_name) values($1,$2,'Master')", [id(144), id(1)]);
  await db.query("insert into public.appointments(id,workspace_id,client_name,starts_at) values($1,$2,'Patient',now())", [id(145), id(1)]);
  await db.query("insert into public.growth_operator_bookings(request_key,workspace_id,operator_request_id,lead_id,appointment_id,doctor_id,service_ids,starts_local,time_zone) values($1,$2,$3,$4,$5,$6,'{}',now(),'Asia/Almaty')", [id(146), id(1), id(143), leadId, id(145), id(144)]);
  assert.deepEqual((await call()).data?.reviewReasons, ["growth_operator_lead_assignments", "growth_operator_bookings"]);
});

test("UUID case cannot hide a text-based audit reference", async () => {
  await db.query("insert into public.audit_logs(workspace_id,action,entity_type,entity_id) values($1,'updated','lead',$2)", [id(1), leadId]);
  const result = await call({ query: { leadId: leadId.toUpperCase() } });
  assert.equal(result.status, 200);
  assert.equal(result.data?.leadId, leadId);
  assert.deepEqual(result.data?.reviewReasons, ["audit_history"]);
});

test("receipt for a different site triggers review without returning that receipt ID", async () => {
  await db.query("insert into public.crm_site_inquiries(id,site_id,request_key,lead_id,inquiry) values($1,$2,$3,$4,$5)", [id(151), id(11), id(152), leadId, inquiry]);
  const result = await call(); assert.equal(result.status, 200);
  assert.deepEqual(result.data?.reviewReasons, ["other_site_receipts"]);
  assert.equal(result.data?.receiptCount, 2);
  assert.ok(!JSON.stringify(result.payload).includes(id(151)));
});

test("bounded receipt count never produces a silently truncated preview", async () => {
  rowCap = 1;
  assert.equal((await call()).payload.code, "site_deletion_scope_too_large");
  rowCap = 200;
  await db.query("insert into public.crm_site_inquiries(site_id,request_key,lead_id,inquiry) select $1,gen_random_uuid(),$2,$3 from generate_series(1,200)", [id(10), leadId, inquiry]);
  const result = await call(); assert.equal(result.status, 409); assert.equal(result.data, undefined);
});

test("missing dependencies and private DB errors fail closed, without demo or partial scope", async () => {
  for (const table of ["crm_intake_sites", "leads", "crm_site_inquiries", "deals", "tasks", "growth_operator_bookings", "audit_logs"]) {
    failedTable = table;
    const result = await call(); assert.equal(result.status, 503); assert.equal(result.data, undefined);
    assert.equal(result.payload.code, "site_deletion_unavailable");
  }
  supabase.setSupabaseServerClientFactoryForTests(() => null);
  assert.equal((await call()).status, 503);
});

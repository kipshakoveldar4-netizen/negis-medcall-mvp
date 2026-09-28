import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { before, after, beforeEach, afterEach } from "node:test";
import { Readable } from "node:stream";
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
let allowRpc = false;
let rpcCalls: Record<string, unknown>[] = [];
let rpcFailure = "";
let rpcResponse: unknown = undefined;
let permissionOverride: { data: unknown; error: { code: string; message: string } | null } | undefined;

// Preview permits SELECT only; confirmation permits the single atomic RPC.
// Everything runs against real local migrations, without credentials/network.
function client() {
  return {
    async rpc(name: string, args: Record<string, unknown>) {
      assert.ok(allowRpc, "preview must never execute an RPC");
      assert.equal(name, "delete_crm_site_inquiry");
      rpcCalls.push(args);
      if (rpcFailure) return { data: null, error: { message: rpcFailure } };
      if (rpcResponse !== undefined) return { data: rpcResponse, error: null };
      await db.exec("savepoint http_delete");
      try {
        const result = await row("select public.delete_crm_site_inquiry($1,$2,$3,$4,$5,$6,$7,$8,$9) as result", [
          args.p_workspace_id, args.p_site_key, args.p_lead_id, args.p_expected_receipt_ids,
          args.p_expected_lead_updated_at, args.p_staff_user_id, args.p_auth_user_id, args.p_request_key, args.p_confirmed,
        ]);
        await db.exec("release savepoint http_delete");
        return { data: result.result, error: null };
      } catch (error) {
        await db.exec("rollback to savepoint http_delete; release savepoint http_delete");
        return { data: null, error: { message: error instanceof Error ? error.message : "PRIVATE_DATABASE_ERROR" } };
      }
    }, from(table: string) {
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
      ilike(key: string, value: unknown) { return filter(key, " ilike ", value); },
      limit(value: number) { limit = value; return query; },
      order(key: string) { assert.equal(key, "id"); order = " order by id"; return query; },
      maybeSingle() { single = true; return query; },
      async then(resolve: (value: unknown) => unknown) {
        if (table === failedTable) return resolve({ data: null, error: { message: "PRIVATE_DATABASE_ERROR", code: "PGRST205" } });
        if (table === "crm_intake_sites" && columns === "manual_deletion_enabled" && permissionOverride) return resolve(permissionOverride);
        const where = predicates.length ? ` where ${predicates.join(" and ")}` : "";
        const projection = columns.split(",").map(column => column === "updated_at" ? "updated_at::text as updated_at" : column).join(",");
        // Model PostgREST's separate transaction, including a missing 062 column.
        await db.exec("savepoint preview_select");
        try {
          const result = await db.query(`select ${projection} from public.${table}${where}${order} limit ${Math.min(limit, rowCap)}`, params);
          const total = count ? (await row(`select count(*)::int as n from public.${table}${where}`, params)).n : null;
          await db.exec("release savepoint preview_select");
          return resolve({ data: single ? result.rows[0] ?? null : result.rows, count: total, error: null });
        } catch (error) {
          await db.exec("rollback to savepoint preview_select; release savepoint preview_select");
          const code = typeof error === "object" && error !== null && "code" in error ? error.code : "TEST";
          return resolve({ data: null, error: { code, message: "PRIVATE_DATABASE_ERROR" } });
        }
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
  await db.exec(await readFile(path.join(root, "migrations/062_site_inquiry_manual_deletion.sql"), "utf8"));
  await db.query("insert into public.staff_users(id,workspace_id,auth_user_id,full_name,email,role) values($1,$2,$3,'Owner','owner@example.invalid','owner')", [id(91), id(1), id(90)]);
});
beforeEach(async () => {
  await db.exec("begin"); queried = []; failedTable = ""; rowCap = 200;
  allowRpc = false; rpcCalls = []; rpcFailure = ""; rpcResponse = undefined;
  permissionOverride = undefined;
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
    const leadUpdatedAt = (await row("select updated_at::text as stamp from public.leads where id=$1", [leadId])).stamp;
    assert.deepEqual(result.data, { leadId, leadUpdatedAt, receiptIds, receiptCount: 2, reviewRequired: false,
      reviewReasons: [], confirmationRequired: true, deletionEnabled: false, deletionAvailability: "disabled" });
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
  await enable();
  await db.query("insert into public.clients(id,workspace_id,full_name) values($1,$2,'Client')", [id(130), id(1)]);
  await db.query("update public.leads set client_id=$1 where id=$2", [id(130), leadId]);
  await db.query("insert into public.appointments(workspace_id,client_id,client_name,starts_at) values($1,$2,'Client',now())", [id(1), id(130)]);
  const result = await call(); assert.equal(result.status, 200);
  assert.equal(result.data?.reviewRequired, true); assert.deepEqual(result.data?.reviewReasons, ["linked_client"]);
  assert.equal(result.data?.deletionEnabled, false);
  assert.equal(result.data?.deletionAvailability, "review_required");
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

async function confirmationBody() {
  const scope = (await call()).data!;
  return { leadId, receiptIds: scope.receiptIds, leadUpdatedAt: scope.leadUpdatedAt, requestKey: id(200), confirmed: true };
}
async function erase(body: unknown, options: { role?: string; workspace?: string; query?: Record<string, unknown>;
  headers?: Record<string, string>; config?: Record<string, string>; stream?: Buffer[]; method?: string } = {}) {
  allowRpc = true;
  const props = { method: options.method ?? "POST", query: { workspaceId: id(1), ...options.query },
    headers: { "content-type": "application/json", ...options.headers }, ...(options.stream ? {} : { body }) };
  const req = options.stream ? Object.assign(Readable.from(options.stream), props) : props;
  if (options.role !== "anonymous") server.attachWorkspaceContext(req, {
    workspaceId: options.workspace ?? id(1), role: options.role ?? "owner", userId: id(90), staffUserId: id(91), permissions: [],
  });
  let status = 0; let payload: Record<string, unknown> = {};
  const headers: Record<string, unknown> = {};
  const res = { setHeader(key: string, value: unknown) { headers[key] = value; },
    status(value: number) { status = value; return res; }, json(value: Record<string, unknown>) { payload = value; } };
  await preview.createSiteInquiryDeletionHandler(() => options.config ?? env)(req, res);
  assert.equal(headers["Cache-Control"], "no-store");
  for (const privateValue of [inquiry.phone, inquiry.name, inquiry.business, "PRIVATE_DATABASE_ERROR"]) {
    assert.ok(!JSON.stringify(payload).includes(privateValue));
  }
  return { status, payload };
}
const enable = () => db.query("update public.crm_intake_sites set manual_deletion_enabled=true where id=$1", [id(10)]);

test("confirmation requires owner/admin context and the configured marketing workspace", async () => {
  const body = await confirmationBody();
  for (const role of ["anonymous", "doctor", "operator", "receptionist"]) {
    assert.equal((await erase(body, { role })).status, role === "anonymous" ? 401 : 403);
  }
  assert.equal((await erase(body, { workspace: id(2), query: { workspaceId: id(2) } })).status, 403);
  assert.equal((await erase(body, { config: {} })).status, 503);
  assert.equal((await erase(body, { method: "GET" })).status, 405);
  assert.deepEqual(rpcCalls, []);
});

test("confirmation rejects spoofed fields, missing consent/version, duplicate IDs and unbounded bodies", async () => {
  const body = await confirmationBody();
  for (const patch of [{ confirmed: false }, { confirmed: "true" }, { confirmed: null }, { receiptIds: [] },
    { receiptIds: [id(123), id(123)] }, { receiptIds: ["aaaaaaaa-0000-4000-8000-000000000123", "AAAAAAAA-0000-4000-8000-000000000123"] },
    { receiptIds: Array(201).fill(id(123)) }, { leadUpdatedAt: "infinity" }, { leadUpdatedAt: null },
    { leadId: "all" }, { requestKey: null }, { workspaceId: id(2) }, { staffUserId: id(91) },
    { userId: id(90) }, { siteKey: "other-test" }, { role: "owner" }, { phone: inquiry.phone }]) {
    assert.equal((await erase({ ...body, ...patch })).status, 400);
  }
  for (const query of [{ workspaceId: [id(1)] }, { workspaceId: id(2) }, { confirmed: "true" }, { leadId }]) {
    assert.equal((await erase(body, { query })).status, 400);
  }
  assert.equal((await erase(body, { headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await erase(body, { headers: { "content-length": "8193" } })).status, 400);
  assert.equal((await erase({ ...body, padding: "x".repeat(8193) })).status, 400);
  assert.equal((await erase(null, { stream: [Buffer.alloc(4096), Buffer.alloc(4097)] })).status, 400);
  assert.equal((await erase("{broken")).status, 400);
  assert.deepEqual(rpcCalls, []);
});

test("disabled/missing SQL remains closed and never falls back to independent deletes", async () => {
  const body = await confirmationBody();
  assert.deepEqual(await erase(body), { status: 409, payload: { success: false, code: "site_deletion_disabled" } });
  rpcFailure = "Could not find the function public.delete_crm_site_inquiry";
  assert.deepEqual(await erase(body), { status: 503, payload: { success: false, code: "site_deletion_unavailable" } });
  assert.equal((await row("select count(*)::int as n from public.leads")).n, 1);
  assert.equal((await row("select count(*)::int as n from public.crm_site_inquiries")).n, 2);
});

test("owner/admin confirmation preserves microseconds, erases exact scope and safely replays", async () => {
  await enable();
  await db.query("update public.staff_users set role='admin' where id=$1", [id(91)]);
  // This version cannot survive roundtripping through a JavaScript Date.
  await db.exec("alter table public.leads disable trigger user");
  await db.query("update public.leads set updated_at='2026-09-28T01:02:03.123456Z' where id=$1", [leadId]);
  await db.exec("alter table public.leads enable trigger user");
  const body = await confirmationBody();
  assert.match(String(body.leadUpdatedAt), /123456/);
  const result = await erase(body, { role: "admin", stream: [Buffer.from(JSON.stringify(body))] });
  assert.deepEqual(result, { status: 200, payload: { success: true, data: { deleted: true, receiptsDeleted: 2, replayed: false } } });
  assert.equal(rpcCalls[0].p_staff_user_id, id(91)); assert.equal(rpcCalls[0].p_auth_user_id, id(90));
  assert.equal(rpcCalls[0].p_site_key, "medina-test");
  assert.equal(rpcCalls[0].p_expected_lead_updated_at, body.leadUpdatedAt);
  assert.equal((await row("select count(*)::int as n from public.leads")).n, 0);
  assert.equal((await row("select count(*)::int as n from public.crm_site_inquiries")).n, 0);
  assert.deepEqual((await erase(body, { role: "admin" })).payload,
    { success: true, data: { deleted: true, receiptsDeleted: 2, replayed: true } });
  assert.equal((await row("select count(*)::int as n from public.crm_site_inquiry_deletions")).n, 1);
});

test("SQL changes after preview are honored: new receipt, clinical dependency and revoked membership", async () => {
  await enable(); const body = await confirmationBody();
  await db.query("select public.accept_crm_site_inquiry('medina-test',$1,$2::jsonb)", [id(102), JSON.stringify(inquiry)]);
  assert.equal((await erase(body)).payload.code, "deletion_scope_changed");
  const fresh = await confirmationBody();
  await db.query("insert into public.deals(workspace_id,lead_id,title) values($1,$2,'Sale')", [id(1), leadId]);
  assert.equal((await erase(fresh)).payload.code, "deletion_requires_review");
  await db.query("update public.staff_users set status='inactive' where id=$1", [id(91)]);
  assert.equal((await erase(fresh)).status, 403);
  assert.equal((await row("select count(*)::int as n from public.leads")).n, 1);
  assert.equal((await row("select count(*)::int as n from public.crm_site_inquiries")).n, 3);
});

test("errors and unexpected RPC data never disclose raw diagnostics or report false success", async () => {
  const body = await confirmationBody();
  for (const message of ["PRIVATE_DATABASE_ERROR", "constructor", "__proto__", "57014", "55P03"]) {
    rpcFailure = message;
    assert.deepEqual(await erase(body), { status: 503, payload: { success: false, code: "site_deletion_unavailable" } });
  }
  rpcFailure = "";
  for (const data of [null, {}, { deleted: true, receiptsDeleted: 1, replayed: false },
    { deleted: true, receiptsDeleted: "2", replayed: false }, { deleted: true, receiptsDeleted: 2, replayed: "true" }]) {
    rpcResponse = data; assert.equal((await erase(body)).status, 503);
  }
  rpcResponse = { deleted: true, receiptsDeleted: 2, replayed: false, privateResponse: inquiry };
  assert.deepEqual((await erase(body)).payload, { success: true, data: { deleted: true, receiptsDeleted: 2, replayed: false } });
  supabase.setSupabaseServerClientFactoryForTests(() => null);
  assert.equal((await erase(body)).status, 503);
});

test("preview works without 062 but cannot offer confirmation", async () => {
  await db.exec("alter table public.crm_intake_sites drop column manual_deletion_enabled");
  const result = await call();
  assert.equal(result.status, 200);
  assert.equal(result.data?.deletionEnabled, false);
  assert.equal(result.data?.deletionAvailability, "schema_not_ready");
  assert.equal(result.data?.receiptCount, 2);
  assert.deepEqual(rpcCalls, []);
});

test("an explicit site permission allows confirmation for owner/admin without mutating scope or enabling intake", async () => {
  await enable();
  await db.query("update public.crm_intake_sites set enabled=false where id=$1", [id(10)]);
  for (const role of ["owner", "admin"]) {
    const result = await call({ role, config: { ...env, MEDINA_SITE_INTAKE_ENABLED: "false" } });
    assert.equal(result.status, 200);
    assert.equal(result.data?.deletionEnabled, true);
    assert.equal(result.data?.deletionAvailability, "confirmation_required");
    assert.equal(result.data?.confirmationRequired, true);
    assert.equal(result.data?.reviewRequired, false);
  }
  assert.deepEqual(rpcCalls, []);
  assert.equal((await row("select count(*)::int as n from public.leads")).n, 1);
  assert.equal((await row("select count(*)::int as n from public.crm_site_inquiries")).n, 2);
  assert.equal((await row("select enabled from public.crm_intake_sites where id=$1", [id(10)])).enabled, false);
  await db.query("update public.crm_intake_sites set manual_deletion_enabled=false where id=$1", [id(10)]);
  assert.equal((await call()).data?.deletionAvailability, "disabled");
});

test("schema-cache lag disables confirmation; failed or malformed permission reads never enable it", async () => {
  for (const code of ["42703", "PGRST204"]) {
    permissionOverride = { data: null, error: { code, message: "PRIVATE_DATABASE_ERROR" } };
    const result = await call();
    assert.equal(result.status, 200);
    assert.equal(result.data?.deletionAvailability, "schema_not_ready");
    assert.equal(result.data?.deletionEnabled, false);
  }
  for (const code of ["42501", "PGRST205", "57014", "TEST"]) {
    permissionOverride = { data: { manual_deletion_enabled: true }, error: { code, message: "PRIVATE_DATABASE_ERROR" } };
    assert.equal((await call()).status, 503);
  }
  for (const data of [null, {}, { manual_deletion_enabled: "true" }, { manual_deletion_enabled: 1 }]) {
    permissionOverride = { data, error: null };
    assert.equal((await call()).status, 503);
  }
  assert.deepEqual(rpcCalls, []);
});

test("known business blockers disable confirmation even when the site permission is enabled", async () => {
  await enable();
  for (const [column, value, reason] of [
    ["source", "manual", "non_site_source"], ["campaign", "Legacy campaign", "campaign_snapshot"],
    ["status", "in_progress", "progressed_stage"],
  ]) {
    await db.exec("savepoint lead_change");
    await db.query(`update public.leads set ${column}=$1,stage_id=null where id=$2`, [value, leadId]);
    const result = await call();
    assert.equal(result.status, 200);
    assert.deepEqual(result.data?.reviewReasons, [reason]);
    assert.equal(result.data?.deletionAvailability, "review_required");
    assert.equal(result.data?.deletionEnabled, false);
    await db.exec("rollback to savepoint lead_change; release savepoint lead_change");
  }
});

test("structured stage uses workspace-scoped semantics, not its display name or legacy status", async () => {
  await enable();
  const fresh = await row("select id from public.lead_stages where workspace_id=$1 and semantic_group='new' limit 1", [id(1)]);
  const progressed = await row("select id from public.lead_stages where workspace_id=$1 and semantic_group='in_progress' limit 1", [id(1)]);
  const foreign = await row("select id from public.lead_stages where workspace_id=$1 and semantic_group='new' limit 1", [id(2)]);
  await db.query("update public.leads set stage_id=$1,status='legacy-name' where id=$2", [fresh.id, leadId]);
  assert.equal((await call()).data?.deletionEnabled, true);
  for (const stage of [progressed, foreign]) {
    await db.query("update public.leads set stage_id=$1,status='new' where id=$2", [stage.id, leadId]);
    const result = await call();
    assert.deepEqual(result.data?.reviewReasons, ["progressed_stage"]);
    assert.equal(result.data?.deletionEnabled, false);
  }
  failedTable = "lead_stages";
  assert.equal((await call()).status, 503);
});

test("uppercase stored audit references still block confirmation without exposing history", async () => {
  await enable();
  await db.query("insert into public.audit_logs(workspace_id,action,entity_type,entity_id) values($1,'updated','lead',$2)", [id(1), leadId.toUpperCase()]);
  const result = await call();
  assert.deepEqual(result.data?.reviewReasons, ["audit_history"]);
  assert.equal(result.data?.deletionEnabled, false);
});

test("permission revoked after preview is rechecked by confirmation RPC", async () => {
  await enable();
  assert.equal((await call()).data?.deletionEnabled, true);
  const body = await confirmationBody();
  await db.query("update public.crm_intake_sites set manual_deletion_enabled=false where id=$1", [id(10)]);
  assert.equal((await erase(body)).payload.code, "site_deletion_disabled");
  assert.equal((await row("select count(*)::int as n from public.leads")).n, 1);
  assert.equal((await row("select count(*)::int as n from public.crm_site_inquiries")).n, 2);
});

test("late public-form retry after confirmed erasure returns safe 409 without recreating data", async () => {
  await enable();
  assert.equal((await erase(await confirmationBody())).status, 200);
  supabase.setSupabaseServerClientFactoryForTests(() => ({
    async rpc(name: string, args: Record<string, unknown>) {
      assert.equal(name, "accept_crm_site_inquiry");
      await db.exec("savepoint late_retry");
      try {
        const result = await row("select public.accept_crm_site_inquiry($1,$2,$3) as result", [args.p_site_key, args.p_request_key, args.p_inquiry]);
        await db.exec("release savepoint late_retry");
        return { data: result.result, error: null };
      } catch (error) {
        await db.exec("rollback to savepoint late_retry; release savepoint late_retry");
        return { data: null, error: { message: error instanceof Error ? error.message : "PRIVATE_DATABASE_ERROR" } };
      }
    },
  }));
  const intake = await load("lib/crm/site-intake-handler.ts");
  const handler = intake.createSiteIntakeHandler({ env: () => ({ MEDINA_SITE_INTAKE_ENABLED: "true",
    MEDINA_SITE_ORIGIN: "https://site.example.invalid", MEDINA_SITE_INTAKE_KEY: "medina-test", MEDINA_SITE_TURNSTILE_SECRET: "fixture" }), verify: async () => true });
  let status = 0, payload: unknown;
  const res = { setHeader() {}, status(value: number) { status = value; return res; }, json(value: unknown) { payload = value; } };
  await handler({ method: "POST", headers: { origin: "https://site.example.invalid", "content-type": "application/json" },
    body: { requestKey: id(100), inquiry, challengeToken: "fixture" } }, res);
  assert.equal(status, 409);
  assert.deepEqual(payload, { success: false, code: "inquiry_erased" });
  assert.equal((await row("select count(*)::int as n from public.leads")).n, 0);
  assert.equal((await row("select count(*)::int as n from public.crm_site_inquiries")).n, 0);
});

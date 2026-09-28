import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { before, after, beforeEach, afterEach } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const db = new PGlite();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, params)).rows[0];
const inquiry = { name: "Private contact", phone: "+77071234567", business: "Private business", service: "call-center", pagePath: "/ru/", consentVersion: "v1", consent: true };
const submit = (key: number, site = "medina-test") => db.query("select public.accept_crm_site_inquiry($1,$2,$3)", [site, id(key), inquiry]);
let leadId: string, stamp: string, receipts: string[];
const migration = await readFile(path.join(root, "migrations/062_site_inquiry_manual_deletion.sql"), "utf8");
async function rejects(fn: () => Promise<unknown>, expected: RegExp) {
  await db.exec("savepoint refused");
  await assert.rejects(fn, expected);
  await db.exec("rollback to savepoint refused; release savepoint refused");
}
const enable = () => db.query("update public.crm_intake_sites set manual_deletion_enabled=true where id=$1", [id(10)]);
async function erase(options: { workspace?: string; site?: string; lead?: string; receipts?: unknown; stamp?: string; staff?: string; user?: string; key?: string; confirm?: boolean | null } = {}) {
  return (await row("select public.delete_crm_site_inquiry($1,$2,$3,$4,$5,$6,$7,$8,$9) as result", [
    options.workspace ?? id(1), options.site ?? "medina-test", options.lead ?? leadId,
    options.receipts === undefined ? receipts : options.receipts, options.stamp ?? stamp,
    options.staff ?? id(20), options.user ?? id(30), options.key ?? id(200),
    options.confirm === undefined ? true : options.confirm,
  ])).result as Record<string, unknown>;
}
async function assertUnchanged() {
  assert.equal((await row("select count(*)::int as n from public.leads where id=$1", [leadId])).n, 1);
  assert.equal((await row("select count(*)::int as n from public.crm_site_inquiries where lead_id=$1", [leadId])).n, receipts.length);
  assert.equal((await row("select count(*)::int as n from public.crm_site_inquiry_deletions")).n, 0);
  assert.equal((await row("select count(*)::int as n from public.crm_site_inquiry_erased_requests")).n, 0);
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
  await db.exec(migration); await db.exec(migration);
  await db.query("insert into public.staff_users(id,workspace_id,auth_user_id,full_name,email,role) values($1,$2,$3,'Owner','owner@example.invalid','owner'),($4,$2,$5,'Admin','admin@example.invalid','admin')", [id(20), id(1), id(30), id(21), id(31)]);
});
beforeEach(async () => {
  await db.exec("begin");
  await submit(100); await submit(101);
  const saved = await row("select id, updated_at::text as stamp from public.leads where workspace_id=$1", [id(1)]);
  leadId = String(saved.id); stamp = String(saved.stamp);
  receipts = (await db.query<{ id: string }>("select id from public.crm_site_inquiries where lead_id=$1 order by id", [leadId])).rows.map(row => row.id);
});
afterEach(() => db.exec("rollback"));
after(() => db.close());

test("migration is idempotent, leaves intake enabled and manual deletion disabled on every site", async () => {
  assert.deepEqual((await db.query("select enabled,manual_deletion_enabled from public.crm_intake_sites order by site_key")).rows,
    [{ enabled: true, manual_deletion_enabled: false }, { enabled: true, manual_deletion_enabled: false }]);
  await rejects(() => erase(), /site_deletion_disabled/);
  await assertUnchanged();
});

test("server role with verified owner deletes both copies, not same-phone other workspace or old orphan", async () => {
  await enable(); await submit(102, "other-test");
  await db.query("insert into public.crm_site_inquiries(site_id,request_key,inquiry) values($1,$2,$3)", [id(10), id(103), inquiry]);
  await db.exec("set local role service_role");
  assert.deepEqual(await erase(), { deleted: true, receiptsDeleted: 2, replayed: false });
  await db.exec("reset role");
  assert.equal((await row("select count(*)::int as n from public.leads where workspace_id=$1", [id(1)])).n, 0);
  assert.equal((await row("select count(*)::int as n from public.leads where workspace_id=$1", [id(2)])).n, 1);
  assert.equal((await row("select count(*)::int as n from public.crm_site_inquiries where site_id=$1 and lead_id is null", [id(10)])).n, 1);
  const safe = JSON.stringify((await db.query("select * from public.crm_site_inquiry_deletions")).rows);
  for (const value of Object.values(inquiry).filter(value => typeof value === "string")) assert.ok(!safe.includes(value));
});

test("admin can confirm without owner cosignature; intake may be disabled", async () => {
  await enable(); await db.query("update public.crm_intake_sites set enabled=false where id=$1", [id(10)]);
  assert.equal((await erase({ staff: id(21), user: id(31) })).deleted, true);
});

test("explicit confirmation, exact nonempty bounded receipt list and version are mandatory", async () => {
  await enable();
  for (const confirm of [false, null]) await rejects(() => erase({ confirm }), /invalid_deletion_request/);
  for (const value of [null, [], [null], [receipts[0], receipts[0]], Array(201).fill(receipts[0])]) {
    await rejects(() => erase({ receipts: value }), /invalid_deletion_request/);
  }
  await rejects(() => erase({ stamp: "infinity" }), /invalid_deletion_request/);
  await rejects(() => erase({ receipts: [receipts[0]] }), /deletion_scope_changed/);
  await rejects(() => erase({ stamp: "2000-01-01T00:00:00Z" }), /deletion_scope_changed/);
  await assertUnchanged();
});

test("role, active membership, actor identity and workspace are rechecked inside SQL", async () => {
  await enable();
  await rejects(() => erase({ user: id(31) }), /workspace_access_denied/);
  await rejects(() => erase({ workspace: id(2) }), /workspace_access_denied/);
  await rejects(() => erase({ site: "other-test" }), /site_deletion_disabled/);
  for (const role of ["doctor", "receptionist"]) {
    await db.query("update public.staff_users set role=$1 where id=$2", [role, id(20)]);
    await rejects(() => erase(), /workspace_access_denied/);
  }
  await db.query("update public.staff_users set role='owner',status='inactive' where id=$1", [id(20)]);
  await rejects(() => erase(), /workspace_access_denied/);
  await assertUnchanged();
});

test("lost response retry is idempotent; reused request key with different scope fails", async () => {
  await enable(); await erase();
  assert.deepEqual(await erase({ receipts: [...receipts].reverse() }), { deleted: true, receiptsDeleted: 2, replayed: true });
  await rejects(() => erase({ receipts: [receipts[0]] }), /deletion_request_conflict/);
  await rejects(() => erase({ key: id(201) }), /site_inquiry_not_found/);
  assert.equal((await row("select count(*)::int as n from public.crm_site_inquiry_deletions")).n, 1);
  await db.query("update public.staff_users set status='inactive' where id=$1", [id(20)]);
  await rejects(() => erase(), /workspace_access_denied/);
});

test("a new form receipt before execution invalidates the entire confirmation", async () => {
  await enable(); await submit(102);
  await rejects(() => erase(), /deletion_scope_changed/);
  assert.equal((await row("select count(*)::int as n from public.crm_site_inquiries")).n, 3);
  assert.equal((await row("select count(*)::int as n from public.leads")).n, 1);
  await db.query("insert into public.crm_site_inquiries(site_id,request_key,lead_id,inquiry) select $1,gen_random_uuid(),$2,$3 from generate_series(1,198)", [id(10), leadId, inquiry]);
  const partial = (await db.query<{ id: string }>("select id from public.crm_site_inquiries where lead_id=$1 order by id limit 200", [leadId])).rows.map(row => row.id);
  await rejects(() => erase({ receipts: partial }), /deletion_scope_changed/);
  assert.equal((await row("select count(*)::int as n from public.crm_site_inquiries")).n, 201);
});

test("late retries cannot resurrect erased submissions; genuinely new consent is allowed", async () => {
  await enable(); await erase();
  for (const key of [100, 101]) await rejects(() => submit(key), /inquiry_erased/);
  assert.equal((await row("select count(*)::int as n from public.leads")).n, 0);
  assert.equal((await row("select count(*)::int as n from public.crm_site_inquiries")).n, 0);
  await submit(102);
  const fresh = await row("select id from public.leads"); assert.notEqual(fresh.id, leadId);
  // Old deletion replay must never touch a later lead from the same person.
  assert.equal((await erase()).replayed, true);
  assert.equal((await row("select count(*)::int as n from public.leads")).n, 1);
});

test("lead edit after inspection and cross-site receipt both require fresh handling", async () => {
  await enable();
  await db.query("update public.leads set updated_at=updated_at+interval '1 second' where id=$1", [leadId]);
  await rejects(() => erase(), /deletion_scope_changed/);
  stamp = String((await row("select updated_at::text as stamp from public.leads where id=$1", [leadId])).stamp);
  await db.query("insert into public.crm_site_inquiries(site_id,request_key,lead_id,inquiry) values($1,$2,$3,$4)", [id(11), id(103), leadId, inquiry]);
  await rejects(() => erase(), /deletion_requires_review/);
});

test("linked clients, audit and inbound FK rows never cascade into ordinary erasure", async () => {
  await enable();
  for (const sql of [
    `insert into public.clients(id,workspace_id,full_name) values('${id(50)}','${id(1)}','Client'); update public.leads set client_id='${id(50)}' where id='${leadId}'`,
    `insert into public.audit_logs(workspace_id,action,entity_type,entity_id) values('${id(1)}','updated','lead',upper('${leadId}'))`,
    `insert into public.deals(workspace_id,lead_id,title) values('${id(1)}','${leadId}','Sale')`,
    `insert into public.tasks(workspace_id,lead_id,title) values('${id(1)}','${leadId}','Task')`,
    `insert into public.wazzup_inbound_messages(workspace_id,lead_id,message_id,channel_id) values('${id(1)}','${leadId}','message','channel')`,
  ]) {
    await db.exec("savepoint linked"); await db.exec(sql);
    await rejects(() => erase(), /deletion_requires_review/);
    await assertUnchanged(); await db.exec("rollback to savepoint linked; release savepoint linked");
  }
});

test("unknown future composite FK is also refused without exposing table or contact names", async () => {
  await enable();
  await db.exec("create table public.fixture_future_link(lead_id uuid, workspace_id uuid, foreign key(lead_id,workspace_id) references public.leads(id,workspace_id) on delete cascade)");
  await db.query("insert into public.fixture_future_link values($1,$2)", [leadId, id(1)]);
  await rejects(() => erase(), /^error: deletion_requires_review$/);
  await assertUnchanged();
});

test("manual source/campaign and progressed pipeline are outside ordinary site erasure", async () => {
  await enable();
  for (const change of ["source=null", "campaign='Campaign'", "stage_id=null,status='contacted'",
    `stage_id=(select id from public.lead_stages where workspace_id='${id(1)}' and semantic_group <> 'new' limit 1)`]) {
    await db.exec("savepoint changed");
    await db.query(`update public.leads set ${change} where id=$1`, [leadId]);
    await rejects(() => erase(), /deletion_requires_review/);
    await assertUnchanged();
    await db.exec("rollback to savepoint changed; release savepoint changed");
  }
});

test("error after deletes rolls back lead, all consents, tombstones and completion receipt", async () => {
  await enable();
  await db.exec("alter table public.crm_site_inquiry_deletions add constraint simulate_storage_failure check(false) not valid");
  await rejects(() => erase(), /simulate_storage_failure/);
  await assertUnchanged();
});

test("browser roles cannot execute RPC or read/write completion and replay metadata", async () => {
  const signature = "public.delete_crm_site_inquiry(uuid,text,uuid,uuid[],timestamptz,uuid,uuid,uuid,boolean)";
  for (const role of ["anon", "authenticated"]) {
    assert.equal((await row("select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, signature])).allowed, false);
    for (const table of ["crm_site_inquiry_deletions", "crm_site_inquiry_erased_requests"]) {
      assert.equal((await row("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') as allowed", [role, `public.${table}`])).allowed, false);
    }
  }
  assert.equal((await row("select has_function_privilege('service_role',$1,'EXECUTE') as allowed", [signature])).allowed, true);
});

test("same site lock as intake, parent lock and fixed search path remain part of the contract", async () => {
  const intake = await readFile(path.join(root, "migrations/058_public_site_intake_foundation.sql"), "utf8");
  assert.match(intake, /crm_intake_sites where site_key = p_site_key for update/);
  assert.match(migration, /workspace_id = p_workspace_id and site_key = p_site_key for update/);
  assert.match(migration, /public\.leads where id = p_lead_id and workspace_id = p_workspace_id for update/);
  assert.match(migration, /security definer set search_path = '' set lock_timeout = '3s'/);
  // PGlite is single-session: this checks the locking contract, not a real
  // multi-connection contention test. That remains a release prerequisite.
});

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { before, after, beforeEach, afterEach } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { validateSiteInquiry } = await import(pathToFileURL(path.join(root, "lib/crm/site-intake.ts")).href) as {
  validateSiteInquiry(value: unknown): { ok: true; data: { phone: string; name: string } } | { ok: false; code: string };
};
const db = new PGlite();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const valid = { name: "Test", phone: "+77071234567", business: "Test salon", service: "call-center", pagePath: "/ru/", consentVersion: "v1", consent: true };
const row = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, params)).rows[0];
const submit = (key = 100, body: unknown = valid, site = "medina-test") =>
  row("select public.accept_crm_site_inquiry($1,$2,$3::jsonb) as result", [site, id(key), JSON.stringify(body)]);
async function rejects(fn: () => Promise<unknown>, pattern: RegExp) {
  await db.exec("savepoint expected_error");
  await assert.rejects(fn, pattern);
  await db.exec("rollback to savepoint expected_error; release savepoint expected_error");
}

before(async () => {
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to anon, authenticated, service_role;");
  const selected = new Set([9, 10, 11, 12, 13, 14, 19, 58]);
  for (const file of (await readdir(path.join(root, "migrations"))).sort()) {
    if (!selected.has(Number(file.slice(0, 3)))) continue;
    await db.exec((await readFile(path.join(root, "migrations", file), "utf8")).replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/i, ""));
  }
  // Migration is safe to reapply and does not provision/enable any sites.
  await db.exec(await readFile(path.join(root, "migrations/058_public_site_intake_foundation.sql"), "utf8"));
  assert.equal((await row("select count(*)::int as n from public.crm_intake_sites")).n, 0);
  await db.exec(`insert into public.workspaces(id,name) values('${id(1)}','Marketing'),('${id(2)}','Other');
    insert into public.crm_intake_sites(site_key,workspace_id,consent_version,allowed_page_paths,enabled)
      values('medina-test','${id(1)}','v1',array['/ru/'],true),
            ('other-test','${id(2)}','v1',array['/ru/'],true),
            ('closed-test','${id(1)}','v1',array['/ru/'],false);`);
});
after(() => db.close());
beforeEach(() => db.exec("begin"));
afterEach(() => db.exec("rollback"));

test("validation normalizes existing phone format and excludes visitor tenant/IDs/raw URLs", () => {
  const result = validateSiteInquiry({ ...valid, phone: "8 (707) 123-45-67", name: " Test " });
  assert.equal(result.ok, true);
  if (result.ok) { assert.equal(result.data.phone, valid.phone); assert.equal(result.data.name, "Test"); }
  for (const body of [null, [], { ...valid, workspaceId: id(2) }, { ...valid, leadId: id(5) },
    { ...valid, consent: "true" }, { ...valid, phone: "call 77071234567" },
    { ...valid, pagePath: "/ru/?phone=123" }, { ...valid, pagePath: "https://example.invalid/" },
    { ...valid, service: "unknown" }, { ...valid, name: "<script>" }, { ...valid, business: "x".repeat(161) }]) {
    assert.equal(validateSiteInquiry(body).ok, false);
  }
});

test("server-selected workspace, structured taxonomy and consent receipt are saved atomically", async () => {
  assert.deepEqual((await submit()).result, { accepted: true });
  const lead = await row("select * from public.leads");
  assert.equal(lead.workspace_id, id(1));
  assert.equal(lead.phone, valid.phone);
  assert.equal(lead.source, "website");
  assert.ok(lead.stage_id); assert.ok(lead.source_id);
  const receipt = await row("select * from public.crm_site_inquiries");
  assert.equal(receipt.lead_id, lead.id);
  assert.deepEqual(receipt.inquiry, valid);
  assert.ok(receipt.consent_received_at);
});

test("same request is idempotent; changed payload with reused key fails", async () => {
  await submit(); await submit();
  assert.equal((await row("select count(*)::int as n from public.leads")).n, 1);
  assert.equal((await row("select count(*)::int as n from public.crm_site_inquiries")).n, 1);
  await rejects(() => submit(100, { ...valid, name: "Other" }), /request_conflict/);
});

test("repeated form with a new key reuses only a recent matching site lead", async () => {
  await submit(); await submit(101);
  assert.equal((await row("select count(*)::int as n from public.leads")).n, 1);
  await submit(102, valid, "other-test");
  assert.equal((await row("select count(*)::int as n from public.leads")).n, 2);
  await submit(103, { ...valid, business: "Other business" });
  assert.equal((await row("select count(*)::int as n from public.leads")).n, 3);
});

test("disabled/unknown sites and unapproved paths/consent cannot create leads", async () => {
  await rejects(() => db.exec("update public.crm_intake_sites set allowed_page_paths=array[null]::text[] where site_key='medina-test'"), /check constraint/);
  await rejects(() => submit(100, valid, "closed-test"), /site_unavailable/);
  await rejects(() => submit(100, valid, "missing-test"), /site_unavailable/);
  for (const body of [{ ...valid, workspaceId: id(2) }, { ...valid, consent: false },
    { ...valid, consentVersion: "old" }, { ...valid, pagePath: "/ru/other/" },
    { ...valid, phone: null }, { ...valid, name: 42 }, { ...valid, phone: "87071234567" }]) {
    await rejects(() => submit(100, body), /invalid_inquiry/);
  }
  assert.equal((await row("select count(*)::int as n from public.leads")).n, 0);
});

test("durable phone rate limit survives new request keys while exact retry remains safe", async () => {
  await db.exec("update public.crm_intake_sites set phone_daily_limit=1 where site_key='medina-test'");
  await submit(); await submit();
  await rejects(() => submit(101), /intake_rate_limited/);
  assert.equal((await row("select count(*)::int as n from public.crm_site_inquiries")).n, 1);
});

test("site-wide rate limit also bounds different phones", async () => {
  await db.exec("update public.crm_intake_sites set hourly_limit=1 where site_key='medina-test'");
  await submit();
  await rejects(() => submit(101, { ...valid, phone: "+77071234568" }), /intake_rate_limited/);
});

test("receipt failure rolls back lead creation", async () => {
  await db.exec("alter table public.crm_site_inquiries add constraint test_failure check (false) not valid");
  await rejects(() => submit(), /test_failure/);
  assert.equal((await row("select count(*)::int as n from public.leads")).n, 0);
});

test("historical CRM lead is never overwritten or silently merged", async () => {
  await db.query("insert into public.leads(id,workspace_id,full_name,phone,notes) values($1,$2,'Existing',$3,'Keep')", [id(90), id(1), valid.phone]);
  await submit();
  assert.equal((await row("select count(*)::int as n from public.leads")).n, 2);
  assert.equal((await row("select notes from public.leads where id=$1", [id(90)])).notes, "Keep");
});

test("anon and authenticated cannot read receipts or execute intake RPC", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set local role ${role}`);
    await rejects(() => submit(), /permission denied/);
    await rejects(() => row("select * from public.crm_site_inquiries"), /permission denied/);
    await db.exec("reset role");
  }
  await db.exec("set local role service_role");
  assert.deepEqual((await submit()).result, { accepted: true });
  await db.exec("reset role");
});

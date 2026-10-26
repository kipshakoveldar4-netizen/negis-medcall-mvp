import assert from "node:assert/strict";
import test, { before, after, beforeEach, afterEach } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
const { parseContributorApplication, parseContributorProfile, publicPortfolioUrl } = await import(new URL("../../lib/crm/contributor-contracts.ts", import.meta.url).href);

const db = new PGlite();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const migration = await readFile(new URL("../../migrations/105_contributor_applications.sql", import.meta.url), "utf8");
async function apply(actor = 1, partner = true, creator = true) {
  return (await db.query<{ value: Record<string, unknown> }>("select public.apply_growth_contributor($1,$2,$3,$4,$5) value", [id(actor), "QA Blogger", partner, creator, ["https://example.com/portfolio"]])).rows[0].value;
}
async function review(row: Record<string, unknown>, role = "partner", action = "approve") {
  return (await db.query<{ value: Record<string, unknown> }>("select public.review_growth_contributor($1,$2,$3,$4,$5) value", [row.id, row.revision, id(90), role, action])).rows[0].value;
}
async function rejects(run: () => Promise<unknown>, error: RegExp) {
  await db.exec("savepoint denied"); await assert.rejects(run, error); await db.exec("rollback to savepoint denied; release savepoint denied");
}
before(async () => {
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to anon,authenticated,service_role;");
  await db.exec(migration); await db.exec(migration);
});
after(async () => { await db.close(); });
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });

test("both requested roles start pending in one profile, without clinic/financial objects", async () => {
  const row = await apply();
  assert.equal(row.partner_status, "pending"); assert.equal(row.creator_status, "pending");
  const names = (await db.query<{ tablename: string }>("select tablename from pg_tables where schemaname='public'")).rows.map(r => r.tablename);
  assert.deepEqual(names, ["growth_contributor_profiles"]);
});
test("repeated application preserves identity, links, review and revision", async () => {
  const first = await apply(); const approved = await review(first);
  const replay = (await db.query<{ value: Record<string, unknown> }>("select public.apply_growth_contributor($1,'Different',true,true,'{}') value", [id(1)])).rows[0].value;
  assert.deepEqual(replay, approved);
});
test("second role is additive, does not reset approved or suspended first role", async () => {
  const first = await apply(1, true, false);
  const suspended = await review(await review(first), "partner", "suspend");
  const second = await apply();
  assert.equal(second.partner_status, "suspended"); assert.equal(second.creator_status, "pending");
  assert.notEqual(second.revision, suspended.revision);
});
test("separate role approvals reject stale review; suspension never changes the other role", async () => {
  const row = await apply(), partner = await review(row);
  await rejects(() => review(row, "creator"), /contributor_review_changed/);
  const both = await review(partner, "creator");
  const suspended = await review(both, "partner", "suspend");
  assert.equal(suspended.creator_status, "approved"); assert.equal(suspended.partner_status, "suspended");
  assert.equal(suspended.partner_reviewed_by, id(90));
});
test("unrequested role, wrong id, missing actor and invalid actions fail closed", async () => {
  const row = await apply(1, false, true);
  await rejects(() => review(row), /contributor_review_changed/);
  await rejects(() => review({ ...row, id: id(999) }, "creator"), /contributor_review_changed/);
  await rejects(() => review(row, "owner"), /invalid_contributor_review/);
  await rejects(() => db.query("select public.apply_growth_contributor(null,'QA',true,true,'{}')"), /invalid_contributor_application/);
});
test("database rejects empty roles and oversized portfolio", async () => {
  await rejects(() => apply(1, false, false), /invalid_contributor_application/);
  await rejects(() => db.query("select public.apply_growth_contributor($1,'QA',true,true,$2)", [id(1), Array(6).fill("https://example.com")]), /invalid_contributor_application/);
});
test("browser roles cannot read, insert or execute application/review functions", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set local role ${role}`);
    await rejects(() => db.query("select * from public.growth_contributor_profiles"), /permission denied/);
    await rejects(() => apply(), /permission denied/);
    await rejects(() => review({ id: id(1), revision: id(2) }), /permission denied/);
    await db.exec("reset role");
  }
  assert.equal((await db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where oid='public.growth_contributor_profiles'::regclass")).rows[0].relrowsecurity, true);
});
test("service can use RPC and read, but cannot bypass it with direct write", async () => {
  await db.exec("set local role service_role");
  await apply();
  assert.equal((await db.query("select id from public.growth_contributor_profiles")).rows.length, 1);
  await rejects(() => db.query("update public.growth_contributor_profiles set partner_status='approved'"), /permission denied/);
});
test("profiles for independent auth actors remain separate", async () => {
  const a = await apply(1), b = await apply(2);
  assert.notEqual(a.id, b.id);
  await review(a);
  const ownB = (await db.query<{ creator_status: string; partner_status: string }>("select creator_status,partner_status from public.growth_contributor_profiles where auth_user_id=$1", [id(2)])).rows[0];
  assert.deepEqual(ownB, { creator_status: "pending", partner_status: "pending" });
});

const application = { displayName: "QA", partner: true, creator: true, portfolioUrls: ["https://example.com/portfolio"] };
test("application contract accepts both roles and rejects identity, status and financial injection", () => {
  assert.deepEqual(parseContributorApplication(application), application);
  for (const key of ["auth_user_id", "id", "partnerStatus", "approved_by", "workspaceId", "firstCommissionBps"]) assert.equal(parseContributorApplication({ ...application, [key]: "injected" }), null);
  assert.equal(parseContributorApplication({ ...application, partner: false, creator: false }), null);
  assert.equal(parseContributorApplication({ ...application, portfolioUrls: [...application.portfolioUrls, ...application.portfolioUrls] }), null);
});
test("portfolio permits public HTTPS links, rejects credentials, unsafe schemes and local addresses", () => {
  assert.equal(publicPortfolioUrl("https://www.instagram.com/qa/"), "https://www.instagram.com/qa/");
  for (const url of ["javascript:alert(1)", "http://example.com", "https://name:secret@example.com/", "https://127.0.0.1/", "https://localhost/", "https://a.internal/", "https://[::1]/", "https://example.com:444/", "https://example.com/\n"]) assert.equal(publicPortfolioUrl(url), null, url);
});
test("profile DTO refuses malformed status, duplicate URLs, unknown revision and unrequested profile", () => {
  const row = { id: id(1), revision: id(2), displayName: "QA", portfolioUrls: [], partnerStatus: "pending", creatorStatus: null };
  assert.deepEqual(parseContributorProfile(row), row);
  assert.equal(parseContributorProfile({ ...row, partnerStatus: "active" }), null);
  assert.equal(parseContributorProfile({ ...row, revision: "old" }), null);
  assert.equal(parseContributorProfile({ ...row, partnerStatus: null }), null);
  assert.equal(parseContributorProfile({ ...row, portfolioUrls: ["https://example.com/", "https://example.com/"] }), null);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before, after, beforeEach, afterEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { commissionMinor, readMinor, summarizePartnerLedger } = await import(
  pathToFileURL(path.join(root, "lib/crm/growth.ts")).href
);
const db = new PGlite(); // In memory only. No DATABASE_URL or production credentials.
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const nowPaid = "2026-01-01T12:00:00Z";

async function row(sql: string, params: unknown[] = []) {
  return (await db.query<Record<string, unknown>>(sql, params)).rows[0];
}
async function bind(workspace = 1, code = "PARTNER_A", source = "link") {
  return row("select public.bind_growth_referral($1, $2, $3) as value", [id(workspace), code, source]);
}
async function pay(key = 1001, workspace = 1, subscription = 601, amount = "100000", currency = "KZT", paidAt = nowPaid) {
  return row("select public.confirm_growth_subscription_payment($1, $2, $3, $4, $5, $6, $7) as value",
    [id(workspace), id(subscription), amount, currency, paidAt, id(key), id(900)]);
}
async function payout(key = 2001, amount = "10000", partner = 301, currency = "KZT") {
  return row("select public.confirm_growth_partner_payout($1, $2, $3, $4, $5, $6) as value",
    [id(partner), amount, currency, nowPaid, id(key), id(900)]);
}
async function accept(request = 801, operatorUser = 201) {
  return row("select public.accept_growth_operator_request($1, $2) as value", [id(request), id(operatorUser)]);
}
async function arrive(request = 801, appointment = 501, staff = 101) {
  return row("select public.confirm_growth_operator_arrival($1, $2, $3) as value", [id(request), id(appointment), id(staff)]);
}

before(async () => {
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to service_role;");
  for (const filename of ["009_medcall_mvp_persistence.sql", "010_staff_ready_crm.sql", "011_staff_auth_foundation.sql", "034_platform_subscriptions.sql", "052_operators_and_partner_ledger.sql"]) {
    const sql = await readFile(path.join(root, "migrations", filename), "utf8");
    // gen_random_uuid is built in. PGlite does not need the pgcrypto extension.
    await db.exec(sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/i, ""));
  }
  // Rerunning the additive migration must preserve data and privileges.
  await db.exec(await readFile(path.join(root, "migrations/052_operators_and_partner_ledger.sql"), "utf8"));
  await db.exec(await readFile(path.join(root, "migrations/053_operator_request_lifecycle.sql"), "utf8"));
  await db.exec(await readFile(path.join(root, "migrations/053_operator_request_lifecycle.sql"), "utf8"));
  await db.exec(`
    insert into public.workspaces(id, name) values
      ('${id(1)}', 'Clinic A'), ('${id(2)}', 'Clinic B'), ('${id(3)}', 'Clinic C');
    insert into public.staff_users(id, workspace_id, auth_user_id, email, full_name, role) values
      ('${id(101)}','${id(1)}','${id(401)}','owner-a@example.invalid','Owner A','owner'),
      ('${id(102)}','${id(2)}','${id(402)}','owner-b@example.invalid','Owner B','owner'),
      ('${id(103)}','${id(1)}','${id(201)}','operator@example.invalid','Operator','receptionist'),
      ('${id(104)}','${id(1)}','${id(404)}','desk@example.invalid','Reception','receptionist');
    insert into public.appointments(id,workspace_id,client_name) values
      ('${id(501)}','${id(1)}','Test A'),('${id(502)}','${id(2)}','Test B');
    insert into public.platform_subscriptions(id,workspace_id,plan,price_minor,currency) values
      ('${id(601)}','${id(1)}','basic',100000,'KZT'),
      ('${id(602)}','${id(2)}','basic',100000,'KZT'),
      ('${id(603)}','${id(3)}','basic',100000,'USD');
    insert into public.growth_partners(id,auth_user_id,display_name,referral_code,first_commission_bps,renewal_commission_bps) values
      ('${id(301)}','${id(901)}','Partner A','PARTNER_A',1000,500),
      ('${id(302)}','${id(902)}','Partner B','PARTNER_B',5000,1000);
    insert into public.growth_operator_profiles(id,auth_user_id,display_name,status,accepting_requests,approved_by,approved_at) values
      ('${id(701)}','${id(201)}','Operator A','approved',true,'${id(900)}',now()),
      ('${id(702)}','${id(202)}','Operator B','pending',false,null,null),
      ('${id(703)}','${id(203)}','Operator C','approved',true,'${id(900)}',now());
    insert into public.growth_operator_requests(id,workspace_id,operator_id,requested_by_staff_user_id,clinic_brief,price_per_arrival_minor) values
      ('${id(801)}','${id(1)}','${id(701)}','${id(101)}','Clinic A request',50000),
      ('${id(802)}','${id(2)}','${id(701)}','${id(102)}','Clinic B request',70000),
      ('${id(803)}','${id(1)}','${id(703)}','${id(101)}','Clinic A second operator',60000);
  `);
});
after(async () => { await db.close(); });
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });

// A rejected statement aborts PostgreSQL's transaction; keep assertions isolated.
async function rejects(operation: () => Promise<unknown>, expected: RegExp) {
  await db.exec("savepoint expected_failure");
  await assert.rejects(operation, expected);
  await db.exec("rollback to savepoint expected_failure; release savepoint expected_failure");
}

test("first link or promo binding survives every later referral", async () => {
  assert.equal((await bind(1, "partner_a", "promo_code")).value, id(301));
  assert.equal((await bind(1, "PARTNER_B")).value, id(301));
  const referral = await row("select * from public.growth_referrals where workspace_id=$1", [id(1)]);
  assert.equal(referral.source, "promo_code");
  assert.equal(referral.partner_id, id(301));
});

test("registration and an active subscription do not create income", async () => {
  await bind();
  assert.equal((await row("select count(*)::int as n from public.platform_subscription_payments")).n, 0);
  assert.equal((await row("select count(*)::int as n from public.growth_partner_commissions")).n, 0);
});

test("first and renewal payment use separate configured rates and the same partner", async () => {
  await bind();
  await pay();
  await bind(1, "PARTNER_B");
  await pay(1002);
  const receipts = await db.query("select p.kind,c.partner_id,c.rate_bps,c.amount_minor::text from public.platform_subscription_payments p join public.growth_partner_commissions c on c.payment_id=p.id order by p.kind");
  assert.deepEqual(receipts.rows, [
    { kind: "first", partner_id: id(301), rate_bps: 1000, amount_minor: "10000" },
    { kind: "renewal", partner_id: id(301), rate_bps: 500, amount_minor: "5000" },
  ]);
});

test("payment retry is idempotent and changed retry is rejected", async () => {
  await bind();
  assert.deepEqual(await pay(), await pay());
  await rejects(() => pay(1001, 1, 601, "200000"), /payment_request_conflict/);
  assert.equal((await row("select count(*)::int as n from public.growth_partner_commissions")).n, 1);
});

test("changed tariffs do not change historical commissions; renewal follows clinic across subscription rows", async () => {
  await bind(); await pay();
  await db.exec(`update public.growth_partners set first_commission_bps=5000,renewal_commission_bps=1000 where id='${id(301)}';
    update public.platform_subscriptions set status='cancelled' where id='${id(601)}';
    insert into public.platform_subscriptions(id,workspace_id,plan) values('${id(604)}','${id(1)}','pro');`);
  await pay(1002, 1, 604);
  const receipts = await db.query("select p.kind,c.rate_bps,c.amount_minor::text from public.platform_subscription_payments p join public.growth_partner_commissions c on c.payment_id=p.id order by p.kind");
  assert.deepEqual(receipts.rows, [
    { kind: "first", rate_bps: 1000, amount_minor: "10000" },
    { kind: "renewal", rate_bps: 1000, amount_minor: "10000" },
  ]);
});

test("missing agreed commission rolls back the receipt rather than inventing a rate", async () => {
  await bind();
  await db.exec(`update public.growth_partners set first_commission_bps=null where id='${id(301)}'`);
  await rejects(() => pay(), /partner_terms_required/);
  assert.equal((await row("select count(*)::int as n from public.platform_subscription_payments")).n, 0);
});

test("payments enforce clinic, currency, chronology and positive amount", async () => {
  await rejects(() => pay(1001, 1, 602), /subscription_unavailable/);
  await rejects(() => pay(1001, 1, 601, "100000", "USD"), /subscription_unavailable/);
  await rejects(() => pay(1001, 1, 601, "0"), /payment_invalid/);
  await rejects(() => pay(1001, 1, 601, "100000", "KZT", "2999-01-01"), /payment_invalid/);
  await pay();
  await rejects(() => pay(1002, 1, 601, "100000", "KZT", "2025-01-01"), /payment_chronology_required/);
  await rejects(() => bind(), /referral_after_payment/);
});

test("no referral payment remains a receipt without a fictional commission", async () => {
  await pay();
  assert.equal((await row("select count(*)::int as n from public.platform_subscription_payments")).n, 1);
  assert.equal((await row("select count(*)::int as n from public.growth_partner_commissions")).n, 0);
});

test("bigint money and SQL commission calculation agree without rounding through Number", async () => {
  const value = "9007199254740993";
  await bind(); await pay(1001, 1, 601, value);
  const receipt = await row("select amount_minor::text as amount from public.growth_partner_commissions");
  assert.equal(receipt.amount, commissionMinor(value, 1000, "first"));
  assert.equal(receipt.amount, "900719925474099");
  assert.equal(commissionMinor("1", 1000, "first"), "0");
  assert.throws(() => commissionMinor("100", 1500, "renewal"), /invalid_commission_rate/);
  assert.throws(() => readMinor(9007199254740993), /invalid_minor_units/);
  assert.throws(() => readMinor("1.01"), /invalid_minor_units/);
});

test("payout cannot exceed balance; retries do not withdraw twice", async () => {
  await bind(); await pay();
  await rejects(() => payout(2001, "10001"), /insufficient_partner_balance/);
  const first = await payout();
  assert.deepEqual(await payout(), first);
  await rejects(() => payout(2002, "1"), /insufficient_partner_balance/);
  await rejects(() => payout(2001, "1"), /payout_request_conflict/);
});

test("KZT balance cannot pay a USD withdrawal", async () => {
  await bind(); await pay();
  await rejects(() => payout(2001, "1", 301, "USD"), /insufficient_partner_balance/);
  await bind(3); await pay(1002, 3, 603, "1000", "USD");
  await payout(2001, "100", 301, "USD");
  await payout(2002, "10000");
});

test("anonymous and authenticated browser roles cannot read or execute growth operations", async () => {
  const tables = ["growth_operator_profiles", "growth_operator_requests", "growth_operator_arrivals", "growth_partners", "growth_referrals", "platform_subscription_payments", "growth_partner_commissions", "growth_partner_payouts"];
  for (const role of ["anon", "authenticated"]) {
    for (const table of tables) {
      const result = await row("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') as allowed", [role, `public.${table}`]);
      assert.equal(result.allowed, false, `${role}/${table}`);
    }
    const functions = await db.query<{ name: string; allowed: boolean }>("select p.proname as name,has_function_privilege($1,p.oid,'EXECUTE') as allowed from pg_proc p where p.proname like '%growth%'", [role]);
    assert.equal(functions.rows.length, 7);
    assert.ok(functions.rows.every((r) => !r.allowed));
  }
});

test("service role uses functions, cannot overwrite referrals or mint receipts directly", async () => {
  await db.exec("set local role service_role");
  await bind(); await pay();
  await rejects(() => db.exec("update public.growth_referrals set source='promo_code'"), /permission denied/);
  await rejects(() => db.exec("delete from public.growth_partner_commissions"), /permission denied/);
  await rejects(() => db.exec("insert into public.platform_subscription_payments default values"), /permission denied/);
});

test("operator acceptance checks identity and approval", async () => {
  await rejects(() => accept(801, 202), /approved_operator_required/);
  await db.exec(`update public.growth_operator_profiles set status='suspended',accepting_requests=false where id='${id(701)}'`);
  await rejects(() => accept(), /approved_operator_required/);
});

test("requests cannot be created for unapproved or unavailable operators", async () => {
  await rejects(() => db.exec(`insert into public.growth_operator_requests(workspace_id,operator_id,requested_by_staff_user_id,clinic_brief)
    values('${id(1)}','${id(702)}','${id(101)}','Test')`), /operator_not_accepting_requests/);
  await db.exec(`update public.growth_operator_profiles set accepting_requests=false where id='${id(701)}'`);
  await rejects(() => db.exec(`insert into public.growth_operator_requests(workspace_id,operator_id,requested_by_staff_user_id,clinic_brief)
    values('${id(1)}','${id(701)}','${id(101)}','Test')`), /operator_not_accepting_requests/);
});

test("one approved operator may accept several clinics; acceptance is idempotent", async () => {
  assert.deepEqual(await accept(), await accept());
  await accept(802);
  assert.equal((await row("select count(*)::int as n from public.growth_operator_requests where status='accepted'")).n, 2);
  await rejects(() => db.exec(`update public.growth_operator_requests set price_per_arrival_minor=1 where id='${id(801)}'`), /accepted_terms_immutable/);
});

test("historical requester deactivation does not freeze an agreement", async () => {
  await db.exec(`update public.staff_users set status='paused' where id='${id(101)}'`);
  assert.equal((await accept()).value, id(801));
  await db.exec(`update public.growth_operator_requests set status='ended',ended_at=now() where id='${id(801)}'`);
  assert.equal((await row("select status from public.growth_operator_requests where id=$1", [id(801)])).status, "ended");
  await rejects(() => db.exec(`insert into public.growth_operator_requests(workspace_id,operator_id,requested_by_staff_user_id,clinic_brief)
    values('${id(1)}','${id(701)}','${id(101)}','New request')`), /clinic_requester_required/);
});

test("request lifecycle cannot change identity or reopen ended agreements", async () => {
  await accept();
  await rejects(() => db.exec(`update public.growth_operator_requests set workspace_id='${id(2)}' where id='${id(801)}'`), /operator_request_identity_immutable/);
  await db.exec(`update public.growth_operator_requests set status='ended',ended_at=now() where id='${id(801)}'`);
  await rejects(() => db.exec(`update public.growth_operator_requests set status='accepted',ended_at=null where id='${id(801)}'`), /operator_request_transition_invalid/);
});

test("requester and appointment must be from the request clinic", async () => {
  await rejects(() => db.exec(`insert into public.growth_operator_requests(workspace_id,operator_id,requested_by_staff_user_id,clinic_brief)
    values('${id(2)}','${id(703)}','${id(101)}','Test')`), /clinic_requester_required/);
  await accept();
  await rejects(() => arrive(801, 502), /appointment_unavailable/);
  await rejects(() => arrive(801, 501, 102), /clinic_confirmation_required/);
});

test("operator cannot substitute their call or their staff membership for clinic confirmation", async () => {
  await accept();
  await rejects(() => arrive(801, 501, 103), /clinic_confirmation_required/);
  await rejects(() => row("select public.record_growth_operator_check($1,$2,'confirmed')", [id(999),id(201)]), /arrival_unavailable/);
  assert.equal((await row("select count(*)::int as n from public.growth_operator_arrivals")).n, 0);
});

test("arrival uses agreed price and remains clinic-confirmed after a supplemental call", async () => {
  await accept();
  const receipt = await arrive();
  assert.deepEqual(await arrive(), receipt);
  await row("select public.record_growth_operator_check($1,$2,'unconfirmed')", [receipt.value,id(201)]);
  const stored = await row("select price_minor::text,clinic_confirmed_at is not null as confirmed,operator_check_result from public.growth_operator_arrivals");
  assert.deepEqual(stored, { price_minor: "50000", confirmed: true, operator_check_result: "unconfirmed" });
  await accept(803, 203);
  await rejects(() => arrive(803), /arrival_already_assigned/);
});

test("partner totals separate registrations, payments, currencies and payouts", () => {
  const summary = summarizePartnerLedger(["a", "b", "c"], [
    {paymentId:"1",workspaceId:"a",kind:"first",amountMinor:"10000",currency:"KZT"},
    {paymentId:"2",workspaceId:"a",kind:"renewal",amountMinor:"5000",currency:"KZT"},
    {paymentId:"3",workspaceId:"b",kind:"first",amountMinor:"100",currency:"USD"},
  ], [{id:"p1",amountMinor:"4000",currency:"KZT"}]);
  assert.deepEqual(summary, {registrations:3,paidClinics:2,firstPayments:2,renewals:1,balances:[
    {currency:"KZT",earnedMinor:"15000",paidMinor:"4000",availableMinor:"11000"},
    {currency:"USD",earnedMinor:"100",paidMinor:"0",availableMinor:"100"},
  ]});
  assert.deepEqual(summarizePartnerLedger(["a"], [], []), {registrations:1,paidClinics:0,firstPayments:0,renewals:0,balances:[]});
  assert.throws(() => summarizePartnerLedger([], [{paymentId:"1",workspaceId:"foreign",kind:"first",amountMinor:"1",currency:"KZT"}], []), /referral_scope_mismatch/);
  assert.throws(() => summarizePartnerLedger([], [], [{id:"1",amountMinor:"1",currency:"KZT"}]), /partner_balance_inconsistent/);
});

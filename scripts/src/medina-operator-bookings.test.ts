import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { before, after, beforeEach, afterEach } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const db = new PGlite();
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = async (sql: string, params: unknown[] = []) =>
  (await db.query<Record<string, unknown>>(sql, params)).rows[0];
const time = "2030-01-07T10:00";
async function book(
  options: {
    user?: number;
    lead?: number;
    key?: number;
    doctor?: number;
    services?: number[];
    local?: string;
    tz?: string;
  } = {},
) {
  return (
    await row(
      "select public.create_growth_operator_booking($1,$2,$3,$4,$5,$6,$7,$8) as data",
      [
        id(50),
        id(options.user ?? 20),
        id(options.lead ?? 60),
        id(options.key ?? 100),
        id(options.doctor ?? 70),
        (options.services ?? [80, 81]).map(id),
        options.local ?? time,
        options.tz ?? "Asia/Almaty",
      ],
    )
  ).data as Record<string, unknown>;
}
async function rejects(fn: () => Promise<unknown>, message: RegExp) {
  await db.exec("savepoint expected_failure");
  await assert.rejects(fn, message);
  await db.exec(
    "rollback to savepoint expected_failure; release savepoint expected_failure",
  );
}
before(async () => {
  await db.exec(
    "create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to service_role;",
  );
  const numbers = new Set([
    9, 10, 11, 12, 13, 14, 19, 20, 30, 32, 33, 34, 36, 40, 45, 52, 53, 54, 55,
    56, 57,
  ]);
  for (const file of (await readdir(path.join(root, "migrations"))).sort()) {
    if (!numbers.has(Number(file.slice(0, 3)))) continue;
    try {
      await db.exec(
        (await readFile(path.join(root, "migrations", file), "utf8")).replace(
          /CREATE EXTENSION IF NOT EXISTS pgcrypto;/i,
          "",
        ),
      );
    } catch (error) {
      throw new Error(`${file}: ${(error as Error).message}`);
    }
  }
  await db.exec(
    await readFile(
      path.join(root, "migrations/057_operator_catalog_booking.sql"),
      "utf8",
    ),
  );
  await db.exec(`
    insert into public.workspaces(id,name) values('${id(1)}','Clinic'),('${id(2)}','Foreign');
    insert into public.workspace_settings(workspace_id,key,value) values('${id(1)}','clinic_schedule','{"timeZone":"Asia/Almaty"}');
    insert into public.staff_users(id,workspace_id,auth_user_id,full_name,email,role) values('${id(10)}','${id(1)}','${id(11)}','Owner','test@example.invalid','owner');
    insert into public.growth_operator_profiles(id,auth_user_id,display_name,status,accepting_requests,approved_by,approved_at)
      values('${id(30)}','${id(20)}','Operator','approved',true,'${id(11)}',now());
    insert into public.growth_operator_requests(id,workspace_id,operator_id,requested_by_staff_user_id,clinic_brief,price_per_arrival_minor)
      values('${id(50)}','${id(1)}','${id(30)}','${id(10)}','Brief',10000);
    select public.accept_growth_operator_request('${id(50)}','${id(20)}');
    insert into public.leads(id,workspace_id,full_name,phone) values
      ('${id(60)}','${id(1)}','Patient','87000000000'),('${id(61)}','${id(1)}','Other','87000000001'),('${id(62)}','${id(2)}','Foreign','87000000002');
    select public.set_growth_operator_lead_assignment('${id(50)}','${id(60)}','${id(10)}',true);
    insert into public.clinic_doctors(id,workspace_id,full_name) values('${id(70)}','${id(1)}','Master'),('${id(71)}','${id(2)}','Foreign');
    insert into public.clinic_services(id,workspace_id,doctor_id,name,base_price_minor,duration_minutes) values
      ('${id(80)}','${id(1)}','${id(70)}','Service',100000,60),('${id(81)}','${id(1)}',null,'Shared',50000,30),
      ('${id(82)}','${id(2)}','${id(71)}','Foreign',100000,60);
    insert into public.clinic_doctor_shifts(workspace_id,doctor_id,weekday,is_working,start_minute,end_minute)
      values('${id(1)}','${id(70)}',1,true,540,1080);
  `);
});
after(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.exec("begin");
});
afterEach(async () => {
  await db.exec("rollback");
});

test("catalog booking saves all services, price, client and safe audit atomically; retry is idempotent", async () => {
  const result = await book();
  assert.equal(result.priceMinor, "150000");
  assert.equal(result.durationMinutes, 90);
  assert.equal(result.status, "scheduled");
  assert.deepEqual(await book(), result);
  const appointment = await row(
    "select * from public.appointments where id=$1",
    [id(100)],
  );
  assert.equal(appointment.service_id, null);
  assert.equal((appointment.service_items as unknown[]).length, 2);
  assert.equal(
    appointment.client_id,
    (await row("select client_id from public.leads where id=$1", [id(60)]))
      .client_id,
  );
  assert.equal(
    (await row("select count(*)::int as n from public.clients")).n,
    1,
  );
  assert.equal(
    (
      await row(
        "select count(*)::int as n from public.growth_operator_bookings",
      )
    ).n,
    1,
  );
  const audit = await row(
    "select metadata from public.audit_logs where action='operator_appointment_created'",
  );
  assert.doesNotMatch(JSON.stringify(audit), /Patient|870000|price|phone/);
  assert.equal(
    (
      await row(
        "select count(*)::int as n from public.growth_operator_arrivals",
      )
    ).n,
    0,
  );
  await rejects(() => book({ local: "2030-01-07T12:00" }), /retry_conflict/);
  await rejects(() => book({ key: 101 }), /already_exists/);
});
test("identity, assignment, workspace, suspension and ended cooperation are checked", async () => {
  await rejects(() => book({ user: 21 }), /access_denied/);
  await rejects(() => book({ lead: 61 }), /access_denied/);
  await rejects(() => book({ lead: 62 }), /access_denied/);
  await rejects(() => book({ doctor: 71 }), /doctor_unavailable/);
  await rejects(() => book({ services: [82] }), /service_unavailable/);
  await db.exec(
    "update public.growth_operator_profiles set status='suspended', accepting_requests=false",
  );
  await rejects(() => book(), /access_denied/);
  await db.exec(
    "update public.growth_operator_profiles set status='approved'; update public.growth_operator_requests set status='ended', ended_at=now()",
  );
  await rejects(() => book(), /access_denied/);
});
test("unknown price or duration blocks booking; zero price is allowed; invalid services roll back", async () => {
  await rejects(() => book({ services: [] }), /invalid/);
  await rejects(() => book({ services: [80, 80] }), /invalid/);
  await db.exec(
    "update public.clinic_services set base_price_minor=null where name='Service'",
  );
  await rejects(() => book(), /price_required/);
  assert.equal(
    (await row("select count(*)::int as n from public.clients")).n,
    0,
  );
  await db.exec(
    "update public.clinic_services set base_price_minor=0 where name='Service'",
  );
  assert.equal((await book({ services: [80] })).priceMinor, "0");
});
test("working intervals, closed windows, date override and whole visit duration are enforced", async () => {
  await rejects(() => book({ local: "2030-01-07T08:00" }), /outside_schedule/);
  await rejects(() => book({ local: "2030-01-07T17:00" }), /outside_schedule/);
  await db.exec(`insert into public.clinic_doctor_shifts(workspace_id,doctor_id,on_date,on_date_end,is_working,start_minute,end_minute)
    values('${id(1)}','${id(70)}','2030-01-07','2030-01-07',false,660,720)`);
  await rejects(() => book(), /outside_schedule/);
  assert.equal((await book({ local: "2030-01-07T12:00" })).status, "scheduled");
});
test("overnight schedule works and a full date day-off removes that day's weekly shift", async () => {
  await db.exec(
    `update public.clinic_doctor_shifts set start_minute=1320,end_minute=1560`,
  );
  assert.equal((await book({ local: "2030-01-08T00:00" })).status, "scheduled");
  await db.exec(`insert into public.clinic_doctor_shifts(workspace_id,doctor_id,on_date,on_date_end,is_working)
    values('${id(1)}','${id(70)}','2030-01-07','2030-01-07',false)`);
  await rejects(
    () => book({ key: 102, local: "2030-01-07T22:00" }),
    /outside_schedule/,
  );
});
test("busy time denies booking without exposing another patient; cancellation releases slot", async () => {
  await db.exec(`insert into public.appointments(workspace_id,client_name,doctor_id,doctor_name,starts_at,duration_minutes,status)
    values('${id(1)}','Private other patient','${id(70)}','Master','2030-01-07T05:00Z',60,'scheduled')`);
  await rejects(() => book(), /time_taken/);
  await db.exec("update public.appointments set status='cancelled'");
  assert.equal((await book()).status, "scheduled");
});
test("client phone normalization reuses existing patient", async () => {
  await db.exec(
    `insert into public.clients(id,workspace_id,full_name,phone) values('${id(90)}','${id(1)}','Existing','+7 700 000 00 00')`,
  );
  await book();
  assert.equal(
    (
      await row("select client_id from public.appointments where id=$1", [
        id(100),
      ])
    ).client_id,
    id(90),
  );
  assert.equal(
    (await row("select count(*)::int as n from public.clients")).n,
    1,
  );
});
test("missing timezone and changed timezone fail closed", async () => {
  await rejects(() => book({ tz: "UTC" }), /timezone_changed/);
  await db.exec("delete from public.workspace_settings");
  await rejects(() => book(), /schedule_required/);
});

test("ambiguous patients and a foreign existing client link never create another patient", async () => {
  await db.exec(`insert into public.clients(id,workspace_id,full_name,phone) values
    ('${id(90)}','${id(1)}','A','+77000000000'),('${id(91)}','${id(1)}','B','87000000000'),
    ('${id(92)}','${id(2)}','Foreign','+77000000000')`);
  await rejects(() => book(), /client_ambiguous/);
  assert.equal(
    (await row("select count(*)::int as n from public.clients")).n,
    3,
  );
  await db.exec(
    `update public.leads set client_id='${id(92)}' where id='${id(60)}'`,
  );
  await rejects(() => book(), /client_unavailable/);
});
test("current catalog values override cached UI values and archived services cannot be booked", async () => {
  await db.exec(
    `update public.clinic_services set base_price_minor=200000, duration_minutes=75 where id='${id(80)}'`,
  );
  const result = await book();
  assert.equal(result.priceMinor, "250000");
  assert.equal(result.durationMinutes, 105);
  await db.exec(
    `update public.clinic_services set is_active=false where id='${id(80)}'`,
  );
  await rejects(
    () => book({ key: 102, local: "2030-01-07T13:00" }),
    /service_unavailable/,
  );
  await db.exec(
    `update public.clinic_services set is_active=true, duration_minutes=null where id='${id(80)}'`,
  );
  await rejects(
    () => book({ key: 102, local: "2030-01-07T13:00" }),
    /price_required/,
  );
});
test("no configured shifts never becomes unrestricted operator booking", async () => {
  await db.exec("delete from public.clinic_doctor_shifts");
  await rejects(() => book(), /outside_schedule/);
});
test("past date, missing contact and another master's service are rejected before client creation", async () => {
  await rejects(() => book({ local: "2000-01-01T10:00" }), /invalid/);
  await db.exec(`insert into public.clinic_doctors(id,workspace_id,full_name) values('${id(72)}','${id(1)}','Other master');
    update public.clinic_services set doctor_id='${id(72)}' where id='${id(80)}'`);
  await rejects(() => book(), /service_unavailable/);
  await db.exec(`update public.leads set phone=null where id='${id(60)}'`);
  await rejects(() => book(), /contact_required/);
  assert.equal(
    (await row("select count(*)::int as n from public.clients")).n,
    0,
  );
});
test("late appointment insert failure rolls back newly created client and lead link", async () => {
  await db.exec(
    `insert into public.appointments(id,workspace_id,client_name) values('${id(100)}','${id(2)}','Foreign collision')`,
  );
  await rejects(() => book(), /duplicate key/);
  assert.equal(
    (await row("select count(*)::int as n from public.clients")).n,
    0,
  );
  assert.equal(
    (await row("select client_id from public.leads where id=$1", [id(60)]))
      .client_id,
    null,
  );
  assert.equal(
    (
      await row(
        "select count(*)::int as n from public.growth_operator_bookings",
      )
    ).n,
    0,
  );
});
test("whole-clinic scope can book an unassigned lead and respects master capacity", async () => {
  await db.exec(`insert into public.growth_operator_profiles(id,auth_user_id,display_name,status,accepting_requests,approved_by,approved_at)
    values('${id(31)}','${id(21)}','Second operator','approved',true,'${id(11)}',now());
    insert into public.growth_operator_requests(id,workspace_id,operator_id,requested_by_staff_user_id,clinic_brief,price_per_arrival_minor,lead_scope)
    values('${id(51)}','${id(1)}','${id(31)}','${id(10)}','Brief',10000,'clinic');
    select public.accept_growth_operator_request('${id(51)}','${id(21)}');
    update public.clinic_doctors set capacity=2 where id='${id(70)}';`);
  await book();
  const result = await row(
    "select public.create_growth_operator_booking($1,$2,$3,$4,$5,$6,$7,$8) as data",
    [id(51), id(21), id(61), id(101), id(70), [id(80)], time, "Asia/Almaty"],
  );
  assert.equal((result.data as Record<string, unknown>).status, "scheduled");
  assert.equal(
    (await row("select count(*)::int as n from public.appointments")).n,
    2,
  );
});
test("booking context and writes are server-only; raw catalog has no browser grants", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set local role ${role}`);
    await rejects(() => book(), /permission denied/);
    await db.exec("reset role");
  }
  await db.exec("set local role service_role");
  const context = await row("select public.read_growth_operator_booking_context($1,$2,$3) as data", [id(50),id(20),id(60)]);
  assert.deepEqual(context.data,{timeZone:"Asia/Almaty"});
  await rejects(()=>row("select public.operator_booking_workspace($1,$2,$3)",[id(50),id(20),id(60)]),/permission denied/);
  assert.equal((await book()).status, "scheduled");
  await rejects(
    () => db.exec("delete from public.growth_operator_bookings"),
    /permission denied/,
  );
});

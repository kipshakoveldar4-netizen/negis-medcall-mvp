import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { before, after, beforeEach, afterEach } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const db = new PGlite(); // No files, environment configuration or network.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fingerprint = "a".repeat(64);
const row = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, params)).rows[0];
const counts = () => row(`select (select count(*) from clients) as clients,
  (select count(*) from appointments) as appointments, (select count(*) from deals) as deals,
  (select count(*) from crm_appointment_create_requests) as receipts`);
const untouched = { clients: 1, appointments: 0, deals: 0, receipts: 0 };
const once = { clients: 2, appointments: 1, deals: 1, receipts: 1 };

before(async () => {
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  const numbers = new Set([9, 10, 11, 12, 13, 14, 19, 20, 29, 30, 32, 33, 34, 36, 40, 43, 45, 55, 61, 63, 64]);
  for (const file of (await readdir(path.join(root, "migrations"))).sort()) {
    if (!numbers.has(Number(file.slice(0, 3)))) continue;
    await db.exec((await readFile(path.join(root, "migrations", file), "utf8"))
      .replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/i, ""));
  }
});
after(() => db.close());
beforeEach(() => db.exec(`begin;
  insert into workspaces(id,name,arrival_marks_paid) values
    ('${id(1)}','Isolated request fixture',true),('${id(2)}','Other isolated fixture',false);
  insert into staff_users(id,workspace_id,full_name,email,role) values
    ('${id(11)}','${id(1)}','Fixture owner','owner@example.invalid','owner'),
    ('${id(12)}','${id(1)}','Fixture colleague','colleague@example.invalid','doctor'),
    ('${id(13)}','${id(2)}','Other owner','other@example.invalid','owner');
  insert into clinic_doctors(id,workspace_id,staff_user_id,full_name,capacity)
    values('${id(15)}','${id(1)}','${id(11)}','Fixture doctor',2);
  insert into clients(id,workspace_id,full_name) values('${id(90)}','${id(1)}','Existing fixture client');`));
afterEach(() => db.exec("rollback"));

function input(clientId = id(100)) {
  return {
    workspace: id(1), staff: id(11), key: id(50), fingerprint,
    client: { id: clientId, workspace_id: id(1), full_name: "New fixture client", status: "new" } as Record<string, unknown> | null,
    appointment: { workspace_id: id(1), client_id: clientId, created_by_staff_user_id: id(11),
      client_name: "New fixture client", doctor_id: id(15), doctor_name: "Fixture doctor",
      starts_at: "2026-10-03T09:00:00+05:00", duration_minutes: 60,
      status: "arrived", service: "Fixture service", price_minor: 123450 } as Record<string, unknown>,
    match: "created",
  };
}
type Input = ReturnType<typeof input>;
type Reply = { appointment: Record<string, unknown>; replayed: boolean; clientCreated: boolean; clientMatch: string };
async function query(sql: string, params: unknown[] = [], role: "service_role" | "anon" | "authenticated" = "service_role") {
  await db.exec(`savepoint request_call; set local role ${role}`);
  try {
    const result = await row(sql, params);
    await db.exec("reset role; release savepoint request_call");
    return { data: result.result as Reply | null, code: null };
  } catch (error) {
    await db.exec("rollback to savepoint request_call; release savepoint request_call");
    return { data: null, code: (error as { code: string }).code };
  }
}
const submit = (p = input(), role?: "service_role" | "anon" | "authenticated") => query(
  "select public.create_crm_appointment_once($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6::jsonb,$7) as result",
  [p.workspace, p.staff, p.key, p.fingerprint, p.client === null ? null : JSON.stringify(p.client), JSON.stringify(p.appointment), p.match], role);
const read = (p = input(), role?: "service_role" | "anon" | "authenticated") => query(
  "select public.read_crm_appointment_create_request($1::uuid,$2::uuid,$3::uuid,$4) as result",
  [p.workspace, p.staff, p.key, p.fingerprint], role);
function saved(result: Awaited<ReturnType<typeof submit>>) {
  assert.equal(result.code, null);
  assert.ok(result.data);
  return result.data;
}

test("lost result replay returns one visit, new client and exact sale even at capacity two", async () => {
  saved(await submit()); // The caller may lose this reply after the commit.
  const receipt = await row("select * from crm_appointment_create_requests");
  const original = await row("select * from appointments");
  const retry = saved(await submit(input(id(101)))); // Newly prepared ID is not a new intent.
  assert.equal(retry.replayed, true);
  assert.equal(retry.appointment.id, original.id);
  assert.equal(retry.appointment.client_id, id(100));
  assert.equal(retry.clientCreated, true);
  assert.equal(retry.clientMatch, "created");
  assert.deepEqual(await counts(), once);
  assert.deepEqual(await row("select * from crm_appointment_create_requests"), receipt);
  assert.equal((await row("select amount_minor from deals")).amount_minor, 123450);
  assert.equal(saved(await read()).appointment.id, original.id);
});

test("different fingerprint on the same key is refused without mutation", async () => {
  saved(await submit());
  const changed = { ...input(id(101)), fingerprint: "b".repeat(64) };
  assert.equal((await submit(changed)).code, "P6402");
  assert.equal((await read(changed)).code, "P6402");
  assert.deepEqual(await counts(), once);
});

test("replay returns the current cancelled visit without reverting later edits or creating another sale", async () => {
  saved(await submit());
  await db.exec("update appointments set status='cancelled',notes='Later change'");
  const result = saved(await submit(input(id(101))));
  assert.equal(result.appointment.status, "cancelled");
  assert.equal(result.appointment.notes, "Later change");
  assert.deepEqual(await counts(), once);
});

test("deleted appointment leaves a receipt and cannot be resurrected by retry", async () => {
  const p = input(); p.appointment.status = "scheduled";
  saved(await submit(p));
  await db.exec("delete from appointments");
  assert.equal((await row("select appointment_id from crm_appointment_create_requests")).appointment_id, null);
  assert.equal((await read(p)).code, "P6403");
  assert.equal((await submit(p)).code, "P6403");
  assert.deepEqual(await counts(), { clients: 2, appointments: 0, deals: 0, receipts: 1 });
});

test("same key is isolated by verified staff and workspace", async () => {
  const first = saved(await submit());
  const colleague = input(id(101)); colleague.staff = id(12); colleague.appointment.created_by_staff_user_id = id(12);
  assert.equal((await read(colleague)).data, null);
  const second = saved(await submit(colleague));
  assert.notEqual(second.appointment.id, first.appointment.id);
  const other = input(id(102)); other.workspace = id(2); other.staff = id(13);
  other.client!.workspace_id = id(2);
  Object.assign(other.appointment, { workspace_id: id(2), created_by_staff_user_id: id(13), doctor_id: null });
  assert.equal((await read(other)).data, null);
  const third = saved(await submit(other));
  assert.notEqual(third.appointment.id, first.appointment.id);
  assert.equal(third.appointment.workspace_id, id(2));
  assert.equal(saved(await read()).appointment.id, first.appointment.id);
  assert.deepEqual(await counts(), { clients: 4, appointments: 3, deals: 2, receipts: 3 });
});

test("inactive or foreign membership cannot replay or create", async () => {
  saved(await submit());
  await db.exec(`update staff_users set status='inactive' where id='${id(11)}'`);
  assert.equal((await read()).code, "P6404");
  assert.equal((await submit(input(id(101)))).code, "P6404");
  assert.equal((await read({ ...input(), staff: id(13) })).code, "P6404");
  assert.deepEqual(await counts(), once);
});

for (const match of ["provided", "phone"]) {
  test(`existing-client ${match} path is atomic and replayable without rewriting the card`, async () => {
    const card = await row(`select * from clients where id='${id(90)}'`);
    const p = input(id(90)); p.client = null; p.match = match;
    const first = saved(await submit(p));
    assert.equal(first.clientCreated, false);
    assert.equal(first.clientMatch, match);
    assert.equal(saved(await submit(p)).appointment.id, first.appointment.id);
    assert.deepEqual(await row(`select * from clients where id='${id(90)}'`), card);
    assert.deepEqual(await counts(), { clients: 1, appointments: 1, deals: 1, receipts: 1 });
  });
}

test("failure after all domain inserts rolls back receipt, client, appointment and sale", async () => {
  await db.exec(`create function refuse_receipt() returns trigger language plpgsql as $$ begin
    raise exception 'Fixture receipt refused' using errcode='23514'; end $$;
    create trigger refuse_receipt before insert on crm_appointment_create_requests
      for each row execute function refuse_receipt()`);
  assert.equal((await submit()).code, "23514");
  assert.deepEqual(await counts(), untouched);
  assert.equal((await read()).data, null);
  await db.exec("drop trigger refuse_receipt on crm_appointment_create_requests");
  assert.equal(saved(await submit(input(id(101)))).replayed, false);
  assert.deepEqual(await counts(), once);
});

test("arrival trigger refusal does not consume the key or create a client", async () => {
  const p = input(); p.appointment.price_minor = null;
  assert.equal((await submit(p)).code, "P6105");
  assert.deepEqual(await counts(), untouched);
  assert.equal((await read()).data, null);
  assert.equal(saved(await submit()).replayed, false);
  assert.deepEqual(await counts(), once);
});

test("malformed metadata, mixed tenant references and generated fields are refused", async () => {
  const cases: Array<(p: Input) => void> = [
    p => { p.fingerprint = "browser supplied text"; },
    p => { p.appointment.workspace_id = id(2); },
    p => { p.appointment.created_by_staff_user_id = id(12); },
    p => { p.appointment.arrival_sale_id = id(200); },
    p => { p.client = null; p.match = "created"; },
    p => { p.match = "phone"; },
    p => { p.client = null; p.match = "provided"; p.appointment.client_id = id(200); },
  ];
  for (const mutate of cases) {
    const p = input(); mutate(p);
    assert.equal((await submit(p)).code, "P6401");
    assert.deepEqual(await counts(), untouched);
  }
});

for (const role of ["anon", "authenticated"] as const) {
  test(`${role} cannot execute either RPC or read receipts`, async () => {
    assert.equal((await submit(input(), role)).code, "42501");
    assert.equal((await read(input(), role)).code, "42501");
    assert.equal((await query("select * from public.crm_appointment_create_requests", [], role)).code, "42501");
    assert.deepEqual(await counts(), untouched);
  });
}

test("receipt table has no PII/body columns and service role uses RPCs, not raw ledger access", async () => {
  assert.equal((await query("select * from public.crm_appointment_create_requests")).code, "42501");
  const columns = (await db.query<{ column_name: string }>(`select column_name from information_schema.columns
    where table_schema='public' and table_name='crm_appointment_create_requests' order by ordinal_position`)).rows.map(r => r.column_name);
  assert.deepEqual(columns, ["workspace_id", "staff_user_id", "request_key", "request_fingerprint",
    "appointment_id", "client_created", "client_match", "created_at"]);
  assert.equal((await row("select relrowsecurity from pg_class where oid='public.crm_appointment_create_requests'::regclass")).relrowsecurity, true);
});

test("migration can be repeated without losing receipts or modifying clinic settings", async () => {
  saved(await submit());
  const receipt = await row("select * from crm_appointment_create_requests");
  const workspaces = await row("select jsonb_agg(w order by id) as rows from workspaces w");
  const source = await readFile(path.join(root, "migrations/064_appointment_create_requests.sql"), "utf8");
  await db.exec(source.replace(/^begin;$/m, "").replace(/^commit;$/m, ""));
  assert.deepEqual(await row("select * from crm_appointment_create_requests"), receipt);
  assert.deepEqual(await row("select jsonb_agg(w order by id) as rows from workspaces w"), workspaces);
  assert.deepEqual(await counts(), once);
  assert.equal(saved(await read()).replayed, true);
});

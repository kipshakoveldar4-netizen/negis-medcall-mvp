import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { before, after, beforeEach, afterEach } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createRequire } from "node:module";
const { arrivalPaymentError } = createRequire(import.meta.url)("../../lib/crm/arrival-payment.ts") as {
  arrivalPaymentError(error: { code?: string }): string | null;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const db = new PGlite(); // In-memory only. Never reads production configuration.
const require = createRequire(import.meta.url);
const serverClient = require("../../lib/supabase/server.ts") as {
  setSupabaseServerClientFactoryForTests(factory: (() => unknown) | null): void;
};
const handler = require("../../api/crm/[...path].ts").default as (req: unknown, res: unknown) => Promise<void>;
const originalFetch = globalThis.fetch;
const originalUrl = process.env.SUPABASE_URL;
const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows[0];
const arrive = () => db.exec(`update appointments set status='arrived' where id='${id(10)}'`);
const sale = () => row(`select * from deals where appointment_id='${id(10)}'`);
async function rejects(sql: string, code: string) {
  await db.exec("savepoint expected_failure");
  await assert.rejects(db.exec(sql), (error: { code?: string }) => error.code === code);
  await db.exec("rollback to savepoint expected_failure; release savepoint expected_failure");
}
before(async () => {
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  const numbers = new Set([9, 10, 11, 12, 13, 14, 19, 20, 29, 30, 32, 33, 34, 36, 40, 43, 45, 55, 61, 63, 64]);
  for (const file of (await readdir(path.join(root, "migrations"))).sort()) {
    if (!numbers.has(Number(file.slice(0, 3)))) continue;
    try {
      await db.exec((await readFile(path.join(root, "migrations", file), "utf8"))
        .replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/i, ""));
    } catch (error) {
      throw new Error(`${file}: ${(error as Error).message}`);
    }
  }
});
after(() => db.close());
beforeEach(async () => {
  await db.exec(`begin;
    insert into workspaces(id,name,arrival_marks_paid) values
      ('${id(1)}','Isolated test',true),('${id(2)}','Untouched',false);
    insert into clients(id,workspace_id,full_name) values('${id(3)}','${id(1)}','Test client');
    insert into appointments(id,workspace_id,client_id,service,price_minor,status) values
      ('${id(10)}','${id(1)}','${id(3)}','Two services',1500000,'confirmed');`);
});
afterEach(() => db.exec("rollback"));

// Execute real route queries and trigger writes, rather than returning canned
// successful API responses. This adapter is intentionally test-local/read-write.
function apiDatabase(rpcRole: "service_role" | "anon" | "authenticated" = "service_role") {
  const ident = (value: string) => {
    assert.match(value, /^[a-z_][a-z0-9_]*$/);
    return `"${value}"`;
  };
  return {
    async rpc(name: string, args: Record<string, unknown>) {
      const calls: Record<string, { sql: string; params: unknown[] }> = {
        create_crm_appointment_with_new_client: {
          sql: "select public.create_crm_appointment_with_new_client($1::uuid, $2::jsonb, $3::jsonb) as item",
          params: [args.p_workspace_id, JSON.stringify(args.p_client), JSON.stringify(args.p_appointment)],
        },
        read_crm_appointment_create_request: {
          sql: "select public.read_crm_appointment_create_request($1::uuid,$2::uuid,$3::uuid,$4) as item",
          params: [args.p_workspace_id, args.p_staff_user_id, args.p_request_key, args.p_request_fingerprint],
        },
        create_crm_appointment_once: {
          sql: "select public.create_crm_appointment_once($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6::jsonb,$7) as item",
          params: [args.p_workspace_id, args.p_staff_user_id, args.p_request_key, args.p_request_fingerprint,
            args.p_new_client === null ? null : JSON.stringify(args.p_new_client), JSON.stringify(args.p_appointment), args.p_client_match],
        },
      };
      assert.ok(calls[name], `Unexpected RPC ${name}`);
      await db.exec(`savepoint api_rpc; set local role ${rpcRole}`);
      try {
        const result = await db.query<{ item: Record<string, unknown> }>(
          calls[name].sql, calls[name].params,
        );
        await db.exec("reset role; release savepoint api_rpc");
        return { data: result.rows[0].item, error: null };
      } catch (error) {
        await db.exec("rollback to savepoint api_rpc; release savepoint api_rpc");
        return { data: null, error: { code: (error as { code: string }).code, message: "Isolated database rejected the RPC" } };
      }
    },
    from(table: string) {
    let operation = "select", single = false, columns = "*";
    let values: Record<string, unknown> = {};
    const filters: Array<[string, "=" | ">=" | "<" | "<=", unknown]> = [];
    let limit: number | undefined;
    async function execute() {
      const params: unknown[] = [];
      const bind = (value: unknown) => {
        params.push(Array.isArray(value) ? JSON.stringify(value) : value);
        return `$${params.length}`;
      };
      const selection = columns === "*" ? "*" : columns.split(",").map(v => ident(v.trim())).join(",");
      let sql = `select ${selection} from ${ident(table)}`;
      if (operation === "update") sql = `update ${ident(table)} set ${Object.entries(values)
        .map(([key, value]) => `${ident(key)}=${bind(value)}`).join(",")}`;
      if (operation === "insert") sql = `insert into ${ident(table)} (${Object.keys(values).map(ident).join(",")}) values (${Object.values(values).map(bind).join(",")})`;
      if (filters.length) sql += " where " + filters.map(([key, operator, value]) => `${ident(key)}${operator}${bind(value)}`).join(" and ");
      if (operation !== "select") sql += ` returning ${selection}`;
      if (operation === "select" && limit !== undefined) sql += ` limit ${limit}`;
      if (operation !== "select") await db.exec("savepoint api_write");
      try {
        const result = await db.query(sql, params);
        if (operation !== "select") await db.exec("release savepoint api_write");
        const rows = JSON.parse(JSON.stringify(result.rows));
        return { data: single ? rows[0] ?? null : rows, error: null };
      } catch (error) {
        if (operation !== "select") await db.exec("rollback to savepoint api_write; release savepoint api_write");
        return { data: null, error: { code: (error as { code: string }).code, message: "Isolated database rejected the query" } };
      }
    }
    const query = {
      select(value: string) { columns = value; return query; },
      eq(key: string, value: unknown) { filters.push([key, "=", value]); return query; },
      gte(key: string, value: unknown) { filters.push([key, ">=", value]); return query; },
      lt(key: string, value: unknown) { filters.push([key, "<", value]); return query; },
      lte(key: string, value: unknown) { filters.push([key, "<=", value]); return query; },
      order() { return query; },
      limit(value: number) { assert.ok(Number.isInteger(value) && value > 0); limit = value; return query; },
      insert(value: Record<string, unknown>) { operation = "insert"; values = value; return query; },
      update(value: Record<string, unknown>) { operation = "update"; values = value; return query; },
      single() { single = true; return execute(); },
      maybeSingle() { single = true; return execute(); },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) { return execute().then(resolve, reject); },
    };
    return query;
  } };
}

async function apiFixture(role = "owner") {
  await db.exec(`insert into staff_users(id,workspace_id,auth_user_id,full_name,email,role)
    values('${id(40)}','${id(1)}','${id(41)}','Test master','fixture@example.invalid','${role}');
    insert into clinic_doctors(id,workspace_id,full_name,staff_user_id)
    values('${id(42)}','${id(1)}','Test master','${id(40)}');
    update appointments set doctor_id='${id(42)}',doctor_name='Test master' where id='${id(10)}'`);
  process.env.SUPABASE_URL = "https://fixture.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-not-a-secret";
  globalThis.fetch = (async (url: unknown) => {
    assert.equal(url, "https://fixture.invalid/auth/v1/user");
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: id(41) }) };
  }) as unknown as typeof fetch;
  serverClient.setSupabaseServerClientFactoryForTests(apiDatabase);
  return async (route = "appointments", method = "PATCH", updates: Record<string, unknown> = { status: "arrived" }, workspace = 1, appointmentId = id(10)) => {
    let status = 0; let body: Record<string, unknown> = {};
    const res = { setHeader() {}, status(value: number) { status = value; return res; },
      json(value: Record<string, unknown>) { body = value; } };
    await handler({ method, headers: { authorization: "Bearer fixture.test.signature" },
      query: { path: [route], workspaceId: id(workspace) },
      body: method === "GET" ? undefined : method === "POST" ? updates : { id: appointmentId, updates } }, res);
    return { status, body };
  };
}
afterEach(() => {
  serverClient.setSupabaseServerClientFactoryForTests(null);
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
});

test("API arrival returns persisted sale link and sales exposes exact paid amount", async () => {
  const call = await apiFixture();
  const response = await call();
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.mode, "supabase");
  const item = (response.body.data as { item: Record<string, unknown> }).item;
  assert.equal(item.arrivalSaleId, (await sale()).id);
  const sales = await call("deals", "GET");
  assert.equal(sales.status, 200, JSON.stringify(sales.body));
  const deals = (sales.body.data as { items: Record<string, unknown>[] }).items;
  assert.equal(deals.length, 1);
  assert.equal(deals[0].status, "paid");
  assert.equal(deals[0].amountMinor, 1500000);
  assert.ok(deals[0].paidAt);
  assert.equal((await row("select count(*) from audit_logs where entity_type='appointment'")).count, 1);
  await call();
  assert.equal((await row("select count(*) from deals")).count, 1);
});
test("API missing price returns safe error and keeps visit unconfirmed", async () => {
  const call = await apiFixture();
  await db.exec(`update appointments set price_minor=null where id='${id(10)}'`);
  const response = await call();
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "arrival_payment");
  assert.match(String(response.body.error), /стоимость/);
  assert.equal((await row(`select status from appointments where id='${id(10)}'`)).status, "confirmed");
  assert.equal((await row("select count(*) from deals")).count, 0);
});
test("master can confirm own arrival without gaining access to all sales", async () => {
  const call = await apiFixture("doctor");
  assert.equal((await call()).status, 200);
  assert.equal((await sale()).responsible_user_id, id(40));
  assert.equal((await call("deals", "GET")).status, 403);
});
test("cross-workspace confirmation never creates a payment", async () => {
  const call = await apiFixture();
  assert.equal((await call("appointments", "PATCH", { status: "arrived" }, 2)).status, 403);
  assert.equal((await row("select count(*) from deals")).count, 0);
});
test("master cannot confirm another specialist's appointment", async () => {
  const call = await apiFixture("doctor");
  await db.exec(`update appointments set doctor_id=null,doctor_name='Other master' where id='${id(10)}'`);
  assert.equal((await call()).status, 404);
  assert.equal((await row("select count(*) from deals")).count, 0);
});
test("API preserves manual sales behavior until workspace explicitly opts in", async () => {
  const call = await apiFixture();
  await db.exec(`update workspaces set arrival_marks_paid=false where id='${id(1)}'`);
  const response = await call();
  assert.equal(response.status, 200);
  assert.equal((response.body.data as { item: Record<string, unknown> }).item.arrivalSaleId, "");
  assert.equal((await row("select count(*) from deals")).count, 0);
});
test("browser cannot forge the server-owned payment link", async () => {
  const call = await apiFixture();
  const response = await call("appointments", "PATCH", { status: "arrived", arrivalSaleId: id(99), arrival_sale_id: id(99) });
  assert.equal(response.status, 200);
  assert.equal((response.body.data as { item: Record<string, unknown> }).item.arrivalSaleId, (await sale()).id);
});

const serviceBundle = [
  { serviceId: id(50), name: "First quoted service", priceMinor: 500050, durationMinutes: 45 },
  { serviceId: id(51), name: "Second quoted service", priceMinor: 200000, durationMinutes: 30 },
  { serviceId: "", name: "Free manual service", priceMinor: 0, durationMinutes: 10 },
];
const bundleBooking = () => ({
  client: "Isolated new bundle client", doctorId: id(42), doctor: "Test master",
  startsAt: "2026-10-03T09:00:00+05:00", status: "confirmed",
  serviceItems: serviceBundle, priceMinor: 1, durationMinutes: 1, service: "Untrusted total",
});
async function bundleApiFixture(role = "owner") {
  const call = await apiFixture(role);
  await db.exec(`insert into clinic_services(id,workspace_id,doctor_id,name,base_price_minor,duration_minutes) values
    ('${id(50)}','${id(1)}','${id(42)}','First catalogue service',500050,45),
    ('${id(51)}','${id(1)}','${id(42)}','Second catalogue service',200000,30)`);
  return call;
}
function apiItem(response: { status: number; body: Record<string, unknown> }, expectedStatus = 200) {
  assert.equal(response.status, expectedStatus, JSON.stringify(response.body));
  assert.equal(response.body.mode, "supabase");
  assert.equal((response.body.data as Record<string, unknown>).unsaved, undefined);
  return (response.body.data as { item: Record<string, unknown> }).item;
}

const keyedBooking = () => ({ ...bundleBooking(), requestKey: id(70) });
const retryCounts = () => row(`select (select count(*) from clients) as clients,
  (select count(*) from appointments) as appointments, (select count(*) from deals) as sales,
  (select count(*) from crm_appointment_create_requests) as receipts,
  (select count(*) from audit_logs) as journal`);

for (const capacity of [1, 2]) {
  test(`API lost successful reply replays one client/visit/sale/journal at capacity ${capacity}`, async () => {
    const call = await bundleApiFixture();
    await db.exec(`update clinic_doctors set capacity=${capacity}`);
    const body = { ...keyedBooking(), status: "arrived" };
    const first = await call("appointments", "POST", body);
    const visit = apiItem(first, 201);
    assert.equal((first.body.data as Record<string, unknown>).replayed, false);
    const before = await retryCounts();
    assert.deepEqual(before, { clients: 2, appointments: 2, sales: 1, receipts: 1, journal: 2 });
    const retry = await call("appointments", "POST", { ...body, id: id(999), updated_at: "ignored", requestFingerprint: "forged" });
    assert.deepEqual(apiItem(retry), visit);
    assert.equal((retry.body.data as Record<string, unknown>).replayed, true);
    assert.equal((retry.body.data as Record<string, unknown>).clientCreated, true);
    assert.deepEqual(await retryCounts(), before);
    assert.equal((await row("select amount_minor from deals")).amount_minor, 700050);
  });
}

test("API retry returns later edits despite archived catalogue without restoring old data", async () => {
  const call = await bundleApiFixture();
  const visit = apiItem(await call("appointments", "POST", keyedBooking()), 201);
  await db.exec(`update appointments set status='cancelled',notes='Later edit' where id='${visit.id}';
    update clinic_services set is_active=false`);
  const before = await retryCounts();
  const retry = apiItem(await call("appointments", "POST", keyedBooking()));
  assert.equal(retry.id, visit.id);
  assert.equal(retry.status, "cancelled");
  assert.equal(retry.notes, "Later edit");
  assert.deepEqual(await retryCounts(), before);
});

test("API computes the fingerprint itself and rejects changed intent for a used key", async () => {
  const call = await bundleApiFixture();
  apiItem(await call("appointments", "POST", keyedBooking()), 201);
  const before = await retryCounts();
  const receipt = await row("select request_fingerprint from crm_appointment_create_requests");
  for (const updates of [{ client: "Different person" }, { startsAt: "2026-10-04T09:00:00+05:00" },
    { clientId: id(3) }, { clientId: "", client_id: id(3) }, { notes: "Different intent" }, { allowOutsideSchedule: true },
    { serviceItems: serviceBundle.map(item => ({ ...item, priceMinor: 1 })) }]) {
    const reply = await call("appointments", "POST", { ...keyedBooking(), ...updates, requestFingerprint: receipt.request_fingerprint });
    assert.equal(reply.status, 409, JSON.stringify(reply.body));
    assert.equal(reply.body.code, "appointment_request_conflict");
    assert.deepEqual(await retryCounts(), before);
  }
});

test("API normalizes aliases and service property order without hashing generated fields", async () => {
  const call = await bundleApiFixture();
  const original = keyedBooking();
  const visit = apiItem(await call("appointments", "POST", original), 201);
  const { client, startsAt, doctorId, doctor, serviceItems, ...rest } = original;
  const reply = await call("appointments", "POST", { ...rest, client_name: client, starts_at: startsAt,
    doctor_id: doctorId, doctor_name: doctor,
    service_items: serviceItems.map(({ durationMinutes, priceMinor, name, serviceId }) => ({ durationMinutes, priceMinor, name, serviceId })) });
  assert.equal(apiItem(reply).id, visit.id);
});

test("API existing-client replay does not overwrite the client and reflects later arrival", async () => {
  const call = await bundleApiFixture();
  const body = { ...keyedBooking(), clientId: id(3) };
  const card = await row(`select * from clients where id='${id(3)}'`);
  const first = await call("appointments", "POST", body);
  const visit = apiItem(first, 201);
  assert.equal((first.body.data as Record<string, unknown>).clientCreated, false);
  apiItem(await call("appointments", "PATCH", { status: "arrived" }, 1, String(visit.id)));
  const before = await retryCounts();
  const reply = await call("appointments", "POST", body);
  assert.equal(apiItem(reply).status, "arrived");
  assert.equal((reply.body.data as Record<string, unknown>).clientMatch, "provided");
  assert.deepEqual(await retryCounts(), before);
  // Arrival updates visit history but retry itself must not rewrite the card.
  assert.equal((await row(`select * from clients where id='${id(3)}'`)).full_name, card.full_name);
});

test("API a deleted receipt target refuses resurrection", async () => {
  const call = await bundleApiFixture();
  const visit = apiItem(await call("appointments", "POST", keyedBooking()), 201);
  await db.exec(`delete from appointments where id='${visit.id}'`);
  const before = await retryCounts();
  const reply = await call("appointments", "POST", keyedBooking());
  assert.equal(reply.status, 409);
  assert.equal(reply.body.code, "appointment_request_unavailable");
  assert.deepEqual(await retryCounts(), before);
});

test("API replay checks current own-work and does not expose another specialist's moved visit", async () => {
  const call = await bundleApiFixture("doctor");
  const visit = apiItem(await call("appointments", "POST", keyedBooking()), 201);
  await db.exec(`update appointments set doctor_id=null,doctor_name='Other specialist',client_phone='+77001234567'
    where id='${visit.id}'`);
  const before = await retryCounts();
  const reply = await call("appointments", "POST", keyedBooking());
  assert.equal(reply.status, 404);
  assert.equal(JSON.stringify(reply.body).includes("77001234567"), false);
  assert.equal(JSON.stringify(reply.body).includes("Other specialist"), false);
  assert.deepEqual(await retryCounts(), before);
});

test("API doctor retry redacts contacts added after the original booking", async () => {
  const call = await bundleApiFixture("doctor");
  const visit = apiItem(await call("appointments", "POST", keyedBooking()), 201);
  await db.exec(`update appointments set client_phone='+77001234567',whatsapp='+77007654321' where id='${visit.id}'`);
  const reply = await call("appointments", "POST", keyedBooking());
  assert.equal(apiItem(reply).id, visit.id);
  assert.equal(JSON.stringify(reply.body).includes("77001234567"), false);
  assert.equal(JSON.stringify(reply.body).includes("77007654321"), false);
});

test("API implicit self booking keeps the original retry intent without mutating request input", async () => {
  const call = await apiFixture("doctor");
  const body = { requestKey: id(70), client: "Fixture client", service: "Manual fixture", priceMinor: 100,
    startsAt: "2026-10-03T09:00:00+05:00" };
  const original = { ...body };
  const visit = apiItem(await call("appointments", "POST", body), 201);
  assert.deepEqual(body, original);
  assert.equal(apiItem(await call("appointments", "POST", body)).id, visit.id);
});

test("API receipt scope comes from authenticated staff, not supplied actor or workspace fields", async () => {
  const call = await bundleApiFixture();
  await db.exec(`update clinic_doctors set capacity=2`);
  const first = apiItem(await call("appointments", "POST", keyedBooking()), 201);
  assert.equal((await call("appointments", "POST", keyedBooking(), 2)).status, 403);
  await db.exec(`insert into staff_users(id,workspace_id,auth_user_id,full_name,email,role)
    values('${id(43)}','${id(1)}','${id(44)}','Fixture colleague','colleague@example.invalid','owner')`);
  globalThis.fetch = (async (url: unknown) => {
    assert.equal(url, "https://fixture.invalid/auth/v1/user");
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: id(44) }) };
  }) as unknown as typeof fetch;
  const second = apiItem(await call("appointments", "POST", { ...keyedBooking(), staffUserId: id(40), created_by_staff_user_id: id(40) }), 201);
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.clientId, first.clientId);
  assert.equal((await row(`select created_by_staff_user_id from appointments where id='${second.id}'`)).created_by_staff_user_id, id(43));
  assert.equal((await retryCounts()).receipts, 2);
});

test("API retry after loss of membership is refused before returning any receipt", async () => {
  const call = await bundleApiFixture();
  apiItem(await call("appointments", "POST", keyedBooking()), 201);
  await db.exec(`update staff_users set status='inactive' where id='${id(40)}'`);
  const before = await retryCounts();
  const reply = await call("appointments", "POST", keyedBooking());
  assert.equal(reply.status, 403);
  assert.equal(reply.body.data, undefined);
  assert.deepEqual(await retryCounts(), before);
});

for (const rpcName of ["read_crm_appointment_create_request", "create_crm_appointment_once"]) {
  test(`API missing ${rpcName} fails closed without legacy INSERT or unsaved success`, async () => {
    const call = await bundleApiFixture();
    const base = apiDatabase();
    serverClient.setSupabaseServerClientFactoryForTests(() => ({ ...base, rpc: async (name: string, args: Record<string, unknown>) =>
      name === rpcName ? { data: null, error: { code: "PGRST202", message: "private fixture SQL detail" } } : base.rpc(name, args) }));
    const before = await retryCounts();
    const reply = await call("appointments", "POST", keyedBooking());
    assert.equal(reply.status, 503);
    assert.equal(reply.body.code, "appointment_create_unavailable");
    assert.equal(reply.body.data, undefined);
    assert.equal(JSON.stringify(reply.body).includes("private fixture SQL detail"), false);
    assert.deepEqual(await retryCounts(), before);
  });
}

test("API malformed key and uncertain receipt read never become successful creates", async () => {
  const call = await bundleApiFixture();
  const before = await retryCounts();
  for (const requestKey of [null, "", "arbitrary", 123]) {
    assert.equal((await call("appointments", "POST", { ...keyedBooking(), requestKey })).status, 400);
  }
  const base = apiDatabase();
  serverClient.setSupabaseServerClientFactoryForTests(() => ({ ...base, rpc: async () => ({
    data: null, error: { code: "08006", message: "private connection detail" },
  }) }));
  const reply = await call("appointments", "POST", keyedBooking());
  assert.equal(reply.status, 502);
  assert.equal(reply.body.data, undefined);
  assert.equal(JSON.stringify(reply.body).includes("private connection detail"), false);
  assert.deepEqual(await retryCounts(), before);
});

test("API lost RPC response after commit is recovered without a second transaction or invented success", async () => {
  const call = await bundleApiFixture();
  const base = apiDatabase();
  let creates = 0;
  serverClient.setSupabaseServerClientFactoryForTests(() => ({ ...base, rpc: async (name: string, args: Record<string, unknown>) => {
    const result = await base.rpc(name, args);
    if (name !== "create_crm_appointment_once") return result;
    creates++;
    assert.equal(result.error, null);
    return { data: null, error: { code: "08006", message: "Reply lost after isolated commit" } };
  } }));
  const body = { ...keyedBooking(), status: "arrived" };
  const unknown = await call("appointments", "POST", body);
  assert.equal(unknown.status, 502);
  assert.equal(unknown.body.data, undefined);
  const before = await retryCounts();
  assert.deepEqual(before, { clients: 2, appointments: 2, sales: 1, receipts: 1, journal: 0 });
  const retry = apiItem(await call("appointments", "POST", body));
  assert.equal(retry.arrivalSaleId, (await row("select id from deals")).id);
  assert.equal(creates, 1);
  assert.deepEqual(await retryCounts(), before);
});

test("API existing-client keyed insert cannot fall back by discarding schema fields", async () => {
  const call = await bundleApiFixture();
  const base = apiDatabase();
  let creates = 0;
  serverClient.setSupabaseServerClientFactoryForTests(() => ({ ...base, rpc: async (name: string, args: Record<string, unknown>) => {
    if (name !== "create_crm_appointment_once") return base.rpc(name, args);
    creates++;
    return { data: null, error: { code: "PGRST204", message: "Could not find the doctor_id column" } };
  } }));
  const before = await retryCounts();
  const reply = await call("appointments", "POST", { ...keyedBooking(), clientId: id(3) });
  assert.equal(reply.status, 503);
  assert.equal(reply.body.code, "appointment_create_unavailable");
  assert.equal(creates, 1);
  assert.deepEqual(await retryCounts(), before);
});

test("API malformed or foreign receipt response fails without exposing its contents", async () => {
  const call = await bundleApiFixture();
  const base = apiDatabase();
  const before = await retryCounts();
  for (const data of [{}, { appointment: { id: id(99), workspace_id: id(2), client_name: "Private fixture name" },
    replayed: true, clientCreated: true, clientMatch: "created" }]) {
    serverClient.setSupabaseServerClientFactoryForTests(() => ({ ...base, rpc: async () => ({ data, error: null }) }));
    const reply = await call("appointments", "POST", keyedBooking());
    assert.equal(reply.status, 502);
    assert.equal(reply.body.data, undefined);
    assert.equal(JSON.stringify(reply.body).includes("Private fixture name"), false);
    assert.deepEqual(await retryCounts(), before);
  }
});

test("API keyed trigger failure rolls back all writes and leaves the intent retryable", async () => {
  const call = await bundleApiFixture();
  const before = await retryCounts();
  const body = { ...keyedBooking(), status: "arrived", serviceItems: [{ name: "Unknown quote", priceMinor: null, durationMinutes: 60 }] };
  const refused = await call("appointments", "POST", body);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "arrival_payment");
  assert.deepEqual(await retryCounts(), before);
  const saved = apiItem(await call("appointments", "POST", { ...keyedBooking(), status: "arrived" }), 201);
  assert.ok(saved.arrivalSaleId);
  assert.deepEqual(await retryCounts(), { clients: 2, appointments: 2, sales: 1, receipts: 1, journal: 2 });
});

for (const capacity of [1, 2]) {
  test(`API commit between lookup and preflight replays at capacity ${capacity} without loser side effects`, async () => {
    const call = await bundleApiFixture();
    await db.exec(`update clinic_doctors set capacity=${capacity}`);
    const base = apiDatabase();
    let injected = false, reads = 0, creates = 0;
    let winner: Record<string, unknown> = {};
    serverClient.setSupabaseServerClientFactoryForTests(() => ({ ...base, rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "read_crm_appointment_create_request") reads++;
      if (name === "create_crm_appointment_once") creates++;
      const result = await base.rpc(name, args);
      if (name === "read_crm_appointment_create_request" && !injected) {
        assert.equal(result.data, null);
        injected = true;
        // Deterministic interleaving with real SQL writes, not a canned success.
        // Native two-connection lock contention remains a separate PostgreSQL test.
        const committed = await base.rpc("create_crm_appointment_once", { ...args,
          p_new_client: { id: id(80), workspace_id: id(1), full_name: "Concurrent fixture", status: "new" },
          p_appointment: { workspace_id: id(1), client_id: id(80), created_by_staff_user_id: id(40),
            client_name: "Concurrent fixture", doctor_id: id(42), doctor_name: "Test master",
            starts_at: "2026-10-03T09:00:00+05:00", duration_minutes: 85, status: "confirmed",
            service: "Fixture bundle", price_minor: 700050, service_items: serviceBundle }, p_client_match: "created" });
        assert.equal(committed.error, null);
        winner = (committed.data as Record<string, unknown>).appointment as Record<string, unknown>;
      }
      return result;
    } }));
    const reply = await call("appointments", "POST", keyedBooking());
    const visit = apiItem(reply);
    assert.equal(visit.id, winner.id);
    assert.equal(visit.clientId, id(80));
    assert.equal((reply.body.data as Record<string, unknown>).replayed, true);
    assert.deepEqual(await retryCounts(), { clients: 2, appointments: 2, sales: 0, receipts: 1, journal: 0 });
    assert.equal(reads, capacity === 1 ? 2 : 1);
    assert.equal(creates, capacity === 1 ? 0 : 1);
  });
}

test("API bundle create/read/edit/arrival preserves the quote, client and one exact KZT sale", async () => {
  const call = await bundleApiFixture();
  const created = await call("appointments", "POST", bundleBooking());
  const item = apiItem(created, 201);
  const appointmentId = String(item.id);
  assert.equal((created.body.data as Record<string, unknown>).clientCreated, true);
  assert.ok(item.clientId && item.clientId !== id(3));
  assert.deepEqual(item.serviceItems, serviceBundle);
  assert.equal(item.priceMinor, 700050);
  assert.equal(item.durationMinutes, 85);
  assert.equal(item.serviceId, "");
  const stored = await row(`select * from appointments where id='${appointmentId}'`);
  assert.deepEqual(stored.service_items, serviceBundle);
  assert.equal(stored.price_minor, 700050);
  assert.equal(stored.duration_minutes, 85);
  assert.equal(stored.service_id, null);
  assert.equal(stored.client_id, item.clientId);
  const clients = await call("clients", "GET");
  assert.equal(clients.status, 200, JSON.stringify(clients.body));
  assert.equal((clients.body.data as { items: Record<string, unknown>[] }).items.filter(client => client.id === item.clientId).length, 1);
  const listed = await call("appointments", "GET");
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual((listed.body.data as { items: Record<string, unknown>[] }).items.find(visit => visit.id === appointmentId)?.serviceItems, serviceBundle);
  assert.equal((await row("select count(*) from deals")).count, 0);

  const revised = serviceBundle.map((service, index) => index === 1 ? { ...service, priceMinor: 300075 } : service);
  const edited = apiItem(await call("appointments", "PATCH", { serviceItems: revised, priceMinor: 1, durationMinutes: 1 }, 1, appointmentId));
  assert.deepEqual(edited.serviceItems, revised);
  assert.equal(edited.priceMinor, 800125);
  assert.equal(edited.durationMinutes, 85);
  await db.exec(`update clinic_services set base_price_minor=9999999, name='Repriced catalogue', is_active=false where workspace_id='${id(1)}'`);
  const arrived = apiItem(await call("appointments", "PATCH", { status: "arrived" }, 1, appointmentId));
  assert.deepEqual(arrived.serviceItems, revised);
  assert.equal(arrived.priceMinor, 800125);
  const receipt = await row(`select * from deals where appointment_id='${appointmentId}'`);
  assert.equal(receipt.id, arrived.arrivalSaleId);
  assert.equal(receipt.amount_minor, 800125);
  assert.equal(receipt.client_id, item.clientId);
  assert.equal(receipt.responsible_user_id, id(40));
  assert.equal(receipt.service_id, null, "the bundle must not count in full as just its first service");
  assert.equal(receipt.title, revised.map(service => service.name).join(" + "));
  assert.equal(receipt.currency, "KZT");
  assert.equal(receipt.status, "paid");
  const sales = await call("deals", "GET");
  assert.equal(sales.status, 200, JSON.stringify(sales.body));
  const deals = (sales.body.data as { items: Record<string, unknown>[] }).items;
  assert.equal(deals.length, 1);
  assert.equal(deals[0].amountMinor, 800125);
  assert.equal(deals[0].appointmentId, appointmentId);
  apiItem(await call("appointments", "PATCH", { status: "arrived" }, 1, appointmentId));
  assert.equal((await row("select count(*) from deals")).count, 1);
  assert.deepEqual(await row(`select * from deals where appointment_id='${appointmentId}'`), receipt);
  assert.equal((await row("select count(*) from clients")).count, 2);
});

test("API bundle with a missing line price cannot become a zero-valued arrival sale", async () => {
  const call = await bundleApiFixture();
  const incomplete = serviceBundle.map((service, index) => index === 1 ? { ...service, priceMinor: null } : service);
  const created = apiItem(await call("appointments", "POST", { ...bundleBooking(), serviceItems: incomplete }), 201);
  assert.equal(created.priceMinor, null);
  const response = await call("appointments", "PATCH", { status: "arrived" }, 1, String(created.id));
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "arrival_payment");
  const stored = await row(`select * from appointments where id='${created.id}'`);
  assert.equal(stored.status, "confirmed");
  assert.equal(stored.price_minor, null);
  assert.deepEqual(stored.service_items, incomplete);
  assert.equal((await row("select count(*) from deals")).count, 0);
});

test("API legacy total-only PATCH cannot change the stored bundle or record arrival", async () => {
  const call = await bundleApiFixture();
  const created = apiItem(await call("appointments", "POST", bundleBooking()), 201);
  const response = await call("appointments", "PATCH", { priceMinor: 1, status: "arrived" }, 1, String(created.id));
  assert.equal(response.status, 400, JSON.stringify(response.body));
  const stored = await row(`select * from appointments where id='${created.id}'`);
  assert.equal(stored.price_minor, 700050);
  assert.equal(stored.status, "confirmed");
  assert.deepEqual(stored.service_items, serviceBundle);
  assert.equal((await row("select count(*) from deals")).count, 0);
});

test("API rejects a foreign service in the bundle before creating a client or appointment", async () => {
  const call = await bundleApiFixture();
  await db.exec(`update clinic_services set workspace_id='${id(2)}',doctor_id=null where id='${id(51)}'`);
  const response = await call("appointments", "POST", bundleBooking());
  assert.equal(response.status, 400, JSON.stringify(response.body));
  assert.equal((await row("select count(*) from clients")).count, 1);
  assert.equal((await row("select count(*) from appointments")).count, 1);
  assert.equal((await row("select count(*) from deals")).count, 0);
});

async function refuseFixtureInsert(table: "clients" | "appointments" | "deals") {
  // The failure occurs inside the real INSERT, after route preflight checks.
  // Per-request savepoints must not roll back an earlier successful request.
  await db.exec(`create function public.refuse_fixture_insert() returns trigger
    language plpgsql as $$ begin
      raise exception 'Isolated fixture insert refused' using errcode = '23514';
    end $$;
    create trigger refuse_fixture_insert before insert on public.${table}
      for each row execute function public.refuse_fixture_insert()`);
}
async function stopRefusingFixtureInsert(table: "clients" | "appointments" | "deals") {
  await db.exec(`drop trigger refuse_fixture_insert on public.${table}`);
}
async function bookingCounts() {
  return row(`select
    (select count(*) from clients where workspace_id='${id(1)}') as clients,
    (select count(*) from appointments where workspace_id='${id(1)}') as appointments,
    (select count(*) from deals where workspace_id='${id(1)}') as deals`);
}
function assertWriteRefused(response: { status: number; body: Record<string, unknown> }) {
  assert.equal(response.status, 502, JSON.stringify(response.body));
  assert.equal(response.body.success, false);
  assert.equal(response.body.data, undefined);
  assert.doesNotMatch(JSON.stringify(response.body), /Isolated fixture insert refused|23514|fixture-not-a-secret/);
}

test("API client insert failure leaves no visit and a later retry creates one linked pair", async () => {
  const call = await bundleApiFixture("doctor");
  const baseline = await bookingCounts();
  await refuseFixtureInsert("clients");
  assertWriteRefused(await call("appointments", "POST", bundleBooking()));
  assert.deepEqual(await bookingCounts(), baseline);
  await stopRefusingFixtureInsert("clients");
  const saved = apiItem(await call("appointments", "POST", bundleBooking()), 201);
  assert.deepEqual(await bookingCounts(), { clients: 2, appointments: 2, deals: 0 });
  assert.equal((await row(`select client_id from appointments where id='${saved.id}'`)).client_id, saved.clientId);
});

test("API refused appointment INSERT does not leave a new client behind", async () => {
  const call = await bundleApiFixture("doctor");
  const baseline = await bookingCounts();
  await refuseFixtureInsert("appointments");
  assertWriteRefused(await call("appointments", "POST", bundleBooking()));
  assert.deepEqual(await bookingCounts(), baseline);
});

test("API retry after refused appointment INSERT creates only one new client", async () => {
  const call = await bundleApiFixture("doctor");
  await refuseFixtureInsert("appointments");
  assertWriteRefused(await call("appointments", "POST", bundleBooking()));
  await stopRefusingFixtureInsert("appointments");
  const saved = apiItem(await call("appointments", "POST", bundleBooking()), 201);
  assert.equal((await row(`select client_id from appointments where id='${saved.id}'`)).client_id, saved.clientId);
  assert.deepEqual(await bookingCounts(), { clients: 2, appointments: 2, deals: 0 });
});

test("API failure and retry with an explicit client preserve that card and create one visit", async () => {
  const call = await bundleApiFixture();
  const original = await row(`select * from clients where id='${id(3)}'`);
  const booking = { ...bundleBooking(), clientId: id(3) };
  await refuseFixtureInsert("appointments");
  assertWriteRefused(await call("appointments", "POST", booking));
  assert.deepEqual(await bookingCounts(), { clients: 1, appointments: 1, deals: 0 });
  assert.deepEqual(await row(`select * from clients where id='${id(3)}'`), original);
  await stopRefusingFixtureInsert("appointments");
  const saved = apiItem(await call("appointments", "POST", booking), 201);
  assert.equal(saved.clientId, id(3));
  assert.deepEqual(await bookingCounts(), { clients: 1, appointments: 2, deals: 0 });
  assert.deepEqual(await row(`select * from clients where id='${id(3)}'`), original);
});

test("API repeated POST after a saved booking is refused before client creation at capacity one", async () => {
  const call = await bundleApiFixture("doctor");
  apiItem(await call("appointments", "POST", bundleBooking()), 201);
  const stored = await bookingCounts();
  const repeated = await call("appointments", "POST", bundleBooking());
  assert.equal(repeated.status, 409, JSON.stringify(repeated.body));
  assert.equal(repeated.body.code, "appointment_conflict");
  assert.deepEqual(await bookingCounts(), stored);
});

test("API refused arrived INSERT rolls back the client and retry records one linked sale", async () => {
  const call = await bundleApiFixture("doctor");
  const incomplete = serviceBundle.map(service => ({ ...service, priceMinor: null }));
  const refused = await call("appointments", "POST", { ...bundleBooking(), status: "arrived", serviceItems: incomplete });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "arrival_payment");
  assert.deepEqual(await bookingCounts(), { clients: 1, appointments: 1, deals: 0 });
  assert.equal((await row("select count(*) from audit_logs")).count, 0);
  const saved = apiItem(await call("appointments", "POST", { ...bundleBooking(), status: "arrived" }), 201);
  assert.ok(saved.arrivalSaleId);
  assert.deepEqual(await bookingCounts(), { clients: 2, appointments: 2, deals: 1 });
  const receipt = await row(`select * from deals where id='${saved.arrivalSaleId}'`);
  assert.equal(receipt.client_id, saved.clientId);
  assert.equal(receipt.appointment_id, saved.id);
  assert.equal(receipt.amount_minor, 700050);
});

test("API sale INSERT failure rolls back the new card and arrived appointment", async () => {
  const call = await bundleApiFixture();
  await refuseFixtureInsert("deals");
  assertWriteRefused(await call("appointments", "POST", { ...bundleBooking(), status: "arrived" }));
  assert.deepEqual(await bookingCounts(), { clients: 1, appointments: 1, deals: 0 });
  assert.equal((await row("select count(*) from audit_logs")).count, 0);
});

test("API without migration 063 refuses new-card creation but keeps existing-card booking", async () => {
  const call = await bundleApiFixture();
  await db.exec("drop function public.create_crm_appointment_with_new_client(uuid, jsonb, jsonb)");
  const refused = await call("appointments", "POST", bundleBooking());
  assert.equal(refused.status, 503, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "appointment_create_unavailable");
  assert.deepEqual(await bookingCounts(), { clients: 1, appointments: 1, deals: 0 });
  assert.equal((await row("select count(*) from audit_logs")).count, 0);
  assert.equal(apiItem(await call("appointments", "POST", { ...bundleBooking(), clientId: id(3) }), 201).clientId, id(3));
  assert.deepEqual(await bookingCounts(), { clients: 1, appointments: 2, deals: 0 });
});

test("API missing column inside atomic RPC refuses the whole pair without lossy retry", async () => {
  const call = await bundleApiFixture();
  await db.exec("alter table appointments drop column source");
  const refused = await call("appointments", "POST", bundleBooking());
  assert.equal(refused.status, 503, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "appointment_create_unavailable");
  assert.deepEqual(await bookingCounts(), { clients: 1, appointments: 1, deals: 0 });
});

test("API RPC schema-cache refusal never falls back to separate INSERTs", async () => {
  const call = await bundleApiFixture();
  let attempts = 0;
  serverClient.setSupabaseServerClientFactoryForTests(() => ({
    ...apiDatabase(),
    async rpc() {
      attempts += 1;
      return { data: null, error: { code: "PGRST202", message: "Isolated schema cache does not know this function" } };
    },
  }));
  const response = await call("appointments", "POST", bundleBooking());
  assert.equal(response.status, 503, JSON.stringify(response.body));
  assert.equal(response.body.code, "appointment_create_unavailable");
  assert.equal(attempts, 1);
  assert.deepEqual(await bookingCounts(), { clients: 1, appointments: 1, deals: 0 });
  assert.equal((await row("select count(*) from audit_logs")).count, 0);
});

test("API atomic new card preserves contacts and a later phone match reuses it unchanged", async () => {
  const call = await bundleApiFixture();
  const created = apiItem(await call("appointments", "POST", {
    ...bundleBooking(), phone: "+7 700 000 00 01", whatsapp: "+7 700 000 00 02",
  }), 201);
  const card = await row(`select * from clients where id='${created.clientId}'`);
  assert.equal(card.phone_normalized, "+77000000001");
  assert.equal(card.whatsapp_normalized, "+77000000002");
  const later = await call("appointments", "POST", {
    ...bundleBooking(), phone: "8 700 000 00 01", startsAt: "2026-10-03T12:00:00+05:00",
  });
  assert.equal(apiItem(later, 201).clientId, created.clientId);
  assert.equal((later.body.data as Record<string, unknown>).clientCreated, false);
  assert.equal((later.body.data as Record<string, unknown>).clientMatch, "phone");
  assert.deepEqual(await row(`select * from clients where id='${created.clientId}'`), card);
  assert.deepEqual(await bookingCounts(), { clients: 2, appointments: 3, deals: 0 });
});

const atomicRpcArgs = () => ({
  p_workspace_id: id(1),
  p_client: { id: id(70), workspace_id: id(1), full_name: "Isolated atomic client", status: "new" },
  p_appointment: { workspace_id: id(1), client_id: id(70), client_name: "Isolated atomic client", status: "scheduled", duration_minutes: 60 },
});
for (const role of ["anon", "authenticated"] as const) {
  test(`atomic creation RPC refuses direct ${role} execution`, async () => {
    const response = await apiDatabase(role).rpc("create_crm_appointment_with_new_client", atomicRpcArgs());
    assert.equal(response.error?.code, "42501");
    assert.deepEqual(await bookingCounts(), { clients: 1, appointments: 1, deals: 0 });
  });
}

test("atomic creation RPC rejects mixed workspaces, mismatched links and receipt injection", async () => {
  const base = atomicRpcArgs();
  for (const changes of [
    { p_workspace_id: id(2) },
    { p_client: { ...base.p_client, workspace_id: id(2) } },
    { p_appointment: { ...base.p_appointment, workspace_id: id(2) } },
    { p_appointment: { ...base.p_appointment, client_id: id(3) } },
    { p_appointment: { ...base.p_appointment, arrival_sale_id: id(99) } },
  ]) {
    const response = await apiDatabase().rpc("create_crm_appointment_with_new_client", { ...base, ...changes });
    assert.equal(response.error?.code, "22023");
    assert.deepEqual(await bookingCounts(), { clients: 1, appointments: 1, deals: 0 });
  }
});

test("atomic creation RPC cannot overwrite an existing client or accept a foreign doctor", async () => {
  await bundleApiFixture();
  const original = await row(`select * from clients where id='${id(3)}'`);
  const base = atomicRpcArgs();
  const collision = await apiDatabase().rpc("create_crm_appointment_with_new_client", {
    ...base, p_client: { ...base.p_client, id: id(3) }, p_appointment: { ...base.p_appointment, client_id: id(3) },
  });
  assert.equal(collision.error?.code, "23505");
  assert.deepEqual(await row(`select * from clients where id='${id(3)}'`), original);
  await db.exec(`insert into clinic_doctors(id,workspace_id,full_name) values('${id(80)}','${id(2)}','Foreign doctor')`);
  const foreign = await apiDatabase().rpc("create_crm_appointment_with_new_client", {
    ...base, p_appointment: { ...base.p_appointment, doctor_id: id(80) },
  });
  assert.equal(foreign.error?.code, "22023");
  assert.deepEqual(await bookingCounts(), { clients: 1, appointments: 1, deals: 0 });
});

test("migration 063 is repeatable without backfill, activation or public RPC grants", async () => {
  const before = await row(`select jsonb_agg(w order by id) as rows from workspaces w`);
  const source = await readFile(path.join(root, "migrations/063_atomic_appointment_client.sql"), "utf8");
  await db.exec(source.replace(/^begin;$/m, "").replace(/^commit;$/m, ""));
  assert.deepEqual(await row(`select jsonb_agg(w order by id) as rows from workspaces w`), before);
  assert.deepEqual(await bookingCounts(), { clients: 1, appointments: 1, deals: 0 });
  assert.deepEqual(await row(`select
    has_function_privilege('anon', 'public.create_crm_appointment_with_new_client(uuid,jsonb,jsonb)', 'execute') as anon,
    has_function_privilege('authenticated', 'public.create_crm_appointment_with_new_client(uuid,jsonb,jsonb)', 'execute') as authenticated,
    has_function_privilege('service_role', 'public.create_crm_appointment_with_new_client(uuid,jsonb,jsonb)', 'execute') as service`),
  { anon: false, authenticated: false, service: true });
});

test("arrival creates one paid KZT sale using visit price and client", async () => {
  await arrive();
  const deal = await sale();
  assert.equal(deal.amount_minor, 1500000);
  assert.equal(deal.currency, "KZT");
  assert.equal(deal.status, "paid");
  assert.equal(deal.client_id, id(3));
  assert.ok(deal.paid_at);
  assert.equal((await row(`select arrival_sale_id from appointments where id='${id(10)}'`)).arrival_sale_id, deal.id);
});
test("repeat arrival and reversal do not duplicate payment or change paid date", async () => {
  await arrive();
  const first = await sale();
  await arrive();
  await db.exec(`update appointments set status='confirmed' where id='${id(10)}'`);
  await arrive();
  assert.equal((await row("select count(*) from deals")).count, 1);
  assert.deepEqual((await sale()).paid_at, first.paid_at);
});
test("missing price refuses both arrival and sale, explicit zero is allowed", async () => {
  await db.exec(`update appointments set price_minor=null where id='${id(10)}'`);
  await rejects(`update appointments set status='arrived' where id='${id(10)}'`, "P6105");
  assert.equal((await row(`select status from appointments where id='${id(10)}'`)).status, "confirmed");
  assert.equal((await row("select count(*) from deals")).count, 0);
  await db.exec(`update appointments set price_minor=0 where id='${id(10)}'`);
  await arrive();
  assert.equal((await sale()).amount_minor, 0);
});
test("arrived INSERT is atomic too", async () => {
  await db.exec(`insert into appointments(id,workspace_id,service,price_minor,status)
    values('${id(11)}','${id(1)}','Walk-in',250000,'arrived')`);
  assert.ok((await row(`select arrival_sale_id from appointments where id='${id(11)}'`)).arrival_sale_id);
});
test("unknown status is not payment confirmation", async () => {
  await db.exec(`update appointments set status=null where id='${id(10)}'`);
  assert.equal((await row("select count(*) from deals")).count, 0);
});
test("pending sale is reused; attribution is preserved", async () => {
  await db.exec(`insert into deals(id,workspace_id,appointment_id,title,amount_minor,status,notes)
    values('${id(20)}','${id(1)}','${id(10)}','Pending',100,'pending','Keep note')`);
  await arrive();
  const deal = await sale();
  assert.equal(deal.id, id(20));
  assert.equal(deal.amount_minor, 1500000);
  assert.equal(deal.notes, "Keep note");
  assert.equal(deal.status, "paid");
});
test("already paid receipt and amount are not overwritten", async () => {
  await db.exec(`insert into deals(workspace_id,appointment_id,title,amount_minor,status,paid_at)
    values('${id(1)}','${id(10)}','Paid earlier',12300,'paid','2025-01-01')`);
  await arrive();
  assert.equal((await sale()).amount_minor, 12300);
});
test("manual duplicate sale is refused after arrival", async () => {
  await arrive();
  await rejects(`insert into deals(workspace_id,appointment_id,title)
    values('${id(1)}','${id(10)}','Duplicate')`, "P6102");
});
test("multiple historical sales are not silently overwritten", async () => {
  await db.exec(`update workspaces set arrival_marks_paid=false where id='${id(1)}';
    insert into deals(workspace_id,appointment_id,title) values
      ('${id(1)}','${id(10)}','First'),('${id(1)}','${id(10)}','Second');
    update workspaces set arrival_marks_paid=true where id='${id(1)}'`);
  await rejects(`update appointments set status='arrived' where id='${id(10)}'`, "P6103");
  assert.equal((await row("select count(*) from deals where status='pending'")).count, 2);
});
test("multiple services use their saved total rather than current catalogue prices", async () => {
  await db.exec(`update appointments set service_items='[
    {"name":"First","priceMinor":1000000,"durationMinutes":60},
    {"name":"Second","priceMinor":500000,"durationMinutes":30}
  ]' where id='${id(10)}'`);
  await arrive();
  assert.equal((await sale()).amount_minor, 1500000);
});
test("refund stays refunded on repeat arrival; receipt cannot be detached", async () => {
  await arrive();
  await db.exec("update deals set status='refunded'");
  await db.exec(`update appointments set status='confirmed' where id='${id(10)}'`);
  await arrive();
  assert.equal((await sale()).status, "refunded");
  await rejects("update deals set appointment_id=null", "P6107");
});
test("cancelled receipt must be reviewed rather than resurrected", async () => {
  await db.exec(`insert into deals(workspace_id,appointment_id,title,status)
    values('${id(1)}','${id(10)}','Cancelled','cancelled')`);
  await rejects(`update appointments set status='arrived' where id='${id(10)}'`, "P6104");
});
test("other currency pending sale fails without conversion", async () => {
  await db.exec(`insert into deals(workspace_id,appointment_id,title,currency)
    values('${id(1)}','${id(10)}','USD','USD')`);
  await rejects(`update appointments set status='arrived' where id='${id(10)}'`, "P6106");
});
test("default-disabled workspaces and historical visits stay untouched", async () => {
  await db.exec(`insert into appointments(id,workspace_id,status,price_minor)
    values('${id(11)}','${id(2)}','arrived',40000);
    update workspaces set arrival_marks_paid=true where id='${id(2)}';
    update appointments set notes='Edit only' where id='${id(11)}'`);
  assert.equal((await row("select count(*) from deals")).count, 0);
});
test("cross-workspace sale cannot be linked", async () => {
  await rejects(`insert into deals(workspace_id,appointment_id,title)
    values('${id(2)}','${id(10)}','Foreign')`, "P6101");
});
test("migration is repeatable and does not enable any workspace", async () => {
  // Do not execute transaction-wrapped migration inside per-test transaction.
  const source = await readFile(path.join(root, "migrations/061_appointment_arrival_payment.sql"), "utf8");
  await db.exec(source.replace(/^begin;$/m, "").replace(/^commit;$/m, ""));
  assert.equal((await row(`select arrival_marks_paid from workspaces where id='${id(2)}'`)).arrival_marks_paid, false);
});
test("only allowlisted database errors are exposed", () => {
  assert.match(arrivalPaymentError({ code: "P6105" })!, /стоимость/);
  assert.equal(arrivalPaymentError({ code: "XX000" }), null);
});

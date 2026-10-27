import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { before, after, beforeEach, afterEach } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createRequire } from "node:module";
import { createSalesRetryRuntime } from "./sales-retry-test-runtime.js";
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
  const numbers = new Set([9, 10, 11, 12, 13, 14, 19, 20, 29, 30, 32, 33, 34, 35, 36, 40, 43, 45, 52, 53, 54, 55, 56, 57, 61, 63, 64, 72, 73, 102]);
  for (const file of (await readdir(path.join(root, "migrations"))).sort()) {
    if (!numbers.has(Number(file.slice(0, 3)))) continue;
    try {
      await db.exec((await readFile(path.join(root, "migrations", file), "utf8"))
        .replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/i, ""));
    } catch (error) {
      throw new Error(`${file}: ${(error as Error).message}`);
    }
  }
  // 076 is being developed locally: execute its actual source, never a Git-only
  // snapshot or a synthetic receipt implementation. 059/065 remain excluded.
  await db.exec(await readFile(path.join(root, "migrations/076_crm_sale_create_requests.sql"), "utf8"));
  await db.exec(await readFile(path.join(root, "migrations/115_appointment_request_actor.sql"), "utf8"));
  await db.exec(await readFile(path.join(root, "migrations/116_appointment_patch_actor.sql"), "utf8"));
  await db.exec(await readFile(path.join(root, "migrations/117_appointment_edit_version.sql"), "utf8"));
  await db.exec(await readFile(path.join(root, "migrations/118_appointment_version_entry.sql"), "utf8"));
  await db.exec(await readFile(path.join(root, "migrations/119_appointment_patch_journal.sql"), "utf8"));
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
// DDL-refusal cases must not leave cached WASM plans using a rolled-back row type.
afterEach(() => db.exec("rollback; discard plans"));

// Execute real route queries and trigger writes, rather than returning canned
// successful API responses. This adapter is intentionally test-local/read-write.
type ApiFilter = [string, "=" | ">=" | "<" | "<=" | "in" | "ilike", unknown];
type ApiQuery = { table: string; operation: string; columns: string; filters: ApiFilter[] };
function apiDatabase(rpcRole: "postgres" | "service_role" | "anon" | "authenticated" = "service_role", queries: ApiQuery[] = [], database = db, failConflictRead = false) {
  const ident = (value: string) => {
    assert.match(value, /^[a-z_][a-z0-9_]*$/);
    return `"${value}"`;
  };
  return {
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === "patch_crm_appointment_journaled") queries.push({ table: "appointments", operation: "rpc:patch_crm_appointment_journaled",
        columns: "*", filters: [["id", "=", args.p_appointment_id], ["workspace_id", "=", args.p_workspace_id]] });
      const calls: Record<string, { sql: string; params: unknown[] }> = {
        create_crm_appointment_with_new_client: {
          sql: "select public.create_crm_appointment_with_new_client($1::uuid, $2::jsonb, $3::jsonb) as item",
          params: [args.p_workspace_id, JSON.stringify(args.p_client), JSON.stringify(args.p_appointment)],
        },
        read_crm_appointment_request_v2: {
          sql: "select public.read_crm_appointment_request_v2($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6) as item",
          params: [args.p_workspace_id, args.p_staff_user_id, args.p_auth_user_id, args.p_actor_role, args.p_request_key, args.p_request_fingerprint],
        },
        create_crm_appointment_v2: {
          sql: "select public.create_crm_appointment_v2($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6,$7::jsonb,$8::jsonb,$9) as item",
          params: [args.p_workspace_id, args.p_staff_user_id, args.p_auth_user_id, args.p_actor_role, args.p_request_key, args.p_request_fingerprint,
            args.p_new_client === null ? null : JSON.stringify(args.p_new_client), JSON.stringify(args.p_appointment), args.p_client_match],
        },
        patch_crm_appointment_journaled: {
          sql: "select public.patch_crm_appointment_journaled($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7::jsonb,$8::jsonb,$9::jsonb) as item",
          params: [args.p_workspace_id, args.p_staff_user_id, args.p_auth_user_id, args.p_actor_role, args.p_appointment_id,
            args.p_expected_edit_version, JSON.stringify(args.p_before), JSON.stringify(args.p_patch), JSON.stringify(args.p_journal)],
        },
        read_crm_sale_create_request: {
          sql: "select public.read_crm_sale_create_request($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text) as item",
          params: [args.p_workspace_id, args.p_staff_user_id, args.p_auth_user_id, args.p_request_key, args.p_request_fingerprint],
        },
        create_crm_sale_once: {
          sql: "select public.create_crm_sale_once($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::jsonb) as item",
          params: [args.p_workspace_id, args.p_staff_user_id, args.p_auth_user_id, args.p_request_key,
            args.p_request_fingerprint, JSON.stringify(args.p_sale)],
        },
      };
      assert.ok(calls[name], `Unexpected RPC ${name}`);
      await database.exec(`savepoint api_rpc; set local role ${rpcRole}`);
      try {
        const result = await database.query<{ item: Record<string, unknown> }>(
          calls[name].sql, calls[name].params,
        );
        await database.exec("reset role; release savepoint api_rpc");
        return { data: result.rows[0].item, error: null };
      } catch (error) {
        await database.exec("rollback to savepoint api_rpc; release savepoint api_rpc");
        const failure = error as { code: string; message: string };
        return { data: null, error: { code: failure.code, message: failure.code === "23P01" && failure.message === "appointment_capacity_exceeded"
          ? failure.message : "Isolated database rejected the RPC" } };
      }
    },
    from(table: string) {
    let operation = "select", single = false, columns = "*";
    let values: Record<string, unknown> = {};
    const filters: ApiFilter[] = [];
    let limit: number | undefined;
    async function execute() {
      queries.push({ table, operation, columns, filters: [...filters] });
      if (failConflictRead && table === "appointments" && operation === "select"
        && columns === "id, client_name, doctor_id, doctor_name, starts_at, duration_minutes, status") {
        return { data: null, error: { code: "57014", message: "Synthetic advisory read timeout" } };
      }
      const params: unknown[] = [];
      const bind = (value: unknown) => {
        params.push(Array.isArray(value) ? JSON.stringify(value) : value);
        return `$${params.length}`;
      };
      const leadColumns = "*,stage_definition:lead_stages(id,stage_key,name,color,semantic_group,sort_order,is_default,is_active),source_definition:lead_sources(id,source_key,name,channel,color,sort_order,is_default,is_active)";
      // Execute the router's known embedded lead projection against real rows.
      const selection = table === "leads" && columns === leadColumns
        ? `"leads".*,
          (select to_jsonb(definition) from (select id,stage_key,name,color,semantic_group,sort_order,is_default,is_active
            from lead_stages where id="leads".stage_id) definition) as stage_definition,
          (select to_jsonb(definition) from (select id,source_key,name,channel,color,sort_order,is_default,is_active
            from lead_sources where id="leads".source_id) definition) as source_definition`
        : columns === "*" ? "*" : columns.split(",").map(v => ident(v.trim())).join(",");
      let sql = `select ${selection} from ${ident(table)}`;
      if (operation === "update") sql = `update ${ident(table)} set ${Object.entries(values)
        .map(([key, value]) => `${ident(key)}=${bind(value)}`).join(",")}`;
      if (operation === "insert") sql = `insert into ${ident(table)} (${Object.keys(values).map(ident).join(",")}) values (${Object.values(values).map(bind).join(",")})`;
      if (filters.length) sql += " where " + filters.map(([key, operator, value]) => {
        if (operator === "ilike") return `${ident(key)} ilike ${bind(value)}`;
        if (operator !== "in") return `${ident(key)}${operator}${bind(value)}`;
        assert.ok(Array.isArray(value));
        return value.length ? `${ident(key)} in (${value.map(bind).join(",")})` : "false";
      }).join(" and ");
      if (operation !== "select") sql += ` returning ${selection}`;
      if (operation === "select" && limit !== undefined) sql += ` limit ${limit}`;
      // Settings read failures must not abort the enclosing fixture transaction.
      const savepoint = operation !== "select" ? "api_write" : table === "workspace_settings" ? "api_settings" : null;
      if (savepoint) await database.exec(`savepoint ${savepoint}`);
      try {
        const serialized = operation === "select" ? `select row_to_json(owned_row) value from (${sql}) owned_row`
          : `with owned_row as (${sql}) select row_to_json(owned_row) value from owned_row`;
        const result = await database.query<{ value: Record<string, unknown> }>(serialized, params);
        if (savepoint) await database.exec(`release savepoint ${savepoint}`);
        // PostgREST returns SQL DATE as YYYY-MM-DD, not a JS Date timestamp.
        if (table === "clinic_doctor_shifts") for (const row of result.rows.map(row => row.value)) {
          for (const key of ["on_date", "on_date_end"]) if (row[key] instanceof Date) row[key] = row[key].toISOString().slice(0, 10);
        }
        const rows = result.rows.map(row => row.value);
        return { data: single ? rows[0] ?? null : rows, error: null };
      } catch (error) {
        if (savepoint) await database.exec(`rollback to savepoint ${savepoint}; release savepoint ${savepoint}`);
        return { data: null, error: { code: (error as { code: string }).code, message: "Isolated database rejected the query" } };
      }
    }
    const query = {
      select(value: string) { columns = value; return query; },
      eq(key: string, value: unknown) { filters.push([key, "=", value]); return query; },
      ilike(key: string, value: string) { filters.push([key, "ilike", value]); return query; },
      in(key: string, value: unknown[]) { filters.push([key, "in", [...value]]); return query; },
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
  const queries: ApiQuery[] = [];
  serverClient.setSupabaseServerClientFactoryForTests(() => apiDatabase("service_role", queries));
  return async (route = "appointments", method = "PATCH", updates: Record<string, unknown> = { status: "arrived" }, workspace = 1, appointmentId = id(10)) => {
    queries.length = 0;
    let status = 0; let body: Record<string, unknown> = {};
    const res = { setHeader() {}, status(value: number) { status = value; return res; },
      json(value: Record<string, unknown>) { body = value; } };
    // These stateless API tests start from a newly observed row. The native
    // composed browser suite separately freezes and races the open form token.
    const version = route === "appointments" && method === "PATCH" ? (await db.query<{ edit_version: string }>(
      "select edit_version from appointments where id=$1 and workspace_id=$2", [appointmentId, id(workspace)],
    )).rows[0]?.edit_version : undefined;
    await handler({ method, headers: { authorization: "Bearer fixture.test.signature" },
      query: { path: [route], workspaceId: id(workspace) },
      body: method === "GET" ? undefined : method === "POST" ? updates : { id: appointmentId, expectedEditVersion: version, updates } }, res);
    return { status, body, queries: [...queries] };
  };
}
afterEach(() => {
  serverClient.setSupabaseServerClientFactoryForTests(null);
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
});

const profileQueries = (queries: ApiQuery[]) => queries.filter(query => query.table === "workspace_settings"
  && query.filters.some(([key, operator, value]) => key === "key" && operator === "=" && value === "workspace_purpose"));

test("API arrival returns persisted sale link and sales exposes exact paid amount", async () => {
  const call = await apiFixture();
  const response = await call();
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(profileQueries(response.queries), [{ table: "workspace_settings", operation: "select",
    columns: "workspace_id, value", filters: [["workspace_id", "in", [id(1)]], ["key", "=", "workspace_purpose"]] }]);
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
test("API profile lookup ignores foreign profiles and unrelated settings without changing arrival payment", async () => {
  const call = await apiFixture();
  await db.exec(`insert into workspace_settings(workspace_id,key,value) values
    ('${id(2)}','workspace_purpose','{"purpose":"mortgage_leads"}'),
    ('${id(1)}','fixture_setting','{"retained":true}')`);
  assert.equal((await call()).status, 200);
  assert.equal((await sale()).amount_minor, 1500000);
  assert.deepEqual((await row(`select value from workspace_settings where workspace_id='${id(1)}'`)).value, { retained: true });
  const empty = await apiDatabase().from("workspace_settings").select("workspace_id, value").in("workspace_id", []);
  assert.deepEqual(empty, { data: [], error: null });
});

for (const failure of ["malformed", "query error"]) {
  test(`API ${failure} profile fails closed before any arrival writes and remains retryable`, async () => {
    const call = await apiFixture();
    const before = await retryCounts();
    if (failure === "malformed") {
      await db.exec(`insert into workspace_settings(workspace_id,key,value)
        values('${id(1)}','workspace_purpose','{"purpose":"unrecognized"}')`);
    } else {
      await db.exec("alter table workspace_settings rename column value to fixture_value");
    }
    const response = await call();
    assert.equal(response.status, 503, JSON.stringify(response.body));
    assert.equal(response.body.code, "workspace_profile_unavailable");
    assert.equal(response.body.data, undefined);
    const profiles = profileQueries(response.queries);
    assert.equal(profiles.length, 1);
    assert.deepEqual(response.queries.filter(query => query.table !== "staff_users" && !profiles.includes(query)), []);
    assert.deepEqual(await retryCounts(), before);
    assert.equal((await row(`select status from appointments where id='${id(10)}'`)).status, "confirmed");
    if (failure === "malformed") await db.exec("delete from workspace_settings where key='workspace_purpose'");
    else await db.exec("alter table workspace_settings rename column fixture_value to value");
    assert.equal((await call()).status, 200);
    assert.equal((await sale()).amount_minor, 1500000);
  });
}

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

test("G2 actual router + 063/064/072/073/076/102 separates identities and replays one visit and pending sale", { timeout: 120000 }, async () => {
  // Separate WASM database: the historical suite below keeps its original
  // schema. Real native locking and raw full-chain acceptance run separately.
  const composed = new PGlite();
  try {
    await composed.exec("create role anon; create role authenticated; create role service_role bypassrls;");
    const numbers = new Set([9,10,11,12,13,14,19,20,29,30,32,33,34,36,40,43,45,52,53,54,55,56,57,61,63,64,72,73,76,102,115]);
    for (const file of (await readdir(path.join(root, "migrations"))).sort()) if (numbers.has(Number(file.slice(0, 3)))) {
      // PGlite has built-in UUID support, not native pgcrypto extension files.
      const source = await readFile(path.join(root, "migrations", file), "utf8");
      await composed.exec(Number(file.slice(0, 3)) === 9 ? source.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/i, "") : source);
    }
    const call = await apiFixture(); // Synthetic Auth identity only; no external Auth request.
    let advisoryUnavailable = false;
    serverClient.setSupabaseServerClientFactoryForTests(() => apiDatabase("service_role", [], composed, advisoryUnavailable));
    await composed.exec(`begin;
      insert into workspaces(id,name) values('${id(1)}','Owned composed calendar');
      insert into workspace_settings(workspace_id,key,value) values('${id(1)}','clinic_schedule','{"timeZone":"UTC"}');
      insert into staff_users(id,workspace_id,auth_user_id,full_name,email,role)
        values('${id(40)}','${id(1)}','${id(41)}','Test master','composed@example.invalid','owner');
      insert into clinic_doctors(id,workspace_id,full_name,staff_user_id,capacity) values
        ('${id(42)}','${id(1)}','Test master','${id(40)}',2),('${id(43)}','${id(1)}','Renamed doctor',null,2);
      insert into clinic_doctor_shifts(workspace_id,doctor_id,on_date,on_date_end,start_minute,end_minute,is_working)
        values('${id(1)}','${id(42)}','2090-10-20','2090-10-20',0,1440,true);
      insert into appointments(workspace_id,doctor_id,doctor_name,client_name,starts_at,duration_minutes,status) values
        ('${id(1)}','${id(43)}','Test master','Other resource A','2090-10-20T09:00:00Z',60,'confirmed'),
        ('${id(1)}','${id(43)}','Test master','Other resource B','2090-10-20T09:00:00Z',60,'confirmed');`);
    const body = { requestKey: id(70), client: "Owned composed new client", doctorId: id(42), doctor: "Test master",
      startsAt: "2090-10-20T09:00:00Z", status: "confirmed",
      serviceItems: [{ serviceId: "", name: "Owned service", priceMinor: 700050, durationMinutes: 60 }] };
    const first = apiItem(await call("appointments", "POST", body), 201);
    const second = apiItem(await call("appointments", "POST", { ...body, requestKey: id(71), client: "Second owned client" }), 201);
    assert.notEqual(first.id, second.id);
    const state = async () => (await composed.query<Record<string, number>>(`select
      (select count(*)::int from clients) as clients,(select count(*)::int from appointments) as appointments,
      (select count(*)::int from crm_appointment_create_requests) as receipts,
      (select count(*)::int from deals) as deals,(select count(*)::int from crm_sale_create_requests) as sale_receipts,
      (select count(*)::int from audit_logs) as journal`)).rows[0];
    const full = await state();
    assert.equal(full.clients, 2); assert.equal(full.appointments, 4); assert.equal(full.receipts, 2); assert.equal(full.deals, 0);
    const third = await call("appointments", "POST", { ...body, requestKey: id(72), client: "Refused owned client" });
    assert.equal(third.status, 409, JSON.stringify(third.body));
    assert.deepEqual(await state(), full);
    advisoryUnavailable = true;
    const atomicRefusal = await call("appointments", "POST", { ...body, requestKey: id(74), client: "SQL refuses despite read timeout" });
    advisoryUnavailable = false;
    assert.equal(atomicRefusal.status, 409, JSON.stringify(atomicRefusal.body));
    assert.deepEqual(await state(), full, "the actual trigger, not a canned successful/refused RPC, must roll back every side effect");
    const replay = await call("appointments", "POST", body); // Simulate dropping the first success reply.
    assert.deepEqual(apiItem(replay), first);
    assert.equal((replay.body.data as Record<string, unknown>).replayed, true);
    assert.deepEqual(await state(), full);
    const manualSale = { requestKey: id(170), title: "Owned pending sale", amountMinor: 700050, currency: "KZT", status: "pending",
      appointmentId: first.id, clientId: first.clientId, responsibleUserId: id(40) };
    const savedSale = apiItem(await call("deals", "POST", manualSale), 201);
    assert.equal(savedSale.status, "pending"); assert.equal(savedSale.amountMinor, 700050);
    const withSale = await state();
    assert.equal(withSale.deals, 1); assert.equal(withSale.sale_receipts, 1);
    const saleReplay = await call("deals", "POST", manualSale);
    assert.equal(apiItem(saleReplay).id, savedSale.id);
    assert.equal((saleReplay.body.data as Record<string, unknown>).replayed, true);
    assert.deepEqual(await state(), withSale);
    await composed.query('update appointments set doctor_name=$1 where doctor_id=$2', ['Changed stored label', id(42)]);
    assert.equal((await call("appointments", "POST", { ...body, requestKey: id(73), client: "Still refused" })).status, 409);
    assert.deepEqual(await state(), withSale);
  } finally {
    await composed.exec("rollback");
    await composed.close();
  }
});

const retryCounts = () => row(`select (select count(*) from clients) as clients,
  (select count(*) from appointments) as appointments, (select count(*) from deals) as sales,
  (select count(*) from crm_appointment_create_requests) as receipts,
  (select count(*) from audit_logs) as journal`);

const keyedSale = (changes: Record<string, unknown> = {}) => ({
  requestKey: id(170), title: "Isolated manual sale", amountMinor: 700050, currency: "KZT", status: "pending",
  clientId: id(3), appointmentId: id(10), serviceId: id(50), responsibleUserId: id(40), notes: "Original sale intent",
  ...changes,
});
async function saleApiFixture(role = "owner") {
  const call = await bundleApiFixture(role);
  await db.exec(`update workspaces set arrival_marks_paid=false where id='${id(1)}'`);
  return call;
}
// Inspect as the fixture owner: service_role may execute the RPCs but cannot read receipts directly.
const saleRequestState = () => row(`select jsonb_build_object(
  'sales',(select jsonb_agg(d order by id) from deals d),
  'receipts',(select jsonb_agg(r order by workspace_id,staff_user_id,request_key) from crm_sale_create_requests r),
  'journal',(select jsonb_agg(j order by id) from audit_logs j)) as state`);
const saleRpcArgs = (changes: Record<string, unknown> = {}) => ({
  p_workspace_id: id(1), p_staff_user_id: id(40), p_auth_user_id: id(41),
  p_request_key: id(170), p_request_fingerprint: "a".repeat(64),
  p_sale: { workspace_id: id(1), title: "SQL manual pending sale", amount_minor: 700050, currency: "KZT", status: "pending",
    client_id: id(3), appointment_id: id(10), service_id: id(50), responsible_user_id: id(40) },
  ...changes,
});

for (const role of ["owner", "admin", "receptionist", "manager"]) {
  test(`API keyed sale ${role}: same intent replays one sale, receipt and first-create journal`, async () => {
    const call = await saleApiFixture(role);
    const body = keyedSale();
    const first = await call("deals", "POST", body);
    const saved = apiItem(first, 201);
    assert.equal((first.body.data as Record<string, unknown>).replayed, false);
    assert.equal(saved.status, "pending"); assert.equal(saved.paidAt, null);
    assert.equal((await row("select count(*) from crm_sale_create_requests")).count, 1);
    assert.equal((await row("select count(*) from deals")).count, 1);
    assert.equal((await row("select count(*) from audit_logs where entity_type='deal'")).count, 1);
    const before = await saleRequestState();
    const replay = await call("deals", "POST", body);
    assert.deepEqual(apiItem(replay), saved);
    assert.equal((replay.body.data as Record<string, unknown>).replayed, true);
    assert.deepEqual(await saleRequestState(), before);
  });
}

test("API keyed sale hashes normalized original intent, not supplied fingerprints or generated fields", async () => {
  const call = await saleApiFixture();
  const saved = apiItem(await call("deals", "POST", { ...keyedSale(), requestFingerprint: "forged" }), 201);
  const receipt = await row("select * from crm_sale_create_requests");
  assert.match(String(receipt.request_fingerprint), /^[0-9a-f]{64}$/);
  assert.equal(receipt.workspace_id, id(1)); assert.equal(receipt.staff_user_id, id(40));
  assert.equal(receipt.request_key, id(170)); assert.equal(receipt.sale_id, saved.id);
  const before = await saleRequestState();
  const replay = await call("deals", "POST", {
    requestKey: id(170), title: "  Isolated manual sale  ", amount_minor: 700050, currency: "kzt", status: "PENDING",
    client_id: id(3), appointment_id: id(10), service_id: id(50), responsible_user_id: id(40), notes: "Original sale intent",
    requestFingerprint: "different-forgery", id: id(999), created_at: "2090-01-01", updated_at: "2091-01-01",
  });
  assert.deepEqual(apiItem(replay), saved);
  assert.equal((replay.body.data as Record<string, unknown>).replayed, true);
  assert.deepEqual(await saleRequestState(), before);
});

test("API keyed sale rejects changed intent before reference preflight without writes", async () => {
  const call = await saleApiFixture();
  apiItem(await call("deals", "POST", keyedSale()), 201);
  const receipt = await row("select request_fingerprint from crm_sale_create_requests");
  const before = await saleRequestState();
  for (const updates of [{ title: "Different sale" }, { amountMinor: 700051 }, { currency: "USD" }, { status: "paid" },
    { notes: "Different intent" }, { paymentMethod: "cash" }, { clientId: id(999) }, { appointmentId: id(999) },
    { serviceId: id(999) }, { responsibleUserId: id(999) }, { paidAt: "2090-01-01T00:00:00Z" }]) {
    const reply = await call("deals", "POST", { ...keyedSale(), ...updates, requestFingerprint: receipt.request_fingerprint });
    assert.equal(reply.status, 409, JSON.stringify(reply.body));
    assert.equal(reply.body.data, undefined);
    assert.deepEqual(await saleRequestState(), before);
    assert.deepEqual(reply.queries.filter(query => query.operation !== "select"), []);
  }
});

for (const keyed of [false, true]) {
  test(`API ${keyed ? "different sale keys" : "legacy unkeyed sales"} preserve intentional create-new behavior`, async () => {
    const call = await saleApiFixture();
    const { requestKey: _key, ...legacy } = keyedSale();
    const first = apiItem(await call("deals", "POST", keyed ? keyedSale() : legacy), 201);
    const second = apiItem(await call("deals", "POST", keyed ? keyedSale({ requestKey: id(171) }) : legacy), 201);
    assert.notEqual(first.id, second.id);
    assert.equal((await row("select count(*) from deals")).count, 2);
    assert.equal((await row("select count(*) from crm_sale_create_requests")).count, keyed ? 2 : 0);
    assert.equal((await row("select count(*) from deals where status='paid' or paid_at is not null")).count, 0);
  });
}

test("API sale receipts isolate verified actor/workspace and ignore supplied scope fields", async () => {
  const call = await saleApiFixture();
  const body = keyedSale({ clientId: "", appointmentId: "", serviceId: "", responsibleUserId: "" });
  const first = apiItem(await call("deals", "POST", { ...body, workspaceId: id(2), staffUserId: id(99), authUserId: id(99) }), 201);
  const before = await saleRequestState();
  assert.equal((await call("deals", "POST", body, 2)).status, 403);
  assert.deepEqual(await saleRequestState(), before);
  await db.exec(`insert into staff_users(id,workspace_id,auth_user_id,full_name,email,role) values
    ('${id(43)}','${id(1)}','${id(44)}','Second local actor','second@example.invalid','admin'),
    ('${id(45)}','${id(2)}','${id(46)}','Other local workspace','other@example.invalid','owner')`);
  let actor = id(44);
  globalThis.fetch = (async (url: unknown) => {
    assert.equal(url, "https://fixture.invalid/auth/v1/user");
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: actor }) };
  }) as unknown as typeof fetch;
  const second = apiItem(await call("deals", "POST", { ...body, staffUserId: id(40), authUserId: id(41) }), 201);
  actor = id(46);
  const third = apiItem(await call("deals", "POST", { ...body, workspaceId: id(1), staffUserId: id(40) }, 2), 201);
  assert.equal(new Set([first.id, second.id, third.id]).size, 3);
  const receipts = (await db.query("select workspace_id,staff_user_id,request_key,sale_id from crm_sale_create_requests order by staff_user_id")).rows;
  assert.deepEqual(receipts, [
    { workspace_id: id(1), staff_user_id: id(40), request_key: id(170), sale_id: first.id },
    { workspace_id: id(1), staff_user_id: id(43), request_key: id(170), sale_id: second.id },
    { workspace_id: id(2), staff_user_id: id(45), request_key: id(170), sale_id: third.id },
  ]);
});

test("API sale replay preserves later edits despite archived catalogue", async () => {
  const call = await saleApiFixture();
  const saved = apiItem(await call("deals", "POST", keyedSale()), 201);
  const edited = apiItem(await call("deals", "PATCH", { notes: "Later edit", amountMinor: 12345, status: "cancelled" }, 1, String(saved.id)));
  await db.exec("update clinic_services set is_active=false");
  const before = await saleRequestState();
  const reply = await call("deals", "POST", keyedSale());
  // SQL JSON retains the session offset; the query adapter serializes Dates as UTC.
  const instants = (item: Record<string, unknown>) => ({ ...item,
    createdAt: new Date(String(item.createdAt)).toISOString(), updatedAt: new Date(String(item.updatedAt)).toISOString() });
  assert.deepEqual(instants(apiItem(reply)), instants(edited));
  assert.equal((reply.body.data as Record<string, unknown>).replayed, true);
  assert.equal(reply.queries.some(query => query.table === "clinic_services"), false, "replay precedes active catalogue preflight");
  assert.deepEqual(await saleRequestState(), before);
});

test("API sale saved between receipt lookup and failed catalogue preflight replays without loser writes", async () => {
  const call = await saleApiFixture();
  const base = apiDatabase();
  let inserted = false, reads = 0, routeCreates = 0;
  let winner: Record<string, unknown> = {};
  let winnerState: Record<string, unknown> = {};
  serverClient.setSupabaseServerClientFactoryForTests(() => ({ ...base, rpc: async (name: string, args: Record<string, unknown>) => {
    if (name === "read_crm_sale_create_request") reads++;
    if (name === "create_crm_sale_once") routeCreates++;
    const result = await base.rpc(name, args);
    if (name === "read_crm_sale_create_request" && !inserted) {
      assert.equal(result.data, null);
      inserted = true;
      // Real SQL interleaving in one fixture transaction, not a two-connection lock test.
      const saved = await base.rpc("create_crm_sale_once", { ...args, p_sale: { ...saleRpcArgs().p_sale,
        title: "Isolated manual sale", notes: "Original sale intent", paid_at: null, closed_at: null, payment_method: null } });
      assert.equal(saved.error, null);
      winner = (saved.data as Record<string, unknown>).sale as Record<string, unknown>;
      await db.exec("update clinic_services set is_active=false");
      winnerState = await saleRequestState();
    }
    return result;
  } }));
  const reply = await call("deals", "POST", keyedSale());
  assert.equal(apiItem(reply).id, winner.id);
  assert.equal((reply.body.data as Record<string, unknown>).replayed, true);
  assert.equal(reads, 2); assert.equal(routeCreates, 0);
  assert.deepEqual(await saleRequestState(), winnerState);
  assert.equal((await row("select count(*) from audit_logs")).count, 0, "loser replay cannot invent a post-domain audit");
});

test("API deleted sale keeps its receipt tombstone and refuses resurrection", async () => {
  const call = await saleApiFixture();
  const saved = apiItem(await call("deals", "POST", keyedSale()), 201);
  await db.query("delete from deals where id=$1", [saved.id]);
  const receipt = await row("select * from crm_sale_create_requests");
  assert.equal(receipt.sale_id, null);
  const before = await saleRequestState();
  const reply = await call("deals", "POST", keyedSale());
  assert.equal(reply.status, 409, JSON.stringify(reply.body));
  assert.equal(reply.body.data, undefined);
  assert.deepEqual(await saleRequestState(), before);
  const direct = await apiDatabase().rpc("read_crm_sale_create_request", saleRpcArgs({ p_request_fingerprint: receipt.request_fingerprint }));
  assert.equal(direct.error?.code, "P7603");
});

for (const revoke of ["status='inactive'", "role='doctor'", `auth_user_id='${id(999)}'`]) {
  test(`API sale replay denies current actor revocation ${revoke} before receipt access`, async () => {
    const call = await saleApiFixture();
    apiItem(await call("deals", "POST", keyedSale()), 201);
    await db.exec(`update staff_users set ${revoke} where id='${id(40)}'`);
    const before = await saleRequestState();
    let receiptReads = 0;
    const base = apiDatabase();
    serverClient.setSupabaseServerClientFactoryForTests(() => ({ ...base, rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "read_crm_sale_create_request") receiptReads++;
      return base.rpc(name, args);
    } }));
    const reply = await call("deals", "POST", keyedSale());
    assert.equal(reply.status, 403, JSON.stringify(reply.body));
    assert.equal(reply.body.data, undefined);
    assert.equal(receiptReads, 0);
    assert.deepEqual(await saleRequestState(), before);
  });
}

for (const rpcName of ["read_crm_sale_create_request", "create_crm_sale_once"]) {
  test(`API ${rpcName} rechecks live authorization inside SQL after route authorization`, async () => {
    const call = await saleApiFixture();
    const before = await saleRequestState();
    const base = apiDatabase();
    let checked = false;
    serverClient.setSupabaseServerClientFactoryForTests(() => ({ ...base, rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === rpcName) { await db.exec(`update staff_users set status='inactive' where id='${id(40)}'`); checked = true; }
      return base.rpc(name, args);
    } }));
    const reply = await call("deals", "POST", keyedSale());
    assert.equal(checked, true);
    assert.equal(reply.status, 403, JSON.stringify(reply.body));
    assert.equal(reply.body.data, undefined);
    assert.deepEqual(await saleRequestState(), before);
  });
}

test("API malformed sale keys never dispatch SQL or become legacy creates", async () => {
  const call = await saleApiFixture();
  const before = await saleRequestState();
  const queries: ApiQuery[] = [];
  const base = apiDatabase("service_role", queries);
  let rpcs = 0;
  serverClient.setSupabaseServerClientFactoryForTests(() => ({ ...base, rpc: async (name: string, args: Record<string, unknown>) => {
    rpcs++; return base.rpc(name, args);
  } }));
  for (const requestKey of [null, "", "not-a-uuid", 123, {}, "00000000-0000-1000-8000-000000000170"]) {
    const reply = await call("deals", "POST", keyedSale({ requestKey }));
    assert.equal(reply.status, 400, JSON.stringify({ requestKey, reply: reply.body }));
    assert.equal(reply.body.data, undefined);
  }
  assert.equal(rpcs, 0);
  assert.deepEqual(queries.filter(query => query.operation !== "select"), []);
  assert.deepEqual(await saleRequestState(), before);
});

test("API keyed sale rejects invalid amounts and blank titles before RPC without legacy fallback", async () => {
  const call = await saleApiFixture();
  const before = await saleRequestState();
  const queries: ApiQuery[] = [];
  const base = apiDatabase("service_role", queries);
  let rpcs = 0;
  serverClient.setSupabaseServerClientFactoryForTests(() => ({ ...base, rpc: async (name: string, args: Record<string, unknown>) => {
    rpcs++; return base.rpc(name, args);
  } }));
  const { amountMinor: _amount, ...body } = keyedSale();
  const attempts: Record<string, unknown>[] = [body, keyedSale({ title: "" }), keyedSale({ title: " \t\r\n " })];
  for (const alias of ["amountMinor", "amount_minor"]) {
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "9007199254740992", "0.5", "not-a-number"]) {
      attempts.push({ ...body, [alias]: value });
    }
  }
  for (const input of attempts) {
    const reply = await call("deals", "POST", input);
    assert.equal(reply.status, 400, JSON.stringify({ input, reply: reply.body }));
    assert.equal(reply.body.data, undefined);
  }
  assert.equal(rpcs, 0, "invalid keyed amounts/titles must fail before reading or creating a receipt");
  assert.deepEqual(queries.filter(query => query.operation !== "select"), []);
  assert.deepEqual(await saleRequestState(), before);
});

test("API keyed sale accepts explicit zero and MAX_SAFE_INTEGER and canonically replays numeric-string aliases", async () => {
  const call = await saleApiFixture();
  for (const [index, amount] of [0, Number.MAX_SAFE_INTEGER].entries()) {
    const body = keyedSale({ requestKey: id(180 + index), amountMinor: amount });
    const saved = apiItem(await call("deals", "POST", body), 201);
    assert.equal(saved.amountMinor, amount); assert.equal(saved.status, "pending");
    const before = await saleRequestState();
    const { amountMinor: _amount, ...original } = body;
    const reply = await call("deals", "POST", { ...original, amount_minor: String(amount) });
    const replay = apiItem(reply);
    assert.equal(replay.id, saved.id); assert.equal(replay.amountMinor, amount);
    assert.equal((reply.body.data as Record<string, unknown>).replayed, true);
    assert.deepEqual(await saleRequestState(), before);
  }
  assert.equal((await row("select count(*) from deals")).count, 2);
  assert.equal((await row("select count(*) from crm_sale_create_requests")).count, 2);
  assert.equal((await row("select count(*) from deals where status='paid' or paid_at is not null")).count, 0);
});

for (const rpcName of ["read_crm_sale_create_request", "create_crm_sale_once"]) {
  for (const missing of ["actual SQL function", "schema cache"]) {
    test(`API missing sale ${rpcName} (${missing}) returns 503 without legacy INSERT`, async () => {
      const call = await saleApiFixture();
      const before = await saleRequestState();
      const queries: ApiQuery[] = [];
      const base = apiDatabase("service_role", queries);
      if (missing === "actual SQL function") {
        const signature = rpcName === "read_crm_sale_create_request" ? "uuid,uuid,uuid,uuid,text" : "uuid,uuid,uuid,uuid,text,jsonb";
        await db.exec(`alter function public.${rpcName}(${signature}) rename to fixture_missing_sale_rpc`);
        serverClient.setSupabaseServerClientFactoryForTests(() => base);
      } else {
        serverClient.setSupabaseServerClientFactoryForTests(() => ({ ...base, rpc: async (name: string, args: Record<string, unknown>) =>
          name === rpcName ? { data: null, error: { code: "PGRST202", message: "private sale schema detail" } } : base.rpc(name, args) }));
      }
      const reply = await call("deals", "POST", keyedSale());
      assert.equal(reply.status, 503, JSON.stringify(reply.body));
      assert.equal(reply.body.code, "sale_create_unavailable");
      assert.equal(reply.body.data, undefined);
      assert.doesNotMatch(JSON.stringify(reply.body), /private sale schema detail|fixture_missing_sale_rpc/);
      assert.deepEqual(queries.filter(query => query.operation !== "select"), []);
      assert.deepEqual(await saleRequestState(), before);
    });
  }
  test(`API unknown ${rpcName} error cannot fall back to unkeyed INSERT`, async () => {
    const call = await saleApiFixture();
    const before = await saleRequestState();
    const queries: ApiQuery[] = [];
    const base = apiDatabase("service_role", queries);
    serverClient.setSupabaseServerClientFactoryForTests(() => ({ ...base, rpc: async (name: string, args: Record<string, unknown>) =>
      name === rpcName ? { data: null, error: { code: "08006", message: "private sale connection detail" } } : base.rpc(name, args) }));
    const reply = await call("deals", "POST", keyedSale());
    assert.equal(reply.status, 502, JSON.stringify(reply.body));
    assert.equal(reply.body.data, undefined);
    assert.doesNotMatch(JSON.stringify(reply.body), /private sale connection detail/);
    assert.deepEqual(queries.filter(query => query.operation !== "select"), []);
    assert.deepEqual(await saleRequestState(), before);
  });
  test(`API malformed or foreign ${rpcName} receipts fail closed`, async () => {
    const call = await saleApiFixture();
    const before = await saleRequestState();
    const base = apiDatabase();
    for (const data of [{}, { sale: { id: id(99), workspace_id: id(1) }, replayed: "true" },
      { sale: { id: id(99), workspace_id: id(2), title: "Private foreign sale" }, replayed: true }]) {
      serverClient.setSupabaseServerClientFactoryForTests(() => ({ ...base, rpc: async (name: string, args: Record<string, unknown>) =>
        name === rpcName ? { data, error: null } : base.rpc(name, args) }));
      const reply = await call("deals", "POST", keyedSale());
      assert.equal(reply.status, 502, JSON.stringify(reply.body));
      assert.equal(reply.body.data, undefined);
      assert.doesNotMatch(JSON.stringify(reply.body), /Private foreign sale/);
      assert.deepEqual(await saleRequestState(), before);
    }
  });
}

test("API lost sale RPC reply recovers the saved row without claiming crash-atomic journal", async () => {
  const call = await saleApiFixture();
  const base = apiDatabase();
  let creates = 0;
  serverClient.setSupabaseServerClientFactoryForTests(() => ({ ...base, rpc: async (name: string, args: Record<string, unknown>) => {
    const result = await base.rpc(name, args);
    if (name !== "create_crm_sale_once") return result;
    creates++;
    assert.equal(result.error, null);
    return { data: null, error: { code: "08006", message: "Synthetic reply lost after real sale SQL" } };
  } }));
  const first = await call("deals", "POST", keyedSale());
  assert.equal(first.status, 502);
  assert.equal(first.body.data, undefined);
  assert.equal((await row("select count(*) from deals")).count, 1);
  assert.equal((await row("select count(*) from crm_sale_create_requests")).count, 1);
  assert.equal((await row("select count(*) from audit_logs")).count, 0);
  const before = await saleRequestState();
  const replay = await call("deals", "POST", keyedSale());
  assert.equal(apiItem(replay).id, (await row("select id from deals")).id);
  assert.equal((replay.body.data as Record<string, unknown>).replayed, true);
  assert.equal(creates, 1);
  assert.deepEqual(await saleRequestState(), before, "replay neither duplicates a sale nor invents the missing post-domain audit");
});

for (const role of ["anon", "authenticated"] as const) {
  test(`SQL sale receipts refuse direct ${role} execution and remain invisible even with temporary SELECT`, async () => {
    await saleApiFixture();
    const saved = await apiDatabase().rpc("create_crm_sale_once", saleRpcArgs());
    assert.equal(saved.error, null);
    const before = await saleRequestState();
    for (const rpcName of ["read_crm_sale_create_request", "create_crm_sale_once"]) {
      const refused = await apiDatabase(role).rpc(rpcName, saleRpcArgs());
      assert.equal(refused.error?.code, "42501");
      assert.deepEqual(await saleRequestState(), before);
    }
    await db.exec(`savepoint sale_receipt_rls_probe;
      grant select on public.crm_sale_create_requests to ${role}; set local role ${role}`);
    try { assert.equal((await row("select count(*) from public.crm_sale_create_requests")).count, 0); }
    finally { await db.exec("reset role; rollback to savepoint sale_receipt_rls_probe; release savepoint sale_receipt_rls_probe"); }
    assert.deepEqual(await saleRequestState(), before);
  });
}

test("SQL sale receipt ACL permits service RPC execution but no direct receipt-table privileges", async () => {
  await saleApiFixture();
  assert.equal((await row("select relrowsecurity from pg_class where oid='public.crm_sale_create_requests'::regclass")).relrowsecurity, true);
  for (const role of ["anon", "authenticated", "service_role"]) {
    const permissions = await row(`select
      has_table_privilege('${role}','public.crm_sale_create_requests','select') as can_read,
      has_table_privilege('${role}','public.crm_sale_create_requests','insert') as can_insert,
      has_table_privilege('${role}','public.crm_sale_create_requests','update') as can_update,
      has_table_privilege('${role}','public.crm_sale_create_requests','delete') as can_delete,
      has_function_privilege('${role}','public.read_crm_sale_create_request(uuid,uuid,uuid,uuid,text)','execute') as read_rpc,
      has_function_privilege('${role}','public.create_crm_sale_once(uuid,uuid,uuid,uuid,text,jsonb)','execute') as create_rpc`);
    assert.deepEqual(permissions, { can_read: false, can_insert: false, can_update: false, can_delete: false,
      read_rpc: role === "service_role", create_rpc: role === "service_role" });
  }
});

test("SQL sale RPCs validate live actor/auth/workspace and input without leaking receipts", async () => {
  await saleApiFixture();
  const saved = await apiDatabase().rpc("create_crm_sale_once", saleRpcArgs());
  assert.equal(saved.error, null);
  const before = await saleRequestState();
  for (const rpcName of ["read_crm_sale_create_request", "create_crm_sale_once"]) {
    for (const changes of [{ p_staff_user_id: id(999) }, { p_auth_user_id: id(999) }, { p_workspace_id: id(2) }]) {
      const refused = await apiDatabase().rpc(rpcName, saleRpcArgs(changes));
      assert.equal(refused.error?.code, "P7604");
      assert.equal(refused.data, null);
      assert.deepEqual(await saleRequestState(), before);
    }
    for (const changes of [{ p_request_key: null }, { p_auth_user_id: null }, { p_request_fingerprint: "not-a-hash" }]) {
      const refused = await apiDatabase().rpc(rpcName, saleRpcArgs(changes));
      assert.equal(refused.error?.code, "P7601");
      assert.deepEqual(await saleRequestState(), before);
    }
    const conflict = await apiDatabase().rpc(rpcName, saleRpcArgs({ p_request_fingerprint: "b".repeat(64) }));
    assert.equal(conflict.error?.code, "P7602");
    assert.deepEqual(await saleRequestState(), before);
    for (const revoke of ["status='inactive'", "role='doctor'"]) {
      await db.exec(`update staff_users set ${revoke} where id='${id(40)}'`);
      const refused = await apiDatabase().rpc(rpcName, saleRpcArgs());
      assert.equal(refused.error?.code, "P7604");
      assert.deepEqual(await saleRequestState(), before);
      await db.exec(`update staff_users set status='active',role='owner' where id='${id(40)}'`);
    }
  }
});

test("SQL sale create validates reference tenants and rejects injected columns before writing", async () => {
  await saleApiFixture();
  await db.exec(`insert into clients(id,workspace_id,full_name) values('${id(80)}','${id(2)}','Other local client');
    insert into leads(id,workspace_id,full_name) values('${id(81)}','${id(2)}','Other local lead');
    insert into appointments(id,workspace_id,client_id,service) values('${id(82)}','${id(2)}','${id(80)}','Other local visit');
    insert into clinic_services(id,workspace_id,name) values('${id(83)}','${id(2)}','Other local service');
    insert into staff_users(id,workspace_id,auth_user_id,full_name,email,role)
      values('${id(84)}','${id(2)}','${id(85)}','Other local staff','foreign@example.invalid','owner')`);
  const before = await saleRequestState();
  const base = saleRpcArgs();
  for (const changes of [{ workspace_id: id(2) }, { client_id: id(80) }, { lead_id: id(81) },
    { appointment_id: id(82) }, { service_id: id(83) }, { responsible_user_id: id(84) },
    { id: id(999) }, { created_at: "2090-01-01" }, { title: "" }, { title: " \t\r\n " }, { amount_minor: -1 },
    { amount_minor: Number.MAX_SAFE_INTEGER + 1 }, { status: "invalid" }]) {
    const refused = await apiDatabase().rpc("create_crm_sale_once", { ...base, p_sale: { ...base.p_sale, ...changes } });
    assert.equal(refused.error?.code, "P7601", JSON.stringify(changes));
    assert.deepEqual(await saleRequestState(), before);
  }
});

test("SQL sale replay returns current rows before catalogue checks and tombstones refuse resurrection", async () => {
  await saleApiFixture();
  const created = await apiDatabase().rpc("create_crm_sale_once", saleRpcArgs());
  assert.equal(created.error, null);
  const sale = (created.data as Record<string, unknown>).sale as Record<string, unknown>;
  assert.equal((created.data as Record<string, unknown>).replayed, false);
  await db.query("update deals set status='cancelled',amount_minor=12345,notes='Later SQL edit' where id=$1", [sale.id]);
  await db.exec("update clinic_services set is_active=false");
  const before = await saleRequestState();
  for (const rpcName of ["read_crm_sale_create_request", "create_crm_sale_once"]) {
    const replay = await apiDatabase().rpc(rpcName, saleRpcArgs());
    assert.equal(replay.error, null);
    const data = replay.data as Record<string, unknown>;
    const current = data.sale as Record<string, unknown>;
    assert.equal(data.replayed, true);
    assert.equal(current.id, sale.id); assert.equal(current.amount_minor, 12345);
    assert.equal(current.status, "cancelled"); assert.equal(current.notes, "Later SQL edit");
    assert.deepEqual(await saleRequestState(), before);
  }
  await db.query("delete from deals where id=$1", [sale.id]);
  assert.equal((await row("select sale_id from crm_sale_create_requests")).sale_id, null);
  const tombstone = await saleRequestState();
  for (const rpcName of ["read_crm_sale_create_request", "create_crm_sale_once"]) {
    const refused = await apiDatabase().rpc(rpcName, saleRpcArgs());
    assert.equal(refused.error?.code, "P7603"); assert.equal(refused.data, null);
    assert.deepEqual(await saleRequestState(), tombstone);
  }
});

test("SQL sale receipt failure atomically rolls back the inserted sale and leaves its key retryable", async () => {
  await saleApiFixture();
  const before = await saleRequestState();
  await db.exec(`create function public.refuse_fixture_sale_receipt() returns trigger language plpgsql as $$ begin
      raise exception 'Synthetic receipt write refusal' using errcode='23514'; end $$;
    create trigger refuse_fixture_sale_receipt before insert on public.crm_sale_create_requests
      for each row execute function public.refuse_fixture_sale_receipt()`);
  const refused = await apiDatabase().rpc("create_crm_sale_once", saleRpcArgs());
  assert.equal(refused.error?.code, "23514");
  assert.equal(refused.data, null);
  assert.deepEqual(await saleRequestState(), before, "receipt failure must not leave the earlier INSERT or audit behind");
  await db.exec("drop trigger refuse_fixture_sale_receipt on public.crm_sale_create_requests");
  const retry = await apiDatabase().rpc("create_crm_sale_once", saleRpcArgs());
  assert.equal(retry.error, null);
  const saved = (retry.data as Record<string, unknown>).sale as Record<string, unknown>;
  assert.equal((await row("select count(*) from deals")).count, 1);
  assert.equal((await row("select count(*) from crm_sale_create_requests")).count, 1);
  assert.equal((await row("select sale_id from crm_sale_create_requests")).sale_id, saved.id);
  assert.equal((await row("select count(*) from audit_logs")).count, 0, "RPC does not own the server's post-domain audit");
});

test("SQL migration 076 repeats without backfill, workspace activation or receipt access grants", async () => {
  await saleApiFixture();
  assert.equal((await apiDatabase().rpc("create_crm_sale_once", saleRpcArgs())).error, null);
  const before = await saleRequestState();
  const workspaces = await row("select jsonb_agg(w order by id) as rows from workspaces w");
  const source = await readFile(path.join(root, "migrations/076_crm_sale_create_requests.sql"), "utf8");
  await db.exec(source.replace(/^begin;$/gmi, "").replace(/^commit;$/gmi, ""));
  assert.deepEqual(await saleRequestState(), before);
  assert.deepEqual(await row("select jsonb_agg(w order by id) as rows from workspaces w"), workspaces);
  assert.equal((await row("select has_table_privilege('service_role','public.crm_sale_create_requests','select') as permitted")).permitted, false);
});

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

const lateDoctorPhone = "+77001234567";
const lateDoctorWhatsapp = "+77007654321";
const lateDoctorNotes = `Allergy noted; call ${lateDoctorPhone}, WhatsApp ${lateDoctorWhatsapp}`;

// Explicit owner decision, Oct 19, 2026: authorship, not who supplied the phone,
// controls readback. A doctor's own authored booking exposes contacts added later
// by an admin on replay/GET/PATCH. Other/null authors remain redacted, foreign
// work stays inaccessible, and doctor contact writes remain forbidden.
async function doctorContactFixture(author: string | null) {
  const call = await bundleApiFixture("doctor");
  await db.exec(`insert into staff_users(id,workspace_id,auth_user_id,full_name,email,role)
    values('${id(43)}','${id(1)}','${id(44)}','Fixture admin','admin@example.invalid','admin')`);
  const booking = { ...keyedBooking(), createdByStaffUserId: id(43), created_by_staff_user_id: id(43) };
  const visit = apiItem(await call("appointments", "POST", booking), 201);
  assert.equal((await row(`select created_by_staff_user_id from appointments where id='${visit.id}'`))
    .created_by_staff_user_id, id(40), "POST ignores both spoofed author aliases");
  // Seed current other/legacy authorship independently of the doctor's receipt:
  // owning a creation receipt must not itself grant contact visibility.
  await db.query("update appointments set created_by_staff_user_id=$1 where id=$2", [author, visit.id]);
  const doctorFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    assert.equal(url, "https://fixture.invalid/auth/v1/user");
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: id(44) }) };
  }) as unknown as typeof fetch;
  try {
    const edited = apiItem(await call("appointments", "PATCH", {
      phone: lateDoctorPhone, whatsapp: lateDoctorWhatsapp, notes: lateDoctorNotes,
    }, 1, String(visit.id)));
    assert.equal(edited.phone, lateDoctorPhone, "admin can add contacts after booking");
    assert.equal(edited.whatsapp, lateDoctorWhatsapp);
    assert.equal(edited.notes, lateDoctorNotes);
  } finally {
    globalThis.fetch = doctorFetch;
  }
  const stored = await row(`select * from appointments where id='${visit.id}'`);
  assert.equal(stored.created_by_staff_user_id, author, "admin contact edits do not transfer authorship");
  assert.equal(stored.client_phone, lateDoctorPhone);
  assert.equal(stored.whatsapp, lateDoctorWhatsapp);
  assert.equal(stored.notes, lateDoctorNotes);
  return { call, booking, visit, stored };
}

for (const { label, author } of [
  { label: "own author", author: id(40) },
  { label: "other author", author: id(43) },
  { label: "null author", author: null },
]) {
  for (const method of ["replay", "GET", "PATCH"]) {
    test(`API doctor author-readback ${method}: ${label} with admin-added contacts`, async () => {
      const { call, booking, visit, stored } = await doctorContactFixture(author);
      const before = await retryCounts();
      const clientBefore = await row(`select * from clients where id='${visit.clientId}'`);
      const reply = method === "replay" ? await call("appointments", "POST", {
        ...booking, createdByStaffUserId: id(40), created_by_staff_user_id: id(40),
      }) : method === "GET" ? await call("appointments", "GET")
        : await call("appointments", "PATCH", {
          status: "scheduled", createdByStaffUserId: id(40), created_by_staff_user_id: id(40),
        }, 1, String(visit.id));
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.equal(reply.body.success, true);
      assert.equal(reply.body.mode, "supabase");
      const item = method === "GET"
        ? (reply.body.data as { appointments: Record<string, unknown>[] }).appointments.find(item => item.id === visit.id)
        : apiItem(reply);
      assert.ok(item, "own-work appointment remains visible regardless of author");
      assert.equal(item.id, visit.id);
      assert.equal(item.client, booking.client);
      assert.equal(new Date(String(item.startsAt)).toISOString(), "2026-10-03T04:00:00.000Z");
      assert.equal(item.status, method === "PATCH" ? "scheduled" : "confirmed");
      if (author === id(40)) {
        assert.equal(item.phone, lateDoctorPhone);
        assert.equal(item.whatsapp, lateDoctorWhatsapp);
        assert.equal(item.notes, lateDoctorNotes);
      } else {
        for (const field of ["phone", "whatsapp", "email", "clientPhone", "client_phone", "clientWhatsapp", "client_whatsapp"]) {
          assert.equal(field in item, false, `${field} is absent, not empty`);
        }
        assert.match(String(item.notes), /Allergy noted/, "non-contact notes survive");
        assert.notEqual(item.notes, lateDoctorNotes);
        for (const contact of [lateDoctorPhone.slice(1), lateDoctorWhatsapp.slice(1)]) {
          assert.equal(JSON.stringify(reply.body).includes(contact), false, "no contact leaks through any response alias");
        }
      }
      assert.equal(item.createdByStaffUserId, author ?? "", "readback reports stored author, never supplied author");
      const after = await row(`select * from appointments where id='${visit.id}'`);
      if (method === "PATCH") {
        assert.notEqual(after.edit_version, stored.edit_version, "Every accepted edit rotates its server version");
        assert.equal(item.editVersion, after.edit_version, "The response publishes the final stored token");
      }
      assert.deepEqual(after, method === "PATCH"
        ? { ...stored, status: "scheduled", updated_at: after.updated_at, edit_version: after.edit_version } : stored,
      "readback/redaction must not change stored contacts or authorship");
      assert.deepEqual(await row(`select * from clients where id='${visit.clientId}'`), clientBefore);
      assert.deepEqual(await retryCounts(), method === "PATCH" ? { ...before, journal: Number(before.journal) + 1 } : before);
      assert.deepEqual(reply.queries.filter(query => query.table === "clients" || query.table === "deals"), []);
      if (method === "PATCH") {
        const writes = reply.queries.filter(query => query.operation !== "select");
        assert.deepEqual(writes.map(query => query.table), ["appointments"], "Audit is inside the SQL transaction, not a second SDK write");
        assert.equal(writes[0].operation, "rpc:patch_crm_appointment_journaled", "No direct service UPDATE fallback");
        assert.deepEqual(writes[0].filters, [["id", "=", visit.id], ["workspace_id", "=", id(1)]]);
      } else {
        assert.deepEqual(reply.queries.filter(query => query.operation !== "select"), []);
        if (method === "replay") assert.equal((reply.body.data as Record<string, unknown>).replayed, true);
      }
    });
  }
}

test("API same-name doctor reassignment revokes author access and redacts contacts for the new assignee", async () => {
  const { call, booking, visit, stored: authored } = await doctorContactFixture(id(40));
  assert.equal(authored.doctor_id, id(42));
  // Active directory names are unique; archive A's card, not A's staff account.
  await db.exec(`update clinic_doctors set is_active=false where id='${id(42)}';
    update clinic_services set doctor_id=null where id in ('${id(50)}','${id(51)}');
    insert into staff_users(id,workspace_id,auth_user_id,full_name,email,role)
    values('${id(45)}','${id(1)}','${id(46)}','Test master','other-doctor@example.invalid','doctor');
    insert into clinic_doctors(id,workspace_id,full_name,staff_user_id)
    values('${id(47)}','${id(1)}','Test master','${id(45)}')`);
  let authUserId = id(44);
  globalThis.fetch = (async (url: unknown) => {
    assert.equal(url, "https://fixture.invalid/auth/v1/user");
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: authUserId }) };
  }) as unknown as typeof fetch;
  apiItem(await call("clients", "PATCH", {
    phone: lateDoctorPhone, whatsapp: lateDoctorWhatsapp, notes: lateDoctorNotes,
  }, 1, String(visit.clientId)));
  const moved = apiItem(await call("appointments", "PATCH", {
    doctorId: id(47), doctor: "Test master", serviceItems: serviceBundle,
  }, 1, String(visit.id)));
  assert.equal(moved.doctorId, id(47));
  assert.equal(moved.doctor, "Test master");
  assert.equal(moved.createdByStaffUserId, id(40));
  const stored = await row(`select * from appointments where id='${visit.id}'`);
  assert.notEqual(stored.edit_version, authored.edit_version);
  assert.equal(moved.editVersion, stored.edit_version);
  assert.deepEqual(stored, { ...authored, doctor_id: id(47), updated_at: stored.updated_at, edit_version: stored.edit_version },
    "admin reassignment changes the doctor ID, not the identical name, contacts or author");
  const clientBefore = await row(`select * from clients where id='${visit.clientId}'`);
  assert.equal(clientBefore.phone, lateDoctorPhone);
  assert.equal(clientBefore.whatsapp, lateDoctorWhatsapp);
  const before = await retryCounts();

  authUserId = id(41);
  const hidden = await call("appointments", "GET");
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
  assert.equal(hidden.body.mode, "supabase");
  const hiddenData = hidden.body.data as { appointments: Record<string, unknown>[]; items: Record<string, unknown>[] };
  for (const list of [hiddenData.appointments, hiddenData.items]) {
    assert.ok(list.some(item => item.id === id(10)), "A still sees an appointment assigned to A");
    assert.ok(list.every(item => item.id !== visit.id), "authorship and matching names cannot override B's doctor ID");
  }
  assert.ok(hidden.queries.some(query => query.table === "appointments" && query.columns === "*"
    && query.filters.some(([column, operator, value]) => column === "doctor_name" && operator === "ilike" && value === "Test master")),
  "the same-name query runs against the reassigned row before the merged result is filtered");
  const denied = await call("appointments", "PATCH", { status: "arrived" }, 1, String(visit.id));
  assert.equal(denied.status, 404, JSON.stringify(denied.body));
  const clients = await call("clients", "GET");
  assert.equal(clients.status, 403, JSON.stringify(clients.body));
  for (const reply of [denied, clients]) {
    assert.equal(reply.body.success, false);
    assert.equal(reply.body.data, undefined);
  }
  for (const reply of [hidden, denied, clients]) {
    for (const secret of [booking.client, lateDoctorPhone.slice(1), lateDoctorWhatsapp.slice(1), lateDoctorNotes]) {
      assert.equal(JSON.stringify(reply.body).includes(secret), false);
    }
    assert.deepEqual(reply.queries.filter(query => query.operation !== "select"), []);
    assert.deepEqual(reply.queries.filter(query => query.table === "clients" || query.table === "deals"), [],
      "denial must not read client contacts or touch sales");
  }

  authUserId = id(46);
  const visible = await call("appointments", "GET");
  assert.equal(visible.status, 200, JSON.stringify(visible.body));
  assert.equal(visible.body.mode, "supabase");
  const visibleData = visible.body.data as { appointments: Record<string, unknown>[]; items: Record<string, unknown>[] };
  for (const list of [visibleData.appointments, visibleData.items]) {
    assert.deepEqual(list.map(item => item.id), [visit.id], "B sees only the appointment assigned to B, not same-named A's work");
    const item = list[0];
    assert.equal(item.doctorId, id(47));
    assert.equal(item.client, booking.client);
    assert.equal(item.status, "confirmed");
    assert.equal(item.createdByStaffUserId, id(40), "reassignment does not make B the author");
    for (const field of ["phone", "whatsapp", "email", "clientPhone", "client_phone", "clientWhatsapp", "client_whatsapp"]) {
      assert.equal(field in item, false, `${field} is absent, not empty`);
    }
    assert.match(String(item.notes), /Allergy noted/);
    assert.notEqual(item.notes, lateDoctorNotes);
  }
  for (const contact of [lateDoctorPhone.slice(1), lateDoctorWhatsapp.slice(1)]) {
    assert.equal(JSON.stringify(visible.body).includes(contact), false, "no contact leaks through any response alias");
  }
  assert.deepEqual(visible.queries.filter(query => query.operation !== "select" || query.table === "clients" || query.table === "deals"), []);
  assert.deepEqual(await row(`select * from appointments where id='${visit.id}'`), stored);
  assert.deepEqual(await row(`select * from clients where id='${visit.clientId}'`), clientBefore);
  assert.deepEqual(await retryCounts(), before, "GETs and A's refused arrival PATCH create no writes, sale or journal entry");
});

for (const scope of ["other doctor", "foreign workspace"]) {
  for (const method of ["replay", "GET", "PATCH"]) {
    test(`API doctor author-readback ${method}: ${scope} never grants contact access`, async () => {
      const { call, booking, visit } = await doctorContactFixture(id(40));
      if (scope === "other doctor") {
        await db.exec(`insert into clinic_doctors(id,workspace_id,full_name)
          values('${id(45)}','${id(1)}','Other specialist');
          update appointments set doctor_id='${id(45)}',doctor_name='Other specialist' where id='${visit.id}'`);
      }
      const stored = await row(`select * from appointments where id='${visit.id}'`);
      const before = await retryCounts();
      const observedQueries: ApiQuery[] = [];
      const base = apiDatabase("service_role", observedQueries);
      const rpcCalls: string[] = [];
      serverClient.setSupabaseServerClientFactoryForTests(() => ({ ...base,
        rpc: async (name: string, args: Record<string, unknown>) => {
          rpcCalls.push(name);
          return base.rpc(name, args);
        },
      }));
      const workspace = scope === "foreign workspace" ? 2 : 1;
      const reply = method === "replay" ? await call("appointments", "POST", booking, workspace)
        : method === "GET" ? await call("appointments", "GET", {}, workspace)
          : await call("appointments", "PATCH", {
            status: "scheduled", createdByStaffUserId: id(40), created_by_staff_user_id: id(40),
          }, workspace, String(visit.id));
      assert.equal(reply.status, workspace === 2 ? 403 : method === "GET" ? 200 : 404, JSON.stringify(reply.body));
      if (reply.status === 200) {
        const data = reply.body.data as { appointments: Record<string, unknown>[]; items: Record<string, unknown>[] };
        for (const list of [data.appointments, data.items]) assert.ok(list.every(item => item.id !== visit.id));
      } else {
        assert.equal(reply.body.success, false);
        assert.equal(reply.body.data, undefined);
      }
      for (const hidden of [booking.client, lateDoctorPhone.slice(1), lateDoctorWhatsapp.slice(1), lateDoctorNotes]) {
        assert.equal(JSON.stringify(reply.body).includes(hidden), false);
      }
      assert.deepEqual(await row(`select * from appointments where id='${visit.id}'`), stored);
      assert.deepEqual(await retryCounts(), before);
      assert.deepEqual(observedQueries.filter(query => query.operation !== "select"), []);
      assert.deepEqual(observedQueries.filter(query => query.table === "clients" || query.table === "deals"), [],
        "scope denial must precede any client/contact-card access");
      for (const query of observedQueries.filter(query => query.table === "appointments")) {
        assert.ok(query.filters.some(([column, operator, value]) => column === "workspace_id" && operator === "=" && value === id(1)));
        if (method === "GET" && query.columns === "*") {
          assert.ok(query.filters.some(([column, operator, value]) =>
            (column === "doctor_id" && operator === "=" && value === id(42))
            || (column === "doctor_name" && operator === "ilike" && value === "Test master")),
          "GET scopes contact-bearing appointment reads to the acting doctor");
        }
      }
      if (workspace === 2) {
        assert.deepEqual(rpcCalls, [], "workspace denial precedes receipt/contact reads or writes");
        assert.deepEqual(observedQueries.filter(query => !["staff_users", "workspace_settings"].includes(query.table)), []);
      } else {
        assert.deepEqual(rpcCalls, method === "replay" ? ["read_crm_appointment_request_v2"] : []);
      }
    });
  }
}

for (const method of ["POST", "PATCH"]) {
  test(`API doctor author-readback ${method}: contact writes still fail before reads despite author spoofing`, async () => {
    const { call, booking, visit, stored } = await doctorContactFixture(id(40));
    const before = await retryCounts();
    const observedQueries: ApiQuery[] = [];
    const base = apiDatabase("service_role", observedQueries);
    const rpcCalls: string[] = [];
    serverClient.setSupabaseServerClientFactoryForTests(() => ({ ...base,
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcCalls.push(name);
        return base.rpc(name, args);
      },
    }));
    for (const field of ["phone", "client_phone", "clientPhone", "whatsapp", "client_whatsapp", "email"]) {
      observedQueries.length = 0;
      const fields = { [field]: field === "email" ? "blocked@example.invalid" : "+77009999999",
        createdByStaffUserId: id(40), created_by_staff_user_id: id(40) };
      const reply = await call("appointments", method, method === "POST"
        ? { ...booking, ...fields } : { ...fields, status: "scheduled" }, 1, String(visit.id));
      assert.equal(reply.status, 403, `${field}: ${JSON.stringify(reply.body)}`);
      assert.equal(reply.body.success, false);
      assert.equal(reply.body.data, undefined);
      for (const contact of [lateDoctorPhone.slice(1), lateDoctorWhatsapp.slice(1), "77009999999", "blocked@example.invalid"]) {
        assert.equal(JSON.stringify(reply.body).includes(contact), false);
      }
      assert.deepEqual(rpcCalls, [], "contact-write rejection must precede receipt access");
      assert.deepEqual(observedQueries.filter(query => query.operation !== "select"), []);
      assert.deepEqual(observedQueries.filter(query => !["staff_users", "workspace_settings"].includes(query.table)), [],
        "contact-write rejection precedes appointment and client reads");
      assert.deepEqual(await row(`select * from appointments where id='${visit.id}'`), stored);
      assert.deepEqual(await retryCounts(), before);
    }
  });
}

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

for (const rpcName of ["read_crm_appointment_request_v2", "create_crm_appointment_v2"]) {
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
    if (name !== "create_crm_appointment_v2") return result;
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
    if (name !== "create_crm_appointment_v2") return base.rpc(name, args);
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

for (const keyed of [true, false]) {
  for (const existingClient of [true, false]) {
    if (!keyed && existingClient) continue;
    for (const [code, message, status] of [
      ["23P01", "appointment_capacity_exceeded", 409],
      ["23P01", "another_exclusion", 502],
      ["23514", "appointment_capacity_exceeded", 502],
      ["23P01", "appointment_capacity_exceeded: private-client", 502],
    ] as const) {
      test(`API capacity ${keyed ? "keyed" : "legacy"} ${existingClient ? "existing" : "new"}-client create classifies ${code}/${message}`, async () => {
        const call = await bundleApiFixture();
        const base = apiDatabase();
        const rpcName = "create_crm_appointment_v2";
        let creates = 0;
        serverClient.setSupabaseServerClientFactoryForTests(() => ({ ...base, rpc: async (name: string, args: Record<string, unknown>) => {
          if (name !== rpcName) return base.rpc(name, args);
          creates++;
          return { data: null, error: { code, message, details: "private-client +77000000000", hint: "private SQL constraint" } };
        } }));
        const before = await retryCounts();
        const body = { ...(keyed ? keyedBooking() : bundleBooking()), status: "arrived", ...(existingClient ? { clientId: id(3) } : {}) };
        const reply = await call("appointments", "POST", body);
        assert.equal(reply.status, status, JSON.stringify(reply.body));
        if (status === 409) {
          assert.deepEqual(reply.body, {
            success: false,
            error: "Это время у врача уже занято",
            code: "appointment_conflict",
          });
        } else {
          assert.equal(reply.body.code, undefined);
        }
        assert.doesNotMatch(JSON.stringify(reply.body), /private-client|77000000000|SQL|23P01|appointment_capacity_exceeded|another_exclusion/);
        assert.equal(creates, 1, "no retry or fallback after the RPC refusal");
        assert.deepEqual(await retryCounts(), before, "no client, visit, sale, receipt or journal side effects");
      });
    }
  }
}

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
      if (name === "read_crm_appointment_request_v2") reads++;
      if (name === "create_crm_appointment_v2") creates++;
      const result = await base.rpc(name, args);
      if (name === "read_crm_appointment_request_v2" && !injected) {
        assert.equal(result.data, null);
        injected = true;
        // Deterministic interleaving with real SQL writes, not a canned success.
        // Native two-connection lock contention remains a separate PostgreSQL test.
        const committed = await base.rpc("create_crm_appointment_v2", { ...args,
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

for (const scenario of ["normal save", "lost saved response", "refused before insert"] as const) {
  test(`G2 SalesPage keyed pending-sale runtime: ${scenario} preserves one sale and first-create journal`, async () => {
    const call = await apiFixture();
    await db.exec(`update workspaces set arrival_marks_paid=false where id='${id(1)}';
      update appointments set status='arrived' where id='${id(10)}'`);
    const before = await retryCounts();
    const persisted = async () => (await db.query<Record<string, unknown>>(
      "select * from deals where workspace_id=$1 order by id", [id(1)],
    )).rows;
    const savedIds: string[] = [];
    let attempts = 0, losses = 0;
    let proofFailure: unknown;
    let beforeLoss: Record<string, unknown>[] = [];
    const runtime = await createSalesRetryRuntime(id(1), async (method, body) => {
      if (method === "GET") {
        const reply = await call("deals", "GET");
        return Response.json(reply.body, { status: reply.status });
      }
      const attempt = ++attempts;
      try {
        if (scenario === "refused before insert" && attempt === 1) {
          // Only this synthetic actor is temporarily denied; input stays identical.
          await db.exec(`update staff_users set role='doctor' where id='${id(40)}'`);
          let denied;
          try { denied = await call("deals", "POST", body); }
          finally { await db.exec(`update staff_users set role='owner' where id='${id(40)}'`); }
          assert.equal(denied.status, 403, JSON.stringify(denied.body));
          assert.deepEqual(denied.queries.filter(query => query.operation !== "select"), []);
          assert.deepEqual(await retryCounts(), before);
          return Response.json(denied.body, { status: denied.status });
        }
        const reply = await call("deals", "POST", body);
        const replayed = scenario === "lost saved response" && attempt === 2;
        const item = apiItem(reply, replayed ? 200 : 201);
        assert.equal((reply.body.data as Record<string, unknown>).replayed, replayed);
        savedIds.push(String(item.id));
        // Read SQL state BEFORE any simulated loss. The outer test later rolls back;
        // this proves writes before reply loss, not durable commit/crash recovery.
        const rows = await persisted();
        assert.equal(rows.length, 1);
        assert.ok(rows.some(row => row.id === item.id && row.status === "pending" && row.paid_at === null));
        if (scenario === "lost saved response" && attempt === 1) beforeLoss = rows;
        else return Response.json(reply.body, { status: reply.status });
      } catch (error) { proofFailure = error; throw error; }
      losses++;
      throw new TypeError("Synthetic response lost after local router save and SQL readback");
    });
    try {
      assert.equal(runtime.view.loaded, true);
      assert.equal(runtime.view.loadError, false);
      assert.equal(runtime.toasts.length, 0);
      runtime.view.openAdd(); runtime.render();
      runtime.view.setForm({ ...runtime.view.form, title: "Synthetic manual pending sale", amountTenge: "7000.50",
        clientId: id(3), appointmentId: id(10), notes: "Diagnostic only; no payment" });
      await runtime.settle();
      const input = JSON.parse(JSON.stringify(runtime.view.form));
      const first = runtime.view.submitForm;
      first(); runtime.render();
      assert.equal(runtime.view.saving, true);
      await runtime.settle();
      assert.ifError(proofFailure);
      assert.equal(runtime.view.saving, false);
      if (scenario !== "normal save") {
        assert.equal(runtime.view.formOpen, true);
        assert.deepEqual(JSON.parse(JSON.stringify(runtime.view.form)), input);
        assert.equal(runtime.view.items.length, 0, "optimistic row is removed when delivery fails");
        assert.equal(runtime.toasts.filter(toast => toast.kind === "success").length, 0);
        assert.equal(runtime.toasts.filter(toast => toast.kind === "error").length, 1);
        const message = runtime.toasts.find(toast => toast.kind === "error")!.message;
        if (scenario === "lost saved response") {
          assert.match(message, /Сохранение не подтверждено/);
          assert.doesNotMatch(message, /отменено|повторите попытку/);
        } else assert.doesNotMatch(message, /Сохранение не подтверждено/, "a definite pre-insert 403 is not a lost reply");
        assert.equal((await persisted()).length, scenario === "lost saved response" ? 1 : 0);
        if (scenario === "lost saved response") {
          assert.equal(beforeLoss.length, 1);
          assert.equal(beforeLoss[0].id, savedIds[0]);
          assert.deepEqual(await persisted(), beforeLoss);
        } else {
          assert.equal((await row("select count(*) from crm_sale_create_requests")).count, 0,
            "the confirmed pre-insert 403 created no receipt before a fresh attempt");
        }
        const latest = runtime.view.submitForm;
        assert.notEqual(latest, first, "retry must come from the latest actual page closure");
        latest(); runtime.render();
        assert.equal(runtime.view.saving, true);
        await runtime.settle();
        assert.ifError(proofFailure);
      }
      const posts = runtime.calls.filter(request => request.method === "POST");
      assert.equal(posts.length, scenario === "normal save" ? 1 : 2);
      if (posts.length === 2) {
        if (scenario === "refused before insert") {
          const { requestKey: rejectedKey, ...rejectedBody } = posts[0].body;
          const { requestKey: freshKey, ...freshBody } = posts[1].body;
          assert.deepEqual(freshBody, rejectedBody, "same business payload after a definite pre-insert refusal");
          assert.notEqual(freshKey, rejectedKey, "a confirmed refusal may retire its unused key");
        } else assert.deepEqual(posts[1].body, posts[0].body, "a lost reply must reuse the identical key and full payload");
      }
      for (const post of posts) {
        assert.match(String(post.body.requestKey), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        for (const key of ["id", "request_key", "requestId", "request_id", "idempotencyKey", "idempotency_key"]) {
          assert.equal(Object.hasOwn(post.body, key), false, `requestKey is the only sale retry identity, not ${key}`);
        }
        assert.deepEqual(Object.keys(post.headers).sort(), ["authorization", "content-type"]);
        assert.equal(post.body.amountMinor, 700050);
        assert.equal(post.body.status, "pending");
      }
      const rows = await persisted();
      const expected = 1;
      assert.equal(rows.length, expected);
      assert.equal(new Set(savedIds).size, expected);
      assert.deepEqual(rows.map(row => row.id).sort(), [...new Set(savedIds)].sort());
      for (const row of rows) {
        assert.match(String(row.id), /^[0-9a-f-]{36}$/);
        assert.equal(row.appointment_id, id(10)); assert.equal(row.client_id, id(3));
        assert.equal(row.amount_minor, 700050); assert.equal(row.status, "pending");
        assert.equal(row.paid_at, null); assert.equal(row.closed_at, null); assert.equal(row.payment_method, null);
      }
      assert.equal((await row("select count(*) from deals where status='paid' or paid_at is not null")).count, 0);
      assert.deepEqual(await retryCounts(), { ...before, sales: expected, journal: expected });
      assert.equal((await row("select count(*) from crm_sale_create_requests")).count, 1);
      assert.equal(losses, scenario === "lost saved response" ? 1 : 0);
      assert.equal(runtime.view.saving, false); assert.equal(runtime.view.formOpen, false);
      assert.equal(runtime.view.form.title, ""); assert.equal(runtime.view.form.amountTenge, "");
      assert.deepEqual(Array.from(runtime.view.items, item => item.id), [savedIds.at(-1)]);
      assert.equal(runtime.toasts.filter(toast => toast.kind === "success").length, 1);
      assert.equal(runtime.stored.has("negis_demo_deals"), false);
    } finally { runtime.dispose(); }
  });
}

for (const role of ["receptionist", "admin", "manager"] as const) {
  test(`G2 role workflow ${role}: linked lead and two catalogue services reach one explicit pending sale`, async () => {
    const call = await bundleApiFixture(role);
    await db.exec(`update workspaces set arrival_marks_paid=false where id='${id(1)}';
      insert into clients(id,workspace_id,full_name) values('${id(60)}','${id(1)}','G2 synthetic client');
      insert into leads(id,workspace_id,full_name) values('${id(61)}','${id(1)}','G2 synthetic lead')`);
    const client = await row(`select * from clients where id='${id(60)}'`);
    const linked = apiItem(await call("leads", "PATCH", { clientId: id(60) }, 1, id(61)));
    assert.equal(linked.id, id(61));
    assert.equal(linked.clientId, id(60));
    assert.equal((await row(`select client_id from leads where id='${id(61)}'`)).client_id, id(60));
    const leads = await call("leads", "GET");
    assert.equal(leads.status, 200, JSON.stringify(leads.body));
    assert.equal((leads.body.data as { items: Record<string, unknown>[] }).items[0].clientId, id(60));

    const catalogue = await call("clinic-services", "GET");
    assert.equal(catalogue.status, 200, JSON.stringify(catalogue.body));
    const services = (catalogue.body.data as { items: Record<string, unknown>[] }).items
      .map(service => ({ serviceId: service.id, name: service.name, priceMinor: service.basePriceMinor, durationMinutes: service.durationMinutes }))
      .sort((a, b) => String(a.serviceId).localeCompare(String(b.serviceId)));
    assert.deepEqual(services, [
      { serviceId: id(50), name: "First catalogue service", priceMinor: 500050, durationMinutes: 45 },
      { serviceId: id(51), name: "Second catalogue service", priceMinor: 200000, durationMinutes: 30 },
    ]);
    const booking = { ...keyedBooking(), client: client.full_name, clientId: linked.clientId, serviceItems: services };
    const before = await retryCounts();
    const created = await call("appointments", "POST", booking);
    const visit = apiItem(created, 201);
    const appointmentId = String(visit.id);
    assert.equal((created.body.data as Record<string, unknown>).clientCreated, false);
    assert.equal((created.body.data as Record<string, unknown>).clientMatch, "provided");
    assert.equal(visit.clientId, id(60));
    assert.deepEqual(visit.serviceItems, services);
    assert.equal(visit.priceMinor, 700050);
    assert.equal(visit.durationMinutes, 75);
    const stored = await row(`select * from appointments where id='${appointmentId}'`);
    assert.equal(stored.workspace_id, id(1));
    assert.equal(stored.client_id, id(60));
    assert.equal(stored.doctor_id, id(42));
    assert.equal(stored.created_by_staff_user_id, id(40));
    assert.deepEqual(stored.service_items, services);
    assert.equal(stored.service_id, null);
    assert.equal(stored.price_minor, 700050);
    assert.equal(stored.duration_minutes, 75);
    assert.equal(new Date(String(stored.starts_at)).toISOString(), "2026-10-03T04:00:00.000Z");
    const receipt = await row("select * from crm_appointment_create_requests");
    assert.equal(receipt.workspace_id, id(1));
    assert.equal(receipt.staff_user_id, id(40));
    assert.equal(receipt.request_key, id(70));
    assert.equal(receipt.appointment_id, appointmentId);
    const listed = await call("appointments", "GET");
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const listedVisit = (listed.body.data as { items: Record<string, unknown>[] }).items.find(item => item.id === appointmentId)!;
    for (const field of ["startsAt", "time"]) assert.equal((await db.query<{ same: boolean }>(
      "select $1::timestamptz=$2::timestamptz same", [listedVisit[field], "2026-10-03T04:00:00.000Z"],
    )).rows[0].same, true, "Equivalent PostgREST timestamp forms retain the exact instant");
    assert.deepEqual({ ...listedVisit, startsAt: visit.startsAt, time: visit.time }, visit);
    const afterCreate = await retryCounts();
    assert.equal(afterCreate.clients, before.clients);
    assert.equal(afterCreate.appointments, Number(before.appointments) + 1);
    assert.equal(afterCreate.receipts, 1);
    assert.equal(afterCreate.sales, 0);
    const repeated = await call("appointments", "POST", booking);
    assert.equal(apiItem(repeated).id, appointmentId);
    assert.equal((repeated.body.data as Record<string, unknown>).replayed, true);
    assert.deepEqual(await retryCounts(), afterCreate);

    const arrived = apiItem(await call("appointments", "PATCH", { status: "arrived" }, 1, appointmentId));
    assert.equal(arrived.id, appointmentId);
    assert.equal(arrived.status, "arrived");
    assert.equal(arrived.arrivalSaleId, "");
    assert.equal((await row("select count(*) from deals")).count, 0);
    assert.equal((await row(`select arrival_sale_id from appointments where id='${appointmentId}'`)).arrival_sale_id, null);
    const pending = apiItem(await call("deals", "POST", {
      title: arrived.service, clientId: arrived.clientId, leadId: linked.id, appointmentId: arrived.id,
      responsibleUserId: id(40), serviceId: "", amountMinor: arrived.priceMinor, currency: "KZT", status: "pending",
      notes: "G2-C1 synthetic manual CRM record; no payment",
    }), 201);
    assert.equal(pending.clientId, id(60));
    assert.equal(pending.leadId, id(61));
    assert.equal(pending.appointmentId, appointmentId);
    assert.equal(pending.responsibleUserId, id(40));
    assert.equal(pending.amountMinor, 700050);
    assert.equal(pending.currency, "KZT");
    assert.equal(pending.status, "pending");
    assert.equal(pending.paidAt, null);
    const savedSale = await row(`select * from deals where id='${pending.id}'`);
    assert.equal(savedSale.workspace_id, id(1));
    assert.equal(savedSale.client_id, id(60));
    assert.equal(savedSale.lead_id, id(61));
    assert.equal(savedSale.appointment_id, appointmentId);
    assert.equal(savedSale.responsible_user_id, id(40));
    assert.equal(savedSale.amount_minor, 700050);
    assert.equal(savedSale.currency, "KZT");
    assert.equal(savedSale.status, "pending");
    assert.equal(savedSale.service_id, null);
    assert.equal(savedSale.paid_at, null);
    assert.equal(savedSale.payment_method, null);

    // Only booking replay/arrival are idempotent here, not a second manual sale POST.
    const afterSale = await retryCounts();
    const replay = await call("appointments", "POST", booking);
    assert.equal(apiItem(replay).id, appointmentId);
    assert.equal(apiItem(replay).status, "arrived");
    assert.equal((replay.body.data as Record<string, unknown>).replayed, true);
    assert.deepEqual(await retryCounts(), afterSale);
    assert.equal(apiItem(await call("appointments", "PATCH", { status: "arrived" }, 1, appointmentId)).arrivalSaleId, "");
    const sales = await call("deals", "GET");
    assert.equal(sales.status, 200, JSON.stringify(sales.body));
    assert.deepEqual((sales.body.data as { items: Record<string, unknown>[] }).items, [pending]);
    assert.deepEqual(await row(`select * from deals where id='${pending.id}'`), savedSale);
    assert.deepEqual(await row(`select * from clients where id='${id(60)}'`), client);
    assert.equal((await row(`select count(*) from appointments where client_id='${id(60)}'`)).count, 1);
    assert.equal((await row("select count(*) from deals")).count, 1);
    assert.equal((await row("select count(*) from deals where status='paid'")).count, 0);
    assert.equal((await retryCounts()).appointments, Number(before.appointments) + 1);
    assert.equal((await retryCounts()).receipts, 1);
    assert.equal((await row(`select role from staff_users where id='${id(40)}'`)).role, role);
    assert.equal((await row(`select arrival_marks_paid from workspaces where id='${id(1)}'`)).arrival_marks_paid, false);
  });

  test(`G2 role workflow ${role}: foreign client is refused for lead, booking and manual sale without writes`, async () => {
    const call = await bundleApiFixture(role);
    await db.exec(`update workspaces set arrival_marks_paid=false where id='${id(1)}';
      insert into clients(id,workspace_id,full_name) values('${id(60)}','${id(2)}','G2 foreign client');
      insert into leads(id,workspace_id,full_name,client_id)
        values('${id(61)}','${id(1)}','G2 own linked lead','${id(3)}')`);
    const snapshot = async () => (await row(`select jsonb_build_object(
      'clients',(select jsonb_agg(c order by id) from clients c),
      'leads',(select jsonb_agg(l order by id) from leads l),
      'appointments',(select jsonb_agg(a order by id) from appointments a),
      'deals',(select jsonb_agg(d order by id) from deals d),
      'receipts',(select jsonb_agg(r order by request_key) from crm_appointment_create_requests r),
      'journal',(select jsonb_agg(j order by id) from audit_logs j)) as state`)).state;
    const before = await snapshot();
    const attempts = [
      () => call("leads", "PATCH", { clientId: id(60) }, 1, id(61)),
      () => call("appointments", "POST", { ...keyedBooking(), clientId: id(60), serviceItems: serviceBundle.slice(0, 2) }),
      () => call("deals", "POST", {
        title: "G2 foreign-client manual sale",
        clientId: id(60), leadId: id(61), appointmentId: id(10), amountMinor: 700050, currency: "KZT", status: "pending",
      }),
    ];
    for (const attempt of attempts) {
      const response = await attempt();
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.match(JSON.stringify(response.body), /clientId/);
      assert.ok(response.queries.some(query => query.table === "clients"
        && query.filters.some(([key, operator, value]) => key === "workspace_id" && operator === "=" && value === id(1))));
      assert.deepEqual(response.queries.filter(query => query.operation !== "select"), []);
      assert.deepEqual(await snapshot(), before);
    }
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
for (const role of ["anon", "authenticated", "service_role"] as const) {
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
    const response = await apiDatabase("postgres").rpc("create_crm_appointment_with_new_client", { ...base, ...changes });
    assert.equal(response.error?.code, "22023");
    assert.deepEqual(await bookingCounts(), { clients: 1, appointments: 1, deals: 0 });
  }
});

test("atomic creation RPC cannot overwrite an existing client or accept a foreign doctor", async () => {
  await bundleApiFixture();
  const original = await row(`select * from clients where id='${id(3)}'`);
  const base = atomicRpcArgs();
  const collision = await apiDatabase("postgres").rpc("create_crm_appointment_with_new_client", {
    ...base, p_client: { ...base.p_client, id: id(3) }, p_appointment: { ...base.p_appointment, client_id: id(3) },
  });
  assert.equal(collision.error?.code, "23505");
  assert.deepEqual(await row(`select * from clients where id='${id(3)}'`), original);
  await db.exec(`insert into clinic_doctors(id,workspace_id,full_name) values('${id(80)}','${id(2)}','Foreign doctor')`);
  const foreign = await apiDatabase("postgres").rpc("create_crm_appointment_with_new_client", {
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

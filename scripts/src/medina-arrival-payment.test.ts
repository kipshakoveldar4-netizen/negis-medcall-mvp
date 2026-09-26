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
  const numbers = new Set([9, 10, 11, 12, 13, 14, 19, 20, 29, 30, 32, 33, 34, 36, 40, 45, 55, 61]);
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
function apiDatabase() {
  const ident = (value: string) => {
    assert.match(value, /^[a-z_][a-z0-9_]*$/);
    return `"${value}"`;
  };
  return { from(table: string) {
    let operation = "select", single = false, columns = "*";
    let values: Record<string, unknown> = {};
    const filters: Array<[string, unknown]> = [];
    let limit: number | undefined;
    async function execute() {
      const params: unknown[] = [];
      const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
      const selection = columns === "*" ? "*" : columns.split(",").map(v => ident(v.trim())).join(",");
      let sql = `select ${selection} from ${ident(table)}`;
      if (operation === "update") sql = `update ${ident(table)} set ${Object.entries(values)
        .map(([key, value]) => `${ident(key)}=${bind(value)}`).join(",")}`;
      if (operation === "insert") sql = `insert into ${ident(table)} (${Object.keys(values).map(ident).join(",")}) values (${Object.values(values).map(bind).join(",")})`;
      if (filters.length) sql += " where " + filters.map(([key, value]) => `${ident(key)}=${bind(value)}`).join(" and ");
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
      eq(key: string, value: unknown) { filters.push([key, value]); return query; },
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
  return async (route = "appointments", method = "PATCH", updates: Record<string, unknown> = { status: "arrived" }, workspace = 1) => {
    let status = 0; let body: Record<string, unknown> = {};
    const res = { setHeader() {}, status(value: number) { status = value; return res; },
      json(value: Record<string, unknown>) { body = value; } };
    await handler({ method, headers: { authorization: "Bearer fixture.test.signature" },
      query: { path: [route], workspaceId: id(workspace) },
      body: method === "GET" ? undefined : { id: id(10), updates } }, res);
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

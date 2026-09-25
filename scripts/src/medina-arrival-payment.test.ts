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
  const numbers = new Set([9, 10, 11, 12, 13, 14, 19, 20, 30, 32, 33, 34, 36, 40, 45, 55, 61]);
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

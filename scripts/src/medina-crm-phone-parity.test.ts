import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// PH — the canonical phone exists twice, and the two must agree.
//
// Migration 028 adds leads.phone_normalized as a STORED GENERATED column so
// the inbound dedup can match on an indexed equality instead of scanning an
// arbitrary 1000-row window. That puts the canonicalization rules in two
// places: lib/crm/phone.ts (TypeScript, used by the webhook adapters when
// reading a provider payload) and the SQL expression (used by the database
// for every row anyone writes).
//
// If those two ever disagree, dedup fails silently in the worst possible
// way — the message is filed, the lead looks right, and the duplicate only
// appears later as two cards for one patient. So this suite executes the SQL
// expression's semantics against normalizePhone case by case, and pins the
// migration text so a future edit to one side cannot pass without the other.
//
// The SQL is modelled, not run: this project has no database in tests and
// never touches production from one. The model is derived from the migration
// text itself (the branches are extracted and asserted below), so a change to
// the SQL that this model does not describe fails PH3 rather than passing
// unnoticed.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationPath = path.join(repoRoot, "migrations", "028_leads_phone_normalized.sql");

const { normalizePhone } = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "crm", "phone.ts")).href
)) as { normalizePhone: (raw: unknown) => string };

/**
 * The generated column, evaluated the way Postgres would.
 *
 * `regexp_replace(phone, '\D', '', 'g')` is the digits; the branches below are
 * the CASE arms in the same order the migration writes them, since SQL CASE is
 * first-match just like the if-chain in phone.ts.
 */
function sqlPhoneNormalized(phone: string | null): string | null {
  if (phone === null) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits === "") return null;
  if (digits.length > 11 && digits.slice(0, 2) === "00") return `+${digits.slice(2)}`;
  if (digits.length === 11 && digits.slice(0, 1) === "8") return `+7${digits.slice(1)}`;
  return `+${digits}`;
}

/** Spellings this system actually receives and stores. */
const CASES: Array<string | null> = [
  null,
  "",
  "   ",
  "77010000001",
  "+77010000001",
  "+7 701 000-00-01",
  "8 701 000 00 01",
  "87010000001",
  "8(701)000-00-01",
  "007701000000123",
  "0077010000001",
  "+7-701-000-00-01",
  "701 000 00 01",
  "abc",
  "+7 (701) 000 00 01 доб. 5",
  "77470000000",
  "+1 202 555 0143",
  "8800",
];

test("PH1 the SQL column and normalizePhone agree on every spelling this system sees", () => {
  for (const input of CASES) {
    const sql = sqlPhoneNormalized(input);
    const ts = normalizePhone(input);
    // phone.ts answers "" where SQL answers NULL — both mean "nothing to match
    // on", and the pipeline never queries with an empty phone.
    const sqlComparable = sql === null ? "" : sql;
    assert.equal(
      sqlComparable,
      ts,
      `disagreement on ${JSON.stringify(input)}: SQL ${JSON.stringify(sql)} vs phone.ts ${JSON.stringify(ts)}`,
    );
  }
});

test("PH2 the two spellings of one Kazakh number collapse to the same key", () => {
  // The exact case the dedup exists for: an operator types the trunk form, the
  // provider sends the international one.
  const stored = sqlPhoneNormalized("8 701 000-00-01");
  const incoming = normalizePhone("77010000001");
  assert.equal(stored, "+77010000001");
  assert.equal(incoming, "+77010000001");
  assert.equal(stored, incoming, "a repeat contact would be filed as a new lead");
});

test("PH3 the generated expression is exactly the one this suite models", async () => {
  const sql = await readFile(migrationPath, "utf8");

  const start = sql.indexOf("generated always as (");
  assert.ok(start > 0, "the column must be generated, not application-maintained");
  const end = sql.indexOf(") stored;", start);
  assert.ok(end > start, "a virtual column cannot be indexed — it must be stored");

  const expression = sql
    .slice(start + "generated always as (".length, end)
    .replace(/\s+/g, " ")
    .trim();

  // Compared whole, not by fragments. A fragment check passes a defect as
  // small as negating one branch condition — verified: disabling the length
  // guard on the 00 arm left every `includes()` assertion happy. The model in
  // sqlPhoneNormalized() above is only trustworthy if the SQL it claims to
  // describe cannot drift by a single character without failing here.
  const EXPECTED =
    "case " +
    "when phone is null then null " +
    "when regexp_replace(phone, '\\D', '', 'g') = '' then null " +
    "when length(regexp_replace(phone, '\\D', '', 'g')) > 11 " +
    "and left(regexp_replace(phone, '\\D', '', 'g'), 2) = '00' " +
    "then '+' || substr(regexp_replace(phone, '\\D', '', 'g'), 3) " +
    "when length(regexp_replace(phone, '\\D', '', 'g')) = 11 " +
    "and left(regexp_replace(phone, '\\D', '', 'g'), 1) = '8' " +
    "then '+7' || substr(regexp_replace(phone, '\\D', '', 'g'), 2) " +
    "else '+' || regexp_replace(phone, '\\D', '', 'g') " +
    "end";

  assert.equal(
    expression,
    EXPECTED,
    "the SQL changed: update sqlPhoneNormalized() in this file to match, then update this expectation",
  );
});

test("PH4 the index the dedup relies on is there and matches the query's filters", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.ok(
    sql.includes("leads_workspace_phone_normalized_idx"),
    "without the index the exact match is a sequential scan on a growing table",
  );
  assert.ok(
    sql.includes("(workspace_id, phone_normalized)"),
    "the lookup is always scoped to one workspace — tenant first",
  );
  assert.ok(
    sql.includes("status is distinct from 'lost'"),
    "the partial predicate must mirror the query's own neq('status','lost')",
  );
});

/**
 * The same canonicalization now lives on clients too (migration 030), because
 * lead → client conversion had the mirror image of the defect 028 repaired:
 * it read every client of the workspace and matched in the browser by digits
 * alone, so the trunk form and the international form were two different
 * patients at any clinic size, and past the row cap the returning patient's
 * card was not in the window at all.
 *
 * Two columns, because the conversion matches on the WhatsApp number as well:
 * a patient reached at a second number is still that patient.
 */
const clientsMigrationPath = path.join(repoRoot, "migrations", "030_clients_phone_normalized.sql");

/** The one expression, with the column name as its only variable. */
function expectedExpression(column: string): string {
  return (
    "case " +
    `when ${column} is null then null ` +
    `when regexp_replace(${column}, '\\D', '', 'g') = '' then null ` +
    `when length(regexp_replace(${column}, '\\D', '', 'g')) > 11 ` +
    `and left(regexp_replace(${column}, '\\D', '', 'g'), 2) = '00' ` +
    `then '+' || substr(regexp_replace(${column}, '\\D', '', 'g'), 3) ` +
    `when length(regexp_replace(${column}, '\\D', '', 'g')) = 11 ` +
    `and left(regexp_replace(${column}, '\\D', '', 'g'), 1) = '8' ` +
    `then '+7' || substr(regexp_replace(${column}, '\\D', '', 'g'), 2) ` +
    `else '+' || regexp_replace(${column}, '\\D', '', 'g') ` +
    "end"
  );
}

function generatedExpressions(sql: string): string[] {
  const found: string[] = [];
  let at = sql.indexOf("generated always as (");
  while (at >= 0) {
    const end = sql.indexOf(") stored;", at);
    assert.ok(end > at, "a virtual column cannot be indexed — it must be stored");
    found.push(sql.slice(at + "generated always as (".length, end).replace(/\s+/g, " ").trim());
    at = sql.indexOf("generated always as (", end);
  }
  return found;
}

test("PH6 the clients columns carry character-for-character the same rule as leads", async () => {
  const sql = await readFile(clientsMigrationPath, "utf8");
  const expressions = generatedExpressions(sql);

  assert.equal(expressions.length, 2, "both the phone and the WhatsApp number are canonicalized");
  assert.equal(
    expressions[0],
    expectedExpression("phone"),
    "clients.phone_normalized drifted from the rule this suite models",
  );
  assert.equal(
    expressions[1],
    expectedExpression("whatsapp"),
    "clients.whatsapp_normalized drifted from the rule this suite models",
  );

  // And the model itself still agrees with phone.ts on every spelling, which
  // is what makes pinning the text meaningful rather than circular.
  for (const input of CASES) {
    const modelled = sqlPhoneNormalized(input);
    assert.equal(modelled === null ? "" : modelled, normalizePhone(input));
  }
});

test("PH7 the clients lookup has its indexes, scoped to the workspace first", async () => {
  const sql = await readFile(clientsMigrationPath, "utf8");

  for (const [name, columns] of [
    ["clients_workspace_phone_normalized_idx", "(workspace_id, phone_normalized)"],
    ["clients_workspace_whatsapp_normalized_idx", "(workspace_id, whatsapp_normalized)"],
  ]) {
    assert.ok(sql.includes(name), `without ${name} the exact match is a sequential scan on a growing table`);
    assert.ok(sql.includes(columns), `${name} must lead with the tenant: ${columns}`);
  }
});

test("PH8 030 adds columns and touches nothing that exists", async () => {
  const sql = await readFile(clientsMigrationPath, "utf8");

  for (const forbidden of ["drop column", "drop table", "delete from", "update public.clients", "alter column"]) {
    assert.equal(
      sql.toLowerCase().includes(forbidden),
      false,
      `030 must be additive; found "${forbidden}"`,
    );
  }
  assert.equal(
    (sql.match(/add column if not exists/g) ?? []).length,
    2,
    "re-running the migration must be a no-op for both columns",
  );
});

test("PH5 028 adds a column and touches nothing that exists", async () => {
  const sql = await readFile(migrationPath, "utf8");

  for (const forbidden of ["drop column", "drop table", "delete from", "update public.leads", "alter column"]) {
    assert.equal(
      sql.toLowerCase().includes(forbidden),
      false,
      `028 must be additive; found "${forbidden}"`,
    );
  }
  assert.ok(sql.includes("add column if not exists"), "re-running the migration must be a no-op");
});

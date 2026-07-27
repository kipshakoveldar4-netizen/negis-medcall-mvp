import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Medina OS Security-1B — the public schema must expose nothing to the browser
// roles, and future migrations must not silently reintroduce exposure.
//
// Verified in production before this migration: all 27 public tables had RLS
// enabled with zero policies, yet anon/authenticated held full table DML, and
// BOTH postgres and supabase_admin default ACLs granted the same to future
// objects. Migration 019 had already leaked two RPC-callable functions this way.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationsDir = path.join(repoRoot, "migrations");
const negisSrc = path.join(repoRoot, "artifacts", "negis", "src");

const HARDENING_MIGRATION = "023_public_privilege_hardening.sql";

/** Strip SQL comments so assertions never match explanatory prose. */
function sqlOnly(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

function normalize(source: string): string {
  return sqlOnly(source).replace(/\s+/g, " ").toLowerCase();
}

const migrationFiles = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
const migrations = new Map<string, string>();
for (const file of migrationFiles) {
  migrations.set(file, await readFile(path.join(migrationsDir, file), "utf8"));
}

const hardening = migrations.get(HARDENING_MIGRATION) ?? "";
const hardeningSql = normalize(hardening);

/** Migrations applied after the hardening migration must not undo it. */
const laterMigrations = migrationFiles.filter((f) => f > HARDENING_MIGRATION);

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectSourceFiles(full)));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

const frontendFiles = await collectSourceFiles(negisSrc);
const frontendSources = new Map<string, string>();
for (const file of frontendFiles) frontendSources.set(file, await readFile(file, "utf8"));

// ---------------------------------------------------------------------------
// Migration 023 content (assertions 1-19)
// ---------------------------------------------------------------------------

test("01 migration 023 exists", () => {
  assert.ok(migrations.has(HARDENING_MIGRATION), `${HARDENING_MIGRATION} must exist`);
  assert.ok(hardeningSql.includes("begin;") && hardeningSql.includes("commit;"), "single transaction");
});

test("02-04 migration 023 revokes CREATE on schema public from PUBLIC/anon/authenticated", () => {
  for (const role of ["public", "anon", "authenticated"]) {
    assert.ok(
      hardeningSql.includes(`revoke create on schema public from ${role};`),
      `CREATE on schema public must be revoked from ${role}`,
    );
  }
});

test("05 migration 023 revokes existing table privileges from browser roles", () => {
  assert.ok(
    hardeningSql.includes("revoke all privileges on all tables in schema public from anon, authenticated;"),
    "existing table privileges must be revoked",
  );
});

test("06 migration 023 revokes existing sequence privileges from browser roles", () => {
  assert.ok(
    hardeningSql.includes("revoke all privileges on all sequences in schema public from anon, authenticated;"),
    "existing sequence privileges must be revoked",
  );
});

test("07 migration 023 revokes function execution from PUBLIC/anon/authenticated", () => {
  assert.ok(
    hardeningSql.includes("revoke all privileges on all functions in schema public from public, anon, authenticated;"),
    "function execution must be revoked from browser roles and PUBLIC",
  );
});

test("08-13 migration 023 hardens default privileges for BOTH owner roles", () => {
  // ALTER DEFAULT PRIVILEGES is per-owner: covering only postgres would leave
  // supabase_admin-created objects exposed.
  for (const owner of ["postgres", "supabase_admin"]) {
    assert.ok(
      hardeningSql.includes(`alter default privileges for role ${owner} in schema public revoke all on tables from anon, authenticated;`),
      `${owner} future tables must not be granted to browser roles`,
    );
    assert.ok(
      hardeningSql.includes(`alter default privileges for role ${owner} in schema public revoke all on sequences from anon, authenticated;`),
      `${owner} future sequences must not be granted to browser roles`,
    );
    assert.ok(
      hardeningSql.includes(`alter default privileges for role ${owner} in schema public revoke execute on functions from public, anon, authenticated;`),
      `${owner} future functions must not be executable by browser roles`,
    );
  }
});

test("14 migration 023 never revokes service_role access", () => {
  assert.ok(!/revoke[^;]*service_role/.test(hardeningSql), "service_role must keep its access");
  assert.ok(hardeningSql.includes("grant usage on schema public to service_role;"), "service_role USAGE retained");
});

test("15-17 migration 023 touches no auth/storage/graphql_public objects", () => {
  for (const schema of ["auth.", "storage.", "graphql_public"]) {
    assert.ok(!hardeningSql.includes(schema), `migration must not modify ${schema}`);
  }
  for (const schema of ["schema auth", "schema storage", "schema graphql_public", "schema realtime"]) {
    assert.ok(!hardeningSql.includes(schema), `migration must not modify ${schema}`);
  }
});

test("18 migration 023 contains no data statements", () => {
  for (const stmt of ["insert into", "update ", "delete from", "truncate "]) {
    assert.ok(!hardeningSql.includes(stmt), `migration must not run "${stmt.trim()}"`);
  }
  assert.ok(!hardeningSql.includes("drop "), "migration must not drop objects");
});

test("19 migration 023 creates no tables or subscription objects", () => {
  assert.ok(!hardeningSql.includes("create table"), "no table creation in a privileges migration");
  for (const term of ["subscription", "plan_key", "entitlement", "billing", "invoice"]) {
    assert.ok(!hardeningSql.includes(term), `Commercial-3 object "${term}" must not appear here`);
  }
});

// ---------------------------------------------------------------------------
// Frontend still has no Data API dependency (assertions 20-25)
// ---------------------------------------------------------------------------

test("20-22 the frontend performs no table, RPC or Realtime access", () => {
  for (const [file, source] of frontendSources) {
    const rel = path.relative(negisSrc, file);
    assert.ok(!/\.from\(['"`]/.test(source), `${rel} must not query tables directly`);
    assert.ok(!/supabase[\s\S]{0,40}\.rpc\(/.test(source), `${rel} must not call database RPC`);
    assert.ok(!source.includes(".channel("), `${rel} must not open a Realtime channel`);
    assert.ok(!source.includes("postgres_changes"), `${rel} must not subscribe to table changes`);
  }
});

test("23 no direct PostgREST access from the browser", () => {
  for (const [file, source] of frontendSources) {
    const rel = path.relative(negisSrc, file);
    assert.ok(!source.includes("/rest/v1"), `${rel} must not call PostgREST directly`);
    assert.ok(!/fetch\([^)]*\/rpc\//.test(source), `${rel} must not call /rpc/ directly`);
  }
});

test("24 Security-1A containment remains intact", async () => {
  const app = await readFile(path.join(negisSrc, "App.tsx"), "utf8");
  assert.ok(!app.includes('path="/agent"'), "/agent stays unrouted");
  const authContext = await readFile(path.join(negisSrc, "contexts", "AuthContext.tsx"), "utf8");
  assert.ok(!authContext.includes("supabase.from("), "AuthContext performs no table reads");
  assert.ok(authContext.includes("/api/crm/staff"), "role resolution stays server-side");
});

test("25 Ads Automation PAUSED safety remains intact", async () => {
  const ads = await readFile(path.join(negisSrc, "pages", "AdsAutomation.tsx"), "utf8");
  assert.ok(ads.includes("выключенной"), "PAUSED notice preserved");
});

// ---------------------------------------------------------------------------
// Migration hygiene, order-aware (assertions 26-30)
// ---------------------------------------------------------------------------

// Tables created before the RLS-discipline era are recorded here deliberately:
// production shows every one of them already has RLS enabled, and migration 023
// removes the grants that made them reachable. New migrations get no such pass.
const PRE_HARDENING_RLS_ALLOWLIST = new Set(migrationFiles.filter((f) => f < HARDENING_MIGRATION));

test("26 migrations creating public tables must enable RLS", () => {
  for (const [file, source] of migrations) {
    const sql = normalize(source);
    if (!sql.includes("create table")) continue;
    if (PRE_HARDENING_RLS_ALLOWLIST.has(file)) continue;
    assert.ok(
      sql.includes("enable row level security"),
      `${file} creates a table and must enable row level security`,
    );
  }
});

test("27 new public SECURITY DEFINER functions must set a safe search_path", () => {
  for (const [file, source] of migrations) {
    const sql = normalize(source);
    if (!sql.includes("security definer")) continue;
    assert.ok(
      sql.includes("set search_path"),
      `${file} defines a SECURITY DEFINER function and must pin search_path`,
    );
  }
});

test("28 browser RPC execution requires an explicit allowlist (currently empty)", () => {
  for (const file of laterMigrations) {
    const sql = normalize(migrations.get(file) ?? "");
    assert.ok(
      !/grant execute[^;]*to[^;]*(anon|authenticated|public)/.test(sql),
      `${file} must not grant function execution to browser roles without review`,
    );
  }
});

test("29 no migration grants TRUNCATE or TRIGGER to browser roles", () => {
  for (const [file, source] of migrations) {
    const sql = normalize(source);
    assert.ok(
      !/grant[^;]*(truncate|trigger)[^;]*to[^;]*(anon|authenticated)/.test(sql),
      `${file} must not grant TRUNCATE/TRIGGER to browser roles`,
    );
  }
});

test("30 migrations after 023 must not reintroduce table DML for browser roles", () => {
  for (const file of laterMigrations) {
    const sql = normalize(migrations.get(file) ?? "");
    assert.ok(
      !/grant[^;]*(all|select|insert|update|delete)[^;]*on[^;]*to[^;]*(anon|authenticated)/.test(sql),
      `${file} must not re-expose tables to anon/authenticated`,
    );
    assert.ok(
      !/alter default privileges[^;]*grant[^;]*(anon|authenticated)/.test(sql),
      `${file} must not restore permissive default privileges`,
    );
  }
});

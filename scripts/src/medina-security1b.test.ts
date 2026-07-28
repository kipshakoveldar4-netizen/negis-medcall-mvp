import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Medina OS Security-1B — the public schema must expose nothing to the browser
// roles, and future migrations must not silently reintroduce exposure.
//
// Verified in production before this migration: all 27 public tables had RLS
// enabled with zero policies, yet anon and authenticated held 182 table grants
// each, and two RPC-callable functions leaked PUBLIC EXECUTE via migration 019.
//
// Owner boundary, established by a failed production run (SQLSTATE 42501):
// the SQL Editor and every project connection run as postgres, and
// pg_has_role(current_user, 'supabase_admin', 'MEMBER') is false. A project
// role therefore cannot alter default privileges owned by supabase_admin.
// A production owner audit showed all 27 public relations and all 4 public
// functions are owned by postgres, so hardening the postgres defaults covers
// every application object. The supabase_admin defaults remain a documented
// platform-owner residual, not an application-migration responsibility.

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

const hardeningRaw = migrations.get(HARDENING_MIGRATION) ?? "";
const hardeningSql = normalize(hardeningRaw);

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
// Migration 023 content and owner boundary (assertions 1-15)
// ---------------------------------------------------------------------------

test("01 migration 023 exists and is a single transaction", () => {
  assert.ok(migrations.has(HARDENING_MIGRATION), `${HARDENING_MIGRATION} must exist`);
  assert.equal(hardeningSql.split("begin;").length - 1, 1, "exactly one begin;");
  assert.equal(hardeningSql.split("commit;").length - 1, 1, "exactly one commit;");
});

test("02 migration 023 attempts no supabase_admin default privileges", () => {
  // A project connection runs as postgres and is not a member of
  // supabase_admin. Including that statement made the whole transaction fail
  // with SQLSTATE 42501 and rolled back every reachable REVOKE.
  assert.ok(
    !hardeningSql.includes("for role supabase_admin"),
    "migration must not alter default privileges owned by supabase_admin",
  );
  assert.ok(!hardeningSql.includes("set role supabase_admin"), "no role impersonation");
  assert.ok(!hardeningSql.includes("set session authorization"), "no session authorization switch");
});

test("03 migration 023 documents the platform-owner boundary", () => {
  const prose = hardeningRaw.toLowerCase();
  assert.ok(prose.includes("owner boundary"), "the owner boundary must be documented");
  assert.ok(prose.includes("supabase_admin"), "the residual owner must be named");
  assert.ok(
    prose.includes("platform-owner residual"),
    "the residual must be labelled so it is not mistaken for full coverage",
  );
});

test("04-06 migration 023 revokes CREATE on schema public from PUBLIC/anon/authenticated", () => {
  for (const role of ["public", "anon", "authenticated"]) {
    assert.ok(
      hardeningSql.includes(`revoke create on schema public from ${role};`),
      `CREATE on schema public must be revoked from ${role}`,
    );
  }
});

test("07 migration 023 revokes existing table privileges from browser roles", () => {
  assert.ok(
    hardeningSql.includes("revoke all privileges on all tables in schema public from anon, authenticated;"),
    "existing table privileges must be revoked",
  );
});

test("08 migration 023 revokes existing sequence privileges from browser roles", () => {
  assert.ok(
    hardeningSql.includes("revoke all privileges on all sequences in schema public from anon, authenticated;"),
    "existing sequence privileges must be revoked",
  );
});

test("09 migration 023 revokes function execution from PUBLIC/anon/authenticated", () => {
  assert.ok(
    hardeningSql.includes("revoke all privileges on all functions in schema public from public, anon, authenticated;"),
    "function execution must be revoked from browser roles and PUBLIC",
  );
});

test("10-12 migration 023 hardens postgres future objects", () => {
  // postgres owns every current public relation and function in production, and
  // every application migration runs as postgres, so these three statements
  // cover all application-owned future objects.
  assert.ok(
    hardeningSql.includes(
      "alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;",
    ),
    "postgres future tables must not be granted to browser roles",
  );
  assert.ok(
    hardeningSql.includes(
      "alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;",
    ),
    "postgres future sequences must not be granted to browser roles",
  );
  assert.ok(
    hardeningSql.includes(
      "alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;",
    ),
    "postgres future functions must not be executable by browser roles",
  );
});

test("13 migration 023 never revokes service_role access", () => {
  assert.ok(!/revoke[^;]*service_role/.test(hardeningSql), "service_role must keep its access");
  assert.ok(hardeningSql.includes("grant usage on schema public to service_role;"), "service_role USAGE retained");
});

test("14 migration 023 mutates no business data and no schema objects", () => {
  for (const stmt of ["insert into", "update ", "delete from", "truncate ", "alter table"]) {
    assert.ok(!hardeningSql.includes(stmt), `migration must not run "${stmt.trim()}"`);
  }
  assert.ok(!/\bdrop\b/.test(hardeningSql), "migration must not drop objects");
  assert.ok(!hardeningSql.includes("create table"), "no table creation in a privileges migration");
  assert.ok(!hardeningSql.includes("row level security"), "migration must not change RLS");
  assert.ok(!hardeningSql.includes("create policy") && !hardeningSql.includes("drop policy"), "no policy changes");
  for (const schema of ["auth.", "storage.", "graphql_public", "realtime"]) {
    assert.ok(!hardeningSql.includes(schema), `migration must not touch ${schema}`);
  }
});

test("15 migration 023 creates no Commercial-3 objects", () => {
  for (const term of ["subscription", "plan_key", "entitlement", "billing", "invoice", "trial"]) {
    assert.ok(!hardeningSql.includes(term), `Commercial-3 object "${term}" must not appear here`);
  }
});

// ---------------------------------------------------------------------------
// Frontend still has no Data API dependency (assertions 16-20)
// ---------------------------------------------------------------------------

test("16-18 the frontend performs no table, RPC or Realtime access", () => {
  for (const [file, source] of frontendSources) {
    const rel = path.relative(negisSrc, file);
    assert.ok(!/\.from\(['"`]/.test(source), `${rel} must not query tables directly`);
    assert.ok(!/supabase[\s\S]{0,40}\.rpc\(/.test(source), `${rel} must not call database RPC`);
    assert.ok(!source.includes(".channel("), `${rel} must not open a Realtime channel`);
    assert.ok(!source.includes("postgres_changes"), `${rel} must not subscribe to table changes`);
    assert.ok(!source.includes("/rest/v1"), `${rel} must not call PostgREST directly`);
    assert.ok(!/fetch\([^)]*\/rpc\//.test(source), `${rel} must not call /rpc/ directly`);
  }
});

test("19 Ads Automation PAUSED safety remains intact", async () => {
  const ads = await readFile(path.join(negisSrc, "pages", "AdsAutomation.tsx"), "utf8");
  assert.ok(ads.includes("выключенной"), "PAUSED notice preserved");
});

test("20 Security-1A containment remains intact", async () => {
  const app = await readFile(path.join(negisSrc, "App.tsx"), "utf8");
  assert.ok(!app.includes('path="/agent"'), "/agent stays unrouted");
  const authContext = await readFile(path.join(negisSrc, "contexts", "AuthContext.tsx"), "utf8");
  assert.ok(!authContext.includes("supabase.from("), "AuthContext performs no table reads");
  assert.ok(authContext.includes("/api/crm/staff"), "role resolution stays server-side");
});

// ---------------------------------------------------------------------------
// Application-owner guard for future migrations (assertions 21-25)
// ---------------------------------------------------------------------------

// Tables created before the RLS-discipline era are recorded here deliberately:
// production shows every one of them already has RLS enabled, and migration 023
// removes the grants that made them reachable. New migrations get no such pass.
const PRE_HARDENING_RLS_ALLOWLIST = new Set(migrationFiles.filter((f) => f < HARDENING_MIGRATION));

test("21 no migration may run as, or hand ownership to, supabase_admin", () => {
  // Application objects must stay postgres-owned; postgres is the only owner
  // whose default privileges this project is able to harden.
  for (const [file, source] of migrations) {
    const sql = normalize(source);
    assert.ok(!sql.includes("set role supabase_admin"), `${file} must not impersonate supabase_admin`);
    assert.ok(
      !sql.includes("set session authorization supabase_admin"),
      `${file} must not switch session authorization to supabase_admin`,
    );
    assert.ok(!/owner\s+to\s+supabase_admin/.test(sql), `${file} must not hand ownership to supabase_admin`);
  }
});

test("22 new public tables must enable RLS and grant nothing to browser roles", () => {
  for (const [file, source] of migrations) {
    const sql = normalize(source);
    if (!sql.includes("create table")) continue;
    if (PRE_HARDENING_RLS_ALLOWLIST.has(file)) continue;
    assert.ok(
      sql.includes("enable row level security"),
      `${file} creates a table and must enable row level security`,
    );
    assert.ok(
      !/grant[^;]*(all|select|insert|update|delete)[^;]*on[^;]*to[^;]*(anon|authenticated)/.test(sql),
      `${file} must not grant table access to browser roles`,
    );
  }
});

test("23 new public functions must not become browser-callable by default", () => {
  for (const file of laterMigrations) {
    const sql = normalize(migrations.get(file) ?? "");
    assert.ok(
      !/grant execute[^;]*to[^;]*(anon|authenticated|public)/.test(sql),
      `${file} must not grant function execution to browser roles without review`,
    );
    if (sql.includes("security definer")) {
      assert.ok(sql.includes("set search_path"), `${file} SECURITY DEFINER function must pin search_path`);
    }
  }
});

test("24 migrations after 023 must not reintroduce browser exposure", () => {
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
    assert.ok(
      !/grant[^;]*(truncate|trigger)[^;]*to[^;]*(anon|authenticated)/.test(sql),
      `${file} must not grant TRUNCATE/TRIGGER to browser roles`,
    );
  }
});

test("25 SECURITY DEFINER functions everywhere must pin search_path", () => {
  for (const [file, source] of migrations) {
    const sql = normalize(source);
    if (!sql.includes("security definer")) continue;
    assert.ok(sql.includes("set search_path"), `${file} defines a SECURITY DEFINER function and must pin search_path`);
  }
});

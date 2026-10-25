import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeSqlAcl, assertNoBrowserFunctionGrants, sameSqlObject, type SqlObject } from "./sql-acl-verifier";

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
const aclCache = new Map<string, ReturnType<typeof analyzeSqlAcl>>();
function inspectAcl(source: string) {
  let analysis = aclCache.get(source);
  if (!analysis) { analysis = analyzeSqlAcl(source); aclCache.set(source, analysis); }
  return analysis;
}

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

/**
 * The first migration required to satisfy assertion 22b.
 *
 * Compared by filename, exactly as the two allowlists above are: everything
 * before this predates the rule and keeps describing what it actually did.
 */
const ALTER_DISCIPLINE_MIGRATION = "031_tasks_links_and_authorship.sql";

/** Tables a migration alters, as opposed to creates. */
function alteredTables(sql: string): string[] {
  const names = new Set<string>();
  // ONLY — ключевое слово формы ALTER TABLE ONLY, а не имя таблицы; схема,
  // отличная от public, этому правилу не подчиняется. Без обеих оговорок
  // проверка потребовала бы грант для несуществующего объекта «only».
  for (const match of sql.matchAll(/alter table (?:if exists )?(?:only )?(?:([a-z0-9_]+)\.)?([a-z0-9_]+)/g)) {
    const schema = match[1] ?? "public";
    if (schema !== "public") continue;
    names.add(match[2]);
  }
  for (const created of sql.matchAll(/create table (?:if not exists )?(?:public\.)?([a-z0-9_]+)/g)) {
    names.delete(created[1]);
  }
  return [...names];
}

test("22b a migration that only alters a table does not get a free pass on RLS and grants", () => {
  // Assertion 22 and assertion 26 both begin by skipping any file without
  // `create table`. That is right for what they were written to catch — a new
  // table arriving unprotected — and it leaves a gap the other way round: a
  // migration that adds columns and indexes to a pre-023 table passes both
  // gates without a word, and the table it just extended keeps whatever it had,
  // which for the 010-era tables is no explicit grant and, by that migration's
  // own text, no RLS. Found by an adversarial review of the tasks branch, whose
  // own migration would have been the first to walk through it.
  //
  // The rule is deliberately narrow: a migration reaching for an existing table
  // must leave that table with RLS on and an explicit service_role grant
  // somewhere in the chain. It need not do both itself — a forward repair in a
  // later file is the sanctioned shape — but it may no longer stay silent.
  for (const [file, source] of migrations) {
    if (file < ALTER_DISCIPLINE_MIGRATION) continue;
    const sql = normalize(source);

    for (const table of alteredTables(sql)) {
      assert.ok(
        grantsToServiceRole(migrations, table) || RPC_ONLY_TABLES.has(table),
        `${file} alters ${table}, which nothing in the chain grants to service_role — `
          + "add the grant here rather than leaving the server's access to whatever production happens to hold",
      );
      const rlsPattern = new RegExp(`alter table (?:public\\.)?${table} enable row level security`);
      const enabledSomewhere = [...migrations].some(([, other]) => rlsPattern.test(normalize(other)));
      assert.ok(
        enabledSomewhere,
        `${file} alters ${table} without the chain ever enabling row level security on it`,
      );
    }
  }
});

test("23 new public functions must not become browser-callable by default", () => {
  for (const file of laterMigrations) {
    const source = migrations.get(file) ?? "";
    const sql = normalize(source);
    assert.doesNotThrow(() => assertNoBrowserFunctionGrants(source),
      `${file} must not grant function execution to browser roles or use unverifiable dynamic grants`);
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

// ---------------------------------------------------------------------------
// Server reachability of new tables (assertions 26-28)
// ---------------------------------------------------------------------------

// Tables created before the service-role grant had to be written down. They are
// listed rather than inferred, so the exemption is a decision someone made once
// and not a rule that quietly widens.
const PRE_EXPLICIT_GRANT_ALLOWLIST = new Set(
  [...PRE_HARDENING_RLS_ALLOWLIST].concat([
    "016_video_processing_jobs.sql",
    "017_video_jobs_completed_at.sql",
    "018_video_processing_jobs_contract.sql",
    "019_crm_lead_pipeline_foundation.sql",
    "020_crm_deals_foundation.sql",
    "021_crm_deal_payments.sql",
  ]),
);

/** Tables a migration creates, in the order the chain creates them. */
function createdTables(sql: string): string[] {
  const names: string[] = [];
  for (const match of sql.matchAll(/create table (?:if not exists )?(?:public\.)?([a-z0-9_]+)/g)) {
    names.push(match[1]);
  }
  return names;
}

/**
 * Does anything in the chain grant this table to service_role?
 *
 * Deliberately chain-wide rather than per-file: a forward repair in a later
 * migration is the correct way to fix an omission, because the earlier one has
 * already run somewhere and must keep describing what it did.
 */
function grantsToServiceRole(chain: Iterable<[string, string]>, table: string): boolean {
  for (const [, source] of chain) {
    for (const acl of inspectAcl(source).acls) {
      if (acl.action === "grant" && acl.kind === "table" && acl.roles.includes("service_role")
        && acl.objects.some((object) => sameSqlObject(object, { schema: "public", name: table }))) return true;
    }
  }
  return false;
}

// Receipt mutations use only reviewed SECURITY DEFINER RPCs. Most receipts are
// wholly RPC-only; 093 explicitly permits service_role SELECT, never DML.
type ReceiptFunction = { name: string; args: string[] };
type ReceiptReview = {
  migration: string;
  functions: ReceiptFunction[];
  readOnly?: boolean;
  privateFunctions?: (ReceiptFunction & { external?: boolean; definer?: boolean })[];
  triggers?: { name: string; table: string; fn: string; events: string[]; timing: string; deferred?: boolean }[];
};
const RPC_ONLY_TABLES = new Map<string, ReceiptReview>([
  ["crm_appointment_create_requests", {
    migration: "064_appointment_create_requests.sql",
    functions: [
      { name: "read_crm_appointment_create_request", args: ["uuid", "uuid", "uuid", "text"] },
      { name: "create_crm_appointment_once", args: ["uuid", "uuid", "uuid", "text", "jsonb", "jsonb", "text"] },
    ],
  }],
  ["crm_sale_create_requests", {
    migration: "076_crm_sale_create_requests.sql",
    functions: [
      { name: "read_crm_sale_create_request", args: ["uuid", "uuid", "uuid", "uuid", "text"] },
      { name: "create_crm_sale_once", args: ["uuid", "uuid", "uuid", "uuid", "text", "jsonb"] },
    ],
  }],
  ["platform_subscription_operations", {
    migration: "084_platform_subscription_operations.sql",
    functions: [
      { name: "apply_platform_subscription_operation", args: ["uuid", "uuid", "uuid", "text", "jsonb"] },
      { name: "read_platform_subscription_operation", args: ["uuid", "uuid", "uuid"] },
      { name: "abandon_platform_subscription_operation", args: ["uuid", "uuid", "uuid"] },
    ],
  }],
  ["content_telegram_delivery_guards", {
    migration: "097_content_telegram_delivery_admission.sql",
    functions: [{ name: "admit_content_telegram_delivery", args:
      ["uuid", "uuid", "uuid", "uuid", "timestamp with time zone", "text", "uuid", "text", "jsonb"] }],
  }],
  ["content_telegram_deliveries", {
    migration: "097_content_telegram_delivery_admission.sql",
    functions: [
      { name: "admit_content_telegram_delivery", args:
        ["uuid", "uuid", "uuid", "uuid", "timestamp with time zone", "text", "uuid", "text", "jsonb"] },
      { name: "advance_content_telegram_delivery", args:
        ["uuid", "uuid", "uuid", "uuid", "timestamp with time zone", "text", "uuid", "integer", "text", "text"] },
    ],
  }],
  ["crm_site_consent_receipts", {
    migration: "093_site_consent_receipts.sql",
    readOnly: true,
    functions: [{ name: "accept_crm_site_inquiry_with_consent", args: ["text", "uuid", "jsonb", "jsonb"] }],
    privateFunctions: [
      { name: "guard_crm_site_consent_receipt", args: [], definer: true },
      { name: "require_crm_site_consent_receipt", args: [], definer: true },
      { name: "valid_crm_site_consent_receipt", args: ["jsonb"], definer: false },
      { name: "accept_crm_site_inquiry", args: ["text", "uuid", "jsonb"], external: true },
    ],
    triggers: [
      { name: "guard_crm_site_consent_receipt", table: "crm_site_consent_receipts", fn: "guard_crm_site_consent_receipt", events: ["insert", "update"], timing: "before" },
      { name: "guard_crm_site_inquiry_binding", table: "crm_site_inquiries", fn: "guard_crm_site_consent_receipt", events: ["update"], timing: "before" },
      { name: "require_crm_site_consent_receipt", table: "crm_site_inquiries", fn: "require_crm_site_consent_receipt", events: ["insert"], timing: "after", deferred: true },
    ],
  }],
]);

test("26a grant checks recognize table lists without accepting similarly named tables or roles", () => {
  const chain = new Map([["local.sql", 'grant select on public.first, public.second to service_role; grant select on table public.third to "service_role" with grant option;']]);
  for (const table of ["first", "second", "third"]) assert.equal(grantsToServiceRole(chain, table), true);
  assert.equal(grantsToServiceRole(chain, "secon"), false);
  assert.equal(grantsToServiceRole(new Map([["local.sql", "grant select on second to other_service_role;"]]), "second"), false);
  assert.equal(grantsToServiceRole(new Map([["local.sql", "grant execute on function public.second() to service_role;"]]), "second"), false);
  assert.equal(grantsToServiceRole(new Map([["local.sql", "grant select on other.second to service_role;"]]), "second"), false);
});

function assertPrivateReceipt(chain: Map<string, string>, table: string) {
  const review = RPC_ONLY_TABLES.get(table);
  assert.ok(review, "an RPC-only exception needs an explicit reviewed migration and exact function signatures");
  const source = chain.get(review.migration) ?? "";
  const sql = normalize(source);
  const reviewed = inspectAcl(source);
  const relation: SqlObject = { schema: "public", name: table };
  assert.ok(createdTables(sql).includes(table));
  assert.ok(reviewed.rls.some((item) => sameSqlObject(item.object, relation) && item.enabled), "explicit RLS required");
  for (const role of ["public", "anon", "authenticated", "service_role"]) {
    assert.ok(reviewed.acls.some((acl) => acl.action === "revoke" && !acl.optionOnly && acl.kind === "table"
      && acl.privileges.includes("all") && acl.roles.includes(role)
      && acl.objects.some((object) => sameSqlObject(object, relation))), `explicit table REVOKE from ${role}`);
  }
  const analyses = [...chain].map(([file, text]) => ({ file, ...inspectAcl(text) }));
  if (review.readOnly) {
    assert.ok(reviewed.acls.some((acl) => acl.action === "grant" && acl.kind === "table" && !acl.columnScoped
      && !acl.grantOption && acl.privileges.length === 1 && acl.privileges[0] === "select"
      && acl.roles.length === 1 && acl.roles[0] === "service_role"
      && acl.objects.some((object) => sameSqlObject(object, relation))), "read-only server SELECT must be explicit");
    let serverSelect = false;
    for (const analysis of analyses) {
      for (const acl of analysis.acls.filter((item) => item.kind === "table" && !item.optionOnly && !item.columnScoped
        && item.roles.includes("service_role") && item.privileges.some((privilege) => ["all", "select"].includes(privilege))
        && item.objects.some((object) => sameSqlObject(object, relation)))) serverSelect = acl.action === "grant";
    }
    assert.ok(serverSelect, "read-only server SELECT must remain available after the full chain");
  }
  for (const analysis of analyses) {
    assert.ok(!analysis.rls.some((item) => sameSqlObject(item.object, relation) && !item.enabled), "RLS cannot be disabled later");
    assert.ok(!analysis.policies.some((object) => sameSqlObject(object, relation)), "receipt tables have no direct-access policies");
    for (const acl of analysis.acls.filter((item) => item.action === "grant" && item.kind === "table"
      && item.objects.some((object) => sameSqlObject(object, relation)))) {
      assert.ok(review.readOnly && acl.roles.length === 1 && acl.roles[0] === "service_role"
        && !acl.grantOption && acl.privileges.length === 1 && acl.privileges[0] === "select"
        && acl.objects.length === 1 && acl.objects[0].name === table,
      "receipt tables cannot have unreviewed direct or column grants");
    }
    for (const fn of analysis.functions.filter((item) => item.definer
      && item.references.some((reference) => sameSqlObject(reference, relation)))) {
      assert.ok([...review.functions, ...(review.privateFunctions ?? [])].some((signature) => sameSqlObject(fn.object, { schema: "public", ...signature })),
        `${table}: an additional SECURITY DEFINER reader needs explicit review`);
    }
  }
  for (const signature of review.functions) {
    const object: SqlObject = { schema: "public", ...signature };
    const functions = reviewed.functions.filter((fn) => sameSqlObject(fn.object, object));
    assert.equal(functions.length, 1, `${signature.name}: exact reviewed overload required`);
    assert.ok(functions[0].references.some((reference) => sameSqlObject(reference, relation)), signature.name);
    for (const role of ["public", "anon", "authenticated"]) {
      assert.ok(reviewed.acls.some((acl) => acl.action === "revoke" && !acl.optionOnly && acl.kind === "function"
        && acl.privileges.some((privilege) => ["all", "execute"].includes(privilege)) && acl.roles.includes(role)
        && acl.objects.some((target) => target.name !== "*" && sameSqlObject(target, object))),
      `${signature.name}: reviewed migration must explicitly revoke ${role} on this overload`);
    }
    assert.ok(reviewed.acls.some((acl) => acl.action === "grant" && acl.kind === "function"
      && acl.privileges.some((privilege) => ["all", "execute"].includes(privilege)) && acl.roles.includes("service_role")
      && acl.objects.some((target) => target.name !== "*" && sameSqlObject(target, object))),
    `${signature.name}: reviewed migration must explicitly grant server EXECUTE`);
    const revoked = new Set<string>();
    let serviceExecute = false;
    for (const analysis of analyses) {
      for (const fn of analysis.functions.filter((item) => sameSqlObject(item.object, object))) {
        assert.ok(fn.definer && fn.emptySearchPath, `${signature.name}: SECURITY DEFINER and empty search_path required`);
      }
      for (const acl of analysis.acls.filter((item) => item.kind === "function"
        && item.objects.some((target) => sameSqlObject(target, object))
        && item.privileges.some((privilege) => ["all", "execute"].includes(privilege)))) {
        if (acl.optionOnly) continue;
        for (const role of acl.roles) {
          if (acl.action === "revoke") {
            revoked.add(role);
            if (role === "service_role") serviceExecute = false;
          } else {
            assert.ok(!["public", "anon", "authenticated"].includes(role), `${signature.name}: no browser EXECUTE`);
            if (role === "service_role") {
              assert.equal(acl.grantOption, false, `${signature.name}: no delegated grant option`);
              serviceExecute = true;
            }
          }
        }
      }
    }
    for (const role of ["public", "anon", "authenticated"]) assert.ok(revoked.has(role), `${signature.name}: revoke ${role}`);
    assert.ok(serviceExecute, `${signature.name}: server EXECUTE must remain available`);
  }
  for (const signature of review.privateFunctions ?? []) {
    const object: SqlObject = { schema: "public", name: signature.name, args: signature.args };
    if (!signature.external) {
      const functions = reviewed.functions.filter((fn) => sameSqlObject(fn.object, object));
      assert.equal(functions.length, 1, `${signature.name}: exact closed helper required`);
      assert.ok(functions[0].emptySearchPath && functions[0].definer === signature.definer, `${signature.name}: reviewed helper security`);
    }
    for (const fn of analyses.flatMap((analysis) => analysis.functions).filter((item) => sameSqlObject(item.object, object))) {
      assert.ok(fn.emptySearchPath && (signature.definer === undefined || fn.definer === signature.definer),
        `${signature.name}: later definitions must preserve helper security`);
    }
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      assert.ok(reviewed.acls.some((acl) => acl.action === "revoke" && acl.kind === "function" && !acl.optionOnly
        && acl.privileges.some((privilege) => ["all", "execute"].includes(privilege)) && acl.roles.includes(role)
        && acl.objects.some((target) => target.name !== "*" && sameSqlObject(target, object))), `${signature.name}: explicit closed helper REVOKE ${role}`);
      let executable = false;
      for (const analysis of analyses) {
        for (const acl of analysis.acls.filter((item) => item.kind === "function" && !item.optionOnly
          && item.privileges.some((privilege) => ["all", "execute"].includes(privilege)) && item.roles.includes(role)
          && item.objects.some((target) => sameSqlObject(target, object)))) executable = acl.action === "grant";
      }
      assert.equal(executable, false, `${signature.name}: no bypass through ${role}`);
    }
  }
  for (const expected of review.triggers ?? []) {
    const object = { schema: "public", name: expected.table };
    const trigger = reviewed.triggers.filter((item) => item.name === expected.name && sameSqlObject(item.object, object));
    assert.equal(trigger.length, 1, `${expected.name}: receipt trigger required`);
    assert.equal(analyses.flatMap((analysis) => analysis.triggers).filter((item) => item.name === expected.name
      && sameSqlObject(item.object, object)).length, 1, `${expected.name}: replacement needs review`);
    assert.ok(sameSqlObject(trigger[0].fn, { schema: "public", name: expected.fn, args: [] }));
    assert.deepEqual(trigger[0].events, expected.events, `${expected.name}: all expected events`);
    assert.equal(trigger[0].timing, expected.timing);
    assert.equal(trigger[0].row, true);
    assert.equal(trigger[0].deferred, expected.deferred ?? false);
    assert.ok(!analyses.some((analysis) => analysis.triggerEdits.some((edit) => sameSqlObject(edit.object, object)
      && [expected.name, "all", "user"].includes(edit.name))), `${expected.name}: no later trigger replacement or disable`);
  }
}

for (const [table, review] of RPC_ONLY_TABLES) {
  test(`26b RPC-only ${table} stays private and reachable through its reviewed functions`, () => {
    assertPrivateReceipt(migrations, table);
  });

  test(`26b ${table} privacy check rejects weakened grants and inaccessible or unsafe RPCs`, () => {
    const source = migrations.get(review.migration)!;
    assert.doesNotThrow(() => assertPrivateReceipt(migrations, table), "negative fixtures require a valid baseline");
    for (const [from, to] of [
      [`alter table public.${table} enable row level security`, `alter table public.${table} disable row level security`],
      ["security definer", "security invoker"],
      [source.includes("security definer set search_path = ''") ? "security definer set search_path = ''" : "security definer set search_path=''",
        "security definer set search_path=public"],
      [source.includes(`revoke all on public.${table}`) ? `revoke all on public.${table}`
        : "revoke all on public.content_telegram_deliveries,public.content_telegram_delivery_guards",
        `grant select on public.${table}`],
      [`grant execute on function public.${review.functions[0].name}`, `revoke execute on function public.${review.functions[0].name}`],
    ]) {
      assert.ok(source.includes(from), "each mutation must change the current migration");
      const changed = new Map(migrations);
      changed.set(review.migration, source.replace(from, to));
      assert.throws(() => assertPrivateReceipt(changed, table), `${from} -> ${to}`);
    }
    for (const exposure of [
      `grant ${review.readOnly ? "insert" : "select"} on public.${table} to service_role;`,
      `grant select on table public.other, public.${table} to "service_role" with grant option;`,
      `grant select on public.${table} to "anon";`,
      `grant select (workspace_id) on public.${table} to authenticated;`,
      "grant select on all tables in schema public to service_role;",
      `alter table public.${table} disable row level security;`,
      `create policy leak on public.${table} to authenticated using (true);`,
      `grant execute on function public.${review.functions[0].name}(${review.functions[0].args.join(",")}) to "authenticated";`,
      `revoke execute on function public.${review.functions[0].name}(${review.functions[0].args.join(",")}) from service_role;`,
      `create function public.unreviewed_receipt_reader() returns jsonb language sql security definer set search_path='' as $$ select to_jsonb(t) from public.${table} t; $$;`,
      "do $$ begin execute format('grant execute on function %s to %I', unknown_function, unknown_role); end $$;",
    ]) {
      const exposed = new Map(migrations);
      exposed.set("999_synthetic_exposure.sql", exposure);
      assert.throws(() => assertPrivateReceipt(exposed, table), exposure);
    }
    for (const signature of review.functions) {
      const changed = new Map(migrations);
      const at = source.indexOf(`create or replace function public.${signature.name}(`);
      assert.ok(at >= 0, signature.name);
      changed.set(review.migration, source.slice(0, at) + source.slice(at).replace("security definer", "security invoker"));
      assert.throws(() => assertPrivateReceipt(changed, table), `each RPC must be protected: ${signature.name}`);
    }
    for (const signature of review.privateFunctions ?? []) {
      const exposed = new Map(migrations);
      exposed.set("999_synthetic_helper_exposure.sql", `grant execute on function public.${signature.name}(${signature.args.join(",")}) to service_role;`);
      assert.throws(() => assertPrivateReceipt(exposed, table), `closed helper ${signature.name}`);
    }
    for (const trigger of review.triggers ?? []) {
      for (const sql of [
        `alter table public.${trigger.table} disable trigger ${trigger.name};`,
        `drop trigger ${trigger.name} on public.${trigger.table};`,
      ]) {
        const changed = new Map(migrations);
        changed.set("999_synthetic_trigger_exposure.sql", sql);
        assert.throws(() => assertPrivateReceipt(changed, table), sql);
      }
    }
  });
}

test("26c 093 requires read-only SELECT and every immutable/deferred trigger event", () => {
  const table = "crm_site_consent_receipts";
  const file = "093_site_consent_receipts.sql";
  const source = migrations.get(file)!;
  assert.doesNotThrow(() => assertPrivateReceipt(migrations, table));
  for (const [from, to] of [
    [`grant select on public.${table} to service_role;`, `revoke select on public.${table} from service_role;`],
    ["before insert or update on public.crm_site_consent_receipts", "before insert on public.crm_site_consent_receipts"],
    ["deferrable initially deferred for each row", "not deferrable for each row"],
  ]) {
    assert.ok(source.includes(from), from);
    const changed = new Map(migrations);
    changed.set(file, source.replace(from, to));
    assert.throws(() => assertPrivateReceipt(changed, table), from);
  }
  const inaccessible = new Map(migrations);
  inaccessible.set("999_synthetic_read_revoke.sql", `revoke select on public.${table} from service_role;`);
  assert.throws(() => assertPrivateReceipt(inaccessible, table));
});

test("26 every new application table is reachable by the server that owns it", () => {
  // The routes run as service_role on a table created by postgres, which grants
  // it nothing. Migration 024 shipped without the grant: the invitation routes
  // authorized correctly and then failed on the query, in production, with a
  // 503 that said nothing. The rule is chain-wide, so a repair migration counts.
  const offenders: string[] = [];
  for (const [file, source] of migrations) {
    if (PRE_EXPLICIT_GRANT_ALLOWLIST.has(file)) continue;
    for (const table of createdTables(normalize(source))) {
      if (!grantsToServiceRole(migrations, table) && !RPC_ONLY_TABLES.has(table)) {
        offenders.push(`${file}: ${table} is never granted to service_role`);
      }
    }
  }
  assert.deepEqual(offenders, [], "a table the server cannot read is a feature that fails after it authorizes");
});

test("27 the rule detects the omission it was written for", () => {
  // Proof by fixture rather than by inspection: strip the repair out of a copy
  // of the chain and the check must fail. Without this, test 26 could be
  // asserting nothing and nobody would know.
  const withoutRepair = new Map(migrations);
  for (const [file, source] of withoutRepair) {
    withoutRepair.set(file, source.replace(/grant[^;]*staff_invitations[^;]*service_role[^;]*;/g, ""));
  }
  assert.equal(
    grantsToServiceRole(withoutRepair, "staff_invitations"),
    false,
    "the fixture must actually remove the grant, or this proves nothing",
  );
  assert.equal(
    grantsToServiceRole(migrations, "staff_invitations"),
    true,
    "and the real chain must carry it",
  );
});

test("28 the applied invitation migration is not rewritten to hide the omission", () => {
  const created = migrations.get("024_staff_invitations.sql") ?? "";
  const repair = migrations.get("025_staff_invitations_service_role_grant.sql") ?? "";

  assert.ok(created.length > 0, "024 must remain in the chain");
  assert.ok(repair.length > 0, "025 must carry the forward repair");
  assert.ok(
    !/grant[^;]*staff_invitations[^;]*service_role/.test(normalize(created)),
    "024 has already run in production; the grant belongs in 025, not backdated into it",
  );

  const repairSql = normalize(repair);
  assert.ok(/grant[^;]*on\s+table\s+public\.staff_invitations[^;]*to\s+service_role/.test(repairSql));
  assert.ok(!/(anon|authenticated|to\s+public)\b/.test(repairSql), "the repair grants nothing to a browser role");
  assert.ok(!/alter default privileges/.test(repairSql), "and says nothing about future tables");
  assert.ok(!/disable row level security/.test(repairSql), "RLS stays on");
  assert.equal((repairSql.match(/begin;/g) || []).length, 1);
  assert.equal((repairSql.match(/commit;/g) || []).length, 1);
});

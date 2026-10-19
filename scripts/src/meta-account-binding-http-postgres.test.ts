import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
type Row = Record<string, unknown>;
type PgClient = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
};
type PgFailure = { code: string; message: string; detail?: string; constraint?: string; table?: string; schema?: string };
type Filter = [string, "=" | "in", unknown];
type Query = { table: string; operation: "select" | "insert" | "update"; columns: string; filters: Filter[]; error?: PgFailure };
type Result = { data: unknown; error: PgFailure | null };

// Only the router's small query surface is translated; PostgreSQL supplies all
// business rows and write errors, including the unmodified unique violation.
function sqlClient(db: PgClient, identity: { user: string; staff: string }, queries: Query[],
  afterSnapshot?: (rows: Row[]) => Promise<void>) {
  const ident = (name: string) => {
    assert.match(name, /^[a-z_][a-z0-9_]*$/);
    return `"${name}"`;
  };
  return { from(table: string) {
    assert.ok(["staff_users", "workspace_settings", "meta_ad_accounts", "audit_logs"].includes(table));
    let operation: Query["operation"] = "select", columns = "*", single = false;
    let values: Row = {}, limit: number | undefined;
    const filters: Filter[] = [], orders: string[] = [];
    async function execute(): Promise<Result> {
      const entry: Query = { table, operation, columns, filters: [...filters] };
      queries.push(entry);
      let predicates = filters;
      if (table === "staff_users") {
        // 011 is deliberately not loaded. Mock only the auth-user-to-staff link;
        // membership role/status/workspace still come from the seeded real row.
        assert.equal(operation, "select");
        assert.deepEqual(filters, [["auth_user_id", "=", identity.user], ["status", "=", "active"]]);
        predicates = [["id", "=", identity.staff], ["status", "=", "active"]];
      }
      const params: unknown[] = [];
      const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
      const selection = columns === "*" ? "*" : columns.split(",").map(value => ident(value.trim())).join(",");
      let sql = `select ${selection} from public.${ident(table)}`;
      if (operation === "insert") sql = `insert into public.${ident(table)} (${Object.keys(values).map(ident).join(",")})`
        + ` values (${Object.values(values).map(bind).join(",")})`;
      if (operation === "update") sql = `update public.${ident(table)} set `
        + Object.entries(values).map(([key, value]) => `${ident(key)}=${bind(value)}`).join(",");
      if (predicates.length) sql += " where " + predicates.map(([key, operator, value]) => {
        if (operator === "=") return `${ident(key)}=${bind(value)}`;
        assert.ok(Array.isArray(value));
        return value.length ? `${ident(key)} in (${value.map(bind).join(",")})` : "false";
      }).join(" and ");
      if (operation !== "select") sql += ` returning ${selection}`;
      else {
        if (orders.length) sql += ` order by ${orders.join(",")}`;
        if (limit !== undefined) sql += ` limit ${limit}`;
      }
      let rows: Row[];
      try { rows = (await db.query(sql, params)).rows; }
      catch (error) {
        entry.error = error as PgFailure;
        return { data: null, error: entry.error };
      }
      if (table === "meta_ad_accounts" && operation === "select" && columns === "id") await afterSnapshot?.(rows);
      return { data: single ? rows[0] ?? null : rows, error: null };
    }
    const query = {
      select(value: string) { columns = value; return query; },
      eq(key: string, value: unknown) { filters.push([key, "=", value]); return query; },
      in(key: string, value: unknown[]) { filters.push([key, "in", value]); return query; },
      order(key: string, options: { ascending?: boolean } = {}) {
        orders.push(`${ident(key)} ${options.ascending === false ? "desc" : "asc"}`); return query;
      },
      limit(value: number) { assert.ok(Number.isInteger(value) && value > 0); limit = value; return query; },
      insert(value: Row) { operation = "insert"; values = value; return query; },
      update(value: Row) { operation = "update"; values = value; return query; },
      single() { single = true; return execute(); },
      maybeSingle() { single = true; return execute(); },
      then(resolve: (value: Result) => unknown, reject: (error: unknown) => unknown) { return execute().then(resolve, reject); },
    };
    return query;
  } };
}

test("Meta binding router race and retry use native PostgreSQL uniqueness", { timeout: 300000 }, async t => {
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE, "1", "Native fixture opt-in is mandatory; no Docker or external database fallback");
  const { startDisposablePostgres } = await import(new URL("../fixtures/disposable-postgres.mjs", import.meta.url).href) as {
    startDisposablePostgres(): Promise<{ connect(): Promise<PgClient>; close(): Promise<void> }>;
  };
  const fixture = await startDisposablePostgres();
  const workspace = randomUUID(), other = randomUUID(), staff = randomUUID(), user = randomUUID();
  const env = { SUPABASE_URL: "https://fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "fixture-not-a-service-secret",
    META_WORKSPACE_ID: workspace, META_AD_ACCOUNT_ID: "act_123456789", META_ACCESS_TOKEN: "fixture-not-a-meta-secret" };
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let resetFactory = () => {}, directory = "";
  try {
    const observer = await fixture.connect();
    directory = path.dirname(String((await observer.query("select current_setting('data_directory') as data")).rows[0].data));
    for (const name of ["009_medcall_mvp_persistence.sql", "010_staff_ready_crm.sql",
      "013_release_admin_settings.sql", "075_meta_account_workspace_uniqueness.sql"]) {
      // Read committed blobs explicitly, never the parallel session's migrations.
      await observer.query(execFileSync("git", ["show", `HEAD:migrations/${name}`], { cwd: root, encoding: "utf8", windowsHide: true }));
    }
    await observer.query("insert into workspaces(id,name) values($1,'Synthetic Meta race'),($2,'Untouched synthetic workspace')", [workspace, other]);
    await observer.query("insert into staff_users(id,workspace_id,email,full_name,role) values($1,$2,'admin@example.invalid','Synthetic admin','admin')", [staff, workspace]);
    await observer.query("insert into meta_ad_accounts(workspace_id,ad_account_id,account_name,metadata) values($1,'987654321','fixture-private-other-account',$2)",
      [other, { sentinel: "fixture-private-other-metadata" }]);
    const accounts = async (workspaceId: string) => (await observer.query(
      "select to_jsonb(m) as item from meta_ad_accounts m where workspace_id=$1 order by id", [workspaceId])).rows.map(row => row.item as Row);
    const otherBefore = await accounts(other);
    const journalBefore = (await observer.query("select * from audit_logs order by id")).rows;
    const a = await fixture.connect(), b = await fixture.connect();
    const backends = await Promise.all([observer, a, b].map(async db => (await db.query("select pg_backend_pid() as pid")).rows[0].pid));
    assert.equal(new Set(backends).size, 3, "Two independent request connections plus a separate observer");

    Object.assign(process.env, env);
    let authCalls = 0;
    const unexpectedHttp: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      if (url !== "https://fixture.invalid/auth/v1/user") {
        unexpectedHttp.push(String(url));
        throw new Error("External HTTP is forbidden in this fixture");
      }
      authCalls += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: user }) };
    }) as unknown as typeof fetch;
    const scope = new AsyncLocalStorage<ReturnType<typeof sqlClient>>();
    const serverClient = require("../../lib/supabase/server.ts") as {
      setSupabaseServerClientFactoryForTests(factory: (() => unknown) | null): void;
    };
    serverClient.setSupabaseServerClientFactoryForTests(() => {
      const client = scope.getStore();
      assert.ok(client, "No service client outside this request's owned SQL connection");
      return client;
    });
    resetFactory = () => serverClient.setSupabaseServerClientFactoryForTests(null);
    const handler = require("../../api/crm/[...path].ts").default as (req: unknown, res: unknown) => Promise<void>;
    async function call(db: PgClient, accountName: string, afterSnapshot?: (rows: Row[]) => Promise<void>) {
      const queries: Query[] = [];
      let status = 0, body: Row = {};
      const res = { setHeader() {}, status(value: number) { status = value; return res; }, json(value: Row) { body = value; } };
      await scope.run(sqlClient(db, { user, staff }, queries, afterSnapshot), () => handler({ method: "POST",
        headers: { authorization: "Bearer fixture.test.signature" }, query: { path: ["meta-accounts"], workspaceId: workspace },
        body: { workspaceId: workspace, adAccountId: env.META_AD_ACCOUNT_ID, accountName, status: "draft" } }, res));
      return { status, body, queries };
    }

    let release!: () => void;
    const bothEmpty = new Promise<void>(resolve => { release = resolve; });
    const snapshots: number[] = [];
    const afterSnapshot = async (rows: Row[]) => {
      snapshots.push(rows.length);
      assert.equal(rows.length, 0, "Each router request actually reads an empty binding snapshot");
      if (snapshots.length === 2) release();
      await Promise.race([bothEmpty, delay(5000, undefined, { ref: false }).then(() => {
        throw new Error("Both empty router reads must complete before either insert");
      })]);
    };
    const results = await Promise.all([call(a, "Synthetic concurrent A", afterSnapshot), call(b, "Synthetic concurrent B", afterSnapshot)]);
    assert.deepEqual(snapshots, [0, 0]);
    assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
    const winner = results.find(result => result.status === 201)!;
    const loser = results.find(result => result.status === 409)!;
    const item = (winner.body.data as { item: Row }).item;
    assert.equal(winner.body.success, true);
    assert.equal(winner.body.mode, "supabase");
    const saved = await accounts(workspace);
    assert.equal(saved.length, 1);
    assert.equal(item.id, saved[0].id);
    assert.equal(item.accountName, saved[0].account_name);
    assert.equal(item.adAccountId, saved[0].ad_account_id);
    assert.equal(saved[0].workspace_id, workspace);
    for (const result of results) {
      assert.deepEqual(result.queries.filter(query => query.table === "meta_ad_accounts").map(query => query.operation), ["select", "insert"]);
      assert.deepEqual(result.queries.filter(query => query.table === "audit_logs" && query.operation !== "select"), []);
    }
    const errors = loser.queries.flatMap(query => query.error ? [query.error] : []);
    assert.equal(errors.length, 1);
    const failure = errors[0];
    assert.equal(failure.code, "23505");
    assert.equal(failure.constraint, "meta_ad_accounts_one_workspace_idx");
    assert.ok(failure.detail?.includes(workspace), "Real PostgreSQL diagnostic contains the private conflicting workspace");
    assert.equal(winner.queries.some(query => query.error), false);
    assert.equal(loser.body.success, false);
    assert.equal(loser.body.code, "meta_account_binding_conflict");
    const serialized = JSON.stringify(loser.body);
    assert.doesNotMatch(serialized, /"(?:item|data|mode|warning|diagnostics?|message|hint)"\s*:/);
    for (const privateText of [workspace, other, env.SUPABASE_SERVICE_ROLE_KEY, env.META_ACCESS_TOKEN, "fixture.test.signature",
      env.META_AD_ACCOUNT_ID, "Synthetic concurrent A", "Synthetic concurrent B", "fixture-private", failure.code,
      failure.message, failure.detail, failure.constraint, failure.table, failure.schema]) {
      if (privateText) assert.equal(serialized.includes(privateText), false, "No provider secret or private database detail in conflict response");
    }
    assert.deepEqual((await observer.query("select * from audit_logs order by id")).rows, journalBefore,
      "The conflict creates no success journal; this resource currently journals neither successful nor refused saves");
    assert.deepEqual(await accounts(other), otherBefore);

    const retry = await call(results[0] === loser ? a : b, "Synthetic retry after conflict");
    assert.equal(retry.status, 201, JSON.stringify(retry.body));
    assert.equal(retry.body.mode, "supabase");
    assert.equal((retry.body.data as { item: Row }).item.id, item.id);
    const updated = await accounts(workspace);
    assert.equal(updated.length, 1);
    assert.equal(updated[0].id, item.id);
    assert.equal(updated[0].account_name, "Synthetic retry after conflict");
    assert.deepEqual(retry.queries.filter(query => query.table === "meta_ad_accounts").map(query => query.operation), ["select", "update"]);
    assert.deepEqual(retry.queries.find(query => query.operation === "update")?.filters,
      [["id", "=", item.id], ["workspace_id", "=", workspace]]);
    assert.equal(retry.queries.some(query => query.error), false);
    assert.deepEqual(await accounts(other), otherBefore);
    assert.deepEqual((await observer.query("select * from audit_logs order by id")).rows, journalBefore);
    assert.equal(authCalls, 3, "All three requests traverse actual router authentication");
    assert.deepEqual(unexpectedHttp, [], "No Meta, provider, or Supabase HTTP beyond the mocked auth endpoint");
    t.diagnostic("Observed two empty SQL snapshots, distinct PostgreSQL backends, real 23505, router 201/409, and same-row retry update; only committed 009/010/013/075 loaded");
  } finally {
    resetFactory();
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fixture.close();
    if (directory) {
      await assert.rejects(stat(directory), { code: "ENOENT" });
      t.diagnostic("Owned native PostgreSQL cluster stopped; its guarded fixture directory was removed");
    }
  }
});

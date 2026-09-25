import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { before, after, beforeEach, afterEach } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const load = (file: string) => import(pathToFileURL(path.join(root, file)).href);
const blog = await load("lib/crm/site-blog.ts") as { handleSiteBlog(req: unknown, res: unknown): Promise<unknown> };
const server = await load("lib/crm/server.ts") as { attachWorkspaceContext(req: unknown, context: unknown): void };
const supabase = await load("lib/supabase/server.ts") as { setSupabaseServerClientFactoryForTests(factory: (() => unknown) | null): void };
const schema = await load("lib/site/blog.ts") as { validateBlogWrite(body: unknown, updating: boolean): unknown };
const db = new PGlite();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fields = { title: "Статья", slug: "test-article", excerpt: "Описание", body: "Первый абзац\n\nВторой", locale: "ru" };

// Execute the handler's query chain against isolated PostgreSQL, including unique
// conflicts and optimistic version predicates, instead of canned successful rows.
function client() {
  return { from(table: string) {
    assert.equal(table, "site_blog_posts");
    let operation = "select", columns = "*", values: Record<string, unknown> = {}, single = false;
    const filters: Array<[string, unknown]> = [];
    let range: [number, number] | undefined;
    async function execute() {
      const params: unknown[] = [];
      const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
      let sql = "";
      if (operation === "insert") sql = `insert into public.site_blog_posts (${Object.keys(values).join(",")}) values (${Object.values(values).map(bind).join(",")})`;
      if (operation === "update") sql = `update public.site_blog_posts set ${Object.entries(values).map(([key, value]) => `${key}=${bind(value)}`).join(",")}`;
      if (operation === "select") sql = `select ${columns} from public.site_blog_posts`;
      if (filters.length) sql += " where " + filters.map(([key, value]) => `${key}=${bind(value)}`).join(" and ");
      if (operation !== "select") sql += ` returning ${columns}`;
      else if (range) sql += ` order by updated_at desc,id limit ${range[1] - range[0] + 1} offset ${range[0]}`;
      await db.exec("savepoint handler_query");
      try {
        const result = await db.query(sql, params);
        await db.exec("release savepoint handler_query");
        return { data: single ? result.rows[0] ?? null : result.rows, error: null };
      } catch (error) {
        await db.exec("rollback to savepoint handler_query; release savepoint handler_query");
        return { data: null, error: { code: (error as { code: string }).code } };
      }
    }
    const builder = {
      select(value: string) { columns = value; return builder; },
      insert(value: Record<string, unknown>) { values = value; operation = "insert"; return builder; },
      update(value: Record<string, unknown>) { values = value; operation = "update"; return builder; },
      eq(key: string, value: unknown) { filters.push([key, value]); return builder; },
      order() { return builder; },
      range(start: number, end: number) { range = [start, end]; return builder; },
      single() { single = true; return execute(); },
      maybeSingle() { single = true; return execute(); },
      then(resolve: (value: unknown) => unknown) { return execute().then(resolve); },
    };
    return builder;
  } };
}

async function call(method: string, body: unknown = undefined, workspace = 1, role = "owner", query: Record<string, string> = {}) {
  const req = { method, body, query, headers: {} };
  if (role !== "anonymous") server.attachWorkspaceContext(req, { workspaceId: id(workspace), role, userId: id(90), staffUserId: id(91), permissions: [] });
  let status = 0; let payload: Record<string, unknown> = {};
  const res = { setHeader() {}, status(value: number) { status = value; return res; }, json(value: Record<string, unknown>) { payload = value; } };
  await blog.handleSiteBlog(req, res);
  return { status, payload };
}
before(async () => {
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create table public.workspaces(id uuid primary key);");
  const sql = await readFile(path.join(root, "migrations/059_site_blog_drafts.sql"), "utf8");
  await db.exec(sql); await db.exec(sql);
  await db.query("insert into public.workspaces(id) values($1),($2)", [id(1), id(2)]);
});
beforeEach(async () => { await db.exec("begin"); supabase.setSupabaseServerClientFactoryForTests(client); });
afterEach(async () => { supabase.setSupabaseServerClientFactoryForTests(null); await db.exec("rollback"); });
after(() => db.close());

test("only owner/admin can edit; anonymous and staff cannot read", async () => {
  assert.equal((await call("GET", undefined, 1, "anonymous")).status, 401);
  assert.equal((await call("GET", undefined, 1, "receptionist")).status, 403);
  assert.equal((await call("GET", undefined, 1, "admin")).status, 200);
});
test("create retry is idempotent; list excludes article body", async () => {
  assert.equal((await call("POST", { ...fields, id: id(10) })).status, 201);
  assert.equal((await call("POST", { ...fields, id: id(10) })).status, 200);
  const list = await call("GET");
  const rows = list.payload.data as Record<string, unknown>[];
  assert.equal(rows.length, 1); assert.equal(Object.hasOwn(rows[0], "body"), false);
  const item = await call("GET", undefined, 1, "owner", { id: id(10) });
  assert.equal((item.payload.data as Record<string, unknown>).body, fields.body);
});
test("tenant isolation applies to list/detail/update/create retries", async () => {
  await call("POST", { ...fields, id: id(10) });
  assert.deepEqual((await call("GET", undefined, 2)).payload.data, []);
  assert.equal((await call("GET", undefined, 2, "owner", { id: id(10) })).status, 404);
  assert.equal((await call("PATCH", { ...fields, id: id(10), version: 1 }, 2)).status, 409);
  assert.equal((await call("POST", { ...fields, id: id(10) }, 2)).status, 409);
});
test("stale revision never overwrites the saved draft", async () => {
  await call("POST", { ...fields, id: id(10) });
  assert.equal((await call("PATCH", { ...fields, title: "Новое", id: id(10), version: 1 })).status, 200);
  assert.equal((await call("PATCH", { ...fields, title: "Устаревшее", id: id(10), version: 1 })).status, 409);
  const data = (await call("GET", undefined, 1, "owner", { id: id(10) })).payload.data as Record<string, unknown>;
  assert.equal(data.version, 2); assert.equal(data.title, "Новое");
});
test("slug uniqueness is workspace-scoped; publishing and tenant injection are refused", async () => {
  await call("POST", { ...fields, id: id(10) });
  assert.equal((await call("POST", { ...fields, id: id(11) })).status, 409);
  assert.equal((await call("POST", { ...fields, id: id(12) }, 2)).status, 201);
  for (const extra of [{ workspace_id: id(2) }, { status: "published" }, { locale: "kz" }, { title: "" }, { body: "x".repeat(30001) }]) {
    assert.equal(schema.validateBlogWrite({ ...fields, id: id(13), ...extra }, false), null);
  }
});
test("pagination has explicit hasMore and stable page size", async () => {
  for (let i = 0; i < 21; i++) await call("POST", { ...fields, slug: `article-${i}`, id: id(100 + i) });
  const first = await call("GET"); assert.equal((first.payload.data as unknown[]).length, 20); assert.equal(first.payload.hasMore, true);
  const last = await call("GET", undefined, 1, "owner", { offset: "20" }); assert.equal((last.payload.data as unknown[]).length, 1); assert.equal(last.payload.hasMore, false);
});
test("missing storage is an explicit error, never demo or successful empty list", async () => {
  supabase.setSupabaseServerClientFactoryForTests(() => null);
  const result = await call("GET"); assert.equal(result.status, 503); assert.equal(result.payload.code, "blog_unavailable");
});
test("browser roles have no direct table privileges", async () => {
  const result = await db.query<{ allowed: boolean }>("select has_table_privilege('anon','public.site_blog_posts','SELECT') or has_table_privilege('authenticated','public.site_blog_posts','UPDATE') as allowed");
  assert.equal(result.rows[0].allowed, false);
});

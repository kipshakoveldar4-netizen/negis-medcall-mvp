import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { before, after, beforeEach, afterEach } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const load = (file: string) => import(pathToFileURL(path.join(root, file)).href);
const blog = await load("lib/crm/site-blog.ts") as { handleSiteBlog(req: unknown, res: unknown): Promise<unknown> };
const publicSite = await load("lib/crm/site-page.ts") as { handleSitePage(req: unknown, res: unknown): Promise<unknown> };
const server = await load("lib/crm/server.ts") as { attachWorkspaceContext(req: unknown, context: unknown): void };
const supabase = await load("lib/supabase/server.ts") as { setSupabaseServerClientFactoryForTests(factory: (() => unknown) | null): void };
const schema = await load("lib/site/blog.ts") as { validateBlogWrite(body: unknown, updating: boolean): unknown };
const db = new PGlite();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fields = { title: "Статья", slug: "test-article", excerpt: "Описание", body: "Первый абзац\n\nВторой", locale: "ru" };

test("editor distinguishes unavailable list from empty and translates auth errors", async () => {
  const source = await readFile(path.join(root, "artifacts/negis/src/pages/SiteBlog.tsx"), "utf8");
  assert.ok(source.includes("error instanceof CrmApiError"));
  assert.ok(source.includes("Войдите в аккаунт повторно."));
  assert.ok(source.includes('listAvailable ? "Статей пока нет." : "Список недоступен."'));
  assert.ok(source.includes("setListAvailable(false)"));
  assert.ok(source.includes("setListAvailable(true)"));
});

// Execute the handler's query chain against isolated PostgreSQL, including unique
// conflicts and optimistic version predicates, instead of canned successful rows.
function client() {
  return { async rpc(name: string, args: Record<string, unknown>) {
    assert.equal(name, "set_site_blog_publication");
    await db.exec("savepoint publish_query");
    try {
      const result = await db.query<{ value: unknown }>("select public.set_site_blog_publication($1,$2,$3,$4) as value",
        [args.p_workspace_id, args.p_post_id, args.p_version, args.p_publish]);
      await db.exec("release savepoint publish_query");
      return { data: result.rows[0].value, error: null };
    } catch (error) {
      await db.exec("rollback to savepoint publish_query; release savepoint publish_query");
      return { data: null, error: { code: (error as { code: string }).code } };
    }
  }, from(table: string) {
    assert.equal(table, "site_blog_posts");
    let operation = "select", columns = "*", values: Record<string, unknown> = {}, single = false;
    const filters: Array<[string, unknown]> = [];
    let range: [number, number] | undefined;
    let publishedOnly = false;
    async function execute() {
      const params: unknown[] = [];
      const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
      let sql = "";
      if (operation === "insert") sql = `insert into public.site_blog_posts (${Object.keys(values).join(",")}) values (${Object.values(values).map(bind).join(",")})`;
      if (operation === "update") sql = `update public.site_blog_posts set ${Object.entries(values).map(([key, value]) => `${key}=${bind(value)}`).join(",")}`;
      if (operation === "select") sql = `select ${columns} from public.site_blog_posts`;
      if (filters.length) sql += " where " + filters.map(([key, value]) => `${key}=${bind(value)}`).join(" and ");
      if (publishedOnly) sql += `${filters.length ? " and" : " where"} published_snapshot is not null`;
      if (operation !== "select") sql += ` returning ${columns}`;
      else if (range) sql += ` order by updated_at desc,id limit ${range[1] - range[0] + 1} offset ${range[0]}`;
      await db.exec("savepoint handler_query");
      try {
        const result = await db.query(sql, params);
        await db.exec("release savepoint handler_query");
        const rows = JSON.parse(JSON.stringify(result.rows));
        return { data: single ? rows[0] ?? null : rows, error: null };
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
      not(key: string, operator: string, value: unknown) { assert.equal(key, "published_snapshot"); assert.equal(operator, "is"); assert.equal(value, null); publishedOnly = true; return builder; },
      limit(count: number) { range = [0, count - 1]; return builder; },
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
  const publication = await readFile(path.join(root, "migrations/060_site_blog_publication.sql"), "utf8");
  await db.exec(publication); await db.exec(publication);
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

test("explicit publication snapshots survive draft edits, but withdrawal removes them", async () => {
  await call("POST", { ...fields, id: id(10) });
  const published = await call("PATCH", { id: id(10), version: 1, action: "publish" });
  assert.equal(published.status, 200);
  assert.equal((published.payload.data as Record<string, unknown>).publishedVersion, 2);
  await call("PATCH", { ...fields, title: "PRIVATE DRAFT", id: id(10), version: 2 });
  const row = await db.query<{ published_snapshot: { title: string } }>("select published_snapshot from site_blog_posts");
  assert.equal(row.rows[0].published_snapshot.title, fields.title);
  assert.equal((await call("PATCH", { id: id(10), version: 2, action: "publish" })).status, 409);
  assert.equal((await call("PATCH", { id: id(10), version: 3, action: "unpublish" })).status, 200);
  assert.equal((await db.query<{ n: number }>("select count(*)::int as n from site_blog_posts where published_snapshot is not null")).rows[0].n, 0);
});

test("publication requires owner, workspace, complete content and unique public slug", async () => {
  await call("POST", { ...fields, id: id(10) });
  const action = { id: id(10), version: 1, action: "publish" };
  assert.equal((await call("PATCH", action, 1, "receptionist")).status, 403);
  assert.equal((await call("PATCH", action, 2)).status, 409);
  assert.equal((await call("PATCH", { ...action, published_snapshot: fields })).status, 400);
  assert.equal((await call("PATCH", action)).status, 200);
  await call("PATCH", { ...fields, slug: "renamed-draft", id: id(10), version: 2 });
  await call("POST", { ...fields, id: id(11) });
  assert.equal((await call("PATCH", { ...action, id: id(11) })).status, 409);
  await call("POST", { ...fields, slug: "empty", body: "", id: id(12) });
  assert.equal((await call("PATCH", { ...action, id: id(12) })).status, 400);
  const grant = await db.query<{ allowed: boolean }>("select has_function_privilege('anon','public.set_site_blog_publication(uuid,uuid,integer,boolean)','EXECUTE') or has_function_privilege('authenticated','public.set_site_blog_publication(uuid,uuid,integer,boolean)','EXECUTE') as allowed");
  assert.equal(grant.rows[0].allowed, false);
});

async function publicCall(page = "/ru/blog/", extra: Record<string, unknown> = {}, enabled = true, method = "GET", formEnabled = false) {
  const names = ["MEDINA_PUBLIC_SITE_ENABLED", "MEDINA_PUBLIC_SITE_WORKSPACE_ID", "MEDINA_SITE_ORIGIN", "MEDINA_SITE_INDEXABLE", "MEDINA_SITE_FORM_ENABLED", "MEDINA_SITE_INTAKE_ENABLED", "MEDINA_SITE_INTAKE_KEY", "MEDINA_SITE_TURNSTILE_SECRET", "MEDINA_SITE_TURNSTILE_SITE_KEY"];
  const previous = names.map(name => process.env[name]);
  process.env.MEDINA_PUBLIC_SITE_ENABLED = String(enabled);
  process.env.MEDINA_PUBLIC_SITE_WORKSPACE_ID = id(1);
  process.env.MEDINA_SITE_ORIGIN = "https://site.example.invalid";
  process.env.MEDINA_SITE_INDEXABLE = "true";
  process.env.MEDINA_SITE_FORM_ENABLED = String(formEnabled);
  process.env.MEDINA_SITE_INTAKE_ENABLED = String(formEnabled);
  process.env.MEDINA_SITE_INTAKE_KEY = "test-site";
  process.env.MEDINA_SITE_TURNSTILE_SECRET = "test-secret-never-render";
  process.env.MEDINA_SITE_TURNSTILE_SITE_KEY = "public-test-site-key";
  let status = 0, html = "";
  const headers: Record<string, string> = {};
  const res = { setHeader(key: string, value: string) { headers[key] = value; }, status(value: number) { status = value; return res; }, end(value?: string) { html = value || ""; } };
  try { await publicSite.handleSitePage({ method, url: page, query: { page, ...extra } }, res); return { status, html, headers }; }
  finally { names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }); }
}

test("public HTML never exposes drafts or foreign workspaces, and withdrawal is immediate", async () => {
  await call("POST", { ...fields, title: "PRIVATE DRAFT", id: id(10) });
  assert.doesNotMatch((await publicCall()).html, /PRIVATE DRAFT|after-the-lead/);
  await call("POST", { ...fields, title: "FOREIGN ARTICLE", id: id(11) }, 2);
  await call("PATCH", { id: id(11), version: 1, action: "publish" }, 2);
  await call("PATCH", { id: id(10), version: 1, action: "publish" });
  const page = await publicCall("/ru/blog/test-article/");
  assert.equal(page.status, 200); assert.match(page.html, /PRIVATE DRAFT/);
  assert.doesNotMatch(page.html, /FOREIGN ARTICLE|workspace_id|published_snapshot|Редакционный черновик/);
  assert.match(page.html, /canonical/); assert.equal(page.headers["Cache-Control"], "no-store");
  await call("PATCH", { ...fields, title: "NEW SECRET", id: id(10), version: 2 });
  assert.doesNotMatch((await publicCall("/ru/blog/test-article/")).html, /NEW SECRET/);
  await call("PATCH", { id: id(10), version: 3, action: "unpublish" });
  assert.equal((await publicCall("/ru/blog/test-article/")).status, 404);
  assert.doesNotMatch((await publicCall("/ru/sitemap.xml")).html, /test-article/);
});

test("public surface refuses tenant selectors, writes, disabled config and storage outages", async () => {
  assert.equal((await publicCall("/ru/", {}, false)).status, 404);
  assert.equal((await publicCall("/ru/", { workspaceId: id(2) })).status, 400);
  const tagged = await publicCall("/ru/", { utm_source: "ad-test-only", fbclid: "ignored-click-id" });
  assert.equal(tagged.status, 200); assert.doesNotMatch(tagged.html, /ad-test-only|ignored-click-id/);
  assert.equal((await publicCall("/ru/", {}, true, "POST")).status, 405);
  assert.equal((await publicCall("/ru/", {}, true, "HEAD")).html, "");
  assert.equal((await publicCall("/ru/missing/")).status, 404);
  assert.equal((await publicCall("/ru/blog/../../admin")).status, 404);
  supabase.setSupabaseServerClientFactoryForTests(() => null);
  assert.equal((await publicCall()).status, 503);
});

test("inquiry form requires matching enabled tenant mapping and never renders its secret", async () => {
  let workspace = id(2), enabled = true;
  supabase.setSupabaseServerClientFactoryForTests(() => ({ from(table: string) {
    if (table === "site_blog_posts") return client().from(table);
    assert.equal(table, "crm_intake_sites");
    const query = {
      select() { return query; },
      eq(key: string, value: string) { assert.equal(key, "site_key"); assert.equal(value, "test-site"); return query; },
      async maybeSingle() { return { error: null, data: { workspace_id: workspace, enabled, consent_version: "v1", allowed_page_paths: ["/ru/"] } }; },
    };
    return query;
  } }));
  assert.doesNotMatch((await publicCall("/ru/", {}, true, "GET", true)).html, /data-intake-endpoint/);
  workspace = id(1); enabled = false;
  assert.doesNotMatch((await publicCall("/ru/", {}, true, "GET", true)).html, /data-intake-endpoint/);
  enabled = true;
  const page = await publicCall("/ru/", {}, true, "GET", true);
  assert.equal(page.status, 200);
  assert.match(page.html, /data-intake-endpoint/);
  assert.match(page.html, /public-test-site-key/);
  assert.doesNotMatch(page.html, /test-secret-never-render|workspace_id/);
  assert.doesNotMatch((await publicCall("/ru/")).html, /data-intake-endpoint/);
});

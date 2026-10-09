import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const db = new PGlite();
const workspaceId = "00000000-0000-4000-8000-000000000001";

async function migration(name: string) {
  return (await readFile(path.join(root, "migrations", name), "utf8")).replace(
    /CREATE EXTENSION IF NOT EXISTS pgcrypto;/i,
    "",
  );
}

async function replace(plan: string, price = "3990000") {
  return (
    await db.query<{ item: Record<string, unknown> }>(
      "select public.replace_platform_subscription($1,$2,$3,$4,$5,$6) as item",
      [workspaceId, plan, price, "KZT", "monthly", "test only"],
    )
  ).rows[0].item;
}

before(async () => {
  await db.exec(
    "create role anon; create role authenticated; create role service_role bypassrls;",
  );
  await db.exec(await migration("009_medcall_mvp_persistence.sql"));
  await db.exec(await migration("034_platform_subscriptions.sql"));
  await db.exec(await migration("067_atomic_platform_subscription.sql"));
  await db.exec(
    `insert into public.workspaces(id,name) values('${workspaceId}','Test clinic')`,
  );
});

beforeEach(async () => {
  await db.exec("truncate public.platform_subscriptions");
});

after(async () => {
  await db.close();
});

test("subscription replacement keeps exactly one active row and preserves history", async () => {
  const first = await replace("basic", "1990000");
  const second = await replace("standard");
  assert.notEqual(first.id, second.id);

  const rows = await db.query<{
    id: string;
    plan: string;
    status: string;
    ended_at: string | null;
  }>(
    "select id,plan,status,ended_at from public.platform_subscriptions order by created_at,id",
  );
  assert.equal(rows.rows.length, 2);
  assert.deepEqual(
    rows.rows.map(({ plan, status }) => ({ plan, status })),
    [
      { plan: "basic", status: "cancelled" },
      { plan: "standard", status: "active" },
    ],
  );
  assert.ok(rows.rows[0].ended_at);
});

test("a late insert failure rolls back cancellation of the current subscription", async () => {
  const current = await replace("standard");
  await db.exec(`
    create function public.reject_pro_subscription() returns trigger language plpgsql as $$
    begin
      if new.plan = 'pro' then raise exception 'test_insert_failure'; end if;
      return new;
    end $$;
    create trigger reject_pro_subscription before insert on public.platform_subscriptions
      for each row execute function public.reject_pro_subscription();
  `);
  await assert.rejects(() => replace("pro", "7990000"), /test_insert_failure/);

  const rows = await db.query<{ id: string; plan: string; status: string }>(
    "select id,plan,status from public.platform_subscriptions",
  );
  assert.deepEqual(rows.rows, [
    { id: current.id as string, plan: "standard", status: "active" },
  ]);
  await db.exec(
    "drop trigger reject_pro_subscription on public.platform_subscriptions; drop function public.reject_pro_subscription()",
  );
});

test("invalid direct calls and browser database roles cannot replace a subscription", async () => {
  await assert.rejects(
    () => replace("unknown"),
    /platform_subscription_invalid/,
  );
  await assert.rejects(
    () => db.query("select public.replace_platform_subscription($1,$2,$3,$4,$5,$6)", [
      workspaceId,
      null,
      "3990000",
      "KZT",
      "monthly",
      null,
    ]),
    /platform_subscription_invalid/,
  );
  await assert.rejects(
    () => db.query("select public.replace_platform_subscription($1,$2,$3,$4,$5,$6)", [
      workspaceId,
      "standard",
      "3990000",
      "KZT",
      null,
      null,
    ]),
    /platform_subscription_invalid/,
  );
  assert.equal(
    (
      await db.query<{ count: number }>(
        "select count(*)::int as count from public.platform_subscriptions",
      )
    ).rows[0].count,
    0,
  );

  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    await assert.rejects(() => replace("standard"), /permission denied/);
    await db.exec("reset role");
  }
});

test("the migration serializes replacements by locking the clinic row", async () => {
  const source = await readFile(
    path.join(root, "migrations", "067_atomic_platform_subscription.sql"),
    "utf8",
  );
  assert.match(source, /from public\.workspaces[\s\S]*for update/);
  assert.match(source, /security definer[\s\S]*set search_path = ''/);
  assert.match(
    source,
    /revoke all on function public\.replace_platform_subscription[\s\S]*from public, anon, authenticated/,
  );
});

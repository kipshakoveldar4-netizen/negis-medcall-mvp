import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { buildSitePreviewBootstrap, candidateCommit, migrationFiles, testProjectRef } from './site-preview-bootstrap.mjs';

const sql = buildSitePreviewBootstrap();
const localSql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/i, '');
const setup = `create role anon; create role authenticated; create role service_role bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  create schema auth; create table auth.users(id uuid primary key);`;

test('bootstrap is pinned, guarded, atomic and excludes intake, deletion and data seeds', () => {
  assert.equal(candidateCommit, '43568ed');
  assert.ok(sql.includes(testProjectRef));
  assert.equal(migrationFiles.length, 7);
  assert.equal(sql.match(/^begin;$/gm)?.length, 1);
  assert.equal(sql.match(/^commit;$/gm)?.length, 1);
  assert.equal(sql.match(/^notify pgrst/gm)?.length, 1);
  assert.ok(sql.indexOf('preview_requires_empty_public_schema') < sql.indexOf('-- Source:'));
  assert.doesNotMatch(sql, /insert into|delete from|truncate|drop table|062_|058_|cron\.|http_post/i);
});

test('empty database installs auth/blog schema with no patients, memberships or published posts', async () => {
  const db = new PGlite();
  try {
    await db.exec(setup);
    await db.exec(localSql);
    for (const table of ['workspaces', 'staff_users', 'clients', 'leads', 'appointments', 'site_blog_posts']) {
      assert.equal((await db.query(`select count(*)::int as n from public.${table}`)).rows[0].n, 0);
    }
    assert.equal((await db.query("select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity")).rows[0].n, 0);
    for (const role of ['anon', 'authenticated']) {
      const checks = (await db.query(`select
        has_table_privilege($1, 'public.staff_users', 'select') as staff,
        has_table_privilege($1, 'public.site_blog_posts', 'select') as blog,
        has_function_privilege($1, 'public.set_site_blog_publication(uuid,uuid,integer,boolean)', 'execute') as publish`, [role])).rows[0];
      assert.deepEqual(checks, { staff: false, blog: false, publish: false });
    }
    const checks = (await db.query(`select
      has_table_privilege('service_role', 'public.staff_users', 'select') as staff,
      has_table_privilege('service_role', 'public.site_blog_posts', 'insert') as blog,
      has_function_privilege('service_role', 'public.set_site_blog_publication(uuid,uuid,integer,boolean)', 'execute') as publish`)).rows[0];
    assert.deepEqual(checks, { staff: true, blog: true, publish: true });
    await db.exec('set role anon');
    await assert.rejects(db.query('select * from public.site_blog_posts'), /permission denied/);
    await db.exec('reset role');
    await assert.rejects(db.exec(localSql), /preview_requires_empty_public_schema/);
    await db.exec('rollback');
    assert.equal((await db.query('select count(*)::int as n from public.staff_users')).rows[0].n, 0);
  } finally { await db.close(); }
});

test('existing application table aborts before migrations and preserves data', async () => {
  const db = new PGlite();
  try {
    await db.exec(setup + "create table public.keep_me(value text); insert into public.keep_me values('unchanged');");
    await assert.rejects(db.exec(localSql), /preview_requires_empty_public_schema/);
    await db.exec('rollback');
    assert.equal((await db.query('select value from public.keep_me')).rows[0].value, 'unchanged');
    assert.equal((await db.query("select to_regclass('public.site_blog_posts') as name")).rows[0].name, null);
  } finally { await db.close(); }
});

test('existing auth user aborts before migrations without changing that user', async () => {
  const db = new PGlite();
  try {
    await db.exec(setup + "insert into auth.users values('00000000-0000-4000-8000-000000000001');");
    await assert.rejects(db.exec(localSql), /preview_requires_no_auth_users/);
    await db.exec('rollback');
    assert.equal((await db.query('select count(*)::int as n from auth.users')).rows[0].n, 1);
    assert.equal((await db.query("select to_regclass('public.workspaces') as name")).rows[0].name, null);
  } finally { await db.close(); }
});

test('non-Supabase database without auth schema is refused', async () => {
  const db = new PGlite();
  try {
    await assert.rejects(db.exec(localSql), /preview_requires_supabase_auth/);
    await db.exec('rollback');
    assert.equal((await db.query("select to_regclass('public.workspaces') as name")).rows[0].name, null);
  } finally { await db.close(); }
});

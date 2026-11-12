import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { startDisposablePostgres } from './disposable-postgres.mjs';

const source = await readFile(new URL('../../migrations/015_ad_creative_assets.sql', import.meta.url), 'utf8');
const marker = 'insert into storage.buckets';
assert.equal(source.split(marker).length, 2);
const foundation = source.slice(0, source.indexOf(marker));
assert.doesNotMatch(foundation, /storage\./i);
const access = await readFile(new URL('../../migrations/082_ad_creative_assets_server_access.sql', import.meta.url), 'utf8');
const body = access.replace(/^begin;\r?$/m, '').replace(/^commit;\r?$/m, '');
assert.equal(access.length - body.length, 'begin;'.length + 'commit;'.length);
const W = '10000000-0000-4000-8000-000000000001';

async function transaction(db, callback) {
  await db.query('begin');
  try { await callback(); } finally { await db.query('rollback'); }
}
async function rejectsSql(db, sql, code) {
  await db.query('savepoint expected_failure');
  try { await assert.rejects(db.query(sql), error => error.code === code); }
  finally { await db.query('rollback to savepoint expected_failure'); }
}
async function secure(db) {
  assert.equal((await db.query("select relrowsecurity from pg_class where oid='public.ad_creative_assets'::regclass")).rows[0].relrowsecurity, true);
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await db.query("select has_table_privilege($1,'public.ad_creative_assets','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as allowed", [role])).rows[0].allowed, false);
    assert.equal((await db.query("select has_any_column_privilege($1,'public.ad_creative_assets','SELECT,INSERT,UPDATE,REFERENCES') as allowed", [role])).rows[0].allowed, false);
  }
}

test('015 table-only + 082 is atomic and server-only on disposable PostgreSQL', { timeout: 300000 }, async t => {
  const fixture = await startDisposablePostgres();
  try {
    const db = await fixture.connect();
    await db.query(`create role anon nologin nobypassrls;
      create role authenticated nologin nobypassrls;
      create role service_role nologin bypassrls;
      grant usage on schema public to anon, authenticated, service_role;
      create table public.workspaces(id uuid primary key, name text);
      create table public.meta_campaign_launches(id uuid primary key);
      create table public.unrelated(id integer primary key, note text);
      insert into public.unrelated values (1,'Fictional untouched row');
      grant select(note) on public.unrelated to authenticated;
      alter default privileges grant all on tables to anon, authenticated;`);
    await db.query('insert into public.workspaces values ($1,$2)', [W, 'Synthetic workspace']);
    const unrelated = () => db.query("select to_jsonb(t) as row, (select relacl::text from pg_class where oid='public.unrelated'::regclass) as acl from public.unrelated t");
    const before = (await unrelated()).rows;
    await t.test('missing foundation fails closed', () => transaction(db, async () => {
      await rejectsSql(db, body, 'P8201');
      assert.equal((await db.query("select to_regclass('public.ad_creative_assets') as table")).rows[0].table, null);
    }));
    await t.test('missing dependency leaves no partial table', () => transaction(db, async () => {
      await db.query('alter table public.meta_campaign_launches rename to missing_launches');
      await rejectsSql(db, foundation, '42P01');
      assert.equal((await db.query("select to_regclass('public.ad_creative_assets') as table")).rows[0].table, null);
    }));
    await t.test('service role without bypass is refused', () => transaction(db, async () => {
      await db.query(foundation);
      await db.query('alter role service_role nobypassrls');
      await rejectsSql(db, body, 'P8202');
    }));
    await t.test('foundation and protection commit together without touching Storage', async () => {
      await db.query(`begin;\n${foundation}\n${body}\ncommit;`);
      await secure(db);
      assert.equal((await db.query("select to_regnamespace('storage') as storage")).rows[0].storage, null);
    });
    await t.test('browser CRUD is denied even with permissive RLS policies', () => transaction(db, async () => {
      await db.query('create policy legacy_browser on public.ad_creative_assets for all to authenticated using (true) with check (true)');
      for (const role of ['anon', 'authenticated']) {
        await db.query(`set local role ${role}`);
        for (const sql of ['select * from public.ad_creative_assets', 'insert into public.ad_creative_assets default values',
          "update public.ad_creative_assets set status='changed'", 'delete from public.ad_creative_assets']) await rejectsSql(db, sql, '42501');
        await db.query('reset role');
      }
    }));
    await t.test('server CRUD works and workspace foreign key is enforced', () => transaction(db, async () => {
      await db.query('set local role service_role');
      const result = await db.query("insert into public.ad_creative_assets(workspace_id,file_name,file_type,mime_type,status) values($1,'synthetic.mp4','video','video/mp4','uploaded') returning id", [W]);
      const id = result.rows[0].id;
      assert.equal((await db.query('select * from public.ad_creative_assets where id=$1', [id])).rowCount, 1);
      assert.equal((await db.query("update public.ad_creative_assets set status='verified' where id=$1", [id])).rowCount, 1);
      await rejectsSql(db, "insert into public.ad_creative_assets(workspace_id) values('20000000-0000-4000-8000-000000000002')", '23503');
      assert.equal((await db.query('delete from public.ad_creative_assets where id=$1', [id])).rowCount, 1);
      await db.query('reset role');
    }));
    await t.test('legacy column grants are removed and repeats preserve fictional data', () => transaction(db, async () => {
      await db.query("insert into public.ad_creative_assets(workspace_id,file_name) values($1,'preserve.mp4')", [W]);
      const rows = (await db.query('select to_jsonb(t) as row from public.ad_creative_assets t')).rows;
      await db.query('grant select(file_name), update(status) on public.ad_creative_assets to authenticated; grant select(public_url) on public.ad_creative_assets to public');
      await db.query(body); await db.query(body); await secure(db);
      assert.deepEqual((await db.query('select to_jsonb(t) as row from public.ad_creative_assets t')).rows, rows);
    }));
    await t.test('unrelated data and permissions stayed unchanged', async () => { assert.deepEqual((await unrelated()).rows, before); });
  } finally { await fixture.close(); }
});

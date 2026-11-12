import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startDisposablePostgres } from './disposable-postgres.mjs';

const migration = await readFile(new URL('../../migrations/075_meta_account_workspace_uniqueness.sql', import.meta.url), 'utf8');
const observed = promise => promise.then(value => ({ value }), error => ({ error }));
const snapshot = async db => (await db.query('select to_jsonb(m) as item from public.meta_ad_accounts m order by id')).rows;
async function denied(promise, code) {
  const result = await observed(promise);
  assert.equal(result.error?.code, code, result.error?.message ?? 'Unexpected success');
  return result.error;
}

test('Meta binding uniqueness on disposable native PostgreSQL', { timeout: 300000 }, async t => {
  const fixture = await startDisposablePostgres();
  try {
    const db = await fixture.connect();
    await t.test('missing dependency refuses without creating anything', async () => {
      await denied(db.query(migration), 'P7502');
      await db.query('rollback');
      assert.equal((await db.query("select to_regclass('public.meta_ad_accounts') as item")).rows[0].item, null);
    });
    for (const name of ['009_medcall_mvp_persistence.sql', '010_staff_ready_crm.sql', '013_release_admin_settings.sql']) {
      await db.query(await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'));
    }
    const legacy = randomUUID(), workspace = randomUUID(), other = randomUUID();
    for (const id of [legacy, workspace, other]) await db.query('insert into public.workspaces(id,name) values($1,$2)', [id, 'Synthetic Meta binding']);
    const insert = (client, w, account = '123456789') => client.query(
      'insert into public.meta_ad_accounts(workspace_id,ad_account_id,status) values($1,$2,\'draft\') returning *', [w, account]);
    await db.query('create role anon; create role authenticated; create role service_role bypassrls;');
    await db.query('alter table public.meta_ad_accounts enable row level security; grant usage on schema public to service_role; grant select,insert,update on public.meta_ad_accounts to service_role;');
    const security = async () => (await db.query(`select relrowsecurity,
      has_table_privilege('anon','public.meta_ad_accounts','SELECT') as anon_read,
      has_table_privilege('authenticated','public.meta_ad_accounts','INSERT') as browser_write,
      has_table_privilege('service_role','public.meta_ad_accounts','INSERT') as server_write
      from pg_class where oid='public.meta_ad_accounts'::regclass`)).rows[0];
    const beforeSecurity = await security();

    await t.test('legacy simultaneous first saves really create two ambiguous rows', async () => {
      const a = await fixture.connect(), b = await fixture.connect();
      try {
        await a.query('begin'); await b.query('begin');
        for (const client of [a, b]) assert.equal((await client.query('select id from public.meta_ad_accounts where workspace_id=$1', [legacy])).rowCount, 0);
        await insert(a, legacy); await insert(b, legacy);
        await a.query('commit'); await b.query('commit');
        assert.equal((await db.query('select id from public.meta_ad_accounts where workspace_id=$1', [legacy])).rowCount, 2);
      } finally { await a.query('rollback'); await b.query('rollback'); await a.end(); await b.end(); }
    });
    await t.test('migration refuses legacy duplicates and preserves every row and permission', async () => {
      const before = await snapshot(db);
      await denied(db.query(migration), 'P7501'); await db.query('rollback');
      assert.deepEqual(await snapshot(db), before);
      assert.deepEqual(await security(), beforeSecurity);
      assert.equal((await db.query("select to_regclass('public.meta_ad_accounts_one_workspace_idx') as item")).rows[0].item, null);
    });
    // Only this test's synthetic legacy rows are removed, never by the migration.
    await db.query('delete from public.meta_ad_accounts where workspace_id=$1', [legacy]);
    await t.test('clean application and repeat preserve rows RLS and privileges', async () => {
      await insert(db, other, 'other-synthetic-account');
      const before = await snapshot(db);
      await db.query(migration); await db.query(migration);
      assert.deepEqual(await snapshot(db), before);
      assert.deepEqual(await security(), beforeSecurity);
    });
    await t.test('two empty snapshots serialize on the unique index with exactly one winner', async () => {
      const a = await fixture.connect(), b = await fixture.connect();
      try {
        await a.query('begin'); await b.query('begin');
        for (const client of [a, b]) assert.equal((await client.query('select id from public.meta_ad_accounts where workspace_id=$1', [workspace])).rowCount, 0);
        const first = (await insert(a, workspace)).rows[0];
        const pid = (await b.query('select pg_backend_pid() as id')).rows[0].id;
        const pending = observed(insert(b, workspace));
        let blocked = false;
        for (let i = 0; i < 100; i++) {
          if ((await db.query('select cardinality(pg_blocking_pids($1))>0 as blocked', [pid])).rows[0].blocked) { blocked = true; break; }
          await delay(15);
        }
        assert.equal(blocked, true, 'observe actual PostgreSQL blocking, not a timed assumption');
        await a.query('commit');
        const loser = await pending;
        assert.equal(loser.error?.code, '23505');
        assert.equal(loser.error?.constraint, 'meta_ad_accounts_one_workspace_idx');
        await b.query('rollback');
        const saved = await db.query('select * from public.meta_ad_accounts where workspace_id=$1', [workspace]);
        assert.equal(saved.rowCount, 1); assert.deepEqual(saved.rows[0], first);
        await b.query('update public.meta_ad_accounts set account_name=$1 where workspace_id=$2 and id=$3', ['Synthetic retry', workspace, first.id]);
        assert.equal((await db.query('select id from public.meta_ad_accounts where workspace_id=$1', [workspace])).rowCount, 1);
        assert.equal((await db.query('select ad_account_id from public.meta_ad_accounts where workspace_id=$1', [other])).rows[0].ad_account_id, 'other-synthetic-account');
      } finally { await a.query('rollback'); await b.query('rollback'); await a.end(); await b.end(); }
    });
    await t.test('direct service-role writes cannot bypass uniqueness or move a row over another binding', async () => {
      const before = await snapshot(db);
      await db.query('begin; set local role service_role');
      await denied(insert(db, workspace), '23505'); await db.query('rollback');
      await db.query('begin; set local role service_role');
      await denied(db.query('update public.meta_ad_accounts set workspace_id=$1 where workspace_id=$2', [workspace, other]), '23505');
      await db.query('rollback');
      assert.deepEqual(await snapshot(db), before);
      assert.deepEqual(await security(), beforeSecurity);
    });
    await t.test('an incompatible existing index name fails closed instead of being silently accepted', async () => {
      await db.query('drop index public.meta_ad_accounts_one_workspace_idx; create index meta_ad_accounts_one_workspace_idx on public.meta_ad_accounts(workspace_id)');
      const before = await snapshot(db);
      await denied(db.query(migration), 'P7503'); await db.query('rollback');
      assert.deepEqual(await snapshot(db), before);
      assert.equal((await db.query("select indisunique from pg_index where indexrelid='public.meta_ad_accounts_one_workspace_idx'::regclass")).rows[0].indisunique, false);
      assert.deepEqual(await security(), beforeSecurity);
    });
    await db.end();
  } finally { await fixture.close(); }
});

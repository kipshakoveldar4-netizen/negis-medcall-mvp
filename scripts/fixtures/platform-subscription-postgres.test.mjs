import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startDisposablePostgres } from './disposable-postgres.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const observe = promise => promise.then(value => ({ value }), error => ({ error }));
const replace = async (db, workspace, plan, note = 'synthetic manual assignment') => (
  await db.query('select public.replace_platform_subscription($1,$2,0,\'KZT\',\'monthly\',$3) as item', [workspace, plan, note])
).rows[0].item;
const pid = async db => (await db.query('select pg_backend_pid() as pid')).rows[0].pid;
async function waitForLock(observer, waiter, holder) {
  for (let i = 0; i < 250; i++) {
    const blockers = (await observer.query('select pg_blocking_pids($1) as blockers', [waiter])).rows[0].blockers;
    if (blockers.includes(holder)) return;
    await delay(15);
  }
  assert.fail('Expected a real PostgreSQL lock wait, not a timing-based concurrency assumption');
}

// This is the existing manual administrative transaction, not checkout,
// provider confirmation, paid access, or agreed commercial pricing.
test('manual subscription replacement on isolated native PostgreSQL', { timeout: 180000 }, async t => {
  const f = await startDisposablePostgres();
  try {
    const db = await f.connect();
    await db.query('create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to anon,authenticated,service_role;');
    for (const name of ['009_medcall_mvp_persistence.sql', '034_platform_subscriptions.sql', '067_atomic_platform_subscription.sql']) {
      const sql = execFileSync('git', ['show', `HEAD:migrations/${name}`], { cwd: root, windowsHide: true, encoding: 'utf8' });
      await db.query(sql);
    }
    const workspace = randomUUID(), independent = randomUUID();
    await db.query('insert into public.workspaces(id,name) values($1,\'Synthetic manual A\'),($2,\'Synthetic manual B\')', [workspace, independent]);
    const a = await f.connect(), b = await f.connect(), c = await f.connect();
    const aPid = await pid(a), bPid = await pid(b), cPid = await pid(c);

    await t.test('only the service database role can execute the manual replacement RPC', async () => {
      const signature = 'public.replace_platform_subscription(uuid,text,bigint,text,text,text)';
      const row = (await db.query(`select p.prosecdef as definer,p.proconfig as config,
        has_function_privilege('anon',p.oid,'EXECUTE') as anon,
        has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated,
        has_function_privilege('service_role',p.oid,'EXECUTE') as service
        from pg_proc p where p.oid=$1::regprocedure`, [signature])).rows[0];
      assert.deepEqual(row, { definer: true, config: ['search_path=""'], anon: false, authenticated: false, service: true });
      for (const role of ['anon', 'authenticated']) {
        await a.query(`set role ${role}`);
        const result = await observe(replace(a, workspace, 'basic'));
        assert.equal(result.error?.code, '42501');
        await a.query('reset role');
      }
      assert.equal((await db.query('select count(*)::int as n from public.platform_subscriptions')).rows[0].n, 0);
    });

    await t.test('two replacements really serialize while another workspace remains independent', async () => {
      await a.query('begin');
      await a.query('set local role service_role');
      const first = await replace(a, workspace, 'basic', 'synthetic first transaction');
      const waiting = observe(replace(b, workspace, 'standard', 'synthetic second transaction'));
      await waitForLock(db, bPid, aPid);
      assert.equal((await db.query('select count(*)::int as n from public.platform_subscriptions where workspace_id=$1', [workspace])).rows[0].n, 0,
        'an uncommitted administrative assignment must not become visible');
      const other = await replace(c, independent, 'basic', 'synthetic independent workspace');
      assert.equal(other.workspace_id, independent);
      assert.equal(other.price_minor, 0);
      await a.query('commit');
      const secondResult = await waiting;
      assert.equal(secondResult.error, undefined);
      const second = secondResult.value;
      assert.notEqual(first.id, second.id);
      const rows = (await db.query('select id,plan,status,price_minor,currency,ended_at from public.platform_subscriptions where workspace_id=$1 order by created_at,id', [workspace])).rows;
      assert.equal(rows.length, 2);
      assert.equal(rows.find(row => row.id === first.id).status, 'cancelled');
      assert.ok(rows.find(row => row.id === first.id).ended_at);
      assert.equal(rows.find(row => row.id === second.id).status, 'active');
      assert.equal(rows.filter(row => row.status === 'active').length, 1);
      assert.ok(rows.every(row => row.price_minor === '0' && row.currency === 'KZT'));
      assert.deepEqual((await db.query('select id,status from public.platform_subscriptions where workspace_id=$1', [independent])).rows,
        [{ id: other.id, status: 'active' }]);
    });

    await t.test('failure after cancellation rolls back before the waiting replacement commits', async () => {
      const current = (await db.query("select id from public.platform_subscriptions where workspace_id=$1 and status='active'", [workspace])).rows[0].id;
      await db.query(`create function public.synthetic_subscription_insert_gate() returns trigger language plpgsql as $$
        begin
          if new.note='synthetic fail after cancellation' then
            perform pg_advisory_xact_lock(671901);
            raise exception using errcode='P9901',message='synthetic_insert_failure';
          end if;
          return new;
        end; $$;
        create trigger synthetic_subscription_insert_gate before insert on public.platform_subscriptions
          for each row execute function public.synthetic_subscription_insert_gate();`);
      await c.query('begin');
      await c.query('select pg_advisory_xact_lock(671901)');
      await a.query('begin');
      const failing = observe(replace(a, workspace, 'pro', 'synthetic fail after cancellation'));
      await waitForLock(db, aPid, cPid);
      const waiting = observe(replace(b, workspace, 'basic', 'synthetic valid waiter'));
      await waitForLock(db, bPid, aPid);
      assert.deepEqual((await db.query("select id from public.platform_subscriptions where workspace_id=$1 and status='active'", [workspace])).rows,
        [{ id: current }], 'observers must still see the prior committed assignment during the failing transaction');
      await c.query('commit');
      assert.equal((await failing).error?.code, 'P9901');
      await a.query('rollback');
      const next = await waiting;
      assert.equal(next.error, undefined);
      const rows = (await db.query('select id,status,note from public.platform_subscriptions where workspace_id=$1', [workspace])).rows;
      assert.equal(rows.length, 3, 'the failed insert must leave no history row');
      assert.equal(rows.find(row => row.id === current).status, 'cancelled');
      assert.deepEqual(rows.filter(row => row.status === 'active').map(row => row.id), [next.value.id]);
      assert.ok(rows.every(row => row.note !== 'synthetic fail after cancellation'));
      await db.query('drop trigger synthetic_subscription_insert_gate on public.platform_subscriptions; drop function public.synthetic_subscription_insert_gate()');
    });

    await t.test('invalid replacement leaves the committed state byte-for-byte unchanged', async () => {
      const before = (await db.query('select to_jsonb(s) as item from public.platform_subscriptions s order by id')).rows;
      const result = await observe(replace(a, workspace, 'unknown', 'synthetic rejected input'));
      assert.match(result.error?.message || '', /platform_subscription_invalid/);
      assert.deepEqual((await db.query('select to_jsonb(s) as item from public.platform_subscriptions s order by id')).rows, before);
    });
    t.diagnostic('Only synthetic manual administrative records with 0 KZT; no payment/provider/network or real entitlement confirmation');
  } finally {
    await f.close();
  }
});

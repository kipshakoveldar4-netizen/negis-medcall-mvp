import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startNativePostgres } from './native-postgres.mjs';

const migration = await readFile(new URL('../../migrations/051_content_generation_usage.sql', import.meta.url), 'utf8');
const repair = await readFile(new URL('../../migrations/081_content_usage_reservation_column_scope.sql', import.meta.url), 'utf8');
const observed = promise => promise.then(value => ({ value }), error => ({ error }));
const reservationSql = 'select * from public.reserve_content_generation_usage($1,$2,$3,$4,$5,$6,$7,$8,$9)';
const completionSql = 'select public.complete_content_generation_usage($1,$2,$3,$4,null,null) as completed';

test('Content usage quotas on disposable native PostgreSQL, no provider calls', { timeout: 300000 }, async t => {
  const fixture = await startNativePostgres();
  try {
    const db = await fixture.connect();
    await t.test('repair refuses missing foundation without creating objects', async () => {
      assert.equal((await observed(db.query(repair))).error?.code, 'P8101');
      await db.query('rollback');
      assert.equal((await db.query("select to_regclass('public.content_generation_usage') as item")).rows[0].item, null);
    });
    // Only the two referenced identity tables are synthetic; quota SQL is the
    // unchanged production migration, executed in this invocation's fresh DB.
    await db.query(`create role anon; create role authenticated; create role service_role bypassrls;
      create table public.workspaces(id uuid primary key);
      create table public.staff_users(id uuid primary key);
      grant usage on schema public to anon,authenticated,service_role;`);
    await db.query(migration);
    const staff = randomUUID();
    await db.query('insert into public.staff_users(id) values($1)', [staff]);
    const workspace = async () => {
      const id = randomUUID();
      await db.query('insert into public.workspaces(id) values($1)', [id]);
      return id;
    };
    const reserve = (client, w, key = randomUUID(), units = 1, limit = 1, kind = 'image') => client.query(
      reservationSql, [w, staff, key, kind === 'image' ? 'generated_image' : kind === 'video_seconds' ? 'generated_video' : 'content_package', kind, units, limit, 'synthetic-provider', 'synthetic-model']);
    const complete = (client, w, id, status, error = null) => client.query(completionSql, [w, id, status, error]);
    const rows = async w => (await db.query('select * from public.content_generation_usage where workspace_id=$1 order by id', [w])).rows;
    const blockedBy = async (pid, blocker) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await db.query('select $2::integer=any(pg_blocking_pids($1)) as blocked', [pid, blocker])).rows[0].blocked) return;
        await delay(15);
      }
      assert.fail('Expected a real PostgreSQL blocker, not a timed overlap');
    };
    const concurrent = async scenario => {
      const a = await fixture.connect(), b = await fixture.connect();
      try {
        const apid = (await a.query('select pg_backend_pid() as pid')).rows[0].pid;
        const bpid = (await b.query('select pg_backend_pid() as pid')).rows[0].pid;
        assert.equal(new Set([apid, bpid, (await db.query('select pg_backend_pid() as pid')).rows[0].pid]).size, 3);
        await a.query('begin'); await b.query('begin');
        await scenario(a, b, apid, bpid);
      } finally {
        await a.query('rollback'); await b.query('rollback');
        await a.end(); await b.end();
      }
    };

    await t.test('unmodified 051 reproduces ambiguous period_start before any receipt', async () => {
      const w = await workspace();
      const result = await observed(reserve(db, w));
      assert.equal(result.error?.code, '42702');
      assert.match(result.error?.message ?? '', /period_start.*ambiguous/);
      assert.equal((await rows(w)).length, 0);
    });
    await t.test('081 is repeatable and preserves existing receipts, RLS and grants', async () => {
      const w = await workspace();
      await db.query(`insert into public.content_generation_usage(workspace_id,staff_user_id,request_key,
        operation,kind,units,period_start) values($1,$2,$3,'generated_image','image',1,date_trunc('month',now() at time zone 'UTC')::date)`, [w, staff, randomUUID()]);
      const before = await rows(w);
      const security = async () => (await db.query(`select relrowsecurity,
        has_table_privilege('anon','public.content_generation_usage','SELECT') as anon_read,
        has_function_privilege('authenticated','public.reserve_content_generation_usage(uuid,uuid,uuid,text,text,integer,integer,text,text)','EXECUTE') as browser_execute,
        has_function_privilege('service_role','public.reserve_content_generation_usage(uuid,uuid,uuid,text,text,integer,integer,text,text)','EXECUTE') as server_execute
        from pg_class where oid='public.content_generation_usage'::regclass`)).rows[0];
      const beforeSecurity = await security();
      await db.query(repair); await db.query(repair);
      assert.deepEqual(await rows(w), before);
      assert.deepEqual(await security(), beforeSecurity);
      assert.equal(beforeSecurity.server_execute, true);
      assert.equal(beforeSecurity.browser_execute, false);
    });

    await t.test('last available unit permits exactly one concurrent different-key reservation', async () => {
      const w = await workspace();
      await concurrent(async (a, b, apid, bpid) => {
        const first = (await reserve(a, w)).rows[0];
        assert.equal(first.allowed, true);
        const pending = observed(reserve(b, w));
        await blockedBy(bpid, apid);
        await a.query('commit');
        const second = await pending;
        assert.ifError(second.error);
        assert.equal(second.value.rows[0].allowed, false);
        assert.equal(second.value.rows[0].duplicate, false);
        assert.equal(second.value.rows[0].remaining_units, '0');
        await b.query('commit');
      });
      assert.equal((await rows(w)).length, 1);
    });
    await t.test('same request key has one receipt and denies a second provider attempt', async () => {
      const w = await workspace(), key = randomUUID();
      await concurrent(async (a, b, apid, bpid) => {
        const first = (await reserve(a, w, key, 1, 3)).rows[0];
        const pending = observed(reserve(b, w, key, 1, 3));
        await blockedBy(bpid, apid); await a.query('commit');
        const second = await pending;
        assert.ifError(second.error);
        assert.equal(second.value.rows[0].allowed, false);
        assert.equal(second.value.rows[0].duplicate, true);
        assert.equal(second.value.rows[0].usage_id, first.usage_id);
        await b.query('commit');
      });
      assert.equal((await rows(w)).length, 1);
    });
    await t.test('rollback of first reservation lets the blocked caller reserve the unit', async () => {
      const w = await workspace();
      await concurrent(async (a, b, apid, bpid) => {
        await reserve(a, w);
        const pending = observed(reserve(b, w));
        await blockedBy(bpid, apid); await a.query('rollback');
        const second = await pending;
        assert.ifError(second.error); assert.equal(second.value.rows[0].allowed, true);
        await b.query('commit');
      });
      assert.equal((await rows(w)).length, 1);
    });
    await t.test('lock timeout never creates an unaccounted second reservation', async () => {
      const w = await workspace();
      await concurrent(async (a, b, apid, bpid) => {
        await reserve(a, w); await b.query("set local lock_timeout='800ms'");
        const pending = observed(reserve(b, w));
        await blockedBy(bpid, apid);
        assert.equal((await pending).error?.code, '55P03');
        await b.query('rollback'); await a.query('commit');
      });
      assert.equal((await rows(w)).length, 1);
    });
    await t.test('same key in a different workspace is independent', async () => {
      const w1 = await workspace(), w2 = await workspace(), key = randomUUID();
      await concurrent(async (a, b) => {
        const first = (await reserve(a, w1, key)).rows[0];
        await b.query("set local lock_timeout='800ms'");
        const second = (await reserve(b, w2, key)).rows[0];
        assert.equal(first.allowed, true); assert.equal(second.allowed, true);
        assert.notEqual(first.usage_id, second.usage_id);
        await a.query('commit'); await b.query('commit');
      });
    });
    await t.test('different media kinds have independent quota locks', async () => {
      const w = await workspace();
      await concurrent(async (a, b) => {
        await reserve(a, w);
        await b.query("set local lock_timeout='800ms'");
        assert.equal((await reserve(b, w, randomUUID(), 8, 8, 'video_seconds')).rows[0].allowed, true);
        await a.query('commit'); await b.query('commit');
      });
      assert.equal((await rows(w)).length, 2);
    });
    await t.test('same key across different media kinds still cannot create two receipts', async () => {
      const w = await workspace(), key = randomUUID();
      await concurrent(async (a, b, apid, bpid) => {
        await reserve(a, w, key, 1, 2);
        const pending = observed(reserve(b, w, key, 8, 16, 'video_seconds'));
        await blockedBy(bpid, apid); await a.query('commit');
        assert.equal((await pending).error?.code, '23505');
        await b.query('rollback');
      });
      assert.equal((await rows(w)).length, 1);
    });
    await t.test('unknown and successful outcomes consume quota, known rejection frees quota', async () => {
      for (const [status, error, reusable] of [
        ['unknown', 'request_unknown', false], ['succeeded', null, false], ['failed', 'provider_rejected', true],
      ]) {
        const w = await workspace();
        const first = (await reserve(db, w)).rows[0];
        assert.equal((await complete(db, w, first.usage_id, status, error)).rows[0].completed, true);
        assert.equal((await reserve(db, w)).rows[0].allowed, reusable);
        assert.equal((await reserve(db, w, (await rows(w))[0].request_key)).rows[0].allowed, false);
      }
    });
    await t.test('completion is first-terminal-wins under concurrent callbacks', async () => {
      const w = await workspace(), receipt = (await reserve(db, w)).rows[0];
      await concurrent(async (a, b, apid, bpid) => {
        assert.equal((await complete(a, w, receipt.usage_id, 'succeeded')).rows[0].completed, true);
        const pending = observed(complete(b, w, receipt.usage_id, 'failed', 'provider_rejected'));
        await blockedBy(bpid, apid); await a.query('commit');
        const second = await pending;
        assert.ifError(second.error); assert.equal(second.value.rows[0].completed, false);
        await b.query('commit');
      });
      assert.equal((await rows(w))[0].status, 'succeeded');
      assert.equal((await reserve(db, w)).rows[0].allowed, false);
    });
    await t.test('another workspace cannot complete a receipt', async () => {
      const w = await workspace(), other = await workspace(), receipt = (await reserve(db, w)).rows[0];
      assert.equal((await complete(db, other, receipt.usage_id, 'failed', 'provider_rejected')).rows[0].completed, false);
      assert.equal((await rows(w))[0].status, 'reserved');
    });
    await t.test('previous UTC month is not charged to the current period', async () => {
      const w = await workspace(), receipt = (await reserve(db, w)).rows[0];
      await db.query("update public.content_generation_usage set period_start=(period_start-interval '1 month')::date where id=$1", [receipt.usage_id]);
      const current = (await reserve(db, w)).rows[0];
      assert.equal(current.allowed, true); assert.equal(current.used_units, '1');
      assert.equal((await reserve(db, w)).rows[0].allowed, false);
    });
    await t.test('zero quota denies media, null quota preserves existing text accounting', async () => {
      const w = await workspace();
      assert.equal((await reserve(db, w, randomUUID(), 1, 0)).rows[0].allowed, false);
      assert.equal((await reserve(db, w, randomUUID(), 1, null, 'text_request')).rows[0].allowed, true);
      assert.equal((await reserve(db, w, randomUUID(), 1, null, 'text_request')).rows[0].allowed, true);
    });
    await t.test('SQL enforces bounded positive units and known operations', async () => {
      const w = await workspace();
      for (const [units, limit] of [[0, 1], [-1, 1], [3601, 4000], [1, -1]]) {
        assert.equal((await observed(reserve(db, w, randomUUID(), units, limit))).error?.code, 'P0001');
      }
      assert.equal((await rows(w)).length, 0);
    });
    await t.test('anonymous and browser roles cannot read receipts or execute reservation RPC', async () => {
      for (const role of ['anon', 'authenticated']) {
        await db.query(`begin; set local role ${role}`);
        assert.equal((await observed(db.query('select * from public.content_generation_usage'))).error?.code, '42501');
        await db.query('rollback');
        await db.query(`begin; set local role ${role}`);
        assert.equal((await observed(reserve(db, randomUUID()))).error?.code, '42501');
        await db.query('rollback');
      }
      const security = (await db.query("select relrowsecurity from pg_class where oid='public.content_generation_usage'::regclass")).rows[0];
      assert.equal(security.relrowsecurity, true);
    });
    await db.end();
  } finally { await fixture.close(); }
});

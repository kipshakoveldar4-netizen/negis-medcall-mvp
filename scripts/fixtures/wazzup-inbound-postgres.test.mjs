import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startDisposablePostgres } from './disposable-postgres.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const phone = '+12025550123';
const row = async (client, sql, params = []) => (await client.query(sql, params)).rows[0];
const observed = promise => promise.then(value => ({ value }), error => ({ error }));
const none = { leads: 0, receipts: 0 };
const one = { leads: 1, receipts: 1 };

async function completed(pending) {
  const outcome = await pending;
  if (outcome.error) throw outcome.error;
  return outcome.value;
}

async function addChannel(observer, workspace) {
  const channel = randomUUID();
  await observer.query(`insert into public.wazzup_channels
    (id, workspace_id, channel_id, enabled, atomic_inbound) values ($1, $2, $3, true, true)`,
  [randomUUID(), workspace, channel]);
  return channel;
}

async function makeMapping(observer) {
  const workspace = randomUUID();
  await observer.query("insert into public.workspaces(id, name) values ($1, 'Disposable Wazzup fixture')", [workspace]);
  return { workspace, channel: await addChannel(observer, workspace) };
}

const advisoryKey = async (observer, key) => (await row(observer,
  'select pg_catalog.hashtextextended($1, 0)::text as key', [key])).key;

async function waitForBlocking(observer, t, blocker, waiter, type, key = null) {
  const expectedKey = key === null ? null : await advisoryKey(observer, key);
  const until = Date.now() + 4000;
  let state;
  while (Date.now() < until) {
    state = await row(observer, `select a.state, a.wait_event_type, a.wait_event,
      pg_catalog.pg_blocking_pids(a.pid) as blockers,
      coalesce((select json_agg(json_build_object('type', l.locktype,
        'key', ((l.classid::bigint << 32) | l.objid::bigint)::text))
        from pg_catalog.pg_locks l where l.pid = a.pid and not l.granted), '[]'::json) as waiting_locks
      from pg_catalog.pg_stat_activity a where a.pid = $1`, [waiter]);
    if (state?.wait_event_type === 'Lock' && state.blockers.includes(blocker)
      && state.waiting_locks.some(lock => lock.type === type && (expectedKey === null || lock.key === expectedKey))) {
      t.diagnostic(`Observed backend ${waiter} blocked by ${blocker}: ${type}/${state.wait_event}`);
      return;
    }
    await delay(15);
  }
  assert.fail(`Expected real ${type} lock blocking, not elapsed time alone: ${JSON.stringify(state)}`);
}

async function makeCase(fixture, observer, t) {
  const clients = [];
  t.after(async () => {
    // Release the holder first, including when an assertion fails with a waiter in flight.
    for (const client of clients) {
      try { await client.query('rollback'); }
      catch { /* A timed-out/disconnected transaction may already be gone. */ }
      finally { await client.end(); }
    }
  });
  for (let i = 0; i < 2; i++) {
    const client = await fixture.connect();
    clients.push(client);
    await client.query("set statement_timeout = '8s'; set lock_timeout = '6s'; set role service_role");
  }
  const [a, b] = clients;
  const aPid = (await row(a, 'select pg_backend_pid() as pid')).pid;
  const bPid = (await row(b, 'select pg_backend_pid() as pid')).pid;
  const observerPid = (await row(observer, 'select pg_backend_pid() as pid')).pid;
  assert.equal(new Set([aPid, bPid, observerPid]).size, 3, 'Requires three distinct PostgreSQL backends');
  const mapping = await makeMapping(observer);
  const inbound = async (client, message, channel = mapping.channel) => (await row(client,
    'select public.process_wazzup_inbound_message($1, $2, $3, $4, $5) as result',
    [channel, message, phone, 'Synthetic contact', 'Disposable inbound message'])).result;
  const counts = (workspace = mapping.workspace) => row(observer, `select
    (select count(*)::int from public.leads where workspace_id = $1) as leads,
    (select count(*)::int from public.wazzup_inbound_messages where workspace_id = $1) as receipts`, [workspace]);
  const receipts = async (client = observer, workspace = mapping.workspace) => (await client.query(`select
    message_id, channel_id, workspace_id, lead_id, kind from public.wazzup_inbound_messages
    where workspace_id = $1 order by kind, message_id`, [workspace])).rows;
  return { ...mapping, a, b, aPid, bPid, inbound, counts, receipts,
    blocked: (type, key) => waitForBlocking(observer, t, aPid, bPid, type, key) };
}

async function assertReceipts(observer, f, expected, workspace = f.workspace) {
  const leads = (await observer.query('select id, phone_normalized from public.leads where workspace_id = $1', [workspace])).rows;
  assert.equal(leads.length, 1);
  assert.equal(leads[0].phone_normalized, phone);
  assert.deepEqual(await f.receipts(observer, workspace), expected.map(receipt => ({
    message_id: receipt.message, channel_id: receipt.channel, workspace_id: workspace,
    lead_id: leads[0].id, kind: receipt.kind,
  })).sort((a, b) => a.kind.localeCompare(b.kind) || a.message_id.localeCompare(b.message_id)));
  return leads[0].id;
}

// Native opt-in is mandatory: never use Docker, DATABASE_URL, or a downloaded runtime here.
test('atomic Wazzup inbound contention on native disposable PostgreSQL', { timeout: 300000 }, async t => {
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE, '1', 'Set MEDINA_TEST_POSTGRES_NATIVE=1 to use the preinstalled native runtime');
  const fixture = await startDisposablePostgres();
  t.after(() => fixture.close());
  const observer = await fixture.connect();
  await observer.query('create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to service_role;');
  for (const file of [
    '009_medcall_mvp_persistence.sql', '010_staff_ready_crm.sql', '011_staff_auth_foundation.sql',
    '012_appointments_calendar_fields.sql', '013_release_admin_settings.sql', '014_meta_ad_launches.sql',
    '019_crm_lead_pipeline_foundation.sql', '023_public_privilege_hardening.sql',
    '026_wazzup_channels.sql', '028_leads_phone_normalized.sql', '071_atomic_wazzup_inbound.sql',
  ]) {
    await observer.query(await readFile(path.join(root, 'migrations', file), 'utf8'));
  }
  t.diagnostic(`Native PostgreSQL ${(await row(observer, 'show server_version')).server_version}; actual migrations, distinct backends, synthetic records only`);

  await t.test('same message waits for commit, then is ignored with one lead and receipt', { timeout: 25000 }, async t => {
    const f = await makeCase(fixture, observer, t);
    const message = randomUUID();
    await f.a.query('begin');
    assert.equal(await f.inbound(f.a, message), 'created');
    const pending = observed(f.inbound(f.b, message));
    await f.blocked('advisory', `wazzup-message:${message}`);
    assert.deepEqual(await f.counts(), none);
    await f.a.query('commit');
    assert.equal(await completed(pending), 'ignored');
    assert.deepEqual(await f.counts(), one);
    await assertReceipts(observer, f, [{ message, channel: f.channel, kind: 'created' }]);
  });

  await t.test('different messages and channels for one workspace/phone wait, then return created/repeat', { timeout: 25000 }, async t => {
    const f = await makeCase(fixture, observer, t);
    const otherChannel = await addChannel(observer, f.workspace);
    const first = randomUUID(), second = randomUUID();
    await f.a.query('begin');
    assert.equal(await f.inbound(f.a, first), 'created');
    const pending = observed(f.inbound(f.b, second, otherChannel));
    await f.blocked('advisory', `wazzup-phone:${f.workspace}:${phone}`);
    assert.deepEqual(await f.counts(), none);
    await f.a.query('commit');
    assert.equal(await completed(pending), 'repeat');
    assert.deepEqual(await f.counts(), { leads: 1, receipts: 2 });
    await assertReceipts(observer, f, [
      { message: first, channel: f.channel, kind: 'created' },
      { message: second, channel: otherChannel, kind: 'repeat' },
    ]);
  });

  await t.test('rollback lets the waiting same-message retry create exactly once', { timeout: 25000 }, async t => {
    const f = await makeCase(fixture, observer, t);
    const message = randomUUID();
    await f.a.query('begin');
    assert.equal(await f.inbound(f.a, message), 'created');
    const rolledBackLead = (await f.receipts(f.a))[0].lead_id;
    const pending = observed(f.inbound(f.b, message));
    await f.blocked('advisory', `wazzup-message:${message}`);
    assert.deepEqual(await f.counts(), none);
    await f.a.query('rollback');
    assert.equal(await completed(pending), 'created');
    assert.equal(await f.inbound(f.b, message), 'ignored');
    assert.deepEqual(await f.counts(), one);
    const committedLead = await assertReceipts(observer, f, [{ message, channel: f.channel, kind: 'created' }]);
    assert.notEqual(committedLead, rolledBackLead);
    assert.equal((await row(observer, 'select count(*)::int as count from public.leads where id = $1', [rolledBackLead])).count, 0);
  });

  await t.test('the same phone in different workspaces holds independent locks and creates independent leads', { timeout: 25000 }, async t => {
    const f = await makeCase(fixture, observer, t);
    const other = await makeMapping(observer);
    const first = randomUUID(), second = randomUUID();
    await f.a.query('begin');
    assert.equal(await f.inbound(f.a, first), 'created');
    await f.b.query("begin; set local statement_timeout = '2500ms'; set local lock_timeout = '2000ms'");
    assert.equal(await f.inbound(f.b, second, other.channel), 'created');

    // Both transactions must own their distinct phone locks at the same instant.
    const phoneKeys = [];
    for (const [pid, workspace] of [[f.aPid, f.workspace], [f.bPid, other.workspace]]) {
      const key = await advisoryKey(observer, `wazzup-phone:${workspace}:${phone}`);
      phoneKeys.push(key);
      const locks = (await observer.query(`select ((classid::bigint << 32) | objid::bigint)::text as key
        from pg_catalog.pg_locks where pid = $1 and locktype = 'advisory' and granted and objsubid = 1`, [pid])).rows;
      assert.ok(locks.some(lock => lock.key === key), 'Each backend must hold its workspace-scoped phone lock');
      assert.deepEqual(await row(observer, `select state, pg_catalog.pg_blocking_pids(pid) as blockers
        from pg_catalog.pg_stat_activity where pid = $1`, [pid]), { state: 'idle in transaction', blockers: [] });
    }
    assert.notEqual(phoneKeys[0], phoneKeys[1]);
    t.diagnostic('Observed both backends holding distinct workspace/phone advisory locks concurrently');
    assert.deepEqual(await f.counts(), none);
    assert.deepEqual(await f.counts(other.workspace), none);
    await f.b.query('commit');
    assert.deepEqual(await f.counts(other.workspace), one);
    assert.deepEqual(await f.counts(), none);
    const otherLead = await assertReceipts(observer, f,
      [{ message: second, channel: other.channel, kind: 'created' }], other.workspace);
    await f.a.query('commit');
    assert.deepEqual(await f.counts(), one);
    assert.deepEqual(await f.counts(other.workspace), one);
    const firstLead = await assertReceipts(observer, f, [{ message: first, channel: f.channel, kind: 'created' }]);
    assert.notEqual(firstLead, otherLead);
  });

  for (const flag of ['enabled', 'atomic_inbound']) {
    await t.test(`a held mapping row lock makes intake wait and ignore committed ${flag}=false`, { timeout: 25000 }, async t => {
      const f = await makeCase(fixture, observer, t);
      const message = randomUUID();
      await f.a.query('begin');
      await f.a.query('select id from public.wazzup_channels where channel_id = $1 for update', [f.channel]);
      const pending = observed(f.inbound(f.b, message));
      await f.blocked('transactionid');
      // Change the mapping only after observing the RPC blocked on its locked row.
      assert.equal((await f.a.query(`update public.wazzup_channels set ${flag} = false where channel_id = $1`, [f.channel])).rowCount, 1);
      assert.deepEqual(await f.counts(), none);
      assert.deepEqual(await row(observer, `select enabled, atomic_inbound from public.wazzup_channels where channel_id = $1`,
        [f.channel]), { enabled: true, atomic_inbound: true });
      await f.a.query('commit');
      assert.equal(await completed(pending), 'ignored');
      assert.deepEqual(await f.counts(), none);
      assert.equal((await row(observer, `select ${flag} as active from public.wazzup_channels where channel_id = $1`, [f.channel])).active, false);
      assert.equal(await f.inbound(f.b, message), 'ignored');
      assert.deepEqual(await f.counts(), none);
    });
  }
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startDisposablePostgres } from './disposable-postgres.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const row = async (client, sql, params = []) => (await client.query(sql, params)).rows[0];
const observed = promise => promise.then(value => ({ value }), error => ({ error }));

async function makeCase(fixture, observer, t, key = randomUUID()) {
  const a = await fixture.connect(); const b = await fixture.connect();
  t.after(async () => {
    await a.query('rollback').catch(() => {}); await b.query('rollback').catch(() => {});
    await a.end(); await b.end();
  });
  const aPid = (await row(a, 'select pg_backend_pid() as pid')).pid;
  const bPid = (await row(b, 'select pg_backend_pid() as pid')).pid;
  const observerPid = (await row(observer, 'select pg_backend_pid() as pid')).pid;
  assert.equal(new Set([aPid, bPid, observerPid]).size, 3, 'Contention requires three distinct PostgreSQL backends');
  const workspace = randomUUID(), staff = randomUUID(), doctor = randomUUID();
  await observer.query("insert into workspaces(id,name,arrival_marks_paid) values($1,'Disposable booking fixture',true)", [workspace]);
  await observer.query(`insert into staff_users(id,workspace_id,full_name,email,role)
    values($1,$2,'Fixture owner','fixture@example.invalid','owner')`, [staff, workspace]);
  await observer.query(`insert into clinic_doctors(id,workspace_id,staff_user_id,full_name,capacity)
    values($1,$2,$3,'Fixture doctor',2)`, [doctor, workspace, staff]);
  const create = async (client, clientId, fingerprint = 'a'.repeat(64)) => (await row(client,
    'select public.create_crm_appointment_once($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) as result',
    [workspace, staff, key, fingerprint,
      { id: clientId, workspace_id: workspace, full_name: 'Fixture client', status: 'new' },
      { workspace_id: workspace, client_id: clientId, created_by_staff_user_id: staff,
        client_name: 'Fixture client', doctor_id: doctor, doctor_name: 'Fixture doctor',
        starts_at: '2026-10-03T09:00:00Z', duration_minutes: 60, status: 'arrived',
        service: 'Fixture service', price_minor: 123450 }, 'created'])).result;
  const counts = () => row(observer, `select
    (select count(*)::int from clients where workspace_id=$1) as clients,
    (select count(*)::int from appointments where workspace_id=$1) as appointments,
    (select count(*)::int from deals where workspace_id=$1) as deals,
    (select count(*)::int from crm_appointment_create_requests where workspace_id=$1) as receipts`, [workspace]);
  const blocked = async () => {
    const until = Date.now() + 2500;
    while (Date.now() < until) {
      if ((await row(observer, 'select $1::int = any(pg_blocking_pids($2::int)) as blocked', [aPid, bPid])).blocked) return;
      await delay(15);
    }
    assert.fail('Database lock wait was not observed; elapsed time alone does not prove serialization');
  };
  return { a, b, create, counts, blocked };
}

// Never falls back to DATABASE_URL or skips when the explicitly selected local runtime is absent.
test('appointment request contention on disposable PostgreSQL', { timeout: 300000 }, async t => {
  const fixture = await startDisposablePostgres();
  t.after(() => fixture.close());
  const observer = await fixture.connect();
  await observer.query('create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to service_role;');
  const numbers = new Set([9, 10, 11, 12, 13, 14, 19, 20, 29, 30, 32, 33, 34, 36, 40, 43, 45, 52, 53, 54, 55, 56, 57, 61, 63, 64, 72, 73]);
  for (const file of (await readdir(path.join(root, 'migrations'))).sort()) {
    if (numbers.has(Number(file.slice(0, 3)))) await observer.query(await readFile(path.join(root, 'migrations', file), 'utf8'));
  }
  const version = await row(observer, 'show server_version');
  t.diagnostic(`Disposable PostgreSQL ${version.server_version}; real migrations, distinct backend connections, synthetic records only`);
  const one = { clients: 1, appointments: 1, deals: 1, receipts: 1 };
  const none = { clients: 0, appointments: 0, deals: 0, receipts: 0 };

  await t.test('same key waits for commit then returns the first visit without a second client or sale', async t => {
    const f = await makeCase(fixture, observer, t);
    await f.a.query('begin; set local role service_role');
    const first = await f.create(f.a, randomUUID());
    assert.equal(first.replayed, false);
    await f.b.query('set role service_role');
    const pending = observed(f.create(f.b, randomUUID()));
    await f.blocked();
    assert.deepEqual(await f.counts(), none);
    await f.a.query('commit');
    const second = (await pending).value;
    assert.ok(second); assert.equal(second.replayed, true);
    assert.equal(second.appointment.id, first.appointment.id);
    assert.equal(second.appointment.client_id, first.appointment.client_id);
    assert.deepEqual(await f.counts(), one);
  });

  await t.test('same key with changed fingerprint waits then refuses without mutation', async t => {
    const f = await makeCase(fixture, observer, t);
    await f.a.query('begin; set local role service_role'); await f.create(f.a, randomUUID());
    await f.b.query('set role service_role');
    const pending = observed(f.create(f.b, randomUUID(), 'b'.repeat(64)));
    await f.blocked();
    assert.deepEqual(await f.counts(), none);
    await f.a.query('commit');
    assert.equal((await pending).error?.code, 'P6402');
    assert.deepEqual(await f.counts(), one);
  });

  await t.test('rollback releases the key and lets the waiting request become the first commit', async t => {
    const f = await makeCase(fixture, observer, t);
    const retryClient = randomUUID();
    await f.a.query('begin; set local role service_role'); await f.create(f.a, randomUUID());
    await f.b.query('set role service_role');
    const pending = observed(f.create(f.b, retryClient));
    await f.blocked();
    assert.deepEqual(await f.counts(), none);
    await f.a.query('rollback');
    const second = (await pending).value;
    assert.ok(second); assert.equal(second.replayed, false);
    assert.equal(second.appointment.client_id, retryClient);
    assert.deepEqual(await f.counts(), one);
  });

  await t.test('a waiting retry times out without writes and then replays the committed visit', async t => {
    const f = await makeCase(fixture, observer, t);
    await f.a.query('begin; set local role service_role');
    const first = await f.create(f.a, randomUUID());
    await f.b.query("set role service_role; set lock_timeout='300ms'");
    const pending = observed(f.create(f.b, randomUUID()));
    await f.blocked();
    assert.equal((await pending).error?.code, '55P03');
    assert.deepEqual(await f.counts(), none);
    await f.a.query('commit');
    const replay = await f.create(f.b, randomUUID());
    assert.equal(replay.replayed, true);
    assert.equal(replay.appointment.id, first.appointment.id);
    assert.deepEqual(await f.counts(), one);
  });

  await t.test('an identical request key in another workspace does not wait or replay across tenants', async t => {
    const key = randomUUID();
    const first = await makeCase(fixture, observer, t, key);
    const other = await makeCase(fixture, observer, t, key);
    await first.a.query('begin; set local role service_role');
    const firstVisit = await first.create(first.a, randomUUID());
    await other.b.query("set role service_role; set statement_timeout='1500ms'");
    const otherVisit = await other.create(other.b, randomUUID());
    assert.equal(otherVisit.replayed, false);
    assert.notEqual(otherVisit.appointment.id, firstVisit.appointment.id);
    assert.notEqual(otherVisit.appointment.workspace_id, firstVisit.appointment.workspace_id);
    assert.deepEqual(await first.counts(), none);
    assert.deepEqual(await other.counts(), one);
    await first.a.query('commit');
    assert.deepEqual(await first.counts(), one);
  });
});

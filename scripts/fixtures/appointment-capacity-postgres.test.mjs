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

test('different appointment request keys cannot exceed a shared doctor capacity', { timeout: 300000 }, async t => {
  const fixture = await startDisposablePostgres();
  let a, b;
  t.after(async () => {
    await a?.query('rollback').catch(() => {});
    await b?.query('rollback').catch(() => {});
    await fixture.close();
    t.diagnostic('Disposable server stopped and its owned run directory removed');
  });
  const observer = await fixture.connect();
  await observer.query('create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to service_role;');
  const numbers = new Set([9, 10, 11, 12, 13, 14, 19, 20, 29, 30, 32, 33, 34, 36, 40, 43, 45, 55, 61, 63, 64]);
  for (const file of (await readdir(path.join(root, 'migrations'))).sort()) {
    if (numbers.has(Number(file.slice(0, 3)))) await observer.query(await readFile(path.join(root, 'migrations', file), 'utf8'));
  }
  a = await fixture.connect(); b = await fixture.connect();
  const aPid = (await row(a, 'select pg_backend_pid() as pid')).pid;
  const bPid = (await row(b, 'select pg_backend_pid() as pid')).pid;
  const observerPid = (await row(observer, 'select pg_backend_pid() as pid')).pid;
  assert.equal(new Set([aPid, bPid, observerPid]).size, 3);
  const workspace = randomUUID(), doctor = randomUUID();
  const staffA = randomUUID(), staffB = randomUUID();
  const keyA = randomUUID(), keyB = randomUUID();
  await observer.query("insert into workspaces(id,name) values($1,'Disposable capacity fixture')", [workspace]);
  for (const staff of [staffA, staffB]) {
    await observer.query(`insert into staff_users(id,workspace_id,full_name,email,role)
      values($1,$2,'Fixture owner',$3,'owner')`, [staff, workspace, `${staff}@example.invalid`]);
  }
  await observer.query(`insert into clinic_doctors(id,workspace_id,staff_user_id,full_name,capacity)
    values($1,$2,$3,'Fixture doctor',1)`, [doctor, workspace, staffA]);
  const create = async (client, staff, key) => {
    const clientId = randomUUID();
    return (await row(client,
      'select public.create_crm_appointment_once($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) as result',
      [workspace, staff, key, 'a'.repeat(64),
        { id: clientId, workspace_id: workspace, full_name: 'Fixture client', status: 'new' },
        { workspace_id: workspace, client_id: clientId, created_by_staff_user_id: staff,
          client_name: 'Fixture client', doctor_id: doctor, doctor_name: 'Fixture doctor',
          starts_at: '2026-10-03T09:00:00Z', duration_minutes: 60, status: 'scheduled',
          service: 'Fixture service', price_minor: 123450 }, 'created'])).result;
  };
  await a.query('begin; set local role service_role');
  const first = await create(a, staffA, keyA);
  assert.equal(first.replayed, false);
  assert.equal((await row(observer, 'select count(*)::int as n from appointments where workspace_id=$1', [workspace])).n, 0);
  await b.query('set role service_role');
  let settled = false;
  const pending = create(b, staffB, keyB).then(
    value => { settled = true; return { value }; },
    error => { settled = true; return { error }; },
  );
  // Hold the first write uncommitted until the competing backend is observed.
  let blocked = false;
  const deadline = Date.now() + 2500;
  while (!settled && Date.now() < deadline) {
    blocked = (await row(observer, 'select $1::int=any(pg_blocking_pids($2::int)) as blocked', [aPid, bPid])).blocked;
    if (blocked) break;
    await delay(15);
  }
  assert.ok(settled || blocked, 'The competing call must complete or enter a real database lock wait');
  await a.query('commit');
  const second = await pending;
  assert.ok(!['55P03', '57014'].includes(second.error?.code), 'A timeout is not a capacity rejection');
  const counts = await row(observer, `select
    (select count(*)::int from appointments where workspace_id=$1) as appointments,
    (select count(*)::int from clients where workspace_id=$1) as clients,
    (select count(*)::int from crm_appointment_create_requests where workspace_id=$1) as receipts`, [workspace]);
  t.diagnostic(`capacity=1; appointments=${counts.appointments}; clients=${counts.clients}; receipts=${counts.receipts}; competing_backend_blocked=${blocked}`);
  assert.equal(counts.appointments, 1, 'Two valid, different requests must not overbook one available place');
  assert.deepEqual(counts, { appointments: 1, clients: 1, receipts: 1 });
  assert.equal(second.error?.code, '23P01', 'Only an explicit capacity exclusion may refuse the competing request');
});

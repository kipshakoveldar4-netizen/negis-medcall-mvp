import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startDisposablePostgres } from './disposable-postgres.mjs';
import { reproduceNamesakeCapacityRefusal, exerciseCapacityIdentity, exerciseCapacityMigrationRefusals } from './appointment-capacity-identity-cases.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const start = '2090-10-20T09:00:00Z';
const row = async (client, sql, params = []) => (await client.query(sql, params)).rows[0];
const observed = promise => promise.then(value => ({ value }), error => ({ error }));
const none = { appointments: 0, clients: 0, receipts: 0, deals: 0 };
const one = { appointments: 1, clients: 1, receipts: 1, deals: 0 };
const capacityDenied = promise => assert.rejects(promise, error => {
  assert.equal(error.code, '23P01');
  assert.equal(error.message, 'appointment_capacity_exceeded');
  assert.equal(error.detail, undefined);
  return true;
});

async function makeCase(fixture, db, t, capacity = 1, paid = false) {
  const a = await fixture.connect(), b = await fixture.connect();
  t.after(async () => {
    await a.query('rollback').catch(() => {}); await b.query('rollback').catch(() => {});
    await a.end(); await b.end();
  });
  const aPid = (await row(a, 'select pg_backend_pid() as pid')).pid;
  const bPid = (await row(b, 'select pg_backend_pid() as pid')).pid;
  assert.equal(new Set([aPid, bPid, (await row(db, 'select pg_backend_pid() as pid')).pid]).size, 3);
  const workspace = randomUUID(), doctor = randomUUID(), staffA = randomUUID(), staffB = randomUUID();
  await db.query("insert into workspaces(id,name,arrival_marks_paid) values($1,'Disposable capacity fixture',$2)", [workspace, paid]);
  for (const staff of [staffA, staffB]) {
    await db.query(`insert into staff_users(id,workspace_id,auth_user_id,full_name,email,role)
      values($1,$2,$3,'Fixture owner',$4,'owner')`, [staff, workspace, randomUUID(), `${staff}@example.invalid`]);
  }
  await db.query(`insert into clinic_doctors(id,workspace_id,staff_user_id,full_name,capacity)
    values($1,$2,$3,'Fixture doctor',$4)`, [doctor, workspace, staffA, capacity]);
  await a.query('set role service_role'); await b.query('set role service_role');
  const create = async (client, options = {}) => {
    const clientId = randomUUID();
    const clientData = { id: clientId, workspace_id: workspace, full_name: 'Fixture client', status: 'new' };
    const appointment = { workspace_id: workspace, client_id: clientId,
      created_by_staff_user_id: options.staff ?? staffA, client_name: 'Fixture client',
      doctor_id: doctor, doctor_name: 'Fixture doctor', starts_at: start,
      duration_minutes: 60, status: 'scheduled', service: 'Fixture service', price_minor: 123450,
      ...options.appointment };
    if (options.legacy) return (await row(client,
      'select public.create_crm_appointment_with_new_client($1,$2::jsonb,$3::jsonb) as result',
      [workspace, clientData, appointment])).result;
    return (await row(client,
      'select public.create_crm_appointment_once($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) as result',
      [workspace, options.staff ?? staffA, options.key ?? randomUUID(), 'a'.repeat(64), clientData, appointment, 'created'])).result;
  };
  const counts = () => row(db, `select
    (select count(*)::int from appointments where workspace_id=$1) as appointments,
    (select count(*)::int from clients where workspace_id=$1) as clients,
    (select count(*)::int from crm_appointment_create_requests where workspace_id=$1) as receipts,
    (select count(*)::int from deals where workspace_id=$1) as deals`, [workspace]);
  const blocked = async () => {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      if ((await row(db, 'select $1::int=any(pg_blocking_pids($2::int)) as blocked', [aPid, bPid])).blocked) return;
      await delay(15);
    }
    assert.fail('A real database lock wait is required; elapsed time alone does not prove serialization');
  };
  const operator = async (options = {}) => {
    const profile = randomUUID(), user = randomUUID(), request = randomUUID(), lead = randomUUID(), service = randomUUID();
    await db.query(`insert into growth_operator_profiles(id,auth_user_id,display_name,status,accepting_requests,approved_by,approved_at)
      values($1,$2,'Fixture operator','approved',true,$3,now())`, [profile, user, randomUUID()]);
    await db.query(`insert into growth_operator_requests(id,workspace_id,operator_id,requested_by_staff_user_id,clinic_brief,price_per_arrival_minor)
      values($1,$2,$3,$4,'Fixture request',0)`, [request, workspace, profile, staffA]);
    await db.query('select public.accept_growth_operator_request($1,$2)', [request, user]);
    await db.query("insert into leads(id,workspace_id,full_name,phone) values($1,$2,'Fixture lead','+70000000000')", [lead, workspace]);
    await db.query(`insert into growth_operator_lead_assignments(operator_request_id,workspace_id,lead_id,changed_by_staff_user_id)
      values($1,$2,$3,$4)`, [request, workspace, lead, staffA]);
    await db.query(`insert into workspace_settings(workspace_id,key,value) values($1,'clinic_schedule','{"timeZone":"UTC"}')`, [workspace]);
    await db.query(`insert into clinic_doctor_shifts(workspace_id,doctor_id,on_date,on_date_end,start_minute,end_minute,is_working)
      values($1,$2,'2090-10-20','2090-10-20',0,1440,true)`, [workspace, doctor]);
    await db.query(`insert into clinic_services(id,workspace_id,doctor_id,name,base_price_minor,duration_minutes)
      values($1,$2,$3,'Fixture service',1000,$4)`, [service, workspace, doctor, options.minutes ?? 60]);
    return client => row(client,
      'select public.create_growth_operator_booking($1,$2,$3,$4,$5,$6,$7,$8) as result',
      [request, user, lead, randomUUID(), doctor, [service], options.startsLocal ?? '2090-10-20 09:00:00', 'UTC']);
  };
  return { a, b, workspace, doctor, staffB, create, counts, blocked, operator };
}

// Real local SQL only: never DATABASE_URL, a live tenant, or a skipped substitute.
test('atomic appointment capacity on disposable PostgreSQL', { timeout: 300000 }, async t => {
  const fixture = await startDisposablePostgres();
  t.after(async () => {
    await fixture.close();
    t.diagnostic('Owned disposable server stopped and run directory removed');
  });
  const db = await fixture.connect();
  await db.query('create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to service_role;');
  const numbers = new Set([9, 10, 11, 12, 13, 14, 19, 20, 29, 30, 32, 33, 34, 35, 36, 40, 43, 45, 52, 53, 54, 55, 56, 57, 61, 63, 64]);
  for (const file of (await readdir(path.join(root, 'migrations'))).sort()) {
    if (numbers.has(Number(file.slice(0, 3)))) await db.query(await readFile(path.join(root, 'migrations', file), 'utf8'));
  }
  const historical = await makeCase(fixture, db, t);
  const old = await historical.create(historical.a);
  await historical.create(historical.a);
  const guard = await readFile(path.join(root, 'migrations/072_atomic_appointment_capacity.sql'), 'utf8');
  await db.query(guard); await db.query(guard);
  const bridge = await makeCase(fixture, db, t, 2);
  await bridge.create(bridge.a);
  await bridge.create(bridge.a, { appointment: { starts_at: '2090-10-20T10:00:00Z' } });
  await capacityDenied(bridge.create(bridge.a, { appointment: { duration_minutes: 120 } }));
  const peakGuard = await readFile(path.join(root, 'migrations/073_peak_appointment_capacity.sql'), 'utf8');
  await db.query(peakGuard); await db.query(peakGuard);
  let reproduced=false;
  await t.test('before 102, reproduce 073 refusing a distinct linked namesake at capacity two', async () => {
    await reproduceNamesakeCapacityRefusal(db);reproduced=true;
  });
  assert.ok(reproduced,'Do not accept 102 without the actual prior refusal');
  await db.query(await readFile(path.join(root, 'migrations/076_crm_sale_create_requests.sql'), 'utf8'));
  const identityGuard = await readFile(path.join(root, 'migrations/102_appointment_capacity_explicit_identity.sql'), 'utf8');
  await db.query(identityGuard); await db.query(identityGuard);
  await exerciseCapacityMigrationRefusals(db, identityGuard, t);
  await exerciseCapacityIdentity(db, t);
  t.diagnostic(`PostgreSQL ${(await row(db, 'show server_version')).server_version}; focused 073/076/102 composition; synthetic workspaces only`);

  await t.test('073 fixes the reproduced 072 refusal for a long visit across adjacent visits', async () => {
    await bridge.create(bridge.a, { appointment: { duration_minutes: 120 } });
    await capacityDenied(bridge.create(bridge.b, { appointment: { starts_at: '2090-10-20T09:30:00Z', duration_minutes: 30 } }));
    assert.deepEqual(await bridge.counts(), { appointments: 3, clients: 3, receipts: 3, deals: 0 });
  });

  await t.test('idempotent install preserves history and is not directly executable', async () => {
    assert.equal((await historical.counts()).appointments, 2);
    const fn = await row(db, `select p.prosecdef, p.provolatile, p.proconfig from pg_proc p
      where p.oid='public.guard_appointment_capacity()'::regprocedure`);
    assert.equal(fn.prosecdef, true); assert.equal(fn.provolatile, 'v');
    assert.deepEqual(fn.proconfig, ['search_path=""']);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal((await row(db, "select has_function_privilege($1,'public.guard_appointment_capacity()','execute') as ok", [role])).ok, false);
    }
    await db.query("update appointments set status='arrived' where id=$1", [old.appointment.id]);
    await capacityDenied(historical.create(historical.b));
    assert.equal((await historical.counts()).appointments, 2);
  });

  await t.test('different keys wait and reject without an orphan client, receipt or sale', async t => {
    const f = await makeCase(fixture, db, t, 1, true);
    await f.a.query('begin');
    await f.create(f.a, { appointment: { status: 'arrived' } });
    const pending = observed(f.create(f.b, { staff: f.staffB, appointment: { status: 'arrived' } }));
    await f.blocked(); assert.deepEqual(await f.counts(), none);
    await f.a.query('commit');
    await capacityDenied(Promise.reject((await pending).error));
    assert.deepEqual(await f.counts(), { ...one, deals: 1 });
  });

  await t.test('capacity two admits two after waiting, but rejects a third', async t => {
    const f = await makeCase(fixture, db, t, 2);
    await f.a.query('begin'); await f.create(f.a);
    const pending = observed(f.create(f.b));
    await f.blocked(); await f.a.query('commit');
    assert.ok((await pending).value);
    await capacityDenied(f.create(f.a));
    assert.deepEqual(await f.counts(), { appointments: 2, clients: 2, receipts: 2, deals: 0 });
  });

  await t.test('a full namesake does not poison a real same-ID wait, while both resources keep their limit', async t => {
    const f = await makeCase(fixture, db, t, 2), namesake = randomUUID();
    await db.query("insert into clinic_doctors(id,workspace_id,full_name,capacity) values($1,$2,'Renamed doctor',2)", [namesake, f.workspace]);
    await f.create(f.a, { appointment: { doctor_id: namesake } });
    await f.create(f.a, { appointment: { doctor_id: namesake } });
    await f.a.query('begin'); await f.create(f.a);
    const pending = observed(f.create(f.b));
    await f.blocked(); await f.a.query('commit');
    assert.ok((await pending).value);
    await capacityDenied(f.create(f.a));
    await capacityDenied(f.create(f.a, { appointment: { doctor_id: namesake } }));
    assert.deepEqual(await f.counts(), { appointments: 4, clients: 4, receipts: 4, deals: 0 });
  });

  await t.test('a waiting long visit fits adjacent visits, then capacity still rejects a third at the peak', async t => {
    const f = await makeCase(fixture, db, t, 2);
    await f.a.query('begin');
    await f.create(f.a);
    await f.create(f.a, { appointment: { starts_at: '2090-10-20T10:00:00Z' } });
    const pending = observed(f.create(f.b, { appointment: { duration_minutes: 120 } }));
    await f.blocked(); await f.a.query('commit');
    assert.ok((await pending).value);
    await capacityDenied(f.create(f.a, { appointment: { starts_at: '2090-10-20T10:00:00Z', duration_minutes: 30 } }));
    assert.deepEqual(await f.counts(), { appointments: 3, clients: 3, receipts: 3, deals: 0 });
  });

  await t.test('partial overlaps fill three places only where all three actually meet', async t => {
    const f = await makeCase(fixture, db, t, 3);
    await f.create(f.a, { appointment: { duration_minutes: 120 } });
    await f.create(f.a, { appointment: { starts_at: '2090-10-20T09:30:00Z' } });
    await f.create(f.a, { appointment: { starts_at: '2090-10-20T10:30:00Z', duration_minutes: 30 } });
    await f.create(f.a, { appointment: { duration_minutes: 120 } });
    await capacityDenied(f.create(f.b, { appointment: { starts_at: '2090-10-20T09:45:00Z', duration_minutes: 5 } }));
    assert.equal((await f.counts()).appointments, 4);
  });

  await t.test('rescheduling across adjacent visits works but expansion into a full peak rolls back', async t => {
    const f = await makeCase(fixture, db, t, 2);
    await f.create(f.a);
    await f.create(f.a, { appointment: { starts_at: '2090-10-20T10:00:00Z' } });
    const moved = await f.create(f.a, { appointment: { starts_at: '2090-10-20T11:00:00Z' } });
    await f.a.query('update appointments set starts_at=$1,duration_minutes=120 where id=$2', [start, moved.appointment.id]);
    await f.create(f.a, { appointment: { starts_at: '2090-10-20T11:00:00Z' } });
    await f.create(f.a, { appointment: { starts_at: '2090-10-20T11:00:00Z' } });
    await capacityDenied(f.b.query('update appointments set duration_minutes=180 where id=$1', [moved.appointment.id]));
    assert.equal((await row(db, 'select duration_minutes from appointments where id=$1', [moved.appointment.id])).duration_minutes, 120);
  });

  await t.test('rollback lets a waiting request succeed; same-key replay still works when full', async t => {
    const f = await makeCase(fixture, db, t), key = randomUUID();
    await f.a.query('begin'); await f.create(f.a);
    const pending = observed(f.create(f.b, { key }));
    await f.blocked(); await f.a.query('rollback');
    const first = (await pending).value;
    assert.ok(first); assert.equal(first.replayed, false);
    const replay = await f.create(f.a, { key });
    assert.equal(replay.replayed, true); assert.equal(replay.appointment.id, first.appointment.id);
    assert.deepEqual(await f.counts(), one);
  });

  await t.test('legacy name-only creation and linked creation use the same barrier', async t => {
    const f = await makeCase(fixture, db, t);
    await f.a.query('begin');
    await f.create(f.a, { legacy: true, appointment: { doctor_id: null, doctor_name: ' Fixture DOCTOR ' } });
    const pending = observed(f.create(f.b));
    await f.blocked(); await f.a.query('commit');
    await capacityDenied(Promise.reject((await pending).error));
    assert.deepEqual(await f.counts(), { ...one, receipts: 0 });
  });

  await t.test('unknown legacy names have a normalized workspace-scoped capacity of one', async t => {
    const f = await makeCase(fixture, db, t);
    await f.a.query('begin');
    await f.create(f.a, { appointment: { doctor_id: null, doctor_name: ' Legacy name ' } });
    const pending = observed(f.create(f.b, { appointment: { doctor_id: null, doctor_name: 'legacy NAME' } }));
    await f.blocked(); await f.a.query('commit');
    await capacityDenied(Promise.reject((await pending).error));
    assert.deepEqual(await f.counts(), one);
  });

  await t.test('half-open intervals and legacy zero duration match the CRM rules', async t => {
    const f = await makeCase(fixture, db, t);
    await f.create(f.a, { appointment: { duration_minutes: 0 } });
    await capacityDenied(f.create(f.b, { appointment: { starts_at: '2090-10-20T09:30:00Z' } }));
    await f.create(f.b, { appointment: { starts_at: '2090-10-20T10:00:00Z' } });
    assert.equal((await f.counts()).appointments, 2);
  });

  await t.test('other doctors and workspaces are not serialized behind this doctor', async t => {
    const f = await makeCase(fixture, db, t), other = await makeCase(fixture, db, t);
    const doctor = randomUUID();
    await db.query("insert into clinic_doctors(id,workspace_id,full_name) values($1,$2,'Other fixture doctor')", [doctor, f.workspace]);
    await f.a.query('begin'); await f.create(f.a);
    await f.b.query('set statement_timeout=1500'); await other.a.query('set statement_timeout=1500');
    await f.create(f.b, { appointment: { doctor_id: doctor, doctor_name: 'Other fixture doctor' } });
    await other.create(other.a);
    await f.a.query('commit');
    assert.equal((await f.counts()).appointments, 2); assert.deepEqual(await other.counts(), one);
  });

  await t.test('competing reschedules cannot move two visits into one place', async t => {
    const f = await makeCase(fixture, db, t);
    const first = await f.create(f.a), second = await f.create(f.b, { appointment: { starts_at: '2090-10-20T10:00:00Z' } });
    await f.a.query('begin');
    await f.a.query("update appointments set starts_at='2090-10-20T11:00:00Z' where id=$1", [first.appointment.id]);
    const pending = observed(f.b.query("update appointments set starts_at='2090-10-20T11:00:00Z' where id=$1", [second.appointment.id]));
    await f.blocked(); await f.a.query('commit');
    await capacityDenied(Promise.reject((await pending).error));
    assert.equal((await row(db, "select extract(hour from starts_at at time zone 'UTC')::int as hour from appointments where id=$1", [second.appointment.id])).hour, 10);
  });

  for (const status of ['cancelled', 'no_show']) await t.test(`${status} frees a slot only after commit; reactivation is refused`, async t => {
    const f = await makeCase(fixture, db, t), first = await f.create(f.a);
    await f.a.query('begin'); await f.a.query('update appointments set status=$1 where id=$2', [status, first.appointment.id]);
    const pending = observed(f.create(f.b));
    await f.blocked(); await f.a.query('commit'); assert.ok((await pending).value);
    await capacityDenied(f.a.query("update appointments set status='scheduled' where id=$1", [first.appointment.id]));
    assert.equal((await row(db, 'select status from appointments where id=$1', [first.appointment.id])).status, status);
  });

  await t.test('multi-row writes and stale-snapshot isolation fail closed', async t => {
    const f = await makeCase(fixture, db, t);
    await capacityDenied(f.a.query(`insert into appointments(workspace_id,doctor_id,doctor_name,starts_at,status)
      select $1,$2,'Fixture doctor',$3,'scheduled' from generate_series(1,2)`, [f.workspace, f.doctor, start]));
    assert.deepEqual(await f.counts(), none);
    for (const level of ['repeatable read', 'serializable']) {
      await f.a.query(`begin isolation level ${level}`);
      await assert.rejects(f.create(f.a), { code: '40001', message: 'appointment_capacity_requires_read_committed' });
      await f.a.query('rollback');
    }
    await f.create(f.a, { appointment: { status: 'legacy_unknown' } });
    await capacityDenied(f.create(f.b));
    assert.deepEqual(await f.counts(), one);
  });

  await t.test('operator booking waits for the CRM and refuses before creating side effects', async t => {
    const f = await makeCase(fixture, db, t), book = await f.operator();
    await f.a.query('begin'); await f.create(f.a);
    const pending = observed(book(f.b));
    await f.blocked(); await f.a.query('commit');
    await capacityDenied(Promise.reject((await pending).error));
    assert.deepEqual(await f.counts(), one);
    assert.equal((await row(db, 'select count(*)::int as n from growth_operator_bookings where workspace_id=$1', [f.workspace])).n, 0);
  });

  await t.test('operator long booking uses the same peak rule and leaves no side effects on refusal', async t => {
    const f = await makeCase(fixture, db, t, 2), book = await f.operator({ minutes: 120 });
    await f.create(f.a);
    await f.create(f.a, { appointment: { starts_at: '2090-10-20T10:00:00Z' } });
    await book(f.b);
    await capacityDenied(f.create(f.a, { appointment: { duration_minutes: 120 } }));
    assert.deepEqual(await f.counts(), { appointments: 3, clients: 3, receipts: 2, deals: 0 });
    assert.equal((await row(db, 'select count(*)::int as n from growth_operator_bookings where workspace_id=$1', [f.workspace])).n, 1);
  });

  await t.test('CRM waits for the operator booking and rolls back its losing new client', async t => {
    const f = await makeCase(fixture, db, t), book = await f.operator();
    await f.a.query('begin'); await book(f.a);
    const pending = observed(f.create(f.b));
    await f.blocked(); await f.a.query('commit');
    await capacityDenied(Promise.reject((await pending).error));
    assert.deepEqual(await f.counts(), { ...one, receipts: 0 });
    assert.equal((await row(db, 'select count(*)::int as n from growth_operator_bookings where workspace_id=$1', [f.workspace])).n, 1);
  });
});

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { before, after, beforeEach, afterEach } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { appointmentReadinessQuery, buildAppointmentPreviewReadiness } from './appointment-preview-readiness.mjs';
import { buildSitePreviewBootstrap } from './site-preview-bootstrap.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const db = new PGlite();
const numbers = new Set([9, 10, 11, 12, 13, 14, 19, 20, 29, 30, 32, 33, 34, 36, 40, 43, 45, 55, 61, 63, 64]);
const roles = 'create role anon; create role authenticated; create role service_role bypassrls;';
const local = sql => sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/i, '');
const workspace = '00000000-0000-4000-8000-000000000001';
const staff = '00000000-0000-4000-8000-000000000011';
const client = '00000000-0000-4000-8000-000000000100';
const signature = 'public.create_crm_appointment_once(uuid,uuid,uuid,text,jsonb,jsonb,text)';
const checks = async database => (await database.query(appointmentReadinessQuery)).rows;
const blockers = async database => (await checks(database)).filter(row => !row.ready).map(row => row.check_name);

async function install(database, skip = null) {
  await database.exec(roles);
  for (const file of (await readdir(path.join(root, 'migrations'))).sort()) {
    const number = Number(file.slice(0, 3));
    if (numbers.has(number) && number !== skip) {
      await database.exec(local(await readFile(path.join(root, 'migrations', file), 'utf8')));
    }
  }
}

before(() => install(db));
after(() => db.close());
beforeEach(() => db.exec('begin'));
afterEach(() => db.exec('rollback'));

test('generated checks are read-only metadata, not clinical data or an execution command', () => {
  const sql = buildAppointmentPreviewReadiness();
  assert.match(sql, /begin read only;/);
  assert.match(sql, /NOT end-to-end, concurrency or payment acceptance/);
  assert.doesNotMatch(sql, /\b(?:insert|update|delete|alter|grant|revoke|truncate|drop)\s+(?:into|from|table|on|all)/i);
  assert.doesNotMatch(sql, /select\s+\*|from\s+public\.(?:clients|appointments|deals)\b/i);
});

test('empty database reports missing prerequisites rather than throwing or returning ready', async () => {
  const empty = new PGlite();
  try {
    const failures = await blockers(empty);
    assert.ok(failures.includes('column:appointments.created_by_staff_user_id'));
    assert.ok(failures.includes(`rpc:${signature}`));
    assert.ok(failures.includes(`execute:service_role:${signature}`));
    assert.equal(failures.length, (await checks(empty)).length);
  } finally { await empty.close(); }
});

test('partial auth/blog bootstrap is not considered a CRM-ready database', async () => {
  const partial = new PGlite();
  try {
    await partial.exec(roles + 'create schema auth; create table auth.users(id uuid primary key);');
    await partial.exec(local(buildSitePreviewBootstrap()));
    const failures = await blockers(partial);
    assert.ok(failures.includes('column:appointments.created_by_staff_user_id'));
    assert.ok(failures.includes(`rpc:${signature}`));
  } finally { await partial.close(); }
});

test('clean appointment dependency chain satisfies all metadata prerequisites', async () => {
  assert.deepEqual(await blockers(db), []);
});

test('missing 043 reproduces Preview failure despite all RPCs being present, with no partial writes', async () => {
  const incomplete = new PGlite();
  try {
    await install(incomplete, 43);
    assert.deepEqual(await blockers(incomplete), ['column:appointments.created_by_staff_user_id']);
    await incomplete.exec(`insert into workspaces(id,name) values('${workspace}','Isolated readiness fixture');
      insert into staff_users(id,workspace_id,full_name,email,role) values
      ('${staff}','${workspace}','Fixture owner','fixture@example.invalid','owner');`);
    await assert.rejects(incomplete.query(
      'select public.create_crm_appointment_once($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6::jsonb,$7)',
      [workspace, staff, '00000000-0000-4000-8000-000000000050', 'a'.repeat(64),
        JSON.stringify({ id: client, workspace_id: workspace, full_name: 'Fictional client', status: 'new' }),
        JSON.stringify({ workspace_id: workspace, client_id: client, created_by_staff_user_id: staff,
          client_name: 'Fictional client', starts_at: '2026-10-09T09:00:00+05:00', status: 'scheduled',
          service: 'Fixture service', price_minor: 150000, duration_minutes: 90 }), 'created']),
      error => error.code === '42703');
    const counts = (await incomplete.query(`select (select count(*) from clients) as clients,
      (select count(*) from appointments) as appointments, (select count(*) from deals) as sales,
      (select count(*) from crm_appointment_create_requests) as receipts`)).rows[0];
    assert.deepEqual(counts, { clients: 0, appointments: 0, sales: 0, receipts: 0 });
    await incomplete.exec(await readFile(path.join(root, 'migrations/043_appointment_author.sql'), 'utf8'));
    assert.deepEqual(await blockers(incomplete), []);
  } finally { await incomplete.close(); }
});

test('missing server execute or inherited PUBLIC execute is rejected', async () => {
  await db.exec(`revoke execute on function ${signature} from service_role`);
  assert.deepEqual(await blockers(db), [`execute:service_role:${signature}`]);
  await db.exec(`grant execute on function ${signature} to service_role; grant execute on function ${signature} to public`);
  assert.deepEqual(await blockers(db), [`execute:anon:${signature}`, `execute:authenticated:${signature}`]);
});

test('receipt RLS and even a column-only browser grant are checked', async () => {
  await db.exec('alter table crm_appointment_create_requests disable row level security');
  assert.deepEqual(await blockers(db), ['receipts:rls']);
  await db.exec('alter table crm_appointment_create_requests enable row level security; grant select(request_key) on crm_appointment_create_requests to anon');
  assert.deepEqual(await blockers(db), ['receipts:closed:anon']);
});

test('readiness does not change records, workspace financial settings or role grants', async () => {
  await db.exec(`insert into workspaces(id,name,arrival_marks_paid) values('${workspace}','Untouched fixture',false);
    insert into clients(id,workspace_id,full_name) values('${client}','${workspace}','Untouched client');`);
  const snapshot = async () => (await db.query(`select
    (select jsonb_agg(w) from workspaces w) as workspaces,
    (select jsonb_agg(c) from clients c) as clients,
    (select jsonb_agg(p.proacl order by p.oid) from pg_proc p where p.pronamespace='public'::regnamespace) as grants`)).rows[0];
  const original = await snapshot();
  assert.deepEqual(await blockers(db), []);
  assert.deepEqual(await snapshot(), original);
});

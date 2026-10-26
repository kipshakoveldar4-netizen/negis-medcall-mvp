import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const one = async (db, sql, params = []) => (await db.query(sql, params)).rows[0];
async function rollback(db, action) {
  await db.query('begin');
  try { return await action(); } finally { await db.query('rollback'); }
}
async function capacityDenied(db, action) {
  await db.query('savepoint capacity_refusal');
  try {
    await assert.rejects(action, error => error.code === '23P01'
      && error.message === 'appointment_capacity_exceeded' && error.detail === undefined);
  } finally { await db.query('rollback to savepoint capacity_refusal'); }
}
async function setup(db) {
  const workspace = randomUUID(), doctorA = randomUUID(), doctorB = randomUUID();
  const staff = randomUUID(), actor = randomUUID();
  await db.query("insert into workspaces(id,name) values($1,'Owned identity fixture')", [workspace]);
  await db.query(`insert into staff_users(id,workspace_id,auth_user_id,full_name,email,role)
    values($1,$2,$3,'Owned fixture owner',$4,'owner')`, [staff, workspace, actor, `${staff}@example.invalid`]);
  for (const id of [doctorA, doctorB]) await db.query(`insert into clinic_doctors(id,workspace_id,full_name,capacity)
    values($1,$2,$3,2)`, [id, workspace, id === doctorA ? 'Namesake doctor' : 'Renamed doctor']);
  const create = async (doctor, label = 'Namesake doctor', key = randomUUID(), status = 'scheduled') => {
    const client = randomUUID();
    const result = await one(db, 'select public.create_crm_appointment_once($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) as value',
      [workspace, staff, key, 'a'.repeat(64), { id: client, workspace_id: workspace, full_name: 'Owned fixture client', status: 'new' },
        { workspace_id: workspace, client_id: client, created_by_staff_user_id: staff, client_name: 'Owned fixture client',
          doctor_id: doctor, doctor_name: label, starts_at: '2090-10-20T09:00:00Z', duration_minutes: 60, status, price_minor: 1000 }, 'created']);
    return result.value;
  };
  const counts = async () => {
    const actor = (await one(db, 'select current_user as actor')).actor;
    assert.ok(['postgres', 'service_role'].includes(actor));
    // Observe private receipts as the owned fixture administrator, not by
    // granting the application role new access to clients/receipt tables.
    await db.query('reset role');
    try { return await one(db, `select
    (select count(*)::int from appointments where workspace_id=$1) as appointments,
    (select count(*)::int from clients where workspace_id=$1) as clients,
    (select count(*)::int from crm_appointment_create_requests where workspace_id=$1) as receipts,
    (select count(*)::int from deals where workspace_id=$1) as deals`, [workspace]); }
    finally { if (actor === 'service_role') await db.query('set local role service_role'); }
  };
  return { workspace, doctorA, doctorB, create, counts };
}

export async function reproduceNamesakeCapacityRefusal(db) {
  await rollback(db, async () => {
    const f = await setup(db);
    await f.create(f.doctorB); await f.create(f.doctorB);
    await capacityDenied(db, () => f.create(f.doctorA));
    assert.deepEqual(await f.counts(), { appointments: 2, clients: 2, receipts: 2, deals: 0 });
  });
}

// Run both on the focused 073/076/102 composition and on the exact full chain.
// Each case rolls back all synthetic data, including clients and request receipts.
export async function exerciseCapacityIdentity(db, t) {
  for (const [name, action] of [
    ['full linked namesakes have separate capacity; same-key replay at full capacity is unchanged', async f => {
      await f.create(f.doctorB); await f.create(f.doctorB);
      const key = randomUUID();
      const first = await f.create(f.doctorA, 'Namesake doctor', key);
      await f.create(f.doctorA);
      const replay = await f.create(f.doctorA, 'Namesake doctor', key);
      assert.equal(replay.replayed, true); assert.equal(replay.appointment.id, first.appointment.id);
      await capacityDenied(db, () => f.create(f.doctorA));
      assert.deepEqual(await f.counts(), { appointments: 4, clients: 4, receipts: 4, deals: 0 });
    }],
    ['changed/empty labels do not free the same explicit UUID', async f => {
      await f.create(f.doctorA, 'Old label'); await f.create(f.doctorA, '');
      await capacityDenied(db, () => f.create(f.doctorA, 'New label'));
      assert.equal((await f.counts()).appointments, 2);
    }],
    ['archived directory namesake does not consume the active doctor capacity', async f => {
      await f.create(f.doctorB); await f.create(f.doctorB);
      await db.query("update clinic_doctors set is_active=false,full_name='Namesake doctor' where id=$1", [f.doctorB]);
      await f.create(f.doctorA); await f.create(f.doctorA);
      await capacityDenied(db, () => f.create(f.doctorA));
      assert.equal((await f.counts()).appointments, 4);
    }],
    ['legacy names still consume the linked resource but not a renamed distinct linked namesake', async f => {
      await f.create(null, ' Namesake DOCTOR ');
      await f.create(f.doctorA, 'Old label');
      await capacityDenied(db, () => f.create(f.doctorA));
      await f.create(f.doctorB);
      await capacityDenied(db, () => f.create(f.doctorB));
      assert.equal((await f.counts()).appointments, 3);
    }],
    ['legacy candidate stays conservative across linked namesakes', async f => {
      await f.create(f.doctorA); await f.create(f.doctorB);
      await capacityDenied(db, () => f.create(null, ' NAMESAKE doctor '));
      assert.equal((await f.counts()).appointments, 2);
    }],
    ['failed reassignment rolls back; linked namesake can retain its own occupied interval', async f => {
      await f.create(f.doctorA); await f.create(f.doctorA);
      const moved = await f.create(f.doctorB);
      await capacityDenied(db, () => db.query('update appointments set doctor_id=$1 where id=$2', [f.doctorA, moved.appointment.id]));
      await db.query("update appointments set status='arrived' where id=$1", [moved.appointment.id]);
      assert.equal((await one(db, 'select doctor_id from appointments where id=$1', [moved.appointment.id])).doctor_id, f.doctorB);
      assert.equal((await f.counts()).appointments, 3);
    }],
    ['with 076 present, arrival sale trigger preserves atomic refusal without an orphan sale/client/receipt', async f => {
      await db.query('reset role');
      await db.query('update workspaces set arrival_marks_paid=true where id=$1', [f.workspace]);
      await db.query('set local role service_role');
      await f.create(f.doctorB, 'Namesake doctor', randomUUID(), 'arrived');
      await f.create(f.doctorB, 'Namesake doctor', randomUUID(), 'arrived');
      await f.create(f.doctorA, 'Namesake doctor', randomUUID(), 'arrived');
      await f.create(f.doctorA, 'Namesake doctor', randomUUID(), 'arrived');
      await capacityDenied(db, () => f.create(f.doctorA, 'Namesake doctor', randomUUID(), 'arrived'));
      assert.deepEqual(await f.counts(), { appointments: 4, clients: 4, receipts: 4, deals: 4 });
    }],
  ]) {
    let passed = false;
    await t.test(`102 ${name}`, async () => rollback(db, async () => {
      const f = await setup(db);
      await db.query('set local role service_role');
      // The enclosing rollback also restores SET LOCAL ROLE, including after
      // an unexpected SQL error; RESET in an aborted transaction masks it.
      await action(f); passed = true;
    }));
    assert.ok(passed, 'Stop after a failed actual capacity identity proof');
  }
}

export async function exerciseCapacityMigrationRefusals(db, source, t) {
  const snapshot = async () => (await db.query(`select pg_catalog.pg_get_functiondef(p.oid) as definition,
    p.proacl::text as acl,p.proowner::regrole::text as owner,
    pg_catalog.pg_get_triggerdef(t.oid) as trigger,pg_catalog.obj_description(p.oid,'pg_proc') as comment
    from pg_catalog.pg_proc p join pg_catalog.pg_trigger t on t.tgfoid=p.oid
    where p.oid='public.guard_appointment_capacity()'::regprocedure
      and t.tgrelid='public.appointments'::regclass and t.tgname='guard_appointment_capacity'`)).rows;
  for (const [name, change, message] of [
    ['unexpected body', "create or replace function public.guard_appointment_capacity() returns trigger language plpgsql volatile security definer set search_path='' as $$begin return new; end$$", 'appointment_capacity_identity_dependencies_unconfirmed'],
    ['unexpected search path', "alter function public.guard_appointment_capacity() set search_path=public", 'appointment_capacity_identity_dependencies_unconfirmed'],
    ['unexpected owner', 'alter function public.guard_appointment_capacity() owner to service_role', 'appointment_capacity_identity_dependencies_unconfirmed'],
    ['disabled trigger', 'alter table public.appointments disable trigger guard_appointment_capacity', 'appointment_capacity_identity_dependencies_unconfirmed'],
    ['incomplete update trigger', 'drop trigger guard_appointment_capacity on public.appointments; create trigger guard_appointment_capacity before insert or update of starts_at or delete on public.appointments for each row execute function public.guard_appointment_capacity()', 'appointment_capacity_identity_dependencies_unconfirmed'],
    ['direct server execution grant', 'grant execute on function public.guard_appointment_capacity() to service_role', 'appointment_capacity_identity_acl_unconfirmed'],
  ]) {
    let passed = false;
    await t.test(`102 refuses ${name} without accepting/repairing an unknown baseline`, async () => {
      const before = await snapshot();
      await db.query('begin');
      try {
        await db.query(change);
        await assert.rejects(db.query(source), error => error.message === message);
      } finally { await db.query('rollback'); }
      assert.deepEqual(await snapshot(), before); passed = true;
    });
    assert.ok(passed, 'Stop after a failed migration dependency refusal');
  }
  await t.test('102 reapply preserves its exact definition, ACL, trigger and comment', async () => {
    const before = await snapshot();
    await db.query(source);
    assert.deepEqual(await snapshot(), before);
  });
}

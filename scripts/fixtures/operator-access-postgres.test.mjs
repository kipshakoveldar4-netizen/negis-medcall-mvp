import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startDisposablePostgres } from './disposable-postgres.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const row = async (client, sql, values = []) => (await client.query(sql, values)).rows[0];
const observed = promise => promise.then(value => ({ value }), error => ({ error }));
const denied = promise => assert.rejects(promise, error => {
  assert.equal(error.code, 'P0001');
  assert.equal(error.message, 'operator_access_denied');
  return true;
});
const arrivalDenied = promise => assert.rejects(promise, error => {
  assert.equal(error.code, 'P0001');
  assert.equal(error.message, 'operator_arrival_access_denied');
  return true;
});

async function makeCase(fixture, db, t, scope = 'assigned') {
  const a = await fixture.connect(), b = await fixture.connect();
  t.after(async () => {
    await a.query('rollback').catch(() => {});
    await b.query('rollback').catch(() => {});
    await a.end(); await b.end();
  });
  await b.query('set role service_role');
  const ids = Object.fromEntries(['workspace', 'foreignWorkspace', 'staff', 'foreignStaff',
    'profile', 'user', 'otherProfile', 'otherUser', 'request', 'otherRequest',
    'lead', 'unassigned', 'foreignLead', 'stage', 'foreignStage', 'doctor', 'service']
    .map(key => [key, randomUUID()]));
  const i = ids;
  for (const [workspace, staff] of [[i.workspace, i.staff], [i.foreignWorkspace, i.foreignStaff]]) {
    await db.query("insert into workspaces(id,name) values($1,'Disposable operator access fixture')", [workspace]);
    await db.query(`insert into staff_users(id,workspace_id,auth_user_id,full_name,email,role)
      values($1,$2,$3,'Fixture owner',$4,'owner')`, [staff, workspace, randomUUID(), `${staff}@example.invalid`]);
  }
  for (const [profile, user] of [[i.profile, i.user], [i.otherProfile, i.otherUser]]) {
    await db.query(`insert into growth_operator_profiles(id,auth_user_id,display_name,status,
      accepting_requests,approved_by,approved_at) values($1,$2,'Disposable operator','approved',true,$3,now())`,
    [profile, user, randomUUID()]);
  }
  for (const [request, workspace, profile, staff] of [
    [i.request, i.workspace, i.profile, i.staff],
    [i.otherRequest, i.foreignWorkspace, i.otherProfile, i.foreignStaff],
  ]) {
    // Zero is a disposable technical value, not a commercial rate or payment.
    await db.query(`insert into growth_operator_requests(id,workspace_id,operator_id,
      requested_by_staff_user_id,clinic_brief,price_per_arrival_minor,lead_scope)
      values($1,$2,$3,$4,'Disposable access test; no commercial agreement',0,$5)`,
    [request, workspace, profile, staff, scope]);
    await db.query('select public.accept_growth_operator_request($1,$2)',
      [request, profile === i.profile ? i.user : i.otherUser]);
  }
  for (const [lead, workspace, name] of [[i.lead, i.workspace, 'Assigned fixture'],
    [i.unassigned, i.workspace, 'Unassigned fixture'], [i.foreignLead, i.foreignWorkspace, 'Foreign fixture']]) {
    await db.query(`insert into leads(id,workspace_id,full_name,phone,status,notes)
      values($1,$2,$3,'+70000000000','new','Private fixture note must not leave the RPC')`, [lead, workspace, name]);
  }
  if (scope === 'assigned') await db.query('select public.set_growth_operator_lead_assignment($1,$2,$3,true)',
    [i.request, i.lead, i.staff]);
  for (const [stage, workspace] of [[i.stage, i.workspace], [i.foreignStage, i.foreignWorkspace]]) {
    await db.query(`insert into lead_stages(id,workspace_id,stage_key,name,semantic_group)
      values($1,$2,'fixture_contacted','Fixture contacted','in_progress')`, [stage, workspace]);
  }
  await db.query(`insert into workspace_settings(workspace_id,key,value)
    values($1,'clinic_schedule','{"timeZone":"UTC"}')`, [i.workspace]);
  await db.query(`insert into clinic_doctors(id,workspace_id,staff_user_id,full_name)
    values($1,$2,$3,'Disposable specialist')`, [i.doctor, i.workspace, i.staff]);
  await db.query(`insert into clinic_doctor_shifts(workspace_id,doctor_id,on_date,on_date_end,start_minute,end_minute,is_working)
    values($1,$2,'2090-10-20','2090-10-20',0,1440,true)`, [i.workspace, i.doctor]);
  await db.query(`insert into clinic_services(id,workspace_id,doctor_id,name,base_price_minor,duration_minutes)
    values($1,$2,$3,'Disposable service',0,60)`, [i.service, i.workspace, i.doctor]);

  const leads = (client = b, request = i.request, user = i.user) => client.query(
    'select * from public.read_growth_operator_leads($1,$2,0)', [request, user]);
  const pipeline = (client = b, user = i.user) => row(client,
    'select public.read_growth_operator_lead_pipeline($1,$2,0) as result', [i.request, user]);
  const context = (client = b, lead = i.lead, user = i.user) => row(client,
    'select public.read_growth_operator_booking_context($1,$2,$3) as result', [i.request, user, lead]);
  const arrivals = (client = b, user = i.user) => row(client,
    'select public.read_growth_operator_arrivals($1,$2,0) as result', [i.request, user]);
  const changeStage = (client = b, lead = i.lead, target = i.stage, user = i.user) => client.query(
    'select public.set_growth_operator_lead_stage($1,$2,$3,$4,null,$5)', [i.request, user, lead, target, 'new']);
  const booking = (client = b, lead = i.lead, key = randomUUID(), user = i.user) => row(client,
    'select public.create_growth_operator_booking($1,$2,$3,$4,$5,$6,$7,$8) as result',
    [i.request, user, lead, key, i.doctor, [i.service], '2090-10-20 09:00:00', 'UTC']);
  const confirm = (appointment, client = b, staff = i.staff) => row(client,
    'select public.confirm_growth_operator_booking_arrival($1,$2,$3) as id', [i.request, appointment, staff]);
  const controlCall = (arrival, result = 'confirmed', client = b, user = i.user) => row(client,
    'select public.record_growth_operator_control_call($1,$2,$3) as id', [arrival, user, result]);
  const arrivedBooking = async () => {
    const { result } = await booking();
    await db.query("update appointments set status='arrived' where id=$1 and workspace_id=$2", [result.id, i.workspace]);
    return result.id;
  };
  const arrivalState = () => row(db, `select
    (select jsonb_agg(to_jsonb(r) order by id) from growth_operator_arrivals r where workspace_id=$1) as receipts,
    (select jsonb_agg(to_jsonb(a) order by created_at,id) from audit_logs a where workspace_id=$1) as audits,
    (select count(*)::int from deals where workspace_id=$1) as deals`, [i.workspace]);
  const state = () => row(db, `select
    (select jsonb_agg(to_jsonb(l) order by id) from leads l where workspace_id=$1) as leads,
    (select count(*)::int from clients where workspace_id=$1) as clients,
    (select count(*)::int from appointments where workspace_id=$1) as appointments,
    (select count(*)::int from growth_operator_bookings where workspace_id=$1) as bookings,
    (select count(*)::int from growth_operator_arrivals where workspace_id=$1) as arrivals,
    (select count(*)::int from deals where workspace_id=$1) as deals,
    (select count(*)::int from audit_logs where workspace_id=$1) as audits`, [i.workspace]);
  const revoke = (kind, client = a) => kind === 'profile'
    ? client.query("update growth_operator_profiles set status='suspended',accepting_requests=false where id=$1", [i.profile])
    : kind === 'agreement'
      ? client.query("update growth_operator_requests set status='ended',ended_at=now() where id=$1", [i.request])
      : client.query('update growth_operator_lead_assignments set assigned=false where operator_request_id=$1 and lead_id=$2', [i.request, i.lead]);
  const blocked = async (blocker = a, waiting = b) => {
    const aPid = (await row(blocker, 'select pg_backend_pid() as pid')).pid;
    // A pending query occupies waiting; its PID is captured before starting it.
    const bPid = waiting === b ? bBackend : aBackend;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if ((await row(db, 'select $1::int=any(pg_blocking_pids($2::int)) as blocked', [aPid, bPid])).blocked) return;
      await delay(15);
    }
    assert.fail('A real PostgreSQL lock wait, not elapsed time, is required');
  };
  const aBackend = (await row(a, 'select pg_backend_pid() as pid')).pid;
  const bBackend = (await row(b, 'select pg_backend_pid() as pid')).pid;
  assert.notEqual(aBackend, bBackend);
  return { ...i, a, b, leads, pipeline, context, arrivals, changeStage, booking, confirm,
    controlCall, arrivedBooking, arrivalState, state, revoke, blocked };
}

test('external operator access and revocation on disposable PostgreSQL', { timeout: 300000 }, async t => {
  const fixture = await startDisposablePostgres();
  t.after(async () => { await fixture.close(); t.diagnostic('Owned server stopped and disposable run directory removed'); });
  const db = await fixture.connect();
  await db.query('create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to service_role');
  const numbers = new Set([9, 10, 11, 12, 13, 14, 19, 20, 29, 30, 32, 33, 34, 36, 40, 43, 45,
    52, 53, 54, 55, 56, 57, 61, 63, 64, 66, 72, 73, 74]);
  for (const file of (await readdir(path.join(root, 'migrations'))).sort()) {
    if (numbers.has(Number(file.slice(0, 3)))) {
      const source = await readFile(path.join(root, 'migrations', file), 'utf8');
      await db.query(source);
      if (Number(file.slice(0, 3)) === 74) await db.query(source);
    }
  }
  t.diagnostic(`PostgreSQL ${(await row(db, 'show server_version')).server_version}; local synthetic data only; no external URL accepted`);

  await t.test('assigned access is independent of staff membership and returns minimal contact data', async t => {
    const f = await makeCase(fixture, db, t);
    assert.equal((await row(db, 'select count(*)::int as n from staff_users where auth_user_id=$1', [f.user])).n, 0);
    const rows = (await f.leads()).rows;
    assert.deepEqual(rows.map(r => r.id), [f.lead]);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['created_at', 'full_name', 'id', 'phone', 'source', 'status']);
    assert.deepEqual((await f.pipeline()).result.items.map(r => r.id), [f.lead]);
    assert.deepEqual((await f.context()).result, { timeZone: 'UTC' });
    assert.deepEqual((await f.arrivals()).result, { items: [] });
    await denied(f.context(f.b, f.unassigned));
    await denied(f.context(f.b, f.foreignLead));
    await denied(f.changeStage(f.b, f.unassigned));
    await denied(f.changeStage(f.b, f.foreignLead));
  });

  await t.test('clinic scope includes only its own workspace and cannot be broadened in place', async t => {
    const f = await makeCase(fixture, db, t, 'clinic');
    assert.deepEqual(new Set((await f.leads()).rows.map(r => r.id)), new Set([f.lead, f.unassigned]));
    assert.deepEqual((await f.context(f.b, f.unassigned)).result, { timeZone: 'UTC' });
    await denied(f.context(f.b, f.foreignLead));
    await assert.rejects(db.query("update growth_operator_requests set lead_scope='assigned' where id=$1", [f.request]),
      { code: 'P0001', message: 'operator_scope_immutable' });
  });

  await t.test('wrong identity and another operator agreement do not reveal contacts or permit writes', async t => {
    const f = await makeCase(fixture, db, t), before = await f.state();
    await denied(f.leads(f.b, f.request, f.otherUser));
    await denied(f.leads(f.b, f.otherRequest, f.user));
    await denied(f.context(f.b, f.lead, f.otherUser));
    await denied(f.changeStage(f.b, f.lead, f.stage, f.otherUser));
    await denied(f.booking(f.b, f.lead, randomUUID(), f.otherUser));
    await arrivalDenied(f.arrivals(f.b, f.otherUser));
    assert.deepEqual(await f.state(), before);
  });

  for (const status of ['pending', 'suspended']) {
    await t.test(`${status} profile denies reads and writes even with a retained accepted agreement`, async t => {
      const f = await makeCase(fixture, db, t), before = await f.state();
      await db.query('update growth_operator_profiles set status=$1,accepting_requests=false where id=$2', [status, f.profile]);
      await denied(f.leads()); await denied(f.pipeline()); await denied(f.context());
      await denied(f.changeStage()); await denied(f.booking()); await arrivalDenied(f.arrivals());
      assert.deepEqual(await f.state(), before);
    });
  }

  await t.test('assignment revocation removes contacts and denies a held draft and new booking without side effects', async t => {
    const f = await makeCase(fixture, db, t), before = await f.state();
    await f.b.query('select public.set_growth_operator_lead_assignment($1,$2,$3,false)', [f.request, f.lead, f.staff]);
    assert.deepEqual((await f.leads()).rows, []);
    assert.deepEqual((await f.pipeline()).result.items, []);
    await denied(f.context()); await denied(f.changeStage()); await denied(f.booking());
    const after = await f.state();
    assert.deepEqual(after, { ...before, audits: before.audits + 1 });
  });

  await t.test('ending cooperation denies every operator read/write and cannot be silently reaccepted', async t => {
    const f = await makeCase(fixture, db, t), before = await f.state();
    await f.revoke('agreement');
    await denied(f.leads()); await denied(f.pipeline()); await denied(f.context());
    await denied(f.changeStage()); await denied(f.booking()); await arrivalDenied(f.arrivals());
    await assert.rejects(f.b.query('select public.accept_growth_operator_request($1,$2)', [f.request, f.user]),
      { code: 'P0001', message: 'agreed_terms_required' });
    assert.deepEqual(await f.state(), before);
  });

  await t.test('booking replay rechecks permission after assignment revocation', async t => {
    const f = await makeCase(fixture, db, t), key = randomUUID();
    await f.booking(f.b, f.lead, key);
    const before = await f.state();
    assert.equal(before.appointments, 1); assert.equal(before.clients, 1); assert.equal(before.bookings, 1);
    await f.revoke('assignment');
    await denied(f.booking(f.b, f.lead, key));
    assert.deepEqual(await f.state(), before);
  });

  for (const kind of ['profile', 'agreement', 'assignment']) {
    for (const action of ['changeStage', 'booking']) {
      await t.test(`committing ${kind} revocation before a waiting ${action} denies the write`, async t => {
        const f = await makeCase(fixture, db, t), before = await f.state();
        await f.a.query('begin'); await f.revoke(kind);
        const pending = observed(f[action]());
        await f.blocked();
        await f.a.query('commit');
        const result = await pending;
        assert.equal(result.error?.code, 'P0001');
        assert.equal(result.error?.message, 'operator_access_denied');
        assert.deepEqual(await f.state(), before);
      });
    }
  }

  await t.test('a write holding approval first completes before suspension, then the next request is denied', async t => {
    const f = await makeCase(fixture, db, t);
    await f.b.query('begin'); await f.changeStage();
    const pending = observed(f.revoke('profile'));
    await f.blocked(f.b, f.a);
    await f.b.query('commit');
    const result = await pending;
    assert.equal(result.error, undefined);
    await denied(f.context());
    const state = await f.state();
    assert.equal(state.leads.find(l => l.id === f.lead).stage_id, f.stage);
    assert.equal(state.appointments, 0); assert.equal(state.deals, 0);
  });

  await t.test('arrival confirmation and all call results are idempotent and never create a sale', async t => {
    const f = await makeCase(fixture, db, t), appointment = await f.arrivedBooking();
    const { id } = await f.confirm(appointment);
    const first = await f.arrivalState();
    assert.equal(first.receipts.length, 1);
    assert.equal(first.receipts[0].price_minor, 0);
    assert.equal(first.receipts[0].currency, 'KZT');
    assert.equal(first.receipts[0].operator_check_result, null);
    assert.equal((await f.confirm(appointment)).id, id);
    assert.deepEqual(await f.arrivalState(), first);
    for (const result of ['confirmed', 'unconfirmed', 'unreachable']) {
      assert.equal((await f.controlCall(id, result)).id, id);
      const saved = await f.arrivalState();
      assert.equal(saved.receipts[0].operator_check_result, result);
      assert.notEqual(saved.receipts[0].operator_checked_at, null);
      assert.equal(saved.deals, 0);
      assert.equal(saved.audits.at(-1).action, 'operator_arrival_control_call');
      assert.deepEqual(Object.keys(saved.audits.at(-1).metadata).sort(),
        ['operator_request_id', 'previous_result', 'result']);
      await f.controlCall(id, result);
      assert.deepEqual(await f.arrivalState(), saved);
    }
    const own = (await f.arrivals()).result.items;
    assert.deepEqual(own.map(item => item.arrival_id), [id]);
    assert.equal(own[0].client_phone, '+70000000000');
    assert.equal(Object.hasOwn(own[0], 'notes'), false);
    const before = await f.arrivalState();
    await arrivalDenied(f.controlCall(id, 'confirmed', f.b, f.otherUser));
    await arrivalDenied(f.arrivals(f.b, f.otherUser));
    assert.deepEqual(await f.arrivalState(), before);
  });

  for (const kind of ['profile', 'agreement']) {
    await t.test(`committed ${kind} revocation denies a control call waiting on its receipt`, async t => {
      const f = await makeCase(fixture, db, t), appointment = await f.arrivedBooking();
      const { id } = await f.confirm(appointment), before = await f.arrivalState();
      await f.a.query('begin');
      await f.revoke(kind);
      await f.a.query('select id from growth_operator_arrivals where id=$1 for update', [id]);
      const pending = observed(f.controlCall(id));
      await f.blocked();
      await f.a.query('commit');
      const result = await pending;
      assert.equal(result.error?.code, 'P0001');
      assert.equal(result.error?.message, 'operator_arrival_access_denied');
      assert.deepEqual(await f.arrivalState(), before);
      await arrivalDenied(f.controlCall(id));
    });
  }

  for (const change of ["status='inactive'", "role='doctor'"]) {
    await t.test(`${change} denies a clinic confirmation waiting on its appointment`, async t => {
      const f = await makeCase(fixture, db, t), appointment = await f.arrivedBooking();
      const before = await f.arrivalState();
      await f.a.query('begin');
      await f.a.query(`update staff_users set ${change} where id=$1`, [f.staff]);
      await f.a.query('select id from appointments where id=$1 for update', [appointment]);
      const pending = observed(f.confirm(appointment));
      await f.blocked();
      await f.a.query('commit');
      const result = await pending;
      assert.equal(result.error?.code, 'P0001');
      assert.equal(result.error?.message, 'clinic_confirmation_required');
      assert.deepEqual(await f.arrivalState(), before);
    });
  }

  await t.test('a control call holding approval first completes before revocation; its replay is denied', async t => {
    const f = await makeCase(fixture, db, t), appointment = await f.arrivedBooking();
    const { id } = await f.confirm(appointment);
    await f.b.query('begin');
    await f.controlCall(id);
    const pending = observed(f.revoke('profile'));
    await f.blocked(f.b, f.a);
    await f.b.query('commit');
    assert.equal((await pending).error, undefined);
    const before = await f.arrivalState();
    assert.equal(before.receipts[0].operator_check_result, 'confirmed');
    await arrivalDenied(f.controlCall(id));
    assert.deepEqual(await f.arrivalState(), before);
  });

  await t.test('a clinic confirmation holding staff permission first completes before membership revocation', async t => {
    const f = await makeCase(fixture, db, t), appointment = await f.arrivedBooking();
    await f.b.query('begin');
    const { id } = await f.confirm(appointment);
    const pending = observed(f.a.query("update staff_users set status='inactive' where id=$1", [f.staff]));
    await f.blocked(f.b, f.a);
    await f.b.query('commit');
    assert.equal((await pending).error, undefined);
    const before = await f.arrivalState();
    assert.equal(before.receipts[0].id, id);
    await assert.rejects(f.confirm(appointment), { code: 'P0001', message: 'clinic_confirmation_required' });
    assert.deepEqual(await f.arrivalState(), before);
  });

  await t.test('browser roles have neither table access nor execution of server-only operator RPCs', async t => {
    const f = await makeCase(fixture, db, t);
    for (const role of ['anon', 'authenticated']) {
      await f.a.query(`set role ${role}`);
      for (const table of ['growth_operator_profiles', 'growth_operator_requests', 'growth_operator_lead_assignments',
        'growth_operator_bookings', 'growth_operator_arrivals']) {
        await assert.rejects(f.a.query(`select * from public.${table}`), { code: '42501' });
      }
      await assert.rejects(f.leads(f.a), { code: '42501' });
      await assert.rejects(f.context(f.a), { code: '42501' });
      await assert.rejects(f.changeStage(f.a), { code: '42501' });
      await assert.rejects(f.arrivals(f.a), { code: '42501' });
      await assert.rejects(f.confirm(randomUUID(), f.a), { code: '42501' });
      await assert.rejects(f.controlCall(randomUUID(), 'confirmed', f.a), { code: '42501' });
      await f.a.query('reset role');
    }
    for (const sql of [
      'select public.confirm_growth_operator_arrival($1,$2,$3)',
      "select public.record_growth_operator_check($1,$2,'confirmed')",
    ]) {
      const args = sql.includes('confirm_growth')
        ? [f.request, randomUUID(), f.staff] : [randomUUID(), f.user];
      await assert.rejects(f.b.query(sql, args), { code: '42501' });
    }
    const rls = await db.query(`select relrowsecurity from pg_class where oid=any($1::regclass[])`, [[
      'public.growth_operator_profiles', 'public.growth_operator_requests', 'public.growth_operator_lead_assignments',
      'public.growth_operator_bookings', 'public.growth_operator_arrivals']]);
    assert.equal(rls.rows.length, 5); assert.ok(rls.rows.every(r => r.relrowsecurity));
  });
});

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startDisposablePostgres } from './disposable-postgres.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const row = async (client, sql, values = []) => (await client.query(sql, values)).rows[0];
const observed = promise => promise.then(value => ({ value }), error => ({ error }));
const denied = (promise, message) => assert.rejects(promise, { code: 'P0001', message });

async function makeCase(fixture, db, t) {
  const { a, b } = fixture.lifecycleConnections;
  t.after(async () => {
    await a.query('rollback').catch(() => {});
    await b.query('rollback').catch(() => {});
  });
  const ids = Object.fromEntries(['workspace', 'foreignWorkspace', 'owner', 'replacement',
    'foreignStaff', 'ownerAuth', 'profile', 'user', 'otherProfile', 'otherUser', 'request']
    .map(key => [key, randomUUID()]));
  const i = ids;
  for (const workspace of [i.workspace, i.foreignWorkspace]) {
    await db.query("insert into workspaces(id,name) values($1,'Disposable operator lifecycle fixture')", [workspace]);
  }
  for (const [id, workspace, auth] of [[i.owner, i.workspace, i.ownerAuth],
    [i.replacement, i.workspace, randomUUID()], [i.foreignStaff, i.foreignWorkspace, randomUUID()]]) {
    await db.query(`insert into staff_users(id,workspace_id,auth_user_id,full_name,email,role,status)
      values($1,$2,$3,'Disposable staff',$4,'owner','active')`, [id, workspace, auth, `${id}@example.invalid`]);
  }
  for (const [id, auth] of [[i.profile, i.user], [i.otherProfile, i.otherUser]]) {
    await db.query(`insert into growth_operator_profiles(id,auth_user_id,display_name,status,
      accepting_requests,approved_by,approved_at)
      values($1,$2,'Disposable operator','approved',true,$3,clock_timestamp())`, [id, auth, randomUUID()]);
  }
  await b.query('set role service_role');
  const bPid = (await row(b, 'select pg_backend_pid() as pid')).pid;
  const aPid = (await row(a, 'select pg_backend_pid() as pid')).pid;
  const blocked = async (blocker = aPid, waiter = bPid) => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if ((await row(db, 'select $1::int=any(pg_blocking_pids($2::int)) as blocked', [blocker, waiter])).blocked) return;
      await delay(10);
    }
    assert.fail('A real PostgreSQL lock wait is required, not an elapsed-time assumption');
  };
  const create = (client = db, options = {}) => client.query(`insert into growth_operator_requests
    (id,workspace_id,operator_id,requested_by_staff_user_id,clinic_brief,price_per_arrival_minor,currency,lead_scope)
    values($1,$2,$3,$4,'Synthetic request; no commercial agreement',0,'KZT','assigned') returning id`,
  [options.id ?? i.request, options.workspace ?? i.workspace, options.profile ?? i.profile, options.staff ?? i.owner]);
  const accept = (client = b, user = i.user, request = i.request) => row(client,
    'select public.accept_growth_operator_request($1,$2) as id', [request, user]);
  // These predicates reproduce the current API's actual PostgREST CAS shapes.
  // They are not actor-verifying RPCs; that remaining boundary is reported explicitly.
  // SQL lifecycle cases use a database timestamp, preserving microseconds.
  // The API's separate JavaScript clock/rounding is not accepted by this fixture.
  const clinicTransition = (client = b, action = 'withdraw', workspace = i.workspace) => client.query(`
    update growth_operator_requests set status=$3,
      ended_at=case when $3='ended' then greatest(clock_timestamp(),accepted_at) else null end
    where id=$1 and workspace_id=$2 and status=$4 returning id`,
  [i.request, workspace, action === 'end' ? 'ended' : 'declined',
    action === 'end' ? 'accepted' : 'requested']);
  const operatorTransition = (client = b, action = 'decline', profile = i.profile) => client.query(`
    update growth_operator_requests set status=$3,
      ended_at=case when $3='ended' then greatest(clock_timestamp(),accepted_at) else null end
    where id=$1 and operator_id=$2 and status=$4 returning id`,
  [i.request, profile, action === 'end' ? 'ended' : 'declined',
    action === 'end' ? 'accepted' : 'requested']);
  const state = () => row(db, 'select * from growth_operator_requests where id=$1', [i.request]);
  const unrelated = async () => (await db.query(`select 'staff' as kind,to_jsonb(s) as value from staff_users s
    where workspace_id=$1 union all select 'profile',to_jsonb(p) from growth_operator_profiles p where id=$2
    order by kind`, [i.foreignWorkspace, i.otherProfile])).rows;
  return { ...i, a, b, aPid, bPid, blocked, create, accept, clinicTransition, operatorTransition, state, unrelated };
}

test('operator request lifecycle uses actual SQL on owned disposable PostgreSQL', { timeout: 300000 }, async t => {
  const fixture = await startDisposablePostgres();
  t.after(async () => {
    await fixture.close();
    t.diagnostic('Owned disposable server stopped and run directory removed; no external database URL accepted');
  });
  const db = await fixture.connect();
  await db.query(`create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon,authenticated,service_role`);
  // This deliberately is not the whole migration chain. In particular dirty
  // Foreign 059, unrelated 065 and arrival/payment RPCs are not read or applied.
  const numbers = new Set([9, 10, 11, 23, 29, 34, 52, 53, 54, 94]);
  const applied = [];
  for (const file of (await readdir(path.join(root, 'migrations'))).sort()) {
    if (!numbers.has(Number(file.slice(0, 3)))) continue;
    const source = await readFile(path.join(root, 'migrations', file), 'utf8');
    await db.query(source);
    if (Number(file.slice(0, 3)) === 94) await db.query(source);
    applied.push({ file, sha256: createHash('sha256').update(source).digest('hex') });
  }
  t.diagnostic(`Actual tested sources: ${JSON.stringify(applied)}`);
  t.diagnostic(`PostgreSQL ${(await row(db, 'show server_version')).server_version}; local synthetic data only`);
  // Core staff table predates explicit server grants. These are the existing
  // server's lookup/edit privileges, not browser access or new migration grants.
  await db.query('grant select,update on public.staff_users to service_role');
  // Reuse two distinct sessions across UUID-isolated cases. Every case rolls
  // back both sessions; the fixture owns and closes them with its server.
  fixture.lifecycleConnections = { a: await fixture.connect(), b: await fixture.connect() };

  await t.test('approved exact operator accepts once and exact replay retains accepted terms', async t => {
    const f = await makeCase(fixture, db, t);
    await f.create();
    assert.equal((await f.accept()).id, f.request);
    const before = await f.state();
    assert.equal((await f.accept()).id, f.request);
    assert.deepEqual(await f.state(), before);
    assert.equal(before.status, 'accepted');
    assert.equal(before.price_per_arrival_minor, '0');
    assert.equal(before.currency, 'KZT');
    assert.ok(before.accepted_at);
    assert.equal((await row(db, `select count(*)::int as n from growth_operator_requests
      where workspace_id=$1 and operator_id=$2 and status='accepted'`, [f.workspace, f.profile])).n, 1);
  });

  await t.test('wrong operator, null identity, missing request and another tenant cannot accept', async t => {
    const f = await makeCase(fixture, db, t);
    await f.create();
    const before = await f.state(), foreign = await f.unrelated();
    await denied(f.accept(f.b, f.otherUser), 'approved_operator_required');
    await denied(f.accept(f.b, null), 'approved_operator_required');
    await denied(f.accept(f.b, f.user, randomUUID()), 'operator_request_unavailable');
    const otherRequest = randomUUID();
    await f.create(db, { id: otherRequest, workspace: f.foreignWorkspace, profile: f.otherProfile, staff: f.foreignStaff });
    await denied(f.accept(f.b, f.user, otherRequest), 'approved_operator_required');
    assert.deepEqual(await f.state(), before);
    assert.deepEqual(await f.unrelated(), foreign);
  });

  await t.test('clinic and operator CAS predicates cannot mutate another tenant or profile', async t => {
    const f = await makeCase(fixture, db, t);
    await f.create();
    const before = await f.state();
    assert.equal((await f.clinicTransition(f.b, 'withdraw', f.foreignWorkspace)).rowCount, 0);
    assert.equal((await f.operatorTransition(f.b, 'decline', f.otherProfile)).rowCount, 0);
    assert.deepEqual(await f.state(), before);
  });

  for (const isolation of ['read committed', 'repeatable read', 'serializable']) {
    await t.test(`${isolation}: clinic withdrawal wins the request lock and prevents acceptance/replay`, async t => {
      const f = await makeCase(fixture, db, t);
      await f.create();
      await f.a.query('begin');
      await f.clinicTransition(f.a);
      await f.b.query(`begin isolation level ${isolation}`);
      const pending = observed(f.accept());
      await f.blocked();
      await f.a.query('commit');
      const result = await pending;
      assert.ok(result.error, 'Withdrawn request must not be reported accepted');
      if (isolation === 'read committed') assert.equal(result.error.message, 'agreed_terms_required');
      else assert.equal(result.error.code, '40001');
      await f.b.query('rollback');
      await denied(f.accept(), 'agreed_terms_required');
      assert.equal((await f.state()).status, 'declined');
      assert.equal((await f.state()).accepted_at, null);
    });

    await t.test(`${isolation}: operator acceptance wins and stale clinic withdrawal returns zero rows`, async t => {
      const f = await makeCase(fixture, db, t);
      await f.create();
      await f.a.query('begin');
      assert.equal((await f.accept(f.a)).id, f.request);
      await f.b.query(`begin isolation level ${isolation}`);
      const pending = observed(f.clinicTransition());
      await f.blocked();
      await f.a.query('commit');
      const result = await pending;
      if (isolation === 'read committed') assert.equal(result.value.rowCount, 0);
      else assert.equal(result.error?.code, '40001');
      await f.b.query('rollback');
      assert.equal((await f.state()).status, 'accepted');
      assert.equal((await f.operatorTransition()).rowCount, 0);
    });

    await t.test(`${isolation}: cooperation ending while replay waits never returns accepted`, async t => {
      const f = await makeCase(fixture, db, t);
      await f.create(); await f.accept();
      await f.a.query('begin');
      await f.operatorTransition(f.a, 'end');
      await f.b.query(`begin isolation level ${isolation}`);
      const pending = observed(f.accept());
      await f.blocked();
      await f.a.query('commit');
      const result = await pending;
      assert.ok(result.error);
      if (isolation === 'read committed') assert.equal(result.error.message, 'agreed_terms_required');
      else assert.equal(result.error.code, '40001');
      await f.b.query('rollback');
      await denied(f.accept(), 'agreed_terms_required');
      assert.equal((await f.state()).status, 'ended');
    });

    for (const alreadyAccepted of [false, true]) {
      await t.test(`${isolation}: profile revocation during ${alreadyAccepted ? 'accepted replay' : 'acceptance'} is rechecked after its lock`, async t => {
        const f = await makeCase(fixture, db, t);
        await f.create();
        if (alreadyAccepted) await f.accept();
        const before = await f.state();
        await f.a.query('begin');
        await f.a.query("update growth_operator_profiles set status='suspended',accepting_requests=false where id=$1", [f.profile]);
        await f.b.query(`begin isolation level ${isolation}`);
        const pending = observed(f.accept());
        await f.blocked();
        await f.a.query('commit');
        const result = await pending;
        assert.ok(result.error, 'A suspended operator must never get an accepted response');
        if (isolation === 'read committed') assert.equal(result.error.message, 'approved_operator_required');
        else assert.equal(result.error.code, '40001');
        await f.b.query('rollback');
        await denied(f.accept(), 'approved_operator_required');
        assert.deepEqual(await f.state(), before);
      });
    }
  }

  await t.test('two concurrent accepts serialize to one immutable accepted cooperation', async t => {
    const f = await makeCase(fixture, db, t);
    await f.create();
    await f.a.query('begin');
    assert.equal((await f.accept(f.a)).id, f.request);
    const accepted = await row(f.a, 'select * from growth_operator_requests where id=$1', [f.request]);
    const pending = observed(f.accept());
    await f.blocked();
    await f.a.query('commit');
    assert.equal((await pending).value.id, f.request);
    assert.deepEqual(await f.state(), accepted);
  });

  await t.test('concurrent duplicate proposals cannot create two live agreements', async t => {
    const f = await makeCase(fixture, db, t);
    await f.a.query('begin'); await f.create(f.a);
    const pending = observed(f.create(f.b, { id: randomUUID() }));
    await f.blocked();
    await f.a.query('commit');
    assert.equal((await pending).error?.code, '23505');
    assert.equal((await row(db, `select count(*)::int as n from growth_operator_requests
      where workspace_id=$1 and operator_id=$2 and status in ('requested','accepted')`, [f.workspace, f.profile])).n, 1);
  });

  await t.test('a declined request is historical; a new proposal has a new identity and may be accepted', async t => {
    const f = await makeCase(fixture, db, t);
    await f.create(); await f.operatorTransition();
    const old = await f.state(), next = randomUUID();
    await f.create(f.b, { id: next });
    assert.equal((await f.accept(f.b, f.user, next)).id, next);
    await denied(f.accept(), 'agreed_terms_required');
    assert.deepEqual(await f.state(), old);
  });

  await t.test('former requester does not freeze a valid historical proposal or ending by current staff', async t => {
    const f = await makeCase(fixture, db, t);
    await f.create();
    await db.query("update staff_users set status='inactive',role='doctor' where id=$1", [f.owner]);
    assert.equal((await f.accept()).id, f.request);
    assert.equal((await f.clinicTransition(f.b, 'end')).rowCount, 1);
    assert.equal((await f.state()).status, 'ended');
  });

  await t.test('accepted terms, scope, workspace, operator and original requester remain immutable', async t => {
    const f = await makeCase(fixture, db, t);
    await f.create(); await f.accept();
    const before = await f.state();
    for (const [sql, values, message] of [
      ['price_per_arrival_minor=1', [], 'accepted_terms_immutable'],
      ["currency='USD'", [], 'accepted_terms_immutable'],
      ["accepted_at=accepted_at+interval '1 second'", [], 'accepted_terms_immutable'],
      ["lead_scope='clinic'", [], 'operator_scope_immutable'],
      ['workspace_id=$2', [f.foreignWorkspace], 'operator_request_identity_immutable'],
      ['operator_id=$2', [f.otherProfile], 'operator_request_identity_immutable'],
      ['requested_by_staff_user_id=$2', [f.replacement], 'operator_request_identity_immutable'],
    ]) {
      await denied(f.b.query(`update growth_operator_requests set ${sql} where id=$1`, [f.request, ...values]), message);
    }
    assert.deepEqual(await f.state(), before);
  });

  for (const target of ['profile', 'staff']) {
    for (const isolation of ['read committed', 'repeatable read', 'serializable']) {
      await t.test(`${isolation}: request creation rechecks ${target} revocation after a real row-lock wait`, async t => {
        const f = await makeCase(fixture, db, t), unrelated = await f.unrelated();
        const table = target === 'profile' ? 'growth_operator_profiles' : 'staff_users';
        const id = target === 'profile' ? f.profile : f.owner;
        await f.a.query('begin');
        await f.a.query(`select id from ${table} where id=$1 for update`, [id]);
        await f.b.query(`begin isolation level ${isolation}`);
        const pending = observed(f.create(f.b));
        await f.blocked();
        await f.a.query(target === 'profile'
          ? "update growth_operator_profiles set status='suspended',accepting_requests=false where id=$1"
          : "update staff_users set status='inactive' where id=$1", [id]);
        await f.a.query('commit');
        const result = await pending;
        assert.ok(result.error, 'No proposal may be admitted from a stale approval or staff permission');
        if (isolation === 'read committed') {
          assert.equal(result.error.message, target === 'profile' ? 'operator_not_accepting_requests' : 'clinic_requester_required');
        } else assert.equal(result.error.code, '40001');
        await f.b.query('rollback');
        assert.equal(await f.state(), undefined);
        assert.deepEqual(await f.unrelated(), unrelated);
      });
    }

    await t.test(`request admission holds ${target} permission until its transaction commits`, async t => {
      const f = await makeCase(fixture, db, t);
      await f.b.query('begin');
      await f.create(f.b);
      const pending = observed(target === 'profile'
        ? f.a.query("update growth_operator_profiles set status='suspended',accepting_requests=false where id=$1", [f.profile])
        : f.a.query("update staff_users set status='inactive' where id=$1", [f.owner]));
      await f.blocked(f.bPid, f.aPid);
      await f.b.query('commit');
      assert.equal((await pending).value.rowCount, 1);
      assert.equal((await f.state()).status, 'requested');
      await denied(f.create(f.b, { id: randomUUID() }),
        target === 'profile' ? 'operator_not_accepting_requests' : 'clinic_requester_required');
    });

    await t.test(`ordinary non-key ${target} UPDATE is also a real admission barrier`, async t => {
      const f = await makeCase(fixture, db, t);
      await f.a.query('begin');
      await f.a.query(target === 'profile'
        ? "update growth_operator_profiles set status='suspended',accepting_requests=false where id=$1"
        : "update staff_users set status='inactive' where id=$1", [target === 'profile' ? f.profile : f.owner]);
      const pending = observed(f.create(f.b));
      await f.blocked();
      await f.a.query('commit');
      assert.equal((await pending).error?.message,
        target === 'profile' ? 'operator_not_accepting_requests' : 'clinic_requester_required');
      assert.equal(await f.state(), undefined);
    });
  }

  for (const invalid of ['foreign_staff', 'inactive', 'role', 'unapproved', 'not_accepting']) {
    await t.test(`proposal admission rejects ${invalid} without creating cooperation`, async t => {
      const f = await makeCase(fixture, db, t);
      let options = {}, message = 'clinic_requester_required';
      if (invalid === 'foreign_staff') options = { staff: f.foreignStaff };
      else if (invalid === 'inactive') await db.query("update staff_users set status='inactive' where id=$1", [f.owner]);
      else if (invalid === 'role') await db.query("update staff_users set role='doctor' where id=$1", [f.owner]);
      else {
        await db.query(`update growth_operator_profiles set accepting_requests=false,
          status=$2 where id=$1`, [f.profile, invalid === 'unapproved' ? 'pending' : 'approved']);
        message = 'operator_not_accepting_requests';
      }
      await denied(f.create(f.b, options), message);
      assert.equal(await f.state(), undefined);
    });
  }

  await t.test('browser roles have neither request data access nor lifecycle RPC execution', async t => {
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await row(db, "select has_function_privilege($1,'public.accept_growth_operator_request(uuid,uuid)','execute') as allowed", [role])).allowed, false);
      assert.equal((await row(db, "select has_table_privilege($1,'public.growth_operator_requests','select,insert,update,delete') as allowed", [role])).allowed, false);
      const client = await fixture.connect();
      try {
        await client.query(`set role ${role}`);
        await assert.rejects(client.query('select public.accept_growth_operator_request($1,$2)', [randomUUID(), randomUUID()]), { code: '42501' });
        await assert.rejects(client.query('select * from growth_operator_requests'), { code: '42501' });
      } finally { await client.end(); }
    }
    const flags = await row(db, `select relrowsecurity from pg_class where oid='public.growth_operator_requests'::regclass`);
    assert.equal(flags.relrowsecurity, true);
  });

  await t.test('no payment, operator arrival, ledger or workspace membership was manufactured', async () => {
    for (const table of ['growth_operator_arrivals', 'platform_subscription_payments',
      'growth_partner_commissions', 'growth_partner_payouts', 'platform_subscriptions']) {
      assert.equal((await row(db, `select count(*)::int as n from ${table}`)).n, 0);
    }
    assert.equal((await row(db, `select count(*)::int as n from staff_users s join growth_operator_profiles p
      on p.auth_user_id=s.auth_user_id`)).n, 0);
  });
});

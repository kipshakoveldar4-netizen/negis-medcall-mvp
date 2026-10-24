import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startDisposablePostgres } from './disposable-postgres.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const migrationPath = path.join(root, 'migrations/083_lead_team_analytics_snapshot.sql');
const signature = 'public.read_lead_team_analytics(uuid,uuid,uuid,integer)';
const migrations = [
  '009_medcall_mvp_persistence.sql', '010_staff_ready_crm.sql', '011_staff_auth_foundation.sql',
  '014_meta_ad_launches.sql', '019_crm_lead_pipeline_foundation.sql',
  '028_leads_phone_normalized.sql', '038_staff_join_requests.sql',
  '069_assigned_lead_manager.sql', '070_mortgage_workspace.sql',
];
const row = async (db, sql, params = []) => (await db.query(sql, params)).rows[0];
const identity = p => [p.workspace, p.id, p.auth];
const read = async (db, p, ...days) => (await row(db,
  `select public.read_lead_team_analytics($1,$2,$3${days.length ? ',$4::integer' : ''}) as result`,
  [...identity(p), ...days])).result;
const member = (result, p) => {
  const item = result.members.find(m => m.staffId === p.id);
  assert.ok(item, `Expected report member ${p.id}`);
  return item;
};
const assigned = (values = {}) => ({ total: 0, new: 0, inProgress: 0, booked: 0,
  postponed: 0, lost: 0, other: 0, ...values });
const emptyActivity = () => ({ createdEvents: 0, updatedEvents: 0, touchedLeads: 0, lastRecordedAt: null });
const observed = promise => promise.then(value => ({ value }), error => ({ error }));
const hash = source => createHash('sha256').update(source).digest('hex');

async function expectError(operation, code) {
  await assert.rejects(operation, error => {
    assert.equal(error.code, code, error.message);
    return true;
  }, `Expected PostgreSQL ${code}, not a plausible partial result`);
}

async function rollback(db, operation) {
  await db.query('begin');
  try { return await operation(); }
  finally { await db.query('rollback'); }
}

async function deniedInTransaction(db, operation, code) {
  await db.query('savepoint expected_denial');
  try { await expectError(operation(), code); }
  finally { await db.query('rollback to savepoint expected_denial'); }
}

async function workspace(db, name = 'Synthetic analytics') {
  const id = randomUUID();
  await db.query('insert into public.workspaces(id,name) values($1,$2)', [id, name]);
  await db.query(`insert into public.workspace_settings(workspace_id,key,value)
    values($1,'workspace_purpose','{"purpose":"mortgage_leads"}')`, [id]);
  return id;
}

async function person(db, workspaceId, role, name, status = 'active') {
  const p = { workspace: workspaceId, id: randomUUID(), auth: randomUUID(), role, name, status };
  await db.query(`insert into public.staff_users
    (id,workspace_id,auth_user_id,email,full_name,role,status) values($1,$2,$3,$4,$5,$6,$7)`,
  [p.id, p.workspace, p.auth, `${p.id}@example.invalid`, name, role, status]);
  return p;
}

async function lead(db, workspaceId, assignee, status = 'new', stage = null) {
  const id = randomUUID();
  await db.query(`insert into public.leads
    (id,workspace_id,responsible_user_id,status,stage_id,full_name,phone,notes)
    values($1,$2,$3,$4,$5,'PRIVATE_CONTACT_SENTINEL','+77000000000','PRIVATE_NOTES_SENTINEL')`,
  [id, workspaceId, assignee, status, stage]);
  return id;
}

async function event(db, workspaceId, actor, entity, action = 'updated', at = null,
  kind = 'manual', type = 'lead') {
  return (await row(db, `insert into public.audit_logs
    (workspace_id,actor_staff_user_id,entity_id,action,created_at,actor_kind,entity_type,metadata,actor_name)
    values($1,$2,$3,$4,coalesce($5::timestamptz,statement_timestamp()-interval '1 minute'),$6,$7,
      '{"private":"PRIVATE_AUDIT_SENTINEL"}','Historic actor name') returning id`,
  [workspaceId, actor, entity, action, at, kind, type])).id;
}

function assertShape(result, workspaceId, days = 30) {
  assert.deepEqual(Object.keys(result).sort(), ['workspaceId', 'generatedAt', 'period', 'totalLeads',
    'unassignedLeads', 'otherAssigneeLeads', 'activityStatus', 'members'].sort());
  assert.equal(result.workspaceId, workspaceId);
  assert.equal(result.period.days, days);
  assert.equal(result.generatedAt, result.period.to);
  assert.equal(Date.parse(result.period.to) - Date.parse(result.period.from), days * 86400000);
  assert.ok(Number.isFinite(Date.parse(result.generatedAt)));
  const seen = new Set();
  let total = result.unassignedLeads + result.otherAssigneeLeads;
  for (const m of result.members) {
    assert.deepEqual(Object.keys(m).sort(), ['staffId', 'name', 'role', 'status', 'assigned', 'activity'].sort());
    assert.equal(seen.has(m.staffId), false);
    seen.add(m.staffId);
    assert.deepEqual(Object.keys(m.assigned).sort(), Object.keys(assigned()).sort());
    assert.equal(m.assigned.total, ['new', 'inProgress', 'booked', 'postponed', 'lost', 'other']
      .reduce((n, bucket) => n + m.assigned[bucket], 0));
    total += m.assigned.total;
    if (result.activityStatus === 'available') {
      assert.deepEqual(Object.keys(m.activity).sort(), Object.keys(emptyActivity()).sort());
      assert.ok(m.activity.touchedLeads <= m.activity.updatedEvents + m.activity.createdEvents);
    } else assert.equal(m.activity, null);
  }
  assert.equal(total, result.totalLeads);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_(CONTACT|NOTES|AUDIT)_SENTINEL/);
}

async function waitForBlock(db, waiter, holder) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await row(db, 'select pg_blocking_pids($1) as pids', [waiter])).pids.includes(holder)) return;
    await delay(15);
  }
  assert.fail('Expected an observed PostgreSQL lock wait, not a timing-only race');
}

async function seed(db) {
  const w = await workspace(db), foreign = await workspace(db, 'Foreign analytics');
  const owner = await person(db, w, 'owner', 'Owner');
  const admin = await person(db, w, 'admin', 'Admin');
  const a = await person(db, w, 'lead_manager', 'Manager A');
  const b = await person(db, w, 'lead_manager', 'Manager B', 'inactive');
  const nonmember = await person(db, w, 'receptionist', 'Not a report member');
  const outsider = await person(db, foreign, 'owner', 'FOREIGN_MEMBER_SENTINEL');
  const stages = Object.fromEntries((await db.query(
    'select stage_key,id from public.lead_stages where workspace_id=$1', [w])).rows
    .map(s => [s.stage_key, s.id]));
  const foreignStage = (await row(db, `select id from public.lead_stages
    where workspace_id=$1 and stage_key='booked'`, [foreign])).id;
  await db.query("update public.lead_stages set is_active=false where id=$1", [stages.in_progress]);
  // Expected buckets are explicit test data, independent of the SQL classifier.
  const cases = [
    ['new', null, 'new'], [' NEW ', null, 'new'], ['\t\u00a0NEW\u00a0\t', null, 'new'],
    ['\u041d\u043e\u0432\u0430\u044f', null, 'new'],
    ['in_progress', null, 'inProgress'], ['\u0412 \u0440\u0430\u0431\u043e\u0442\u0435', null, 'inProgress'],
    ['booked', null, 'booked'], ['\u0417\u0430\u043f\u0438\u0441\u0430\u043d\u0430', null, 'booked'],
    ['lost', null, 'lost'], ['\u041f\u043e\u0442\u0435\u0440\u044f\u043d\u0430', null, 'lost'],
    ...['postponed', 'deferred', ' DEFERRED ', '\ufeff\u2007deferred\u202f',
      '\t\u00a0\u041e\u0422\u041b\u041e\u0416\u0415\u041d\u0410\u00a0\t', '\u041e\u0442\u043b\u043e\u0436\u0435\u043d\u0430',
      ' \u041e\u0422\u041b\u041e\u0416\u0415\u041d\u041d\u042b\u0415 ', '\u041e\u0442\u043b\u043e\u0436\u0435\u043d\u043e',
      '\u041e\u0442\u043b\u043e\u0436\u0435\u043d'].map(s => [s, null, 'postponed']),
    ...['postponed_custom', 'deferred_custom', 'not_deferred', '\u041e\u0442\u043b\u043e\u0436\u0435\u043d\u043d\u044b\u0439',
      '\u041e\u0442\u043b\u043e\u0436\u0435\u043d\u0430 \u043f\u043e \u043f\u0440\u043e\u0441\u044c\u0431\u0435', '', null, 'unknown']
      .map(s => [s, null, 'other']),
    ['postponed', stages.new, 'new'], ['postponed', stages.in_progress, 'inProgress'],
    ['postponed', stages.booked, 'booked'], ['postponed', stages.lost, 'lost'],
    ['lost', foreignStage, 'lost'],
  ];
  const expected = assigned(), ids = [];
  for (const [status, stage, bucket] of cases) {
    ids.push(await lead(db, w, a.id, status, stage));
    expected.total++;
    expected[bucket]++;
  }
  const inactiveLead = await lead(db, w, b.id, 'lost');
  const adminLead = await lead(db, w, admin.id, 'new');
  await lead(db, w, null);
  await lead(db, w, nonmember.id);
  await lead(db, w, outsider.id);
  await lead(db, foreign, outsider.id);
  const deleted = await lead(db, w, a.id);
  const old = new Date(Date.now() - 120000).toISOString();
  const recent = new Date(Date.now() - 60000).toISOString();
  await event(db, w, b.id, ids[0], 'updated', old);
  await event(db, w, b.id, ` ${ids[0].toUpperCase()} `, 'updated', recent);
  await event(db, w, b.id, ids[1], 'created', old);
  await event(db, w, b.id, deleted, 'updated', old);
  await db.query('delete from public.leads where id=$1', [deleted]);
  await event(db, w, admin.id, inactiveLead, 'updated', old);
  await event(db, foreign, b.id, ids[0]);
  for (const kind of ['integration', 'automation', 'system']) await event(db, w, b.id, 'ignored invalid', 'updated', old, kind);
  await event(db, w, b.id, 'ignored invalid', 'updated', old, 'manual', 'client');
  await event(db, w, b.id, 'ignored invalid', 'deleted', old);
  await event(db, w, b.id, 'ignored invalid', 'updated', new Date(Date.now() - 100 * 86400000).toISOString());
  await event(db, w, b.id, 'ignored invalid', 'updated', new Date(Date.now() + 86400000).toISOString());
  await event(db, w, nonmember.id, 'ignored nonmember invalid');
  await event(db, w, outsider.id, 'ignored foreign actor invalid');
  await event(db, w, null, null);
  return { w, foreign, owner, admin, a, b, nonmember, outsider, stages, ids, expected, recent,
    inactiveLead, adminLead, total: cases.length + 5 };
}

// A missing candidate fails before the harness starts; no URL, .env or cloud fallback exists.
test('lead team analytics 083 on owned disposable PostgreSQL', { timeout: 300000 }, async t => {
  const source = await readFile(migrationPath, 'utf8'), sourceHash = hash(source);
  const fixture = await startDisposablePostgres();
  try {
    const db = await fixture.connect();
    t.diagnostic(`PostgreSQL ${(await row(db, 'show server_version')).server_version}; 083 SHA-256 ${sourceHash}`);
    await db.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls;
      grant usage on schema public to anon,authenticated,service_role`);

    const rejectMissing = async () => {
      try { await expectError(db.query(source), 'P0001'); }
      finally { await db.query('rollback'); }
      assert.equal((await row(db, 'select to_regprocedure($1) as signature', [signature])).signature, null);
    };
    await t.test('preflight rejects missing 070 and 029 without installing a partial function', rejectMissing);
    for (const file of migrations) {
      if (file.startsWith('014_')) {
        const settings = await readFile(path.join(root, 'migrations/013_release_admin_settings.sql'), 'utf8');
        const ddl = settings.match(/create table if not exists public\.workspace_settings\s*\([\s\S]*?\n\);/g);
        assert.equal(ddl?.length, 1, 'Extract only the real 013 workspace_settings DDL');
        await db.query(ddl[0]);
      }
      await db.query(await readFile(path.join(root, 'migrations', file), 'utf8'));
    }
    await t.test('070 alone cannot substitute for the real 029 journal columns', rejectMissing);
    await db.query(await readFile(path.join(root, 'migrations/029_audit_logs_change_journal.sql'), 'utf8'));
    await t.test('029 alone cannot substitute for the real 070 locking authorization helper', async () => {
      await db.query('alter function public.mortgage_actor_role(uuid,uuid,uuid) rename to fixture_hidden_actor_role');
      try { await rejectMissing(); }
      finally { await db.query('alter function public.fixture_hidden_actor_role(uuid,uuid,uuid) rename to mortgage_actor_role'); }
    });
    await db.query(source);
    const definition = (await row(db, 'select pg_get_functiondef($1::regprocedure) as body', [signature])).body;
    await t.test('migration is repeatable, JSONB, security definer and uses the real locking actor helper', async () => {
      await db.query(source);
      const fn = await row(db, `select p.prosecdef,p.proconfig,p.prorettype::regtype::text as result,
        p.pronargdefaults,pg_get_functiondef(p.oid) as body from pg_proc p where p.oid=$1::regprocedure`, [signature]);
      assert.equal(fn.body, definition);
      assert.equal(fn.result, 'jsonb');
      assert.equal(fn.prosecdef, true);
      assert.ok(fn.proconfig.includes('search_path=""'));
      assert.equal(fn.pronargdefaults, 1);
      assert.match(definition, /public\.mortgage_actor_role\s*\(/i);
      assert.match(definition, /statement_timestamp\s*\(/i);
      for (const cap of [1001, 20001, 30001]) assert.match(source, new RegExp(`limit\\s+${cap}\\b`, 'i'));
      assert.ok((definition.match(/as\s+materialized\s*\(/gi) ?? []).length >= 4);
    });
    t.diagnostic('Real 009/010/011/014/019/028/029/038/069/070 + 013 settings table only + 083; no timezone setting');
    const f = await seed(db);

    await t.test('only service_role has execution privileges, including the default-argument call', async () => {
      const publicGrant = await row(db, `select count(*)::int as n from pg_proc p
        cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where p.oid=$1::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'`, [signature]);
      assert.equal(publicGrant.n, 0);
      const caller = await fixture.connect();
      try {
        for (const role of ['anon', 'authenticated', 'service_role']) {
          assert.equal((await row(db, "select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, signature])).allowed,
            role === 'service_role');
          await caller.query(`set role ${role}`);
          if (role === 'service_role') assertShape(await read(caller, f.owner), f.w);
          else {
            await expectError(read(caller, f.owner), '42501');
            await expectError(read(caller, f.owner, 7), '42501');
          }
        }
      } finally { await caller.end(); }
    });

    await t.test('owner and admin receive tenant-only full DTOs, inactive members, exact stage priority and legacy aliases', async () => {
      for (const p of [f.owner, f.admin]) {
        const result = await read(db, p);
        assertShape(result, f.w);
        assert.equal(result.totalLeads, f.total);
        assert.equal(result.unassignedLeads, 1);
        assert.equal(result.otherAssigneeLeads, 2);
        assert.equal(result.members.length, 4);
        assert.deepEqual(member(result, f.a).assigned, f.expected);
        assert.deepEqual(member(result, f.b).assigned, assigned({ total: 1, lost: 1 }));
        assert.equal(member(result, f.b).status, 'inactive');
        assert.deepEqual(member(result, f.admin).assigned, assigned({ total: 1, new: 1 }));
        assert.deepEqual(member(result, f.owner).assigned, assigned());
        assert.doesNotMatch(JSON.stringify(result), /FOREIGN_MEMBER_SENTINEL|Not a report member/);
      }
      const foreign = await read(db, f.outsider);
      assertShape(foreign, f.foreign);
      assert.equal(foreign.totalLeads, 1);
      assert.deepEqual(foreign.members.map(m => m.staffId), [f.outsider.id]);
    });

    await t.test('audit credits recorded actors, distinct normalized UUIDs and deleted leads, excluding irrelevant events', async () => {
      const result = await read(db, f.owner);
      assert.equal(result.activityStatus, 'available');
      assert.deepEqual(member(result, f.a).activity, emptyActivity());
      assert.deepEqual(member(result, f.owner).activity, emptyActivity());
      const activity = member(result, f.b).activity;
      assert.deepEqual({ ...activity, lastRecordedAt: null },
        { createdEvents: 1, updatedEvents: 3, touchedLeads: 3, lastRecordedAt: null });
      assert.equal(Date.parse(activity.lastRecordedAt), Date.parse(f.recent));
      assert.equal(member(result, f.admin).activity.updatedEvents, 1);
      assert.equal(member(result, f.admin).activity.touchedLeads, 1);
    });

    await t.test('private audit helper is STABLE and cannot be invoked by service_role or browser roles', async () => {
      const helper = 'public.read_lead_team_activity_snapshot(uuid,timestamp with time zone,timestamp with time zone)';
      const info = await row(db, `select p.provolatile,p.prosecdef,p.proconfig from pg_proc p
        where p.oid=$1::regprocedure`, [helper]);
      assert.equal(info.provolatile, 's', 'Audit reads must inherit the parent SELECT snapshot');
      assert.ok(info.proconfig.includes('search_path=""'));
      assert.equal((await row(db, `select count(*)::int as n from pg_proc p
        cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where p.oid=$1::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'`, [helper])).n, 0);
      const caller = await fixture.connect();
      try {
        for (const role of ['anon', 'authenticated', 'service_role']) {
          assert.equal((await row(db, "select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, helper])).allowed, false);
          await caller.query(`set role ${role}`);
          await expectError(caller.query(`select public.read_lead_team_activity_snapshot(
            $1,statement_timestamp()-interval '30 days',statement_timestamp())`, [f.w]), '42501');
        }
      } finally { await caller.end(); }
    });

    await t.test('a real unavailable audit relation preserves complete workload and returns null activity', async () => {
      const baseline = await read(db, f.owner);
      await rollback(db, async () => {
        await db.query('alter table public.audit_logs rename to fixture_unavailable_audit_logs');
        const result = await read(db, f.owner);
        assertShape(result, f.w);
        assert.equal(result.activityStatus, 'unavailable');
        assert.equal(result.totalLeads, f.total);
        assert.deepEqual(member(result, f.a).assigned, member(baseline, f.a).assigned);
        assert.ok(result.members.every(m => m.activity === null));
        assert.doesNotMatch(JSON.stringify(result), /fixture_unavailable|relation|does not exist|error/i);
      });
      assert.equal((await read(db, f.owner)).activityStatus, 'available', 'Audit access recovers after rollback');
    });

    await t.test('empty workspaces keep explicit zero buckets and blank names use the established fallback', async () => {
      await rollback(db, async () => {
        const w = await workspace(db), owner = await person(db, w, 'owner', '\t\u00a0\ufeff\u2002');
        const result = await read(db, owner);
        assertShape(result, w);
        assert.equal(result.totalLeads, 0);
        assert.equal(result.activityStatus, 'available');
        assert.equal(member(result, owner).name, '\u0421\u043e\u0442\u0440\u0443\u0434\u043d\u0438\u043a');
        assert.deepEqual(member(result, owner).assigned, assigned());
        assert.deepEqual(member(result, owner).activity, emptyActivity());
        await db.query('update public.staff_users set full_name=$2 where id=$1', [owner.id, '\t\u00a0Trimmed owner\u2002\ufeff']);
        assert.equal(member(await read(db, owner), owner).name, 'Trimmed owner');
      });
    });

    await t.test('tenant, role, auth identity, active membership and mortgage purpose are rechecked by PostgreSQL', async () => {
      for (const p of [f.a, f.b, f.nonmember, { ...f.owner, workspace: f.foreign },
        { ...f.owner, auth: f.admin.auth }, { ...f.owner, id: randomUUID() },
        { ...f.owner, auth: null }, { ...f.owner, id: null }, { ...f.owner, workspace: null }]) {
        await expectError(read(db, p), 'P7001');
      }
      await rollback(db, async () => {
        for (const changes of ["status='inactive'", "role='lead_manager'", "role='manager'",
          "role='doctor'", "auth_user_id=null"]) {
          await db.query(`update public.staff_users set ${changes} where id=$1`, [f.owner.id]);
          await deniedInTransaction(db, () => read(db, f.owner), 'P7001');
          await db.query("update public.staff_users set status='active',role='owner',auth_user_id=$2 where id=$1", [f.owner.id, f.owner.auth]);
        }
        await db.query(`update public.workspace_settings set value='{"purpose":"clinic_services"}'
          where workspace_id=$1 and key='workspace_purpose'`, [f.w]);
        await deniedInTransaction(db, () => read(db, f.owner), 'P7001');
        await db.query("delete from public.workspace_settings where workspace_id=$1 and key='workspace_purpose'", [f.w]);
        await deniedInTransaction(db, () => read(db, f.owner), 'P7001');
      });
      await expectError(read(db, { ...f.owner, auth: randomUUID() }, 0), 'P7001');
    });

    await t.test('default period is 30; only 7/30/90 are accepted and periods use statement, not transaction time', async () => {
      for (const days of [null, 0, -1, 1, 8, 31, 365, 2147483647]) await expectError(read(db, f.owner, days), 'P8303');
      for (const days of [7, 30, 90]) {
        const result = await row(db, `select statement_timestamp() as anchor,
          public.read_lead_team_analytics($1,$2,$3,$4) as result`, [...identity(f.owner), days]);
        assertShape(result.result, f.w, days);
        assert.equal(Date.parse(result.result.generatedAt), result.anchor.getTime());
      }
      await rollback(db, async () => {
        const started = (await row(db, 'select transaction_timestamp() as at')).at;
        await db.query('select pg_sleep(0.06)');
        const result = await read(db, f.owner);
        assert.ok(Date.parse(result.generatedAt) >= started.getTime() + 40);
      });
    });

    await t.test('period windows include both exact boundaries and reject old/future records', async () => {
      await rollback(db, async () => {
        const w = await workspace(db), owner = await person(db, w, 'owner', 'Boundary owner');
        // The DO body and its RPC share one statement_timestamp, including fractional precision.
        await db.query(`do $fixture$ declare result jsonb; boundary timestamptz:=statement_timestamp(); begin
          insert into public.audit_logs(workspace_id,actor_staff_user_id,entity_id,action,actor_kind,entity_type,created_at)
          select '${w}'::uuid,'${owner.id}'::uuid,'${randomUUID()}','updated','manual','lead',at
          from (values(boundary),(boundary-interval '7 days'),
            (boundary+interval '1 microsecond'),(boundary-interval '7 days 1 microsecond')) v(at);
          result:=public.read_lead_team_analytics('${w}','${owner.id}','${owner.auth}',7);
          if result->'members'->0->'activity'->>'updatedEvents' <> '2'
            or result->'members'->0->'activity'->>'touchedLeads' <> '1'
            or (result->'members'->0->'activity'->>'lastRecordedAt')::timestamptz <> boundary then
            raise exception 'Boundary activity mismatch: %',result;
          end if;
        end $fixture$`);
      });
    });

    for (const bad of [null, '', 'not-a-uuid', `${randomUUID()} trailing`, '00000000000000000000000000000000']) {
      await t.test(`malformed relevant audit entity ${JSON.stringify(bad)} makes all activity unavailable, not zero`, async () => {
        const baseline = await read(db, f.owner);
        await rollback(db, async () => {
          await event(db, f.w, f.b.id, bad);
          const result = await read(db, f.owner);
          assertShape(result, f.w);
          assert.equal(result.activityStatus, 'unavailable');
          assert.equal(result.totalLeads, f.total);
          assert.deepEqual(member(result, f.a).assigned, member(baseline, f.a).assigned);
          assert.ok(result.members.every(m => m.activity === null));
        });
      });
    }
    await t.test('standard UUID text permits any hex version/variant and case-insensitive logical identity', async () => {
      await rollback(db, async () => {
        const entity = 'abcdefab-cdef-0000-0000-abcdefabcdef';
        await event(db, f.w, f.owner.id, entity);
        await event(db, f.w, f.owner.id, ` ${entity.toUpperCase()} `, 'created');
        await event(db, f.w, f.owner.id, `\t\u00a0${entity.toUpperCase()}\ufeff\u2002\n`, 'created');
        const result = await read(db, f.owner);
        assert.equal(result.activityStatus, 'available');
        assert.equal(member(result, f.owner).activity.touchedLeads, 1);
        assert.equal(member(result, f.owner).activity.createdEvents, 2);
        assert.equal(member(result, f.owner).activity.updatedEvents, 1);
      });
    });

    for (const [table, cap, insert] of [
      ['staff_users', 1000, `insert into public.staff_users(workspace_id,email,full_name,role,status)
        select $1,gen_random_uuid()::text||'@example.invalid','Cap nonmember','receptionist','inactive' from generate_series(1,$2::int)`],
      ['lead_stages', 1000, `insert into public.lead_stages(workspace_id,stage_key,name,semantic_group,is_active)
        select $1,'cap_'||gen_random_uuid()::text,'Cap stage','new',false from generate_series(1,$2::int)`],
      ['leads', 20000, `insert into public.leads(workspace_id,responsible_user_id,status)
        select $1,null,'new' from generate_series(1,$2::int)`],
    ]) await t.test(`${table} accepts exactly ${cap}, then ${cap + 1} fails with P8304; foreign rows do not consume cap`, async () => {
      await rollback(db, async () => {
        const w = await workspace(db), owner = await person(db, w, 'owner', 'Cap owner');
        const count = (await row(db, `select count(*)::int as n from public.${table} where workspace_id=$1`, [w])).n;
        await db.query(insert, [w, cap - count]);
        const complete = await read(db, owner);
        assertShape(complete, w);
        if (table === 'leads') assert.equal(complete.totalLeads, cap);
        if (table === 'staff_users') assert.equal(complete.members.length, 1);
        await db.query(insert, [w, 1]);
        await deniedInTransaction(db, () => read(db, owner), 'P8304');
        assertShape(await read(db, f.owner), f.w);
      });
    });

    await t.test('30000 relevant events are exact; 30001 makes activity unavailable but preserves workload', async () => {
      await rollback(db, async () => {
        const w = await workspace(db), owner = await person(db, w, 'owner', 'Audit cap owner');
        const id = await lead(db, w, owner.id);
        await db.query(`insert into public.audit_logs
          (workspace_id,actor_staff_user_id,entity_id,action,actor_kind,entity_type,created_at)
          select $1,$2,$3,'updated','manual','lead',statement_timestamp()-interval '1 minute'
          from generate_series(1,30000)`, [w, owner.id, id]);
        const exact = await read(db, owner);
        assertShape(exact, w);
        assert.equal(exact.activityStatus, 'available');
        assert.equal(member(exact, owner).activity.updatedEvents, 30000);
        assert.equal(member(exact, owner).activity.touchedLeads, 1);
        await event(db, w, null, 'nonmember still consumes relevant event cap');
        const overflow = await read(db, owner);
        assertShape(overflow, w);
        assert.equal(overflow.activityStatus, 'unavailable');
        assert.deepEqual(member(overflow, owner).assigned, assigned({ total: 1, new: 1 }));
        assert.equal(member(overflow, owner).activity, null);
        assert.equal((await read(db, f.owner)).activityStatus, 'available');
      });
    });

    await t.test('601 same-cardinality lead updates with staff, stage and audit changes yield only coherent snapshots', async () => {
      const w = await workspace(db), owner = await person(db, w, 'owner', 'Snapshot owner');
      const a = await person(db, w, 'lead_manager', 'Snapshot A');
      const b = await person(db, w, 'lead_manager', 'Snapshot B');
      const stage = (await row(db, `select id from public.lead_stages where workspace_id=$1 and stage_key='new'`, [w])).id;
      await db.query(`insert into public.leads(workspace_id,responsible_user_id,status,stage_id)
        select $1,$2,'lost',$3 from generate_series(1,601)`, [w, a.id, stage]);
      const audit = await event(db, w, a.id, randomUUID());
      const writer = await fixture.connect(), reader = await fixture.connect();
      try {
        const holder = (await row(writer, 'select pg_backend_pid() as pid')).pid;
        const waiter = (await row(reader, 'select pg_backend_pid() as pid')).pid;
        for (let round = 0; round < 8; round++) {
          const next = round % 2 === 0 ? 'B' : 'A';
          const target = next === 'B' ? b : a;
          await writer.query('begin');
          // This gate intersects the business query, after 070's unrelated owner/purpose locks.
          await writer.query('lock table public.audit_logs in access exclusive mode');
          const pending = observed(read(reader, owner));
          try {
            await waitForBlock(db, waiter, holder);
            await writer.query('update public.staff_users set full_name=$2 where id=$1', [a.id, `Snapshot ${next}`]);
            await writer.query('update public.lead_stages set semantic_group=$2 where id=$1', [stage, next === 'B' ? 'booked' : 'new']);
            await writer.query('update public.leads set responsible_user_id=$2 where workspace_id=$1', [w, target.id]);
            await writer.query('update public.audit_logs set actor_staff_user_id=$2,action=$3 where id=$1',
              [audit, target.id, next === 'B' ? 'created' : 'updated']);
            await writer.query('commit');
          } finally { await writer.query('rollback'); }
          const outcome = await pending;
          if (outcome.error) throw outcome.error;
          const result = outcome.value;
          assertShape(result, w);
          assert.equal(result.totalLeads, 601);
          const version = member(result, a).name === 'Snapshot A' ? 'A' : 'B';
          const active = version === 'A' ? a : b, idle = version === 'A' ? b : a;
          assert.deepEqual(member(result, active).assigned,
            assigned({ total: 601, [version === 'A' ? 'new' : 'booked']: 601 }));
          assert.deepEqual(member(result, idle).assigned, assigned());
          assert.deepEqual({ ...member(result, active).activity, lastRecordedAt: null },
            { createdEvents: version === 'B' ? 1 : 0, updatedEvents: version === 'A' ? 1 : 0,
              touchedLeads: 1, lastRecordedAt: null });
          assert.deepEqual(member(result, idle).activity, emptyActivity());
          const committed = await read(db, owner);
          assert.equal(member(committed, a).name, `Snapshot ${next}`);
          assert.equal(member(committed, target).assigned.total, 601);
        }
      } finally {
        await writer.query('rollback');
        await writer.end();
        await reader.end();
      }
    });

    for (const [name, revoke] of [
      ['membership', async c => c.query("update public.staff_users set status='inactive' where id=$1", [f.owner.id])],
      ['purpose', async c => c.query(`update public.workspace_settings set value='{"purpose":"clinic_services"}'
        where workspace_id=$1 and key='workspace_purpose'`, [f.w])],
    ]) await t.test(`${name} revocation serializes in both lock orders and waiting reads fail closed`, async () => {
      const holder = await fixture.connect(), waiter = await fixture.connect();
      try {
        const holderPid = (await row(holder, 'select pg_backend_pid() as pid')).pid;
        const waiterPid = (await row(waiter, 'select pg_backend_pid() as pid')).pid;
        await holder.query('begin');
        await read(holder, f.owner);
        const pendingRevoke = observed(revoke(waiter));
        try { await waitForBlock(db, waiterPid, holderPid); }
        finally { await holder.query('rollback'); }
        const revoked = await pendingRevoke;
        if (revoked.error) throw revoked.error;
        await expectError(read(db, f.owner), 'P7001');
        await db.query("update public.staff_users set status='active' where id=$1", [f.owner.id]);
        await db.query(`update public.workspace_settings set value='{"purpose":"mortgage_leads"}'
          where workspace_id=$1 and key='workspace_purpose'`, [f.w]);

        await holder.query('begin');
        await revoke(holder);
        const pendingRead = observed(read(waiter, f.owner));
        try { await waitForBlock(db, waiterPid, holderPid); await holder.query('commit'); }
        finally { await holder.query('rollback'); }
        assert.equal((await pendingRead).error?.code, 'P7001');
      } finally {
        await holder.query('rollback');
        await holder.end();
        await waiter.end();
        await db.query("update public.staff_users set status='active' where id=$1", [f.owner.id]);
        await db.query(`update public.workspace_settings set value='{"purpose":"mortgage_leads"}'
          where workspace_id=$1 and key='workspace_purpose'`, [f.w]);
      }
    });

    await t.test('real route authorization and mortgage policy admit only owner/admin GET', async () => {
      const { require: tsxRequire } = await import('tsx/cjs/api');
      const load = file => tsxRequire(path.join(root, file), import.meta.url);
      const { resolveCrmRoute } = await load('lib/crm/authorization.ts');
      const { mortgageRouteAllowed } = await load('lib/crm/workspace-policy.ts');
      const route = resolveCrmRoute(['lead-team-analytics']);
      assert.deepEqual(route.authorization.roles, ['owner', 'admin']);
      assert.deepEqual(route.authorization.methods, ['GET']);
      for (const role of ['owner', 'admin', 'lead_manager', 'manager', 'receptionist', 'doctor', 'marketer']) {
        for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
          assert.equal(mortgageRouteAllowed(role, 'lead-team-analytics', method),
            ['owner', 'admin'].includes(role) && method === 'GET');
        }
      }
    });

    await t.test('HTTP method, purpose, role and missing context deny before storage access', async () => {
      const { require: tsxRequire } = await import('tsx/cjs/api');
      const load = file => tsxRequire(path.join(root, file), import.meta.url);
      const { setSupabaseServerClientFactoryForTests } = await load('lib/supabase/server.ts');
      const { attachWorkspaceContext } = await load('lib/crm/server.ts');
      const { handleLeadTeamAnalytics } = await load('lib/crm/lead-team-analytics.ts');
      let storageCalls = 0;
      setSupabaseServerClientFactoryForTests(() => {
        storageCalls++;
        throw new Error('Denied requests must not reach storage');
      });
      try {
        for (const [role, purpose, method, context, status] of [
          ['owner', 'mortgage_leads', 'POST', true, 405],
          ['owner', 'mortgage_leads', 'PATCH', true, 405],
          ['owner', 'mortgage_leads', 'DELETE', true, 405],
          ['owner', 'clinic_services', 'GET', true, 403],
          ['owner', 'mortgage_leads', 'GET', false, 403],
          ...['lead_manager', 'manager', 'receptionist', 'doctor', 'marketer']
            .map(role => [role, 'mortgage_leads', 'GET', true, 403]),
        ]) {
          const req = { method, query: { workspaceId: f.foreign }, headers: {} };
          if (context) attachWorkspaceContext(req, { workspaceId: f.w, staffUserId: f.owner.id,
            userId: f.owner.auth, role, purpose, permissions: [] });
          const res = { statusCode: 0, body: null, headers: {},
            status(code) { this.statusCode = code; return this; },
            setHeader(key, value) { this.headers[key] = value; return this; },
            json(body) { this.body = body; return this; } };
          await handleLeadTeamAnalytics(req, res);
          assert.equal(res.statusCode, status, `${role}/${purpose}/${method}/${context}`);
          assert.equal(res.body.success, false);
          assert.equal(res.headers['Cache-Control'], 'private, no-store');
        }
        assert.equal(storageCalls, 0);
      } finally { setSupabaseServerClientFactoryForTests(null); }
    });

    await t.test('actual HTTP handler accepts the real service-role RPC DTO and suppresses revoked identity', async () => {
      const { require: tsxRequire } = await import('tsx/cjs/api');
      const load = file => tsxRequire(path.join(root, file), import.meta.url);
      const { setSupabaseServerClientFactoryForTests } = await load('lib/supabase/server.ts');
      const { attachWorkspaceContext } = await load('lib/crm/server.ts');
      const { handleLeadTeamAnalytics } = await load('lib/crm/lead-team-analytics.ts');
      const caller = await fixture.connect();
      await caller.query('set role service_role');
      let calls = 0;
      setSupabaseServerClientFactoryForTests(() => ({ async rpc(name, args) {
        calls++;
        assert.equal(name, 'read_lead_team_analytics');
        assert.deepEqual(Object.keys(args).sort(), ['p_workspace_id', 'p_staff_user_id', 'p_auth_user_id', 'p_days'].sort());
        try {
          return { data: (await row(caller, 'select public.read_lead_team_analytics($1,$2,$3,$4) as result',
            [args.p_workspace_id, args.p_staff_user_id, args.p_auth_user_id, args.p_days])).result, error: null };
        } catch (error) { return { data: null, error: { code: error.code, message: error.message } }; }
      } }));
      const invoke = async p => {
        const req = { method: 'GET', query: { days: '30', workspaceId: f.foreign }, headers: {} };
        attachWorkspaceContext(req, { workspaceId: f.w, staffUserId: p.id, userId: p.auth,
          role: 'owner', purpose: 'mortgage_leads', permissions: [] });
        const res = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; },
          setHeader() { return this; }, json(body) { this.body = body; return this; } };
        await handleLeadTeamAnalytics(req, res);
        return res;
      };
      try {
        const accepted = await invoke(f.owner);
        assert.equal(accepted.statusCode, 200);
        assert.equal(accepted.body.success, true);
        const report = accepted.body.data.analytics;
        assert.equal(report.totalLeads, f.total);
        assert.equal(Object.hasOwn(report, 'workspaceId'), false, 'internal identity receipt is not a new public DTO field');
        assert.deepEqual(member(report, f.a).assigned, member(await read(db, f.owner), f.a).assigned);
        assert.equal(report.generatedAt, report.period.to);
        assert.match(report.generatedAt, /\.\d{3}Z$/);
        const refused = await invoke({ ...f.owner, auth: randomUUID() });
        assert.equal(refused.statusCode, 403);
        assert.equal(refused.body.code, 'workspace_access_denied');
        assert.equal(refused.body.data, undefined);
        assert.equal(calls, 2);
      } finally { setSupabaseServerClientFactoryForTests(null); await caller.end(); }
    });

    await t.test('optional real 080 structured postponed stage wins over conflicting legacy status without becoming a dependency', async () => {
      await db.query(await readFile(path.join(root, 'migrations/080_postponed_lead_stage.sql'), 'utf8'));
      await rollback(db, async () => {
        const w = await workspace(db), owner = await person(db, w, 'owner', 'Structured postponed owner');
        const stage = (await row(db, `select id from public.lead_stages
          where workspace_id=$1 and stage_key='postponed'`, [w])).id;
        await lead(db, w, owner.id, 'lost', stage);
        await lead(db, w, owner.id, 'new', stage);
        await db.query('update public.lead_stages set is_active=false where id=$1', [stage]);
        const result = await read(db, owner);
        assertShape(result, w);
        assert.deepEqual(member(result, owner).assigned, assigned({ total: 2, postponed: 2 }));
      });
    });
    assert.equal(hash(await readFile(migrationPath, 'utf8')), sourceHash, '083 changed during the run; rerun the latest candidate');
    t.diagnostic('083 source hash unchanged through completion');
  } finally {
    await fixture.close();
    t.diagnostic('Owned disposable PostgreSQL stopped and removed in finally; no remote database contacted');
  }
});

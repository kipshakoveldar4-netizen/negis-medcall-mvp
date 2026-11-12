import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startDisposablePostgres } from './disposable-postgres.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const migrations = [
  '009_medcall_mvp_persistence.sql',
  '010_staff_ready_crm.sql',
  '011_staff_auth_foundation.sql',
  '014_meta_ad_launches.sql',
  '019_crm_lead_pipeline_foundation.sql',
  '028_leads_phone_normalized.sql',
  '038_staff_join_requests.sql',
  '069_assigned_lead_manager.sql',
];
const row = async (client, sql, params = []) => (await client.query(sql, params)).rows[0];
const observed = promise => promise.then(value => ({ value }), error => ({ error }));
const identity = person => [person.workspace, person.id, person.auth];
const read = async (client, args) => (await row(client,
  'select public.read_assigned_crm_leads($1,$2,$3) as result', args)).result;
const patch = async (client, args, lead, changes) => (await row(client,
  'select public.patch_assigned_crm_lead($1,$2,$3,$4,$5::jsonb) as result',
  [...args, lead, JSON.stringify(changes)])).result;
const leadRow = async (client, id) => (await row(client,
  'select to_jsonb(l) as item from public.leads l where id=$1', [id])).item;
const leadSnapshot = async client => (await row(client,
  "select coalesce(jsonb_agg(to_jsonb(l) order by l.id), '[]'::jsonb) as items from public.leads l")).items;

async function expectError(operation, code, message) {
  const result = await observed(operation);
  assert.ok(result.error, `Expected PostgreSQL ${code}, but the RPC succeeded`);
  assert.equal(result.error.code, code, result.error.message);
  if (message) assert.equal(result.error.message, message);
  return { code: result.error.code, message: result.error.message };
}

async function seed(observer) {
  const workspaces = [randomUUID(), randomUUID()];
  for (const [index, id] of workspaces.entries()) {
    await observer.query('insert into public.workspaces(id,name) values($1,$2)',
      [id, `Disposable assigned leads ${index}`]);
  }
  const people = Array.from({ length: 8 }, (_, index) => ({
    id: randomUUID(), auth: randomUUID(), workspace: workspaces[index === 4 || index === 5 ? 1 : 0],
    role: index < 6 ? 'lead_manager' : index === 6 ? 'manager' : 'admin',
    status: index === 2 ? 'inactive' : 'active',
  }));
  for (const [index, person] of people.entries()) {
    await observer.query(`insert into public.staff_users
      (id,auth_user_id,workspace_id,email,full_name,role,status) values($1,$2,$3,$4,$5,$6,$7)`,
    [person.id, person.auth, person.workspace, `assigned-${index}@example.invalid`,
      `Synthetic staff ${index}`, person.role, person.status]);
  }
  const taxonomy = new Map();
  for (const workspace of workspaces) {
    const stages = (await observer.query('select * from public.lead_stages where workspace_id=$1', [workspace])).rows;
    const source = await row(observer,
      "select * from public.lead_sources where workspace_id=$1 and source_key='meta_ads'", [workspace]);
    const inactive = randomUUID();
    await observer.query(`insert into public.lead_stages
      (id,workspace_id,stage_key,name,semantic_group,is_active) values($1,$2,'archived','Inactive fixture','lost',false)`,
    [inactive, workspace]);
    const client = randomUUID(), campaign = randomUUID();
    await observer.query('insert into public.clients(id,workspace_id,full_name) values($1,$2,$3)',
      [client, workspace, 'Synthetic client']);
    await observer.query('insert into public.meta_campaign_launches(id,workspace_id,campaign_name) values($1,$2,$3)',
      [campaign, workspace, 'Synthetic campaign']);
    taxonomy.set(workspace, { stages: Object.fromEntries(stages.map(stage => [stage.stage_key, stage])),
      source, inactive, client, campaign });
  }
  const addLead = async (workspace, responsible, created = '2026-01-01T00:00:00Z') => {
    const id = randomUUID(), local = taxonomy.get(workspace);
    await observer.query(`insert into public.leads
      (id,workspace_id,responsible_user_id,client_id,full_name,phone,notes,status,stage_id,
       source,source_id,campaign,meta_campaign_launch_id,created_at,updated_at)
      values($1,$2,$3,$4,'Synthetic lead','8 (701) 123-45-67','Original notes','new',$5,
       'Meta Ads snapshot',$6,'Synthetic campaign snapshot',$7,$8,$8)`,
    [id, workspace, responsible, local.client, local.stages.new.id, local.source.id, local.campaign, created]);
    return id;
  };
  const own = [await addLead(workspaces[0], people[0].id), await addLead(workspaces[0], people[0].id),
    await addLead(workspaces[0], people[0].id, '2025-01-01T00:00:00Z')];
  const other = await addLead(workspaces[0], people[1].id);
  const unassigned = await addLead(workspaces[0], null);
  const foreign = await addLead(workspaces[1], people[4].id);
  // Migration 010's single-column FK permits this: workspace filtering must still win.
  const foreignAssigned = await addLead(workspaces[1], people[0].id);
  for (const person of people.slice(2)) await addLead(person.workspace, person.id);
  await addLead(workspaces[1], null);
  return { workspaces, people, taxonomy, addLead, own, other, unassigned, foreign, foreignAssigned };
}

async function contenders(fixture, observer, t) {
  const a = await fixture.connect();
  let b;
  t.after(async () => {
    await a.query('rollback').catch(() => {});
    if (b) await b.query('rollback').catch(() => {});
    await a.end();
    if (b) await b.end();
  });
  b = await fixture.connect();
  const aPid = (await row(a, 'select pg_backend_pid() as pid')).pid;
  const bPid = (await row(b, 'select pg_backend_pid() as pid')).pid;
  const observerPid = (await row(observer, 'select pg_backend_pid() as pid')).pid;
  assert.equal(new Set([aPid, bPid, observerPid]).size, 3, 'Use distinct real PostgreSQL connections');
  assert.equal((await row(b, 'show transaction_isolation')).transaction_isolation, 'read committed');
  const blocked = async () => {
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      const lock = await row(observer, `select pg_blocking_pids(pid) as blockers, wait_event_type
        from pg_stat_activity where pid=$1`, [bPid]);
      if (lock?.blockers.includes(aPid)) {
        assert.equal(lock.wait_event_type, 'Lock');
        t.diagnostic('pg_blocking_pids confirmed the second connection waits for the first');
        return;
      }
      await delay(15);
    }
    assert.fail('No pg_blocking_pids edge observed; elapsed time does not prove contention');
  };
  return { a, b, blocked };
}

// The shared harness accepts only a new owned local cluster; never use a URL or skip a missing runtime.
test('assigned lead RPC regressions on disposable PostgreSQL', { timeout: 300000 }, async t => {
  const fixture = await startDisposablePostgres();
  try {
    const observer = await fixture.connect();
    await observer.query(`create role anon; create role authenticated; create role service_role bypassrls;
      grant usage on schema public to anon, authenticated, service_role;`);
    for (const file of migrations) await observer.query(await readFile(path.join(root, 'migrations', file), 'utf8'));
    const version = await row(observer, 'show server_version');
    t.diagnostic(`PostgreSQL ${version.server_version}; migrations 009/010/011/014/019/028/038/069; synthetic data only`);
    const f = await seed(observer), owner = f.people[0], auth = identity(owner);
    const local = f.taxonomy.get(owner.workspace), foreignTaxonomy = f.taxonomy.get(f.workspaces[1]);
    const service = await fixture.connect();
    await service.query('set role service_role');

    await t.test('own-only reads exclude other, unassigned and foreign leads for every active lead manager', async () => {
      assert.equal(f.people.length, 8);
      assert.equal(f.people.filter(person => person.role === 'lead_manager').length, 6);
      const all = await leadSnapshot(observer);
      for (const person of f.people.filter(person => person.role === 'lead_manager' && person.status === 'active')) {
        const expected = all.filter(lead => lead.workspace_id === person.workspace && lead.responsible_user_id === person.id)
          .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
        const result = await read(service, identity(person));
        assert.deepEqual(result.map(lead => lead.id), expected.map(lead => lead.id));
        for (const lead of result) {
          assert.equal(lead.responsible_user_id, person.id);
          assert.equal(lead.stage_definition.workspace_id, person.workspace);
          assert.equal(lead.source_definition.workspace_id, person.workspace);
        }
      }
      const owned = await read(service, auth);
      assert.deepEqual(new Set(owned.map(lead => lead.id)), new Set(f.own));
      for (const excluded of [f.other, f.unassigned, f.foreign, f.foreignAssigned]) {
        assert.ok(!owned.some(lead => lead.id === excluded));
      }
    });

    await t.test('RPC ACL rejects anon/authenticated and grants execution only to the service role', async () => {
      const signatures = ['public.read_assigned_crm_leads(uuid,uuid,uuid)',
        'public.patch_assigned_crm_lead(uuid,uuid,uuid,uuid,jsonb)'];
      const before = await leadSnapshot(observer);
      for (const role of ['anon', 'authenticated', 'service_role']) {
        for (const signature of signatures) {
          assert.equal((await row(observer, 'select has_function_privilege($1,$2,\'EXECUTE\') as allowed',
            [role, signature])).allowed, role === 'service_role');
        }
      }
      const acl = await row(observer, `select count(*)::int as public_execute from pg_proc p
        cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where p.oid in ($1::regprocedure,$2::regprocedure) and a.grantee=0 and a.privilege_type='EXECUTE'`, signatures);
      assert.equal(acl.public_execute, 0);
      const caller = await fixture.connect();
      try {
        for (const role of ['anon', 'authenticated']) {
          await caller.query(`set role ${role}`);
          await expectError(read(caller, auth), '42501', 'permission denied for function read_assigned_crm_leads');
          await expectError(patch(caller, auth, f.own[0], { notes: 'Must not persist' }),
            '42501', 'permission denied for function patch_assigned_crm_lead');
        }
      } finally { await caller.end(); }
      assert.deepEqual(await leadSnapshot(observer), before);
    });

    await t.test('missing, inactive, foreign-auth/workspace and wrong-role identities get P6901 in both RPCs', async t => {
      const cases = [
        ['missing staff', [owner.workspace, randomUUID(), owner.auth]],
        ['null staff', [owner.workspace, null, owner.auth]],
        ['missing workspace', [randomUUID(), owner.id, owner.auth]],
        ['null workspace', [null, owner.id, owner.auth]],
        ['inactive staff', identity(f.people[2])],
        ['foreign auth', [owner.workspace, owner.id, f.people[4].auth]],
        ['missing auth', [owner.workspace, owner.id, randomUUID()]],
        ['null auth', [owner.workspace, owner.id, null]],
        ['foreign staff', [owner.workspace, f.people[4].id, f.people[4].auth]],
        ['foreign workspace', [f.workspaces[1], owner.id, owner.auth]],
        ['existing manager head', identity(f.people[6])],
        ['existing admin', identity(f.people[7])],
      ];
      for (const [name, args] of cases) await t.test(name, async () => {
        const before = await leadSnapshot(observer);
        await expectError(read(service, args), 'P6901', 'assigned_lead_access_denied');
        await expectError(patch(service, args, f.own[0], { notes: 'Denied mutation' }),
          'P6901', 'assigned_lead_access_denied');
        assert.deepEqual(await leadSnapshot(observer), before);
      });
    });

    await t.test('own PATCH changes contact/notes/stage while preserving all attribution and other leads', async () => {
      const before = await leadRow(observer, f.own[0]);
      const others = (await leadSnapshot(observer)).filter(lead => lead.id !== before.id);
      const result = await patch(service, auth, before.id, { full_name: '  Updated synthetic lead  ',
        phone: '  8 (702) 765-43-21  ', notes: '  Updated notes  ',
        stage_id: local.stages.in_progress.id, status: 'in_progress' });
      assert.deepEqual(result.before, before);
      const after = await leadRow(observer, before.id);
      assert.equal(after.full_name, 'Updated synthetic lead');
      assert.equal(after.phone, '8 (702) 765-43-21');
      assert.equal(after.phone_normalized, '+77027654321');
      assert.equal(after.notes, 'Updated notes');
      assert.equal(after.status, 'in_progress');
      assert.equal(after.stage_id, local.stages.in_progress.id);
      assert.ok(Date.parse(after.updated_at) > Date.parse(before.updated_at));
      const mutable = new Set(['full_name', 'phone', 'phone_normalized', 'notes', 'status', 'stage_id', 'updated_at']);
      for (const key of Object.keys(before).filter(key => !mutable.has(key))) assert.deepEqual(after[key], before[key], key);
      assert.equal(result.item.id, after.id);
      for (const key of ['full_name', 'phone', 'notes', 'status', 'stage_id', 'responsible_user_id', 'source', 'source_id', 'campaign']) {
        assert.deepEqual(result.item[key], after[key], key);
      }
      assert.equal(result.item.stage_definition.id, after.stage_id);
      assert.equal(result.item.source_definition.id, before.source_id);
      assert.deepEqual((await leadSnapshot(observer)).filter(lead => lead.id !== before.id), others);
    });

    await t.test('status-only/stage-only PATCH resolves a matching active workspace-local stage', async () => {
      const id = f.own[1];
      let result = await patch(service, auth, id, { stage_id: local.stages.booked.id });
      assert.equal(result.item.status, 'booked');
      assert.equal(result.item.stage_id, local.stages.booked.id);
      result = await patch(service, auth, id, { status: 'lost' });
      assert.equal(result.item.status, 'lost');
      assert.equal(result.item.stage_id, local.stages.lost.id);
      result = await patch(service, auth, id, { notes: null });
      assert.equal(result.item.notes, null);
      assert.equal(result.item.status, 'lost');
      assert.equal(result.item.stage_id, local.stages.lost.id);
    });

    await t.test('unknown/foreign/unassigned/other-assignee lead errors are indistinguishable P6902', async () => {
      const before = await leadSnapshot(observer);
      const errors = [];
      for (const id of [randomUUID(), null, f.foreign, f.foreignAssigned, f.unassigned, f.other]) {
        errors.push(await expectError(patch(service, auth, id, { notes: 'Must not persist' }),
          'P6902', 'assigned_lead_not_found'));
      }
      for (const error of errors) assert.deepEqual(error, errors[0]);
      assert.deepEqual(await leadSnapshot(observer), before);
    });

    await t.test('forbidden keys reject even unchanged attribution, with no partial writes', async t => {
      const before = await leadRow(observer, f.own[0]);
      const keys = ['id', 'workspace_id', 'responsible_user_id', 'client_id', 'source', 'source_id',
        'campaign', 'meta_campaign_launch_id', 'phone_normalized', 'created_at', 'updated_at', 'unknown'];
      for (const key of keys) await t.test(key, async () => {
        const snapshot = await leadSnapshot(observer);
        await expectError(patch(service, auth, before.id, { full_name: 'Must roll back', [key]: before[key] ?? 'forbidden' }),
          'P6903', 'assigned_lead_patch_invalid');
        assert.deepEqual(await leadSnapshot(observer), snapshot);
      });
    });

    await t.test('malformed payloads, types and lengths reject with P6903 and rollback', async t => {
      const cases = [
        ['SQL null', undefined], ['JSON null', null], ['empty object', {}], ['array', []], ['string', 'invalid'],
        ['number', 3], ['boolean', false], ['numeric contact', { phone: 7011234567 }],
        ['object notes', { notes: {} }], ['array name', { full_name: [] }], ['boolean status', { status: true }],
        ['long name', { full_name: 'n'.repeat(501) }], ['long phone', { phone: '1'.repeat(101) }],
        ['long notes', { notes: 'n'.repeat(10001) }], ['long status', { status: 's'.repeat(101) }],
      ];
      for (const [name, changes] of cases) await t.test(name, async () => {
        const before = await leadSnapshot(observer);
        await expectError(patch(service, auth, f.own[0], changes), 'P6903', 'assigned_lead_patch_invalid');
        assert.deepEqual(await leadSnapshot(observer), before);
      });
    });

    await t.test('invalid/mismatched/foreign/inactive stages reject with P6903 and rollback', async t => {
      await observer.query(`insert into public.lead_stages (workspace_id,stage_key,name,semantic_group)
        values($1,'foreign_only','Foreign active fixture','new')`, [f.workspaces[1]]);
      const cases = [
        ['bad UUID', { stage_id: 'not-a-uuid' }], ['null UUID', { stage_id: null }],
        ['empty UUID', { stage_id: '' }], ['unknown UUID', { stage_id: randomUUID() }],
        ['foreign active UUID', { stage_id: foreignTaxonomy.stages.booked.id }],
        ['inactive UUID', { stage_id: local.inactive }],
        ['unknown status', { status: 'not-a-stage' }], ['null status', { status: null }],
        ['empty status', { status: '' }], ['inactive status', { status: 'archived' }],
        ['foreign-only status', { status: 'foreign_only' }],
        ['mismatched status', { stage_id: local.stages.booked.id, status: 'new' }],
        ['null mismatched status', { stage_id: local.stages.booked.id, status: null }],
      ];
      for (const [name, changes] of cases) await t.test(name, async () => {
        const before = await leadSnapshot(observer);
        await expectError(patch(service, auth, f.own[0], { full_name: 'Must roll back', ...changes }),
          'P6903', 'assigned_lead_stage_invalid');
        assert.deepEqual(await leadSnapshot(observer), before);
      });
    });

    await t.test('post-update contact validation rolls back the entire statement inside a real transaction', async () => {
      const before = await leadSnapshot(observer);
      await service.query('begin; savepoint invalid_contact');
      try {
        await expectError(patch(service, auth, f.own[0], { full_name: ' ', phone: null, notes: 'Must roll back',
          stage_id: local.stages.lost.id }), 'P6903', 'assigned_lead_contact_required');
        await expectError(service.query('select 1'), '25P02');
        await service.query('rollback to savepoint invalid_contact');
        await service.query('commit');
      } finally { await service.query('rollback'); }
      assert.deepEqual(await leadSnapshot(observer), before);
    });

    await t.test('migration 028 generated phone normalization follows every accepted PATCH', async t => {
      const column = await row(observer, `select is_generated from information_schema.columns
        where table_schema='public' and table_name='leads' and column_name='phone_normalized'`);
      assert.equal(column.is_generated, 'ALWAYS');
      const cases = [['8 (701) 123-45-67', '+77011234567'], ['00 44 20 1234 5678', '+442012345678'],
        ['+7 (702) 765-43-21', '+77027654321'], ['123-45', '+12345'], ['no digits', null], ['', null], [null, null]];
      for (const [phone, expected] of cases) await t.test(String(phone), async () => {
        const before = await leadRow(observer, f.own[0]);
        await patch(service, auth, before.id, { phone });
        const after = await leadRow(observer, before.id);
        assert.equal(after.phone_normalized, expected);
        assert.equal(after.full_name, before.full_name);
        for (const key of Object.keys(before).filter(key => !['phone', 'phone_normalized', 'updated_at'].includes(key))) {
          assert.deepEqual(after[key], before[key], key);
        }
      });
    });

    await t.test('reassignment commits first: waiting PATCH rechecks ownership and returns P6902 without mutation', async t => {
      const id = await f.addLead(owner.workspace, owner.id), before = await leadRow(observer, id);
      const c = await contenders(fixture, observer, t);
      await c.a.query('begin');
      await c.a.query('update public.leads set responsible_user_id=$1 where id=$2', [f.people[1].id, id]);
      await c.b.query('set role service_role');
      const pending = observed(patch(c.b, auth, id, { full_name: 'Waiting mutation', notes: 'Must not persist' }));
      await c.blocked();
      assert.deepEqual(await leadRow(observer, id), before);
      await c.a.query('commit');
      const result = await pending;
      assert.equal(result.error?.code, 'P6902', result.error?.message);
      assert.equal(result.error.message, 'assigned_lead_not_found');
      assert.deepEqual(await leadRow(observer, id), { ...before, responsible_user_id: f.people[1].id });
    });

    await t.test('staff deactivation commits first: waiting PATCH returns P6901 without mutation', async t => {
      const person = f.people[3], id = await f.addLead(person.workspace, person.id);
      const before = await leadRow(observer, id), c = await contenders(fixture, observer, t);
      await c.a.query('begin');
      await c.a.query("update public.staff_users set status='inactive' where id=$1", [person.id]);
      await c.b.query('set role service_role');
      const pending = observed(patch(c.b, identity(person), id, { notes: 'Must not persist' }));
      await c.blocked();
      assert.equal((await row(observer, 'select status from public.staff_users where id=$1', [person.id])).status, 'active');
      assert.deepEqual(await leadRow(observer, id), before);
      await c.a.query('commit');
      const result = await pending;
      assert.equal(result.error?.code, 'P6901', result.error?.message);
      assert.equal(result.error.message, 'assigned_lead_access_denied');
      assert.equal((await row(observer, 'select status from public.staff_users where id=$1', [person.id])).status, 'inactive');
      assert.deepEqual(await leadRow(observer, id), before);
    });

    await t.test('PATCH commits first: waiting deactivation cannot commit ahead of its membership lock', async t => {
      const person = f.people[1], args = identity(person), id = await f.addLead(person.workspace, person.id);
      const before = await leadRow(observer, id), c = await contenders(fixture, observer, t);
      await c.a.query('begin; set local role service_role');
      const first = await patch(c.a, args, id, { notes: 'Committed before deactivation', stage_id: local.stages.booked.id });
      await c.b.query('begin');
      const pending = observed(c.b.query("update public.staff_users set status='inactive' where id=$1 returning status", [person.id]));
      await c.blocked();
      assert.deepEqual(await leadRow(observer, id), before);
      assert.equal((await row(observer, 'select status from public.staff_users where id=$1', [person.id])).status, 'active');
      await c.a.query('commit');
      const deactivation = await pending;
      assert.equal(deactivation.error, undefined);
      assert.equal(deactivation.value.rowCount, 1);
      assert.equal(deactivation.value.rows[0].status, 'inactive');
      const committed = await leadRow(observer, id);
      assert.equal(committed.notes, first.item.notes);
      assert.equal(committed.status, 'booked');
      assert.equal(committed.stage_id, local.stages.booked.id);
      // The observer sees PATCH committed while the waiting revocation is still uncommitted.
      assert.equal((await row(observer, 'select status from public.staff_users where id=$1', [person.id])).status, 'active');
      await c.b.query('commit');
      assert.equal((await row(observer, 'select status from public.staff_users where id=$1', [person.id])).status, 'inactive');
      await expectError(read(service, args), 'P6901', 'assigned_lead_access_denied');
      await expectError(patch(service, args, id, { notes: 'Too late' }), 'P6901', 'assigned_lead_access_denied');
      assert.deepEqual(await leadRow(observer, id), committed);
    });
  } finally {
    await fixture.close();
    t.diagnostic('Owned disposable cluster stopped and removed');
  }
});

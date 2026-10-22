import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
const legacyGroups = ['new', 'in_progress', 'booked', 'lost'];
const stageKeys = ['new', 'in_progress', 'booked', 'postponed', 'lost'];
const dataTables = ['workspaces', 'staff_users', 'clients', 'meta_campaign_launches',
  'leads', 'lead_stages', 'lead_sources'];
const rpcSignatures = ['public.read_assigned_crm_leads(uuid,uuid,uuid)',
  'public.patch_assigned_crm_lead(uuid,uuid,uuid,uuid,jsonb)'];
const seedSignature = 'public.seed_default_lead_taxonomy(uuid)';
const row = async (client, sql, params = []) => (await client.query(sql, params)).rows[0];
const identity = person => [person.workspace, person.id, person.auth];
const read = async (client, person) => (await row(client,
  'select public.read_assigned_crm_leads($1,$2,$3) as result', identity(person))).result;
const patch = async (client, person, id, changes) => (await row(client,
  'select public.patch_assigned_crm_lead($1,$2,$3,$4,$5::jsonb) as result',
  [...identity(person), id, JSON.stringify(changes)])).result;
const leadRow = async (client, id) => (await row(client,
  'select to_jsonb(l) as item from public.leads l where id=$1', [id])).item;
const stages = async (client, workspace) => (await client.query(
  'select * from public.lead_stages where workspace_id=$1 order by sort_order,stage_key', [workspace])).rows;

async function expectError(operation, code, message) {
  await assert.rejects(operation, error => {
    assert.equal(error.code, code, error.message);
    if (message) assert.equal(error.message, message);
    return true;
  }, `Expected PostgreSQL ${code}; the operation must fail closed`);
}

async function dataSnapshot(client) {
  const result = {};
  for (const table of dataTables) {
    result[table] = (await row(client, `select coalesce(jsonb_agg(to_jsonb(r) order by r.id),
      '[]'::jsonb) as items from public.${table} r`)).items;
  }
  return result;
}

async function securitySnapshot(client) {
  return (await row(client, `select jsonb_build_object(
    'tables', (select coalesce(jsonb_agg(jsonb_build_object('name',c.relname,
      'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'forced',c.relforcerowsecurity)
      order by c.relname),'[]'::jsonb) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r'),
    'policies', (select coalesce(jsonb_agg(to_jsonb(p) order by p.tablename,p.policyname),
      '[]'::jsonb) from pg_policies p where p.schemaname='public'),
    'functions', (select coalesce(jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,
      'owner',p.proowner,'acl',p.proacl,'security_definer',p.prosecdef,'settings',p.proconfig,
      'definition',case when p.proname <> 'seed_default_lead_taxonomy'
        then pg_get_functiondef(p.oid) end) order by p.oid::regprocedure::text),'[]'::jsonb)
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind='f')) as snapshot`)).snapshot;
}

async function catalogSnapshot(client) {
  return {
    security: await securitySnapshot(client),
    constraints: (await client.query(`select c.conrelid::regclass::text as relation,c.conname,
      c.convalidated,pg_get_constraintdef(c.oid) as definition from pg_constraint c
      join pg_namespace n on n.oid=c.connamespace where n.nspname='public'
      order by relation,c.conname`)).rows,
    functions: (await client.query(`select p.oid::regprocedure::text as signature,
      pg_get_functiondef(p.oid) as definition from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'
      order by signature`)).rows,
    triggers: (await client.query(`select c.relname,t.tgname,pg_get_triggerdef(t.oid) as definition
      from pg_trigger t join pg_class c on c.oid=t.tgrelid
      join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal
      order by c.relname,t.tgname`)).rows,
  };
}

async function rejectMigration(client, sql, code, message) {
  const before = await catalogSnapshot(client);
  try {
    await expectError(client.query(sql), code, message);
    await expectError(client.query('select 1'), '25P02');
  } finally {
    await client.query('rollback');
  }
  assert.deepEqual(await catalogSnapshot(client), before, 'Rejected 080 must leave the catalog unchanged');
}

function assertFiveDefaults(items) {
  assert.deepEqual(items.filter(stage => stageKeys.includes(stage.stage_key)).map(stage => ({
    key: stage.stage_key, group: stage.semantic_group, order: stage.sort_order,
    default: stage.is_default, active: stage.is_active,
  })), stageKeys.map((key, index) => ({ key, group: key,
    order: [10, 20, 30, 35, 40][index], default: true, active: true })));
}

async function seed(client) {
  const a = randomUUID(), b = randomUUID();
  for (const [name, workspace] of [['A', a], ['B', b]]) {
    await client.query('insert into public.workspaces(id,name) values($1,$2)',
      [workspace, `Disposable postponed ${name}`]);
    await client.query(`insert into public.lead_stages
      (workspace_id,stage_key,name,color,semantic_group,sort_order,is_default,is_active)
      values($1,'clinic_review','Custom clinic review','#123456','in_progress',25,false,false)`, [workspace]);
    await client.query(`insert into public.lead_sources
      (workspace_id,source_key,name,channel,color,sort_order,is_default,is_active)
      values($1,'clinic_source','Custom clinic source','other','#654321',91,false,false)`, [workspace]);
    await client.query(`update public.lead_stages set name='Customized booking',color='#112233'
      where workspace_id=$1 and stage_key='booked'`, [workspace]);
    await client.query(`update public.lead_sources set name='Customized manual source',color='#332211'
      where workspace_id=$1 and source_key='manual'`, [workspace]);
  }
  const people = [a, a, b].map(workspace => ({ id: randomUUID(), auth: randomUUID(), workspace }));
  for (const [index, person] of people.entries()) {
    await client.query(`insert into public.staff_users
      (id,auth_user_id,workspace_id,email,full_name,role,status)
      values($1,$2,$3,$4,$5,'lead_manager','active')`,
    [person.id, person.auth, person.workspace, `postponed-${index}@example.invalid`, `Synthetic manager ${index}`]);
  }
  const clientId = randomUUID(), campaign = randomUUID();
  await client.query('insert into public.clients(id,workspace_id,full_name) values($1,$2,$3)',
    [clientId, a, 'Synthetic client']);
  await client.query('insert into public.meta_campaign_launches(id,workspace_id,campaign_name) values($1,$2,$3)',
    [campaign, a, 'Synthetic campaign']);
  const taxonomy = new Map();
  for (const workspace of [a, b]) {
    taxonomy.set(workspace, {
      stages: Object.fromEntries((await stages(client, workspace)).map(stage => [stage.stage_key, stage])),
      source: await row(client, "select * from public.lead_sources where workspace_id=$1 and source_key='meta_ads'", [workspace]),
    });
  }
  const addLead = async (workspace, assignee, historical = false) => {
    const id = randomUUID(), local = taxonomy.get(workspace);
    await client.query(`insert into public.leads
      (id,workspace_id,responsible_user_id,client_id,full_name,phone,notes,status,stage_id,
       source,source_id,campaign,meta_campaign_launch_id,created_at,updated_at)
      values($1,$2,$3,$4,'Synthetic postponed lead','8 (701) 123-45-67','Original notes',$5,$6,
       'Preserved source snapshot',$7,'Preserved campaign snapshot',$8,'2026-01-01Z','2026-01-01Z')`,
    [id, workspace, assignee, workspace === a ? clientId : null, historical ? 'postponed' : 'new',
      historical ? null : local.stages.new.id, historical ? null : local.source.id,
      workspace === a ? campaign : null]);
    return id;
  };
  const own = await addLead(a, people[0].id), other = await addLead(a, people[1].id);
  const unassigned = await addLead(a, null), foreign = await addLead(b, people[2].id);
  const historical = await addLead(a, null, true);
  return { a, b, people, taxonomy, own, other, unassigned, foreign, historical };
}

// Only the shared harness may select a server: never accept a URL or skip a missing runtime.
test('postponed lead stage regressions on disposable PostgreSQL', { timeout: 300000 }, async t => {
  const migrationPath = path.join(root, 'migrations/080_postponed_lead_stage.sql');
  const sql = await readFile(migrationPath, 'utf8');
  const migrationHash = createHash('sha256').update(sql).digest('hex');
  const fixture = await startDisposablePostgres();
  try {
    const observer = await fixture.connect();
    t.diagnostic(`PostgreSQL ${(await row(observer, 'show server_version')).server_version}; owned synthetic cluster only`);
    t.diagnostic(`080 SHA-256 ${migrationHash}`);
    await t.test('080 without 019 fails closed on a fresh database', async () => {
      await rejectMigration(observer, sql, 'P8001', 'postponed_lead_stage_requires_019');
    });
    await observer.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls;
      grant usage on schema public to anon,authenticated,service_role`);
    for (const file of migrations) await observer.query(await readFile(path.join(root, 'migrations', file), 'utf8'));
    t.diagnostic('Applied only 009/010/011/014/019/028/038/069, then the tested 080');
    const f = await seed(observer), owner = f.people[0];

    // Synthetic pre-existing policies/ACLs make preservation observable, beyond 038's RLS flags.
    for (const table of ['leads', 'lead_stages', 'lead_sources']) {
      await observer.query(`alter table public.${table} enable row level security;
        grant select on public.${table} to authenticated;
        create policy fixture_workspace_read on public.${table} for select to authenticated
        using (workspace_id=nullif(current_setting('medina.fixture_workspace',true),'')::uuid)`);
    }
    await observer.query(`alter table public.lead_sources force row level security;
      revoke all on function public.seed_default_lead_taxonomy(uuid) from public,anon,authenticated;
      grant execute on function public.seed_default_lead_taxonomy(uuid) to service_role`);
    const securityBefore = await securitySnapshot(observer);
    const initial = await dataSnapshot(observer);
    const originalSeed = (await row(observer,
      'select pg_get_functiondef($1::regprocedure) as definition', [seedSignature])).definition;
    const originalCheck = (await row(observer, `select pg_get_constraintdef(oid) as definition
      from pg_constraint where conrelid='public.lead_stages'::regclass
      and conname='lead_stages_semantic_group_check'`)).definition;

    const missing = [
      ['lead_stages', 'alter table public.lead_stages rename to fixture_hidden_stages',
        'alter table public.fixture_hidden_stages rename to lead_stages'],
      ['lead_sources', 'alter table public.lead_sources rename to fixture_hidden_sources',
        'alter table public.fixture_hidden_sources rename to lead_sources'],
      ['seed function', 'alter function public.seed_default_lead_taxonomy(uuid) rename to fixture_hidden_seed',
        'alter function public.fixture_hidden_seed(uuid) rename to seed_default_lead_taxonomy'],
    ];
    for (const [name, hide, restore] of missing) await t.test(`missing ${name} fails closed independently`, async () => {
      await observer.query(hide);
      try { await rejectMigration(observer, sql, 'P8001', 'postponed_lead_stage_requires_019'); }
      finally { await observer.query('rollback'); await observer.query(restore); }
      assert.deepEqual(await dataSnapshot(observer), initial);
    });

    const customChecks = [
      ['unknown custom semantic group', "check (semantic_group in ('new','in_progress','booked','lost','clinic_custom'))"],
      ['missing semantic check', null],
      ['unvalidated semantic check', `${originalCheck} not valid`],
      ['custom restriction with the same legacy group names',
        "check (semantic_group in ('new','in_progress','booked','lost') and sort_order >= 0)"],
      ['same-column narrowed check length(semantic_group) < 7',
        "check (semantic_group in ('new','in_progress','booked','lost') and length(semantic_group) < 7)", true],
    ];
    for (const [name, definition, narrowed] of customChecks) await t.test(`${name} requires review without replacing it`, async () => {
      try {
        // Make the narrowed predicate genuinely validated, not rejected merely as NOT VALID.
        if (narrowed) await observer.query(`update public.lead_stages set semantic_group='new'
          where length(semantic_group) >= 7`);
        await observer.query('alter table public.lead_stages drop constraint lead_stages_semantic_group_check');
        if (definition) await observer.query(`alter table public.lead_stages
          add constraint lead_stages_semantic_group_check ${definition}`);
        if (narrowed) {
          assert.equal((await row(observer, `select convalidated from pg_constraint
            where conrelid='public.lead_stages'::regclass
            and conname='lead_stages_semantic_group_check'`)).convalidated, true);
        }
        const before = await dataSnapshot(observer);
        await rejectMigration(observer, sql, 'P8002', 'postponed_lead_stage_constraint_requires_review');
        assert.deepEqual(await dataSnapshot(observer), before);
      } finally {
        await observer.query('rollback');
        await observer.query('alter table public.lead_stages drop constraint if exists lead_stages_semantic_group_check');
        await observer.query(`alter table public.lead_stages add constraint lead_stages_semantic_group_check ${originalCheck}`);
        await observer.query(originalSeed);
        if (narrowed) {
          for (const stage of initial.lead_stages.filter(stage => stage.semantic_group.length >= 7)) {
            await observer.query('update public.lead_stages set semantic_group=$1 where id=$2',
              [stage.semantic_group, stage.id]);
          }
        }
      }
      assert.deepEqual(await dataSnapshot(observer), initial);
    });

    await t.test('initial 080 preserves every existing workspace, lead, custom row and security setting', async () => {
      for (const workspace of [f.a, f.b]) {
        assert.deepEqual((await stages(observer, workspace)).filter(stage => stage.is_default)
          .map(stage => stage.stage_key), legacyGroups);
      }
      await observer.query(sql);
      assert.deepEqual(await dataSnapshot(observer), initial, '080 must not backfill any existing workspace or lead');
      assert.deepEqual(await securitySnapshot(observer), securityBefore);
      assert.equal((await leadRow(observer, f.historical)).stage_id, null);
      assert.equal((await row(observer, "select count(*)::int as count from public.lead_stages where stage_key='postponed'")).count, 0);
    });

    let postponed, futurePostponed;
    await t.test('explicitly seeding only workspace A adds the fifth ordered default, with B and all existing rows unchanged', async () => {
      const before = await dataSnapshot(observer);
      await observer.query('select public.seed_default_lead_taxonomy($1)', [f.a]);
      const after = await dataSnapshot(observer);
      postponed = after.lead_stages.find(stage => stage.workspace_id === f.a && stage.stage_key === 'postponed');
      assert.ok(postponed);
      assert.equal(postponed.name, '\u041e\u0442\u043b\u043e\u0436\u0435\u043d\u0430');
      assert.equal(postponed.color, '#64748b');
      assertFiveDefaults(await stages(observer, f.a));
      assert.deepEqual({ ...after, lead_stages: after.lead_stages.filter(stage => stage.id !== postponed.id) }, before);
      assert.deepEqual((await stages(observer, f.b)).filter(stage => stage.is_default)
        .map(stage => stage.stage_key), legacyGroups);
      assert.deepEqual(await securitySnapshot(observer), securityBefore);
    });

    await t.test('the existing workspace-insert trigger gives future workspaces five defaults and unchanged sources', async () => {
      const before = await dataSnapshot(observer), workspace = randomUUID();
      await observer.query('insert into public.workspaces(id,name) values($1,$2)', [workspace, 'Disposable postponed future']);
      const after = await dataSnapshot(observer), futureStages = await stages(observer, workspace);
      assertFiveDefaults(futureStages);
      assert.equal(futureStages.length, 5);
      futurePostponed = futureStages.find(stage => stage.stage_key === 'postponed');
      const sources = after.lead_sources.filter(source => source.workspace_id === workspace);
      const originals = before.lead_sources.filter(source => source.workspace_id === f.b && source.is_default);
      const shape = source => ({ key: source.source_key, channel: source.channel, color: source.color,
        order: source.sort_order, default: source.is_default, active: source.is_active });
      assert.deepEqual(sources.map(shape).sort((a, b) => a.key.localeCompare(b.key)),
        originals.map(source => ({ ...shape(source), color: source.source_key === 'manual' ? '#64748b' : source.color }))
          .sort((a, b) => a.key.localeCompare(b.key)));
      const existing = Object.fromEntries(Object.entries(after).map(([table, items]) => [table,
        items.filter(item => table === 'workspaces' ? item.id !== workspace : item.workspace_id !== workspace)]));
      assert.deepEqual(existing, before);
    });

    await t.test('all four legacy semantic groups remain writable', async () => {
      const before = await dataSnapshot(observer);
      await observer.query('begin');
      try {
        for (const group of legacyGroups) {
          const result = await row(observer, `insert into public.lead_stages
            (workspace_id,stage_key,name,semantic_group) values($1,$2,'Legacy fixture',$3) returning semantic_group`,
          [f.a, `legacy_${group}`, group]);
          assert.equal(result.semantic_group, group);
        }
      } finally { await observer.query('rollback'); }
      assert.deepEqual(await dataSnapshot(observer), before);
    });
    await t.test('an unknown semantic group is rejected by the widened validated check without a write', async () => {
      const before = await dataSnapshot(observer);
      await expectError(observer.query(`insert into public.lead_stages
        (workspace_id,stage_key,name,semantic_group) values($1,'unknown_group','Must not persist','unknown')`, [f.a]), '23514');
      const constraint = await row(observer, `select convalidated from pg_constraint
        where conrelid='public.lead_stages'::regclass and conname='lead_stages_semantic_group_check'`);
      assert.equal(constraint.convalidated, true);
      assert.deepEqual(await dataSnapshot(observer), before);
    });

    const service = await fixture.connect();
    await service.query('set role service_role');
    await t.test('existing RLS policies still enforce workspace visibility and function ACLs remain service-only', async () => {
      const before = await dataSnapshot(observer), caller = await fixture.connect();
      try {
        for (const role of ['anon', 'authenticated', 'service_role']) {
          for (const signature of [...rpcSignatures, seedSignature]) {
            assert.equal((await row(observer, "select has_function_privilege($1,$2,'EXECUTE') as allowed",
              [role, signature])).allowed, role === 'service_role');
          }
        }
        const publicAcl = await row(observer, `select count(*)::int as count from pg_proc p
          cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          where p.oid=any($1::regprocedure[]) and a.grantee=0 and a.privilege_type='EXECUTE'`,
        [[...rpcSignatures, seedSignature]]);
        assert.equal(publicAcl.count, 0);
        for (const role of ['anon', 'authenticated']) {
          await caller.query(`set role ${role}`);
          await expectError(read(caller, owner), '42501', 'permission denied for function read_assigned_crm_leads');
          await expectError(patch(caller, owner, f.own, { status: 'postponed' }),
            '42501', 'permission denied for function patch_assigned_crm_lead');
          await expectError(caller.query('select public.seed_default_lead_taxonomy($1)', [f.b]),
            '42501', 'permission denied for function seed_default_lead_taxonomy');
        }
        for (const workspace of [null, f.a, f.b]) {
          await caller.query("select set_config('medina.fixture_workspace',$1,false)", [workspace ?? '']);
          for (const table of ['leads', 'lead_stages', 'lead_sources']) {
            const visible = (await caller.query(`select id from public.${table} order by id`)).rows.map(item => item.id);
            assert.deepEqual(visible, before[table].filter(item => item.workspace_id === workspace).map(item => item.id));
          }
        }
      } finally { await caller.end(); }
      assert.deepEqual(await dataSnapshot(observer), before);
      assert.deepEqual(await securitySnapshot(observer), securityBefore);
    });

    await t.test('069 round-trips an owned lead through postponed stage-only, status-only, combined and legacy patches', async () => {
      const local = f.taxonomy.get(f.a).stages;
      const changes = [
        { stage_id: postponed.id }, { status: 'new' }, { status: 'postponed' },
        { stage_id: postponed.id, status: 'postponed' },
        ...legacyGroups.map(status => ({ status })),
      ];
      for (const change of changes) {
        const before = await dataSnapshot(observer), old = await leadRow(observer, f.own);
        const result = await patch(service, owner, f.own, change), after = await leadRow(observer, f.own);
        const status = change.status ?? 'postponed', expectedStage = status === 'postponed' ? postponed : local[status];
        assert.deepEqual(result.before, old);
        assert.equal(after.status, status);
        assert.equal(after.stage_id, expectedStage.id);
        for (const key of Object.keys(old).filter(key => !['status', 'stage_id', 'updated_at'].includes(key))) {
          assert.deepEqual(after[key], old[key], `PATCH must preserve ${key}`);
        }
        assert.ok(Date.parse(after.updated_at) >= Date.parse(old.updated_at));
        const items = await read(service, owner);
        assert.deepEqual(items.map(item => item.id), [f.own]);
        assert.deepEqual(items[0], result.item);
        assert.equal(result.item.stage_definition.id, expectedStage.id);
        assert.equal(result.item.stage_definition.semantic_group, status);
        assert.equal(result.item.stage_definition.workspace_id, f.a);
        assert.equal(result.item.source_definition.id, old.source_id);
        const snapshot = await dataSnapshot(observer);
        assert.deepEqual({ ...snapshot, leads: snapshot.leads.map(lead => lead.id === old.id ? old : lead) }, before);
      }
    });

    const denied = [
      ['another assigned manager cannot change the owner lead', f.people[1], f.own,
        { status: 'postponed' }, 'P6902', 'assigned_lead_not_found'],
      ['owner cannot change another manager lead', owner, f.other,
        { stage_id: () => postponed.id }, 'P6902', 'assigned_lead_not_found'],
      ['unassigned lead', owner, f.unassigned, { status: 'postponed' }, 'P6902', 'assigned_lead_not_found'],
      ['foreign lead', owner, f.foreign, { status: 'postponed' }, 'P6902', 'assigned_lead_not_found'],
      ['foreign postponed stage', owner, f.own, { stage_id: () => futurePostponed.id, status: 'postponed' },
        'P6903', 'assigned_lead_stage_invalid'],
      ['mismatched postponed stage/status', owner, f.own, { stage_id: () => postponed.id, status: 'new' },
        'P6903', 'assigned_lead_stage_invalid'],
      ['unknown status', owner, f.own, { status: 'unknown' }, 'P6903', 'assigned_lead_stage_invalid'],
      ...[f.people[1].id, null, owner.id].map(assignee => [
        `assignment change to ${assignee === null ? 'null' : assignee === owner.id ? 'self' : 'another manager'}`,
        owner, f.own, { responsible_user_id: assignee, status: 'postponed' }, 'P6903', 'assigned_lead_patch_invalid',
      ]),
    ];
    for (const [name, person, id, change, code, message] of denied) await t.test(`069 denies ${name} with all data unchanged`, async () => {
      const before = await dataSnapshot(observer);
      const resolved = Object.fromEntries(Object.entries(change).map(([key, value]) =>
        [key, typeof value === 'function' ? value() : value]));
      await expectError(patch(service, person, id, { notes: 'Must not persist', ...resolved }), code, message);
      assert.deepEqual(await dataSnapshot(observer), before);
    });

    await t.test('repeated 080 and scoped seeds never overwrite customized postponed configuration or backfill B', async () => {
      await observer.query(`update public.lead_stages set name='Custom postponed label',color='#aabbcc',
        semantic_group='in_progress',sort_order=17,is_default=false,is_active=false,
        updated_at='2026-02-01Z' where id=$1`, [postponed.id]);
      const before = await dataSnapshot(observer);
      for (let repeat = 0; repeat < 2; repeat++) {
        await observer.query(sql);
        assert.deepEqual(await dataSnapshot(observer), before, 'Repeating 080 must not seed existing workspaces');
        await observer.query('select public.seed_default_lead_taxonomy($1)', [f.a]);
        assert.deepEqual(await dataSnapshot(observer), before, 'ON CONFLICT must preserve every customized field and timestamp');
        assert.deepEqual(await securitySnapshot(observer), securityBefore);
      }
      assert.equal((await stages(observer, f.b)).some(stage => stage.stage_key === 'postponed'), false);
      await expectError(patch(service, owner, f.own, { status: 'postponed', notes: 'Inactive must not persist' }),
        'P6903', 'assigned_lead_stage_invalid');
      assert.deepEqual(await dataSnapshot(observer), before);
    });
    assert.equal(createHash('sha256').update(await readFile(migrationPath, 'utf8')).digest('hex'),
      migrationHash, '080 changed during this run; rerun against the latest migration');
    t.diagnostic('080 source hash unchanged through completion');
  } finally {
    await fixture.close();
    t.diagnostic('Owned disposable cluster stopped and removed in finally');
  }
});

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startDisposablePostgres } from './disposable-postgres.mjs';

const read = file => readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8');
const tables = ['lead_stages', 'lead_sources'];
const signatures = ['public.seed_default_lead_taxonomy(uuid)', 'public.seed_default_lead_taxonomy_after_workspace_insert()'];
const row = async (client, sql, args = []) => (await client.query(sql, args)).rows[0];
const observe = promise => promise.then(value => ({ value }), error => ({ error }));

async function rows(client) {
  const result = {};
  for (const { tablename } of (await client.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows) {
    result[tablename] = (await row(client, `select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),'[]'::jsonb) as data from public.${tablename} r`)).data;
  }
  return result;
}

async function catalog(client) {
  return (await row(client, `select jsonb_build_object(
    'tables',(select jsonb_agg(jsonb_build_object('table',c.relname,'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force',c.relforcerowsecurity)
      order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'),
    'columns',(select jsonb_agg(jsonb_build_object('table',c.relname,'column',a.attname,'acl',a.attacl) order by c.relname,a.attnum)
      from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and a.attnum>0 and not a.attisdropped),
    'functions',(select jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'owner',p.proowner,'acl',p.proacl,'definition',pg_get_functiondef(p.oid))
      order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'),
    'policies',(select coalesce(jsonb_agg(to_jsonb(p) order by p.tablename,p.policyname),'[]'::jsonb) from pg_policies p where p.schemaname='public'),
    'roles',(select jsonb_agg(jsonb_build_object('name',rolname,'bypass',rolbypassrls,'login',rolcanlogin) order by rolname)
      from pg_roles where rolname in ('anon','authenticated','service_role'))
    ) as snapshot`)).snapshot;
}

async function deny(client, query, args = [], code = '42501') {
  await assert.rejects(client.query(query, args), error => error.code === code);
}

async function rejectedMigration(client, sql, message) {
  const before = await catalog(client), data = await rows(client);
  try {
    await assert.rejects(client.query(sql), error => error.message === message);
    await deny(client, 'select 1', [], '25P02');
  } finally { await client.query('rollback'); }
  assert.deepEqual(await catalog(client), before, 'Rejected migration cannot partially change ACL, policy, role or RLS');
  assert.deepEqual(await rows(client), data, 'Rejected migration cannot mutate business data');
}

async function as(client, role, action) {
  assert.ok(['anon', 'authenticated', 'service_role'].includes(role));
  await client.query(`set role ${role}`);
  try { return await action(); } finally { await client.query('reset role'); }
}

async function waitForLock(observer, pid) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const state = await row(observer, 'select wait_event_type from pg_stat_activity where pid=$1', [pid]);
    if (state?.wait_event_type === 'Lock') return;
    await delay(10);
  }
  assert.fail('The owned migration never reached an authoritative PostgreSQL lock wait');
}

test('091 taxonomy hardening executes real grants/RLS on owned PostgreSQL', { timeout: 180000 }, async t => {
  const sql = await read('091_lead_taxonomy_server_access.sql');
  const fixture = await startDisposablePostgres();
  try {
    const admin = await fixture.connect();
    await admin.query(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      grant usage on schema public to anon,authenticated,service_role`);
    t.diagnostic(`PostgreSQL ${(await row(admin, 'show server_version')).server_version}; no external database URL`);
    t.diagnostic(`091 SHA-256 ${createHash('sha256').update(sql).digest('hex')}`);
    await t.test('missing 019 refuses without creating tables or granting access', async () => {
      await rejectedMigration(admin, sql, 'lead_taxonomy_dependencies_unconfirmed');
    });
    for (const file of ['009_medcall_mvp_persistence.sql','010_staff_ready_crm.sql','011_staff_auth_foundation.sql',
      '014_meta_ad_launches.sql','019_crm_lead_pipeline_foundation.sql','028_leads_phone_normalized.sql',
      '038_staff_join_requests.sql','069_assigned_lead_manager.sql','080_postponed_lead_stage.sql']) await admin.query(await read(file));
    const a = randomUUID(), b = randomUUID(), manager = randomUUID(), auth = randomUUID(), lead = randomUUID();
    await admin.query("insert into public.workspaces(id,name) values($1,'Owned taxonomy A'),($2,'Owned taxonomy B')", [a,b]);
    await admin.query(`insert into public.staff_users(id,workspace_id,auth_user_id,email,full_name,role,status)
      values($1,$2,$3,'taxonomy@example.invalid','Synthetic manager','lead_manager','active')`, [manager,a,auth]);
    await admin.query(`insert into public.leads(id,workspace_id,responsible_user_id,full_name,phone,status,stage_id)
      values($1,$2,$3,'Synthetic lead','+77010000000','new',(select id from public.lead_stages where workspace_id=$2 and stage_key='new'))`, [lead,a,manager]);
    await admin.query(`update public.lead_stages set name='Owned custom name',sort_order=53,is_active=false where workspace_id=$1 and stage_key='booked';
      `, [a]);
    await admin.query(`insert into public.lead_sources(workspace_id,source_key,name,channel,sort_order,is_default,is_active)
      values($1,'owned_custom','Owned custom source','other',77,false,false)`, [b]);
    await admin.query(`grant select,insert,update,delete on public.workspaces to service_role;
      grant all on public.lead_stages,public.lead_sources to public,anon,authenticated;
      grant select(id,name),insert(name),update(name),references(id) on public.lead_stages to anon,authenticated;
      grant select(id,name),insert(name),update(name),references(id) on public.lead_sources to anon,authenticated;
      create policy owned_legacy_policy on public.lead_stages for all to public using(true) with check(true);
      create policy owned_legacy_policy on public.lead_sources for all to public using(true) with check(true);`);
    await t.test('baseline reproduces missing RLS and direct browser reading on synthetic legacy grants', async () => {
      for (const table of tables) {
        assert.equal((await row(admin, 'select relrowsecurity as enabled from pg_class where oid=$1::regclass', [`public.${table}`])).enabled, false);
        await as(admin, 'authenticated', async () => {
          const scope = (await admin.query(`select distinct workspace_id from public.${table} order by workspace_id`)).rows;
          assert.equal(scope.length, 2, 'The red baseline actually reads both synthetic workspaces');
        });
      }
    });
    await t.test('inherited table grants cause an atomic refusal instead of a false success', async () => {
      await admin.query(`create role owned_taxonomy_reader nologin; grant select on public.lead_stages to owned_taxonomy_reader;
        grant owned_taxonomy_reader to authenticated`);
      try { await rejectedMigration(admin, sql, 'lead_taxonomy_browser_access_unconfirmed'); }
      finally { await admin.query('revoke owned_taxonomy_reader from authenticated; drop owned by owned_taxonomy_reader; drop role owned_taxonomy_reader'); }
    });
    await t.test('inherited column grants are not hidden by table-level revocation', async () => {
      await admin.query(`create role owned_taxonomy_column_reader nologin; grant select(name) on public.lead_sources to owned_taxonomy_column_reader;
        grant owned_taxonomy_column_reader to anon`);
      try { await rejectedMigration(admin, sql, 'lead_taxonomy_browser_access_unconfirmed'); }
      finally { await admin.query('revoke owned_taxonomy_column_reader from anon; drop owned by owned_taxonomy_column_reader; drop role owned_taxonomy_column_reader'); }
    });
    await t.test('inherited seed execution causes a full rollback', async () => {
      await admin.query(`create role owned_taxonomy_seed_reader nologin;
        grant execute on function public.seed_default_lead_taxonomy(uuid) to owned_taxonomy_seed_reader;
        grant owned_taxonomy_seed_reader to authenticated`);
      try { await rejectedMigration(admin, sql, 'lead_taxonomy_browser_function_access_unconfirmed'); }
      finally { await admin.query('revoke owned_taxonomy_seed_reader from authenticated; drop owned by owned_taxonomy_seed_reader; drop role owned_taxonomy_seed_reader'); }
    });
    await t.test('missing service bypass refuses without weakening RLS', async () => {
      await admin.query('alter role service_role nobypassrls');
      try { await rejectedMigration(admin, sql, 'lead_taxonomy_dependencies_unconfirmed'); }
      finally { await admin.query('alter role service_role bypassrls'); }
    });
    await t.test('DDL lock timeout leaves all permissions and data unchanged', async () => {
      const blocker = await fixture.connect(), runner = await fixture.connect();
      await blocker.query('begin; lock table public.lead_sources in access share mode');
      const pid = (await row(runner, 'select pg_backend_pid() as pid')).pid;
      const before = await catalog(admin), data = await rows(admin);
      const pending = observe(runner.query(sql));
      try {
        await waitForLock(admin, pid);
        const result = await pending;
        assert.equal(result.error?.code, '55P03');
        await runner.query('rollback');
      } finally { await blocker.query('rollback'); await blocker.end(); await runner.end(); }
      assert.deepEqual(await catalog(admin), before); assert.deepEqual(await rows(admin), data);
    });
    const before = await rows(admin), functionsBefore = await admin.query(`select p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid) as definition
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' order by signature`);
    await t.test('091 changes no business rows, routine definitions, policies or role settings', async () => {
      const policies = (await admin.query("select * from pg_policies where schemaname='public' order by tablename,policyname")).rows;
      await admin.query(sql);
      assert.deepEqual(await rows(admin), before);
      assert.deepEqual((await admin.query(`select p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid) as definition from pg_proc p
        join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' order by signature`)).rows, functionsBefore.rows);
      assert.deepEqual((await admin.query("select * from pg_policies where schemaname='public' order by tablename,policyname")).rows, policies);
    });
    for (const role of ['anon','authenticated']) for (const table of tables) {
      await t.test(`${role} has neither table nor column permissions on ${table}`, async () => {
        const grants = await row(admin, `select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as table_acl,
          has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') as column_acl`, [role,`public.${table}`]);
        assert.deepEqual(grants, { table_acl:false, column_acl:false });
        assert.equal((await row(admin,'select relrowsecurity as enabled from pg_class where oid=$1::regclass',[`public.${table}`])).enabled, true);
      });
      for (const command of [`select * from public.${table}`,`select name from public.${table}`,`update public.${table} set name='forbidden'`,
        `delete from public.${table}`,`truncate public.${table}`]) {
        await t.test(`${role} actual ${command.split(' ')[0]} ${table} is denied`, async () => {
          await as(admin, role, () => deny(admin, command));
        });
      }
    }
    for (const role of ['anon','authenticated']) await t.test(`${role} cannot seed or invoke the seed trigger routine`, async () => {
      for (const signature of signatures) assert.equal((await row(admin, 'select has_function_privilege($1,$2,\'EXECUTE\') as allowed',[role,signature])).allowed,false);
      await as(admin, role, () => deny(admin,'select public.seed_default_lead_taxonomy($1)',[a]));
    });
    await t.test('server can read scoped taxonomy and exercise CRUD without bypassing the browser denial', async () => {
      await admin.query('begin');
      try {
        await as(admin, 'service_role', async () => {
          assert.equal((await row(admin,'select count(*)::int as count from public.lead_stages where workspace_id=$1',[a])).count,5);
          const own = (await row(admin, `insert into public.lead_sources(workspace_id,source_key,name) values($1,'owned_temporary','Owned temporary') returning id`,[a])).id;
          await admin.query("update public.lead_sources set name='Owned updated' where workspace_id=$1 and id=$2",[a,own]);
          assert.equal((await row(admin,'select name from public.lead_sources where workspace_id=$1 and id=$2',[a,own])).name,'Owned updated');
          await admin.query('delete from public.lead_sources where workspace_id=$1 and id=$2',[a,own]);
        });
      } finally { await admin.query('rollback'); }
      assert.deepEqual(await rows(admin),before);
    });
    await t.test('actual assigned-lead RPC still reads its joined stage while denying another actor', async () => {
      await admin.query('grant execute on function public.read_assigned_crm_leads(uuid,uuid,uuid) to service_role');
      await as(admin,'service_role',async () => {
        const receipt=(await row(admin,'select public.read_assigned_crm_leads($1,$2,$3) as data',[a,manager,auth])).data;
        assert.ok(JSON.stringify(receipt).includes(lead));
        const denied=await observe(admin.query('select public.read_assigned_crm_leads($1,$2,$3)',[b,manager,auth]));
        assert.equal(denied.error?.code,'P6901');
      });
    });
    await t.test('future server workspace trigger still seeds five stages and never edits previous workspaces', async () => {
      const future=randomUUID();
      await admin.query('begin');
      try {
        await as(admin,'service_role',async () => {
          await admin.query("insert into public.workspaces(id,name) values($1,'Owned future')",[future]);
          assert.equal((await row(admin,'select count(*)::int as count from public.lead_stages where workspace_id=$1',[future])).count,5);
          assert.equal((await row(admin,'select count(*)::int as count from public.lead_sources where workspace_id=$1',[future])).count,8);
        });
      } finally { await admin.query('rollback'); }
      assert.deepEqual(await rows(admin),before);
    });
    await t.test('reapplication is idempotent and does not recreate browser grants',async () => {
      const snapshot=await catalog(admin); await admin.query(sql); assert.deepEqual(await catalog(admin),snapshot); assert.deepEqual(await rows(admin),before);
    });
    await t.test('080 replacement after 091 preserves the seed execute boundary and every existing row',async () => {
      await admin.query(await read('080_postponed_lead_stage.sql'));
      for(const role of ['anon','authenticated']) assert.equal((await row(admin,'select has_function_privilege($1,$2,\'EXECUTE\') as allowed',[role,signatures[0]])).allowed,false);
      assert.deepEqual(await rows(admin),before);
    });
  } finally { await fixture.close(); }
});

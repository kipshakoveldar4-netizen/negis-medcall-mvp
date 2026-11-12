import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { legacyAccessSnapshot } from './legacy-server-access-cases.mjs';

export const legacyCrmRlsTables = Object.freeze(['ai_provider_settings','calls','chat_messages','clients',
  'integration_statuses','staff_users','workspace_settings']);
const one = async (db, sql, args = []) => (await db.query(sql,args)).rows[0];
const q = value => '"'+value.replaceAll('"','""')+'"';
const insertions=Object.freeze({
  ai_provider_settings:"insert into public.ai_provider_settings(id,workspace_id,provider,purpose,enabled) values($1::uuid,$2::uuid,($1::uuid)::text,'synthetic',false)",
  calls:"insert into public.calls(id,workspace_id,summary) values($1,$2,'SYNTHETIC ONLY')",
  chat_messages:"insert into public.chat_messages(id,workspace_id,message) values($1,$2,'SYNTHETIC ONLY')",
  clients:"insert into public.clients(id,workspace_id,full_name) values($1,$2,'SYNTHETIC ONLY')",
  integration_statuses:"insert into public.integration_statuses(id,workspace_id,provider) values($1::uuid,$2::uuid,($1::uuid)::text)",
  staff_users:"insert into public.staff_users(id,workspace_id,email,full_name,role) values($1::uuid,$2::uuid,($1::uuid)::text||'@fixture.invalid','SYNTHETIC ONLY','admin')",
  workspace_settings:"insert into public.workspace_settings(id,workspace_id,key,value) values($1::uuid,$2::uuid,($1::uuid)::text,'{}')",
});

export async function legacyCrmRlsSnapshot(db) {
  const snapshot=await legacyAccessSnapshot(db);
  snapshot.definitions=(await one(db,`select jsonb_build_object(
    'constraints',(select coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',k.conname,
      'definition',pg_get_constraintdef(k.oid,true),'validated',k.convalidated) order by c.relname,k.conname),'[]'::jsonb)
      from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'),
    'indexes',(select coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'definition',pg_get_indexdef(c.oid),
      'valid',i.indisvalid,'ready',i.indisready) order by c.relname),'[]'::jsonb) from pg_index i
      join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'),
    'triggers',(select coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'enabled',t.tgenabled,
      'definition',pg_get_triggerdef(t.oid)) order by c.relname,t.tgname),'[]'::jsonb) from pg_trigger t
      join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal),
    'defaults',(select coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'column',a.attname,'notnull',a.attnotnull,
      'expression',pg_get_expr(d.adbin,d.adrelid)) order by c.relname,a.attnum),'[]'::jsonb) from pg_class c
      join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
      left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where n.nspname='public' and c.relkind='r')
    ) as value`)).value;
  return snapshot;
}

async function rollback(db, action) {
  await db.query('begin');
  try { return await action(); } finally { await db.query('rollback'); }
}
async function asRole(db, name, action) {
  assert.ok(['anon','authenticated','service_role'].includes(name));
  await db.query(`set role ${q(name)}`);
  try { return await action(); } finally { await db.query('reset role'); }
}
async function deniedWrite(db, sql, args) {
  await db.query('savepoint owned_rls_denial');
  try { await assert.rejects(db.query(sql,args),error=>error.code==='42501'); }
  finally { await db.query('rollback to savepoint owned_rls_denial'); }
}
function comparable(snapshot) {
  const result=structuredClone(snapshot);
  for(const table of result.catalog.tables ?? []) if(table.schema==='public'&&legacyCrmRlsTables.includes(table.name)) delete table.rls;
  return result;
}

export async function exerciseLegacyCrmRlsRefusals(db,sql,t) {
  const reject = async message => {
    const before=await legacyCrmRlsSnapshot(db);
    try { await assert.rejects(db.query(sql),error=>error.message===message); }
    finally { await db.query('rollback'); }
    assert.deepEqual(await legacyCrmRlsSnapshot(db),before,'A refused 100 must not change rows, grants, policies, roles, definitions, defaults or any RLS flag');
  };
  const change = async (name,setup,restore,message) => {
    let passed=false;
    await t.test(name,async()=>{await db.query(setup);try {await reject(message);} finally {await db.query(restore);}passed=true;});
    assert.ok(passed,`Stop after failed precondition case: ${name}`);
  };
  await change('100 missing relation refuses atomically','alter table public.calls rename to owned_100_missing',
    'alter table public.owned_100_missing rename to calls','legacy_crm_rls_relations_unconfirmed');
  await change('100 mismatched workspace column refuses atomically','alter table public.chat_messages rename workspace_id to owned_100_missing',
    'alter table public.chat_messages rename owned_100_missing to workspace_id','legacy_crm_rls_columns_unconfirmed');
  await change('100 mismatched UUID type refuses atomically','alter table public.ai_provider_settings alter column id type text using id::text',
    'alter table public.ai_provider_settings alter column id type uuid using id::uuid','legacy_crm_rls_columns_unconfirmed');
  await change('100 unreviewed inheritance refuses atomically','create table public.owned_100_child() inherits(public.calls)',
    'drop table public.owned_100_child','legacy_crm_rls_relations_unconfirmed');
  await change('100 missing one required server privilege refuses atomically','revoke update on public.clients from service_role',
    'grant update on public.clients to service_role','legacy_crm_rls_server_access_unconfirmed');
  await change('100 service BYPASSRLS is an explicit dependency','alter role service_role nobypassrls',
    'alter role service_role bypassrls','legacy_crm_rls_roles_unconfirmed');
  await change('100 browser BYPASSRLS refuses atomically','alter role anon bypassrls',
    'alter role anon nobypassrls','legacy_crm_rls_roles_unconfirmed');
  await change('100 browser can become a bypass role refuses atomically','grant service_role to authenticated',
    'revoke service_role from authenticated','legacy_crm_rls_role_membership_unconfirmed');
  await change('100 browser table privileges are not silently rewritten','grant select on public.calls to anon',
    'revoke select on public.calls from anon','legacy_crm_rls_browser_access_unconfirmed');
  await change('100 PUBLIC column privileges are not silently rewritten','grant update(message) on public.chat_messages to public',
    'revoke update(message) on public.chat_messages from public','legacy_crm_rls_browser_access_unconfirmed');
  await db.query('create role owned_100_reader; grant owned_100_reader to anon');
  try {
    await change('100 inherited column privileges refuse atomically','grant select(full_name) on public.clients to owned_100_reader',
      'revoke select(full_name) on public.clients from owned_100_reader','legacy_crm_rls_browser_access_unconfirmed');
    await change('100 inherited permissive policy refuses without erasing it','create policy owned_100_inherited on public.clients for select to owned_100_reader using(true)',
      'drop policy owned_100_inherited on public.clients','legacy_crm_rls_browser_policy_unconfirmed');
  } finally { await db.query('revoke owned_100_reader from anon; drop role owned_100_reader'); }
  await change('100 PUBLIC permissive policy refuses without erasing it','create policy owned_100_public on public.clients using(true)',
    'drop policy owned_100_public on public.clients','legacy_crm_rls_browser_policy_unconfirmed');
  await db.query('create role owned_100_owner');
  try {await change('100 unexpected table owner refuses atomically','alter table public.clients owner to owned_100_owner',
    'alter table public.clients owner to postgres','legacy_crm_rls_relations_unconfirmed');}
  finally {await db.query('drop role owned_100_owner');}
}

export async function proveLegacyCrmRlsChange(db,before,sql) {
  const after=await legacyCrmRlsSnapshot(db);
  assert.deepEqual(comparable(after),comparable(before),'100 may change only seven RLS flags');
  for(const name of legacyCrmRlsTables) assert.equal(after.catalog.tables.find(table=>table.schema==='public'&&table.name===name)?.rls,true,name);
  await db.query(sql);
  assert.deepEqual(await legacyCrmRlsSnapshot(db),after,'100 is idempotent without altering existing data or policy');
}

async function seed(db) {
  const workspaces=[randomUUID(),randomUUID()];
  await db.query("insert into public.workspaces(id,name) values($1,'SYNTHETIC RLS A'),($2,'SYNTHETIC RLS B')",workspaces);
  const rows=[];
  for(const workspace of workspaces) {
    const record={workspace,ids:{}};
    for(const name of legacyCrmRlsTables) {const id=randomUUID();await db.query(insertions[name],[id,workspace]);record.ids[name]=id;}
    rows.push(record);
  }
  return rows;
}

export async function proveLegacyCrmRlsBaseline(db) {
  await rollback(db,async()=>{
    const rows=await seed(db);
    for(const name of legacyCrmRlsTables) {
      assert.equal((await one(db,'select relrowsecurity as enabled from pg_class where oid=$1::regclass',[`public.${name}`])).enabled,false);
      await db.query(`grant select on public.${q(name)} to anon`);
      await asRole(db,'anon',async()=>assert.equal((await one(db,`select count(*)::int as n from public.${q(name)} where id=any($1::uuid[])`,[rows.map(row=>row.ids[name])])).n,2));
    }
  });
}

export async function proveLegacyCrmRlsEnforcement(db) {
  await rollback(db,async()=>{
    const rows=await seed(db);
    for(const name of legacyCrmRlsTables) {
      const ids=rows.map(row=>row.ids[name]);
      await asRole(db,'service_role',async()=>{
        assert.equal((await one(db,`select count(*)::int as n from public.${q(name)} where id=any($1::uuid[])`,[ids])).n,2);
        assert.equal((await db.query(`update public.${q(name)} set id=id where id=any($1::uuid[])`,[ids])).rowCount,2);
        const created=randomUUID();await db.query(insertions[name],[created,rows[0].workspace]);ids.push(created);
        assert.equal((await one(db,`select count(*)::int as n from public.${q(name)} where id=any($1::uuid[])`,[ids])).n,3);
      });
      // Simulate a future mistaken DML grant in this owned rollback only. Never
      // grant TRUNCATE/REFERENCES: PostgreSQL RLS does not constrain those.
      await db.query(`grant select,insert,update,delete on public.${q(name)} to anon,authenticated`);
      for(const browser of ['anon','authenticated']) await asRole(db,browser,async()=>{
        assert.equal((await one(db,`select count(*)::int as n from public.${q(name)} where id=any($1::uuid[])`,[ids])).n,0);
        assert.equal((await db.query(`update public.${q(name)} set id=id where id=any($1::uuid[])`,[ids])).rowCount,0);
        assert.equal((await db.query(`delete from public.${q(name)} where id=any($1::uuid[])`,[ids])).rowCount,0);
        await deniedWrite(db,insertions[name],[randomUUID(),rows[0].workspace]);
      });
    }
  });
}

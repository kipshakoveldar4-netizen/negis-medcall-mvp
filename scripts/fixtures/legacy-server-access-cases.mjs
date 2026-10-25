import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { legacyServerAccessRequirements as requirements } from './legacy-server-access-requirements.mjs';

const q = name => '"' + name.replaceAll('"', '""') + '"';
const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
const observed = promise => promise.then(value => ({ value }), error => ({ error }));
const operations = requirement => requirement.privileges.map(privilege => [privilege,
  privilege === 'SELECT' ? `select * from public.${q(requirement.table)} limit 0`
    : privilege === 'INSERT' ? `insert into public.${q(requirement.table)}(id) select null::uuid where false`
      : `update public.${q(requirement.table)} set id=id where false`]);

export async function legacyAccessSnapshot(db) {
  const catalog = (await one(db, `select jsonb_build_object(
    'tables',(select jsonb_agg(jsonb_build_object('name',c.relname,'schema',n.nspname,'kind',c.relkind,'owner',c.relowner,
      'rls',c.relrowsecurity,'force',c.relforcerowsecurity,'acl',c.relacl) order by n.nspname,c.relname)
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','storage') and c.relkind in ('r','p','v','m','f','S')),
    'columns',(select jsonb_agg(jsonb_build_object('table',c.relname,'schema',n.nspname,'name',a.attname,'type',a.atttypid,
      'generated',a.attgenerated,'acl',a.attacl) order by n.nspname,c.relname,a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid
      join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','storage') and a.attnum>0 and not a.attisdropped),
    'defaults',(select coalesce(jsonb_agg(to_jsonb(d) order by d.oid),'[]'::jsonb) from pg_default_acl d),
    'policies',(select coalesce(jsonb_agg(to_jsonb(p) order by p.schemaname,p.tablename,p.policyname),'[]'::jsonb) from pg_policies p),
    'routines',(select coalesce(jsonb_agg(jsonb_build_object('id',p.oid,'acl',p.proacl,'source',p.prosrc,'settings',p.proconfig)
      order by p.oid),'[]'::jsonb) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','storage')),
    'roles',(select jsonb_agg(jsonb_build_object('name',rolname,'bypass',rolbypassrls,'login',rolcanlogin,'super',rolsuper,'inherit',rolinherit) order by rolname) from pg_roles),
    'memberships',(select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member),'[]'::jsonb) from pg_auth_members m)
    ) as value`)).value;
  const tables = (await db.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows;
  const fields = tables.map(({ tablename }) => `${"'" + tablename.replaceAll("'", "''") + "'"},
    (select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),'[]'::jsonb) from public.${q(tablename)} r)`);
  // jsonb_build_object accepts at most 100 arguments; a SELECT per table stays
  // bounded and also works for the full cumulative application catalogue.
  const data = {};
  for (let start = 0; start < fields.length; start += 40) Object.assign(data,
    (await one(db, `select jsonb_build_object(${fields.slice(start, start + 40).join(',')}) as value`)).value);
  return { catalog, data };
}

async function service(db, action) {
  await db.query('set role service_role');
  try { return await action(); } finally { await db.query('reset role'); }
}

export async function proveLegacyAccessBaseline(db) {
  const missing = [];
  for (const requirement of requirements) for (const [privilege, sql] of operations(requirement)) {
    assert.equal((await one(db, "select has_table_privilege('service_role',$1,$2) as allowed", [`public.${requirement.table}`, privilege])).allowed, false,
      `${requirement.table}:${privilege}: the claimed fresh-chain missing right is not reproduced`);
    await service(db, async () => {
      const result = await observed(db.query(sql));
      assert.equal(result.error?.code, '42501', `${requirement.table}:${privilege}: require actual SQL permission denial before 098`);
    });
    missing.push(`${requirement.table}:${privilege}`);
  }
  assert.equal(missing.length, 17);
  return missing;
}

async function rejected(db, sql, message) {
  const before = await legacyAccessSnapshot(db);
  try {
    const result = await observed(db.query(sql)); assert.equal(result.error?.message, message);
    const aborted = await observed(db.query('select 1')); assert.equal(aborted.error?.code, '25P02');
  } finally { await db.query('rollback'); }
  assert.deepEqual(await legacyAccessSnapshot(db), before, 'Failed 098 cannot partially grant, enable RLS, change defaults/policies/roles or alter any business row');
}

export async function exerciseLegacyAccessRefusals(db, sql, t) {
  const check = async (name, action) => {
    let passed = false;
    await t.test(name, async () => { await action(); passed = true; });
    assert.ok(passed, `${name}: stop before accepting the candidate`);
  };
  await check('098 missing dependency refuses atomically', async () => {
    await db.query('alter table public.release_checks rename to owned_098_missing_dependency');
    try { await rejected(db, sql, 'legacy_server_dependencies_unconfirmed'); }
    finally { await db.query('alter table public.owned_098_missing_dependency rename to release_checks'); }
  });
  await check('098 missing API column refuses atomically', async () => {
    await db.query('alter table public.content_videos rename column audience to owned_098_missing_column');
    try { await rejected(db, sql, 'legacy_server_columns_unconfirmed'); }
    finally { await db.query('alter table public.content_videos rename column owned_098_missing_column to audience'); }
  });
  await check('098 wrong API column type refuses atomically', async () => {
    await db.query('alter table public.content_videos alter column duration type integer using null');
    try { await rejected(db, sql, 'legacy_server_columns_unconfirmed'); }
    finally { await db.query('alter table public.content_videos alter column duration type text using duration::text'); }
  });
  await check('098 service RLS bypass is an explicit dependency', async () => {
    await db.query('alter role service_role nobypassrls');
    try { await rejected(db, sql, 'legacy_server_dependencies_unconfirmed'); }
    finally { await db.query('alter role service_role bypassrls'); }
  });
  for (const [name, grant, principal] of [
    ['inherited browser table reader', 'grant select on public.meta_ad_accounts to %ROLE%', 'authenticated'],
    ['inherited browser column writer', 'grant update(title) on public.content_videos to %ROLE%', 'anon'],
    ['inherited service deleter', 'grant delete on public.targeting_campaigns to %ROLE%', 'service_role'],
  ]) await check(`098 ${name} cannot cross the minimal ACL boundary`, async () => {
    const probe = 'owned_098_' + randomUUID().replaceAll('-', '');
    await db.query(`create role ${q(probe)} nologin`);
    await db.query(grant.replace('%ROLE%', q(probe))); await db.query(`grant ${q(probe)} to ${q(principal)}`);
    try { await rejected(db, sql, principal === 'service_role' ? 'legacy_server_unreviewed_server_access' : 'legacy_server_browser_access_unconfirmed'); }
    finally {
      await db.query(`revoke ${q(probe)} from ${q(principal)}`);
      await db.query(`drop owned by ${q(probe)}`); await db.query(`drop role ${q(probe)}`);
    }
  });
  await check('098 PUBLIC column reader refuses without silently revoking it', async () => {
    await db.query('grant select(summary) on public.targeting_reports to public');
    try { await rejected(db, sql, 'legacy_server_browser_access_unconfirmed'); }
    finally { await db.query('revoke select(summary) on public.targeting_reports from public'); }
  });
  await check('098 service delegation is not a bootstrap prerequisite', async () => {
    await db.query('grant insert on public.meta_launch_audit_logs to service_role with grant option');
    try { await rejected(db, sql, 'legacy_server_unreviewed_server_access'); }
    finally { await db.query('revoke insert on public.meta_launch_audit_logs from service_role'); }
  });
  await check('098 service column delegation also refuses atomically', async () => {
    await db.query('grant insert(title) on public.content_videos to service_role with grant option');
    try { await rejected(db, sql, 'legacy_server_unreviewed_server_access'); }
    finally { await db.query('revoke insert(title) on public.content_videos from service_role'); }
  });
}

export async function proveLegacyAccessRepair(db, before, sql) {
  const after = await legacyAccessSnapshot(db);
  assert.deepEqual(after.data, before.data, '098 cannot change any business row');
  for (const key of ['columns', 'defaults', 'policies', 'routines', 'roles', 'memberships']) assert.deepEqual(after.catalog[key], before.catalog[key], key);
  const own = new Set(requirements.map(requirement => requirement.table));
  const neutral = tables => tables.map(table => own.has(table.name) && table.schema === 'public' ? { ...table, acl: null, rls: null } : table);
  assert.deepEqual(neutral(after.catalog.tables), neutral(before.catalog.tables), 'Only the seven table ACL/RLS flags may change');
  for (const requirement of requirements) {
    assert.equal(after.catalog.tables.find(table => table.schema === 'public' && table.name === requirement.table)?.rls, true);
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      assert.equal((await one(db, "select has_table_privilege('service_role',$1,$2) as allowed", [`public.${requirement.table}`, privilege])).allowed,
        requirement.privileges.includes(privilege), `${requirement.table}:${privilege}`);
    }
    await service(db, async () => { for (const [, query] of operations(requirement)) await db.query(query); });
    for (const name of ['anon', 'authenticated']) {
      const access = await one(db, `select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as tab,
        has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') as col`, [name, `public.${requirement.table}`]);
      assert.deepEqual(access, { tab: false, col: false });
    }
  }
  assert.deepEqual((await legacyAccessSnapshot(db)).data, before.data, 'No-row authority probes must leave business rows unchanged');
  await db.query(sql);
  assert.deepEqual(await legacyAccessSnapshot(db), after, '098 is idempotent, including effective ACLs, RLS and data');
}

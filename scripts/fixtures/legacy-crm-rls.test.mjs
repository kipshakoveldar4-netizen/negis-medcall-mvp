import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { inspectMigration,migrationTokens } from './migration-chain-review.mjs';
import { legacyCrmRlsSnapshot,legacyCrmRlsTables,exerciseLegacyCrmRlsRefusals,proveLegacyCrmRlsBaseline,
  proveLegacyCrmRlsChange,proveLegacyCrmRlsEnforcement } from './legacy-crm-rls-cases.mjs';

const read=file=>readFile(new URL(`../../migrations/${file}`,import.meta.url),'utf8');
const sql=await read('100_legacy_crm_row_security.sql');

test('100 exact scope: seven RLS flags, no grants/policies/functions/roles/defaults/data rewrites',()=>{
  const evidence=inspectMigration(sql);
  assert.deepEqual(evidence.rls.sort(),legacyCrmRlsTables.map(name=>`public.${name}`).sort());
  for(const field of ['tables','functions','extensions','notifications','dynamicSqlLines']) assert.deepEqual(evidence[field],[],field);
  let first;
  for(const token of migrationTokens(sql)) {
    if(token.kind==='symbol'&&token.value===';') first=undefined;
    else if(!first) {first=token.value;assert.ok(!['grant','revoke','insert','update','delete','truncate','create'].includes(first));}
  }
  assert.doesNotMatch(sql,/\balter\s+(?:default\s+privileges|role)\b|\bdisable\s+row\s+level\s+security\b/i);
});

test('100 actual PostgreSQL-emulator preconditions, rollback and default-deny, not cloud authority',{timeout:120000},async t=>{
  const pg=new PGlite();t.after(()=>pg.close());
  const db={query:async(sql,args=[])=>{
    const result=args.length?await pg.query(sql,args):(await pg.exec(sql)).at(-1);
    return {...result,rowCount:result?.affectedRows??result?.rows?.length??0};
  }};
  await db.query('create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to service_role,anon,authenticated');
  await assert.rejects(db.query(sql),/legacy_crm_rls_relations_unconfirmed/);await db.query('rollback');
  // Focused emulator scaffold: one original 009 CREATE TABLE statement, then
  // complete unmodified 010/013/014/019/023/035. Not a stripped migration chain.
  const original=await read('009_medcall_mvp_persistence.sql');let statement=[];let loaded=false;
  for(const token of migrationTokens(original)) {
    if(token.kind==='symbol'&&token.value===';') {
      if(statement[0]?.value==='create'&&statement[1]?.value==='table') {
        const ddl=original.slice(statement[0].offset,token.offset+1);
        if(inspectMigration(ddl).tables[0]==='public.workspaces') {await db.query(ddl);loaded=true;}
      }
      statement=[];
    } else statement.push(token);
  }
  assert.equal(loaded,true);
  for(const file of ['010_staff_ready_crm.sql','013_release_admin_settings.sql','014_meta_ad_launches.sql','019_crm_lead_pipeline_foundation.sql',
    '023_public_privilege_hardening.sql','035_service_role_grant_parity.sql']) await db.query(await read(file));
  await t.test('baseline reproduces all seven leaks only under an owned temporary DML grant',()=>proveLegacyCrmRlsBaseline(db));
  await exerciseLegacyCrmRlsRefusals(db,sql,t);
  await db.query('create policy owned_100_server on public.clients for select to service_role using(true); alter table public.clients force row level security');
  await db.query('create policy owned_100_restrictive on public.clients as restrictive for select to anon using(false)');
  const before=await legacyCrmRlsSnapshot(db);await db.query(sql);
  await t.test('only intended RLS flags change, existing FORCE/policies/data/grants/defaults survive, repeat is inert',()=>proveLegacyCrmRlsChange(db,before,sql));
  await t.test('mistaken browser DML grants still cannot read or write rows; original server CRUD survives',()=>proveLegacyCrmRlsEnforcement(db));
});

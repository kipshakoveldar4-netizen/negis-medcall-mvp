import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {exerciseDeletionOperations} from './site-deletion-operations-cases.mjs';
import {inspectMigration} from './migration-chain-review.mjs';

const directory=new URL('../../migrations/',import.meta.url);
const sql=await readFile(new URL('101_site_deletion_operations.sql',directory),'utf8');
async function bootstrap(t) {
  const pg=new PGlite();t.after(()=>pg.close());
  const db={query:async(sql,args=[])=>args.length?pg.query(sql,args):(await pg.exec(sql)).at(-1)};
  await db.query('create role anon;create role authenticated;create role service_role bypassrls;grant usage on schema public to anon,authenticated,service_role');
  const selected=new Set([9,10,11,13,14,19,58,62,93]);
  for(const file of (await readdir(directory)).sort()) if(selected.has(Number(file.slice(0,3))))
    await db.query((await readFile(new URL(file,directory),'utf8')).replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/i,''));
  return db;
}
test('101 source has one closed RLS ledger, four server RPCs, no external effect or historical backfill',()=>{
  const source=inspectMigration(sql);assert.deepEqual(source.tables,['public.site_deletion_operations']);
  assert.deepEqual(source.rls,['public.site_deletion_operations']);assert.deepEqual(source.extensions,[]);assert.deepEqual(source.notifications,[]);
  assert.equal(source.functions.length,7);assert.doesNotMatch(sql,/\b(?:net\.http|dblink|cron\.|pg_read_file|copy\s+.*program)\b/i);
});
test('101 focused emulator: original 058/062/093 and durable operation contract; not native/cloud acceptance',{timeout:180000},async t=>{
  // PGlite has built-in crypto. This declared focused scaffold omits only the
  // unavailable pgcrypto extension install; native acceptance executes raw SQL.
  const db=await bootstrap(t);
  await db.query(sql);await exerciseDeletionOperations(db,t);
  const row=(await db.query("select relrowsecurity as rls from pg_class where oid='public.site_deletion_operations'::regclass")).rows[0];assert.equal(row.rls,true);
  for(const role of ['anon','authenticated','service_role']) {
    const result=(await db.query("select has_table_privilege($1,'public.site_deletion_operations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as tab,has_any_column_privilege($1,'public.site_deletion_operations','SELECT,INSERT,UPDATE,REFERENCES') as col,has_function_privilege($1,'public.delete_crm_site_inquiry(uuid,text,uuid,uuid[],timestamptz,uuid,uuid,uuid,boolean)','EXECUTE') as old",[role])).rows[0];
    assert.deepEqual(result,{tab:false,col:false,old:false});
  }
  assert.equal((await db.query('select count(*)::int as n from public.site_deletion_operations')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int as n from public.workspaces')).rows[0].n,0);
});
for(const mode of ['changed executor','inherited helper execute']) test(`101 refuses ${mode} atomically, without creating its ledger or revoking old server access`,{timeout:120000},async t=>{
  const db=await bootstrap(t);
  if(mode==='changed executor') await db.query(`create or replace function public.delete_crm_site_inquiry(
    p_workspace_id uuid,p_site_key text,p_lead_id uuid,p_expected_receipt_ids uuid[],p_expected_lead_updated_at timestamptz,
    p_staff_user_id uuid,p_auth_user_id uuid,p_request_key uuid,p_confirmed boolean) returns jsonb language plpgsql
    security definer set search_path='' set lock_timeout='3s' as $$begin return '{}'::jsonb;end$$`);
  else await db.query('create role owned_101_helper_reader;grant owned_101_helper_reader to authenticated;alter default privileges for role postgres grant execute on functions to owned_101_helper_reader');
  await assert.rejects(db.query(sql),error=>error.message===(mode==='changed executor'?'site_deletion_operations_dependencies_unconfirmed':'site_deletion_operations_access_unconfirmed'));
  await db.query('rollback');
  assert.equal((await db.query("select to_regclass('public.site_deletion_operations') as value")).rows[0].value,null);
  assert.equal((await db.query("select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('prepare_site_deletion_operation','read_site_deletion_operations','execute_site_deletion_operation','close_site_deletion_operation')")).rows[0].n,0);
  assert.equal((await db.query("select has_function_privilege('service_role','public.delete_crm_site_inquiry(uuid,text,uuid,uuid[],timestamptz,uuid,uuid,uuid,boolean)','EXECUTE') as value")).rows[0].value,true);
});

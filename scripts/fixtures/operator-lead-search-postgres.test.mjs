import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {readReviewedChain} from './migration-chain-review.mjs';
import {startNativePostgres} from './native-postgres.mjs';
import {exerciseOperatorLeadSearch} from './operator-lead-search-cases.mjs';
import {exerciseOperatorLeadSearchHttp} from './operator-lead-search-native-http-cases.mjs';

test('complete operator lead search uses only owned native PostgreSQL and exact source dependencies',{timeout:300000},async t=>{
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE,'1');
  const chain=await readReviewedChain(fileURLToPath(new URL('../../migrations/',import.meta.url)));
  const index=chain.findIndex(entry=>entry.file==='124_operator_lead_search.sql');
  assert.ok(index>0,'The reviewed chain must contain the search migration');
  const searchMigration=chain[index];
  const fixture=await startNativePostgres();t.after(()=>fixture.close());const db=await fixture.connect();
  await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    grant usage on schema public to anon,authenticated,service_role;
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);alter table storage.objects enable row level security;`);
  for(const entry of chain.slice(0,index))await db.query(entry.source);
  for(const[name,sql]of [['stages RLS','alter table public.lead_stages disable row level security'],['stage writer body',"alter function public.set_growth_operator_lead_stage(uuid,uuid,uuid,uuid,uuid,text) stable"],['browser bypass','alter role anon bypassrls']])await t.test('124 dependency drift refuses atomically: '+name,async()=>{
    await db.query('begin');try{await db.query(sql);await assert.rejects(db.query(searchMigration.source),e=>e.message==='operator_lead_search_dependencies_unconfirmed');}finally{await db.query('rollback');}
    assert.equal((await db.query("select to_regprocedure('public.read_growth_operator_lead_search(uuid,text,text,uuid,integer)') f")).rows[0].f,null);
  });
  for(const entry of chain.slice(index))await db.query(entry.source);
  await exerciseOperatorLeadSearch(db,fixture,searchMigration.source,t);
  await exerciseOperatorLeadSearchHttp(db,fixture,t);
  for(const{name}of(await db.query("select relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'")).rows)
    assert.equal((await db.query('select count(*)::int n from public."'+name.replaceAll('"','""')+'"')).rows[0].n,0,'Owned synthetic cleanup: '+name);
});

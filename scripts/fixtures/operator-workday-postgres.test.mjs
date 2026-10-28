import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readReviewedChain } from './migration-chain-review.mjs';
import { startNativePostgres } from './native-postgres.mjs';
import { exerciseOperatorWorkday } from './operator-workday-cases.mjs';
import { exerciseOperatorWorkdayHttp } from './operator-workday-native-http-cases.mjs';

test('complete own operator workday on owned PostgreSQL, without cloud or provider facilities',{timeout:300000},async t=>{
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE,'1');
  // Historical 123 protocol; current-chain composition is tested separately.
  const chain=(await readReviewedChain(fileURLToPath(new URL('../../migrations/',import.meta.url)))).filter(e=>Number(e.file.slice(0,3))<=123),last=chain.at(-1);
  assert.equal(last.file,'123_operator_workday_read.sql');
  const fixture=await startNativePostgres();t.after(()=>fixture.close());const db=await fixture.connect();
  await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    grant usage on schema public to anon,authenticated,service_role;
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);alter table storage.objects enable row level security;`);
  for(const entry of chain.slice(0,-1))await db.query(entry.source);
  for(const[name,sql]of[
    ['profile RLS','alter table public.growth_operator_profiles disable row level security'],
    ['assignment RLS','alter table public.growth_operator_lead_assignments disable row level security'],
    ['request authority volatility','alter function public.transition_growth_operator_request(uuid,uuid,text) stable'],
    ['assignment authority invoker','alter function public.set_growth_operator_lead_assignment(uuid,uuid,uuid,boolean) security invoker'],
    ['browser bypass','alter role authenticated bypassrls'],
  ])await t.test('123 drift refuses before creating readers: '+name,async()=>{
    await db.query('begin');try{await db.query(sql);await assert.rejects(db.query(last.source),e=>e.message==='operator_workday_dependencies_unconfirmed');}finally{await db.query('rollback');}
    assert.equal((await db.query("select to_regprocedure('public.read_growth_operator_workday(uuid,integer)') f")).rows[0].f,null);
  });
  await db.query(last.source);await exerciseOperatorWorkday(db,fixture,last.source,t);await exerciseOperatorWorkdayHttp(db,fixture,t);
  for(const{name}of(await db.query("select relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'")).rows)
    assert.equal((await db.query('select count(*)::int n from public."'+name.replaceAll('"','""')+'"')).rows[0].n,0,'All owned synthetic rows removed: '+name);
});

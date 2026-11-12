import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startNativePostgres } from './native-postgres.mjs';
import { readReviewedChain } from './migration-chain-review.mjs';
import { exercisePartnerHistory } from './partner-history-cases.mjs';
import { exercisePartnerHistoryHttp } from './partner-history-native-http-cases.mjs';

test('read-only partner journal on owned PostgreSQL; no external payment, Auth, provider or cloud', { timeout: 300000 }, async t=>{
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE,'1');
  // Historical 122 protocol; full current-chain composition is tested separately.
  const chain=(await readReviewedChain(fileURLToPath(new URL('../../migrations/',import.meta.url)))).filter(e=>Number(e.file.slice(0,3))<=122),last=chain.at(-1);
  assert.equal(last.file,'122_partner_history_read.sql');
  const fixture=await startNativePostgres();t.after(()=>fixture.close());const db=await fixture.connect();
  await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    grant usage on schema public to anon,authenticated,service_role;
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);alter table storage.objects enable row level security;`);
  for(const entry of chain.slice(0,-1))await db.query(entry.source);
  for(const [name,sql]of [
    ['ledger authority volatility','alter function public.read_growth_partner_ledger(uuid) stable'],
    ['ledger body',"create or replace function public.read_growth_partner_ledger(p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$ begin return '{\"state\":\"not_activated\"}'::jsonb; end $$"],
    ['current payment writer','alter function public.confirm_growth_subscription_payment(uuid,uuid,bigint,text,timestamptz,uuid,uuid) security invoker'],
    ['commission RLS','alter table public.growth_partner_commissions disable row level security'],
    ['browser bypass','alter role authenticated bypassrls'],
  ])await t.test('122 drift refuses before creating a reader: '+name,async()=>{
    await db.query('begin');try{await db.query(sql);await assert.rejects(db.query(last.source),e=>e.message==='partner_history_dependencies_unconfirmed');}finally{await db.query('rollback');}
    assert.equal((await db.query("select to_regprocedure('public.read_growth_partner_history(uuid,integer,text)') f")).rows[0].f,null);
  });
  await db.query(last.source);await exercisePartnerHistory(db,fixture,last.source,t);await exercisePartnerHistoryHttp(db,fixture,t);
  for(const {name}of(await db.query("select relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'")).rows)
    assert.equal((await db.query('select count(*)::int n from public."'+name.replaceAll('"','""')+'"')).rows[0].n,0,'All synthetic business rows removed: '+name);
});

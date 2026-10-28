import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readReviewedChain } from './migration-chain-review.mjs';
import { startNativePostgres } from './native-postgres.mjs';
import { exercisePartnerCompanyApproval } from './partner-company-approval-cases.mjs';

test('owned native partner-company approval foundation; no HTTP activation, Auth creation or payment provider',{timeout:300000},async t=>{
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE,'1','Explicit owned native opt-in only, no remote DSN');
  // Historical 121 protocol; current-chain composition is proved separately.
  const chain=(await readReviewedChain(fileURLToPath(new URL('../../migrations/',import.meta.url)))).filter(e=>Number(e.file.slice(0,3))<=121),last=chain.at(-1);assert.equal(last.file,'121_partner_company_approval.sql');
  const fixture=await startNativePostgres();t.after(()=>fixture.close());const db=await fixture.connect();
  await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;grant usage on schema public to anon,authenticated,service_role;
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);alter table storage.objects enable row level security;`);
  for(const entry of chain.slice(0,-1))await db.query(entry.source);
  for(const [label,sql] of [
    ['source RLS','alter table public.growth_partner_sources disable row level security'],
    ['payment window RLS','alter table public.growth_partner_payment_windows disable row level security'],
    ['browser bypass','alter role authenticated bypassrls'],
    ['consent identity','alter function public.valid_crm_site_consent_receipt(jsonb) volatile'],
    ['original claim','alter function public.claim_growth_partner_source(uuid,uuid,text) security invoker'],
  ])await t.test('121 refuses drift before creating applications: '+label,async()=>{
    await db.query('begin');try{await db.query(sql);await assert.rejects(db.query(last.source),e=>e.message==='partner_company_dependencies_unconfirmed');}finally{await db.query('rollback');}
    assert.equal((await db.query("select to_regclass('public.growth_partner_company_applications') relation")).rows[0].relation,null);
  });
  const legacyPurge=chain.find(e=>e.file.startsWith('113_')).evidence.functions.find(f=>f.name==='public.purge_growth_partner_sources').body;
  await db.query(last.source);await exercisePartnerCompanyApproval(db,fixture,last.source,t,{legacyPurge});
  for(const {name}of(await db.query("select relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'")).rows)
    assert.equal((await db.query('select count(*)::int n from public."'+name.replaceAll('"','""')+'"')).rows[0].n,0,'All owned business rows cleaned: '+name);
});

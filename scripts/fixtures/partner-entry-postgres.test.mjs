import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readReviewedChain } from './migration-chain-review.mjs';
import { startNativePostgres } from './native-postgres.mjs';
import { exercisePartnerEntryAnchor } from './partner-entry-cases.mjs';
import { exercisePartnerEntryHttp } from './partner-entry-native-http-cases.mjs';

test('partner entry clock/cleanup on owned PostgreSQL; no remote authority or providers',{timeout:300000},async t=>{
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE,'1');const chain=await readReviewedChain(fileURLToPath(new URL('../../migrations/',import.meta.url)));
  const f=await startNativePostgres();t.after(()=>f.close());const db=await f.connect();
  await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;grant usage on schema public to anon,authenticated,service_role;
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);alter table storage.objects enable row level security;`);
  for(const e of chain){
    if(e.file.startsWith('113_'))for(const change of [
      "alter table public.growth_partner_sources disable row level security",
      "alter function public.capture_growth_partner_source(uuid,text,text,text) security invoker",
      "grant select on public.growth_partner_sources to authenticated",
      "grant update(captured_at) on public.growth_partner_sources to service_role",
      "grant execute on function public.partner_source_profile(uuid) to service_role",
      "grant execute on function public.claim_growth_partner_source(uuid,uuid,text) to public",
      "revoke execute on function public.read_growth_partner_source(uuid,uuid) from service_role",
      "grant select on public.growth_partner_sources to public"
    ])
      await t.test('113 refuses changed dependency '+change,async()=>{await db.query('begin');try{await db.query(change);await assert.rejects(db.query(e.source),v=>v.message==='partner_entry_dependencies_unconfirmed');}finally{await db.query('rollback');}});
    await db.query(e.source);if(e.file.startsWith('113_')){await exercisePartnerEntryAnchor(db,f,e.source,t);await exercisePartnerEntryHttp(db,f,t);}
  }
  for(const{name}of(await db.query("select c.relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'")).rows)
    assert.equal((await db.query('select count(*)::int n from public."'+name.replaceAll('"','""')+'"')).rows[0].n,0,'No owned fixture remains: '+name);
});

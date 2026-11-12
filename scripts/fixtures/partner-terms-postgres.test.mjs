import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readReviewedChain } from './migration-chain-review.mjs';
import { startNativePostgres } from './native-postgres.mjs';
import { exercisePartnerTerms } from './partner-terms-cases.mjs';
import { exercisePartnerTermsHttp } from './partner-terms-native-http-cases.mjs';

test('initial partner terms/activation on owned PostgreSQL; no accounts, cloud, payments or providers',{timeout:300000},async t=>{
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE,'1');const chain=await readReviewedChain(fileURLToPath(new URL('../../migrations/',import.meta.url)));
  const f=await startNativePostgres();t.after(()=>f.close());const db=await f.connect();
  await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;grant usage on schema public to anon,authenticated,service_role;
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);alter table storage.objects enable row level security;`);
  for(const e of chain){await db.query(e.source);if(e.file.startsWith('114_')){await exercisePartnerTerms(db,f,e.source,t);await exercisePartnerTermsHttp(db,f,t);}}
  for(const{name}of(await db.query("select c.relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'")).rows)
    assert.equal((await db.query('select count(*)::int n from public."'+name.replaceAll('"','""')+'"')).rows[0].n,0,'No owned fixture remains: '+name);
});

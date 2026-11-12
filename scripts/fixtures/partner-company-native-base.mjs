import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReviewedChain } from './migration-chain-review.mjs';
import { startNativePostgres } from './native-postgres.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export async function startPartnerCompanyNativeBase(until = 125) {
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE, '1');
  assert.ok([124, 125, 126].includes(until));
  const chain = (await readReviewedChain(path.join(root, 'migrations'))).filter(entry => Number(entry.file.slice(0, 3)) <= until);
  const fixture = await startNativePostgres();
  try {
    const db = await fixture.connect();
    await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      grant usage on schema public to anon,authenticated,service_role;
      create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);
      alter table storage.objects enable row level security;`);
    for (const entry of chain) await db.query(entry.source);
    return { fixture, db, chain, async close() { await fixture.close(); } };
  } catch (error) { await fixture.close(); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = await startPartnerCompanyNativeBase(124);
  try {
    const functions = (await base.db.query(`select oid::regprocedure::text signature,md5(prosrc) body,prosecdef,proconfig
      from pg_proc where oid=any(array[
        'public.submit_growth_partner_company(uuid,uuid,text,uuid,jsonb,text,jsonb)'::regprocedure,
        'public.read_growth_partner_company(uuid,uuid)'::regprocedure,
        'public.review_growth_partner_company(uuid,uuid,uuid,uuid,text)'::regprocedure,
        'public.partner_company_result(public.growth_partner_company_applications)'::regprocedure]::oid[]) order by oid::regprocedure::text`)).rows;
    const shape = (await base.db.query(`select md5((select jsonb_agg(jsonb_build_array(attname,atttypid::regtype::text,attnotnull) order by attnum)::text
      from pg_attribute where attrelid='public.growth_partner_company_applications'::regclass and attnum>0 and not attisdropped)) columns,
      md5((select string_agg(pg_get_constraintdef(oid),E'\n' order by conname) from pg_constraint
        where conrelid='public.growth_partner_company_applications'::regclass)) constraints`)).rows[0];
    process.stdout.write(JSON.stringify({ functions, shape }) + '\n');
  } finally { await base.close(); }
}

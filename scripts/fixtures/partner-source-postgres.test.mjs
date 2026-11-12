import assert from 'node:assert/strict';
import test from 'node:test';
import { readReviewedChain } from './migration-chain-review.mjs';
import { startNativePostgres } from './native-postgres.mjs';
import { exercisePartnerSources } from './partner-source-cases.mjs';
import { fileURLToPath } from 'node:url';

test('first-source foundation on owned PostgreSQL; no Auth, browser, provider, payment or remote authority', { timeout: 300000 }, async t => {
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE, '1', 'Explicit owned native opt-in; no DSN/download fallback');
  const chain = await readReviewedChain(fileURLToPath(new URL('../../migrations/', import.meta.url)));
  const fixture = await startNativePostgres(); t.after(() => fixture.close()); const db = await fixture.connect();
  await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    grant usage on schema public to anon,authenticated,service_role;
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);alter table storage.objects enable row level security;`);
  for (const entry of chain) {
    if (!entry.file.startsWith('112_')) await db.query(entry.source);
    else {
      for (const [change, expected] of [["alter table public.growth_partners disable row level security", 'partner_source_dependencies_unconfirmed'],
        ["alter role anon bypassrls", 'partner_source_dependencies_unconfirmed'],
        ["alter function public.bind_growth_referral(uuid,text,text) security invoker", 'partner_source_dependencies_unconfirmed'],
        ["alter function public.bind_growth_referral(uuid,text,text) stable", 'partner_source_dependencies_unconfirmed'],
        ["alter function public.review_growth_contributor(uuid,uuid,uuid,text,text) stable", 'partner_source_dependencies_unconfirmed'],
        ["create role owned_source_reader;grant owned_source_reader to authenticated;create function public.read_growth_partner_source(uuid,uuid) returns jsonb language sql as $$select '{}'::jsonb$$;grant execute on function public.read_growth_partner_source(uuid,uuid) to owned_source_reader", 'partner_source_executors_unconfirmed'],
        ["create role owned_source_table_owner;create table public.growth_partner_sources(id uuid,actor_auth_user_id uuid,capability_hash text,partner_id uuid,source text,captured_at timestamptz,expires_at timestamptz,policy_version text,workspace_id uuid,bound_at timestamptz);alter table public.growth_partner_sources owner to owned_source_table_owner", 'partner_source_schema_unconfirmed'],
      ]) await t.test('refuse unconfirmed dependency: ' + change, async () => {
        await db.query('begin'); try { await db.query(change); await assert.rejects(db.query(entry.source), e => e.message === expected); }
        finally { await db.query('rollback'); }
        assert.equal((await db.query("select to_regclass('public.growth_partner_sources') relation")).rows[0].relation, null);
      });
      await db.query(entry.source); await exercisePartnerSources(db, fixture, entry.source, t);
    }
  }
  for (const { name } of (await db.query("select c.relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'")).rows)
    assert.equal((await db.query('select count(*)::int n from public."' + name.replaceAll('"', '""') + '"')).rows[0].n, 0, 'Every owned business row cleaned: ' + name);
});

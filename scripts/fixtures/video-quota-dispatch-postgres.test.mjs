import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startNativePostgres } from './native-postgres.mjs';
import { readReviewedChain } from './migration-chain-review.mjs';
import { reproduceUnboundVideoDispatch, exerciseVideoQuotaDispatch, exerciseVideoQuotaMissing } from './video-quota-dispatch-cases.mjs';

test('106 focused quota dispatch uses the exact raw application schema on owned native PostgreSQL', { timeout:300000 }, async t => {
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE,'1','Explicit owned PostgreSQL opt-in required; no DSN/container fallback');
  const chain = await readReviewedChain(fileURLToPath(new URL('../../migrations/',import.meta.url)));
  const fixture = await startNativePostgres(); t.after(() => fixture.close());
  const db = await fixture.connect();
  assert.equal((await db.query('show server_version_num')).rows[0].server_version_num,'170011');
  await db.query(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon,authenticated,service_role;
    create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);
    alter table storage.objects enable row level security;`);
  await exerciseVideoQuotaMissing(db,chain.find(entry=>entry.file==='106_generated_video_quota_dispatch.sql').source,t);
  for (const entry of chain) {
    if(entry.file==='106_generated_video_quota_dispatch.sql') await reproduceUnboundVideoDispatch(db,t);
    await db.query(entry.source);
    if(entry.file==='106_generated_video_quota_dispatch.sql') await exerciseVideoQuotaDispatch(db,fixture,entry.source,t);
  }
  assert.equal((await db.query('select count(*)::int n from generated_video_workflows')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from content_generation_usage')).rows[0].n,0);
});

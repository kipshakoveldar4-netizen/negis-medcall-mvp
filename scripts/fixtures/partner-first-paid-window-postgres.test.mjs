import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readReviewedChain } from './migration-chain-review.mjs';
import { startNativePostgres } from './native-postgres.mjs';
import { exerciseFirstPaidWindow } from './partner-first-paid-window-cases.mjs';
import { seedPartnerLedger, seedReferral, partnerPayment, partnerReport } from './partner-ledger-cases.mjs';

test('first paid subscription, not registration, qualifies the original seven-day source on owned native SQL', {timeout:300000},async t=>{
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE,'1','Only explicit owned native opt-in, no DSN/provider fallback');
  const reviewed=await readReviewedChain(fileURLToPath(new URL('../../migrations/',import.meta.url)));
  // This focused suite proves the 120 protocol before 121's approval-only cutover.
  // The cumulative native suite separately applies and tests every current file.
  const chain=reviewed.filter(e=>Number(e.file.slice(0,3))<=120),last=chain.at(-1);
  assert.equal(last.file,'120_partner_first_paid_window.sql');
  const fixture=await startNativePostgres();t.after(()=>fixture.close());const db=await fixture.connect();
  await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    grant usage on schema public to anon,authenticated,service_role;create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);alter table storage.objects enable row level security;`);
  for(const entry of chain.slice(0,-1))await db.query(entry.source);
  for(const [label,sql,reason] of [
    ['browser bypass','alter role anon bypassrls','partner_payment_dependencies_unconfirmed'],
    ['source RLS','alter table public.growth_partner_sources disable row level security','partner_payment_dependencies_unconfirmed'],
    ['old payment identity','alter function public.confirm_growth_subscription_payment(uuid,uuid,bigint,text,timestamptz,uuid,uuid) security invoker','partner_payment_dependencies_unconfirmed'],
    ['pre-existing private implementation',"create function public.confirm_growth_subscription_payment_052(uuid,uuid,bigint,text,timestamptz,uuid,uuid) returns uuid language sql as $$select null::uuid$$",'partner_payment_dependencies_unconfirmed'],
  ])await t.test('refuse unconfirmed dependency: '+label,async()=>{
    await db.query('begin');try{await db.query(sql);await assert.rejects(db.query(last.source),e=>e.message===reason);}finally{await db.query('rollback');}
    assert.equal((await db.query("select to_regclass('public.growth_partner_payment_windows') v")).rows[0].v,null);
  });
  await t.test('unpaid old bindings require explicit review, not automatic grandfathering or rewriting',async()=>{
    await db.query('begin');try{const p=await seedPartnerLedger(db);await seedReferral(db,p);await assert.rejects(db.query(last.source),e=>e.message==='partner_payment_legacy_review_required');}finally{await db.query('rollback');}
    assert.equal((await db.query("select to_regclass('public.growth_partner_payment_windows') v")).rows[0].v,null);
  });
  const legacy=await seedPartnerLedger(db),r=await seedReferral(db,legacy);await partnerPayment(db,r);
  const snapshot=async()=>JSON.stringify((await db.query(`select * from (
    select 'referrals' t,to_jsonb(r) v from public.growth_referrals r union all
    select 'payments',to_jsonb(p) from public.platform_subscription_payments p union all
    select 'commissions',to_jsonb(c) from public.growth_partner_commissions c) x order by t,v::text`)).rows);
  const before=await snapshot();await db.query(last.source);
  await t.test('paid historical referrals, receipts and commissions retain exact values; their renewals still work',async()=>{
    assert.equal(await snapshot(),before);assert.equal((await partnerReport(db,legacy)).balances[0].earnedMinor,'1000');
    await partnerPayment(db,r,'10000','2026-02-01T00:00:00Z');assert.equal((await partnerReport(db,legacy)).balances[0].earnedMinor,'1500');
  });
  // This dedicated database contains only this fixture's historical records.
  await db.query('delete from public.growth_partner_commissions');await db.query('delete from public.platform_subscription_payments');
  await db.query('delete from public.growth_referrals');await db.query('delete from public.platform_subscriptions');await db.query('delete from public.workspaces');
  await db.query('delete from public.growth_partners');await db.query('delete from public.growth_contributor_profiles');
  await exerciseFirstPaidWindow(db,fixture,last.source,t);
  for(const {name} of(await db.query("select relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'")).rows)
    assert.equal((await db.query('select count(*)::int n from public."'+name.replaceAll('"','""')+'"')).rows[0].n,0,'Cleaned all owned rows: '+name);
  t.diagnostic('Raw 009-120; owned PostgreSQL only. SQL receipts do not prove bank money, Auth, merchant sandbox, legal approval or Preview delivery.');
});

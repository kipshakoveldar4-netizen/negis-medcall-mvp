import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { startNativePostgres } from './native-postgres.mjs';
import { exercisePartnerLedger } from './partner-ledger-cases.mjs';

test('read-only partner ledger on owned native PostgreSQL',{timeout:220000},async t=>{
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE,'1','Explicit owned native opt-in; no DSN or downloads');
  const fixture=await startNativePostgres();t.after(()=>fixture.close());const db=await fixture.connect();
  await db.query('create role anon;create role authenticated;create role service_role bypassrls;grant usage on schema public to anon,authenticated,service_role;');
  const source=await readFile(new URL('../../migrations/109_partner_ledger_read.sql',import.meta.url),'utf8');
  await assert.rejects(db.query(source),/partner_report_dependencies_unconfirmed/);await db.query('rollback');
  for(const name of ['009_medcall_mvp_persistence.sql','010_staff_ready_crm.sql','011_staff_auth_foundation.sql','034_platform_subscriptions.sql',
    '052_operators_and_partner_ledger.sql','053_operator_request_lifecycle.sql','105_contributor_applications.sql'])
    await db.query(await readFile(new URL('../../migrations/'+name,import.meta.url),'utf8'));
  for(const [name,change,expected]of[
    ['writer volatility',"alter function public.confirm_growth_subscription_payment(uuid,uuid,bigint,text,timestamptz,uuid,uuid) stable",'partner_report_dependencies_unconfirmed'],
    ['writer definer',"alter function public.bind_growth_referral(uuid,text,text) security invoker",'partner_report_dependencies_unconfirmed'],
    ['writer search path',"alter function public.confirm_growth_partner_payout(uuid,bigint,text,timestamptz,uuid,uuid) set search_path=public",'partner_report_dependencies_unconfirmed'],
    ['disabled RLS',"alter table public.growth_partners disable row level security",'partner_report_dependencies_unconfirmed'],
    ['inherited browser executor',"create role partner_untrusted;grant partner_untrusted to authenticated;create function public.read_growth_partner_ledger(uuid) returns jsonb language sql as $$select '{}'::jsonb$$;grant execute on function public.read_growth_partner_ledger(uuid) to partner_untrusted",'partner_report_executor_unconfirmed'],
  ])await t.test('109 refuses '+name+' without partial installation',async()=>{
    await db.query('begin');
    try{await db.query(change);await assert.rejects(db.query(source),error=>error.message===expected);}finally{await db.query('rollback');}
    assert.equal((await db.query("select to_regprocedure('public.read_growth_partner_ledger(uuid)') f")).rows[0].f,null);
  });
  await db.query(source);
  await exercisePartnerLedger(db,fixture,source,t);
});

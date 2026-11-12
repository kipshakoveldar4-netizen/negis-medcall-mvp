import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { seedPartnerLedger, partnerReport } from './partner-ledger-cases.mjs';
import { partnerEntryHttpFixture, stopPartnerEntryBuilds, ENTRY_ORIGIN, ENTRY_ACTOR } from './partner-entry-http-fixture.mjs';
import { startOwnedPartnerHttp } from './partner-entry-native-http-cases.mjs';

const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const observed=p=>p.then(value=>({value}),error=>({error}));
async function rollback(db,run){await db.query('begin');try{await run();}finally{await db.query('rollback');}}
async function denied(db,run,code){await db.query('savepoint owned_paid_denial');try{await assert.rejects(run,e=>e.code===code);}finally{await db.query('rollback to savepoint owned_paid_denial;release savepoint owned_paid_denial');}}
async function seed(db,{self=false}={}){
  const partner=await seedPartnerLedger(db),actor=self?partner.actor:randomUUID();
  const x={partner,actor,w:randomUUID(),staff:randomUUID(),subscription:randomUUID(),intent:randomUUID(),hash:createHash('sha256').update(randomUUID()).digest('hex')};
  const start=(await one(db,"select to_char(clock_timestamp()-interval '6 days','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') at")).at;
  await db.query("select public.capture_growth_partner_source_v2($1,$2,$3,'link',$4)",[x.intent,x.hash,partner.code,start]);
  await db.query('select public.claim_growth_partner_source($1,$2,$3)',[actor,x.intent,x.hash]);
  await db.query("insert into public.workspaces(id,name,created_at) values($1,'Owned first-paid company',clock_timestamp()-interval '5 days')",[x.w]);
  await db.query("insert into public.staff_users(id,workspace_id,auth_user_id,email,full_name,role,status) values($1,$2,$3,'paid@example.invalid','Owned paid owner','owner','active')",[x.staff,x.w,actor]);
  await db.query("insert into public.platform_subscriptions(id,workspace_id,plan,currency,price_minor) values($1,$2,'basic','KZT',999)",[x.subscription,x.w]);
  const result=(await one(db,'select public.bind_growth_partner_source($1,$2,$3) value',[actor,x.intent,x.w])).value;
  assert.equal(result.state,'pending_payment');
  return x;
}
async function expire(db,x){await db.query("update public.growth_partner_sources set captured_at=c.at-interval '8 days',expires_at=c.at-interval '1 day' from(select clock_timestamp() at)c where id=$1",[x.intent]);}
const state=async(db,x)=>(await one(db,'select public.read_growth_partner_source($1,$2) value',[x.actor,x.intent])).value;
async function paidAt(db,x,interval){return(await one(db,"select to_char((captured_at+($2::interval)) at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') at from public.growth_partner_sources where id=$1",[x.intent,interval])).at;}
async function pay(db,x,at,request=randomUUID(),minor='10000'){
  return(await one(db,"select public.confirm_growth_subscription_payment($1,$2,$3,'KZT',$4,$5,$6) id",[x.w,x.subscription,minor,at,request,x.actor])).id;
}
const counts=async(db,x)=>one(db,`select
  (select count(*)::int from public.growth_referrals where workspace_id=$1) referrals,
  (select count(*)::int from public.platform_subscription_payments where workspace_id=$1) payments,
  (select count(*)::int from public.growth_partner_commissions c join public.platform_subscription_payments p on p.id=c.payment_id where p.workspace_id=$1) commissions,
  (select qualified_payment_id is not null from public.growth_partner_payment_windows where workspace_id=$1) qualified`,[x.w]);
async function cleanup(db,x){
  await db.query('delete from public.growth_partner_payment_windows where workspace_id=$1',[x.w]);
  await db.query('delete from public.growth_partner_commissions where payment_id in(select id from public.platform_subscription_payments where workspace_id=$1)',[x.w]);
  await db.query('delete from public.platform_subscription_payments where workspace_id=$1',[x.w]);
  await db.query('delete from public.growth_referrals where workspace_id=$1',[x.w]);
  await db.query('delete from public.growth_partner_sources where id=$1',[x.intent]);
  await db.query('delete from public.platform_subscriptions where id=$1',[x.subscription]);
  await db.query('delete from public.staff_users where id=$1',[x.staff]);await db.query('delete from public.workspaces where id=$1',[x.w]);
  await db.query('delete from public.growth_partners where id=$1',[x.partner.partner]);await db.query('delete from public.growth_contributor_profiles where id=$1',[x.partner.profile]);
}
async function blocked(db,waiter,blocker){for(let n=0;n<160;n++){if((await one(db,'select $1::int=any(pg_blocking_pids($2::int)) yes',[blocker,waiter])).yes)return;await new Promise(r=>setTimeout(r,15));}assert.fail('Expected an actual owned workspace wait');}

export async function exerciseFirstPaidWindow(db,fixture,source,t){
  await t.test('workspace creation reserves the first source without a paid referral or any commission',async()=>rollback(db,async()=>{
    const x=await seed(db);assert.deepEqual(await counts(db,x),{referrals:0,payments:0,commissions:0,qualified:false});
    assert.equal((await state(db,x)).state,'pending_payment');
    assert.equal((await partnerReport(db,x.partner)).registrations,'0');
    const original=await state(db,x);await db.query('select public.bind_growth_partner_source($1,$2,$3)',[x.actor,x.intent,x.w]);
    assert.deepEqual(await state(db,x),original);
    await denied(db,()=>db.query('select public.bind_growth_partner_source($1,$2,$3)',[randomUUID(),x.intent,x.w]),'P1121');
  }));
  for(const self of [false,true])await t.test('first paid receipt qualifies once, including permitted own company: '+self,async()=>rollback(db,async()=>{
    const x=await seed(db,{self}),at=(await one(db,"select to_char((clock_timestamp()-interval '1 hour') at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') at")).at;
    const request=randomUUID(),id=await pay(db,x,at,request);assert.equal(await pay(db,x,at,request),id);
    assert.deepEqual(await counts(db,x),{referrals:1,payments:1,commissions:1,qualified:true});assert.equal((await state(db,x)).state,'bound');
    const report=await partnerReport(db,x.partner);assert.equal(report.registrations,'1');assert.equal(report.firstPayments,'1');assert.equal(report.balances[0].earnedMinor,'1000');
    await denied(db,()=>pay(db,x,at,request,'20000'),'P0001');
  }));
  await t.test('actual paid_at inside seven days qualifies even when its confirmation is later; renewals stay attributed',async()=>rollback(db,async()=>{
    const x=await seed(db);await expire(db,x);assert.equal((await state(db,x)).state,'expired');
    await pay(db,x,await paidAt(db,x,'6 days'));assert.equal((await state(db,x)).state,'bound');
    await pay(db,x,(await one(db,"select to_char((clock_timestamp()-interval '1 second') at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') at")).at);
    assert.deepEqual(await counts(db,x),{referrals:1,payments:2,commissions:2,qualified:true});
    const report=await partnerReport(db,x.partner);assert.equal(report.renewals,'1');assert.equal(report.balances[0].earnedMinor,'1500');
  }));
  await t.test('lower boundary is inclusive when the new workspace already exists at the first entry instant',async()=>rollback(db,async()=>{
    const x=await seed(db);await db.query('update public.workspaces set created_at=(select captured_at from public.growth_partner_sources where id=$1) where id=$2',[x.intent,x.w]);
    await pay(db,x,await paidAt(db,x,'0 seconds'));assert.deepEqual(await counts(db,x),{referrals:1,payments:1,commissions:1,qualified:true});
  }));
  for(const offset of ['168 hours','168 hours 1 microsecond','-1 microsecond'])await t.test('first payment outside half-open entry window never qualifies: '+offset,async()=>rollback(db,async()=>{
    const x=await seed(db);await expire(db,x);const at=await paidAt(db,x,offset),request=randomUUID();
    const id=await pay(db,x,at,request);assert.equal(await pay(db,x,at,request),id);
    assert.deepEqual(await counts(db,x),{referrals:0,payments:1,commissions:0,qualified:false});assert.equal((await state(db,x)).state,'expired');
    const report=await partnerReport(db,x.partner);assert.equal(report.paidCompanies,'0');assert.deepEqual(report.balances,[]);
    await pay(db,x,(await one(db,"select to_char((clock_timestamp()-interval '1 second') at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') at")).at);
    assert.deepEqual(await counts(db,x),{referrals:0,payments:2,commissions:0,qualified:false});
  }));
  await t.test('a late first payment cannot be revived by a later backdated attempt or a different source',async()=>rollback(db,async()=>{
    const x=await seed(db);await expire(db,x);await pay(db,x,await paidAt(db,x,'169 hours'));
    const backdated=await paidAt(db,x,'167 hours');await denied(db,()=>pay(db,x,backdated),'P0001');
    await denied(db,()=>db.query('select public.bind_growth_partner_source($1,$2,$3)',[x.actor,x.intent,randomUUID()]),'P1121');
    assert.deepEqual(await counts(db,x),{referrals:0,payments:1,commissions:0,qualified:false});
  }));
  await t.test('payment, immutable source, eligibility and commission roll back together on a commission failure',async()=>rollback(db,async()=>{
    const x=await seed(db);await db.query('update public.growth_partners set first_commission_bps=null where id=$1',[x.partner.partner]);
    const at=await paidAt(db,x,'5 days');await denied(db,()=>pay(db,x,at),'P0001');
    assert.deepEqual(await counts(db,x),{referrals:0,payments:0,commissions:0,qualified:false});
    await db.query('update public.growth_partners set first_commission_bps=1000 where id=$1',[x.partner.partner]);await pay(db,x,at);
    assert.deepEqual(await counts(db,x),{referrals:1,payments:1,commissions:1,qualified:true});
  }));
  await t.test('inconsistent qualification refuses instead of rebinding a first payment',async()=>rollback(db,async()=>{
    const x=await seed(db);await pay(db,x,await paidAt(db,x,'5 days'));await db.query('update public.growth_partner_payment_windows set qualified_payment_id=null where workspace_id=$1',[x.w]);
    const later=await paidAt(db,x,'5 days 1 hour');await denied(db,()=>pay(db,x,later),'P1202');await denied(db,()=>state(db,x),'P1202');
  }));
  await t.test('service entry and private implementation ACL, including rerun, cannot bypass the window',async()=>rollback(db,async()=>{
    await db.query(source);
    for(const role of ['anon','authenticated','service_role']){
      assert.equal((await one(db,"select has_table_privilege($1,'public.growth_partner_payment_windows','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') yes",[role])).yes,false);
      assert.equal((await one(db,"select has_function_privilege($1,'public.confirm_growth_subscription_payment_052(uuid,uuid,bigint,text,timestamptz,uuid,uuid)','EXECUTE') yes",[role])).yes,false);
      for(const sig of ['public.bind_growth_partner_source(uuid,uuid,uuid)','public.confirm_growth_subscription_payment(uuid,uuid,bigint,text,timestamptz,uuid,uuid)'])
        assert.equal((await one(db,'select has_function_privilege($1,$2,\'EXECUTE\') yes',[role,sig])).yes,role==='service_role');
    }
  }));
  await t.test('two real sessions confirming the same first payment create one binding and one commission',async()=>{
    const x=await seed(db),a=await fixture.connect(),b=await fixture.connect();
    try{const request=randomUUID(),at=await paidAt(db,x,'5 days');await a.query('begin');await a.query('select id from public.workspaces where id=$1 for update',[x.w]);
      const aid=(await one(a,'select pg_backend_pid() id')).id,bid=(await one(b,'select pg_backend_pid() id')).id;
      const pending=observed(pay(b,x,at,request));await blocked(db,bid,aid);const id=await pay(a,x,at,request);await a.query('commit');
      const other=await pending;assert.equal(other.error,undefined);assert.equal(other.value,id);assert.deepEqual(await counts(db,x),{referrals:1,payments:1,commissions:1,qualified:true});
    }finally{await a.query('rollback');await a.end();await b.end();await cleanup(db,x);}
  });
  await t.test('full compiled HTTP/Auth gateway shows pending then paid-bound state and refuses a revoked workspace owner',async()=>{
    const partner=await seedPartnerLedger(db),x={partner,actor:ENTRY_ACTOR,w:randomUUID(),staff:randomUUID(),subscription:randomUUID(),intent:null};
    const params={capture_growth_partner_source_v2:['p_intent','p_capability_hash','p_code','p_source','p_started_at'],
      claim_growth_partner_source:['p_actor','p_intent','p_capability_hash'],read_growth_partner_source:['p_actor','p_intent']};
    const f=await partnerEntryHttpFixture({async rpc(name,args){
      assert.ok(Object.hasOwn(params,name),'Only the three intake RPCs, no financial endpoint or direct write');
      assert.deepEqual(Object.keys(args).sort(),[...params[name]].sort());
      const c=await fixture.connect();try{await c.query('set role service_role');return{data:(await one(c,'select public.'+name+'('+params[name].map((_,i)=>'$'+(i+1)).join(',')+') value',params[name].map(k=>args[k]))).value,error:null};}
      catch(error){return{data:null,error:{code:error.code}};}finally{await c.end();}
    }}),http=await startOwnedPartnerHttp(f.handler);
    let cookie;
    async function call(op,body={}){
      const r=await fetch(http.origin+'/api/crm/partner-entry?op='+op,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
        headers:{Origin:ENTRY_ORIGIN,'Content-Type':'application/json',Authorization:'Bearer owned.owner.signature',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
      assert.equal(r.headers.get('cache-control'),'no-store');cookie??=r.headers.get('set-cookie')?.split(';')[0];return{status:r.status,value:await r.json()};
    }
    try{
      assert.equal((await call('prepare',{code:partner.code,source:'link',consent:true,consentVersion:f.notice.version,challengeToken:'owned-token'})).status,200);
      const captured=await call('capture');assert.equal(captured.status,200);x.intent=captured.value.data.id;
      assert.equal((await call('claim')).status,200);
      await db.query("insert into public.workspaces(id,name) values($1,'Owned HTTP first-paid company')",[x.w]);
      await db.query("insert into public.staff_users(id,workspace_id,auth_user_id,email,full_name,role,status) values($1,$2,$3,'http-paid@example.invalid','Owned HTTP paid owner','owner','active')",[x.staff,x.w,x.actor]);
      await db.query("insert into public.platform_subscriptions(id,workspace_id,plan,currency,price_minor) values($1,$2,'basic','KZT',999)",[x.subscription,x.w]);
      const c=await fixture.connect();try{await c.query('set role service_role');assert.equal((await one(c,'select public.bind_growth_partner_source($1,$2,$3) value',[x.actor,x.intent,x.w])).value.state,'pending_payment');}finally{await c.end();}
      const pending=await call('read');assert.equal(pending.status,200);assert.equal(pending.value.data.state,'pending_payment');
      assert.deepEqual(await counts(db,x),{referrals:0,payments:0,commissions:0,qualified:false});
      const at=(await one(db,"select to_char(statement_timestamp() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') at")).at;
      await pay(db,x,at);const confirmed=await call('read');assert.equal(confirmed.status,200);assert.equal(confirmed.value.data.state,'bound');
      assert.equal(confirmed.value.data.capturedAt,pending.value.data.capturedAt);assert.equal(confirmed.value.data.expiresAt,pending.value.data.expiresAt);
      await db.query("update public.staff_users set status='disabled' where id=$1",[x.staff]);assert.equal((await call('read')).status,403);
      assert.deepEqual(f.state.unexpected,[]);assert.deepEqual(http.state.errors,[]);
    }finally{await http.close();f.close();await stopPartnerEntryBuilds();await cleanup(db,x);}
  });
}

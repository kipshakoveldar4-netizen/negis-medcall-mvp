import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export const partnerLedgerSignature='public.read_growth_partner_ledger(uuid)';
const row=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const observed=promise=>promise.then(value=>({value}),error=>({error}));
async function rollback(db,action){await db.query('begin');try{return await action();}finally{await db.query('rollback');}}
async function denied(db,action,code){await db.query('savepoint partner_denial');try{await assert.rejects(action,error=>error.code===code);}finally{await db.query('rollback to savepoint partner_denial;release savepoint partner_denial');}}
export async function seedPartnerLedger(db,options={}){
  const x={actor:randomUUID(),owner:randomUUID(),partner:randomUUID(),code:randomUUID().replaceAll('-','').toUpperCase()};
  const applied=(await row(db,"select public.apply_growth_contributor($1,'Owned partner',true,true,'{}') value",[x.actor])).value;
  x.profile=applied.id;
  if(options.approved!==false)await db.query("select public.review_growth_contributor($1,$2,$3,'partner','approve')",[applied.id,applied.revision,x.owner]);
  if(options.activated!==false)await db.query(`insert into public.growth_partners(id,auth_user_id,display_name,referral_code,first_commission_bps,renewal_commission_bps)
    values($1,$2,'Owned partner',$3,$4,$5)`,[x.partner,x.actor,x.code,options.first??1000,options.renewal??500]);
  return x;
}
export async function seedReferral(db,x,currency='KZT'){
  const w=randomUUID(),subscription=randomUUID();
  await db.query("insert into public.workspaces(id,name) values($1,'Owned fictional referral')",[w]);
  await db.query("insert into public.platform_subscriptions(id,workspace_id,plan,currency,price_minor) values($1,$2,'basic',$3,999)",[subscription,w,currency]);
  await db.query("select public.bind_growth_referral($1,$2,'link')",[w,x.code]);
  return{w,subscription,currency};
}
export const partnerReport=async(db,x)=>(await row(db,'select public.read_growth_partner_ledger($1) value',[x.actor])).value;
export const partnerPayment=async(db,r,minor='10000',time='2026-01-01T00:00:00Z')=>(await row(db,
  'select public.confirm_growth_subscription_payment($1,$2,$3,$4,$5,$6,$7) id',[r.w,r.subscription,minor,r.currency,time,randomUUID(),randomUUID()])).id;
export const partnerPayout=async(db,x,minor='1',currency='KZT')=>db.query('select public.confirm_growth_partner_payout($1,$2,$3,$4,$5,$6)',
  [x.partner,minor,currency,'2026-02-01T00:00:00Z',randomUUID(),x.owner]);
const ledgerTables=['growth_contributor_profiles','growth_partners','growth_referrals','platform_subscription_payments','growth_partner_commissions','growth_partner_payouts','platform_subscriptions','workspaces'];
const snapshot=async db=>JSON.stringify((await db.query('select * from ('+ledgerTables.map(table=>`select '${table}' t,to_jsonb(r) v from public.${table} r`).join(' union all ')+') ledger_snapshot order by t,v::text')).rows);
async function blocked(db,waiter,blocker){for(let n=0;n<160;n++){if((await row(db,'select $1::int=any(pg_blocking_pids($2::int)) yes',[blocker,waiter])).yes)return;await new Promise(r=>setTimeout(r,15));}assert.fail('Expected the owned authority/ledger row lock wait');}

export async function exercisePartnerLedger(db,fixture,source,t){
  await t.test('109 approved application is not commercial activation, and pending/other actors cannot read',async()=>rollback(db,async()=>{
    const x=await seedPartnerLedger(db,{activated:false}),pending=await seedPartnerLedger(db,{approved:false});
    const before=await snapshot(db);
    await db.query('set local role service_role');
    assert.deepEqual(await partnerReport(db,x),{state:'not_activated'});
    await denied(db,()=>partnerReport(db,pending),'P1091');await denied(db,()=>partnerReport(db,{actor:randomUUID()}),'P1091');
    await denied(db,()=>partnerReport(db,{actor:null}),'P1091');
    await db.query('reset role');assert.equal(await snapshot(db),before);
  }));
  await t.test('109 an activated empty ledger reports actual empty rows; missing terms never become defaults',async()=>rollback(db,async()=>{
    const x=await seedPartnerLedger(db);
    await db.query('update public.growth_partners set first_commission_bps=null,renewal_commission_bps=null where id=$1',[x.partner]);
    const before=await snapshot(db);await db.query('set local role service_role');const value=await partnerReport(db,x);await db.query('reset role');
    assert.deepEqual({...value,generatedAt:undefined},{state:'ready',generatedAt:undefined,firstCommissionBps:null,renewalCommissionBps:null,
      registrations:'0',paidCompanies:'0',firstPayments:'0',renewals:'0',balances:[]});
    assert.ok(Number.isFinite(Date.parse(value.generatedAt)));assert.equal(await snapshot(db),before);
  }));
  await t.test('109 exact own receipt totals, historical rate snapshots, multiple currencies and unpaid registration',async()=>rollback(db,async()=>{
    const x=await seedPartnerLedger(db,{first:5000,renewal:1000}),other=await seedPartnerLedger(db);
    const a=await seedReferral(db,x),b=await seedReferral(db,x,'USD');await seedReferral(db,x);
    const foreign=await seedReferral(db,other);await partnerPayment(db,foreign,'99999999');
    await partnerPayment(db,a,'900719925474099300');await partnerPayment(db,a,'10001','2026-01-02T00:00:00Z');
    await partnerPayment(db,b,'201');await partnerPayout(db,x,'123','KZT');await partnerPayout(db,x,'1','USD');
    await db.query('update public.growth_partners set first_commission_bps=1000,renewal_commission_bps=500 where id=$1',[x.partner]);
    const before=await snapshot(db);await db.query('set local role service_role');const value=await partnerReport(db,x);await db.query('reset role');
    assert.equal(value.registrations,'3');assert.equal(value.paidCompanies,'2');assert.equal(value.firstPayments,'2');assert.equal(value.renewals,'1');
    assert.equal(value.firstCommissionBps,1000);assert.equal(value.renewalCommissionBps,500);
    assert.deepEqual(value.balances,[{currency:'KZT',earnedMinor:'450359962737050650',paidMinor:'123',availableMinor:'450359962737050527'},
      {currency:'USD',earnedMinor:'100',paidMinor:'1',availableMinor:'99'}]);
    assert.doesNotMatch(JSON.stringify(value),/workspace|subscription|actor|owner|referral|Owned|99999999|auth|paid_at/);
    assert.equal(await snapshot(db),before,'Report cannot write commercial or business data');
  }));
  await t.test('109 commercial suspension reveals no previous amounts or terms',async()=>rollback(db,async()=>{
    const x=await seedPartnerLedger(db);await partnerPayment(db,await seedReferral(db,x));
    await db.query("update public.growth_partners set status='suspended' where id=$1",[x.partner]);
    assert.deepEqual(await partnerReport(db,x),{state:'suspended'});
  }));
  for(const kind of ['foreign-commission','missing-commission','wrong-amount','overpaid'])await t.test(`109 inconsistent ${kind} refuses instead of returning fabricated balances`,async()=>rollback(db,async()=>{
    const x=await seedPartnerLedger(db),other=await seedPartnerLedger(db);const own=await seedReferral(db,x),foreign=await seedReferral(db,other);
    if(kind==='overpaid')await db.query("insert into public.growth_partner_payouts(partner_id,request_key,amount_minor,currency,paid_at,confirmed_by) values($1,$2,1,'KZT',now(),$3)",[x.partner,randomUUID(),x.owner]);
    else{
      const r=kind==='foreign-commission'?foreign:own,p=randomUUID();
      await db.query("insert into public.platform_subscription_payments(id,workspace_id,subscription_id,request_key,kind,amount_minor,currency,paid_at,confirmed_by) values($1,$2,$3,$4,'first',10000,'KZT',now(),$5)",[p,r.w,r.subscription,randomUUID(),x.owner]);
      if(kind!=='missing-commission')await db.query("insert into public.growth_partner_commissions(payment_id,partner_id,rate_bps,amount_minor,currency) values($1,$2,1000,$3,'KZT')",[p,x.partner,kind==='wrong-amount'?999:1000]);
    }
    const before=await snapshot(db);await denied(db,()=>partnerReport(db,x),'P1092');assert.equal(await snapshot(db),before);
  }));
  await t.test('109 only service entry point, no browser grants or new table/direct-write privileges',async()=>rollback(db,async()=>{
    for(const role of ['anon','authenticated','service_role']){
      assert.equal((await row(db,'select has_function_privilege($1,$2,\'EXECUTE\') yes',[role,partnerLedgerSignature])).yes,role==='service_role');
      if(role!=='service_role'){await db.query('set local role '+role);await denied(db,()=>partnerReport(db,{actor:randomUUID()}),'42501');await db.query('reset role');}
    }
  }));
  await t.test('109 exact rerun preserves receipts and installed function, without activating accounts',async()=>{
    const before=await snapshot(db);await db.query(source);assert.equal(await snapshot(db),before);
  });
  for(const isolation of ['repeatable read','serializable'])await t.test(`109 ${isolation} cannot label an inherited snapshot as current`,async()=>{
    await db.query('begin isolation level '+isolation);
    try{await denied(db,()=>partnerReport(db,{actor:randomUUID()}),'P1092');}finally{await db.query('rollback');}
  });
  for(const change of ['approval','commercial-status','identity','payment','payout','referral'])await t.test(`109 real ${change} wait rechecks authority or reads the committed ledger`,async()=>{
    const a=await fixture.connect(),b=await fixture.connect();let x,pending;
    try{
      x=await seedPartnerLedger(db);const r=await seedReferral(db,x);await partnerPayment(db,r);
      await a.query('begin');const ap=(await row(a,'select pg_backend_pid() id')).id,bp=(await row(b,'select pg_backend_pid() id')).id;
      if(change==='approval')await a.query("update public.growth_contributor_profiles set partner_status='suspended' where id=$1",[x.profile]);
      if(change==='commercial-status')await a.query("update public.growth_partners set status='suspended' where id=$1",[x.partner]);
      if(change==='identity')await a.query('update public.growth_partners set auth_user_id=$2 where id=$1',[x.partner,randomUUID()]);
      if(change==='payment')await partnerPayment(a,r,'10000','2026-01-02T00:00:00Z');
      if(change==='payout')await partnerPayout(a,x,'100');
      if(change==='referral')await seedReferral(a,x);
      await b.query('set role service_role');pending=observed(partnerReport(b,x));await blocked(db,bp,ap);await a.query('commit');const done=await pending;
      if(change==='approval')assert.equal(done.error?.code,'P1091');
      else if(change==='commercial-status')assert.deepEqual(done.value,{state:'suspended'});
      else if(change==='identity')assert.deepEqual(done.value,{state:'not_activated'});
      else{
        assert.equal(done.value.state,'ready');assert.equal(done.value.registrations,change==='referral'?'2':'1');
        assert.equal(done.value.renewals,change==='payment'?'1':'0');assert.equal(done.value.balances[0].earnedMinor,change==='payment'?'1500':'1000');
        assert.equal(done.value.balances[0].paidMinor,change==='payout'?'100':'0');
      }
    }finally{
      await a.query('rollback');if(pending)await pending;await a.end();await b.end();
      if(x){
        // These immutable records are owned fixture data only; delete in FK order.
        await db.query('delete from public.growth_partner_payouts where partner_id=$1',[x.partner]);
        await db.query('delete from public.growth_partner_commissions where partner_id=$1',[x.partner]);
        const refs=(await db.query('select workspace_id from public.growth_referrals where partner_id=$1',[x.partner])).rows;
        for(const r of refs){await db.query('delete from public.platform_subscription_payments where workspace_id=$1',[r.workspace_id]);await db.query('delete from public.growth_referrals where workspace_id=$1',[r.workspace_id]);await db.query('delete from public.platform_subscriptions where workspace_id=$1',[r.workspace_id]);await db.query('delete from public.workspaces where id=$1',[r.workspace_id]);}
        await db.query('delete from public.growth_partners where id=$1',[x.partner]);await db.query('delete from public.growth_contributor_profiles where id=$1',[x.profile]);
      }
    }
  });
  for(const table of ledgerTables)assert.equal((await row(db,`select count(*)::int n from public.${table}`)).n,0,table+' own cleanup');
}

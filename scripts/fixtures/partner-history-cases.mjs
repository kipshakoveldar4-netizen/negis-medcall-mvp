import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { seedPartnerLedger, seedReferral, partnerPayment, partnerPayout } from './partner-ledger-cases.mjs';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const observed=promise=>promise.then(value=>({value}),error=>({error}));
const history=async(db,x,offset=0,month=null)=>(await one(db,'select public.read_growth_partner_history($1,$2,$3) value',[x.actor,offset,month])).value;
async function rollback(db,action){await db.query('begin');try{return await action();}finally{await db.query('rollback');}}
async function denied(db,action,code){await db.query('savepoint history_denial');try{await assert.rejects(action,error=>error.code===code);}finally{await db.query('rollback to savepoint history_denial;release savepoint history_denial');}}
const tables=['growth_contributor_profiles','growth_partners','growth_referrals','platform_subscription_payments','growth_partner_commissions','growth_partner_payouts','platform_subscriptions','workspaces'];
const snapshot=async db=>JSON.stringify((await db.query('select * from ('+tables.map(table=>`select '${table}' t,to_jsonb(r) v from public.${table} r`).join(' union all ')+') q order by t,v::text')).rows);
async function blocked(db,waiter,blocker){for(let i=0;i<200;i++){if((await one(db,'select $1::integer=any(pg_blocking_pids($2::integer)) yes',[blocker,waiter])).yes)return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Expected an actual owned partner authority/ledger wait');}
async function cleanup(db,x){
  await db.query('delete from public.growth_partner_payouts where partner_id=$1',[x.partner]);
  await db.query('delete from public.growth_partner_commissions where partner_id=$1',[x.partner]);
  await db.query('delete from public.platform_subscription_payments where workspace_id in(select workspace_id from public.growth_referrals where partner_id=$1)',[x.partner]);
  await db.query('delete from public.platform_subscriptions where workspace_id in(select workspace_id from public.growth_referrals where partner_id=$1)',[x.partner]);
  const workspaces=(await db.query('delete from public.growth_referrals where partner_id=$1 returning workspace_id',[x.partner])).rows.map(r=>r.workspace_id);
  if(workspaces.length)await db.query('delete from public.workspaces where id=any($1::uuid[])',[workspaces]);
  await db.query('delete from public.growth_partners where id=$1',[x.partner]);
  await db.query('delete from public.growth_contributor_profiles where id=$1',[x.profile]);
}
export { cleanup as cleanupPartnerHistory };
export async function exercisePartnerHistory(db,fixture,source,t){
  await t.test('122 missing commercial activation differs from unapproved/foreign identity; all reads leave data unchanged',async()=>rollback(db,async()=>{
    const inactive=await seedPartnerLedger(db,{activated:false}),pending=await seedPartnerLedger(db,{approved:false}),active=await seedPartnerLedger(db);
    const before=await snapshot(db);await db.query('set local role service_role');
    assert.deepEqual(await history(db,inactive),{state:'not_activated'});
    await denied(db,()=>history(db,pending),'P1091');await denied(db,()=>history(db,{actor:null}),'P1091');
    await denied(db,()=>history(db,{actor:randomUUID()}),'P1091');
    const empty=await history(db,active);assert.deepEqual({...empty,generatedAt:undefined},{state:'ready',generatedAt:undefined,offset:0,month:null,items:[],hasMore:false});
    await db.query('reset role');assert.equal(await snapshot(db),before);
  }));
  await t.test('122 own commission/posting and confirmed transfer rows are exact, private and currency-preserving',async()=>rollback(db,async()=>{
    const x=await seedPartnerLedger(db,{first:5000,renewal:1000}),other=await seedPartnerLedger(db),a=await seedReferral(db,x),b=await seedReferral(db,x,'USD');
    const first=await partnerPayment(db,a,'900719925474099300'),renewal=await partnerPayment(db,a,'10001'),usd=await partnerPayment(db,b,'201');
    await partnerPayment(db,await seedReferral(db,other),'99999999');await partnerPayout(db,x,'123');
    await db.query("update public.growth_partner_commissions set created_at=case payment_id when $1 then '2026-01-01T00:00:00.000001Z'::timestamptz when $2 then '2026-01-01T00:00:00.000002Z'::timestamptz else '2026-02-01T00:00:00Z'::timestamptz end where partner_id=$3",[first,renewal,x.partner]);
    await db.query("update public.growth_partner_payouts set confirmed_at='2026-02-02T00:00:00Z' where partner_id=$1",[x.partner]);
    const before=await snapshot(db);await db.query('set local role service_role');const value=await history(db,x);
    assert.equal(value.items.length,4);assert.equal(value.hasMore,false);
    assert.deepEqual(value.items.map(r=>[r.kind,r.amountMinor,r.currency]),[['payout','123','KZT'],['first_payment','100','USD'],['renewal','1000','KZT'],['first_payment','450359962737049650','KZT']]);
    assert.deepEqual(value.items.slice(-2).map(r=>r.occurredAt),['2026-01-01T00:00:00.000002Z','2026-01-01T00:00:00.000001Z']);
    assert.ok(value.items.every(r=>Object.keys(r).sort().join(',')==='amountMinor,currency,id,kind,occurredAt'));
    assert.doesNotMatch(JSON.stringify(value),/Owned|workspace|paymentId|subscription|auth|request_key|confirmed_by|99999999/);
    const foreign=await history(db,other);assert.equal(foreign.items.length,1);assert.ok(!foreign.items.some(f=>value.items.some(r=>r.kind===f.kind&&r.id===f.id)));
    await db.query('reset role');assert.equal(await snapshot(db),before);assert.ok(usd);
  }));
  await t.test('122 stable ties, twenty-row pages and UTC calendar boundaries ignore session time zone',async()=>rollback(db,async()=>{
    const x=await seedPartnerLedger(db),a=await seedReferral(db,x),ids=[];
    for(let i=0;i<23;i++)ids.push(await partnerPayment(db,a,'101'));
    await db.query("update public.growth_partner_commissions set created_at='2026-02-28T23:59:59.999999Z' where partner_id=$1",[x.partner]);
    await db.query("update public.growth_partner_commissions set created_at='2026-03-01T00:00:00.000001Z' where payment_id=$1",[ids[0]]);
    await db.query("set local timezone='Pacific/Honolulu'");await db.query('set local role service_role');
    const first=await history(db,x),last=await history(db,x,20),feb=await history(db,x,0,'2026-02'),march=await history(db,x,0,'2026-03');
    assert.equal(first.items.length,20);assert.equal(first.hasMore,true);assert.equal(last.items.length,3);assert.equal(last.hasMore,false);
    const all=[...first.items,...last.items];assert.equal(new Set(all.map(r=>r.kind+':'+r.id)).size,23);
    const tied=all.slice(1);assert.deepEqual(tied.map(r=>r.id),tied.map(r=>r.id).sort());
    assert.equal(feb.items.length,20);assert.equal(feb.hasMore,true);assert.ok(feb.items.every(r=>r.occurredAt.startsWith('2026-02-')));
    assert.equal(march.items.length,1);assert.ok(march.items[0].occurredAt.startsWith('2026-03-01T00:00:00.000001Z'));
    assert.deepEqual((await history(db,x,1_000_000)).items,[]);assert.deepEqual((await history(db,x,0,'0001-01')).items,[]);
    await db.query('reset role');
  }));
  for(const [offset,month]of [[null,null],[-1,null],[1_000_001,null],[0,'0000-01'],[0,'2026-13'],[0,'2026-1'],[0,'2026-01 ']])
    await t.test(`122 invalid bounded query is refused: ${offset}/${month}`,async()=>rollback(db,async()=>{
      const x=await seedPartnerLedger(db);await denied(db,()=>history(db,x,offset,month),'P1222');
    }));
  await t.test('122 suspension and inconsistent/nonfinite journal rows never disclose old money',async()=>rollback(db,async()=>{
    const x=await seedPartnerLedger(db);await partnerPayment(db,await seedReferral(db,x));
    await db.query("update public.growth_partners set status='suspended' where id=$1",[x.partner]);assert.deepEqual(await history(db,x),{state:'suspended'});
    await db.query("update public.growth_partners set status='active' where id=$1",[x.partner]);
    await db.query("update public.growth_partner_commissions set created_at='-infinity' where partner_id=$1",[x.partner]);
    await denied(db,()=>history(db,x,0,'2026-01'),'P1092');
    await db.query('update public.growth_partner_commissions set created_at=clock_timestamp(),amount_minor=amount_minor+1 where partner_id=$1',[x.partner]);
    await denied(db,()=>history(db,x),'P1092');
  }));
  await t.test('122 retains approval and balance locks across a concurrently committed payment',async()=>{
    const x=await seedPartnerLedger(db),a=await seedReferral(db,x),writer=await fixture.connect(),reader=await fixture.connect();let reading;
    try{
      await writer.query('begin');await partnerPayment(writer,a,'10000');
      const w=(await one(writer,'select pg_backend_pid() id')).id,r=(await one(reader,'select pg_backend_pid() id')).id;
      await reader.query('set role service_role');reading=observed(history(reader,x));await blocked(db,r,w);
      await writer.query('commit');const result=await reading;assert.equal(result.error,undefined);assert.equal(result.value.items.length,1);assert.equal(result.value.items[0].amountMinor,'1000');
    }finally{await writer.query('rollback').catch(()=>{});if(reading)await reading;await reader.end();await writer.end();await cleanup(db,x);}
  });
  for(const target of ['profile','commercial'])await t.test('122 blocked reader sees committed revocation: '+target,async()=>{
    const x=await seedPartnerLedger(db);await partnerPayment(db,await seedReferral(db,x));
    const writer=await fixture.connect(),reader=await fixture.connect();let reading;
    try{
      await writer.query('begin');
      if(target==='profile')await writer.query("update public.growth_contributor_profiles set partner_status='suspended' where id=$1",[x.profile]);
      else await writer.query("update public.growth_partners set status='suspended' where id=$1",[x.partner]);
      const w=(await one(writer,'select pg_backend_pid() id')).id,r=(await one(reader,'select pg_backend_pid() id')).id;
      await reader.query('set role service_role');reading=observed(history(reader,x));await blocked(db,r,w);await writer.query('commit');
      const result=await reading;if(target==='profile')assert.equal(result.error?.code,'P1091');else assert.deepEqual(result.value,{state:'suspended'});
    }finally{await writer.query('rollback').catch(()=>{});if(reading)await reading;await reader.end();await writer.end();await cleanup(db,x);}
  });
  await t.test('122 stronger isolation is refused and browser roles have no journal executor',async()=>{
    const x=await seedPartnerLedger(db);
    try{
      await db.query('begin isolation level repeatable read');await denied(db,()=>history(db,x),'P1092');await db.query('rollback');
      for(const role of ['anon','authenticated'])await rollback(db,async()=>{
        await db.query('set local role '+role);await denied(db,()=>history(db,x),'42501');
      });
    }finally{await db.query('rollback').catch(()=>{});await cleanup(db,x);}
  });
  await t.test('122 can be reapplied without modifying existing journal/business rows',async()=>{
    const before=await snapshot(db);await db.query(source);assert.equal(await snapshot(db),before);
  });
}

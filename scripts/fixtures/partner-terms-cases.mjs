import assert from 'node:assert/strict';
import { createHash,randomBytes,randomUUID } from 'node:crypto';

const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const observed=p=>p.then(value=>({value}),error=>({error}));
async function rollback(db,fn){await db.query('begin');try{return await fn();}finally{await db.query('rollback');}}
async function denied(db,fn,code){await db.query('savepoint terms_denial');try{await assert.rejects(fn,e=>e.code===code);}finally{await db.query('rollback to savepoint terms_denial;release savepoint terms_denial');}}
const payload={firstCommissionBps:2350,renewalCommissionBps:725,terms:'Owned fictional proposal\nNot a real legal agreement.'};
async function seed(db){const x={actor:randomUUID(),owner:randomUUID()};
  const a=(await one(db,"select public.apply_growth_contributor($1,'Owned terms partner',true,true,'{}') v",[x.actor])).v;
  const p=(await one(db,"select public.review_growth_contributor($1,$2,$3,'partner','approve') v",[a.id,a.revision,x.owner])).v;
  return{...x,profile:p.id,profileRevision:p.revision};
}
const read=async(db,x,request=null,close=false,action=null,side='partner',actor=side==='partner'?x.actor:x.owner)=>(await one(db,
  'select public.read_growth_partner_terms($1,$2,$3,$4,$5,$6) v',[actor,side,x.profile,request,close,action])).v;
function command(x,action,revision=null,overrides={}){return{actor:['offer','cancel'].includes(action)?x.owner:x.actor,
  side:['offer','cancel'].includes(action)?'platform':'partner',profile:x.profile,request:randomUUID(),profileRevision:x.profileRevision,
  revision,action,payload:action==='offer'?{...payload}:action==='accept'?{accepted:true}:{},...overrides};}
const execute=async(db,c)=>(await one(db,'select public.execute_growth_partner_terms($1,$2,$3,$4,$5,$6,$7,$8) v',
  [c.actor,c.side,c.profile,c.request,c.profileRevision,c.revision,c.action,c.payload])).v;
async function cleanup(db,x){await db.query('delete from public.growth_partner_term_commands where profile_id=$1',[x.profile]);
  await db.query('delete from public.growth_partner_terms where profile_id=$1',[x.profile]);await db.query('delete from public.growth_partners where auth_user_id=$1',[x.actor]);
  await db.query('delete from public.growth_contributor_profiles where id=$1',[x.profile]);}
async function blocked(db,waiter,blocker){for(let n=0;n<160;n++){if((await one(db,'select $1::int=any(pg_blocking_pids($2::int)) yes',[blocker,waiter])).yes)return;await new Promise(r=>setTimeout(r,15));}assert.fail('Expected real partner terms lock wait');}

export async function exercisePartnerTerms(db,fixture,source,t){
  await t.test('114 approval alone creates no rates, code or commercial rows',async()=>rollback(db,async()=>{
    const x=await seed(db);await db.query('set local role service_role');
    assert.deepEqual(await read(db,x),{state:'not_offered',profileId:x.profile,profileRevision:x.profileRevision,agreement:null});
    assert.equal((await read(db,x,null,false,null,'platform')).state,'not_offered');await db.query('reset role');
    assert.equal((await one(db,'select count(*)::int n from public.growth_partners')).n,0);
  }));
  await t.test('114 explicit proposal is pending, replay is identical, and no code exists before partner acceptance',async()=>rollback(db,async()=>{
    const x=await seed(db),c=command(x,'offer');await db.query('set local role service_role');const a=await execute(db,c);
    assert.deepEqual(await execute(db,c),a);assert.equal(a.state,'committed');assert.equal(a.result.agreement.state,'pending');
    assert.equal(a.result.agreement.referralCode,null);assert.equal(a.result.agreement.firstCommissionBps,2350);assert.equal(a.result.agreement.terms,payload.terms);
    assert.deepEqual(await read(db,x),a.result);await db.query('reset role');
    assert.equal((await one(db,'select count(*)::int n from public.growth_partner_term_commands')).n,1);
    assert.equal((await one(db,'select count(*)::int n from public.growth_partners')).n,0);
  }));
  await t.test('114 accepted exact terms atomically issue one stable unique code without money or membership',async()=>rollback(db,async()=>{
    const x=await seed(db);await db.query('set local role service_role');const offer=await execute(db,command(x,'offer'));
    const c=command(x,'accept',offer.result.agreement.revision),a=await execute(db,c);
    assert.equal(a.result.agreement.state,'accepted');assert.match(a.result.agreement.referralCode,/^[A-F0-9]{32}$/);
    assert.equal(a.result.agreement.commercialStatus,'active');assert.deepEqual(await execute(db,c),a);assert.deepEqual(await read(db,x,c.request),a);
    assert.deepEqual(await read(db,x,c.request,true,'accept'),a);await db.query('reset role');
    const p=await one(db,'select * from public.growth_partners');assert.equal(p.auth_user_id,x.actor);assert.equal(p.first_commission_bps,2350);assert.equal(p.renewal_commission_bps,725);
    for(const table of ['growth_referrals','platform_subscription_payments','growth_partner_commissions','growth_partner_payouts','workspaces','staff_users'])
      assert.equal((await one(db,'select count(*)::int n from public.'+table)).n,0,table);
  }));
  for(const [label,change]of [['missing',{}],['string',{...payload,firstCommissionBps:'2350'}],['fraction',{...payload,firstCommissionBps:2350.5}],
    ['low',{...payload,firstCommissionBps:999}],['high',{...payload,renewalCommissionBps:1001}],['extra',{...payload,actor:randomUUID()}],
    ['empty',{...payload,terms:' '}],['control',{...payload,terms:'bad\u0001'}],['oversized',{...payload,terms:'x'.repeat(2001)}]])
    await t.test('114 invalid '+label+' terms cannot create default rates',async()=>rollback(db,async()=>{
      const x=await seed(db);await db.query('set local role service_role');await denied(db,()=>execute(db,command(x,'offer',null,{payload:change})),'P1142');
      await db.query('reset role');assert.equal((await one(db,'select count(*)::int n from public.growth_partner_terms')).n,0);
    }));
  await t.test('114 wrong side, foreign actor, missing explicit acceptance and stale profile are denied',async()=>rollback(db,async()=>{
    const x=await seed(db);await db.query('set local role service_role');const offer=await execute(db,command(x,'offer')),rev=offer.result.agreement.revision;
    await denied(db,()=>execute(db,command(x,'accept',rev,{actor:randomUUID()})),'P1141');
    await denied(db,()=>execute(db,command(x,'offer',null,{side:'partner',actor:x.actor})),'P1142');
    await denied(db,()=>execute(db,command(x,'accept',rev,{payload:{accepted:false}})),'P1142');
    await denied(db,()=>execute(db,command(x,'accept',rev,{profileRevision:randomUUID()})),'P1145');
  }));
  await t.test('114 cancel/decline require new explicit proposals and stale acceptance cannot revive one',async()=>rollback(db,async()=>{
    const x=await seed(db);await db.query('set local role service_role');const c=command(x,'offer'),a=await execute(db,c);
    const cancelled=await execute(db,command(x,'cancel',a.result.agreement.revision));assert.equal(cancelled.result.agreement.state,'cancelled');
    await denied(db,()=>execute(db,command(x,'accept',a.result.agreement.revision)),'P1145');
    assert.deepEqual(await execute(db,c),a);assert.equal((await read(db,x)).agreement.state,'cancelled','Old ACK is not a new proposal');
    const again=await execute(db,command(x,'offer',cancelled.result.agreement.revision));assert.equal(again.result.agreement.state,'pending');
    const declined=await execute(db,command(x,'decline',again.result.agreement.revision));assert.equal(declined.result.agreement.state,'declined');
  }));
  await t.test('114 accepted terms cannot be overwritten, double accepted or turned into a new rate silently',async()=>rollback(db,async()=>{
    const x=await seed(db);await db.query('set local role service_role');const o=await execute(db,command(x,'offer'));
    const a=await execute(db,command(x,'accept',o.result.agreement.revision));
    for(const action of ['offer','cancel','accept','decline'])await denied(db,()=>execute(db,command(x,action,a.result.agreement.revision)),'P1145');
  }));
  await t.test('114 the same verified person may propose and accept for self on the same ordinary terms',async()=>rollback(db,async()=>{
    const x=await seed(db);x.owner=x.actor;await db.query('set local role service_role');
    const o=await execute(db,command(x,'offer')),a=await execute(db,command(x,'accept',o.result.agreement.revision));
    assert.equal(a.result.agreement.firstCommissionBps,2350);assert.equal(a.result.agreement.renewalCommissionBps,725);
  }));
  await t.test('114 the accepted code composes with 113/112 capture, claim and a new own-company binding without money',async()=>rollback(db,async()=>{
    const x=await seed(db);await db.query('set local role service_role');const o=await execute(db,command(x,'offer'));
    const a=await execute(db,command(x,'accept',o.result.agreement.revision)),intent=randomUUID(),hash=createHash('sha256').update(randomBytes(32)).digest('hex');
    await db.query('reset role');const at=(await one(db,"select date_trunc('milliseconds',clock_timestamp()) at")).at.toISOString();
    await db.query('set local role service_role');await db.query("select public.capture_growth_partner_source_v2($1,$2,$3,'link',$4)",[intent,hash,a.result.agreement.referralCode,at]);
    await db.query('select public.claim_growth_partner_source($1,$2,$3)',[x.actor,intent,hash]);await db.query('reset role');const workspace=randomUUID();
    await db.query("insert into public.workspaces(id,name,created_at) values($1,'Owned fictional self referral',clock_timestamp())",[workspace]);
    await db.query("insert into public.staff_users(id,workspace_id,auth_user_id,email,full_name,role,status) values($1,$2,$3,'self@example.invalid','Owned self owner','owner','active')",[randomUUID(),workspace,x.actor]);
    await db.query('set local role service_role');const bound=(await one(db,'select public.bind_growth_partner_source($1,$2,$3) v',[x.actor,intent,workspace])).v;
    assert.equal(bound.state,'bound');assert.equal(bound.workspaceId,workspace);
    assert.deepEqual((await one(db,'select public.read_growth_partner_ledger($1) v',[x.actor])).v.registrations,'1');await db.query('reset role');
    assert.equal((await one(db,'select count(*)::int n from public.growth_referrals')).n,1);
    for(const table of ['platform_subscription_payments','growth_partner_commissions','growth_partner_payouts'])assert.equal((await one(db,'select count(*)::int n from public.'+table)).n,0);
  }));
  await t.test('114 legacy commercial rows remain untouched and are never automatically adopted',async()=>rollback(db,async()=>{
    const x=await seed(db);await db.query("insert into public.growth_partners(auth_user_id,display_name,referral_code) values($1,'Owned legacy','LEGACY_TEST')",[x.actor]);
    const before=await one(db,'select to_jsonb(p) v from public.growth_partners p');await db.query('set local role service_role');
    assert.equal((await read(db,x)).state,'legacy_unmanaged');await denied(db,()=>execute(db,command(x,'offer')),'P1145');await db.query('reset role');
    assert.deepEqual(await one(db,'select to_jsonb(p) v from public.growth_partners p'),before);
  }));
  await t.test('114 read after lost ACK recovers committed exact intent; changed payload/key ownership cannot borrow it',async()=>rollback(db,async()=>{
    const x=await seed(db),y=await seed(db),c=command(x,'offer');await db.query('set local role service_role');const a=await execute(db,c);
    assert.deepEqual(await read(db,x,c.request,false,null,'platform'),a);assert.deepEqual(await execute(db,c),a);
    await denied(db,()=>execute(db,{...c,payload:{...payload,firstCommissionBps:5000}}),'P1143');
    await denied(db,()=>read(db,{...y,owner:x.owner},c.request,false,null,'platform'),'P1143');
  }));
  await t.test('114 missing read is not a fence; explicit close prevents a late activation with the same identity',async()=>rollback(db,async()=>{
    const x=await seed(db);await db.query('set local role service_role');const o=await execute(db,command(x,'offer')),c=command(x,'accept',o.result.agreement.revision);
    assert.equal((await read(db,x,c.request)).state,'unconfirmed');assert.equal((await read(db,x,c.request,true,'accept')).state,'abandoned');
    assert.equal((await execute(db,c)).state,'abandoned');assert.equal((await read(db,x)).agreement.state,'pending');
    await db.query('reset role');assert.equal((await one(db,'select count(*)::int n from public.growth_partners')).n,0);
  }));
  await t.test('114 suspended approval blocks reads, recovery and all partner actions without deleting history',async()=>rollback(db,async()=>{
    const x=await seed(db);const o=await execute(db,command(x,'offer'));
    await db.query("update public.growth_contributor_profiles set partner_status='suspended' where id=$1",[x.profile]);await db.query('set local role service_role');
    await denied(db,()=>read(db,x),'P1141');await denied(db,()=>execute(db,command(x,'accept',o.result.agreement.revision)),'P1141');
    assert.equal((await read(db,x,null,false,null,'platform')).agreement.state,'pending');
  }));
  await t.test('114 private terms/journal, closed direct commercial writes and only two service RPCs',async()=>rollback(db,async()=>{
    for(const role of ['anon','authenticated','service_role']){
      for(const table of ['growth_partner_terms','growth_partner_term_commands']){
        assert.equal((await one(db,"select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') yes",[role,'public.'+table])).yes,false);
        assert.equal((await one(db,"select has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') yes",[role,'public.'+table])).yes,false);
      }
      for(const sig of ['public.partner_terms_actor(uuid,text,uuid)','public.partner_terms_snapshot(public.growth_contributor_profiles)'])
        assert.equal((await one(db,"select has_function_privilege($1,$2,'EXECUTE') yes",[role,sig])).yes,false);
    }
    assert.equal((await one(db,"select has_table_privilege('service_role','public.growth_partners','INSERT,UPDATE,DELETE,TRUNCATE') yes")).yes,false);
  }));
  for(const mode of ['approval','cancel','close','commit','competing'])await t.test('114 real '+mode+' wait rechecks the outcome rather than duplicating activation',async()=>{
    const x=await seed(db),a=await fixture.connect(),b=await fixture.connect();let pending;try{
      const o=await execute(db,command(x,'offer')),c=command(x,'accept',o.result.agreement.revision);
      await a.query('begin');const ap=(await one(a,'select pg_backend_pid() id')).id,bp=(await one(b,'select pg_backend_pid() id')).id;
      if(mode==='approval')await a.query("update public.growth_contributor_profiles set partner_status='suspended' where id=$1",[x.profile]);
      if(mode==='cancel')await execute(a,command(x,'cancel',o.result.agreement.revision));
      if(mode==='close')await read(a,x,c.request,true,'accept');
      if(mode==='commit'||mode==='competing')await execute(a,c);
      await b.query('set role service_role');pending=observed(execute(b,mode==='competing'?{...c,request:randomUUID()}:c));await blocked(db,bp,ap);await a.query('commit');const result=await pending;
      if(mode==='approval')assert.equal(result.error?.code,'P1141');
      if(mode==='cancel')assert.equal(result.error?.code,'P1145');
      if(mode==='close')assert.equal(result.value?.state,'abandoned');
      if(mode==='commit')assert.equal(result.value?.state,'committed');
      if(mode==='competing')assert.equal(result.error?.code,'P1145');
      assert.equal((await one(db,'select count(*)::int n from public.growth_partners where auth_user_id=$1',[x.actor])).n,['commit','competing'].includes(mode)?1:0);
    }finally{await a.query('rollback');if(pending)await pending;await a.end();await b.end();await cleanup(db,x);}
  });
  await t.test('114 real commercial suspension wait denies a committed receipt to the suspended partner',async()=>{
    const x=await seed(db),a=await fixture.connect(),b=await fixture.connect();let pending;try{
      const o=await execute(db,command(x,'offer')),c=command(x,'accept',o.result.agreement.revision);await execute(db,c);
      await a.query('begin');await a.query("update public.growth_partners set status='suspended' where auth_user_id=$1",[x.actor]);
      const ap=(await one(a,'select pg_backend_pid() id')).id,bp=(await one(b,'select pg_backend_pid() id')).id;
      await b.query('set role service_role');pending=observed(read(b,x,c.request));await blocked(db,bp,ap);await a.query('commit');
      assert.equal((await pending).error?.code,'P1141');assert.equal((await read(db,x,null,false,null,'platform')).agreement.referralCode,null);
    }finally{await a.query('rollback');if(pending)await pending;await a.end();await b.end();await cleanup(db,x);}
  });
  for(const [change,message]of [
    ['alter table public.growth_partner_terms add column unexpected text','partner_terms_shape_unconfirmed'],
    ['alter table public.growth_partner_terms alter column revision drop not null','partner_terms_shape_unconfirmed'],
    ['alter table public.growth_partner_terms drop constraint growth_partner_terms_first_commission_bps_check','partner_terms_shape_unconfirmed'],
    ['create policy unexpected on public.growth_partner_terms for select to authenticated using(true)','partner_terms_shape_unconfirmed'],
    ['alter table public.growth_partner_terms disable row level security','partner_terms_shape_unconfirmed'],
    ['grant select on public.growth_partner_term_commands to authenticated','partner_terms_access_unconfirmed'],
    ['grant insert(auth_user_id) on public.growth_partners to service_role','partner_terms_legacy_writer_unconfirmed'],
    ['grant select on public.growth_partners to authenticated','partner_terms_legacy_writer_unconfirmed']])
    await t.test('114 rerun refuses dependency drift '+change,async()=>{
      await db.query('begin');try{await db.query(change);await assert.rejects(db.query(source),e=>e.message===message);}finally{await db.query('rollback');}
    });
  await t.test('114 exact rerun preserves accepted terms, code and command receipts',async()=>{
    const x=await seed(db);try{const o=await execute(db,command(x,'offer'));const a=await execute(db,command(x,'accept',o.result.agreement.revision));
      await db.query(source);assert.deepEqual(await read(db,x),a.result);
    }finally{await cleanup(db,x);}
  });
}

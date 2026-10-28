import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { seedPartnerLedger } from './partner-ledger-cases.mjs';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const observed=p=>p.then(value=>({value}),error=>({error}));
async function rollback(db,run){await db.query('begin');try{await run();}finally{await db.query('rollback');}}
async function denied(db,run,code){await db.query('savepoint owned_company_denial');try{await assert.rejects(run,e=>e.code===code);}finally{await db.query('rollback to savepoint owned_company_denial;release savepoint owned_company_denial');}}
function notice(){const v={version:'owned-company-v1',text:'Fictional consent for owned local tests only.',purpose:'partner_company_registration',policyRevision:'owned-v1',policyUrl:'https://consent.fixture.invalid/policy'};
  return{...v,sha256:createHash('sha256').update(JSON.stringify([v.version,v.text,v.purpose,v.policyRevision,v.policyUrl])).digest('hex')};}
async function seed(db,purpose='marketing'){
  const x={partner:await seedPartnerLedger(db),actor:randomUUID(),owner:randomUUID(),source:randomUUID(),request:randomUUID(),proof:createHash('sha256').update(randomUUID()).digest('hex'),
    company:{name:'Owned new company',ownerName:'Owned Applicant',purpose,vertical:purpose==='clinic_services'?'beauty':null,timeZone:'Asia/Almaty'},email:'applicant@example.invalid',consent:notice()};
  const start=(await one(db,"select to_char((clock_timestamp()-interval '1 second') at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') at")).at;
  await db.query("select public.capture_growth_partner_source_v2($1,$2,$3,'link',$4)",[x.source,x.proof,x.partner.code,start]);return x;
}
const apply=async(db,x)=>(await one(db,'select public.submit_growth_partner_company($1,$2,$3,$4,$5,$6,$7) value',[x.actor,x.source,x.proof,x.request,x.company,x.email,x.consent])).value;
const read=async(db,x)=>(await one(db,'select public.read_growth_partner_company($1,$2) value',[x.actor,x.request])).value;
async function review(db,x,revision,request=randomUUID(),action='approve'){
  return(await one(db,'select public.review_growth_partner_company($1,$2,$3,$4,$5) value',[x.owner,x.request,revision,request,action])).value;
}
async function scope(db,x){return one(db,`select
  (select count(*)::int from public.workspaces where id in(select workspace_id from public.growth_partner_company_applications where id=$1)) workspaces,
  (select count(*)::int from public.staff_users where auth_user_id=$2) staff,
  (select count(*)::int from public.workspace_settings where workspace_id in(select workspace_id from public.growth_partner_company_applications where id=$1)) settings,
  (select count(*)::int from public.platform_subscription_payments where workspace_id in(select workspace_id from public.growth_partner_company_applications where id=$1)) payments,
  (select count(*)::int from public.growth_referrals where workspace_id in(select workspace_id from public.growth_partner_company_applications where id=$1)) referrals`,[x.request,x.actor]);}
async function cleanup(db,x){const app=await one(db,'select workspace_id w from public.growth_partner_company_applications where id=$1',[x.request]);
  await db.query('delete from public.growth_partner_company_applications where id=$1',[x.request]);
  if(app?.w){await db.query('delete from public.growth_partner_payment_windows where workspace_id=$1',[app.w]);
    await db.query('delete from public.growth_partner_commissions where payment_id in(select id from public.platform_subscription_payments where workspace_id=$1)',[app.w]);
    await db.query('delete from public.platform_subscription_payments where workspace_id=$1',[app.w]);await db.query('delete from public.platform_subscriptions where workspace_id=$1',[app.w]);
    await db.query('delete from public.growth_referrals where workspace_id=$1',[app.w]);
    await db.query('delete from public.staff_users where workspace_id=$1',[app.w]);await db.query('delete from public.workspace_settings where workspace_id=$1',[app.w]);
    await db.query('delete from public.growth_partner_sources where id=$1',[x.source]);await db.query('delete from public.workspaces where id=$1',[app.w]);}
  else await db.query('delete from public.growth_partner_sources where id=$1',[x.source]);
  await db.query('delete from public.growth_partners where id=$1',[x.partner.partner]);await db.query('delete from public.growth_contributor_profiles where id=$1',[x.partner.profile]);
}
async function blocked(db,waiter,blocker){for(let n=0;n<180;n++){if((await one(db,'select $1::int=any(pg_blocking_pids($2::int)) yes',[blocker,waiter])).yes)return;await new Promise(r=>setTimeout(r,15));}assert.fail('Expected real owned company approval lock wait');}

export async function exercisePartnerCompanyApproval(db,fixture,source,t,{legacyPurge}={}){
  await t.test('121 explicit consent and claimed source create only one pending application, not a workspace or money',async()=>rollback(db,async()=>{
    const x=await seed(db),first=await apply(db,x);assert.equal(first.state,'pending');assert.equal(first.workspaceId,null);assert.equal(first.sourceState,'captured');assert.deepEqual(await apply(db,x),first);
    assert.deepEqual(await scope(db,x),{workspaces:0,staff:0,settings:0,payments:0,referrals:0});
    const stored=await one(db,'select consent_snapshot,owner_email,applicant_auth_user_id from public.growth_partner_company_applications where id=$1',[x.request]);
    assert.deepEqual(stored.consent_snapshot,x.consent);assert.equal(stored.applicant_auth_user_id,x.actor);
    await denied(db,()=>apply(db,{...x,company:{...x.company,name:'Changed'}}),'P1213');
    await denied(db,()=>apply(db,{...x,request:randomUUID()}),'P1213');
    await denied(db,()=>read(db,{...x,actor:randomUUID()}),'P1211');
    await denied(db,()=>apply(db,{...x,proof:'0'.repeat(64)}),'P1121');
  }));
  for(const change of ['missing','purpose','timezone','vertical','notice','email','selector'])await t.test('121 invalid '+change+' cannot claim, submit or create a company',async()=>rollback(db,async()=>{
    const x=await seed(db);
    if(change==='missing')delete x.company.ownerName;if(change==='purpose')x.company.purpose='unknown';if(change==='timezone')x.company.timeZone='unknown/timezone';
    if(change==='vertical')x.company.vertical='beauty';if(change==='notice')x.consent.sha256='0'.repeat(64);if(change==='email')x.email='not-an-email';if(change==='selector')x.company.workspaceId=randomUUID();
    await denied(db,()=>apply(db,x),'P1212');
    assert.equal((await one(db,'select actor_auth_user_id actor from public.growth_partner_sources where id=$1',[x.source])).actor,null);
  }));
  for(const purpose of ['marketing','clinic_services','mortgage_leads'])await t.test('121 approval atomically creates exact '+purpose+' settings, original owner membership and pending payment',async()=>rollback(db,async()=>{
    const x=await seed(db,purpose),pending=await apply(db,x),request=randomUUID();
    const result=await review(db,x,pending.revision,request);assert.equal(result.state,'approved');assert.equal(result.sourceState,'pending_payment');
    assert.deepEqual(await review(db,x,pending.revision,request),result);assert.deepEqual(await read(db,x),result);
    assert.deepEqual(await scope(db,x),{workspaces:1,staff:1,settings:2,payments:0,referrals:0});
    const staff=await one(db,'select auth_user_id,role,status,password_reset_required from public.staff_users where workspace_id=$1',[result.workspaceId]);
    assert.deepEqual(staff,{auth_user_id:x.actor,role:'owner',status:'active',password_reset_required:false});
    const settings=(await db.query('select key,value from public.workspace_settings where workspace_id=$1 order by key',[result.workspaceId])).rows;
    assert.deepEqual(settings,[{key:'clinic_schedule',value:{timeZone:'Asia/Almaty'}},purpose==='clinic_services'?{key:'workspace_vertical',value:{vertical:'beauty'}}:{key:'workspace_purpose',value:{purpose}}]);
    await denied(db,()=>review(db,x,pending.revision,randomUUID()),'P1213');
    await db.query("update public.staff_users set status='disabled' where workspace_id=$1",[result.workspaceId]);await denied(db,()=>read(db,x),'P1121');
  }));
  await t.test('121 rejection and its exact retry create no company and cannot later be silently approved',async()=>rollback(db,async()=>{
    const x=await seed(db),pending=await apply(db,x),request=randomUUID(),result=await review(db,x,pending.revision,request,'reject');
    assert.equal(result.state,'rejected');assert.deepEqual(await review(db,x,pending.revision,request,'reject'),result);
    await denied(db,()=>review(db,x,pending.revision,randomUUID()),'P1213');assert.deepEqual(await scope(db,x),{workspaces:0,staff:0,settings:0,payments:0,referrals:0});
  }));
  await t.test('121 own company follows the same approval and unpaid-reservation rules',async()=>rollback(db,async()=>{
    const x=await seed(db);x.actor=x.partner.actor;const pending=await apply(db,x),result=await review(db,x,pending.revision);
    assert.equal(result.state,'approved');assert.equal(result.sourceState,'pending_payment');
    assert.equal((await one(db,'select auth_user_id from public.staff_users where workspace_id=$1',[result.workspaceId])).auth_user_id,x.partner.actor);
    assert.deepEqual(await scope(db,x),{workspaces:1,staff:1,settings:2,payments:0,referrals:0});
  }));
  await t.test('121 a new company cannot rewrite an existing workspace or the applicant existing membership',async()=>rollback(db,async()=>{
    const x=await seed(db),old=randomUUID();await db.query("insert into public.workspaces(id,name,owner_email) values($1,'Owned sentinel company','sentinel@example.invalid')",[old]);
    await db.query("insert into public.workspace_settings(workspace_id,key,value) values($1,'clinic_schedule','{\"timeZone\":\"Asia/Almaty\"}')",[old]);
    await db.query("insert into public.staff_users(workspace_id,auth_user_id,email,full_name,role,status) values($1,$2,$3,'Owned existing member','receptionist','active')",[old,x.actor,x.email]);
    const snapshot=async()=>JSON.stringify((await db.query(`select * from(
      select 'workspace' t,to_jsonb(w) v from public.workspaces w where id=$1 union all
      select 'settings',to_jsonb(s) from public.workspace_settings s where workspace_id=$1 union all
      select 'staff',to_jsonb(s) from public.staff_users s where workspace_id=$1) rows order by t,v::text`,[old])).rows);
    const before=await snapshot(),pending=await apply(db,x),result=await review(db,x,pending.revision);
    assert.notEqual(result.workspaceId,old);assert.equal(await snapshot(),before);
    assert.equal((await read(db,x)).workspaceId,result.workspaceId);
  }));
  await t.test('121 a revoked referrer cannot be used to create a company, while the applicant can still read its own pending request',async()=>rollback(db,async()=>{
    const x=await seed(db),pending=await apply(db,x);await db.query("update public.growth_contributor_profiles set partner_status='suspended' where id=$1",[x.partner.profile]);
    await denied(db,()=>review(db,x,pending.revision),'P1121');assert.equal((await read(db,x)).state,'pending');
    assert.deepEqual(await scope(db,x),{workspaces:0,staff:0,settings:0,payments:0,referrals:0});
  }));
  for(const target of ['workspace_settings','staff_users'])await t.test('121 '+target+' failure rolls all new rows back; the same approval can be retried after repair',async()=>rollback(db,async()=>{
    const x=await seed(db),pending=await apply(db,x),request=randomUUID();
    await db.query(`create function public.owned_company_failure() returns trigger language plpgsql as $$begin raise exception 'owned forced failure';end$$;
      create trigger owned_company_failure before insert on public.${target} for each row execute function public.owned_company_failure()`);
    await denied(db,()=>review(db,x,pending.revision,request),'P0001');
    assert.equal((await read(db,x)).revision,pending.revision);assert.deepEqual(await scope(db,x),{workspaces:0,staff:0,settings:0,payments:0,referrals:0});
    assert.equal((await one(db,'select count(*)::int n from public.workspaces')).n,0,'No orphan workspace hidden by the application selector');
    await db.query(`drop trigger owned_company_failure on public.${target};drop function public.owned_company_failure()`);
    assert.equal((await review(db,x,pending.revision,request)).state,'approved');
  }));
  await t.test('121 approval after expiry creates the company without renewing the original payment window',async()=>{
    const x=await seed(db);try{const pending=await apply(db,x);
    await db.query("update public.growth_partner_sources set captured_at=c.at-interval '8 days',expires_at=c.at-interval '1 day' from(select clock_timestamp() at)c where id=$1",[x.source]);
    const original=await one(db,'select captured_at,expires_at from public.growth_partner_sources where id=$1',[x.source]);
    const result=await review(db,x,pending.revision);assert.equal(result.state,'approved');assert.equal(result.sourceState,'expired');
    assert.deepEqual(await one(db,'select captured_at,expires_at from public.growth_partner_sources where id=$1',[x.source]),original);
    const subscription=randomUUID();await db.query("insert into public.platform_subscriptions(id,workspace_id,plan,currency,price_minor) values($1,$2,'basic','KZT',10000)",[subscription,result.workspaceId]);
    const paidAt=(await one(db,"select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') at")).at;
    await db.query("select public.confirm_growth_subscription_payment($1,$2,10000,'KZT',$3,$4,$5)",[result.workspaceId,subscription,paidAt,randomUUID(),x.actor]);
    assert.deepEqual(await scope(db,x),{workspaces:1,staff:1,settings:2,payments:1,referrals:0});
    }finally{await cleanup(db,x);}
  });
  await t.test('121 consent binding cannot be rewritten after submission or after a decision',async()=>rollback(db,async()=>{
    const x=await seed(db),pending=await apply(db,x);
    await denied(db,()=>db.query('update public.growth_partner_company_applications set owner_email=$2 where id=$1',[x.request,'changed@example.invalid']),'P1212');
    await denied(db,()=>db.query('update public.growth_partner_company_applications set company=$2 where id=$1',[x.request,{...x.company,name:'Changed'}]),'P1212');
    await review(db,x,pending.revision);await denied(db,()=>db.query('update public.growth_partner_company_applications set reviewed_by=$2 where id=$1',[x.request,randomUUID()]),'P1212');
  }));
  await t.test('121 cleanup preserves submitted consent and deletes only abandoned expired visits; original 113 reproduces the FK refusal',async()=>rollback(db,async()=>{
    const x=await seed(db);await apply(db,x);const abandoned=randomUUID();
    const start=(await one(db,"select to_char((clock_timestamp()-interval '1 second') at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') at")).at;
    await db.query("select public.capture_growth_partner_source_v2($1,$2,$3,'link',$4)",[abandoned,x.proof,x.partner.code,start]);
    await db.query("update public.growth_partner_sources set captured_at=c.at-interval '8 days',expires_at=c.at-interval '1 day' from(select clock_timestamp() at)c where id=any($1::uuid[])",[[x.source,abandoned]]);
    assert.equal(typeof legacyPurge,'string','Use the exact reviewed original cleanup body as the negative control');assert.ok(!legacyPurge.includes('$owned_original_113$'));
    await db.query('savepoint original_cleanup');try{
      await db.query("create or replace function public.purge_growth_partner_sources(p_limit integer) returns integer language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='8s' as $owned_original_113$"+legacyPurge+'$owned_original_113$');
      await denied(db,()=>db.query('select public.purge_growth_partner_sources(100)'),'23503');
    }finally{await db.query('rollback to savepoint original_cleanup;release savepoint original_cleanup');}
    assert.equal((await one(db,'select public.purge_growth_partner_sources(100) n')).n,1);
    assert.deepEqual((await db.query('select id from public.growth_partner_sources where id=any($1::uuid[])',[[x.source,abandoned]])).rows,[{id:x.source}]);
    const app=await read(db,x);assert.equal(app.state,'pending');assert.equal(app.sourceState,'expired');
    assert.deepEqual((await one(db,'select consent_snapshot from public.growth_partner_company_applications where id=$1',[x.request])).consent_snapshot,x.consent);
  }));
  await t.test('121 private helper, table and old source-reservation grants remain closed, including a rerun',async()=>{
    await db.query(source);
    for(const role of ['anon','authenticated','service_role']){
      assert.equal((await one(db,"select has_table_privilege($1,'public.growth_partner_company_applications','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') yes",[role])).yes,false);
      for(const fn of ['public.bind_growth_partner_source(uuid,uuid,uuid)','public.valid_partner_company(jsonb)','public.guard_partner_company_application()','public.partner_company_result(public.growth_partner_company_applications)'])
        assert.equal((await one(db,"select has_function_privilege($1,$2,'EXECUTE') yes",[role,fn])).yes,false);
      for(const fn of ['public.submit_growth_partner_company(uuid,uuid,text,uuid,jsonb,text,jsonb)','public.read_growth_partner_company(uuid,uuid)','public.review_growth_partner_company(uuid,uuid,uuid,uuid,text)'])
        assert.equal((await one(db,"select has_function_privilege($1,$2,'EXECUTE') yes",[role,fn])).yes,role==='service_role');
    }
  });
  for(const same of [true,false])await t.test('121 two real sessions reviewing the same application: same request='+same,async()=>{
    const x=await seed(db),pending=await apply(db,x),a=await fixture.connect(),b=await fixture.connect(),request=randomUUID();
    try{await a.query('begin');
      // Match the actual protocol: command fence before source, never an
      // artificial inverse-order blocker that the writer itself cannot create.
      await a.query("select pg_advisory_xact_lock(hashtextextended('partner-company-command:'||$1::text,0))",[request]);
      await a.query("select pg_advisory_xact_lock(hashtextextended('partner-source:'||$1::text,0))",[x.source]);
      const aid=(await one(a,'select pg_backend_pid() id')).id,bid=(await one(b,'select pg_backend_pid() id')).id;
      const other=observed(review(b,x,pending.revision,same?request:randomUUID()));await blocked(db,bid,aid);
      const result=await review(a,x,pending.revision,request);await a.query('commit');const after=await other;
      if(same){assert.equal(after.error,undefined);assert.deepEqual(after.value,result);}else assert.equal(after.error?.code,'P1213');
      assert.deepEqual(await scope(db,x),{workspaces:1,staff:1,settings:2,payments:0,referrals:0});
    }finally{await a.query('rollback');await a.end();await b.end();await cleanup(db,x);}
  });
}

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const {parseCreatorJobPage,parseCreatorJobReceipt}=await import(new URL('../../lib/crm/creator-job-contracts.ts',import.meta.url).href);
const row=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const observed=p=>p.then(value=>({value}),error=>({error}));
async function rollback(db,action){await db.query('begin');try{return await action();}finally{await db.query('rollback');}}
async function denied(db,action,code){await db.query('savepoint creator_denial');try{await assert.rejects(action,error=>error.code===code);}finally{await db.query('rollback to savepoint creator_denial;release savepoint creator_denial');}}
const tables=['growth_creator_events','growth_creator_commands','growth_creator_submissions','growth_creator_jobs'];
const snapshot=async db=>JSON.stringify((await db.query('select * from ('+tables.map(t=>`select '${t}' t,to_jsonb(r) v from public.${t} r`).join(' union all ')+') s order by t,v::text')).rows);
async function seed(db){
  const x={w:randomUUID(),otherW:randomUUID(),staff:randomUUID(),otherStaff:randomUUID(),owner:randomUUID(),actor:randomUUID(),other:randomUUID()};
  for(const w of [x.w,x.otherW])await db.query("insert into public.workspaces(id,name) values($1,'QA creator workspace')",[w]);
  await db.query("insert into public.staff_users(id,workspace_id,auth_user_id,email,full_name,role,status) values($1,$2,$3,'qa@example.com','QA owner','owner','active'),($4,$5,$3,'qa@example.com','QA other owner','owner','active')",[x.staff,x.w,x.owner,x.otherStaff,x.otherW]);
  for(const actor of [x.actor,x.other]){
    const profile=(await row(db,"select public.apply_growth_contributor($1,'QA creator',false,true,'{}') v",[actor])).v;
    await db.query("select public.review_growth_contributor($1,$2,$3,'creator','approve')",[profile.id,profile.revision,x.owner]);
    if(actor===x.actor)x.profile=profile.id;else x.otherProfile=profile.id;
  }
  x.clinic={actor:x.owner,workspace:x.w,staff:x.staff};x.creator={actor:x.actor};
  x.terms={creatorId:x.profile,title:'QA video',brief:'QA brief\nSecond paragraph',rightsTerms:'QA explicit rights, not public legal terms',feeMinor:'9007199254740993',currency:'KZT',dueAt:'2030-01-01T08:00:00.000Z'};
  return x;
}
export const seedCreatorJobFixture=seed;
export async function creatorCommand(db,who,action,payload={},job=null,key=randomUUID()){
  const value=(await row(db,'select public.execute_growth_creator_job($1,$2,$3,$4,$5,$6,$7,$8) v',
    [who.actor,who.workspace??null,who.staff??null,key,job?.id??null,job?.revision??null,action,payload])).v;
  assert.ok(parseCreatorJobReceipt(value),JSON.stringify(value));return value;
}
async function list(db,who,offset=0){const value=(await row(db,'select public.read_growth_creator_jobs($1,$2,$3,$4) v',[who.actor,who.workspace??null,who.staff??null,offset])).v;assert.ok(parseCreatorJobPage(value),JSON.stringify(value));return value;}
async function prepare(db,x){
  const offered=await creatorCommand(db,x.clinic,'create',x.terms);
  const accepted=await creatorCommand(db,x.creator,'accept',{termsRevision:offered.job.termsRevision},offered.job);
  return creatorCommand(db,x.creator,'submit',{links:['https://example.com/qa.mp4'],note:'QA delivery'},accepted.job);
}
async function cleanup(db,x){
  for(const t of tables)await db.query(t==='growth_creator_jobs'?`delete from public.${t} where workspace_id=any($1)`:
    `delete from public.${t} where job_id in(select id from public.growth_creator_jobs where workspace_id=any($1))`,[[x.w,x.otherW]]);
  await db.query('delete from public.growth_contributor_profiles where id=any($1)',[[x.profile,x.otherProfile]]);
  await db.query('delete from public.staff_users where id=any($1)',[[x.staff,x.otherStaff]]);
  await db.query('delete from public.workspaces where id=any($1)',[[x.w,x.otherW]]);
}
export const cleanupCreatorJobFixture=cleanup;
async function blocked(db,waiter,blocker){for(let n=0;n<180;n++){if((await row(db,'select $1::int=any(pg_blocking_pids($2::int)) yes',[blocker,waiter])).yes)return;await new Promise(r=>setTimeout(r,10));}assert.fail('Expected the owned creator authority/command lock wait');}

export async function reproduceUnfencedCreatorCommand(db,t){
  await t.test('before command closure, an absent receipt does not prevent a late original create',async()=>rollback(db,async()=>{
    const x=await seed(db),key=randomUUID();await db.query('set local role service_role');
    const absent=(await row(db,'select public.read_growth_creator_command($1,$2,$3,$4) v',[x.owner,x.w,x.staff,key])).v;
    assert.equal(absent,null,'Absence is only a point-in-time observation, not cancellation');
    const late=await creatorCommand(db,x.clinic,'create',x.terms,null,key);
    assert.equal(late.job.state,'offered');assert.equal(late.replayed,false);
    assert.equal((await list(db,x.clinic)).items.length,1,'A delayed original request still writes after that absent read');
  }));
}

export async function exerciseCreatorJobRefusals(db,source,t){
  for(const [name,change,message] of [
    ['profile RLS',"alter table public.growth_contributor_profiles disable row level security",'creator_job_dependencies_unconfirmed'],
    ['staff RLS',"alter table public.staff_users disable row level security",'creator_job_dependencies_unconfirmed'],
    ['workspace RLS',"alter table public.workspaces disable row level security",'creator_job_dependencies_unconfirmed'],
    ['workspace owner',"alter table public.workspaces owner to service_role",'creator_job_dependencies_unconfirmed'],
    ['profile writer',"alter function public.review_growth_contributor(uuid,uuid,uuid,text,text) stable",'creator_job_dependencies_unconfirmed'],
    ['browser bypass',"alter role authenticated bypassrls",'creator_job_dependencies_unconfirmed'],
    ['inherited executor',"create role creator_untrusted;grant creator_untrusted to authenticated;create function public.read_growth_creator_jobs(uuid,uuid,uuid,integer) returns jsonb language sql as $$select '{}'::jsonb$$;grant execute on function public.read_growth_creator_jobs(uuid,uuid,uuid,integer) to creator_untrusted",'creator_job_executor_unconfirmed'],
    ['inherited table reader',"create role creator_untrusted;grant creator_untrusted to authenticated;alter default privileges grant select on tables to creator_untrusted",'creator_job_direct_access_unconfirmed'],
  ])await t.test('110 refuses '+name+' without partial installation',async()=>{
    await db.query('begin');try{await db.query(change);await assert.rejects(db.query(source),e=>e.message===message);}finally{await db.query('rollback');}
    assert.equal((await row(db,"select to_regclass('public.growth_creator_jobs') v")).v,null);
  });
}

export async function exerciseCreatorJobs(db,fixture,source,t){
  await t.test('110 partner approval never grants creator jobs; each contributor direction is independent',async()=>rollback(db,async()=>{
    const x=await seed(db),actor=randomUUID();
    const application=(await row(db,"select public.apply_growth_contributor($1,'QA both roles',true,true,'{}') v",[actor])).v;
    const partnerApproved=(await row(db,"select public.review_growth_contributor($1,$2,$3,'partner','approve') v",[application.id,application.revision,x.owner])).v;
    await db.query('set local role service_role');await denied(db,()=>list(db,{actor}),'P1101');
    await denied(db,()=>creatorCommand(db,x.clinic,'create',{...x.terms,creatorId:application.id}),'P1101');
    await db.query('reset role');await db.query("select public.review_growth_contributor($1,$2,$3,'creator','approve')",[application.id,partnerApproved.revision,x.owner]);
    await db.query('set local role service_role');assert.deepEqual(await list(db,{actor}),{items:[],hasMore:false});
  }));
  await t.test('110 full offered/accepted/submitted/changes/resubmitted/approved path preserves original terms and exact amounts',async()=>rollback(db,async()=>{
    const x=await seed(db);await db.query('set local role service_role');
    let current=await creatorCommand(db,x.clinic,'create',x.terms);const original=current.job;
    assert.equal(original.feeMinor,x.terms.feeMinor);assert.equal(original.state,'offered');
    current=await creatorCommand(db,x.creator,'accept',{termsRevision:original.termsRevision},current.job);
    current=await creatorCommand(db,x.creator,'submit',{links:['https://example.com/first.mp4'],note:'QA first'},current.job);
    current=await creatorCommand(db,x.clinic,'request_changes',{feedback:'QA replace ending'},current.job);
    assert.equal(current.job.feedback,'QA replace ending');
    current=await creatorCommand(db,x.creator,'submit',{links:['https://example.com/second.mp4'],note:'QA revision'},current.job);
    assert.equal(current.job.submissionCount,2);assert.equal(current.job.feedback,null);
    current=await creatorCommand(db,x.clinic,'approve',{},current.job);
    assert.equal(current.job.state,'approved');assert.ok(current.job.approvedAt);
    for(const k of ['title','brief','rightsTerms','feeMinor','currency','termsRevision','dueAt'])assert.equal(current.job[k],original[k]);
    assert.doesNotMatch(JSON.stringify(current),/workspace|auth|created_by|paidMinor|bank|actor_id/);
    assert.equal((await list(db,x.clinic)).items.length,1);assert.equal((await list(db,x.creator)).items.length,1);
    await db.query('reset role');
    assert.equal((await row(db,'select count(*)::int n from public.growth_creator_submissions')).n,2);
    assert.equal((await row(db,'select count(*)::int n from public.growth_creator_commands')).n,6);
    assert.equal((await row(db,'select count(*)::int n from public.growth_creator_events')).n,6);
    for(const table of ['platform_subscription_payments','growth_partner_commissions','growth_partner_payouts'])
      assert.equal((await row(db,`select count(*)::int n from public.${table}`)).n,0,'Acceptance is not money');
  }));
  await t.test('110 lost acknowledgement/replay returns current state and never duplicates create or submission',async()=>rollback(db,async()=>{
    const x=await seed(db),key=randomUUID();await db.query('set local role service_role');
    const offered=await creatorCommand(db,x.clinic,'create',x.terms,null,key);
    const accepted=await creatorCommand(db,x.creator,'accept',{termsRevision:offered.job.termsRevision},offered.job);
    const again=await creatorCommand(db,x.clinic,'create',x.terms,null,key);
    assert.equal(again.replayed,true);assert.equal(again.appliedRevision,offered.appliedRevision);assert.equal(again.job.revision,accepted.job.revision);
    await denied(db,()=>creatorCommand(db,x.clinic,'create',{...x.terms,feeMinor:'1'},null,key),'P1103');
    const sendKey=randomUUID(),payload={links:['https://example.com/once.mp4'],note:''};
    const first=await creatorCommand(db,x.creator,'submit',payload,accepted.job,sendKey);
    const replay=await creatorCommand(db,x.creator,'submit',payload,accepted.job,sendKey);
    assert.equal(replay.replayed,true);assert.deepEqual(replay.job,first.job);
    const receipt=(await row(db,'select public.read_growth_creator_command($1,null,null,$2) v',[x.actor,sendKey])).v;
    assert.ok(parseCreatorJobReceipt(receipt));assert.equal(receipt.job.id,first.job.id);
    assert.equal((await row(db,'select public.read_growth_creator_command($1,null,null,$2) v',[x.actor,randomUUID()])).v,null);
    await db.query('reset role');assert.equal((await row(db,'select count(*)::int n from public.growth_creator_submissions')).n,1);
  }));
  await t.test('110 other creators, tenants, forged staff/identity and non-admin staff cannot act or inspect receipts',async()=>rollback(db,async()=>{
    const x=await seed(db);const offered=await creatorCommand(db,x.clinic,'create',x.terms);
    await db.query('set local role service_role');
    assert.deepEqual(await list(db,{actor:x.other}),{items:[],hasMore:false});
    assert.deepEqual(await list(db,{actor:x.owner,workspace:x.otherW,staff:x.otherStaff}),{items:[],hasMore:false});
    for(const who of [{actor:x.other},{actor:x.owner,workspace:x.otherW,staff:x.otherStaff},{actor:x.actor,workspace:x.w,staff:x.staff},
      {actor:x.owner,workspace:x.w},{actor:null}])await denied(db,()=>creatorCommand(db,who,'accept',{termsRevision:offered.job.termsRevision},offered.job),'P1101');
    await db.query('reset role');await db.query("update public.staff_users set role='doctor' where id=$1",[x.staff]);await db.query('set local role service_role');
    await denied(db,()=>list(db,x.clinic),'P1101');
  }));
  await t.test('110 approval revocation and staff revocation also deny old command replays and command reads',async()=>rollback(db,async()=>{
    const x=await seed(db),offered=await creatorCommand(db,x.clinic,'create',x.terms),key=randomUUID();
    await creatorCommand(db,x.creator,'accept',{termsRevision:offered.job.termsRevision},offered.job,key);
    await db.query("update public.growth_contributor_profiles set creator_status='suspended' where id=$1",[x.profile]);
    await db.query('set local role service_role');await denied(db,()=>list(db,x.creator),'P1101');
    await denied(db,()=>creatorCommand(db,x.creator,'accept',{termsRevision:offered.job.termsRevision},offered.job,key),'P1101');
    await denied(db,()=>db.query('select public.read_growth_creator_command($1,null,null,$2)',[x.actor,key]),'P1101');
    await db.query('reset role');await db.query("update public.staff_users set status='inactive' where id=$1",[x.staff]);await db.query('set local role service_role');
    await denied(db,()=>creatorCommand(db,x.clinic,'create',x.terms,null,offered.requestId),'P1101');
  }));
  await t.test('110 strict payloads reject missing/null terms, unsafe links, invented financial fields and bad dates without writes',async()=>rollback(db,async()=>{
    const x=await seed(db);await db.query('set local role service_role');
    for(const payload of [{...x.terms,rightsTerms:null},{...x.terms,paid:true},{...x.terms,feeMinor:123},{...x.terms,feeMinor:'0'},
      {...x.terms,feeMinor:'9223372036854775808'},{...x.terms,dueAt:'2030-02-30T08:00:00.000Z'}])await denied(db,()=>creatorCommand(db,x.clinic,'create',payload),'P1102');
    const offered=await creatorCommand(db,x.clinic,'create',x.terms);
    for(const termsRevision of [null,randomUUID()])await denied(db,()=>creatorCommand(db,x.creator,'accept',{termsRevision},offered.job),'P1104');
    const accepted=await creatorCommand(db,x.creator,'accept',{termsRevision:offered.job.termsRevision},offered.job);
    for(const link of ['javascript:alert(1)','https://user:pass@example.com/a','https://127.0.0.1/a','https://example.local/a','https://example.com:443/a','https://example.com/a\\b'])
      await denied(db,()=>creatorCommand(db,x.creator,'submit',{links:[link],note:''},accepted.job),'P1102');
    await denied(db,()=>creatorCommand(db,x.creator,'submit',{links:['https://example.com/a','https://example.com/a'],note:''},accepted.job),'P1102');
    await db.query('reset role');assert.equal((await row(db,'select count(*)::int n from public.growth_creator_submissions')).n,0);
    assert.equal((await row(db,'select count(*)::int n from public.growth_creator_events')).n,2);
  }));
  await t.test('110 each side is limited to its transitions; stale revisions and post-accept cancellation cannot overwrite work',async()=>rollback(db,async()=>{
    const x=await seed(db);await db.query('set local role service_role');const offered=await creatorCommand(db,x.clinic,'create',x.terms);
    await denied(db,()=>creatorCommand(db,x.clinic,'accept',{termsRevision:offered.job.termsRevision},offered.job),'P1104');
    const accepted=await creatorCommand(db,x.creator,'accept',{termsRevision:offered.job.termsRevision},offered.job);
    await denied(db,()=>creatorCommand(db,x.clinic,'cancel',{},accepted.job),'P1104');
    await denied(db,()=>creatorCommand(db,x.creator,'submit',{links:['https://example.com/a'],note:''},offered.job),'P1104');
    await denied(db,()=>creatorCommand(db,x.creator,'approve',{},accepted.job),'P1104');
    const submitted=await creatorCommand(db,x.creator,'submit',{links:['https://example.com/a'],note:''},accepted.job);
    const changes=await creatorCommand(db,x.clinic,'request_changes',{feedback:'QA feedback'},submitted.job);
    await denied(db,()=>creatorCommand(db,x.clinic,'approve',{},submitted.job),'P1104');
    assert.equal((await list(db,x.creator)).items[0].revision,changes.job.revision);
  }));
  await t.test('110 cancelling an offer and declining another are final, not refunded/paid or silently reopened',async()=>rollback(db,async()=>{
    const x=await seed(db);await db.query('set local role service_role');const one=await creatorCommand(db,x.clinic,'create',x.terms),two=await creatorCommand(db,x.clinic,'create',x.terms);
    const cancelled=await creatorCommand(db,x.clinic,'cancel',{},one.job),declined=await creatorCommand(db,x.creator,'decline',{},two.job);
    assert.equal(cancelled.job.state,'cancelled');assert.equal(declined.job.state,'declined');
    await denied(db,()=>creatorCommand(db,x.creator,'accept',{termsRevision:one.job.termsRevision},cancelled.job),'P1104');
    await denied(db,()=>creatorCommand(db,x.clinic,'cancel',{},declined.job),'P1104');
  }));
  await t.test('110 bounded pagination is complete and does not change records; stronger snapshots are refused',async()=>rollback(db,async()=>{
    const x=await seed(db);for(let n=0;n<22;n++)await creatorCommand(db,x.clinic,'create',{...x.terms,title:'QA '+n});
    const before=await snapshot(db);await db.query('set local role service_role');const a=await list(db,x.creator),b=await list(db,x.creator,20);
    assert.equal(a.items.length,20);assert.equal(a.hasMore,true);assert.equal(b.items.length,2);assert.equal(b.hasMore,false);
    assert.equal(new Set([...a.items,...b.items].map(j=>j.id)).size,22);
    await denied(db,()=>list(db,x.creator,-1),'P1102');await db.query('reset role');assert.equal(await snapshot(db),before);
  }));
  for(const isolation of ['repeatable read','serializable'])await t.test('110 refuses '+isolation+' authorization snapshots',async()=>{
    await db.query('begin isolation level '+isolation);try{await assert.rejects(list(db,{actor:randomUUID()}),e=>e.code==='P1101');}finally{await db.query('rollback');}
  });
  await t.test('110 rerun preserves existing workflow and every role has only the three narrow entry RPCs',async()=>rollback(db,async()=>{
    const x=await seed(db);await creatorCommand(db,x.clinic,'create',x.terms);const before=await snapshot(db);
    // The migration owns its transaction, so this rerun is checked separately below.
    for(const role of ['anon','authenticated','service_role']){
      for(const table of tables)assert.equal((await row(db,"select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') v",[role,'public.'+table])).v,false);
      assert.equal((await row(db,"select has_function_privilege($1,'public.creator_job_dto(uuid)','EXECUTE') v",[role])).v,false);
      assert.equal((await row(db,"select has_function_privilege($1,'public.execute_growth_creator_job(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb)','EXECUTE') v",[role])).v,role==='service_role');
    }
    assert.equal(await snapshot(db),before);
  }));
  const x=await seed(db),made=await creatorCommand(db,x.clinic,'create',x.terms);const before=await snapshot(db);
  try{await db.query(source);assert.equal(await snapshot(db),before);assert.equal(made.job.state,'offered');}finally{await cleanup(db,x);}

  for(const kind of ['profile','binding','staff','staff-scope','duplicate','receipt','accept-cancel','review'])await t.test('110 native concurrent '+kind+' observes the committed winner without duplicate side effects',async()=>{
    const x=await seed(db),lock=await fixture.connect(),worker=await fixture.connect();
    let work;
    try{
      const blocker=(await row(lock,'select pg_backend_pid() pid')).pid,waiter=(await row(worker,'select pg_backend_pid() pid')).pid;
      await worker.query('set role service_role');
      if(!['profile','binding','staff','staff-scope'].includes(kind))await lock.query('set role service_role');
      if(kind==='profile'||kind==='binding'){
        const offered=await creatorCommand(db,x.clinic,'create',x.terms);
        await lock.query('begin');await lock.query(kind==='profile'?"update public.growth_contributor_profiles set creator_status='suspended' where id=$1":
          "update public.growth_contributor_profiles set auth_user_id=gen_random_uuid() where id=$1",[x.profile]);
        work=observed(creatorCommand(worker,x.creator,'accept',{termsRevision:offered.job.termsRevision},offered.job));
        await blocked(db,waiter,blocker);await lock.query('commit');assert.equal((await work).error?.code,'P1101');
        assert.equal((await list(db,x.clinic)).items[0].state,'offered');
      }else if(kind==='staff'||kind==='staff-scope'){
        const submitted=await prepare(db,x);await lock.query('begin');await lock.query(kind==='staff'?"update public.staff_users set status='inactive' where id=$1":
          "update public.staff_users set workspace_id=$2 where id=$1",kind==='staff'?[x.staff]:[x.staff,x.otherW]);
        work=observed(creatorCommand(worker,x.clinic,'approve',{},submitted.job));await blocked(db,waiter,blocker);await lock.query('commit');assert.equal((await work).error?.code,'P1101');
        assert.equal((await list(db,x.creator)).items[0].state,'submitted');
      }else if(kind==='duplicate'||kind==='receipt'){
        const key=randomUUID();await lock.query('begin');const first=await creatorCommand(lock,x.clinic,'create',x.terms,null,key);
        work=observed(kind==='duplicate'?creatorCommand(worker,x.clinic,'create',x.terms,null,key):
          row(worker,'select public.read_growth_creator_command($1,$2,$3,$4) v',[x.owner,x.w,x.staff,key]).then(v=>v.v));
        await blocked(db,waiter,blocker);await lock.query('commit');const result=await work;assert.equal(result.error,undefined);assert.ok(parseCreatorJobReceipt(result.value));
        assert.equal(result.value.job.id,first.job.id);assert.equal(result.value.replayed,true);assert.equal((await list(db,x.clinic)).items.length,1);
      }else if(kind==='accept-cancel'){
        const offered=await creatorCommand(db,x.clinic,'create',x.terms);await lock.query('begin');
        await creatorCommand(lock,x.creator,'accept',{termsRevision:offered.job.termsRevision},offered.job);
        work=observed(creatorCommand(worker,x.clinic,'cancel',{},offered.job));await blocked(db,waiter,blocker);await lock.query('commit');assert.equal((await work).error?.code,'P1104');
        assert.equal((await list(db,x.creator)).items[0].state,'in_progress');
      }else{
        const submitted=await prepare(db,x);await lock.query('begin');await creatorCommand(lock,x.clinic,'request_changes',{feedback:'QA winner'},submitted.job);
        work=observed(creatorCommand(worker,x.clinic,'approve',{},submitted.job));await blocked(db,waiter,blocker);await lock.query('commit');assert.equal((await work).error?.code,'P1104');
        assert.equal((await list(db,x.creator)).items[0].state,'changes_requested');
      }
    }finally{await lock.query('rollback');if(work)await work;await worker.query('rollback');await lock.end();await worker.end();await cleanup(db,x);}
  });
}

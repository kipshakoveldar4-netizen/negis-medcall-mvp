import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {seedCreatorJobFixture,cleanupCreatorJobFixture,creatorCommand} from './creator-job-cases.mjs';
const {parseCreatorCommandResult,parseCreatorDirectory,parseCreatorJobDetail}=await import(new URL('../../lib/crm/creator-job-contracts.ts',import.meta.url).href);
const row=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const observed=p=>p.then(value=>({value}),error=>({error}));
async function rollback(db,action){await db.query('begin');try{return await action();}finally{await db.query('rollback');}}
async function denied(db,action,code){await db.query('savepoint creator_closure_denial');try{await assert.rejects(action,e=>e.code===code);}finally{await db.query('rollback to savepoint creator_closure_denial;release savepoint creator_closure_denial');}}
const whoArgs=who=>[who.actor,who.workspace??null,who.staff??null];
const identity=(key,action,target)=>({requestId:key,action,targetId:target});
async function execute(db,who,action,payload={},job=null,key=randomUUID()){
  const value=(await row(db,'select public.execute_growth_creator_job_v2($1,$2,$3,$4,$5,$6,$7,$8) v',
    [...whoArgs(who),key,job?.id??null,job?.revision??null,action,payload])).v;
  assert.ok(parseCreatorCommandResult(value,identity(key,action,action==='create'?payload.creatorId:job.id)),JSON.stringify(value));return value;
}
async function read(db,who,key){const v=(await row(db,'select public.read_growth_creator_command_v2($1,$2,$3,$4) v',[...whoArgs(who),key])).v;assert.ok(parseCreatorCommandResult(v));return v;}
async function close(db,who,key,action,target){const v=(await row(db,'select public.close_growth_creator_command_v2($1,$2,$3,$4,$5,$6) v',[...whoArgs(who),key,action,target])).v;assert.ok(parseCreatorCommandResult(v,identity(key,action,target)));return v;}
async function directory(db,who,offset=0){const v=(await row(db,'select public.read_growth_creator_directory($1,$2,$3,$4) v',[...whoArgs(who),offset])).v;assert.ok(parseCreatorDirectory(v));return v;}
async function detail(db,who,job,offset=0){const v=(await row(db,'select public.read_growth_creator_job_detail($1,$2,$3,$4,$5) v',[...whoArgs(who),job.id,offset])).v;assert.ok(parseCreatorJobDetail(v),JSON.stringify(v));return v;}
async function cleanup(db,x){await db.query('delete from public.growth_creator_command_fences where actor_auth_user_id=any($1)',[[x.actor,x.owner,x.other]]);await cleanupCreatorJobFixture(db,x);}
async function blocked(db,waiter,blocker){for(let n=0;n<180;n++){if((await row(db,'select $1::int=any(pg_blocking_pids($2::int)) yes',[blocker,waiter])).yes)return;await new Promise(r=>setTimeout(r,10));}assert.fail('Expected the owned creator command/authority lock wait');}
async function submit(db,x){const offered=await execute(db,x.clinic,'create',x.terms),accepted=await execute(db,x.creator,'accept',{termsRevision:offered.result.job.termsRevision},offered.result.job);
  return execute(db,x.creator,'submit',{links:['https://example.com/v1.mp4'],note:'QA version'},accepted.result.job);}

export async function exerciseCreatorClosureRefusals(db,source,t){
  for(const[name,change,message]of[
    ['writer body',"alter function public.execute_growth_creator_job(uuid,uuid,uuid,uuid,uuid,uuid,text,jsonb) stable",'creator_closure_dependencies_unconfirmed'],
    ['reader RLS',"alter table public.growth_creator_jobs disable row level security",'creator_closure_dependencies_unconfirmed'],
    ['browser inheritance',"grant service_role to authenticated",'creator_closure_dependencies_unconfirmed'],
    ['inherited fence read',"create role creator_closure_untrusted;grant creator_closure_untrusted to anon;alter default privileges grant select on tables to creator_closure_untrusted",'creator_closure_access_unconfirmed'],
    ['inherited executor',"create role creator_closure_untrusted;grant creator_closure_untrusted to anon;create function public.read_growth_creator_command_v2(uuid,uuid,uuid,uuid) returns jsonb language sql as $$select '{}'::jsonb$$;grant execute on function public.read_growth_creator_command_v2(uuid,uuid,uuid,uuid) to creator_closure_untrusted",'creator_closure_executor_unconfirmed'],
  ])await t.test('111 refuses '+name+' atomically',async()=>{
    await db.query('begin');try{await db.query(change);await assert.rejects(db.query(source),e=>e.message===message);}finally{await db.query('rollback');}
    assert.equal((await row(db,"select to_regclass('public.growth_creator_command_fences') v")).v,null);
  });
}

export async function exerciseCreatorClosure(db,fixture,source,t){
  await t.test('111 close an unknown original key, then reject its delayed create without a business write',async()=>rollback(db,async()=>{
    const x=await seedCreatorJobFixture(db),key=randomUUID();await db.query('set local role service_role');
    assert.deepEqual(await read(db,x.clinic,key),{state:'unconfirmed',requestId:key});
    const stopped=await close(db,x.clinic,key,'create',x.profile);assert.equal(stopped.state,'abandoned');
    assert.deepEqual(await close(db,x.clinic,key,'create',x.profile),stopped);
    assert.deepEqual(await execute(db,x.clinic,'create',x.terms,null,key),stopped);
    await denied(db,()=>close(db,x.clinic,key,'create',x.otherProfile),'P1113');
    await db.query('reset role');for(const table of ['growth_creator_jobs','growth_creator_commands','growth_creator_submissions','growth_creator_events'])
      assert.equal((await row(db,'select count(*)::int n from public.'+table)).n,0);
  }));
  await t.test('111 closing a committed action returns its real current result and never cancels or rewrites it',async()=>rollback(db,async()=>{
    const x=await seedCreatorJobFixture(db),key=randomUUID();await db.query('set local role service_role');
    const made=await execute(db,x.clinic,'create',x.terms,null,key);
    const accepted=await execute(db,x.creator,'accept',{termsRevision:made.result.job.termsRevision},made.result.job);
    const result=await close(db,x.clinic,key,'create',x.profile);assert.equal(result.state,'committed');
    assert.equal(result.result.job.revision,accepted.result.job.revision);assert.equal(result.result.appliedRevision,made.result.appliedRevision);
    await denied(db,()=>execute(db,x.clinic,'create',{...x.terms,feeMinor:'1'},null,key),'P1103');
    await db.query('reset role');assert.equal((await row(db,'select count(*)::int n from public.growth_creator_command_fences')).n,0);
  }));
  await t.test('111 legacy committed receipts remain readable, but direct service v1 readers/writers and helpers stay closed',async()=>rollback(db,async()=>{
    const x=await seedCreatorJobFixture(db),key=randomUUID();
    const historic=await creatorCommand(db,x.clinic,'create',x.terms,null,key); // Privileged fixture setup of an actual historical 110 receipt.
    await db.query('set local role service_role');const result=await read(db,x.clinic,key);assert.equal(result.state,'committed');assert.equal(result.result.job.id,historic.job.id);
    for(const sql of ['select public.execute_growth_creator_job($1,$2,$3,$4,null,null,\'create\',$5)',
      'select public.read_growth_creator_command($1,$2,$3,$4)'])
      await denied(db,()=>db.query(sql,sql.includes('execute_')?[x.owner,x.w,x.staff,randomUUID(),x.terms]:[x.owner,x.w,x.staff,key]),'42501');
    await denied(db,()=>db.query('select public.creator_command_result_v2($1,$2,$3,$4,null,null)',[x.owner,x.w,x.staff,key]),'42501');
  }));
  await t.test('111 fenced keys are scoped to actor, original staff/workspace and exact action/target',async()=>rollback(db,async()=>{
    const x=await seedCreatorJobFixture(db),key=randomUUID();await db.query('set local role service_role');
    await close(db,x.clinic,key,'create',x.profile);
    await denied(db,()=>read(db,{actor:x.owner,workspace:x.otherW,staff:x.otherStaff},key),'P1111');
    await denied(db,()=>close(db,x.clinic,key,'cancel',randomUUID()),'P1113');
    assert.deepEqual(await read(db,x.creator,key),{state:'unconfirmed',requestId:key},'Another actor cannot see the company key');
    await db.query('reset role');await db.query("update public.staff_users set status='inactive' where id=$1",[x.staff]);await db.query('set local role service_role');
    await denied(db,()=>read(db,x.clinic,key),'P1101');await denied(db,()=>close(db,x.clinic,key,'create',x.profile),'P1101');
  }));
  await t.test('111 a corrupted mixed commit/fence is unknown, never falsely abandoned',async()=>rollback(db,async()=>{
    const x=await seedCreatorJobFixture(db),key=randomUUID();await execute(db,x.clinic,'create',x.terms,null,key);
    await db.query("insert into public.growth_creator_command_fences(actor_auth_user_id,request_key,workspace_id,actor_staff_user_id,action,target_id) values($1,$2,$3,$4,'create',$5)",[x.owner,key,x.w,x.staff,x.profile]);
    await db.query('set local role service_role');await denied(db,()=>read(db,x.clinic,key),'P1112');
  }));
  await t.test('111 rerun refuses an already mixed committed/fenced key without changing its existing records',async()=>{
    const x=await seedCreatorJobFixture(db),key=randomUUID();
    try{
      await execute(db,x.clinic,'create',x.terms,null,key);
      await db.query("insert into public.growth_creator_command_fences(actor_auth_user_id,request_key,workspace_id,actor_staff_user_id,action,target_id) values($1,$2,$3,$4,'create',$5)",[x.owner,key,x.w,x.staff,x.profile]);
      await assert.rejects(db.query(source),e=>e.message==='creator_closure_state_unconfirmed');await db.query('rollback');
      assert.equal((await row(db,'select count(*)::int n from public.growth_creator_command_fences where actor_auth_user_id=$1 and request_key=$2',[x.owner,key])).n,1);
      assert.equal((await row(db,'select count(*)::int n from public.growth_creator_commands where actor_id=$1 and request_key=$2',[x.owner,key])).n,1);
    }finally{await db.query('rollback');await cleanup(db,x);}
  });
  await t.test('111 directory lists only approved creators and exposes no Auth, review or company fields',async()=>rollback(db,async()=>{
    const x=await seedCreatorJobFixture(db),pending=randomUUID();await db.query("select public.apply_growth_contributor($1,'QA pending',true,true,'{}')",[pending]);
    await db.query('set local role service_role');const page=await directory(db,x.clinic);
    assert.equal(page.items.length,2);assert.deepEqual(Object.keys(page.items[0]),['id','displayName','portfolioUrls']);
    assert.ok(page.items.every(p=>p.displayName!=='QA pending'));await denied(db,()=>directory(db,x.creator),'P1111');
    await denied(db,()=>directory(db,{actor:randomUUID(),workspace:x.w,staff:x.staff}),'P1101');
  }));
  await t.test('111 detail returns the assigned company and exact contiguous submission history without other creators/tenants',async()=>rollback(db,async()=>{
    const x=await seedCreatorJobFixture(db);await db.query("update public.workspaces set name='PRIVATE OTHER COMPANY' where id=$1",[x.otherW]);
    await db.query('set local role service_role');let current=await submit(db,x);
    for(let n=2;n<=22;n++){current=await execute(db,x.clinic,'request_changes',{feedback:'QA changes '+n},current.result.job);
      current=await execute(db,x.creator,'submit',{links:['https://example.com/v'+n+'.mp4'],note:'QA version '+n},current.result.job);}
    const first=await detail(db,x.creator,current.result.job),last=await detail(db,x.clinic,current.result.job,20);
    assert.equal(first.companyName,'QA creator workspace');assert.equal(first.history.items.length,20);assert.equal(first.history.hasMore,true);
    assert.equal(first.history.items[0].sequence,22);assert.deepEqual(last.history.items.map(s=>s.sequence),[2,1]);assert.equal(last.history.hasMore,false);
    assert.doesNotMatch(JSON.stringify(first),/PRIVATE OTHER COMPANY|auth_user_id|workspace_id|submitted_by|created_by/);
    await denied(db,()=>detail(db,{actor:x.other},current.result.job),'P1111');
    await denied(db,()=>detail(db,{actor:x.owner,workspace:x.otherW,staff:x.otherStaff},current.result.job),'P1111');
  }));
  await t.test('111 missing history and malformed company context refuse a partial/false report',async()=>rollback(db,async()=>{
    const x=await seedCreatorJobFixture(db),made=await submit(db,x);await db.query('delete from public.growth_creator_submissions where job_id=$1',[made.result.job.id]);
    await db.query('set local role service_role');await denied(db,()=>detail(db,x.creator,made.result.job),'P1112');
    await db.query('reset role');await db.query("update public.workspaces set name=' ' where id=$1",[x.w]);await db.query('set local role service_role');
    await denied(db,()=>detail(db,x.creator,made.result.job),'P1112');await denied(db,()=>directory(db,x.clinic,-1),'P1102');
  }));
  for(const kind of ['execute-first','close-first','read-wait','revoke-close','directory-revoke','detail-rebind'])await t.test('111 native '+kind+' waits for the committed winner',async()=>{
    const x=await seedCreatorJobFixture(db),lock=await fixture.connect(),worker=await fixture.connect(),key=randomUUID();let work;
    try{
      const blocker=(await row(lock,'select pg_backend_pid() p')).p,waiter=(await row(worker,'select pg_backend_pid() p')).p;
      await worker.query('set role service_role');await lock.query('begin');
      if(kind==='execute-first'||kind==='read-wait'){
        await lock.query('set local role service_role');const made=await execute(lock,x.clinic,'create',x.terms,null,key);
        work=observed(kind==='execute-first'?close(worker,x.clinic,key,'create',x.profile):read(worker,x.clinic,key));
        await blocked(db,waiter,blocker);await lock.query('commit');const result=await work;assert.equal(result.error,undefined);assert.equal(result.value.state,'committed');assert.equal(result.value.result.job.id,made.result.job.id);
      }else if(kind==='close-first'){
        await lock.query('set local role service_role');await close(lock,x.clinic,key,'create',x.profile);
        work=observed(execute(worker,x.clinic,'create',x.terms,null,key));await blocked(db,waiter,blocker);await lock.query('commit');
        assert.equal((await work).value?.state,'abandoned');assert.equal((await row(db,'select count(*)::int n from public.growth_creator_jobs where workspace_id=$1',[x.w])).n,0);
      }else if(kind==='detail-rebind'){
        const made=await execute(db,x.clinic,'create',x.terms);
        await lock.query('update public.growth_contributor_profiles set auth_user_id=gen_random_uuid() where id=$1',[x.profile]);
        work=observed(detail(worker,x.creator,made.result.job));await blocked(db,waiter,blocker);await lock.query('commit');assert.equal((await work).error?.code,'P1101');
      }else{
        await lock.query("update public.staff_users set status='inactive' where id=$1",[x.staff]);
        work=observed(kind==='revoke-close'?close(worker,x.clinic,key,'create',x.profile):directory(worker,x.clinic));
        await blocked(db,waiter,blocker);await lock.query('commit');assert.equal((await work).error?.code,'P1101');
      }
    }finally{await lock.query('rollback');if(work)await work;await worker.query('rollback');await lock.end();await worker.end();await cleanup(db,x);}
  });
  const x=await seedCreatorJobFixture(db);try{await close(db,x.clinic,randomUUID(),'create',x.profile);await db.query(source);
    assert.equal((await row(db,'select count(*)::int n from public.growth_creator_command_fences where actor_auth_user_id=$1',[x.owner])).n,1);
  }finally{await cleanup(db,x);}
}

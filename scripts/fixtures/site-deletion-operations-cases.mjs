import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';

const one=async(db,sql,args=[]) => (await db.query(sql,args)).rows[0];
const signatures={prepare:'prepare_site_deletion_operation',read:'read_site_deletion_operations',
  execute:'execute_site_deletion_operation',close:'close_site_deletion_operation'};
export async function seedDeletionOperation(db) {
  const workspace=randomUUID(),otherWorkspace=randomUUID(),actor=randomUUID(),otherActor=randomUUID(),staff=randomUUID(),otherStaff=randomUUID();
  const site=randomUUID(),siteKey='synthetic-'+randomUUID();
  await db.query("insert into public.workspaces(id,name) values($1,'SYNTHETIC deletion A'),($2,'SYNTHETIC deletion B')",[workspace,otherWorkspace]);
  await db.query("insert into public.staff_users(id,workspace_id,auth_user_id,full_name,email,role) values($1::uuid,$2,$3,'SYNTHETIC A',($1::uuid)::text||'@fixture.invalid','owner'),($4::uuid,$2,$5,'SYNTHETIC B',($4::uuid)::text||'@fixture.invalid','admin')",
    [staff,workspace,actor,otherStaff,otherActor]);
  await db.query(`insert into public.crm_intake_sites(id,site_key,workspace_id,consent_version,allowed_page_paths,enabled,manual_deletion_enabled)
    values($1,$2,$3,'synthetic-v1',array['/ru/'],true,true)`,[site,siteKey,workspace]);
  const notice={version:'synthetic-v1',text:'SYNTHETIC NOT LEGAL',purpose:'SYNTHETIC TEST',policyRevision:'SYNTHETIC',policyUrl:'https://fixture.invalid/synthetic-policy'};
  notice.sha256=createHash('sha256').update(JSON.stringify(Object.values(notice))).digest('hex');
  const inquiry={name:'SYNTHETIC ONLY',phone:'+77070000001',business:'SYNTHETIC ONLY',service:'call-center',pagePath:'/ru/',consentVersion:notice.version,consent:true};
  for(let i=0;i<2;i++) await db.query('select public.accept_crm_site_inquiry_with_consent($1,$2,$3::jsonb,$4::jsonb)',[siteKey,randomUUID(),JSON.stringify(inquiry),JSON.stringify(notice)]);
  const lead=(await one(db,"select l.id,to_char(l.updated_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as version from public.leads l where l.workspace_id=$1",[workspace]));
  const receipts=(await db.query('select id from public.crm_site_inquiries where site_id=$1 order by id',[site])).rows.map(x=>x.id);
  const request={leadId:lead.id,leadUpdatedAt:lead.version,receiptIds:receipts,requestKey:randomUUID(),confirmed:true};
  return {workspace,otherWorkspace,actor,otherActor,staff,otherStaff,site,siteKey,request};
}

export async function deletionOperation(db,which,f,extra) {
  const args=[f.workspace,f.siteKey,f.staff,f.actor];
  if(which==='read') args.push(extra??null);
  else if(which==='close') args.push(extra.key??f.request.requestKey,extra.action);
  else args.push(JSON.stringify(extra??f.request));
  await db.query('set role service_role');let failure;
  try {return (await one(db,`select public.${signatures[which]}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args)).result;}
  catch(error) {failure=error;throw error;}
  finally {try {await db.query('reset role');}catch(error) {if(!failure||error.code!=='25P02')throw error;}}
}
async function refused(db,action,message) {
  await db.query('savepoint owned_operation_refusal');
  try {await assert.rejects(action,error=>error.message===message);} finally {await db.query('rollback to savepoint owned_operation_refusal');}
}
const counts=async(db,f)=>one(db,`select
  (select count(*)::int from public.leads where workspace_id=$1) as leads,
  (select count(*)::int from public.crm_site_inquiries where site_id=$2) as inquiries,
  (select count(*)::int from public.crm_site_consent_receipts where workspace_id=$1) as consents,
  (select count(*)::int from public.crm_site_inquiry_erased_requests where site_id=$2) as tombstones,
  (select count(*)::int from public.crm_site_inquiry_deletions where workspace_id=$1) as deletions,
  (select count(*)::int from public.site_deletion_operations where workspace_id=$1) as operations`,[f.workspace,f.site]);

export async function exerciseDeletionOperations(db,t) {
  const scenario=async(name,action)=>{let passed=false;await t.test(name,async()=>{
    await db.query('begin');try {await action(await seedDeletionOperation(db));passed=true;}finally {await db.query('rollback');}
  });assert.ok(passed,'Stop after failed deletion-operation scenario: '+name);};
  await scenario('101 preparation is durable intent only; a new reader recovers the exact request without deletion',async f=>{
    const before=await counts(db,f),prepared=await deletionOperation(db,'prepare',f);
    assert.equal(prepared.state,'prepared');assert.equal(prepared.replayed,false);assert.deepEqual(prepared.request,f.request);
    assert.equal(prepared.actorId,f.actor);assert.equal(prepared.workspaceId,f.workspace);
    assert.deepEqual(await counts(db,f),{...before,operations:1});
    const read=await deletionOperation(db,'read',f);assert.equal(read.complete,true);assert.equal(read.operations.length,1);assert.deepEqual(read.operations[0].request,f.request);
    const again=await deletionOperation(db,'prepare',f);assert.equal(again.replayed,true);assert.equal(again.createdAt,prepared.createdAt);
    assert.deepEqual(await counts(db,f),{...before,operations:1});
  });
  await scenario('101 execute commits erasure and operation receipt atomically; lost-ACK read and replay delete nothing again',async f=>{
    await deletionOperation(db,'prepare',f);const done=await deletionOperation(db,'execute',f);
    assert.equal(done.state,'committed');assert.equal(done.receiptsDeleted,2);assert.equal(done.replayed,false);
    assert.deepEqual(await counts(db,f),{leads:0,inquiries:0,consents:0,tombstones:2,deletions:1,operations:1});
    const recovered=(await deletionOperation(db,'read',f)).operations[0];assert.equal(recovered.state,'committed');assert.equal(recovered.completedAt,done.completedAt);
    const replay=await deletionOperation(db,'execute',f);assert.equal(replay.replayed,true);assert.equal(replay.completedAt,done.completedAt);
    assert.deepEqual(await counts(db,f),{leads:0,inquiries:0,consents:0,tombstones:2,deletions:1,operations:1});
  });
  await scenario('101 execution without preparation refuses; malformed/extra/private fields never enter the ledger',async f=>{
    await refused(db,()=>deletionOperation(db,'execute',f),'deletion_operation_not_prepared');
    for(const request of [null,{}, {...f.request,confirmed:false},{...f.request,phone:'PRIVATE NOT ALLOWED'},
      {...f.request,receiptIds:[]},{...f.request,receiptIds:[...f.request.receiptIds,f.request.receiptIds[0].toUpperCase()]},
      {...f.request,leadUpdatedAt:'infinity'},{...f.request,leadUpdatedAt:'2026-99-99T00:00:00Z'},
      {...f.request,receiptIds:Array(201).fill(randomUUID())},{...f.request,requestKey:4}]) {
      await refused(db,()=>deletionOperation(db,'prepare',f,request===null?'null':request),'invalid_deletion_request');
    }
    assert.equal((await counts(db,f)).operations,0);assert.equal((await counts(db,f)).leads,1);
  });
  await scenario('101 original actor/staff/site/workspace is mandatory; another administrator cannot read or execute the request',async f=>{
    await deletionOperation(db,'prepare',f);const other={...f,actor:f.otherActor,staff:f.otherStaff};
    assert.deepEqual((await deletionOperation(db,'read',other)).operations,[]);
    await refused(db,()=>deletionOperation(db,'execute',other),'deletion_request_conflict');
    await refused(db,()=>deletionOperation(db,'prepare',other),'deletion_request_conflict');
    await refused(db,()=>deletionOperation(db,'close',other,{action:'abandon'}),'workspace_access_denied');
    await refused(db,()=>deletionOperation(db,'read',{...f,workspace:f.otherWorkspace}),'workspace_access_denied');
    assert.equal((await counts(db,f)).leads,1);
  });
  await scenario('101 immutable prepared payload is checked before the existing erasure executor',async f=>{
    await deletionOperation(db,'prepare',f);
    for(const changed of [{...f.request,receiptIds:f.request.receiptIds.slice(0,1)},
      {...f.request,leadUpdatedAt:'2026-01-01T00:00:00Z'},{...f.request,leadId:randomUUID()}]) {
      await refused(db,()=>deletionOperation(db,'execute',f,changed),'deletion_request_conflict');
      await refused(db,()=>deletionOperation(db,'prepare',f,changed),'deletion_request_conflict');
    }
    assert.deepEqual((await deletionOperation(db,'read',f)).operations[0].request,f.request);
  });
  await scenario('101 changed lead version refuses atomically; the unresolved operation is not silently abandoned',async f=>{
    await deletionOperation(db,'prepare',f);await db.query('update public.leads set updated_at=updated_at+interval \'1 microsecond\' where id=$1',[f.request.leadId]);
    await refused(db,()=>deletionOperation(db,'execute',f),'deletion_scope_changed');
    assert.equal((await deletionOperation(db,'read',f)).operations[0].state,'prepared');assert.equal((await counts(db,f)).tombstones,0);
  });
  await scenario('101 live revocation/rebinding and site disabling are checked, without deleting unknown intent',async f=>{
    await deletionOperation(db,'prepare',f);await db.query("update public.staff_users set status='inactive' where id=$1",[f.staff]);
    for(const which of ['read','execute']) await refused(db,()=>deletionOperation(db,which,f),'workspace_access_denied');
    await db.query("update public.staff_users set status='active',auth_user_id=$2 where id=$1",[f.staff,randomUUID()]);
    await refused(db,()=>deletionOperation(db,'read',f),'workspace_access_denied');
    await db.query('update public.staff_users set auth_user_id=$2 where id=$1',[f.staff,f.actor]);
    await db.query('update public.crm_intake_sites set manual_deletion_enabled=false where id=$1',[f.site]);
    const read=await deletionOperation(db,'read',f);assert.equal(read.deletionEnabled,false);assert.equal(read.operations[0].state,'prepared');
    await refused(db,()=>deletionOperation(db,'execute',f),'site_deletion_disabled');
    assert.equal((await counts(db,f)).leads,1);
  });
  await scenario('101 explicit abandonment fences later execution; acknowledgement never abandons a prepared request',async f=>{
    await deletionOperation(db,'prepare',f);
    await refused(db,()=>deletionOperation(db,'close',f,{action:'acknowledge'}),'deletion_operation_pending');
    const closed=await deletionOperation(db,'close',f,{action:'abandon'});assert.equal(closed.state,'abandoned');
    await refused(db,()=>deletionOperation(db,'execute',f),'deletion_operation_abandoned');
    const ack=await deletionOperation(db,'close',f,{action:'acknowledge'});assert.ok(ack.acknowledgedAt);
    assert.deepEqual((await deletionOperation(db,'read',f)).operations,[]);
    assert.equal((await deletionOperation(db,'read',f,f.request.requestKey)).operations[0].state,'abandoned');
    assert.equal((await counts(db,f)).leads,1);
  });
  await scenario('101 abandon after commit truthfully returns committed; acknowledgements are explicit and idempotent',async f=>{
    await deletionOperation(db,'prepare',f);await deletionOperation(db,'execute',f);
    assert.equal((await deletionOperation(db,'close',f,{action:'abandon'})).state,'committed');
    assert.equal((await deletionOperation(db,'read',f)).operations.length,1);
    const ack=await deletionOperation(db,'close',f,{action:'acknowledge'});
    const replay=await deletionOperation(db,'close',f,{action:'acknowledge'});assert.equal(replay.replayed,true);assert.equal(replay.acknowledgedAt,ack.acknowledgedAt);
    assert.deepEqual((await deletionOperation(db,'read',f)).operations,[]);
  });
  await scenario('101 post-erasure receipt failure rolls back lead, consent, tombstones and both receipt tables',async f=>{
    await deletionOperation(db,'prepare',f);const before=await counts(db,f);
    await db.query(`create function public.owned_101_refusal() returns trigger language plpgsql as $$begin
      if new.state='committed' then raise exception 'owned_operation_commit_refused';end if;return new;end$$;
      create trigger owned_101_refusal before update on public.site_deletion_operations for each row execute function public.owned_101_refusal()`);
    await refused(db,()=>deletionOperation(db,'execute',f),'owned_operation_commit_refused');
    assert.deepEqual(await counts(db,f),before);assert.equal((await deletionOperation(db,'read',f)).operations[0].state,'prepared');
  });
  await scenario('101 bounded unresolved admission refuses item 65, but original replay still succeeds at capacity',async f=>{
    await deletionOperation(db,'prepare',f);
    for(let i=1;i<64;i++) await deletionOperation(db,'prepare',f,{...f.request,requestKey:randomUUID()});
    assert.equal((await deletionOperation(db,'read',f)).operations.length,64);
    await refused(db,()=>deletionOperation(db,'prepare',f,{...f.request,requestKey:randomUUID()}),'deletion_operation_capacity');
    assert.equal((await deletionOperation(db,'prepare',f)).replayed,true);
  });
  await scenario('101 full 10000-row journal refuses new admission, not existing replay or another workspace',async f=>{
    await deletionOperation(db,'prepare',f);
    // Owner-only disposable scaffold: valid already-acknowledged abandonment
    // receipts, not 9,999 simulated customer deletions or a service-role writer.
    await db.query(`with keys as materialized(select gen_random_uuid() as key from generate_series(1,9999))
      insert into public.site_deletion_operations(workspace_id,request_key,site_id,actor_staff_user_id,actor_auth_user_id,
        lead_id,request,state,completed_at,acknowledged_at)
      select $1,key,$2,$3,$4,$5,jsonb_set($6::jsonb,'{requestKey}',to_jsonb(key::text)),'abandoned',clock_timestamp(),clock_timestamp() from keys`,
      [f.workspace,f.site,f.staff,f.actor,f.request.leadId,JSON.stringify(f.request)]);
    assert.equal((await counts(db,f)).operations,10000);
    assert.equal((await deletionOperation(db,'read',f)).operations.length,1);
    await refused(db,()=>deletionOperation(db,'prepare',f,{...f.request,requestKey:randomUUID()}),'deletion_operation_capacity');
    assert.equal((await deletionOperation(db,'prepare',f)).replayed,true);
    const other=await seedDeletionOperation(db);assert.equal((await deletionOperation(db,'prepare',other)).state,'prepared');
  });
}

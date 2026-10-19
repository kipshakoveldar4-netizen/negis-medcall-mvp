import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startDisposablePostgres } from './disposable-postgres.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const observed=p=>p.then(value=>({value}),error=>({error}));
const read=async(c,p,lead=null)=>(await c.query('select public.read_mortgage_workspace($1,$2,$3,\'\',0,$4,null,null,30) as result',[p.w,p.id,p.auth,lead])).rows[0].result;
const save=async(c,p,payload,id=null,version=null,key=randomUUID())=>(await c.query(
  'select public.save_mortgage_activity($1,$2,$3,$4,$5,$6,$7::jsonb) as result',[p.w,p.id,p.auth,id,version,key,JSON.stringify(payload)])).rows[0].result;
const saveSelfLead=async(c,p,row={},id=null)=>(await c.query(
  'select public.save_mortgage_admin_self_lead($1,$2,$3,$4,$5::jsonb) as result',
  [p.w,p.id,p.auth,id,JSON.stringify({responsible_user_id:p.id,...row})])).rows[0].result;
const task=(lead,title='Synthetic task')=>({kind:'task',leadId:lead,title,notes:'Synthetic notes',status:'open',priority:'normal',startsAt:null,endsAt:null,dueAt:null});
const meeting=(lead,start='2027-01-10T10:00:00Z',end='2027-01-10T11:00:00Z')=>({...task(lead,'Synthetic meeting'),kind:'meeting',startsAt:start,endsAt:end});
async function denied(operation,code){ const r=await observed(operation); assert.equal(r.error?.code,code,r.error?.message||'RPC unexpectedly succeeded'); }
async function deniedInTransaction(db,operation,code){
  await db.query('savepoint expected_denial');
  try { await denied(operation(),code); }
  finally { await db.query('rollback to savepoint expected_denial');await db.query('release savepoint expected_denial'); }
}
async function waitForLock(db,waiter,holder){
  for(let i=0;i<200;i++){
    const blockers=(await db.query('select pg_blocking_pids($1) as blockers',[waiter])).rows[0].blockers;
    if(blockers.includes(holder)) return;
    await delay(15);
  }
  assert.fail('A real PostgreSQL lock wait on the expected holder must be observed');
}

test('expanded mortgage CRM on a fresh isolated PostgreSQL cluster',{timeout:300000},async t=>{
  const available=(await readdir(path.join(root,'migrations'))).filter(file=>/^\d{3}_.+\.sql$/.test(file)).sort();
  const upgrade=available.filter(file=>file.startsWith('077_'));
  assert.equal(upgrade.length,1,'Main-owned SQL077 must be available before this fixture can verify admin self meetings');
  const files=available.filter(file=>Number(file.slice(0,3))>=9&&Number(file.slice(0,3))<=75).concat(upgrade);
  const f=await startDisposablePostgres();
  try {
    const db=await f.connect();
    await db.query('create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to anon,authenticated,service_role;');
    // Historical media migrations expect this Supabase catalogue, not a service.
    await db.query('create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
    for(const file of files) {
      // Pin historical SQL; only the new 077 candidate comes from this worktree.
      const source=/^(059|065|070)_/.test(file)
        ? execFileSync('git',['show',`HEAD:migrations/${file}`],{cwd:root,encoding:'utf8',windowsHide:true})
        : await readFile(path.join(root,'migrations',file),'utf8');
      await db.query(source);
      if(file===upgrade[0]) await db.query(source);
    }
    t.diagnostic('Synthetic loopback PostgreSQL only; committed 059/065/070, working 077, no SQL076');
    const w=randomUUID(),foreign=randomUUID();
    for(const id of [w,foreign]) {
      await db.query('insert into public.workspaces(id,name) values($1,\'Synthetic mortgage\')',[id]);
      await db.query("insert into public.workspace_settings(workspace_id,key,value) values($1,'workspace_purpose','{\"purpose\":\"mortgage_leads\"}'),($1,'clinic_schedule','{\"timeZone\":\"Asia/Almaty\"}')",[id]);
    }
    const people=['owner','admin','lead_manager','lead_manager'].map(role=>({w,id:randomUUID(),auth:randomUUID(),role}));
    people.push({w:foreign,id:randomUUID(),auth:randomUUID(),role:'lead_manager'});
    for(const [i,p] of people.entries()) await db.query(`insert into public.staff_users(id,workspace_id,auth_user_id,email,full_name,role,status)
      values($1,$2,$3,$4,$5,$6,'active')`,[p.id,p.w,p.auth,`mortgage-${i}@example.invalid`,`Synthetic ${i}`,p.role]);
    const [owner,admin,a,b,outsider]=people;
    const leads=[randomUUID(),randomUUID(),randomUUID(),randomUUID(),randomUUID()];
    for(const [i,id] of leads.entries()) await db.query(`insert into public.leads(id,workspace_id,full_name,phone,status,responsible_user_id)
      values($1,$2,$3,$4,'new',$5)`,[id,i===4?foreign:w,`Contact ${i}`,`+7700000000${i}`,i<2?a.id:i===2?b.id:i===3?null:outsider.id]);
    const [leadA,leadA2,leadB,unassigned,foreignLead]=leads;

    await t.test('three activity tables deny browser CRUD and all four mortgage RPCs deny direct execution',async()=>{
      for(const table of ['mortgage_activities','mortgage_activity_events','mortgage_activity_requests']) {
        const r=(await db.query("select relrowsecurity as rls,has_table_privilege('anon',$1,'SELECT') as a,has_table_privilege('authenticated',$1,'INSERT') as b from pg_class where oid=$1::regclass",[`public.${table}`])).rows[0];
        assert.deepEqual(r,{rls:true,a:false,b:false});
        for(const role of ['anon','authenticated'])for(const permission of ['SELECT','INSERT','UPDATE','DELETE']){
          assert.equal((await db.query('select has_table_privilege($1,$2,$3) as permitted',[role,`public.${table}`,permission])).rows[0].permitted,false);
        }
      }
      const functions=(await db.query("select p.oid::regprocedure::text as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('mortgage_actor_role','read_mortgage_workspace','save_mortgage_activity','save_mortgage_admin_self_lead')")).rows;
      assert.equal(functions.length,4);
      for(const fn of functions)for(const role of ['anon','authenticated','service_role']){
        assert.equal((await db.query('select has_function_privilege($1,$2,\'EXECUTE\') as permitted',[role,fn.signature])).rows[0].permitted,role==='service_role');
      }
      const c=await f.connect();await c.query('set role authenticated');
      await denied(read(c,owner),'42501');await denied(saveSelfLead(c,admin,{full_name:'Synthetic denied browser'}),'42501');await c.end();
      const service=await f.connect();await service.query('set role service_role');
      assert.equal((await read(service,owner)).contactsTotal,4);await service.end();
    });
    await t.test('owner/admin see only their workspace; managers see only assigned contacts and their own member row',async()=>{
      for(const p of [owner,admin]){const s=await read(db,p);assert.equal(s.contactsTotal,4);assert.equal(s.members.length,4);assert.equal(s.timeZone,'Asia/Almaty');assert.equal(s.metrics.unassignedLeads,1);}
      const s=await read(db,a);assert.deepEqual(new Set(s.contacts.map(x=>x.id)),new Set([leadA,leadA2]));
      assert.deepEqual(s.members.map(x=>x.id),[a.id]);assert.deepEqual(s.memberMetrics,[]);
      for(const id of [leadB,unassigned,foreignLead])await denied(read(db,a,id),'P7002');
      await denied(read(db,owner,foreignLead),'P7002');
    });
    let savedTask;
    await t.test('atomic creation is replay-safe and changed payload with the same key fails',async()=>{
      const key=randomUUID(),payload=task(leadA);
      savedTask=await save(db,a,payload,null,null,key);
      const replay=await save(db,a,payload,null,null,key);assert.equal(replay.id,savedTask.id);assert.equal(replay.replayed,true);
      await denied(save(db,a,{...payload,title:'Different'},null,null,key),'P7007');
      assert.equal((await db.query('select count(*)::int as n from public.mortgage_activities')).rows[0].n,1);
      assert.equal((await db.query('select count(*)::int as n from public.mortgage_activity_events')).rows[0].n,1);
    });
    await t.test('optimistic updates and immutable lead/kind prevent stale overwrites and moves',async()=>{
      const payload={...task(leadA),status:'done'};
      const updated=await save(db,a,payload,savedTask.id,savedTask.updatedAt);
      await denied(save(db,a,task(leadA),savedTask.id,savedTask.updatedAt),'P7005');
      await denied(save(db,a,task(leadA2),savedTask.id,updated.updatedAt),'P7002');
      await denied(save(db,a,meeting(leadA),savedTask.id,updated.updatedAt),'P7003');
      const s=await read(db,owner);assert.equal(s.memberMetrics.find(m=>m.id===a.id).doneTasks,1);
    });
    await t.test('cross-tenant, another manager, and unassigned contact writes are indistinguishable',async()=>{
      for(const id of [leadB,unassigned,foreignLead]) await denied(save(db,a,task(id)),'P7002');
      await denied(save(db,owner,task(foreignLead)),'P7002');
      await denied(save(db,owner,meeting(unassigned)),'P7006');
    });
    await t.test('calendar conflicts span different contacts of the same manager and permit adjacent slots',async()=>{
      await save(db,a,meeting(leadA));
      await denied(save(db,owner,meeting(leadA2,'2027-01-10T10:30:00Z','2027-01-10T11:30:00Z')),'P7004');
      await save(db,a,meeting(leadA2,'2027-01-10T11:00:00Z','2027-01-10T12:00:00Z'));
      await save(db,b,meeting(leadB));
      const s=await read(db,a);assert.ok(s.activities.every(x=>[leadA,leadA2].includes(x.leadId)));
    });
    await t.test('two concurrent identical requests create one task and one history event',async()=>{
      const c1=await f.connect(),c2=await f.connect(),key=randomUUID();
      const payload=task(leadA,'Concurrent replay');
      const result=await Promise.all([save(c1,a,payload,null,null,key),save(c2,a,payload,null,null,key)]);
      assert.equal(result[0].id,result[1].id);assert.equal(result.filter(x=>x.replayed).length,1);
      assert.equal((await db.query('select count(*)::int as n from public.mortgage_activity_events where activity_id=$1',[result[0].id])).rows[0].n,1);
      await c1.end();await c2.end();
    });
    await t.test('concurrent different requests for an overlapping slot serialize by manager',async()=>{
      const c1=await f.connect(),c2=await f.connect();
      const result=await Promise.all([observed(save(c1,a,meeting(leadA,'2027-02-01T10:00:00Z','2027-02-01T11:00:00Z'))),
        observed(save(c2,a,meeting(leadA2,'2027-02-01T10:30:00Z','2027-02-01T11:30:00Z')))]);
      assert.equal(result.filter(x=>x.value).length,1);assert.equal(result.find(x=>x.error).error.code,'P7004');
      await c1.end();await c2.end();
    });
    await t.test('reassignment removes contact, activities, events and write access from the old manager',async()=>{
      await db.query('update public.leads set responsible_user_id=$1 where id=$2',[b.id,leadA]);
      await denied(read(db,a,leadA),'P7002');await denied(save(db,a,task(leadA)),'P7002');
      const s=await read(db,b,leadA);assert.equal(s.contacts[0].id,leadA);assert.ok(s.activities.length>=3);assert.ok(s.events.length>=3);
      await db.query('update public.leads set responsible_user_id=$1 where id=$2',[a.id,leadA]);
    });
    await t.test('a waiting write rechecks ownership after concurrent reassignment commits',async()=>{
      const c1=await f.connect(),c2=await f.connect();
      try {
        await c1.query('begin');await c1.query('update public.leads set responsible_user_id=$1 where id=$2',[b.id,leadA]);
        const pid=(await c2.query('select pg_backend_pid() as pid')).rows[0].pid;
        const pending=observed(save(c2,a,task(leadA,'Must not be saved')));
        let blocked=false;
        for(let i=0;i<100;i++){const r=await db.query('select cardinality(pg_blocking_pids($1))>0 as blocked',[pid]);if(r.rows[0].blocked){blocked=true;break;}await delay(15);}
        assert.equal(blocked,true,'real PostgreSQL blocking must be observed');await c1.query('commit');
        assert.equal((await pending).error?.code,'P7002');
      } finally {await c1.query('rollback');await c1.end();await c2.end();await db.query('update public.leads set responsible_user_id=$1 where id=$2',[a.id,leadA]);}
    });
    await t.test('revocation, mismatched auth identity and non-mortgage profiles fail closed',async()=>{
      await denied(read(db,{...a,auth:b.auth}),'P7001');
      await db.query("update public.staff_users set status='inactive' where id=$1",[a.id]);
      await denied(read(db,a),'P7001');await denied(save(db,a,task(leadA)),'P7001');
      await db.query("update public.staff_users set status='active' where id=$1",[a.id]);
      await db.query("update public.workspace_settings set value='{\"purpose\":\"clinic_services\"}' where workspace_id=$1 and key='workspace_purpose'",[w]);
      await denied(read(db,owner),'P7001');
      await db.query("update public.workspace_settings set value='{\"purpose\":\"mortgage_leads\"}' where workspace_id=$1 and key='workspace_purpose'",[w]);
    });
    await t.test('timezone is mandatory; tasks and meetings reject incompatible dates/statuses',async()=>{
      await denied(save(db,a,{...task(leadA),status:'missed'}),'P7003');
      await denied(save(db,a,{...meeting(leadA),endsAt:'2027-01-10T09:00:00Z'}),'P7003');
      await db.query("update public.workspace_settings set value='{}' where workspace_id=$1 and key='clinic_schedule'",[w]);
      await denied(read(db,owner),'P7008');
      await db.query("update public.workspace_settings set value='{\"timeZone\":\"Asia/Almaty\"}' where workspace_id=$1 and key='clinic_schedule'",[w]);
    });
    await t.test('completion metrics follow the recorded actor and do not inflate after status toggles',async()=>{
      let current=(await read(db,owner,leadA)).activities.find(x=>x.id===savedTask.id);
      for(const status of ['open','done','open','done']){
        const result=await save(db,owner,{...task(leadA),status},current.id,current.updatedAt);
        current={...current,updatedAt:result.updatedAt};
      }
      const metrics=(await read(db,owner)).memberMetrics;
      assert.equal(metrics.find(m=>m.id===owner.id).doneTasks,1);
      assert.equal(metrics.find(m=>m.id===a.id).doneTasks,1);
      assert.equal(metrics.find(m=>m.id===b.id).doneTasks,0);
    });
    await t.test('missed meetings credit the recorded owner once while workload stays with the current manager',async()=>{
      const before=await read(db,owner),now=Date.now();
      assert.equal(before.periodDays,30);
      assert.equal(before.contacts.find(x=>x.id===leadA).responsibleUserId,a.id);
      assert.equal(before.memberMetrics.find(m=>m.id===owner.id).missedMeetings,0);
      assert.equal(before.memberMetrics.find(m=>m.id===a.id).missedMeetings,0);
      const existing=before.activities.filter(x=>x.kind==='meeting'&&x.status==='open'&&x.responsibleUserId===a.id);
      let start=now-3600000;
      while(existing.some(x=>Date.parse(x.startsAt)<start+1800000&&Date.parse(x.endsAt)>start)) start-=3600000;
      assert.ok(start>now-30*86400000);
      const payload={...meeting(leadA,new Date(start).toISOString(),new Date(start+1800000).toISOString()),title:'Synthetic current-period missed meeting'};
      const key=randomUUID(),created=await save(db,owner,payload,null,null,key);
      const activity=s=>s.activities.find(x=>x.id===created.id);
      const events=s=>s.events.filter(x=>x.activityId===created.id);
      const ownerName=before.members.find(m=>m.id===owner.id).name;
      const initial=await read(db,owner);
      assert.equal(activity(initial).status,'open');
      assert.equal(activity(initial).responsibleUserId,a.id);
      assert.equal(activity(initial).updatedAt,created.updatedAt);
      assert.equal(events(initial).length,1);
      assert.equal(events(initial)[0].actorName,ownerName);
      const replay=await save(db,owner,payload,null,null,key);
      assert.equal(replay.id,created.id);assert.equal(replay.replayed,true);
      const replayed=await read(db,owner);
      assert.deepEqual(activity(replayed),activity(initial));
      assert.deepEqual(events(replayed),events(initial));
      let current=activity(replayed),expectedEvents=1;
      const versions=new Set([current.updatedAt]);
      for(const status of ['missed','open','missed']){
        const previous=current,result=await save(db,owner,{...payload,status},current.id,current.updatedAt);
        assert.equal(result.id,created.id);
        assert.notEqual(result.updatedAt,previous.updatedAt);
        versions.add(result.updatedAt);expectedEvents++;
        const snapshot=await read(db,owner);
        current=activity(snapshot);
        assert.equal(current.status,status);assert.equal(current.updatedAt,result.updatedAt);
        assert.equal(current.responsibleUserId,a.id);
        assert.equal(snapshot.activities.filter(x=>x.id===created.id).length,1);
        const history=events(snapshot);
        assert.equal(history.length,expectedEvents);
        assert.equal(new Set(history.map(x=>x.id)).size,expectedEvents);
        assert.ok(history.every(x=>x.actorName===ownerName));
        assert.equal(snapshot.memberMetrics.find(m=>m.id===owner.id).missedMeetings,1);
        assert.equal(snapshot.memberMetrics.find(m=>m.id===a.id).missedMeetings,0);
        await denied(save(db,owner,{...payload,status},previous.id,previous.updatedAt),'P7005');
        const retried=await read(db,owner);
        assert.deepEqual(activity(retried),current);assert.deepEqual(events(retried),history);
        assert.deepEqual(retried.memberMetrics,snapshot.memberMetrics);
      }
      assert.equal(versions.size,4);
      const after=await read(db,owner);
      assert.equal(events(after).length,4);
      assert.equal(after.memberMetrics.find(m=>m.id===owner.id).missedMeetings,1);
      assert.equal(after.memberMetrics.find(m=>m.id===a.id).missedMeetings,0);
      assert.equal(after.contacts.find(x=>x.id===leadA).responsibleUserId,a.id);
      for(const member of [owner,a]) assert.equal(after.memberMetrics.find(m=>m.id===member.id).assignedLeads,before.memberMetrics.find(m=>m.id===member.id).assignedLeads);
      const manager=await read(db,a,leadA);
      assert.deepEqual(manager.memberMetrics,[]);assert.deepEqual(manager.members.map(m=>m.id),[a.id]);
      assert.deepEqual(activity(manager),current);assert.deepEqual(events(manager),events(after));
    });
    await t.test('current admin self meetings preserve distribution, own workload, recorded actors and manager isolation',async()=>{
      await db.query('begin');
      try {
        const before=await read(db,admin),ownerLead=randomUUID(),peer={...admin,id:randomUUID(),auth:randomUUID()};
        await db.query("insert into public.staff_users(id,workspace_id,auth_user_id,email,full_name,role,status) values($1,$2,$3,'synthetic-peer@example.invalid','Synthetic peer','admin','active')",[peer.id,w,peer.auth]);
        const own=(await saveSelfLead(db,admin,{full_name:'Synthetic self contact',phone:'+77000008888'})).id;
        const own2=(await saveSelfLead(db,admin,{full_name:'Synthetic second self contact',phone:'+77000008889'})).id;
        await db.query("insert into public.leads(id,workspace_id,full_name,phone,status,responsible_user_id) values($1,$2,'Synthetic owner contact','+77000008887','new',$3)",[ownerLead,w,owner.id]);
        const start=Date.now()+3600000,iso=offset=>new Date(start+offset).toISOString();
        const payload=meeting(own,iso(0),iso(3600000));
        const created=await save(db,admin,payload),key=randomUUID();
        const createdTask=await save(db,admin,task(own),null,null,key);
        assert.equal((await save(db,admin,task(own),null,null,key)).id,createdTask.id);
        await deniedInTransaction(db,()=>save(db,admin,meeting(own2,iso(1800000),iso(5400000))),'P7004');
        await save(db,admin,meeting(own2,iso(3600000),iso(7200000)));
        const ownRead=await read(db,admin,own),current=ownRead.activities.find(item=>item.id===createdTask.id);
        assert.equal(ownRead.contacts[0].responsibleUserId,admin.id);
        assert.equal(ownRead.activities.find(item=>item.id===created.id).responsibleUserId,admin.id);
        await save(db,admin,{...task(own),status:'done'},current.id,current.updatedAt);
        const snapshot=await read(db,admin),row=snapshot.memberMetrics.find(member=>member.id===admin.id);
        assert.equal(row.role,'admin');assert.equal(row.assignedLeads,2);assert.equal(row.plannedMeetings,2);
        assert.equal(row.doneTasks,before.memberMetrics.find(member=>member.id===admin.id).doneTasks+1);
        assert.equal(snapshot.metrics.activeManagers,before.metrics.activeManagers);
        assert.ok(snapshot.contacts.some(item=>item.id===leadA),'admin retains existing team distribution scope');
        const manager=await read(db,a);
        assert.ok(manager.contacts.every(item=>item.responsibleUserId===a.id));
        assert.ok(manager.activities.every(item=>item.responsibleUserId===a.id));
        assert.deepEqual(manager.members.map(member=>member.id),[a.id]);assert.deepEqual(manager.memberMetrics,[]);
        await deniedInTransaction(db,()=>read(db,a,own),'P7002');await deniedInTransaction(db,()=>save(db,a,task(own)),'P7002');
        await deniedInTransaction(db,()=>save(db,peer,meeting(own,iso(10800000),iso(14400000))),'P7006');
        await deniedInTransaction(db,()=>save(db,owner,meeting(own,iso(10800000),iso(14400000))),'P7006');
        await deniedInTransaction(db,()=>save(db,owner,meeting(ownerLead,iso(10800000),iso(14400000))),'P7006');
        await deniedInTransaction(db,()=>save(db,{...admin,auth:peer.auth},payload),'P7001');
        await db.query('update public.leads set responsible_user_id=$1 where id=$2',[outsider.id,own2]);
        await deniedInTransaction(db,()=>save(db,admin,meeting(own2,iso(10800000),iso(14400000))),'P7006');
        await db.query("update public.staff_users set status='inactive' where id=$1",[admin.id]);
        await deniedInTransaction(db,()=>save(db,admin,payload),'P7001');
      } finally { await db.query('rollback'); }
    });
    await t.test('explicit assignment to admin removes the old manager contact, history and write access',async()=>{
      await db.query('begin');
      try {
        const before=await read(db,admin),old=await read(db,a,leadA);
        assert.ok(old.activities.length>0);assert.ok(old.events.length>0);
        await saveSelfLead(db,admin,{},leadA);
        await deniedInTransaction(db,()=>read(db,a,leadA),'P7002');await deniedInTransaction(db,()=>save(db,a,task(leadA)),'P7002');
        const remaining=await read(db,a);
        assert.ok(remaining.contacts.every(item=>item.id!==leadA));assert.ok(remaining.activities.every(item=>item.leadId!==leadA));
        const activityIds=new Set(old.activities.map(item=>item.id));
        assert.ok(remaining.events.every(event=>!activityIds.has(event.activityId)));assert.deepEqual(remaining.memberMetrics,[]);
        const own=await read(db,admin,leadA);assert.equal(own.contacts[0].responsibleUserId,admin.id);
        assert.equal(own.activities.length,old.activities.length);assert.equal(own.events.length,old.events.length);
        const metrics=(await read(db,admin)).memberMetrics;
        assert.equal(metrics.find(member=>member.id===admin.id).assignedLeads,before.memberMetrics.find(member=>member.id===admin.id).assignedLeads+1);
        assert.equal(metrics.find(member=>member.id===a.id).doneTasks,before.memberMetrics.find(member=>member.id===a.id).doneTasks);
      } finally { await db.query('rollback'); }
    });
    await t.test('SQL077 service-only self INSERT/PATCH returns full lead and definitions and rejects substituted identity or tenant references',async()=>{
      const service=await f.connect();await service.query('set role service_role');await service.query('begin');
      try {
        const stage=randomUUID(),source=randomUUID(),foreignStage=randomUUID(),foreignSource=randomUUID();
        for(const [id,workspace] of [[stage,w],[foreignStage,foreign]]) await service.query(
          "insert into public.lead_stages(id,workspace_id,stage_key,name,semantic_group) values($1,$2,'synthetic-rpc','Synthetic stage','new')",[id,workspace]);
        for(const [id,workspace] of [[source,w],[foreignSource,foreign]]) await service.query(
          "insert into public.lead_sources(id,workspace_id,source_key,name,channel) values($1,$2,'synthetic-rpc','Synthetic source','manual')",[id,workspace]);
        const created=await saveSelfLead(service,admin,{full_name:'Synthetic atomic self',phone:'+77000007777',notes:'Original',stage_id:stage,source_id:source});
        assert.equal(created.workspace_id,w);assert.equal(created.responsible_user_id,admin.id);
        assert.equal(created.full_name,'Synthetic atomic self');assert.equal(created.phone,'+77000007777');
        assert.equal(created.stage_definition.id,stage);assert.equal(created.stage_definition.semantic_group,'new');
        assert.equal(created.source_definition.id,source);assert.equal(created.source_definition.channel,'manual');
        const patched=await saveSelfLead(service,admin,{notes:'Updated atomically'},created.id);
        assert.equal(patched.id,created.id);assert.equal(patched.full_name,created.full_name);assert.equal(patched.notes,'Updated atomically');
        assert.equal(patched.stage_definition.id,stage);assert.equal(patched.source_definition.id,source);
        for(const actor of [owner,a]) await deniedInTransaction(service,()=>saveSelfLead(service,actor,{full_name:'Denied role'}),'P7703');
        await deniedInTransaction(service,()=>saveSelfLead(service,{...admin,auth:a.auth},{full_name:'Denied auth'}),'P7001');
        for(const row of [{responsible_user_id:owner.id},{workspace_id:foreign},{stage_id:foreignStage},{source_id:foreignSource},{staff_user_id:admin.id}]) {
          await deniedInTransaction(service,()=>saveSelfLead(service,admin,row,created.id),'P7701');
        }
        for(const id of [randomUUID(),foreignLead]) await deniedInTransaction(service,()=>saveSelfLead(service,admin,{},id),'P7702');
        await deniedInTransaction(service,()=>saveSelfLead(service,admin,{notes:'Forbidden foreign write'},foreignLead),'P7702');
        assert.equal((await service.query('select notes from public.leads where id=$1',[created.id])).rows[0].notes,'Updated atomically');
      } finally { await service.query('rollback');await service.end(); }
    });
    for(const change of ['demotion','deactivation']) for(const operation of ['INSERT','PATCH']) {
      await t.test(`SQL077 ${operation} waits for concurrent ${change} and then denies acquiring an unassigned lead`,async()=>{
        const actor={w,id:randomUUID(),auth:randomUUID()},marker=`Synthetic race ${randomUUID()}`,target=operation==='PATCH'?randomUUID():null;
        const holder=await f.connect(),writer=await f.connect();let pending;
        try {
          await db.query("insert into public.staff_users(id,workspace_id,auth_user_id,email,full_name,role,status) values($1,$2,$3,$4,'Synthetic race admin','admin','active')",[actor.id,w,actor.auth,`${actor.id}@example.invalid`]);
          if(target) await db.query("insert into public.leads(id,workspace_id,full_name,phone,status) values($1,$2,$3,'+77000006666','new')",[target,w,marker]);
          await writer.query('set role service_role');
          const holderPid=(await holder.query('select pg_backend_pid() as pid')).rows[0].pid;
          const writerPid=(await writer.query('select pg_backend_pid() as pid')).rows[0].pid;
          await holder.query('begin');
          await holder.query('update public.staff_users set role=$1,status=$2 where id=$3',
            [change==='demotion'?'lead_manager':'admin',change==='deactivation'?'inactive':'active',actor.id]);
          pending=observed(saveSelfLead(writer,actor,{full_name:marker,phone:'+77000006666'},target));
          await waitForLock(db,writerPid,holderPid);
          await holder.query('commit');
          const result=await pending;assert.equal(result.error?.code,change==='demotion'?'P7703':'P7001');
          const leads=(await db.query('select id,responsible_user_id from public.leads where workspace_id=$1 and full_name=$2',[w,marker])).rows;
          assert.equal(leads.length,operation==='PATCH'?1:0);
          if(target) {assert.equal(leads[0].id,target);assert.equal(leads[0].responsible_user_id,null);}
        } finally {
          await holder.query('rollback');if(pending) await pending;await holder.end();await writer.end();
          await db.query('delete from public.leads where workspace_id=$1 and full_name=$2',[w,marker]);
          await db.query('delete from public.staff_users where id=$1',[actor.id]);
        }
      });
      await t.test(`SQL077 ${operation} holds the verified actor lock until commit before concurrent ${change}`,async()=>{
        const actor={w,id:randomUUID(),auth:randomUUID()},marker=`Synthetic holding ${randomUUID()}`,target=operation==='PATCH'?randomUUID():null;
        const writer=await f.connect(),revoker=await f.connect();let pending;
        try {
          await db.query("insert into public.staff_users(id,workspace_id,auth_user_id,email,full_name,role,status) values($1,$2,$3,$4,'Synthetic holding admin','admin','active')",[actor.id,w,actor.auth,`${actor.id}@example.invalid`]);
          if(target) await db.query("insert into public.leads(id,workspace_id,full_name,phone,status) values($1,$2,$3,'+77000005555','new')",[target,w,marker]);
          await writer.query('set role service_role');await writer.query('begin');
          const saved=await saveSelfLead(writer,actor,{full_name:marker,phone:'+77000005555'},target);
          const writerPid=(await writer.query('select pg_backend_pid() as pid')).rows[0].pid;
          const revokerPid=(await revoker.query('select pg_backend_pid() as pid')).rows[0].pid;
          pending=observed(revoker.query('update public.staff_users set role=$1,status=$2 where id=$3',
            [change==='demotion'?'lead_manager':'admin',change==='deactivation'?'inactive':'active',actor.id]));
          await waitForLock(db,revokerPid,writerPid);await writer.query('commit');
          assert.equal((await pending).error,undefined);
          assert.equal((await db.query('select responsible_user_id from public.leads where id=$1',[saved.id])).rows[0].responsible_user_id,actor.id);
          const membership=(await db.query('select role,status from public.staff_users where id=$1',[actor.id])).rows[0];
          assert.deepEqual(membership,{role:change==='demotion'?'lead_manager':'admin',status:change==='deactivation'?'inactive':'active'});
        } finally {
          await writer.query('rollback');if(pending) await pending;await writer.end();await revoker.end();
          await db.query('delete from public.leads where workspace_id=$1 and full_name=$2',[w,marker]);
          await db.query('delete from public.staff_users where id=$1',[actor.id]);
        }
      });
    }
    await t.test('contact pagination leaves full metrics intact and search treats wildcard characters literally',async()=>{
      await db.query(`insert into public.leads(workspace_id,full_name,phone,status,responsible_user_id)
        select $1,'Paging contact '||n,'+77000001'||lpad(n::text,3,'0'),'new',$2 from generate_series(1,105) n`,[w,a.id]);
      await db.query("insert into public.leads(workspace_id,full_name,phone,status) values($1,'Literal % _','+77000009999','new')",[w]);
      const first=await read(db,owner);
      const secondPage=(await db.query("select public.read_mortgage_workspace($1,$2,$3,'',1,null,null,null,30) as result",[w,owner.id,owner.auth])).rows[0].result;
      assert.equal(first.contacts.length,100);assert.equal(first.contactsTotal,110);assert.equal(first.metrics.totalLeads,110);
      assert.equal(secondPage.contacts.length,10);
      assert.equal(new Set([...first.contacts,...secondPage.contacts].map(c=>c.id)).size,110);
      const literal=(await db.query("select public.read_mortgage_workspace($1,$2,$3,'%',0,null,null,null,30) as result",[w,owner.id,owner.auth])).rows[0].result;
      assert.equal(literal.contactsTotal,1);assert.equal(literal.contacts[0].name,'Literal % _');
      const own=await read(db,a);assert.equal(own.contactsTotal,107);assert.equal(own.metrics.totalLeads,107);
    });
    await db.end();
  } finally { await f.close(); }
});

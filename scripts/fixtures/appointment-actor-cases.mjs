import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const one=async(db,sql,args=[])=> (await db.query(sql,args)).rows[0];
const readSql='select public.read_crm_appointment_request_v2($1,$2,$3,$4,$5,$6) value';
const createSql='select public.create_crm_appointment_v2($1,$2,$3,$4,$5,$6,null,$7::jsonb,$8) value';
const args=f=>[f.workspace,f.staff,f.actor,f.role,f.key,'a'.repeat(64)];
const observed=p=>p.then(value=>({value}),error=>({error}));
export async function exerciseAppointmentActorDependencies(db,source,t){
  for(const [sql,message] of [
    ['alter table crm_appointment_create_requests disable row level security','appointment_actor_receipt_access_unconfirmed'],
    ['grant select(request_key) on crm_appointment_create_requests to authenticated','appointment_actor_receipt_access_unconfirmed'],
    ['alter function read_crm_appointment_create_request(uuid,uuid,uuid,text) rename to owned_missing_actor_reader','appointment_actor_dependencies_unconfirmed'],
    ['drop index clinic_doctors_workspace_staff_user_idx','appointment_actor_doctor_identity_unconfirmed'],
    ['grant service_role to authenticated','appointment_actor_dependencies_unconfirmed'],
  ])await t.test('115 dependency drift refuses before creating provenance: '+sql,()=>rolledBack(db,async()=>{
    await db.query(sql);await assert.rejects(()=>db.query(source),e=>e.message===message);
  }));
  assert.equal((await one(db,"select to_regclass('public.crm_appointment_request_actors') value")).value,null);
}
async function setup(db) {
  const f=Object.fromEntries(['workspace','staff','actor','doctor','client','key'].map(k=>[k,randomUUID()]));f.role='owner';
  await db.query("insert into workspaces(id,name) values($1,'Owned appointment authority')",[f.workspace]);
  await db.query("insert into staff_users(id,workspace_id,auth_user_id,full_name,email,role,status) values($1,$2,$3,'Owned doctor',$4,'owner','active')",[f.staff,f.workspace,f.actor,f.staff+'@example.invalid']);
  await db.query("insert into clinic_doctors(id,workspace_id,staff_user_id,full_name,capacity) values($1,$2,$3,'Owned doctor',2)",[f.doctor,f.workspace,f.staff]);
  await db.query("insert into clients(id,workspace_id,full_name) values($1,$2,'Owned client')",[f.client,f.workspace]);
  f.appointment={workspace_id:f.workspace,created_by_staff_user_id:f.staff,client_id:f.client,client_name:'Owned client',doctor_id:f.doctor,
    doctor_name:'Owned doctor',starts_at:'2090-10-20T09:00:00Z',duration_minutes:45,price_minor:123450,status:'scheduled',service:'Owned service'};
  f.read=async connection=>(await one(connection,readSql,args(f))).value;
  f.create=async connection=>(await one(connection,createSql,[...args(f),f.appointment,'provided'])).value;
  f.counts=()=>one(db,`select (select count(*)::int from appointments where workspace_id=$1) appointments,
    (select count(*)::int from crm_appointment_create_requests where workspace_id=$1) receipts,
    (select count(*)::int from crm_appointment_request_actors where workspace_id=$1) origins`,[f.workspace]);
  return f;
}
async function denied(db,action,code) {
  await db.query('savepoint expected_actor_refusal');
  try {await assert.rejects(action,error=>error.code===code);}finally{await db.query('rollback to savepoint expected_actor_refusal;release savepoint expected_actor_refusal');}
}
async function rolledBack(db,action){await db.query('begin');try{await action();}finally{await db.query('rollback');}}
async function blocking(observer,owner,waiter) {
  for(let i=0;i<160;i++){if((await one(observer,'select $1::int=any(pg_blocking_pids($2::int)) blocked',[owner,waiter])).blocked)return;await delay(15);}
  assert.fail('A real PostgreSQL blocker was not observed');
}

export async function exerciseAppointmentActor(db,fixture,t) {
  await t.test('115 closes legacy entries/helpers and both receipt tables, leaving only v2 service RPCs',async()=>{
    for(const signature of ['public.create_crm_appointment_with_new_client(uuid,jsonb,jsonb)','public.read_crm_appointment_create_request(uuid,uuid,uuid,text)',
      'public.create_crm_appointment_once(uuid,uuid,uuid,text,jsonb,jsonb,text)','public.lock_crm_appointment_actor(uuid,uuid,uuid,text)','public.crm_appointment_targets_actor(jsonb,jsonb)'])
      assert.equal((await one(db,"select has_function_privilege('service_role',$1,'EXECUTE') allowed",[signature])).allowed,false);
    for(const role of ['anon','authenticated','service_role'])for(const table of ['crm_appointment_create_requests','crm_appointment_request_actors'])
      assert.deepEqual(await one(db,`select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') tab,
        has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') col`,[role,'public.'+table]),{tab:false,col:false});
  });
  for(const role of ['owner','admin','receptionist','manager','doctor'])await t.test('115 '+role+' creates and replays one origin-bound visit',()=>rolledBack(db,async()=>{
    const f=await setup(db);f.role=role;await db.query('update staff_users set role=$1 where id=$2',[role,f.staff]);await db.query('set local role service_role');
    const first=await f.create(db),second=await f.create(db);assert.equal(first.replayed,false);assert.equal(second.replayed,true);assert.equal(first.appointment.id,second.appointment.id);
    await db.query('reset role');assert.deepEqual(await f.counts(),{appointments:1,receipts:1,origins:1});
  }));
  await t.test('115 never adopts a legacy receipt without original Auth provenance',()=>rolledBack(db,async()=>{
    const f=await setup(db);await db.query('select public.create_crm_appointment_once($1,$2,$3,$4,null,$5::jsonb,$6)',[f.workspace,f.staff,f.key,'a'.repeat(64),f.appointment,'provided']);
    await db.query('set local role service_role');await denied(db,()=>f.read(db),'P6403');await denied(db,()=>f.create(db),'P6403');
    await db.query('reset role');assert.deepEqual(await f.counts(),{appointments:1,receipts:1,origins:0});
  }));
  await t.test('115 a newly authorized account cannot adopt the previous account receipt on the same staff row',()=>rolledBack(db,async()=>{
    const f=await setup(db);await f.create(db);const replacement=randomUUID();await db.query('update staff_users set auth_user_id=$1 where id=$2',[replacement,f.staff]);
    f.actor=replacement;await db.query('set local role service_role');await denied(db,()=>f.read(db),'P6404');await denied(db,()=>f.create(db),'P6404');
    await db.query('reset role');assert.deepEqual(await f.counts(),{appointments:1,receipts:1,origins:1});
  }));
  for(const change of ["role='doctor'","status='inactive'","auth_user_id=null"])await t.test('115 exact HTTP authority must match even for '+change,()=>rolledBack(db,async()=>{
    const f=await setup(db);await db.query('update staff_users set '+change+' where id=$1',[f.staff]);await db.query('set local role service_role');
    await denied(db,()=>f.create(db),'P6404');await db.query('reset role');assert.deepEqual(await f.counts(),{appointments:0,receipts:0,origins:0});
  }));
  await t.test('115 doctor loses create authority when its linked card is reassigned; namesakes do not restore it',()=>rolledBack(db,async()=>{
    const f=await setup(db);f.role='doctor';await db.query("update staff_users set role='doctor' where id=$1",[f.staff]);
    await db.query('update clinic_doctors set staff_user_id=null where id=$1',[f.doctor]);await db.query('set local role service_role');await denied(db,()=>f.create(db),'P6404');
    await db.query('reset role');assert.deepEqual(await f.counts(),{appointments:0,receipts:0,origins:0});
  }));
  for(const isolation of ['repeatable read','serializable'])await t.test('115 rejects an old '+isolation+' authority snapshot',async()=>{
    await db.query('begin');const f=await setup(db);await db.query('commit');
    try{await db.query('begin isolation level '+isolation);await db.query('set local role service_role');await denied(db,()=>f.read(db),'P6405');}
    finally{await db.query('rollback');await db.query('delete from workspaces where id=$1',[f.workspace]);}
  });
  for(const change of ["role='marketer'","auth_user_id=null","status='inactive'"])await t.test('115 observes '+change+' after an actual staff row lock wait',async()=>{
    const f=await setup(db),revoker=await fixture.connect(),caller=await fixture.connect();
    try{
      const r=(await one(revoker,'select pg_backend_pid() pid')).pid,c=(await one(caller,'select pg_backend_pid() pid')).pid,o=(await one(db,'select pg_backend_pid() pid')).pid;
      assert.equal(new Set([r,c,o]).size,3);await revoker.query('begin');await revoker.query('update staff_users set '+change+' where id=$1',[f.staff]);
      await caller.query('set role service_role');const pending=observed(f.create(caller));await blocking(db,r,c);await revoker.query('commit');
      assert.equal((await pending).error?.code,'P6404');assert.deepEqual(await f.counts(),{appointments:0,receipts:0,origins:0});
    }finally{await revoker.query('rollback').catch(()=>{});await caller.end();await revoker.end();await db.query('delete from workspaces where id=$1',[f.workspace]);}
  });
  await t.test('115 an admitted transaction pins authority until commit; the later revoker must wait',async()=>{
    const f=await setup(db),caller=await fixture.connect(),revoker=await fixture.connect();
    try{
      const c=(await one(caller,'select pg_backend_pid() pid')).pid,r=(await one(revoker,'select pg_backend_pid() pid')).pid;
      await caller.query('begin;set local role service_role');assert.equal((await f.create(caller)).replayed,false);
      const pending=observed(revoker.query("update staff_users set status='inactive' where id=$1",[f.staff]));await blocking(db,c,r);await caller.query('commit');
      assert.ok((await pending).value);assert.deepEqual(await f.counts(),{appointments:1,receipts:1,origins:1});
      await caller.query('set role service_role');await assert.rejects(()=>f.read(caller),e=>e.code==='P6404');
    }finally{await caller.query('rollback').catch(()=>{});await caller.end();await revoker.end();await db.query('delete from workspaces where id=$1',[f.workspace]);}
  });
  await t.test('115 replay does not invert the appointment-editor/capacity lock order',async()=>{
    const f=await setup(db),reader=await fixture.connect(),editor=await fixture.connect();const other=randomUUID();
    try{
      f.role='doctor';await db.query("update staff_users set role='doctor' where id=$1",[f.staff]);
      const first=await f.create(db);await db.query("insert into clinic_doctors(id,workspace_id,full_name,capacity) values($1,$2,'Owned other doctor',2)",[other,f.workspace]);
      const r=(await one(reader,'select pg_backend_pid() pid')).pid,e=(await one(editor,'select pg_backend_pid() pid')).pid;
      await editor.query('begin');await editor.query('select 1 from appointments where id=$1 for update',[first.appointment.id]);
      await reader.query("begin;set local role service_role;set local statement_timeout='3000ms'");
      assert.equal((await f.read(reader)).appointment.id,first.appointment.id,'MVCC read must not wait for an uncommitted editor row');
      const pending=observed(editor.query('update appointments set doctor_id=$1 where id=$2',[other,first.appointment.id]));
      await blocking(db,r,e);await reader.query('commit');assert.ok((await pending).value);await editor.query('commit');
      await reader.query('set role service_role');await assert.rejects(()=>f.read(reader),error=>error.code==='P6406');
      assert.deepEqual(await f.counts(),{appointments:1,receipts:1,origins:1});
    }finally{await reader.query('rollback').catch(()=>{});await editor.query('rollback').catch(()=>{});await reader.end();await editor.end();await db.query('delete from workspaces where id=$1',[f.workspace]);}
  });
}

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const sql='select public.patch_crm_appointment_as_actor($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) value';
const one=async(db,statement,args=[])=> (await db.query(statement,args)).rows[0];
const observed=p=>p.then(value=>({value}),error=>({error}));
async function setup(db,versioned=false,journaled=false){
  const f=Object.fromEntries(['workspace','staff','actor','doctor','appointment'].map(key=>[key,randomUUID()]));
  await db.query("insert into workspaces(id,name) values($1,'Owned patch authority')",[f.workspace]);
  await db.query("insert into staff_users(id,workspace_id,auth_user_id,full_name,email,role,status) values($1,$2,$3,'Owned patch doctor',$4,'owner','active')",[f.staff,f.workspace,f.actor,f.staff+'@example.invalid']);
  await db.query("insert into clinic_doctors(id,workspace_id,staff_user_id,full_name,capacity) values($1,$2,$3,'Owned patch doctor',2)",[f.doctor,f.workspace,f.staff]);
  await db.query("insert into appointments(id,workspace_id,doctor_id,doctor_name,starts_at,status,notes,price_minor) values($1,$2,$3,'Owned patch doctor','2090-10-20T09:00:00Z','scheduled','Original owned note',0)",[f.appointment,f.workspace,f.doctor]);
  f.before=(await one(db,'select to_jsonb(a) value from appointments a where id=$1',[f.appointment])).value;
  f.args=[f.workspace,f.staff,f.actor,'owner',f.appointment,JSON.stringify(f.before),JSON.stringify({notes:'Owned patch result'})];
  f.patch=async connection=>(await one(connection,journaled?'select public.patch_crm_appointment_journaled($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb) value':versioned?'select public.patch_crm_appointment_v2($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) value':sql,
    journaled?[...f.args.slice(0,5),f.before.edit_version,...f.args.slice(5),JSON.stringify({actorName:'owned@example.invalid',outsideSchedule:false,changes:[]})]:versioned?[...f.args.slice(0,5),f.before.edit_version,...f.args.slice(5)]:f.args)).value;
  f.close=()=>db.query('delete from workspaces where id=$1',[f.workspace]);
  return f;
}
async function blocking(db,owner,waiter){
  for(let n=0;n<160;n++){if((await one(db,'select $1::int=any(pg_blocking_pids($2::int)) blocked',[owner,waiter])).blocked)return;await delay(15);}
  assert.fail('No actual PostgreSQL row-lock wait was observed');
}
async function rolledBack(db,action){await db.query('begin');try{await action();}finally{await db.query('rollback');}}

export async function exerciseAppointmentPatch(db,fixture,t,{versioned=false,journaled=false}={}){
  const make=()=>setup(db,versioned,journaled);
  await t.test('116 closes actual legacy service DML while keeping appointment reads',async()=>{
    await db.query('set role service_role');
    try{
      await db.query('select * from public.appointments limit 0');
      for(const statement of ["update public.appointments set notes=notes where false",
        "delete from public.appointments where false","insert into public.appointments(workspace_id) select null::uuid where false"])
        await assert.rejects(()=>db.query(statement),error=>error.code==='42501');
    }finally{await db.query('reset role');}
  });
  for(const role of ['anon','authenticated'])await t.test('116 actual '+role+' cannot execute the patch entry',async()=>{
    await db.query('set role '+role);try{await assert.rejects(()=>db.query(sql,[null,null,null,null,null,null,null]),error=>error.code==='42501');}
    finally{await db.query('reset role');}
  });
  for(const column of ['workspace_id','id','created_by_staff_user_id','arrival_sale_id','notes=(select 1)'])await t.test('116 rejects server-owned or unknown patch key '+column,()=>rolledBack(db,async()=>{
    const f=await make();f.args[6]=JSON.stringify({[column]:randomUUID()});
    await db.query('savepoint refused;set local role service_role');
    await assert.rejects(()=>f.patch(db),error=>error.code==='P1161');await db.query('rollback to savepoint refused');
    assert.equal((await one(db,'select notes from appointments where id=$1',[f.appointment])).notes,'Original owned note');
  }));
  for(const isolation of ['repeatable read','serializable'])await t.test('116 refuses stale '+isolation+' authority snapshots',async()=>{
    const f=await make();
    try{await db.query('begin isolation level '+isolation+';set local role service_role');await assert.rejects(()=>f.patch(db),error=>error.code==='P1165');}
    finally{await db.query('rollback');await f.close();}
  });
  await t.test('116 only offered columns fire UPDATE OF triggers',()=>rolledBack(db,async()=>{
    const f=await make();
    await db.query(`create function public.owned_patch_status_probe() returns trigger language plpgsql as $$
      begin if old.status is not distinct from new.status then raise exception 'owned_unoffered_status_update';end if;return new;end $$;
      create trigger owned_patch_status_probe before update of status on public.appointments for each row execute function public.owned_patch_status_probe();
      set local role service_role;`);
    assert.equal((await f.patch(db)).notes,'Owned patch result');
  }));
  await t.test('116 sees revocation after a real staff-lock wait before mutation',async()=>{
    const f=await make(),revoker=await fixture.connect(),caller=await fixture.connect();let pending;
    try{
      const r=(await one(revoker,'select pg_backend_pid() pid')).pid,c=(await one(caller,'select pg_backend_pid() pid')).pid;
      await revoker.query('begin');await revoker.query("update staff_users set status='inactive' where id=$1",[f.staff]);
      await caller.query('set role service_role');pending=observed(f.patch(caller));await blocking(db,r,c);await revoker.query('commit');
      assert.equal((await pending).error?.code,'P1162');assert.equal((await one(db,'select notes from appointments where id=$1',[f.appointment])).notes,'Original owned note');
    }finally{await revoker.query('rollback').catch(()=>{});await pending;await caller.end();await revoker.end();await f.close();}
  });
  await t.test('116 admitted mutation pins authority through commit; the later revoker waits',async()=>{
    const f=await make(),caller=await fixture.connect(),revoker=await fixture.connect();let pending;
    try{
      const c=(await one(caller,'select pg_backend_pid() pid')).pid,r=(await one(revoker,'select pg_backend_pid() pid')).pid;
      await caller.query('begin;set local role service_role');assert.equal((await f.patch(caller)).notes,'Owned patch result');
      pending=observed(revoker.query("update staff_users set status='inactive' where id=$1",[f.staff]));await blocking(db,c,r);
      await caller.query('commit');assert.ok((await pending).value);
      assert.equal((await one(db,'select notes from appointments where id=$1',[f.appointment])).notes,'Owned patch result');
      await assert.rejects(()=>f.patch(caller),error=>error.code==='P1162');
    }finally{await caller.query('rollback').catch(()=>{});await pending;await caller.end();await revoker.end();await f.close();}
  });
}

export async function exerciseAppointmentPatchDependencies(db,source,t){
  for(const statement of ['create role owned_legacy_appointment_writer;grant update(notes) on appointments to owned_legacy_appointment_writer;grant owned_legacy_appointment_writer to service_role',
    'create role owned_legacy_appointment_writer;grant update on appointments to owned_legacy_appointment_writer;grant owned_legacy_appointment_writer to service_role'])
    await t.test('116 refuses residual effective column/inherited DML atomically: '+statement,()=>rolledBack(db,async()=>{
      await db.query(statement);await assert.rejects(()=>db.query(source),error=>error.message==='appointment_patch_legacy_write_access_unconfirmed');
    }));
  assert.equal((await one(db,"select to_regprocedure('public.patch_crm_appointment_as_actor(uuid,uuid,uuid,text,uuid,jsonb,jsonb)') value")).value,null);
  await t.test('116 records direct column grants for the subsequent unmodified migration to close',async()=>{
    // PostgreSQL table-level REVOKE also removes that grantee's column grants.
    // Inherited column grants above remain effective and must instead refuse.
    await db.query('grant insert(notes),update(notes) on public.appointments to service_role');
    assert.equal((await one(db,"select has_column_privilege('service_role','public.appointments','notes','INSERT') and has_column_privilege('service_role','public.appointments','notes','UPDATE') allowed")).allowed,true);
  });
}

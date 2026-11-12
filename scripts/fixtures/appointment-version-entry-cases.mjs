import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const legacy='public.patch_crm_appointment_as_actor(uuid,uuid,uuid,text,uuid,jsonb,jsonb)';
const entry='public.patch_crm_appointment_v2(uuid,uuid,uuid,text,uuid,uuid,jsonb,jsonb)';
const oldSql='select public.patch_crm_appointment_as_actor($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) value';
const sql='select public.patch_crm_appointment_v2($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) value';
const one=async(db,statement,args=[])=>(await db.query(statement,args)).rows[0];
async function rollback(db,action){await db.query('begin');try{await action();}finally{await db.query('rollback');}}
async function owned(db){
  const f=Object.fromEntries(['workspace','staff','actor','appointment'].map(key=>[key,randomUUID()]));
  await db.query("insert into workspaces(id,name) values($1,'Owned version entry')",[f.workspace]);
  await db.query("insert into staff_users(id,workspace_id,auth_user_id,full_name,email,role,status) values($1,$2,$3,'Owned editor',$4,'owner','active')",
    [f.staff,f.workspace,f.actor,f.staff+'@example.invalid']);
  await db.query("insert into appointments(id,workspace_id,status,notes) values($1,$2,'cancelled','Owned original note')",[f.appointment,f.workspace]);
  f.read=async()=>(await one(db,'select to_jsonb(a) value from appointments a where id=$1',[f.appointment])).value;
  f.before=await f.read();
  f.prefix=[f.workspace,f.staff,f.actor,'owner',f.appointment];
  f.close=()=>db.query('delete from workspaces where id=$1',[f.workspace]);
  return f;
}

export async function exerciseAppointmentVersionEntryBefore(db,source,t){
  await t.test('before 118 the legacy service API can refresh its preimage and overwrite an older opened form',async()=>{
    const f=await owned(db);try{
      await db.query("update appointments set notes='Owned concurrent note' where id=$1",[f.appointment]);
      const fresh=await f.read();assert.notEqual(fresh.edit_version,f.before.edit_version);
      await db.query('set role service_role');try{
        assert.equal((await one(db,oldSql,[...f.prefix,JSON.stringify(fresh),JSON.stringify({notes:'Owned old API overwrite'})])).value.notes,'Owned old API overwrite');
      }finally{await db.query('reset role');}
    }finally{await f.close();}
  });
  for(const change of [
    'alter table appointments disable trigger stamp_appointment_edit_version',
    'alter table appointments alter column edit_version drop not null',
    'alter function '+legacy+' security invoker',
    'grant update(notes) on appointments to service_role',
    'create role owned_legacy_patch_caller;grant execute on function '+legacy+' to owned_legacy_patch_caller;grant owned_legacy_patch_caller to service_role',
  ])await t.test('118 refuses an incompatible baseline or residual effective legacy grant: '+change,()=>rollback(db,async()=>{
    await db.query(change);await assert.rejects(()=>db.query(source),error=>['appointment_version_entry_dependencies_unconfirmed','appointment_version_entry_legacy_access_unconfirmed'].includes(error.message));
  }));
  assert.equal((await one(db,'select to_regprocedure($1) value',[entry])).value,null);
  assert.equal((await one(db,"select has_function_privilege('service_role',$1,'EXECUTE') allowed",[legacy])).allowed,true);
}

export async function exerciseAppointmentVersionEntry(db,source,t){
  for(const role of ['anon','authenticated','service_role'])await t.test('118 closes actual '+role+' execution of the precondition-free legacy writer',async()=>{
    await db.query('set role '+role);try{await assert.rejects(()=>db.query(oldSql,Array(7).fill(null)),error=>error.code==='42501');}
    finally{await db.query('reset role');}
  });
  for(const role of ['anon','authenticated'])await t.test('118 keeps the current version entry closed to '+role,async()=>{
    await db.query('set role '+role);try{await assert.rejects(()=>db.query(sql,Array(8).fill(null)),error=>error.code==='42501');}
    finally{await db.query('reset role');}
  });
  for(const scenario of ['null','stale','fresh-token-stale-fields','fresh'])await t.test('118 independent opening precondition: '+scenario,async()=>{
    const f=await owned(db);try{
      await db.query("update appointments set notes='Owned concurrent note' where id=$1",[f.appointment]);
      const fresh=await f.read();
      const expected=scenario==='null'?null:scenario==='stale'?f.before.edit_version:fresh.edit_version;
      const before=scenario==='fresh-token-stale-fields'?f.before:fresh;
      const args=[...f.prefix,expected,JSON.stringify(before),JSON.stringify({notes:'Owned reviewed note'})];
      await db.query('set role service_role');try{
        if(scenario==='fresh'){
          const result=(await one(db,sql,args)).value;assert.equal(result.notes,'Owned reviewed note');assert.notEqual(result.edit_version,fresh.edit_version);
        }else await assert.rejects(()=>db.query(sql,args),error=>error.code===(scenario==='null'?'P1181':'P1164'));
      }finally{await db.query('reset role');}
      assert.equal((await f.read()).notes,scenario==='fresh'?'Owned reviewed note':'Owned concurrent note');
    }finally{await f.close();}
  });
  await t.test('118 exact rerun refuses review rather than reopening or replacing either entry',()=>rollback(db,async()=>{
    await assert.rejects(()=>db.query(source),error=>error.message==='appointment_version_entry_already_installed_requires_review');
  }));
}

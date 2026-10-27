import assert from 'node:assert/strict';
import { appointmentActorReadinessQuery,buildAppointmentActorReadiness } from './appointment-actor-readiness.mjs';
import { legacyAppointmentReadinessQuery } from './appointment-preview-readiness.mjs';

const read='public.read_crm_appointment_request_v2(uuid,uuid,uuid,text,uuid,text)';
const create='public.create_crm_appointment_v2(uuid,uuid,uuid,text,uuid,text,jsonb,jsonb,text)';
const patch='public.patch_crm_appointment_as_actor(uuid,uuid,uuid,text,uuid,jsonb,jsonb)';
const routine='routine:'+read;
const blockers=async db=>(await db.query(appointmentActorReadinessQuery)).rows.filter(r=>!r.ready).map(r=>r.check_name);

export async function exerciseAppointmentReadinessBeforeCutover(db,t){
  await t.test('current gate refuses a real legacy-ready schema before 115',async()=>{
    assert.deepEqual((await db.query(legacyAppointmentReadinessQuery)).rows.filter(r=>!r.ready),[], 'This reproduces why the old gate cannot authorize a v2 release');
    const failures=await blockers(db);assert.ok(failures.includes(routine));assert.ok(failures.includes('receipt:shape:crm_appointment_request_actors'));
    assert.ok(failures.includes('execute:service_role:public.create_crm_appointment_once(uuid,uuid,uuid,text,jsonb,jsonb,text)'));
  });
}

export async function exerciseAppointmentReadiness(db,t){
  await t.test('current metadata gate passes the selected schema and is unique, boolean and bounded',async()=>{
    const result=(await db.query(appointmentActorReadinessQuery)).rows;
    assert.equal(result.length,100);assert.equal(new Set(result.map(r=>r.check_name)).size,result.length);
    assert.ok(result.every(r=>typeof r.ready==='boolean'));assert.deepEqual(result.filter(r=>!r.ready),[]);
  });
  for(const [sql,failure] of [
    ['alter table staff_users rename column auth_user_id to owned_missing_auth','column:staff_users.auth_user_id'],
    ['alter table appointments alter column price_minor type numeric','column:appointments.price_minor'],
    ['grant update on appointments to service_role','appointments:server_access'],
    ['grant update(notes) on appointments to service_role','appointments:server_access'],
    ['revoke select on appointments from service_role','appointments:server_access'],
    [`alter function ${read} rename to owned_missing_v2_reader`,routine],
    [`alter function ${read} owner to service_role`,routine],
    [`alter function ${read} security invoker`,routine],
    [`alter function ${read} set search_path=public`,routine],
    [`grant execute on function ${read} to service_role with grant option`,routine],
    [`revoke execute on function ${create} from service_role`,'execute:service_role:'+create],
    [`alter function ${patch} rename to owned_missing_patch`,'routine:'+patch],
    [`alter function ${patch} security invoker`,'routine:'+patch],
    [`revoke execute on function ${patch} from service_role`,'execute:service_role:'+patch],
    [`grant execute on function ${patch} to public`,'execute:anon:'+patch],
    [`grant execute on function ${read} to public`,'execute:anon:'+read],
    ['grant execute on function public.create_crm_appointment_once(uuid,uuid,uuid,text,jsonb,jsonb,text) to service_role','execute:service_role:public.create_crm_appointment_once(uuid,uuid,uuid,text,jsonb,jsonb,text)'],
    ['alter table crm_appointment_request_actors disable row level security','receipt:shape:crm_appointment_request_actors'],
    ['alter table crm_appointment_create_requests force row level security','receipt:shape:crm_appointment_create_requests'],
    ['grant select(auth_user_id) on crm_appointment_request_actors to anon','receipt:closed:crm_appointment_request_actors:anon'],
    ['create role owned_receipt_reader; grant select on crm_appointment_request_actors to owned_receipt_reader; grant owned_receipt_reader to authenticated','receipt:closed:crm_appointment_request_actors:authenticated'],
    ['create policy owned_receipt_policy on crm_appointment_request_actors for select to authenticated using(true)','receipt:shape:crm_appointment_request_actors'],
    ['drop index clinic_doctors_workspace_staff_user_idx','identity:unique_staff_doctor'],
    ['alter table appointments disable trigger guard_appointment_capacity','capacity:trigger'],
    ['drop trigger guard_appointment_capacity on appointments','capacity:trigger'],
    ['grant service_role to authenticated','roles:browser_boundary'],
    ['alter role service_role nobypassrls','roles:service_boundary'],
    [async db=>{
      const rows=(await db.query("select conname from pg_catalog.pg_constraint where conrelid='public.crm_appointment_request_actors'::regclass and contype='f'")).rows;
      assert.equal(rows.length,1);await db.query('alter table public.crm_appointment_request_actors drop constraint "'+rows[0].conname.replaceAll('"','""')+'"');
    },'receipt:origin_fk'],
  ])await t.test('current metadata gate reports '+failure+' after '+(typeof sql==='string'?sql:'origin FK removal'),async()=>{
    await db.query('begin');try{if(typeof sql==='function')await sql(db);else await db.query(sql);assert.ok((await blockers(db)).includes(failure),JSON.stringify(await blockers(db)));}
    finally{await db.query('rollback');}
    assert.deepEqual(await blockers(db),[],'Rollback restores the selected metadata, not a weakened baseline');
  });
  await t.test('current gate detects a body change without executing the changed domain routine',async()=>{
    const definition=(await db.query('select pg_catalog.pg_get_functiondef($1::regprocedure) body',[read])).rows[0].body;
    assert.ok(definition.includes('appointment_request_origin_unconfirmed'));
    await db.query('begin');try{
      await db.query(definition.replaceAll('appointment_request_origin_unconfirmed','owned_changed_diagnostic'));
      assert.ok((await blockers(db)).includes(routine));
    }finally{await db.query('rollback');}
  });
  await t.test('current gate catches renamed PostgREST arguments even when body and grants are unchanged',async()=>{
    const before=(await db.query('select pg_catalog.pg_get_functiondef($1::regprocedure) definition,prosrc body from pg_catalog.pg_proc where oid=$1::regprocedure',[read])).rows[0];
    assert.ok(before.definition.includes('p_workspace_id uuid'));
    await db.query('begin');try{
      await db.query('drop function '+read);await db.query(before.definition.replace('p_workspace_id uuid','p_other_workspace uuid'));
      await db.query('revoke all on function '+read+' from public,anon,authenticated,service_role;grant execute on function '+read+' to service_role');
      assert.equal((await db.query('select prosrc body from pg_catalog.pg_proc where oid=$1::regprocedure',[read])).rows[0].body,before.body);
      assert.deepEqual(await blockers(db),[routine]);
    }finally{await db.query('rollback');}
  });
  await t.test('generated current gate runs under read-only transaction without business/ACL changes',async()=>{
    const snapshot=async()=> (await db.query(`select
      (select jsonb_agg(w order by id) from public.workspaces w) workspaces,
      (select jsonb_agg(a order by id) from public.appointments a) appointments,
      (select jsonb_agg(r order by request_key) from public.crm_appointment_create_requests r) receipts,
      (select jsonb_agg(p.proacl order by p.oid) from pg_catalog.pg_proc p where p.pronamespace='public'::regnamespace) acl`)).rows[0];
    const before=await snapshot();await db.query(buildAppointmentActorReadiness());assert.deepEqual(await snapshot(),before);
    assert.deepEqual(await blockers(db),[]);
  });
}

export async function exerciseAppointmentPatchReadinessBeforeCutover(db,t){
  await t.test('a complete create/replay schema is not ready for current API PATCH before 116',async()=>{
    assert.deepEqual((await blockers(db)).sort(),['appointments:server_access','routine:'+patch,...['anon','authenticated','service_role'].map(role=>'execute:'+role+':'+patch)].sort());
  });
}

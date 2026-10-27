import assert from 'node:assert/strict';
import { appointmentActorReadinessQuery,appointmentVersionEntryReadinessQuery,buildAppointmentActorReadiness } from './appointment-actor-readiness.mjs';
import { legacyAppointmentReadinessQuery } from './appointment-preview-readiness.mjs';

const read='public.read_crm_appointment_request_v2(uuid,uuid,uuid,text,uuid,text)';
const create='public.create_crm_appointment_v2(uuid,uuid,uuid,text,uuid,text,jsonb,jsonb,text)';
const patch='public.patch_crm_appointment_as_actor(uuid,uuid,uuid,text,uuid,jsonb,jsonb)';
const entry='public.patch_crm_appointment_v2(uuid,uuid,uuid,text,uuid,uuid,jsonb,jsonb)';
const journal='public.patch_crm_appointment_journaled(uuid,uuid,uuid,text,uuid,uuid,jsonb,jsonb,jsonb)';
const entryChecks=['routine:'+entry,...['anon','authenticated','service_role'].map(role=>'execute:'+role+':'+entry)];
const version='public.stamp_appointment_edit_version()';
const versionChecks=['column:appointments.edit_version','routine:'+version,
  ...['anon','authenticated','service_role'].map(role=>'execute:'+role+':'+version),
  'appointments:edit_version_shape','appointments:edit_version_trigger','appointments:before_update_triggers'];
const routine='routine:'+read;
const blockers=async db=>(await db.query(appointmentActorReadinessQuery)).rows.filter(r=>!r.ready).map(r=>r.check_name);
const historicalBlockers=async db=>(await db.query(appointmentVersionEntryReadinessQuery)).rows.filter(r=>!r.ready).map(r=>r.check_name);

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
    assert.equal(result.length,130);assert.equal(new Set(result.map(r=>r.check_name)).size,result.length);
    assert.ok(result.every(r=>typeof r.ready==='boolean'));assert.deepEqual(result.filter(r=>!r.ready),[]);
  });
  for(const [sql,failure] of [
    ['alter table staff_users rename column auth_user_id to owned_missing_auth','column:staff_users.auth_user_id'],
    ['alter table appointments alter column price_minor type numeric','column:appointments.price_minor'],
    ['grant update on appointments to service_role','appointments:server_access'],
    ['grant update(notes) on appointments to service_role','appointments:server_access'],
    ['revoke select on appointments from service_role','appointments:server_access'],
    ['alter table appointments alter column edit_version drop not null','appointments:edit_version_shape'],
    ["alter table appointments alter column edit_version set default '00000000-0000-0000-0000-000000000000'::uuid",'appointments:edit_version_shape'],
    ['alter table appointments disable trigger stamp_appointment_edit_version','appointments:edit_version_trigger'],
    ['alter function '+version+' security definer','routine:'+version],
    ['grant execute on function '+version+' to service_role','execute:service_role:'+version],
    [`alter function ${read} rename to owned_missing_v2_reader`,routine],
    [`alter function ${read} owner to service_role`,routine],
    [`alter function ${read} security invoker`,routine],
    [`alter function ${read} set search_path=public`,routine],
    [`grant execute on function ${read} to service_role with grant option`,routine],
    [`revoke execute on function ${create} from service_role`,'execute:service_role:'+create],
    [`alter function ${patch} rename to owned_missing_patch`,'routine:'+patch],
    [`alter function ${patch} security invoker`,'routine:'+patch],
    [`grant execute on function ${patch} to service_role`,'execute:service_role:'+patch],
    [`grant execute on function ${entry} to service_role`,'execute:service_role:'+entry],
    [`revoke execute on function ${journal} from service_role`,'execute:service_role:'+journal],
    [`grant execute on function ${journal} to public`,'execute:anon:'+journal],
    [`alter function ${journal} security invoker`,'routine:'+journal],
    ['alter table audit_logs disable row level security','audit:shape'],
    ['grant select(metadata) on audit_logs to authenticated','audit:closed:authenticated'],
    ['alter table audit_logs rename column actor_kind to owned_missing_kind','column:audit_logs.actor_kind'],
    [`grant execute on function ${entry} to public`,'execute:anon:'+entry],
    [`alter function ${entry} security invoker`,'routine:'+entry],
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
    assert.deepEqual((await historicalBlockers(db)).sort(),['appointments:server_access','routine:'+patch,...['anon','authenticated','service_role'].map(role=>'execute:'+role+':'+patch),...versionChecks,...entryChecks].sort());
  });
}

export async function exerciseAppointmentVersionReadinessBeforeCutover(db,t){
  await t.test('current API refuses the otherwise complete 116 schema without the 117 edit version',async()=>{
    assert.deepEqual((await historicalBlockers(db)).sort(),[...versionChecks,...entryChecks,'execute:service_role:'+patch].sort());
  });
}

export async function exerciseAppointmentEntryReadinessBeforeCutover(db,t){
  await t.test('117 alone cannot authorize the current version-bound API while legacy service execution remains open',async()=>{
    assert.deepEqual((await historicalBlockers(db)).sort(),[...entryChecks,'execute:service_role:'+patch].sort());
  });
}

export async function exerciseAppointmentJournalReadinessBeforeCutover(db,t){
  await t.test('118 alone cannot authorize the journaled API or its legacy-service closure',async()=>{
    assert.deepEqual(await historicalBlockers(db),[]);
    assert.deepEqual((await blockers(db)).sort(),['routine:'+journal,...['anon','authenticated','service_role'].map(role=>'execute:'+role+':'+journal),
      'execute:service_role:'+entry].sort());
  });
}

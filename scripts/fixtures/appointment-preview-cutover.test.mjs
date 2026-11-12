import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startNativePostgres } from './native-postgres.mjs';
import { readReviewedChain } from './migration-chain-review.mjs';
import { appointmentVersionEntryReadinessQuery as appointmentActorReadinessQuery,appointmentActorReadinessQuery as currentReadinessQuery } from './appointment-actor-readiness.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const baselineNumbers=new Set([9,10,11,12,13,14,19,20,29,30,32,33,34,35,36,40,43,45,52,53,54,55,56,57,61,63,64,72,73,76]);
const deltaFiles=['102_appointment_capacity_explicit_identity.sql','115_appointment_request_actor.sql',
  '116_appointment_patch_actor.sql','117_appointment_edit_version.sql','118_appointment_version_entry.sql'];
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const readiness=async db=>Object.fromEntries((await db.query(appointmentActorReadinessQuery)).rows.map(row=>[row.check_name,row.ready]));
async function role(db,name,action){await db.query('set role '+name);try{return await action();}finally{await db.query('reset role');}}
const inventorySql=`with requested(signature) as (select unnest($1::text[])) select jsonb_build_object(
  'inspector',current_user,
  'routines',(select jsonb_agg(jsonb_build_object(
    'signature',r.signature,'exists',p.oid is not null,'owner',pg_catalog.pg_get_userbyid(p.proowner),
    'security_definer',p.prosecdef,'volatility',p.provolatile,'config',p.proconfig,
    'body_sha256',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.replace(p.prosrc,E'\\r\\n',E'\\n'),'UTF8')),'hex'),
    'service_execute',case when p.oid is null then null else pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE') end,
    'anon_execute',case when p.oid is null then null else pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE') end,
    'authenticated_execute',case when p.oid is null then null else pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE') end
  ) order by r.signature) from requested r left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(r.signature)),
  'before_update_triggers',(select coalesce(jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,
    'type',t.tgtype,'function',t.tgfoid::regprocedure::text) order by t.tgname),'[]'::jsonb)
    from pg_catalog.pg_trigger t where t.tgrelid=pg_catalog.to_regclass('public.appointments') and not t.tgisinternal and (t.tgtype::int & 19)=19),
  'origin_relation',pg_catalog.to_regclass('public.crm_appointment_request_actors')::text,
  'version_column',exists(select 1 from pg_catalog.pg_attribute where attrelid=pg_catalog.to_regclass('public.appointments')
    and attname='edit_version' and not attisdropped)) inventory`;

test('selected source cutover matches the observed test catalog, without claiming a full target clone',{timeout:240000},async t=>{
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE,'1','Only an explicitly selected owned native fixture is allowed');
  const observed=JSON.parse(await readFile(new URL('./appointment-preview-catalog-20261027.json',import.meta.url),'utf8'));
  assert.equal(observed.source.project,'medina-os-site-test');assert.equal(observed.version,1);
  assert.equal(observed.source.projectRef,'ukiobbwsdoblooynzlnx');
  assert.equal(observed.source.querySha256,'8f16cfe53e02a51450623a2d2d10dbe48b0efeb784053b25e27317aadc20e5bd');
  assert.equal(observed.source.reasonQuerySha256,'f8ef0799cae557593e66502068cd6ff7cbb157acff0abf3f7b2dbe61a9b4e03e');
  assert.equal(Object.keys(observed.checks).length,112);assert.equal(Object.values(observed.checks).filter(Boolean).length,69);
  const chain=await readReviewedChain(path.join(root,'migrations'));
  const baseline=chain.filter(row=>baselineNumbers.has(Number(row.file.slice(0,3))));
  const delta=deltaFiles.map(file=>{const row=chain.find(row=>row.file===file);assert.ok(row);return row;});
  assert.equal(baseline.length,baselineNumbers.size);assert.equal(delta.length,5);
  const fixture=await startNativePostgres();t.after(()=>fixture.close());const db=await fixture.connect();
  await db.query('create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;grant usage on schema public to anon,authenticated,service_role');
  for(const entry of baseline)await db.query(entry.source);
  await t.test('source-only baseline reproduces all 112 observed booleans and exact routine/trigger reasons',async()=>{
    assert.deepEqual(await readiness(db),observed.checks);
    assert.deepEqual((await one(db,inventorySql,[observed.inventory.routines.map(row=>row.signature)])).inventory,observed.inventory);
    t.diagnostic('69 true / 43 false match the catalog slice, not a clone of all target objects, data or pending outcomes');
  });
  const f=Object.fromEntries(['workspace','staff','actor','doctor','client','legacyKey','newKey'].map(key=>[key,randomUUID()]));
  let legacy;
  const visit={workspace_id:f.workspace,created_by_staff_user_id:f.staff,client_id:f.client,client_name:'Owned historical client',
    doctor_id:f.doctor,doctor_name:'Owned clinician',starts_at:'2090-10-20T09:00:00Z',duration_minutes:45,
    price_minor:0,status:'cancelled',service:'Owned technical service',notes:'Owned original note'};
  await db.query("insert into workspaces(id,name) values($1,'Owned cutover workspace')",[f.workspace]);
  await db.query("insert into staff_users(id,workspace_id,auth_user_id,full_name,email,role,status) values($1,$2,$3,'Owned clinician',$4,'owner','active')",
    [f.staff,f.workspace,f.actor,f.staff+'@example.invalid']);
  await db.query("insert into clients(id,workspace_id,full_name) values($1,$2,'Owned historical client')",[f.client,f.workspace]);
  await db.query("insert into clinic_doctors(id,workspace_id,staff_user_id,full_name,capacity) values($1,$2,$3,'Owned clinician',2)",[f.doctor,f.workspace,f.staff]);
  const counts=()=>one(db,`select (select count(*)::int from appointments where workspace_id=$1) visits,
    (select count(*)::int from crm_appointment_create_requests where workspace_id=$1) receipts,
    (select count(*)::int from crm_appointment_request_actors where workspace_id=$1) origins,
    (select count(*)::int from deals where workspace_id=$1) sales`,[f.workspace]);
  const beforeSnapshot=()=>one(db,`select
    (select jsonb_agg(jsonb_build_object('value',to_jsonb(a)-'edit_version','ctid',a.ctid::text,'xmin',a.xmin::text) order by a.id)
      from appointments a where workspace_id=$1) visits,
    (select jsonb_agg(r order by request_key) from crm_appointment_create_requests r where workspace_id=$1) receipts,
    (select jsonb_agg(c order by id) from clients c where workspace_id=$1) clients,
    (select jsonb_agg(s order by id) from staff_users s where workspace_id=$1) staff,
    (select jsonb_agg(d order by id) from clinic_doctors d where workspace_id=$1) doctors`,[f.workspace]);
  await t.test('the old server creates one genuine legacy receipt before the coordinated source delta',async()=>{
    const args=[f.workspace,f.staff,f.legacyKey,'a'.repeat(64),JSON.stringify(visit),'provided'];
    legacy=await role(db,'service_role',async()=>{
      const first=(await one(db,'select public.create_crm_appointment_once($1,$2,$3,$4,null,$5::jsonb,$6) value',args)).value;
      const replay=(await one(db,'select public.create_crm_appointment_once($1,$2,$3,$4,null,$5::jsonb,$6) value',args)).value;
      assert.equal(first.replayed,false);assert.equal(replay.replayed,true);assert.equal(first.appointment.id,replay.appointment.id);return first;
    });
  });
  const before=await beforeSnapshot();
  for(const entry of delta){
    let applied=false;
    await t.test('apply only selected original '+entry.file,async()=>{await db.query(entry.source);applied=true;t.diagnostic(entry.sha256);});
    assert.equal(applied,true,'Do not continue or add compensating SQL after a refused migration');
  }
  await t.test('only the five-file source delta closes all 112 observed metadata blockers',async()=>{
    const checks=await readiness(db);assert.equal(Object.keys(checks).length,112);assert.deepEqual(Object.entries(checks).filter(([,ready])=>!ready),[]);
    assert.deepEqual(await beforeSnapshot(),before,'No pre-existing field, receipt, contact, staff role or appointment tuple was rewritten');
    assert.equal((await one(db,'select edit_version::text version from appointments where id=$1',[legacy.appointment.id])).version,'00000000-0000-0000-0000-000000000000');
    assert.deepEqual(await counts(),{visits:1,receipts:1,origins:0,sales:0});
  });
  await t.test('legacy outcome remains explicit and is never backfilled or re-created under the current identity',async()=>{
    await role(db,'service_role',async()=>{
      const args=[f.workspace,f.staff,f.actor,'owner',f.legacyKey,'a'.repeat(64)];
      await assert.rejects(()=>db.query('select public.read_crm_appointment_request_v2($1,$2,$3,$4,$5,$6)',args),error=>error.code==='P6403');
      await assert.rejects(()=>db.query('select public.create_crm_appointment_v2($1,$2,$3,$4,$5,$6,null,$7::jsonb,$8)',[...args,JSON.stringify(visit),'provided']),error=>error.code==='P6403');
      await assert.rejects(()=>db.query('select public.read_crm_appointment_create_request($1,$2,$3,$4)',[f.workspace,f.staff,f.legacyKey,'a'.repeat(64)]),error=>error.code==='42501');
      await assert.rejects(()=>db.query('update appointments set notes=notes where false'),error=>error.code==='42501');
    });
    assert.deepEqual(await beforeSnapshot(),before);assert.deepEqual(await counts(),{visits:1,receipts:1,origins:0,sales:0});
  });
  await t.test('new origin-bound create, replay and versioned edit work without a duplicate or a payment',async()=>{
    await role(db,'service_role',async()=>{
      const args=[f.workspace,f.staff,f.actor,'owner',f.newKey,'b'.repeat(64),JSON.stringify({...visit,notes:'Owned new visit'}),'provided'];
      const create=async()=>(await one(db,'select public.create_crm_appointment_v2($1,$2,$3,$4,$5,$6,null,$7::jsonb,$8) value',args)).value;
      const first=await create(),replayed=await create();assert.equal(first.replayed,false);assert.equal(replayed.replayed,true);
      assert.equal(first.appointment.id,replayed.appointment.id);assert.notEqual(first.appointment.edit_version,'00000000-0000-0000-0000-000000000000');
      const patchArgs=[f.workspace,f.staff,f.actor,'owner',first.appointment.id,first.appointment.edit_version,
        JSON.stringify(first.appointment),JSON.stringify({notes:'Owned reviewed note'})];
      const saved=(await one(db,'select public.patch_crm_appointment_v2($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) value',patchArgs)).value;
      assert.equal(saved.notes,'Owned reviewed note');assert.notEqual(saved.edit_version,first.appointment.edit_version);
      patchArgs[6]=JSON.stringify(saved);
      await assert.rejects(()=>db.query('select public.patch_crm_appointment_v2($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)',patchArgs),error=>error.code==='P1164');
    });
    assert.deepEqual(await counts(),{visits:2,receipts:2,origins:1,sales:0});
    assert.equal((await one(db,'select auth_user_id from crm_appointment_request_actors where workspace_id=$1',[f.workspace])).auth_user_id,f.actor);
    assert.equal((await one(db,'select count(*)::int n from workspace_settings where workspace_id=$1',[f.workspace])).n,0);
  });
  await t.test('the selected sixth source 119 adds journal atomicity and closes the prior service entry',async()=>{
    const entry=chain.find(row=>row.file==='119_appointment_patch_journal.sql');assert.ok(entry);await db.query(entry.source);
    const checks=(await db.query(currentReadinessQuery)).rows;assert.equal(checks.length,130);assert.deepEqual(checks.filter(row=>!row.ready),[]);
    const before=(await one(db,'select to_jsonb(a) value from appointments a where id=$1',[legacy.appointment.id])).value;
    const args=[f.workspace,f.staff,f.actor,'owner',before.id,before.edit_version,JSON.stringify(before),JSON.stringify({notes:'Owned atomic cutover note'}),
      JSON.stringify({actorName:'owned@example.invalid',outsideSchedule:false,changes:[{field:'notes',label:'Заметка',from:null,to:null}]})];
    await role(db,'service_role',async()=>{
      await assert.rejects(()=>db.query('select public.patch_crm_appointment_v2($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)',args.slice(0,8)),error=>error.code==='42501');
      const saved=(await one(db,'select public.patch_crm_appointment_journaled($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb) value',args)).value;
      assert.equal(saved.notes,'Owned atomic cutover note');assert.notEqual(saved.edit_version,before.edit_version);
      await assert.rejects(()=>db.query('select public.patch_crm_appointment_journaled($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)',args),error=>error.code==='P1164');
    });
    assert.equal((await one(db,'select count(*)::int n from audit_logs where workspace_id=$1',[f.workspace])).n,1);
    assert.deepEqual(await counts(),{visits:2,receipts:2,origins:1,sales:0});
  });
  await db.query('delete from workspaces where id=$1',[f.workspace]);
  await t.test('all owned rows are removed and no external facility or main source mutation is accepted',async()=>{
    for(const table of ['workspaces','staff_users','clients','appointments','crm_appointment_create_requests','crm_appointment_request_actors','deals','audit_logs'])
      assert.equal((await one(db,'select count(*)::int n from public.'+table)).n,0,table);
    assert.equal((await one(db,'select count(*)::int n from pg_foreign_server')).n,0);
    assert.equal((await one(db,'select count(*)::int n from pg_subscription')).n,0);
    assert.deepEqual((await readReviewedChain(path.join(root,'migrations'))).map(row=>[row.file,row.sha256]),chain.map(row=>[row.file,row.sha256]));
  });
  t.diagnostic('Only an owned source-baseline compatibility proof. No target DDL/data dump, cloud write, real Auth, Preview deployment, provider, payment or claim about unknown target data/triggers.');
});

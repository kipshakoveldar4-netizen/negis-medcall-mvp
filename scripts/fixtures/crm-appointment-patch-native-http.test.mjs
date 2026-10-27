import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { startNativePostgres } from './native-postgres.mjs';
import { readReviewedChain } from './migration-chain-review.mjs';
import { partnerEntryHttpFixture,stopPartnerEntryBuilds } from './partner-entry-http-fixture.mjs';
import { appointmentNativeAdapter,appointmentNativeServer,provisionAppointmentNative } from './crm-appointment-native-http-fixture.mjs';
import { ids,visit,root,recoveryBundle,stopRecoveryBundler,ownedRecoveryBrowser } from '../src/appointment-recovery-committed-fixture.ts';
import { exerciseAppointmentPatch } from './appointment-patch-cases.mjs';

test('appointment PATCH pins the HTTP actor at the actual SQL write',{timeout:300000},async t=>{
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE,'1');
  t.after(stopPartnerEntryBuilds);
  t.after(stopRecoveryBundler);
  const chain=await readReviewedChain(path.join(root,'migrations')),fixture=await startNativePostgres();t.after(()=>fixture.close());
  const db=await fixture.connect();
  await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    grant usage on schema public to anon,authenticated,service_role;create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);
    alter table storage.objects enable row level security;`);
  for(const entry of chain)await db.query(entry.source);
  const transport=appointmentNativeAdapter(fixture),http=await partnerEntryHttpFixture(transport.adapter,{approved:false,
    identities:new Map([[`owned.${ids.A}.signature`,ids.A]]),env:{MEDINA_PARTNER_ENTRY_ENABLED:'false'}});
  t.after(()=>http.close());
  const server=await appointmentNativeServer(http.handler);t.after(()=>server.close());
  const patch=async(updates={notes:'Owned edited note'},method='PATCH')=>{
    const response=await fetch(server.origin+'/api/crm/appointments?workspaceId='+ids.workspace,{method,
      headers:{authorization:`Bearer owned.${ids.A}.signature`,'Content-Type':'application/json'},
      body:JSON.stringify({id:ids.appointment,workspaceId:ids.workspace,updates})});
    return {status:response.status,body:await response.json()};
  };
  async function setup(role='owner'){
    const f=await provisionAppointmentNative(db,role);
    await db.query(`insert into appointments(id,workspace_id,client_id,client_name,client_phone,whatsapp,doctor_id,doctor_name,
      starts_at,duration_minutes,price_minor,status,service,notes,created_by_staff_user_id,created_at,updated_at)
      values($1,$2,$3,$4,$5,$5,$6,$7,$8,45,120000,'scheduled',$9,'Owned original note',$10,
        '2026-10-20T00:00:00.123456Z','2026-10-20T00:00:00.654321Z')`,
      [ids.appointment,ids.workspace,ids.client,visit.client,visit.phone,ids.doctor,visit.doctor,visit.startsAt,visit.service,f.staff]);
    f.read=async()=> (await db.query('select notes,status,doctor_id,client_phone from appointments where id=$1',[ids.appointment])).rows[0];
    f.fullRead=async()=> (await db.query('select to_jsonb(a) value from appointments a where id=$1',[ids.appointment])).rows[0].value;
    return f;
  }
  for(const role of ['owner','admin','receptionist','manager','doctor'])await t.test(role+' can update an authorized unchanged visit',async()=>{
    const f=await setup(role);try{
      const result=await patch();assert.equal(result.status,200,JSON.stringify(result));
      assert.equal((await f.read()).notes,'Owned edited note');assert.equal(result.body.data.item.id,ids.appointment);
    }finally{await f.close();}
  });
  for(const change of ['role','allowed-role','auth','status'])await t.test('a concurrent '+change+' replacement must deny before any appointment or audit change',async()=>{
    const f=await setup();let changed=false;
    try{
      transport.controls.beforePatch=async()=>{if(changed)return;changed=true;
        if(change==='role')await db.query("update staff_users set role='marketer' where id=$1",[f.staff]);
        if(change==='allowed-role')await db.query("update staff_users set role='doctor' where id=$1",[f.staff]);
        if(change==='auth')await db.query('update staff_users set auth_user_id=$1 where id=$2',[randomUUID(),f.staff]);
        if(change==='status')await db.query("update staff_users set status='inactive' where id=$1",[f.staff]);};
      const result=await patch({notes:'Must not persist',allowOutsideSchedule:true});
      assert.equal(changed,true);assert.equal(result.status,403,JSON.stringify(result));
      assert.equal((await f.read()).notes,'Owned original note');assert.equal((await f.counts()).audits,0);
      assert.equal(JSON.stringify(result.body).includes(visit.phone),false);
    }finally{transport.controls.beforePatch=null;await f.close();}
  });
  for(const change of ['appointment','doctor-card'])await t.test('a doctor loses own-work '+change+' before mutation without an echo of the foreign row',async()=>{
    const f=await setup('doctor');let changed=false;
    try{
      const other=randomUUID();await db.query("insert into clinic_doctors(id,workspace_id,full_name,capacity) values($1,$2,'Owned other doctor',2)",[other,ids.workspace]);
      transport.controls.beforePatch=async()=>{if(changed)return;changed=true;
        if(change==='appointment')await db.query('update appointments set doctor_id=$1,doctor_name=$2 where id=$3',[other,'Owned other doctor',ids.appointment]);
        else await db.query('update clinic_doctors set staff_user_id=$1 where id=$2',[f.otherStaff,ids.doctor]);};
      const result=await patch();assert.equal(changed,true);assert.equal(result.status,404,JSON.stringify(result));
      assert.equal((await f.read()).notes,'Owned original note');assert.equal((await f.counts()).audits,0);
      assert.equal(JSON.stringify(result.body).includes(visit.phone),false);
    }finally{transport.controls.beforePatch=null;await f.close();}
  });
  await t.test('a changed preimage is a refresh conflict even when another writer reuses updated_at',async()=>{
    const f=await setup();let changed=false;
    try{
      transport.controls.beforePatch=async()=>{if(changed)return;changed=true;await db.query("update appointments set notes='Owned concurrent note' where id=$1",[ids.appointment]);};
      const result=await patch();assert.equal(changed,true);assert.equal(result.status,409,JSON.stringify(result));
      assert.equal((await f.read()).notes,'Owned concurrent note');assert.equal((await f.counts()).audits,0);
    }finally{transport.controls.beforePatch=null;await f.close();}
  });
  await t.test('DELETE stays unregistered, not a new service-role deletion path',async()=>{
    const f=await setup();try{const result=await patch({},'DELETE');assert.equal(result.status,405);assert.ok(await f.read());}
    finally{await f.close();}
  });
  const script=await recoveryBundle({jwtLikeTokens:true});
  for(const scenario of ['allowed','revoked','reassigned'])await t.test('actual React edit + HTTP + SQL: '+scenario,async()=>{
    const f=await setup(scenario==='allowed'?'owner':'doctor'),ui=await appointmentNativeServer(http.handler,script);let browser;
    try{
      const item=await f.fullRead();browser=await ownedRecoveryBrowser(ui.origin);const run=browser.evaluate,wait=browser.waitFor;
      if(scenario!=='allowed')await run("f.role('doctor');");
      await run(`f.edit(${JSON.stringify(item)});f.view.setForm(current=>({...current,notes:'Owned UI edit'}));await f.tick();`);
      assert.equal((await run('return f.snapshot();')).form.phone,visit.phone);
      if(scenario==='revoked')transport.controls.beforePatch=async()=>{await db.query("update staff_users set status='inactive' where id=$1",[f.staff]);};
      if(scenario==='reassigned'){
        const other=randomUUID();await db.query("insert into clinic_doctors(id,workspace_id,full_name,capacity) values($1,$2,'Owned replacement doctor',2)",[other,ids.workspace]);
        transport.controls.beforePatch=async()=>{await db.query('update appointments set doctor_id=$1,doctor_name=$2 where id=$3',[other,'Owned replacement doctor',ids.appointment]);};
      }
      await run('f.start();');await wait('f.tasks[0]?.done');const result=await run('return f.snapshot();');
      assert.equal(ui.controls.responses[0]?.status,scenario==='allowed'?200:scenario==='revoked'?403:404,JSON.stringify(ui.controls.responses));
      if(scenario==='allowed'){
        assert.equal(result.items[0].notes,'Owned UI edit');assert.equal((await f.read()).notes,'Owned UI edit');assert.equal(result.successes.length,1);
      }else{
        assert.equal((await f.read()).notes,'Owned original note');assert.equal(result.form.client,'');assert.equal(result.form.phone,'');
        assert.equal(result.form.notes,'');assert.equal(result.modalOpen,false);assert.deepEqual(result.items,[]);assert.deepEqual(result.successes,[]);
      }
      assert.deepEqual(ui.controls.errors,[]);assert.deepEqual(browser.exceptions,[]);
      assert.ok(browser.requests.every(url=>new URL(url).origin===ui.origin),'Only owned loopback requests');
    }finally{transport.controls.beforePatch=null;await browser?.close();await ui.close();await f.close();}
  });
  assert.deepEqual(http.state.unexpected,[]);assert.deepEqual(server.controls.errors,[]);
  assert.ok(transport.controls.calls.length>0&&transport.controls.calls.every(call=>call.name==='patch_crm_appointment_as_actor'));
  assert.ok(transport.controls.writes.every(write=>write.table==='audit_logs'),'No direct appointment UPDATE fallback');
  await exerciseAppointmentPatch(db,fixture,t);
});

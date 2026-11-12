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
    identities:new Map([[`owned.${ids.A}.signature`,ids.A],[`owned.${ids.B}.signature`,ids.B]]),env:{MEDINA_PARTNER_ENTRY_ENABLED:'false'}});
  t.after(()=>http.close());
  const server=await appointmentNativeServer(http.handler);t.after(()=>server.close());
  let openedEditVersion;
  const patch=async(updates={notes:'Owned edited note'},method='PATCH',options={})=>{
    const response=await fetch(server.origin+'/api/crm/appointments?workspaceId='+ids.workspace,{method,
      headers:{authorization:`Bearer owned.${options.actor??ids.A}.signature`,'Content-Type':'application/json'},
      body:JSON.stringify({id:ids.appointment,workspaceId:ids.workspace,
        ...(!options.omitVersion?{expectedEditVersion:Object.hasOwn(options,'expectedEditVersion')?options.expectedEditVersion:openedEditVersion}:{}),updates})});
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
    openedEditVersion=(await f.fullRead()).edit_version;
    return f;
  }
  for(const role of ['owner','admin','receptionist','manager','doctor'])await t.test(role+' can update an authorized unchanged visit',async()=>{
    const f=await setup(role);try{
      const result=await patch();assert.equal(result.status,200,JSON.stringify(result));
      assert.equal((await f.read()).notes,'Owned edited note');assert.equal(result.body.data.item.id,ids.appointment);
    }finally{await f.close();}
  });
  for(const [name,options,status] of [['missing',{omitVersion:true},428],['null',{expectedEditVersion:null},400],
    ['malformed',{expectedEditVersion:'not-an-edit-version'},400],['stale',{expectedEditVersion:randomUUID()},409]])
    await t.test(name+' expected edit version refuses before any writer or audit',async()=>{
      const f=await setup();try{
        const count=transport.controls.calls.length,result=await patch({notes:'Owned refused note'},'PATCH',options);
        assert.equal(result.status,status,JSON.stringify(result));assert.equal(transport.controls.calls.length,count+(name==='stale'?1:0));
        assert.equal((await f.read()).notes,'Owned original note');assert.equal((await f.counts()).audits,0);
      }finally{await f.close();}
    });
  for(const options of [{},{omitVersion:true}])await t.test('an empty appointment PATCH never returns an invented confirmed row; legacy='+Boolean(options.omitVersion),async()=>{
    const f=await setup();try{
      const count=transport.controls.calls.length,result=await patch({},'PATCH',options);assert.equal(result.status,400,JSON.stringify(result));
      assert.equal(result.body.code,'no_patchable_fields');assert.equal(transport.controls.calls.length,count);
      assert.equal((await f.read()).notes,'Owned original note');assert.equal((await f.counts()).audits,0);
    }finally{await f.close();}
  });
  await t.test('no version metadata is a 503, never a fallback write',async()=>{
    const f=await setup();let renamed=false;
    try{
      await db.query('alter table appointments rename column edit_version to owned_missing_edit_version');renamed=true;
      const count=transport.controls.calls.length,result=await patch();assert.equal(result.status,503,JSON.stringify(result));
      assert.equal(result.body.code,'appointment_edit_version_unavailable');assert.equal(transport.controls.calls.length,count);
      assert.equal((await f.read()).notes,'Owned original note');assert.equal((await f.counts()).audits,0);
    }finally{if(renamed)await db.query('alter table appointments rename column owned_missing_edit_version to edit_version');await f.close();}
  });
  await t.test('a missing version-bound writer refuses instead of calling the legacy entry or direct UPDATE',async()=>{
    const f=await setup();let renamed=false;
    try{
      await db.query('alter function public.patch_crm_appointment_journaled(uuid,uuid,uuid,text,uuid,uuid,jsonb,jsonb,jsonb) rename to owned_missing_version_writer');renamed=true;
      const count=transport.controls.calls.length,result=await patch();assert.equal(result.status,503,JSON.stringify(result));
      assert.equal(result.body.code,'appointment_patch_unavailable');assert.equal(transport.controls.calls.length,count+1);
      assert.equal(transport.controls.calls.at(-1).name,'patch_crm_appointment_journaled');
      assert.equal((await f.read()).notes,'Owned original note');assert.equal((await f.counts()).audits,0);
    }finally{
      if(renamed)await db.query('alter function public.owned_missing_version_writer(uuid,uuid,uuid,text,uuid,uuid,jsonb,jsonb,jsonb) rename to patch_crm_appointment_journaled');
      await f.close();
    }
  });
  await t.test('a stale status click and override flags cannot undo another account save',async()=>{
    const f=await setup();try{
      const other=await patch({status:'confirmed'},'PATCH',{actor:ids.B});assert.equal(other.status,200,JSON.stringify(other));
      const count=transport.controls.calls.length,result=await patch({status:'cancelled',allowConflict:true,allowOutsideSchedule:true});
      assert.equal(result.status,409,JSON.stringify(result));assert.equal(transport.controls.calls.length,count+1);
      assert.equal((await f.read()).status,'confirmed');assert.equal((await f.counts()).audits,1);
    }finally{await f.close();}
  });
  await t.test('the opened version catches a prior write even when updated_at is reused',async()=>{
    const f=await setup();try{
      const before=await f.fullRead();await db.query("update appointments set notes='Owned earlier concurrent note' where id=$1",[ids.appointment]);
      const after=await f.fullRead();assert.equal(after.updated_at,before.updated_at);assert.notEqual(after.edit_version,before.edit_version);
      const count=transport.controls.calls.length,result=await patch();assert.equal(result.status,409,JSON.stringify(result));
      assert.equal(transport.controls.calls.length,count+1);assert.equal((await f.read()).notes,'Owned earlier concurrent note');
    }finally{await f.close();}
  });
  await t.test('offered edit-version fields cannot choose or reset the server token',async()=>{
    const f=await setup();try{
      const offered=randomUUID(),result=await patch({notes:'Owned safe note',edit_version:offered,editVersion:offered});
      assert.equal(result.status,200,JSON.stringify(result));const after=await f.fullRead();
      assert.notEqual(after.edit_version,offered);assert.notEqual(after.edit_version,openedEditVersion);
      assert.equal(result.body.data.item.editVersion,after.edit_version);
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
  for(const mode of ['throw-first','throw-second','drop','mutate'])await t.test('actual HTTP/SQL: '+mode+' journal failure rolls back the visit and arrival sale',async()=>{
    const f=await setup(),before=await f.fullRead();
    try{
      const failure="raise exception using errcode='P1192',message='PRIVATE_OWNED_AUDIT_FAILURE'";
      const behavior=mode==='throw-first'?failure:mode==='throw-second'?`if new.action='updated' then ${failure};end if;return new`:mode==='drop'?'return null':"new.entity_id='owned_wrong_entity';return new";
      await db.query(`create function public.owned_http_audit_failure() returns trigger language plpgsql as $$begin ${behavior};end$$;
        create trigger owned_http_audit_failure before insert on audit_logs for each row execute function public.owned_http_audit_failure()`);
      const count=transport.controls.calls.length,result=await patch({status:'arrived',allowOutsideSchedule:true});
      assert.equal(result.status,503,JSON.stringify(result));assert.equal(result.body.code,'appointment_patch_unavailable');
      assert.equal(JSON.stringify(result.body).includes('PRIVATE_OWNED_AUDIT_FAILURE'),false);
      assert.equal(transport.controls.calls.length,count+1);assert.deepEqual(await f.fullRead(),before);
      assert.equal((await f.counts()).audits,0);
      assert.equal((await db.query('select count(*)::int n from deals where workspace_id=$1',[ids.workspace])).rows[0].n,0);
    }finally{await db.query('drop trigger if exists owned_http_audit_failure on audit_logs;drop function if exists public.owned_http_audit_failure()');await f.close();}
  });
  const script=await recoveryBundle({jwtLikeTokens:true});
  await t.test('actual React keeps the draft after a rolled-back journal failure and saves once after repair',async()=>{
    const f=await setup(),ui=await appointmentNativeServer(http.handler,script);let browser;
    try{
      const before=await f.fullRead();browser=await ownedRecoveryBrowser(ui.origin);const run=browser.evaluate,wait=browser.waitFor;
      await db.query(`create function public.owned_http_audit_failure() returns trigger language plpgsql as $$begin return null;end$$;
        create trigger owned_http_audit_failure before insert on audit_logs for each row execute function public.owned_http_audit_failure()`);
      await run(`f.edit(${JSON.stringify(before)});f.view.setForm(current=>({...current,notes:'Owned retained draft'}));await f.tick();f.start();`);
      await wait('f.tasks[0]?.done');const rejected=await run('return f.snapshot();');
      assert.equal(ui.controls.responses[0]?.status,503,JSON.stringify(ui.controls.responses));
      assert.equal(rejected.modalOpen,true);assert.equal(rejected.form.notes,'Owned retained draft');assert.deepEqual(rejected.successes,[]);
      assert.deepEqual(await f.fullRead(),before);assert.equal((await f.counts()).audits,0);
      await db.query('drop trigger owned_http_audit_failure on audit_logs;drop function public.owned_http_audit_failure()');
      await run('f.start();');await wait('f.tasks[1]?.done');const saved=await run('return f.snapshot();');
      assert.equal(ui.controls.responses[1]?.status,200);assert.equal(saved.successes.length,1);assert.equal((await f.read()).notes,'Owned retained draft');
      assert.equal((await f.counts()).audits,1);assert.deepEqual(ui.controls.errors,[]);assert.deepEqual(browser.exceptions,[]);
    }finally{await db.query('drop trigger if exists owned_http_audit_failure on audit_logs;drop function if exists public.owned_http_audit_failure()');await browser?.close();await ui.close();await f.close();}
  });
  for(const refreshed of [false,true])await t.test('a form opened before another account saves cannot overwrite it; background refresh='+refreshed,async()=>{
    const f=await setup(),ui=await appointmentNativeServer(http.handler,script);let browser;
    try{
      browser=await ownedRecoveryBrowser(ui.origin);const run=browser.evaluate,wait=browser.waitFor;
      await run(`f.edit(${JSON.stringify(await f.fullRead())});f.view.setForm(current=>({...current,notes:'Owned unsaved A draft'}));await f.tick();`);
      const other=await patch({notes:'Owned B committed note'},'PATCH',{actor:ids.B});
      assert.equal(other.status,200,JSON.stringify(other));
      if(refreshed)await run(`f.refreshItems(${JSON.stringify(other.body.data.item)});await f.tick();`);
      await run('f.start();');await wait('f.tasks[0]?.done');const result=await run('return f.snapshot();');
      assert.equal(ui.controls.responses[0]?.status,409,JSON.stringify(ui.controls.responses));
      assert.equal((await f.read()).notes,'Owned B committed note');assert.equal((await f.counts()).audits,1);
      assert.equal(result.modalOpen,true);assert.equal(result.form.notes,'Owned unsaved A draft');assert.deepEqual(result.successes,[]);
      assert.ok(result.errors.some(message=>message.includes('Запись уже изменилась')),'A confirmed conflict is not mislabeled as a lost connection');
      assert.equal(ui.controls.responses[0].request.expectedEditVersion,openedEditVersion,'An item refresh cannot replace the open form baseline');
      await run(`f.edit(${JSON.stringify(other.body.data.item)});f.view.setForm(current=>({...current,notes:'Owned A reviewed fresh edit'}));await f.tick();f.start();`);
      await wait('f.tasks[1]?.done');
      assert.equal(ui.controls.responses[1]?.status,200,JSON.stringify(ui.controls.responses));
      assert.equal((await f.read()).notes,'Owned A reviewed fresh edit');
      assert.deepEqual(ui.controls.errors,[]);assert.deepEqual(browser.exceptions,[]);
      assert.ok(browser.requests.every(url=>new URL(url).origin===ui.origin));
    }finally{await browser?.close();await ui.close();await f.close();}
  });
  await t.test('a committed edit with a lost ACK is not attributed to another user or blindly repeated',async()=>{
    const f=await setup(),ui=await appointmentNativeServer(http.handler,script);let browser;
    try{
      browser=await ownedRecoveryBrowser(ui.origin);const run=browser.evaluate,wait=browser.waitFor;
      await run(`f.edit(${JSON.stringify(await f.fullRead())});f.view.setForm(current=>({...current,notes:'Owned saved without ACK'}));await f.tick();`);
      const count=transport.controls.calls.length;ui.controls.mode='drop';await run('f.start();');await wait('f.tasks[0]?.done');
      assert.equal((await f.read()).notes,'Owned saved without ACK');const unknown=await run('return f.snapshot();');
      assert.deepEqual(unknown.successes,[]);assert.equal(unknown.modalOpen,true);
      await run('f.start();');await wait('f.tasks[1]?.done');const state=await run('return f.snapshot();');
      assert.equal(ui.controls.responses[1]?.status,409,JSON.stringify(ui.controls.responses));
      assert.equal(transport.controls.calls.length,count+2);assert.equal((await f.counts()).audits,1);
      assert.equal(state.form.notes,'Owned saved without ACK');assert.deepEqual(state.successes,[]);
      assert.ok(state.errors.some(message=>message.includes('Запись уже изменилась')));
      assert.ok(state.errors.every(message=>!message.includes('другой сотрудник')&&!message.includes('пока не сохранён')));
      assert.deepEqual(ui.controls.errors,[]);assert.deepEqual(browser.exceptions,[]);
    }finally{await browser?.close();await ui.close();await f.close();}
  });
  for(const role of ['owner','doctor'])await t.test('live '+role+' revocation wins over an already stale opening token and hides the private form',async()=>{
    const f=await setup(role),ui=await appointmentNativeServer(http.handler,script);let browser,changed=false;
    try{
      browser=await ownedRecoveryBrowser(ui.origin);const run=browser.evaluate,wait=browser.waitFor;
      if(role==='doctor')await run("f.role('doctor');");
      await run(`f.edit(${JSON.stringify(await f.fullRead())});f.view.setForm(current=>({...current,notes:'Owned refused stale draft'}));await f.tick();`);
      transport.controls.beforeAppointmentRead=async()=>{if(changed)return;changed=true;
        await db.query("update staff_users set status='inactive' where id=$1",[f.staff]);
        await db.query("update appointments set notes='Owned newer note' where id=$1",[ids.appointment]);};
      await run('f.start();');await wait('f.tasks[0]?.done');const state=await run('return f.snapshot();');
      assert.equal(changed,true);assert.equal(ui.controls.responses[0]?.status,403,JSON.stringify(ui.controls.responses));
      assert.equal((await f.read()).notes,'Owned newer note');assert.equal((await f.counts()).audits,0);
      assert.equal(state.modalOpen,false);assert.equal(state.form.phone,'');assert.equal(state.form.notes,'');
      assert.deepEqual(state.items,[]);assert.deepEqual(state.successes,[]);assert.deepEqual(ui.controls.errors,[]);assert.deepEqual(browser.exceptions,[]);
    }finally{transport.controls.beforeAppointmentRead=null;await browser?.close();await ui.close();await f.close();}
  });
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
  assert.ok(transport.controls.calls.length>0&&transport.controls.calls.every(call=>call.name==='patch_crm_appointment_journaled'));
  assert.deepEqual(transport.controls.writes,[],'No direct appointment UPDATE or second-statement audit fallback');
  await exerciseAppointmentPatch(db,fixture,t,{versioned:true,journaled:true});
});

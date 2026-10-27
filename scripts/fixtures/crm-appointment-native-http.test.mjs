import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { startNativePostgres } from './native-postgres.mjs';
import { exerciseAppointmentActor } from './appointment-actor-cases.mjs';
import { readReviewedChain } from './migration-chain-review.mjs';
import { partnerEntryHttpFixture,stopPartnerEntryBuilds } from './partner-entry-http-fixture.mjs';
import { appointmentNativeAdapter,appointmentNativeServer,provisionAppointmentNative } from './crm-appointment-native-http-fixture.mjs';
import { ids,visit,root,recoveryBundle,stopRecoveryBundler,ownedRecoveryBrowser } from '../src/appointment-recovery-committed-fixture.ts';

test('CRM recovery composes actual React, full HTTP router and native SQL',{timeout:300000},async t=>{
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE,'1');
  t.after(()=>{stopPartnerEntryBuilds();stopRecoveryBundler();});
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
  const script=await recoveryBundle({jwtLikeTokens:true});
  const expected={appointments:1,clients:1,receipts:1,audits:1};
  const plusFiveScript=await recoveryBundle({jwtLikeTokens:true,clinicTimeZone:'Asia/Almaty'});
  for(const role of ['owner','admin'])for(const status of ['confirmed','cancelled'])await t.test(`${role}: recovery follows the current ${status} visit day at +5, not the original two-service draft`,async()=>{
    const f=await provisionAppointmentNative(db,role),server=await appointmentNativeServer(http.handler,plusFiveScript);let browser;
    const secondService=randomUUID();
    const lead=randomUUID();
    const movedStart=status==='confirmed'?'2026-10-27T20:30:00Z':'2026-10-27T18:30:00Z';
    const movedDay=status==='confirmed'?'2026-10-28':'2026-10-27';
    try{
      await db.query("update workspace_settings set value='{\"timeZone\":\"Asia/Almaty\"}' where workspace_id=$1 and key='clinic_schedule'",[ids.workspace]);
      await db.query('update clinic_doctor_shifts set start_minute=0,end_minute=1440 where workspace_id=$1',[ids.workspace]);
      await db.query("insert into clinic_services(id,workspace_id,doctor_id,name,base_price_minor,duration_minutes) values($1,$2,$3,'Owned second service',355000,30)",[secondService,ids.workspace,ids.doctor]);
      browser=await ownedRecoveryBrowser(server.origin);const run=browser.evaluate,wait=browser.waitFor;
      if(role!=='owner')await run(`f.role('${role}');`);
      server.controls.mode='drop';
      await run(`f.draft();f.view.setForm(current=>({...current,date:'2026-10-25',time:'18:00',priceTenge:'3450.50',
        additionalServices:[{serviceId:'${secondService}',name:'Owned second service',durationMinutes:30,priceMinor:355000}]}));await f.tick();
        f.view.prefillLeadRef.current='${lead}';f.start();`);
      await wait('f.tasks[0]?.done');
      assert.equal(server.controls.responses[0]?.status,201,JSON.stringify(server.controls.responses));
      const original=server.controls.responses[0].body.data.item;
      assert.equal(Date.parse(original.startsAt),Date.parse('2026-10-25T13:00:00Z'));
      assert.equal(original.priceMinor,700050);assert.equal(original.durationMinutes,75);
      assert.deepEqual(original.serviceItems.map(item=>item.serviceId),[ids.service,secondService]);
      assert.equal((await run('return f.snapshot();')).uncertain,true);
      // An owned concurrent editor changes the stored visit. This is not proof
      // of PATCH authority; recovery must only read its present state.
      const zeroServices=original.serviceItems.map(item=>({...item,priceMinor:0}));
      await db.query('update appointments set starts_at=$1,price_minor=0,status=$2,service_items=$3::jsonb where id=$4',[movedStart,status,JSON.stringify(zeroServices),original.id]);
      await db.query('update clinic_services set is_active=false,base_price_minor=999999 where workspace_id=$1',[ids.workspace]);
      await browser.load();if(role!=='owner')await run(`f.role('${role}');`);await wait('f.view.unconfirmedCreate');
      const restored=await run('return f.snapshot();');assert.equal(restored.form.date,'2026-10-25');assert.equal(restored.form.time,'18:00');
      await run('f.start();');await wait('f.tasks[0]?.done');const result=await run('return f.snapshot();');
      assert.equal(server.controls.responses[1]?.status,200,JSON.stringify(server.controls.responses));
      assert.deepEqual(server.controls.responses[1].request,server.controls.responses[0].request);
      assert.equal(result.items.length,1);assert.equal(result.items[0].id,original.id);assert.equal(result.items[0].priceMinor,0);
      assert.equal(result.items[0].durationMinutes,75);assert.equal(result.items[0].status,status);
      assert.equal(Date.parse(result.items[0].startsAt),Date.parse(movedStart));
      assert.equal(result.items[0].serviceItems.length,2);assert.equal(result.items[0].arrivalSaleId,'');
      assert.equal(result.receipts.length,0);assert.equal(result.modalOpen,false);assert.equal(result.successes.length,1);
      assert.equal(result.selectedDate,movedDay,'Navigate to the currently confirmed visit in the clinic timezone, not the old draft day');
      assert.deepEqual(result.handoffs,status==='confirmed'?[lead]:[],
        'Only a currently occupied visit may mark its linked lead booked; this spy does not prove a lead write');
      assert.deepEqual(await f.counts(),expected);assert.deepEqual(server.controls.errors,[]);
      assert.equal((await db.query('select count(*)::int n from deals where workspace_id=$1',[ids.workspace])).rows[0].n,0);
    }finally{await browser?.close();await server.close();await f.close();}
  });
  await t.test('a revoked recovery hides private fields, preserves its unknown key and reconciles once after restored authority',async()=>{
    const f=await provisionAppointmentNative(db),server=await appointmentNativeServer(http.handler,script);let browser;
    try{
      browser=await ownedRecoveryBrowser(server.origin);const run=browser.evaluate,wait=browser.waitFor;
      server.controls.mode='drop';await run('f.draft();f.start();');await wait('f.tasks[0]?.done');
      assert.equal(server.controls.responses[0]?.status,201);const original=await run('return f.snapshot();');
      assert.equal(original.uncertain,true);assert.equal(original.form.phone,visit.phone);assert.equal(original.receipts.length,1);
      await db.query("update staff_users set status='inactive' where id=$1",[f.staff]);
      await run('f.start();');await wait('f.tasks[1]?.done');const refused=await run('return f.snapshot();');
      assert.equal(server.controls.responses[1]?.status,403,JSON.stringify(server.controls.responses));
      assert.equal(refused.form.phone,'');assert.equal(refused.form.client,'');assert.equal(refused.form.notes,'');
      assert.equal(refused.phone,'');assert.equal(refused.uncertain,true);assert.equal(refused.items.length,0);assert.equal(refused.successes.length,0);
      assert.equal(refused.attempt.requestKey,original.attempt.requestKey);assert.deepEqual(refused.receipts,original.receipts);
      await run('f.view.setCreateRecoveryRead(current=>current+1);await f.tick();');
      const reread=await run('return f.snapshot();');assert.equal(reread.form.phone,'');assert.equal(reread.form.notes,'');
      assert.equal(server.controls.responses.length,2,'Storage reread must not silently create or retry');
      await db.query("update staff_users set status='active' where id=$1",[f.staff]);
      await browser.load();await wait('f.view.unconfirmedCreate');await run('f.start();');await wait('f.tasks[0]?.done');
      const recovered=await run('return f.snapshot();');assert.equal(server.controls.responses[2]?.status,200);
      assert.equal(recovered.items[0].id,server.controls.responses[0].body.data.item.id);assert.equal(recovered.receipts.length,0);
      assert.equal(recovered.successes.length,1);assert.deepEqual(await f.counts(),expected);assert.deepEqual(server.controls.errors,[]);
    }finally{await browser?.close();await server.close();await f.close();}
  });
  for(const role of ['owner','admin','receptionist','manager'])await t.test(role+': lost reply and changed catalogue recover the original committed appointment',async()=>{
    const f=await provisionAppointmentNative(db,role),server=await appointmentNativeServer(http.handler,script);let browser;
    try{
      browser=await ownedRecoveryBrowser(server.origin);const run=browser.evaluate,wait=browser.waitFor;
      if(role!=='owner')await run(`f.role('${role}');`);
      server.controls.mode='drop';await run('f.draft();f.start();');await wait('f.tasks[0]?.done');
      assert.deepEqual(server.controls.errors,[]);assert.equal(server.controls.responses[0]?.status,201,JSON.stringify(server.controls.responses));
      const first=await run('return f.snapshot();');assert.equal(first.uncertain,true);assert.equal(first.items.length,0);assert.equal(first.receipts.length,1);
      assert.deepEqual(await f.counts(),expected);
      await db.query("update clinic_services set is_active=false,base_price_minor=999999,duration_minutes=90 where id=$1",[ids.service]);
      await browser.load();if(role!=='owner')await run(`f.role('${role}');`);await wait('f.view.unconfirmedCreate');
      await run('f.start();');await wait('f.tasks[0]?.done');const result=await run('return f.snapshot();');
      assert.equal(server.controls.responses[1]?.status,200,JSON.stringify(server.controls.responses));
      assert.equal(server.controls.responses[1].body.data.replayed,true);assert.deepEqual(server.controls.responses[1].request,server.controls.responses[0].request);
      assert.equal(result.items.length,1);assert.equal(result.items[0].priceMinor,visit.priceMinor);assert.equal(result.items[0].durationMinutes,45);
      assert.equal(result.items[0].id,server.controls.responses[0].body.data.item.id);assert.equal(result.receipts.length,0);assert.equal(result.successes.length,1);
      assert.deepEqual(await f.counts(),expected);
      for(const response of server.controls.responses)assert.match(response.cache,/no-store/);
    }finally{await browser?.close();await server.close();await f.close();}
  });
  await t.test('a pending committed reply cannot publish into a replacement account or resurrect after A returns',async()=>{
    const f=await provisionAppointmentNative(db),server=await appointmentNativeServer(http.handler,script);let browser;
    try{
      browser=await ownedRecoveryBrowser(server.origin);const run=browser.evaluate,wait=browser.waitFor;
      server.controls.mode='hold';await run('f.draft();f.start();');
      await wait("f.tasks.length===1");
      for(let n=0;n<200&&!server.controls.held.length;n++)await new Promise(r=>setTimeout(r,20));
      assert.equal(server.controls.held.length,1,JSON.stringify(server.controls.responses));assert.deepEqual(await f.counts(),expected);
      await run(`f.actor('${ids.B}');await f.tick();`);assert.equal((await run('return f.snapshot();')).form.phone,'');
      await run(`f.actor('${ids.A}');await f.tick();`);await wait('f.view.unconfirmedCreate');
      await run('f.start();');await wait('f.tasks[1]?.done');const settled=await run('return f.snapshot();');
      assert.equal(settled.items.length,1);assert.equal(settled.receipts.length,0);assert.equal(settled.successes.length,1);
      server.release();await wait('f.tasks[0]?.done');const late=await run('return f.snapshot();');
      assert.deepEqual(late.items,settled.items);assert.deepEqual(late.successes,settled.successes);assert.equal(late.receipts.length,0);
      assert.deepEqual(await f.counts(),expected);assert.deepEqual(server.controls.errors,[]);
    }finally{await browser?.close();await server.close();await f.close();}
  });
  for(const phase of ['read_crm_appointment_request_v2','create_crm_appointment_v2'])for(const change of ['role','auth','status'])await t.test(`${phase}: live ${change} replacement before SQL must deny the original HTTP actor`,async()=>{
    const f=await provisionAppointmentNative(db),server=await appointmentNativeServer(http.handler);
    try{
      let changed=false;
      transport.controls.beforeRpc=async name=>{
        if(name!==phase||changed)return;changed=true;
        if(change==='role')await db.query("update staff_users set role='marketer' where id=$1",[f.staff]);
        if(change==='auth')await db.query('update staff_users set auth_user_id=$1 where id=$2',[randomUUID(),f.staff]);
        if(change==='status')await db.query("update staff_users set status='inactive' where id=$1",[f.staff]);
      };
      const response=await fetch(server.origin+'/api/crm/appointments?workspaceId='+ids.workspace,{method:'POST',
        headers:{authorization:`Bearer owned.${ids.A}.signature`,'Content-Type':'application/json'},
        body:JSON.stringify({...visit,workspaceId:ids.workspace,requestKey:randomUUID()})});
      const body=await response.json();assert.equal(changed,true);assert.equal(response.status,403,JSON.stringify(body));
      assert.deepEqual(await f.counts(),{appointments:0,clients:1,receipts:0,audits:0});
    }finally{transport.controls.beforeRpc=null;await server.close();await f.close();}
  });
  await t.test('a legacy browser without a key still uses v2 and cannot fall back after authority is replaced',async()=>{
    const f=await provisionAppointmentNative(db),server=await appointmentNativeServer(http.handler);
    try{
      const before=transport.controls.calls.length;
      transport.controls.beforeRpc=async name=>{if(name==='create_crm_appointment_v2')await db.query("update staff_users set role='marketer' where id=$1",[f.staff]);};
      const response=await fetch(server.origin+'/api/crm/appointments?workspaceId='+ids.workspace,{method:'POST',
        headers:{authorization:`Bearer owned.${ids.A}.signature`,'Content-Type':'application/json'},body:JSON.stringify({...visit,workspaceId:ids.workspace})});
      assert.equal(response.status,403,await response.text());
      const calls=transport.controls.calls.slice(before);assert.deepEqual(calls.map(c=>c.name),['read_crm_appointment_request_v2','create_crm_appointment_v2']);
      assert.equal(calls[0].args.p_request_key,calls[1].args.p_request_key);assert.match(calls[0].args.p_request_key,/^[0-9a-f-]{36}$/);
      assert.deepEqual(await f.counts(),{appointments:0,clients:1,receipts:0,audits:0});
    }finally{transport.controls.beforeRpc=null;await server.close();await f.close();}
  });
  await t.test('concurrent identical HTTP creates commit exactly one visit, origin and first-create journal',async()=>{
    const f=await provisionAppointmentNative(db),server=await appointmentNativeServer(http.handler);
    try{
      const payload={...visit,workspaceId:ids.workspace,requestKey:randomUUID()};
      const create=()=>fetch(server.origin+'/api/crm/appointments?workspaceId='+ids.workspace,{method:'POST',
        headers:{authorization:`Bearer owned.${ids.A}.signature`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const first=create(),second=create();const responses=await first.then(async a=>[a,await second]);
      assert.deepEqual(responses.map(r=>r.status).sort(),[200,201]);
      const [a,b]=await responses[0].json().then(async a=>[a,await responses[1].json()]);assert.equal(a.data.item.id,b.data.item.id);
      assert.deepEqual(await f.counts(),expected);assert.deepEqual(server.controls.errors,[]);
      assert.equal((await db.query('select count(*)::int n from crm_appointment_request_actors where workspace_id=$1',[ids.workspace])).rows[0].n,1);
    }finally{await server.close();await f.close();}
  });
  await t.test('three distinct HTTP creates race for a two-seat slot without bypassing capacity or leaving a failed receipt',async()=>{
    const f=await provisionAppointmentNative(db),server=await appointmentNativeServer(http.handler);
    let release,waiting=0;const admitted=new Promise(resolve=>{release=resolve;});
    const timer=setTimeout(release,8000);
    const firstError=transport.controls.errors.length;
    try{
      transport.controls.beforeRpc=async name=>{if(name==='create_crm_appointment_v2'){waiting++;if(waiting===3)release();await admitted;}};
      const create=()=>fetch(server.origin+'/api/crm/appointments?workspaceId='+ids.workspace,{method:'POST',
        headers:{authorization:`Bearer owned.${ids.A}.signature`,'Content-Type':'application/json'},
        body:JSON.stringify({...visit,workspaceId:ids.workspace,requestKey:randomUUID(),allowConflict:true})});
      const a=create(),b=create(),c=create(),responses=[];
      for(const pending of [a,b,c])responses.push(await pending);
      const bodies=[];for(const response of responses)bodies.push(await response.json());
      assert.equal(waiting,3,'All HTTP checks completed before releasing the three distinct SQL writers');
      assert.deepEqual(responses.map(response=>response.status).sort(),[201,201,409],JSON.stringify(bodies));
      assert.equal(bodies.filter(body=>body.code==='appointment_conflict').length,1);
      assert.equal(new Set(bodies.filter(body=>body.success).map(body=>body.data.item.id)).size,2);
      assert.deepEqual(await f.counts(),{appointments:2,clients:1,receipts:2,audits:2});
      assert.deepEqual(transport.controls.errors.slice(firstError).map(error=>error.code),['23P01']);
      assert.equal((await db.query('select count(*)::int n from crm_appointment_request_actors where workspace_id=$1',[ids.workspace])).rows[0].n,2);
      assert.deepEqual(server.controls.errors,[]);
    }finally{clearTimeout(timer);release();transport.controls.beforeRpc=null;await server.close();await f.close();}
  });
  assert.deepEqual(http.state.unexpected,[]);assert.deepEqual(http.state.challenges,[]);
  assert.equal(transport.controls.errors.filter(error=>error.code==='23P01').length,1,'Exactly the deliberately over-capacity writer');
  assert.ok(transport.controls.errors.every(error=>['P6404','23P01'].includes(error.code)),'Only explicitly exercised authority and capacity refusals');
  await exerciseAppointmentActor(db,fixture,t);
  for(const table of ['workspaces','staff_users','clients','appointments','clinic_doctors','clinic_services','audit_logs',
    'crm_appointment_create_requests','crm_appointment_request_actors','deals']){
    const column=table==='workspaces'?'id':'workspace_id';
    assert.equal((await db.query(`select count(*)::int n from ${table} where ${column} in ($1,$2)`,[ids.workspace,ids.otherWorkspace])).rows[0].n,0,
      'Owned fixture cleanup: '+table);
  }
});

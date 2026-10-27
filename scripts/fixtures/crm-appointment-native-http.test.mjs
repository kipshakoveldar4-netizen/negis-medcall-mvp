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
  assert.deepEqual(http.state.unexpected,[]);assert.deepEqual(http.state.challenges,[]);
  assert.ok(transport.controls.errors.every(error=>error.code==='P6404'),'Only explicitly exercised authority refusals');
  await exerciseAppointmentActor(db,fixture,t);
});

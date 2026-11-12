import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Script } from 'node:vm';
import test from 'node:test';
import { startNativePostgres } from './native-postgres.mjs';
import { readReviewedChain } from './migration-chain-review.mjs';
import { ownedRecoveryBrowser, root } from '../src/appointment-recovery-committed-fixture.ts';

// Real component/transport + HTTP handler + service-role SQL on an owned native
// database. Identity and the SDK adapter are synthetic, not Supabase/Auth proof.
const frontend = path.join(root, 'artifacts/negis');
const require = createRequire(path.join(frontend, 'package.json'));
const ts = createRequire(path.join(root, 'package.json'))('typescript');
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
const rpcArgs = {
  read_growth_operator_booking_context: ['p_request_id','p_operator_user_id','p_lead_id'],
  create_growth_operator_booking: ['p_request_id','p_operator_user_id','p_lead_id','p_request_key','p_doctor_id','p_service_ids','p_starts_local','p_time_zone'],
};
const selections = {
  growth_operator_profiles: { id: 'id' }, growth_operator_requests: { workspace_id: 'workspace_id' },
  clinic_doctors: { id: 'id', 'id,full_name,specialty': 'id,full_name,specialty' },
  clinic_services: { 'id,name,base_price_minor::text,duration_minutes': 'id,name,base_price_minor::text,duration_minutes' },
};
const columns = new Set(['id','workspace_id','auth_user_id','operator_id','status','is_active','full_name','name']);
function sqlAdapter(fixture) {
  async function query(sql, args) {
    const db = await fixture.connect();
    try { await db.query('set role service_role'); return await db.query(sql, args); }
    finally { await db.end(); }
  }
  return {
    async rpc(name, args) {
      assert.ok(Object.hasOwn(rpcArgs, name), 'Only the two real booking RPCs are allowed');
      assert.deepEqual(Object.keys(args).sort(), [...rpcArgs[name]].sort());
      try { return { data: (await query(`select public.${name}(${rpcArgs[name].map((_, i) => '$'+(i+1)).join(',')}) value`, rpcArgs[name].map(key => args[key]))).rows[0].value, error: null }; }
      catch (error) { return { data: null, error: { code: error.code, message: error.message } }; }
    },
    from(table) {
      assert.ok(Object.hasOwn(selections, table), 'No other application table is exposed by this read-only SDK adapter');
      let selected, condition = [], values = [], order = [];
      const q = {
        select(fields) { selected = selections[table][fields]; assert.ok(selected); return q; },
        eq(column, value) { assert.ok(columns.has(column)); values.push(value); condition.push(column+'=$'+values.length); return q; },
        or(value) {
          const match = /^doctor_id\.eq\.([0-9a-f-]{36}),doctor_id\.is\.null$/i.exec(value);
          assert.ok(match && uuid(match[1])); values.push(match[1]); condition.push('(doctor_id=$'+values.length+' or doctor_id is null)'); return q;
        },
        order(column) { assert.ok(columns.has(column)); order.push(column); return q; },
        async run(start = 0, count = 2) {
          assert.ok(selected && condition.length && Number.isInteger(start) && start >= 0 && Number.isInteger(count) && count > 0 && count <= 26);
          try { return { data: (await query(`select ${selected} from public.${table} where ${condition.join(' and ')}${order.length?' order by '+order.join(','):''} offset ${start} limit ${count}`, values)).rows, error: null }; }
          catch (error) { return { data: null, error: { code: error.code, message: error.message } }; }
        },
        async maybeSingle() { const r = await q.run(); assert.ok(r.error || r.data.length <= 1); return { ...r, data: r.data?.[0] ?? null }; },
        range(start, end) { return q.run(start, end-start+1); },
      };
      return q;
    },
  };
}
async function handlers(adapter, identities) {
  function evaluate(source, imports = {}) {
    const exports = {};
    new Script(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)
      .runInNewContext({ exports, Error, require(name) { assert.ok(Object.hasOwn(imports, name), `Unexpected native HTTP import ${name}`); return imports[name]; } });
    return exports;
  }
  const contracts = evaluate(await readFile(path.join(root, 'lib/crm/operator-contracts.ts'), 'utf8'));
  const imports = {
    '../auth/server': { isUuidValue: uuid, requireAuthenticatedUser: async req => {
      const match = /^Bearer owned:([0-9a-f-]{36})$/i.exec(req.headers.authorization ?? '');
      assert.ok(match && identities.has(match[1]), 'Only explicitly provisioned local identities may enter this handler');
      return { id: match[1] };
    } },
    '../supabase/server': { getSupabaseServerClient: () => adapter }, './operator-contracts': contracts,
  };
  return {
    booking: evaluate(await readFile(path.join(root, 'lib/crm/operator-bookings.ts'), 'utf8'), imports).handleOperatorBookings,
    services: evaluate(await readFile(path.join(root, 'lib/crm/operator-services.ts'), 'utf8'), imports).handleOperatorServices,
  };
}
async function provision(db) {
  const f = Object.fromEntries(['workspace','owner','ownerAuth','operator','actor','otherActor','lead','doctor','service','shared'].map(key => [key,randomUUID()]));
  await db.query("insert into workspaces(id,name) values($1,'Owned native booking')",[f.workspace]);
  await db.query("insert into workspace_settings(workspace_id,key,value) values($1,'clinic_schedule','{\"timeZone\":\"Asia/Almaty\"}')",[f.workspace]);
  await db.query("insert into staff_users(id,workspace_id,auth_user_id,email,full_name,role,status) values($1,$2,$3,$4,'Owned owner','owner','active')",[f.owner,f.workspace,f.ownerAuth,f.owner+'@example.invalid']);
  await db.query("insert into growth_operator_profiles(id,auth_user_id,display_name,status,accepting_requests,approved_by,approved_at) values($1,$2,'Owned operator','approved',true,$3,now())",[f.operator,f.actor,f.ownerAuth]);
  f.request = (await one(db,"select create_clinic_operator_request($1,$2,$3,$4,'Owned synthetic agreement',0,'assigned') id",[f.workspace,f.owner,f.ownerAuth,f.operator])).id;
  await db.query("select transition_growth_operator_request($1,$2,'accept')",[f.request,f.actor]);
  await db.query("insert into leads(id,workspace_id,full_name,phone,source) values($1,$2,'Owned fictional client','+77000004101','Owned local fixture')",[f.lead,f.workspace]);
  await db.query("select set_growth_operator_lead_assignment($1,$2,$3,true)",[f.request,f.lead,f.owner]);
  await db.query("insert into clinic_doctors(id,workspace_id,full_name,capacity) values($1,$2,'Owned doctor',1)",[f.doctor,f.workspace]);
  await db.query("insert into clinic_services(id,workspace_id,doctor_id,name,base_price_minor,duration_minutes) values($1,$2,$3,'Owned service',125049,45),($4,$2,null,'Owned shared',25001,30)",[f.service,f.workspace,f.doctor,f.shared]);
  await db.query("insert into clinic_doctor_shifts(workspace_id,doctor_id,weekday,is_working,start_minute,end_minute) values($1,$2,1,true,480,1140)",[f.workspace,f.doctor]);
  f.counts = () => one(db, `select (select count(*)::int from appointments where workspace_id=$1) appointments,
    (select count(*)::int from clients where workspace_id=$1) clients,
    (select count(*)::int from growth_operator_bookings where workspace_id=$1) receipts,
    (select count(*)::int from audit_logs where workspace_id=$1 and action='operator_appointment_created') audits`,[f.workspace]);
  f.close = async () => {
    await db.query('delete from growth_operator_bookings where workspace_id=$1',[f.workspace]);
    await db.query('delete from growth_operator_lead_assignments where workspace_id=$1',[f.workspace]);
    await db.query('delete from growth_operator_requests where workspace_id=$1',[f.workspace]);
    await db.query('delete from workspaces where id=$1',[f.workspace]);
    await db.query('delete from growth_operator_profiles where id=$1',[f.operator]);
  };
  return f;
}
async function bundle(ids) {
  const component = JSON.stringify(path.join(frontend,'src/components/operators/OperatorBookingForm.tsx').replaceAll('\\','/'));
  const mocks = `export const hasSupabaseFrontendEnv=true,isSignOutPending=()=>false,getSignOutRevision=()=>0;
    export const supabase={auth:{getSession:async()=>({data:{session:{user:{id:window.__appointmentRecovery?.actor||'${ids.actor}'},access_token:'owned:'+(window.__appointmentRecovery?.actor||'${ids.actor}')}},error:null})}};`;
  const entry = `import React from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import{OperatorBookingForm}from ${component};
    const f={actor:'${ids.actor}',view:{isCurrentMutationScope:()=>true},booked:[],denied:0,
      snapshot(){return{booked:this.booked,denied:this.denied,receipts:Object.keys(sessionStorage).filter(k=>k.startsWith('medina_operator_booking_attempt')).map(k=>[k,sessionStorage.getItem(k)]),
        form:!!document.querySelector('form'),text:document.body.innerText};}};
    window.__appointmentRecovery=f;
    function Host(){const[revision,setRevision]=React.useState(0),[visible,setVisible]=React.useState(true);const live=React.useRef({active:true});
      f.reopen=()=>{live.current.active=false;live.current={active:true};flushSync(()=>{setVisible(true);setRevision(v=>v+1);});};
      f.switchActor=value=>{live.current.active=false;live.current={active:true};f.actor=value;flushSync(()=>{setVisible(true);setRevision(v=>v+1);});};
      const epoch=live.current;
      return visible?<OperatorBookingForm key={revision} actorId={f.actor} requestId='${ids.request}' leadId='${ids.lead}' isSessionCurrent={()=>epoch.active}
        onBooked={value=>{f.booked.push(value);setVisible(false);}} onAccessDenied={()=>{f.denied++;setVisible(false);}}/>:<output>Owned local result</output>;}
    createRoot(document.getElementById('root')).render(<Host/>);`;
  return (await esbuild.build({ stdin:{contents:entry,resolveDir:frontend,loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',
    define:{'process.env.NODE_ENV':'"production"','import.meta.env.BASE_URL':'"/"','import.meta.env.VITE_API_BASE_URL':'""'},
    plugins:[{name:'owned-native-booking',setup(build){
      build.onResolve({filter:/^@\/lib\/(supabase|authSignOut)$/},()=>({path:'sdk',namespace:'owned'}));
      build.onLoad({filter:/.*/,namespace:'owned'},()=>({contents:mocks,loader:'ts'}));
      build.onResolve({filter:/^@\//},args=>{const base=path.join(frontend,'src',args.path.slice(2)),file=[base+'.ts',base+'.tsx'].find(existsSync);assert.ok(file);return{path:file};});
    }}] })).outputFiles[0].text;
}
async function httpFixture(handlers, code) {
  const controls = { drop: false, hold: false, partial: false, committed: [], held: [], errors: [], headers: [] };
  let origin;
  const server = createServer(async(req,res) => {
    if (!origin || req.headers.host !== new URL(origin).host) { res.writeHead(403).end(); return; }
    res.setHeader('Cache-Control','no-store');
    const url = new URL(req.url,origin);
    if (url.pathname==='/bundle.js') { res.setHeader('Content-Type','application/javascript'); res.end(code); return; }
    if (url.pathname==='/') {
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'");
      res.end('<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/bundle.js"></script></html>'); return;
    }
    if (!['/api/crm/operator-bookings','/api/crm/operator-services'].includes(url.pathname)) { res.writeHead(404).end(); return; }
    try {
      const parts=[]; let length=0;
      for await (const part of req) { length+=part.length; assert.ok(length<=8192); parts.push(part); }
      const body=length?JSON.parse(Buffer.concat(parts).toString('utf8')):undefined;
      let payload, status=200;
      const response={setHeader:(k,v)=>res.setHeader(k,v),status(value){status=value;return response;},json(value){payload=JSON.parse(JSON.stringify(value));return response;}};
      await handlers[url.pathname.endsWith('operator-services')?'services':'booking']({method:req.method,headers:req.headers,query:Object.fromEntries(url.searchParams),body},response);
      const send=()=>{if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(payload));}};
      controls.headers.push({status,cache:res.getHeader('Cache-Control')});
      if(req.method==='POST'&&status===200){
        controls.committed.push({key:body.requestKey,id:payload.data.id});
        if(controls.partial){controls.partial=false;payload={success:true,data:{id:payload.data.id}};send();return;}
        if(controls.drop){
          controls.drop=false;
          // A pre-header reset may be retried transparently by Chromium. Make
          // this an observed, truncated body instead of relying on that policy.
          res.writeHead(status,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(JSON.stringify(payload))+1});
          res.flushHeaders();res.write('{"success":');setTimeout(()=>res.destroy(),20).unref();return;
        }
        if(controls.hold){controls.hold=false;controls.held.push(send);return;}
      }
      send();
    } catch(error){controls.errors.push(error.message);if(!res.destroyed)res.writeHead(500).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  return {origin,controls,close:async()=>{for(const send of controls.held.splice(0))send();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
async function until(action) { for(let n=0;n<160;n++){if(await action())return;await delay(25);}assert.fail('Owned native HTTP condition did not settle'); }

test('operator booking survives committed lost ACK through real local HTTP and native SQL', {timeout:300000}, async t => {
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE,'1','Explicit owned native opt-in required; no DSN/download/container fallback');
  t.after(()=>esbuild.stop());
  const chain=await readReviewedChain(path.join(root,'migrations'));
  const fixture=await startNativePostgres(); t.after(()=>fixture.close()); const db=await fixture.connect();
  await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    grant usage on schema public to anon,authenticated,service_role;create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);
    alter table storage.objects enable row level security;`);
  for(const entry of chain)await db.query(entry.source);
  const identities=new Set(), api=await handlers(sqlAdapter(fixture),identities);
  for(const width of [375,1440])for(const scenario of ['lost-ack','revoked-reopen','account-switch','changed-result','partial-result']){
    await t.test(`${width}: ${scenario} recovers the same committed appointment without duplicate rows`,async()=>{
      const f=await provision(db);identities.add(f.actor);identities.add(f.otherActor);
      const server=await httpFixture(api,await bundle(f));let browser, failure;
      try{
        browser=await ownedRecoveryBrowser(server.origin);await browser.viewport(width,900);
        const run=browser.evaluate,wait=browser.waitFor;
        const snapshot=()=>run('return f.snapshot();');
        await wait("document.querySelectorAll('select option').length>1");
        await run(`const s=document.querySelector('select');s.value='${f.doctor}';s.dispatchEvent(new Event('change',{bubbles:true}));`);
        await wait("document.querySelectorAll('input[type=checkbox]').length===2");
        await run("for(const c of document.querySelectorAll('input[type=checkbox]'))c.click();const d=document.querySelector('input[type=datetime-local]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(d,'2030-01-07T10:00');d.dispatchEvent(new Event('input',{bubbles:true}));d.dispatchEvent(new Event('change',{bubbles:true}));");
        await wait("!document.querySelector('button[type=submit]').disabled");
        server.controls[scenario==='account-switch'?'hold':scenario==='partial-result'?'partial':'drop']=true;
        await run("document.querySelector('form').requestSubmit();");
        await until(()=>server.controls.committed.length===1);
        const original=server.controls.committed[0];assert.equal(original.key,original.id);
        assert.deepEqual(await f.counts(),{appointments:1,clients:1,receipts:1,audits:1});
        await db.query('update clinic_services set base_price_minor=999999,duration_minutes=90 where workspace_id=$1',[f.workspace]);
        if(scenario==='changed-result')await db.query("update appointments set status='cancelled',starts_at=starts_at+interval '1 day',price_minor=null,doctor_name=null,service=null,duration_minutes=720 where id=$1",[original.id]);
        if(scenario==='account-switch'){
          await run(`f.switchActor('${f.otherActor}');`);await wait('f.denied===1');
          await run(`f.switchActor('${f.actor}');`);await wait("document.querySelector('button[type=submit]')?.textContent.includes('Проверить')");
          const before=await snapshot();for(const send of server.controls.held.splice(0))send();
          await delay(100);assert.deepEqual(await snapshot(),before,'An old successful HTTP reply cannot publish or clear the recovery receipt after account replacement');
        }else{
          await wait("document.querySelector('button[type=submit]')?.textContent.includes('Проверить')");
          if(scenario==='revoked-reopen')await db.query("update growth_operator_profiles set status='suspended',accepting_requests=false where id=$1",[f.operator]);
          await browser.load();
          if(scenario==='revoked-reopen'){
            await wait('f.denied===1');assert.equal((await snapshot()).receipts.length,1);
            await db.query("update growth_operator_profiles set status='approved',accepting_requests=true where id=$1",[f.operator]);await run('f.reopen();');
          }
          await wait("document.querySelector('button[type=submit]')?.textContent.includes('Проверить')");
        }
        const retained=await snapshot();assert.equal(retained.receipts.length,1);
        assert.equal(JSON.parse(retained.receipts[0][1]).requestKey,original.key);
        assert.doesNotMatch(retained.receipts[0][1],/Owned|phone|clientName|full_name/);
        await run("document.querySelector('form').requestSubmit();");await wait('f.booked.length===1');
        const recovered=await snapshot();assert.equal(recovered.receipts.length,0);
        assert.equal(recovered.booked[0].id,original.id);assert.equal(recovered.booked[0].priceMinor,scenario==='changed-result'?null:'150050');
        assert.equal(recovered.booked[0].durationMinutes,scenario==='changed-result'?720:75);assert.equal(recovered.booked[0].timeZone,'Asia/Almaty');
        assert.equal(recovered.booked[0].service,scenario==='changed-result'?null:'Owned service + Owned shared');assert.equal(recovered.booked[0].doctorName,scenario==='changed-result'?null:'Owned doctor');
        assert.equal(new Date(recovered.booked[0].startsAt).toISOString(),scenario==='changed-result'?'2030-01-08T05:00:00.000Z':'2030-01-07T05:00:00.000Z');
        assert.equal(recovered.booked[0].status,scenario==='changed-result'?'cancelled':'scheduled');
        assert.deepEqual(await f.counts(),{appointments:1,clients:1,receipts:1,audits:1});
        assert.ok(server.controls.committed.every(row=>row.id===original.id&&row.key===original.key));
        assert.equal(server.controls.committed.length,2,'Exactly one original POST and one explicit same-key recovery');
        assert.ok(server.controls.headers.every(row=>row.cache==='no-store'));
        assert.deepEqual(server.controls.errors,[]);assert.deepEqual(browser.exceptions,[]);
        assert.ok(browser.requests.every(url=>{
          if(new URL(url).origin===server.origin)return true;
          // Chromium's native datetime-local calendar icon is an inline UA
          // resource, not an HTTP request. Pin its bytes; no general data/host
          // allowance or external connection is introduced.
          return /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/.test(url)
            && createHash('sha256').update(Buffer.from(url.slice(url.indexOf(',')+1),'base64')).digest('hex')
              ==='eb81a37ffe395a3a8115531f89d79d95cc521e967078294c0cdd21b5e6227405';
        }),JSON.stringify(browser.requests));
      }catch(error){failure=error;throw error;}
      finally{
        const cleanups=[];
        for(const action of [()=>browser?.close(),()=>server.close(),()=>f.close()])try{await action();}catch(error){cleanups.push(error);}
        identities.delete(f.actor);identities.delete(f.otherActor);
        if(cleanups.length){if(failure)throw new AggregateError([failure,...cleanups],'Native HTTP failure and owned cleanup errors');throw new AggregateError(cleanups,'Owned native HTTP cleanup failed');}
      }
    });
  }
  for(const table of ['appointments','clients','growth_operator_bookings','growth_operator_profiles','growth_operator_requests','leads','staff_users','workspaces'])
    assert.equal((await one(db,`select count(*)::int n from public.${table}`)).n,0);
  t.diagnostic(`Exact raw ${chain[0].file} through ${chain.at(-1).file}, ${chain.length} files; actual handler/native replay, synthetic identity/SDK adapter only.`);
});

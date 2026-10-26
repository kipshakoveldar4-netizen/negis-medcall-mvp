import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { ownedRecoveryBrowser, root } from "./appointment-recovery-committed-fixture.js";

// Reuse only the read-only owned Chromium/loopback driver, not appointment
// behavior. The original OperatorRequests/booking/transport run in real React.
// Descendant lists, SDK and HTTP replies are synthetic; this is not SQL proof.
const frontend = path.join(root, "artifacts/negis");
const requireFrontend = createRequire(path.join(frontend, "package.json"));
const esbuild = createRequire(requireFrontend.resolve("vite/package.json"))("esbuild") as {
  build(options: Record<string, unknown>): Promise<{ outputFiles: Array<{ text: string }> }>;
  stop(): void;
};
const A = "00000000-0000-4000-8000-000000003101", B = "00000000-0000-4000-8000-000000003102";
const R = "00000000-0000-4000-8000-000000003103", S = "00000000-0000-4000-8000-000000003104";
const W = "00000000-0000-4000-8000-000000003105", V = "00000000-0000-4000-8000-000000003106";
const LEAD = "00000000-0000-4000-8000-000000003107";
const imports = (file: string) => JSON.stringify(path.join(frontend, "src", file).replaceAll("\\", "/"));

const mocks = `
import React from 'react';import{flushSync}from'react-dom';
import{OperatorBookingForm}from ${imports("components/operators/OperatorBookingForm.tsx")};
import{newOperatorBookingAttempt,persistOperatorBookingAttempt}from ${imports("lib/operatorBookingAttempt.ts")};
export const hasSupabaseFrontendEnv=true;
let actor='${A}',epoch=0;const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const item=id=>({id,displayName:'Synthetic '+id,status:'accepted',clinicBrief:'Synthetic agreement',pricePerArrivalMinor:'0',currency:'KZT',leadScope:'assigned'});
export const f={items:[item('${R}'),item('${S}')],calls:[],gets:0,globalDenials:0,booked:0,unmounts:[],holds:[],holdAuth:false,holdGets:false,
 view:{isCurrentMutationScope:()=>true},
 session(){const saved=actor;const g=gate();this.holds.push(g);return(this.holdAuth?g.promise:Promise.resolve()).then(()=>({data:{session:{user:{id:saved},access_token:'fixture-'+saved}},error:null}));},
 raw(value){if(actor!==value)epoch++;actor=value;},get epoch(){return epoch;},get actor(){return actor;},
 patch(value){flushSync(()=>this.update(value));},
 async tick(){await new Promise(r=>setTimeout(r,20));},
 refresh(){document.querySelector('[aria-label="Обновить предложения"]').click();},
 next(){[...document.querySelectorAll('button')].find(n=>n.textContent.trim()==='Далее').click();},
 article(id){return[...document.querySelectorAll('article')].find(n=>n.querySelector('h3')?.textContent==='Synthetic '+id);},
 button(id,kind){const article=this.article(id);if(!article)throw Error('Missing article '+id);
  const labels={leads:['Открыть заявки','Назначить заявки'],catalog:['Услуги и цены'],arrivals:['Приходы и звонки','Подтвердить приходы'],end:['Завершить сотрудничество'],accept:['Принять условия'],withdraw:['Отозвать'],decline:['Отклонить']};
  const button=[...article.querySelectorAll('button')].find(n=>labels[kind].includes(n.textContent.trim()));if(!button)throw Error('Missing '+kind+' button');
  return button;},
 click(id,kind){flushSync(()=>this.button(id,kind).click());},
 async open(id){for(const kind of ['leads','catalog','arrivals']){if(!document.querySelector('[data-pane="'+kind+'"][data-request="'+id+'"]'))this.click(id,kind);await this.tick();}},
 reply(index,status,body,holdBody=false){const entry=this.calls[index];
  if(status===200&&body.success===true&&!Object.hasOwn(body,'data')&&entry.body.commandId){const b=entry.body,a=b.commandAction||b.action;
   body={success:true,data:b.action==='abandon'?{state:'abandoned',commandId:b.commandId,action:a,targetId:b.targetId,closedAt:'2030-01-07T05:00:00Z'}
    :{state:'committed',commandId:b.commandId,action:a,targetId:b.id,requestId:b.id,statusAtCommit:a==='accept'?'accepted':a==='end'?'ended':'declined',committedAt:'2030-01-07T05:00:00Z'}};}
  const stream=new ReadableStream({start(controller){entry.finish=()=>{controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));controller.close();};}});
  const response=new Response(stream,{status,headers:{'content-type':'application/json'}});const json=response.json.bind(response);
  response.json=()=>{entry.reads++;return json();};entry.response.resolve(response);if(!holdBody)entry.finish();},
 async closePending(){const button=[...document.querySelectorAll('button')].find(n=>n.textContent.trim()==='Закрыть отправку');if(!button||button.disabled)throw Error('Missing active command closure');
  button.click();await this.tick();const index=this.calls.length-1;if(this.calls[index].body.action!=='abandon')throw Error('Expected explicit closure');this.reply(index,200,{success:true});await this.tick();},
 seed(){const attempt=newOperatorBookingAttempt('${A}','${R}',{leadId:'${LEAD}',doctorId:'00000000-0000-4000-8000-000000003108',serviceIds:['00000000-0000-4000-8000-000000003109'],startsLocal:'2026-10-25T09:00',timeZone:'UTC'});attempt.uncertain=true;
  if(!persistOperatorBookingAttempt(sessionStorage,attempt))throw Error('Cannot persist synthetic booking');return attempt.requestKey;},
 snapshot(){return{panes:[...document.querySelectorAll('[data-pane]')].map(n=>n.dataset.pane+':'+n.dataset.request),
  alerts:[...document.querySelectorAll('[role="alert"]')].map(n=>n.textContent),articles:document.querySelectorAll('article').length,
  busy:[...document.querySelectorAll('article')].map(n=>({id:n.querySelector('h3').textContent,disabled:[...n.querySelectorAll('button')].find(b=>b.textContent.trim()==='Завершить сотрудничество')?.disabled})),
  globalDenials:this.globalDenials,gets:this.gets,calls:this.calls.map(c=>({method:c.method,url:c.url,body:c.body,reads:c.reads})),
  unmounts:[...this.unmounts],booked:this.booked,receipts:Object.keys(sessionStorage).filter(k=>k.startsWith('medina_operator_booking_attempt')).map(k=>[k,sessionStorage.getItem(k)]),
  commands:Object.keys(sessionStorage).filter(k=>k.startsWith('medina_operator_command_v1')).map(k=>[k,sessionStorage.getItem(k)])};}};
export const supabase={auth:{getSession:()=>f.session()}};
export const isSignOutPending=()=>false,getSignOutRevision=()=>0;
const closed=()=>{};const booked=()=>f.booked++;
function Pane({kind,requestId,children}){React.useEffect(()=>()=>{f.unmounts.push(kind+':'+requestId);},[kind,requestId]);return<section data-pane={kind} data-request={requestId}>Synthetic private {kind} {requestId}{children}</section>;}
export function OperatorLeads(props){return<Pane kind="leads" requestId={props.requestId}><input aria-label="Synthetic contact" value={'PRIVATE-'+props.requestId} readOnly/>
 <OperatorBookingForm actorId={props.actorId} requestId={props.requestId} leadId='${LEAD}' onBooked={booked} onAccessDenied={closed}/></Pane>;}
export const OperatorServiceCatalog=props=><Pane kind="catalog" requestId={props.requestId}/>;
export const OperatorArrivals=props=><Pane kind="arrivals" requestId={props.requestId}/>;
export const OperatorCatalogPagination=()=>null;
window.confirm=()=>true;
window.fetch=async(url,init={})=>{if(!String(url).startsWith('/api/crm/'))throw Error('External fetch forbidden');
 const method=init.method||'GET';if(method==='GET'){
  if(String(url).includes('operator-bookings?'))return Response.json({success:true,data:{timeZone:'UTC'}});
  if(String(url).includes('operator-services?'))return Response.json({success:true,data:{items:[],hasMore:false}});
  f.gets++;const g=gate();if(f.holdGets){f.pendingGet=g;await g.promise;}return Response.json({success:true,data:{items:f.items,hasMore:true}});
 }
 const response=gate();f.calls.push({url:String(url),method,body:JSON.parse(init.body),response,reads:0});return response.promise;};
`;
const entry = `
import React from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
import{OperatorRequests}from ${imports("components/operators/OperatorRequests.tsx")};import{f}from'operator-refusal-fake';
function Host(){const[props,setProps]=React.useState({actorId:'${A}',workspaceId:undefined,revision:0});f.update=value=>setProps(old=>({...old,...value,revision:f.epoch}));
 const current=React.useCallback(()=>f.epoch===props.revision,[props.revision]);return<OperatorRequests {...props} isSessionCurrent={current} onAccessDenied={()=>f.globalDenials++}/>;}
const app=createRoot(document.getElementById('root'));flushSync(()=>app.render(<Host/>));
f.unmount=()=>flushSync(()=>app.unmount());window.__appointmentRecovery=f;
`;

test("request-scoped 404/409 refusal in actual React and operator transport", { timeout: 120_000 }, async t => {
  t.after(() => esbuild.stop());
  const built = await esbuild.build({ stdin: { contents: entry, resolveDir: frontend, loader: "tsx", sourcefile: "operator-refusal.tsx" },
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.BASE_URL": '"/"', "import.meta.env.VITE_API_BASE_URL": '""' },
    plugins: [{ name: "owned-operator-refusal", setup(build: any) {
      build.onResolve({ filter: /^(operator-refusal-fake|@\/lib\/supabase|@\/lib\/authSignOut|\.\/OperatorLeads|\.\/OperatorArrivals|\.\/OperatorServiceCatalog)$/ }, () => ({ path: "mocks", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: mocks, loader: "tsx", resolveDir: frontend }));
      build.onResolve({ filter: /^@\// }, (args: { path: string }) => {
        const base = path.join(frontend, "src", args.path.slice(2)); const file = [base + ".ts", base + ".tsx"].find(existsSync); assert.ok(file); return { path: file };
      });
    } }],
  });
  const server = createServer((req, res) => {
    if (req.headers.host !== `127.0.0.1:${(server.address() as { port: number }).port}`) { res.writeHead(403).end(); return; }
    if (req.url === "/bundle.js") { res.setHeader("Content-Type", "application/javascript"); res.end(built.outputFiles[0].text); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'");
    res.end('<!doctype html><div id="root"></div><script src="/bundle.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const browser = await ownedRecoveryBrowser(`http://127.0.0.1:${(server.address() as { port: number }).port}`); t.after(browser.close);
  const run = browser.evaluate, wait = browser.waitFor, snap = () => run<any>("await f.tick();return f.snapshot();");
  const reset = async () => { await run("sessionStorage.clear();"); await browser.load(); await wait("f.article('" + R + "')"); };
  const assertOnlyS = (state: any) => { assert.equal(state.globalDenials, 0); assert.ok(state.panes.length > 0); assert.ok(state.panes.every((p: string) => p.endsWith(S)), JSON.stringify(state)); };

  for (const status of [404, 409]) {
    await t.test(`${status}: closes only matching panes, refreshes and preserves another request's live form`, async () => {
      await reset(); await run(`await f.open('${R}');f.click('${R}','end');await f.open('${S}');f.holdGets=true;`); await wait("f.calls.length===1");
      const before = await snap();
      await run(`f.reply(0,${status},{success:false,code:'P9602',error:'Synthetic request already ended'});`);
      await wait("f.calls[0].reads===1 && !document.querySelector('[data-pane][data-request=\"" + R + "\"]')");
      const refused = await snap(); assertOnlyS(refused);
      assert.ok(refused.gets > before.gets, "live refusal schedules a fresh list read");
      assert.equal(refused.unmounts.some((p: string) => p.endsWith(S)), false, "refresh must not discard another request's unsaved form");
      await run("f.holdGets=false;f.pendingGet.resolve();await f.tick();"); assertOnlyS(await snap());
    });
  }
  await t.test("same request on a newer page is invalidated, but its old mutation does not refresh or set an error on that page", async () => {
    await reset(); await run(`await f.open('${R}');f.click('${R}','end');`); await wait("f.calls.length===1");
    await run(`f.next();await f.tick();await f.open('${R}');`);
    const before = await snap(); await run("f.reply(0,409,{success:false,error:'OBSOLETE_ERROR'});await f.tick();");
    await wait("!document.querySelector('[data-pane][data-request=\"" + R + "\"]')");
    const after = await snap(); assert.deepEqual(after.panes, []); assert.equal(after.gets, before.gets); assert.deepEqual(after.alerts, before.alerts); assert.equal(after.globalDenials, 0);
  });
  await t.test("old refusal after a new page cannot close a different request", async () => {
    await reset(); await run(`await f.open('${R}');f.click('${R}','end');`); await wait("f.calls.length===1");
    await run(`f.next();await f.tick();await f.open('${S}');`);
    const before = await snap(); await run("f.reply(0,404,{success:false,error:'OBSOLETE_ERROR'});await f.tick();");
    const after = await snap(); assertOnlyS(after); assert.deepEqual(after.panes, before.panes); assert.equal(after.gets, before.gets); assert.deepEqual(after.alerts, before.alerts);
  });
  for (const change of ["actor B", "workspace B", "rendered ABA"]) {
    for (const status of [404, 409]) {
      await t.test(`${change}: old ${status} cannot clear panes, refresh, unlock or report into the new scope`, async () => {
        await reset(); await run(`await f.open('${R}');f.click('${R}','end');`);
        if (change === "actor B") await run(`f.raw('${B}');f.patch({actorId:'${B}'});`);
        if (change === "workspace B") await run(`f.patch({workspaceId:'${W}'});await f.tick();f.patch({workspaceId:'${V}'});`);
        if (change === "rendered ABA") await run(`f.raw('${B}');f.patch({actorId:'${B}'});await f.tick();f.raw('${A}');f.patch({actorId:'${A}'});await f.tick();await f.closePending();`);
        const currentIndex=(await snap()).calls.length;
        await run(`f.refresh();await f.tick();f.click('${S}','leads');f.click('${S}','arrivals');f.click('${S}','end');`); await wait(`f.calls.length===${currentIndex+1}`);
        const before = await snap(); await run(`f.reply(0,${status},{success:false,error:'OBSOLETE_ERROR'});await f.tick();`);
        const after = await snap(); assert.deepEqual(after.panes, before.panes); assert.deepEqual(after.busy, before.busy); assert.equal(after.gets, before.gets); assert.deepEqual(after.alerts, before.alerts); assert.equal(after.globalDenials, 0);
        await run(`f.reply(${currentIndex},200,{success:true});await f.tick();`); assert.equal((await snap()).gets, before.gets + 1);
      });
    }
  }
  await t.test("closing a refused request preserves a real pending booking receipt and ignores its late success", async () => {
    await reset(); const key = await run<string>("return f.seed();");
    await run(`await f.open('${R}');`); await wait("!![...document.querySelectorAll('button')].find(n=>n.textContent==='Проверить сохранение')");
    await run("document.querySelector('form').requestSubmit();"); await wait("f.calls.length===1");
    const before = await snap(); assert.equal(before.calls[0].method, "POST"); assert.equal(before.calls[0].body.requestKey, key);
    await run(`f.click('${R}','end');`); await wait("f.calls.length===2");
    await run("f.reply(1,409,{success:false,error:'Synthetic ended request'});await f.tick();");
    await wait("!document.querySelector('[data-pane][data-request=\"" + R + "\"]')");
    const after = await snap(); assert.deepEqual(after.panes, []); assert.deepEqual(after.receipts, before.receipts); assert.equal(after.booked, 0);
    await run("f.reply(0,200,{success:true,data:{appointmentId:'synthetic-confirmed'}});await f.tick();");
    const late = await snap(); assert.deepEqual(late.receipts, before.receipts); assert.equal(late.booked, 0);
    assert.equal(late.alerts.some((v: string) => /не сохран|не отправл/.test(v)), false);
  });
  for (const status of [401, 403]) await t.test(`${status} retains existing global denial behavior`, async () => {
    await reset(); await run(`await f.open('${R}');f.click('${R}','end');await f.open('${S}');`);
    await run(`f.reply(0,${status},{success:false},true);await f.tick();`); const state = await snap();
    assert.equal(state.globalDenials, 1); assert.deepEqual(state.panes, []); assert.equal(state.calls[0].reads, 0);
  });
  for (const clinic of [false, true]) await t.test(`positive ${clinic ? 'clinic withdrawal' : 'operator acceptance'} remains actionable`, async () => {
    await reset(); await run(`f.items=f.items.map(i=>({...i,status:'requested'}));${clinic ? `f.patch({workspaceId:'${W}'});` : ""}f.refresh();await f.tick();f.click('${R}','${clinic ? 'withdraw' : 'accept'}');`);
    await wait("f.calls.length===1"); const before = await snap(); await run("f.reply(0,200,{success:true});await f.tick();");
    const state = await snap(); assert.equal(state.gets, before.gets + 1); assert.equal(state.globalDenials, 0); assert.equal(state.calls[0].body.action, clinic ? "withdraw" : "accept");
  });
  for (const clinic of [false, true]) for (const status of ['requested', 'accepted']) {
    for (const response of [200, 503]) await t.test(`pending ${clinic ? 'clinic' : 'operator'} ${status}: fresh list retains one command until ${response} settles`, async () => {
      await reset();
      const action = status === 'accepted' ? 'end' : clinic ? 'withdraw' : 'accept';
      await run(`f.items=f.items.map(i=>({...i,status:'${status}'}));${clinic ? `f.patch({workspaceId:'${W}'});` : ''}f.refresh();await f.tick();f.click('${R}','${action}');`);
      await wait('f.calls.length===1');
      await run('f.refresh();await f.tick();');
      await wait(`!!f.article('${R}')`);
      assert.equal(await run(`return f.button('${R}','${action}').disabled;`), true,
        'The actual disabled DOM state must survive a fresh list while HTTP reply is pending');
      await run(`f.click('${R}','${action}');f.click('${S}','${action}');await f.tick();`);
      assert.equal((await snap()).calls.length, 1);
      const before = await snap();
      await run(`f.reply(0,${response},{success:${response === 200},error:'Obsolete reply'});await f.tick();`);
      await wait('f.calls[0].reads===1');
      assert.equal(await run(`return f.button('${R}','${action}').disabled;`),true,'Retired replies must retain the unresolved key');
      const after = await snap();
      assert.equal(after.gets, before.gets, 'Retired view cannot refetch or replace the newer snapshot');
      assert.deepEqual(after.alerts, before.alerts);
      assert.equal(after.calls.length, 1); assert.equal(after.globalDenials, 0);
      await run('await f.closePending();');await wait(`f.button('${R}','${action}').disabled===false`);
    });
  }
  await t.test('operator decline is protected by the same command lease', async () => {
    await reset(); await run(`f.items=f.items.map(i=>({...i,status:'requested'}));f.refresh();await f.tick();f.click('${R}','decline');`);
    await wait('f.calls.length===1'); await run('f.refresh();await f.tick();');
    assert.equal(await run(`return f.button('${R}','decline').disabled;`), true);
    await run(`f.click('${R}','decline');await f.tick();`);
    assert.equal((await snap()).calls.length, 1);
    await run('f.reply(0,200,{success:true});await f.tick();');
    await wait('f.calls[0].reads===1');assert.equal(await run(`return f.button('${R}','decline').disabled;`),true);
    await run('await f.closePending();');
    await wait(`f.button('${R}','decline').disabled===false`);
  });
  assert.deepEqual(browser.exceptions, []);
});

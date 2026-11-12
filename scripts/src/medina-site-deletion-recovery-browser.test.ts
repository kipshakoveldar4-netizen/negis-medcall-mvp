import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ownedAnalyticsBrowser, root } from "./medina-analytics-composed-fixture";

const frontend = path.join(root, "artifacts/negis");
const require = createRequire(path.join(frontend, "package.json"));
const esbuild = createRequire(require.resolve("vite/package.json"))("esbuild");
const mocks = `
import {flushSync} from 'react-dom';
const ids={a:'a0000000-0000-4000-8000-000000000001',b:'b0000000-0000-4000-8000-000000000001',
 wa:'a0000000-0000-4000-8000-000000000002',wb:'b0000000-0000-4000-8000-000000000002',
 la:'a0000000-0000-4000-8000-000000000003',lb:'b0000000-0000-4000-8000-000000000003',
 ra:'a0000000-0000-4000-8000-000000000004',rb:'b0000000-0000-4000-8000-000000000004',
 ka:'a0000000-0000-4000-8000-000000000005',kb:'b0000000-0000-4000-8000-000000000005'};
const stamp='2026-10-26T08:00:00.123456Z',deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
let session,lookup=null,props,app,mounted=false;const lifetimes=new Set(),sdk=new Set();
function row(letter,state='prepared') {return{workspaceId:ids['w'+letter],actorId:ids[letter],requestKey:ids['k'+letter],leadId:ids['l'+letter],
 request:{leadId:ids['l'+letter],leadUpdatedAt:stamp,receiptIds:[ids['r'+letter]],requestKey:ids['k'+letter],confirmed:true},state,
 createdAt:stamp,completedAt:state==='prepared'?null:stamp,acknowledgedAt:null,receiptsDeleted:state==='committed'?1:null,replayed:false};}
function life(actor,workspace){let active=true;const listeners=new Set();const value={actorId:actor,isCurrent:()=>active&&session?.user.id===actor,
 subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},retire(){active=false;for(const fn of [...listeners])fn();}};lifetimes.add(value);return value;}
export const f={ids,calls:[],notices:[],rows:[],holdReads:0,holdWrites:0,commitWins:false,
 reset(){this.unmount();lifetimes.clear();this.calls=[];this.notices=[];const ownOtherWorkspace=row('a');ownOtherWorkspace.workspaceId=ids.wb;ownOtherWorkspace.leadId=ids.lb;ownOtherWorkspace.request.leadId=ids.lb;ownOtherWorkspace.requestKey=ids.kb;ownOtherWorkspace.request.requestKey=ids.kb;
  this.rows=[row('a'),row('b'),ownOtherWorkspace];this.retained=null;this.holdReads=0;this.holdWrites=0;this.commitWins=false;lookup=null;
  session={user:{id:ids.a},access_token:'synthetic-A'};this.mount();},
 bind(root,makeProps){app=root;this.makeProps=makeProps;},mount(){props=this.makeProps(ids.a,ids.wa,life(ids.a,ids.wa));mounted=true;this.render();},
 render(){flushSync(()=>this.renderApp(props));},unmount(){if(mounted){props.lifetime.retire();flushSync(()=>this.clearApp());mounted=false;}},
 change(letter){props.lifetime.retire();session={user:{id:ids[letter]},access_token:letter==='a'?'synthetic-A':'synthetic-B'};
  props=this.makeProps(ids[letter],ids['w'+letter],life(ids[letter],ids['w'+letter]));mounted=true;this.render();},
 workspace(){props.lifetime.retire();props=this.makeProps(ids.a,ids.wb,life(ids.a,ids.wb));this.render();},
 raw(letter){session={user:{id:ids[letter]},access_token:letter==='a'?'synthetic-A':'synthetic-B'};for(const l of lifetimes)if(l.actorId!==session.user.id)l.retire();for(const fn of [...sdk])fn('SIGNED_IN',session);},
 refresh(){session={...session,access_token:'synthetic-refreshed-A'};for(const fn of [...sdk])fn('TOKEN_REFRESHED',session);this.render();},
 revise(){props={...props,refreshKey:(props.refreshKey??0)+1};this.render();},holdLookup(){lookup=deferred();},releaseLookup(){const old=lookup;lookup=null;old.resolve();},
 answer(id,status=200,data){const c=this.calls.find(c=>c.id===id);if(!c||c.settled)throw Error('Invalid owned reply');c.settled=true;c.resolve(Response.json(data??c.reply,{status}));},
 headers(id,status){const c=this.calls.find(c=>c.id===id);let controller;const stream=new ReadableStream({start(value){controller=value;}});c.settled=true;c.resolve(new Response(stream,{status,headers:{'Content-Type':'application/json'}}));
  this.releaseBody=()=>{controller.enqueue(new TextEncoder().encode(JSON.stringify(c.reply)));controller.close();};},
 button(label){const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||x.textContent).trim()===label);if(!b)throw Error('Missing '+label);return b;},
 click(label){flushSync(()=>this.button(label).click());},check(){flushSync(()=>document.querySelector('input[type=checkbox]').click());},
 capture(label){const b=this.button(label),key=Object.keys(b).find(k=>k.startsWith('__reactProps$'));this.retained=b[key].onClick;},
 snapshot(){return{text:document.getElementById('root').textContent,checkbox:document.querySelector('input[type=checkbox]')?.checked,
  buttons:[...document.querySelectorAll('button')].map(b=>({text:b.textContent,disabled:b.disabled})),
  calls:this.calls.map(({id,path,method,body,token,settled})=>({id,path,method,body,token,settled})),notices:this.notices,
  width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,
  overflow:[...document.querySelectorAll('#root *')].filter(n=>{const r=n.getBoundingClientRect();return r.width>0&&(r.left<-.5||r.right>innerWidth+.5);}).map(n=>n.tagName+':'+n.textContent.slice(0,50))};},
};
export const hasSupabaseFrontendEnv=true,supabase={auth:{async getSession(){if(lookup)await lookup.promise;return{data:{session},error:null};},onAuthStateChange(fn){sdk.add(fn);return{data:{subscription:{unsubscribe(){sdk.delete(fn);}}}};}}};
export const sessionAuth={onAuthStateChange:supabase.auth.onAuthStateChange};
for(const key of ['getItem','setItem','removeItem','clear'])Storage.prototype[key]=()=>{if(key==='getItem')return null;throw Error('Browser persistence forbidden');};
globalThis.fetch=(input,init={})=>{
 const url=new URL(String(input),location.origin),method=(init.method||'GET').toUpperCase();
 if(url.origin!==location.origin||!/^\\/api\\/crm\\/site-inquiry-deletion(?:-operations)?$/.test(url.pathname))throw Error('External or unrelated request');
 const token=new Headers(init.headers).get('Authorization'),actor=token?.includes('synthetic-B')?ids.b:ids.a;
 const available=f.rows.filter(r=>r.workspaceId===url.searchParams.get('workspaceId')&&r.actorId===actor);
 let reply;
 if(method==='GET')reply={success:true,data:{operations:available.filter(r=>!r.acknowledgedAt).map(r=>structuredClone(r)),complete:true,deletionEnabled:true}};
 else {
  const body=JSON.parse(init.body),key=body.requestKey,op=available.find(r=>r.requestKey===key);if(!op)throw Error('Wrong owner/request');
  if(url.pathname.endsWith('-operations')){
   if(body.action==='abandon'){op.state=f.commitWins?'committed':'abandoned';op.completedAt=stamp;op.receiptsDeleted=f.commitWins?1:null;}
   else if(body.action==='acknowledge'){if(op.state==='prepared')throw Error('Acknowledging prepared intent forbidden');op.acknowledgedAt=stamp;}
   else throw Error('Unexpected operation');reply={success:true,data:{operation:structuredClone(op)}};
  }else {if(JSON.stringify(body)!==JSON.stringify(op.request))throw Error('Original payload bytes changed');op.state='committed';op.completedAt=stamp;op.receiptsDeleted=1;
   reply={success:true,data:{deleted:true,receiptsDeleted:1,replayed:false}};}
 }
 const d=deferred(),c={...d,id:f.calls.length+1,path:url.pathname,method,body:init.body,token,reply,settled:false};f.calls.push(c);
 const held=method==='GET'?f.holdReads>0:f.holdWrites>0;
 if(held){if(method==='GET')f.holdReads--;else f.holdWrites--;}else{c.settled=true;d.resolve(Response.json(reply));}
 return d.promise;
};
`;

test("owned browser: durable deletion recovery controls and original-scope dispatch", { timeout: 180_000 }, async t => {
  t.after(() => esbuild.stop());
  const entry = `import {StrictMode} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {SiteDeletionRecovery} from './src/components/crm/site-deletion-recovery';import {crmFetch} from './src/lib/api';import {f} from 'owned-recovery';
const root=createRoot(document.getElementById('root'));f.renderApp=props=>root.render(<StrictMode><SiteDeletionRecovery {...props}/></StrictMode>);f.clearApp=()=>root.render(null);
f.bind(root,(actorId,workspaceId,lifetime)=>({actorId,workspaceId,lifetime,request:(path,init={})=>crmFetch(path,{...init,expectedUserId:actorId,
 dispatchGuard:()=>lifetime.isCurrent()&&!init.signal?.aborted&&(init.dispatchGuard?.()??true)}),onDeleted:leadId=>f.notices.push({actorId,workspaceId,leadId})}));
f.reset();window.__analyticsFixture=f;`;
  const result = await esbuild.build({ stdin: { contents: entry, resolveDir: frontend, sourcefile: "deletion-recovery-owned.tsx", loader: "tsx" },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", metafile: true,
    define: { "process.env.NODE_ENV": '"development"', "import.meta.env": "{}" },
    plugins: [{ name: "owned-recovery-only", setup(build: any) {
      build.onResolve({ filter: /^(?:owned-recovery|@\/lib\/supabase)$/ }, () => ({ path: "mocks", namespace: "owned" }));
      build.onLoad({ filter: /^mocks$/, namespace: "owned" }, () => ({ contents: mocks, loader: "tsx", resolveDir: frontend }));
      build.onResolve({ filter: /^@\// }, (args: { path: string }) => ({ path: path.join(frontend, "src", args.path.slice(2) + ".ts") }));
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, (args: { path: string }) => { assert.doesNotMatch(args.path.replaceAll("\\", "/"), /\/src\/(?:contexts\/AuthContext|lib\/supabase)\.[jt]sx?$/); return undefined; });
    } }],
  });
  for (const file of ["components/crm/site-deletion-recovery.tsx", "lib/siteDeletionOperations.ts", "lib/api.ts", "lib/serverAuth.ts"]) assert.ok(Object.keys(result.metafile.inputs).some(name => name.replaceAll("\\", "/").endsWith("/src/" + file)), file);
  const assets = path.join(frontend, "dist/public/assets");
  const styles = (await readdir(assets)).filter(name => /^index-.*\.css$/.test(name));assert.equal(styles.length, 1, "Use the existing real build stylesheet, not invented fixture styling");
  const css = await readFile(path.join(assets, styles[0]), "utf8");
  const fontDirectory = path.join(frontend, "dist/public/fonts/inter"), fonts = new Map<string, Buffer>();
  for (const name of (await readdir(fontDirectory)).filter(name => /^inter-(?:latin|cyrillic|cyrillic-ext)\.woff2$/.test(name))) fonts.set(`/fonts/inter/${name}`, await readFile(path.join(fontDirectory, name)));
  const server = createServer((req, res) => {
    if (req.headers.host !== `127.0.0.1:${(server.address() as any).port}` || req.method !== "GET") { res.writeHead(403).end(); return; }
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; font-src 'self' data:; img-src 'none'; form-action 'none'");
    if (req.url === "/bundle.js") { res.setHeader("Content-Type", "application/javascript"); res.end(result.outputFiles[0].text); return; }
    if (fonts.has(req.url ?? "")) { res.setHeader("Content-Type", "font/woff2"); res.end(fonts.get(req.url!)); return; }
    if (req.url === "/favicon.ico") { res.writeHead(204).end(); return; }
    if (req.url !== "/") { res.writeHead(404).end(); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");res.end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style></head><body><main class="mx-auto w-full max-w-[1440px] p-4" id="root"></main><script src="/bundle.js"></script></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const b = await ownedAnalyticsBrowser(origin, "f && document.body.textContent.includes('Результат не подтверждён')");t.after(b.close);
  const run = b.evaluate, settle = () => run("for(let i=0;i<10;i++)await new Promise(resolve=>setTimeout(resolve,0));");
  const state = () => run<any>("return f.snapshot();");
  const reset = async () => { await run("f.reset();"); await settle(); };
  for (const [width, height] of [[390, 844], [1440, 900]]) {
    await t.test(`${width}px current load is read-only, exact original retry is explicit and double click cannot resend`, async () => {
      await b.viewport(width, height);await reset();assert.equal((await state()).calls.filter((c: any) => c.method === "POST").length, 0);
      await run("f.click('Повторить');");await settle();assert.equal((await state()).calls.filter((c: any) => c.method === "POST").length, 0);
      await run("f.check();f.capture('Повторить');f.click('Повторить');f.retained();");await settle();const s = await state();
      assert.equal(s.calls.filter((c: any) => c.method === "POST").length, 1);assert.equal(s.notices.length, 1);assert.match(s.text, /Удалено/);
      assert.equal(s.width, width);assert.ok(s.scrollWidth <= width);assert.deepEqual(s.overflow, []);
    });
    await reset();await run("await document.fonts.ready;");await writeFile(path.join(root, `node_modules/.cache/g60-deletion-recovery-${width}.png`), await b.screenshot());
  }
  await t.test("refresh invalidates confirmation; an older GET cannot replace the newer committed receipt", async () => {
    await reset();await run("f.check();f.holdReads=2;f.revise();");await settle();await run("f.revise();");await settle();
    const calls = (await state()).calls.filter((c: any) => !c.settled);assert.equal(calls.length, 2);
    await run(`const c=f.calls.find(c=>c.id===${calls[1].id});c.reply.data.operations[0].state='committed';c.reply.data.operations[0].completedAt='2026-10-26T08:00:01Z';c.reply.data.operations[0].receiptsDeleted=1;f.answer(c.id);`);await settle();
    assert.match((await state()).text, /Удалено/);await run(`f.answer(${calls[0].id});`);await settle();assert.match((await state()).text, /Удалено/);assert.doesNotMatch((await state()).text, /Результат не подтверждён/);
  });
  for (const boundary of ["actor", "aba", "workspace", "unmount"]) for (const method of ["read", "write"]) {
    await t.test(`${boundary}: pending ${method} response cannot publish, call another owner's callback or resend`, async () => {
      await reset();await run(method === "read" ? "f.holdReads=1;f.click('Проверить операции');" : "f.check();f.holdWrites=1;f.capture('Повторить');f.click('Повторить');");await settle();
      const call = (await state()).calls.find((c: any) => !c.settled);assert.ok(call);
      await run(boundary === "actor" ? "f.change('b');" : boundary === "aba" ? "f.raw('b');f.raw('a');f.change('a');" : boundary === "unmount" ? "f.unmount();" : "f.workspace();");await settle();
      const before = (await state()).calls.length;await run(`f.answer(${call.id});if(f.retained)f.retained();`);await settle();const s = await state();
      assert.deepEqual(s.notices, []);assert.equal(s.calls.length, before);
      if (boundary === "actor" || boundary === "workspace") { assert.match(s.text, /b0000000/);assert.doesNotMatch(s.text, /a0000000/); }
      if (boundary === "unmount") assert.equal(s.text, "");
    });
  }
  await t.test("scope retirement during the actual API token lookup prevents any mutation dispatch", async () => {
    await reset();await run("f.check();f.holdLookup();f.capture('Повторить');f.click('Повторить');");await settle();
    const before = (await state()).calls.length;await run("f.raw('b');f.raw('a');f.releaseLookup();");await settle();
    assert.equal((await state()).calls.length, before);assert.deepEqual((await state()).notices, []);
  });
  await t.test("same-owner token refresh preserves original intent and never auto-posts", async () => {
    await reset();const before = (await state()).calls.length;await run("f.check();f.refresh();");await settle();assert.equal((await state()).calls.length, before);assert.equal((await state()).checkbox, true);
    await run("f.click('Повторить');");await settle();assert.equal((await state()).calls.find((c: any) => c.method === "POST").token, "Bearer synthetic-refreshed-A");
  });
  for (const status of [401, 403]) await t.test(`${status} headers hide retained operation controls before a delayed denial body`, async () => {
    await reset();await run("f.holdReads=1;f.click('Проверить операции');");await settle();const c = (await state()).calls.find((c: any) => !c.settled);
    await run(`f.headers(${c.id},${status});`);await settle();assert.equal((await state()).text, "");await run("f.releaseBody();");await settle();assert.equal((await state()).text, "");
  });
  await t.test("abandon-after-commit shows committed, not cancelled; acknowledgement never calls execute", async () => {
    await reset();await run("f.commitWins=true;f.click('Отказаться от выполнения');");await settle();assert.match((await state()).text, /Удалено/);assert.doesNotMatch((await state()).text, /Выполнение отменено/);assert.equal((await state()).notices.length, 1);
    await run("f.click('Убрать из списка');");await settle();assert.equal((await state()).text, "");
    assert.ok((await state()).calls.filter((c: any) => c.method === "POST").every((c: any) => c.path.endsWith('-operations')));
  });
  assert.deepEqual(b.exceptions, []);assert.ok(b.requests.every(url => url.startsWith(origin + "/")));
});

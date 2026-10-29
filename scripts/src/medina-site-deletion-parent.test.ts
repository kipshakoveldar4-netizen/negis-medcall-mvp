import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Real LeadsPage/session/deletion/api.ts/serverAuth.ts/authSignOut.ts and React.
// Only app chrome, collection data, Auth/SDK and HTTP are synthetic. No app env.
// Green: node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-site-deletion-parent.test.ts
// Red: node scripts/node_modules/tsx/dist/cli.mjs scripts/src/medina-site-deletion-parent.test.ts --baseline
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const frontend = path.join(root, "artifacts/negis");
const require = createRequire(path.join(frontend, "package.json"));
const esbuild = createRequire(require.resolve("vite/package.json"))("esbuild");
const baseline = process.argv.includes("--baseline");
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const mocks = `
import {useState,useSyncExternalStore} from 'react';import {flushSync} from 'react-dom';
export const ids={wa:'00000000-0000-4000-8000-000000000001',la:'00000000-0000-4000-8000-000000000002',ra:'00000000-0000-4000-8000-000000000003',
 wb:'00000000-0000-4000-8000-000000000011',lb:'00000000-0000-4000-8000-000000000012',aa:'00000000-0000-4000-8000-000000000021',ab:'00000000-0000-4000-8000-000000000022'};
const initial=()=>({user:{id:ids.aa},session:{user:{id:ids.aa}},clinicId:ids.wa,userRole:'owner',workspacePurpose:'clinic_services',
 rolePermissions:{tasks:false},isDemoMode:false,isImpersonation:false});
let context=initial(),selected=ids.wa,session={user:{id:ids.aa},access_token:'synthetic-token-A'},gate=null;
const listeners=new Set(),sdk=new Set();
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const version='2026-09-28T11:00:00.123456+00:00';
export const fixture={calls:[],operations:[],operationReadFailure:false,deferExecution:false,writes:[],notices:[],wiring:null,history:[],lookups:0,
 reset(){context=initial();selected=ids.wa;session={user:{id:ids.aa},access_token:'synthetic-token-A'};gate=null;this.calls=[];this.operations=[];this.operationReadFailure=false;this.deferExecution=false;this.writes=[];this.notices=[];this.wiring=null;this.history=[];this.lookups=0;},
 patch(value){flushSync(()=>{context={...context,...value};for(const fn of listeners)fn();});},
 raw(actor,event='SIGNED_IN'){session=actor?{user:{id:actor},access_token:actor===ids.aa?'synthetic-token-A':'synthetic-token-B'}:null;
  for(const fn of [...sdk])fn(event,session);},
 silentActor(actor){session={user:{id:actor},access_token:'synthetic-token-B'};},
 actor(actor){flushSync(()=>{this.raw(actor);context={...context,user:actor?{id:actor}:null,session};for(const fn of listeners)fn();});},
 aba(){flushSync(()=>{this.raw(ids.ab);this.raw(ids.aa);});},
 refresh(){session={...session,access_token:'synthetic-refreshed-A'};flushSync(()=>{for(const fn of [...sdk])fn('TOKEN_REFRESHED',session);
  context={...context,user:{...context.user},session};for(const fn of listeners)fn();});},
 select(value){selected=value;},workspace(value){selected=value;this.patch({clinicId:value});},
 holdLookup(){gate=deferred();},releaseLookup(){const held=gate;gate=null;held.resolve();},
 preview(lead=ids.la){return{success:true,data:{leadId:lead,leadUpdatedAt:version,receiptIds:[ids.ra],receiptCount:1,
  confirmationRequired:true,reviewRequired:false,reviewReasons:[],deletionEnabled:true,deletionAvailability:'confirmation_required'}};},
 success(){return{success:true,data:{deleted:true,receiptsDeleted:1,replayed:false}};},
 answer(id,body,status=200){const call=this.calls.find(c=>c.id===id);if(!call||call.settled)throw Error('Invalid fake reply');call.settled=true;call.resolve(Response.json(body,{status}));},
 ready(){for(const c of this.calls.filter(c=>c.deletion&&c.method==='GET'&&!c.settled&&!c.held))this.answer(c.id,this.preview(new URL(c.path,location.origin).searchParams.get('leadId')));},
 holdBody(id,body){const c=this.calls.find(c=>c.id===id);let controller;const stream=new ReadableStream({start(c){controller=c;}});
  c.settled=true;c.resolve(new Response(stream,{headers:{'Content-Type':'application/json'}}));
  this.releaseBody=()=>{controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));controller.close();};},
 button(kind){const nodes=[...document.querySelectorAll('button')];const b=nodes.find(b=>kind==='detail'?b.getAttribute('aria-label')==='Подробнее':
  kind==='open'?b.hasAttribute('aria-expanded'):kind==='submit'?b.textContent.includes('Удалить заявку и'):kind==='retry'?b.textContent.includes('Повторить запрос'):false);
  if(!b)throw Error('Missing '+kind);return b;},
 click(kind){flushSync(()=>this.button(kind).click());},
 confirm(){const c=document.querySelector('input[type=checkbox]');if(!c)throw Error('Missing checkbox');flushSync(()=>c.click());},
 pageAccess(){const node=this.button('detail'),key=Object.keys(node).find(k=>k.startsWith('__reactFiber$'));
  for(let fiber=node[key];fiber;fiber=fiber.return)if(fiber.memoizedProps?.access?.loadTeamAnalytics)return fiber.memoizedProps.access;
  throw Error('Missing real LeadsPageContent access');},
 capture(){const b=this.button('submit'),key=Object.keys(b).find(k=>k.startsWith('__reactProps$'));this.oldSubmit=b[key].onClick;this.retained=this.wiring;},
 snapshot(){return{text:document.getElementById('root').textContent,deletion:document.querySelector('[aria-expanded]')?.closest('section')?.textContent||'',
  open:document.querySelector('[aria-expanded]')?.getAttribute('aria-expanded'),checked:document.querySelector('input[type=checkbox]')?.checked,
  calls:this.calls.map(c=>({id:c.id,path:c.path,method:c.method,body:c.body,token:c.token,deletion:c.deletion,settled:c.settled,aborted:c.signal?.aborted,cache:c.cache})),
  writes:this.writes,notices:this.notices,listeners:sdk.size};},
};
export function useAuth(){return useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn);},()=>context);}
export const hasSupabaseFrontendEnv=true;
export const supabase={auth:{onAuthStateChange(fn){sdk.add(fn);return{data:{subscription:{unsubscribe(){sdk.delete(fn);}}}};},
 async getSession(){fixture.lookups++;if(gate)await gate.promise;return{data:{session},error:null};}}};
export const sessionAuth={onAuthStateChange:supabase.auth.onAuthStateChange};
export const readWorkspaceId=()=>selected,isRealWorkspace=()=>true,workspaceScopedKey=key=>key;
export const readDemoStorage=(_key,fallback)=>fallback,writeDemoStorage=()=>{throw Error('Unrelated persistence forbidden');};
export function useDemoCollection(){const [items,setItems]=useState(()=>[{id:context.user?.id===ids.ab?ids.lb:ids.la,
 name:context.user?.id===ids.ab?'PRIVATE_B':'PRIVATE_A',phone:'',source:'website',sourceKey:'website',campaign:'',status:'new',notes:'',createdAt:version}]);
 return{items,loaded:true,loadError:null,setItems(update){fixture.writes.push({actor:context.user?.id});setItems(update);},
 addItem(){throw Error('Generic CRUD forbidden');},updateItem(){throw Error('Generic CRUD forbidden');}};}
export function PageLayout({children}){return <main>{children}</main>;}
export function PageHeader({title,actions}){return <header><h1>{title}</h1>{actions}</header>;}
export function MetricCard(){return null;}export function EmptyState(){return null;}
export function TaskPanel(){return null;}export function ChangeLogPanel(){return null;}export function LeadTeamAnalytics(){return null;}
export function Link({children,href,...props}){return <a href={href} {...props}>{children}</a>;}
export const toast={success:message=>fixture.notices.push(message),error:message=>fixture.notices.push(message)};
Storage.prototype.getItem=()=>null;
for(const method of ['setItem','removeItem','clear'])Storage.prototype[method]=()=>{throw Error('Persistence forbidden');};
globalThis.fetch=(input,init={})=>{
 const path=String(input),url=new URL(path,location.origin),method=(init.method||'GET').toUpperCase();
 if(url.origin!==location.origin||!/^\\/api\\/crm\\/(?:site-inquiry-deletion(?:-preview|-operations)?|lead-stages|lead-sources|lead-assignees|meta-launches)$/.test(url.pathname))throw Error('Unrelated or external HTTP forbidden');
 if(url.pathname.endsWith('site-inquiry-deletion-operations')){
  fixture.operations.push({method,body:init.body});
  if(method==='GET')return Promise.resolve(fixture.operationReadFailure?Response.json({success:false,code:'site_deletion_unavailable'},{status:503}):Response.json({success:true,data:{operations:[],complete:true,deletionEnabled:true}}));
  const body=JSON.parse(init.body);if(method!=='POST'||body.action!=='prepare')throw Error('Unexpected operation mutation');
  if(fixture.deferExecution){fixture.deferExecution=false;fixture.holdLookup();}
  return Promise.resolve(Response.json({success:true,data:{operation:{workspaceId:url.searchParams.get('workspaceId'),actorId:session.user.id,
   requestKey:body.request.requestKey,leadId:body.request.leadId,request:body.request,state:'prepared',createdAt:version,
   completedAt:null,acknowledgedAt:null,receiptsDeleted:null,replayed:false}}}));}
 const deletion=url.pathname.includes('site-inquiry-deletion');
 if(!deletion&&method!=='GET')throw Error('Generic CRUD forbidden');
 const d=deferred(),call={id:fixture.calls.length+1,path,method,body:init.body,signal:init.signal,cache:init.cache,
  token:new Headers(init.headers).get('Authorization'),deletion,resolve:d.resolve,reject:d.reject,settled:!deletion};fixture.calls.push(call);
 if(deletion)return d.promise;
 const field=url.pathname.endsWith('meta-launches')?'launches':url.pathname.endsWith('lead-stages')?'stages':url.pathname.endsWith('lead-sources')?'sources':'assignees';
 return Promise.resolve(Response.json({success:true,mode:'supabase',data:{[field]:[]}}));
};
`;

async function bundle() {
  const entry = `import {StrictMode} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import LeadsPage from './src/pages/LeadsPage';import {fixture} from 'parent-owned-mocks';
let app;fixture.mount=(options={})=>{fixture.reset();fixture.operationReadFailure=options.operationReadFailure===true;app=createRoot(document.getElementById('root'));flushSync(()=>app.render(<StrictMode><LeadsPage/></StrictMode>));};
fixture.unmount=()=>flushSync(()=>app.unmount());window.__parentFixture=fixture;fixture.mount();`;
  const result = await esbuild.build({ stdin: { contents: entry, sourcefile: "deletion-parent-owned.tsx", resolveDir: frontend, loader: "tsx" },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", metafile: true,
    define: { "process.env.NODE_ENV": '"development"', "import.meta.env": JSON.stringify({ BASE_URL: "/", VITE_API_BASE_URL: "" }) },
    plugins: [{ name: "owned-deletion-parent", setup(build: any) {
      build.onResolve({ filter: /^(parent-owned-mocks|@\/contexts\/AuthContext|@\/lib\/(?:supabase|demoStorage)|wouter|sonner|@\/components\/(?:layout\/PageLayout|ui\/(?:page-header|metric-card|empty-state)|crm\/(?:task-panel|change-log-panel|lead-team-analytics)))$/ },
        () => ({ path: "mocks", namespace: "owned" }));
      build.onLoad({ filter: /^mocks$/, namespace: "owned" }, () => ({ contents: mocks, loader: "tsx", resolveDir: frontend }));
      build.onResolve({ filter: /^@\/components\/crm\/site-inquiry-deletion$/ }, () => ({ path: "observe-deletion", namespace: "owned" }));
      build.onLoad({ filter: /^observe-deletion$/, namespace: "owned" }, () => ({ contents: `
import {SiteInquiryDeletion as Actual} from ${JSON.stringify(path.join(frontend, "src/components/crm/site-inquiry-deletion.tsx").replaceAll("\\", "/"))};
import {fixture} from 'parent-owned-mocks';
export function SiteInquiryDeletion(props){fixture.wiring=props;fixture.history.push(props);return <Actual {...props}/>;}
`, loader: "tsx", resolveDir: frontend }));
      build.onResolve({ filter: /^@\// }, (args: { path: string }) => {
        const base = path.join(frontend, "src", args.path.slice(2));
        const file = [base + ".ts", base + ".tsx"].find(existsSync); assert.ok(file, args.path); return { path: file };
      });
      build.onLoad({ filter: /\.(?:[cm]?[jt]sx?|json)$/ }, (args: { path: string }) => {
        assert.doesNotMatch(args.path, /(?:^|[/\\])\.env(?:\.|$)/);
        assert.doesNotMatch(args.path.replaceAll("\\", "/"), /\/src\/(?:contexts\/AuthContext|lib\/(?:supabase|demoStorage))\.[jt]sx?$/);
        if (baseline && args.path.replaceAll("\\", "/").endsWith("/src/pages/LeadsPage.tsx")) return {
          contents: execFileSync("git", ["show", "37e1d3e:artifacts/negis/src/pages/LeadsPage.tsx"], { cwd: root, encoding: "utf8" }), loader: "tsx",
        };
        return undefined;
      });
    } }],
  });
  const inputs = Object.keys(result.metafile.inputs).map(file => file.replaceAll("\\", "/"));
  for (const file of ["pages/LeadsPage.tsx", "components/crm/site-inquiry-deletion.tsx", "lib/siteInquiryDeletion.ts", "lib/api.ts", "lib/serverAuth.ts", "lib/authSignOut.ts"]) {
    assert.ok(inputs.some(input => input.endsWith(`/src/${file}`)), `Real composition must include ${file}`);
  }
  return result.outputFiles[0].text;
}

type Snapshot = { text: string; deletion: string; open?: string; checked?: boolean; notices: string[]; writes: unknown[]; listeners: number;
  calls: Array<{ id: number; path: string; method: string; body?: string; token: string; deletion: boolean; settled: boolean; aborted?: boolean; cache?: string }> };

test("owned Chromium: real LeadsPage/session and composed deletion transport", { timeout: 180_000 }, async t => {
  t.after(() => esbuild.stop());
  const browserPath = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(existsSync);
  assert.ok(browserPath, "Installed Chromium only; no download fallback");
  const script = await bundle();
  const server = createServer((req, res) => {
    if (req.headers.host !== `127.0.0.1:${(server.address() as any).port}` || req.method !== "GET" || !["/", "/bundle.js", "/favicon.ico"].includes(req.url ?? "")) { res.writeHead(403); res.end(); return; }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; form-action 'none'; frame-src 'none'");
    if (req.url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    if (req.url === "/bundle.js") { res.setHeader("Content-Type", "application/javascript"); res.end(script); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const profile = await mkdtemp(path.join(tmpdir(), "medina-site-deletion-parent-owned-"));
  const child = spawn(browserPath, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--disable-sync",
    "--disable-component-update", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
  { windowsHide: true, stdio: "ignore", env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "HOME", "DISPLAY"].includes(key))) });
  const exited = new Promise(resolve => { child.once("exit", resolve); child.once("error", resolve); });
  let socket: WebSocket | undefined, cdp: ((method: string, params?: Record<string, unknown>) => Promise<any>) | undefined;
  t.after(async () => {
    await cdp?.("Browser.close").catch(() => {}); await Promise.race([exited, delay(3000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, delay(3000)]); }
    socket?.close();
    assert.equal(path.dirname(profile), path.resolve(tmpdir())); assert.ok(path.basename(profile).startsWith("medina-site-deletion-parent-owned-"));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  let port = "";
  for (let i = 0; i < 250; i++) {
    assert.equal(child.exitCode, null);
    try { port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0]; } catch {}
    if (/^\d+$/.test(port)) break; await delay(40);
  }
  assert.match(port, /^\d+$/);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json();
  assert.ok(Array.isArray(targets), "Owned browser target list must be an array");
  const page = targets.find((value: any) => value.type === "page"); assert.ok(page);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const requests: string[] = [], exceptions: unknown[] = [], consoleErrors: unknown[] = []; let sequence = 0;
  socket.addEventListener("message", event => {
    const data = JSON.parse(String(event.data));
    if (data.method === "Network.requestWillBeSent") requests.push(data.params.request.url);
    if (data.method === "Runtime.exceptionThrown") exceptions.push(data.params.exceptionDetails);
    if (data.method === "Runtime.consoleAPICalled" && data.params.type === "error") consoleErrors.push(data.params.args);
    const item = pending.get(data.id); if (!item) return; clearTimeout(item.timer); pending.delete(data.id);
    if (data.error) item.reject(Error(JSON.stringify(data.error))); else item.resolve(data.result);
  });
  socket.addEventListener("close", () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error("Owned browser closed")); } pending.clear(); });
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(Error("Owned browser connect timeout")), 10_000);
    socket!.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket!.addEventListener("error", () => { clearTimeout(timer); reject(Error("Owned browser connection failed")); }, { once: true }); });
  cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(`Owned CDP timeout: ${method}`)); }, 15_000);
    pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (body: string): Promise<any> => {
    const result = await cdp!("Runtime.evaluate", { expression: `(async()=>{const f=window.__parentFixture;${body}})()`, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  await cdp("Network.enable"); await cdp("Runtime.enable"); await cdp("Page.navigate", { url: origin });
  let ready = false;
  for (let i = 0; i < 150; i++) { ready = await evaluate("return !!f && !!document.querySelector('[aria-label=Подробнее]');"); if (ready) break; await delay(20); }
  assert.ok(ready, JSON.stringify({ exceptions, consoleErrors }));
  const settle = () => evaluate("for(let i=0;i<10;i++)await new Promise(resolve=>setTimeout(resolve,0));");
  const state = (): Promise<Snapshot> => evaluate("return f.snapshot();");
  const deletionCalls = async () => (await state()).calls.filter(c => c.deletion);
  const reset = async () => { await evaluate("f.unmount();f.mount();"); await settle(); };
  const review = async () => {
    await evaluate("f.click('detail');"); await settle(); await evaluate("f.ready();"); await settle();
    await evaluate("f.click('open');"); await settle(); await evaluate("f.ready();"); await settle();
  };
  const submit = async () => { await evaluate("f.confirm();f.capture();f.click('submit');"); await settle();
    const call = (await deletionCalls()).filter(c => c.method === "POST").at(-1); assert.ok(call); return call; };

  await t.test("application hides deletion until durable-operation readiness is verified, then recovers without re-login", async () => {
    await evaluate("f.unmount();f.mount({operationReadFailure:true});"); await settle();
    await evaluate("f.click('detail');"); await settle();
    assert.equal((await state()).deletion, ""); assert.equal((await deletionCalls()).length, 0);
    assert.match((await state()).text, /Не удалось проверить операции удаления/);
    await evaluate("f.operationReadFailure=false;document.querySelector('button[aria-label=\"Проверить операции\"]').click();"); await settle();
    await evaluate("f.ready();"); await settle();
    assert.match((await state()).deletion, /Удаление заявки с сайта/);
    await evaluate("f.click('open');"); await settle(); await evaluate("f.ready();"); await settle();
    assert.equal((await state()).checked, false);
    assert.equal((await deletionCalls()).filter(c => c.method === "POST").length, 0);
  });

  await t.test("parent binds the real preview/POST to its actor and controller; same actor refresh keeps review and identities", async () => {
    await reset(); await review(); await evaluate("f.confirm();f.saved=f.wiring;f.savedAccess=f.pageAccess();");
    const before = await deletionCalls(); await evaluate("f.refresh();"); await settle();
    assert.equal(await evaluate("return f.saved.request===f.wiring.request;"), true, "No new request closure for token/context rerender");
    assert.equal(await evaluate("return f.saved.lifetime===f.wiring.lifetime;"), true);
    assert.equal(await evaluate("return f.savedAccess===f.pageAccess() && f.savedAccess.request===f.pageAccess().request;"), true);
    assert.equal((await state()).checked, true); assert.equal((await deletionCalls()).length, before.length);
    await evaluate("f.capture();f.click('submit');"); await settle(); const post = (await deletionCalls()).at(-1)!;
    assert.equal(post.method, "POST"); assert.equal(post.token, "Bearer synthetic-refreshed-A"); assert.equal(post.aborted, false); assert.equal(post.cache, "no-store");
    await evaluate(`f.answer(${post.id},f.success());`); await settle();
    assert.equal((await state()).notices.length, 1); assert.equal((await state()).writes.length, 1);
  });

  await t.test("silent selected workspace switch during token lookup refuses dispatch in the real API helper", async () => {
    await reset(); await review(); await evaluate("f.confirm();f.capture();f.holdLookup();f.click('submit');"); await settle();
    const before = await deletionCalls(); await evaluate("f.select('00000000-0000-4000-8000-000000000011');f.releaseLookup();"); await settle();
    assert.equal((await deletionCalls()).filter(c => c.method === "POST").length, 0);
    assert.equal((await deletionCalls()).length, before.length); assert.equal((await state()).deletion, "");
    assert.deepEqual((await state()).notices, []); assert.deepEqual((await state()).writes, []);
  });

  for (const phase of ["prepare", "execute"]) await t.test(`closing only the card during ${phase} token lookup blocks dispatch while the page session stays current`, async () => {
    await reset(); await review();
    await evaluate(`f.confirm();${phase === "prepare" ? "f.holdLookup();" : "f.deferExecution=true;"}f.click('submit');`); await settle();
    const prepares = await evaluate("return f.operations.filter(c=>c.method==='POST').length;");
    assert.equal(prepares, phase === "prepare" ? 0 : 1);
    await evaluate("document.querySelector('button[aria-label=Закрыть]').click();"); await settle();
    await evaluate("f.releaseLookup();"); await settle();
    assert.equal(await evaluate("return f.operations.filter(c=>c.method==='POST').length;"), prepares);
    assert.equal((await deletionCalls()).filter(c => c.method === "POST").length, 0);
    assert.deepEqual((await state()).notices, []); assert.deepEqual((await state()).writes, []);
    assert.equal(await evaluate("return f.pageAccess().isCurrent();"), true);
  });

  await t.test("silent SDK subject mismatch during token lookup cannot borrow B's token for A's deletion", async () => {
    await reset(); await review(); await evaluate("f.confirm();f.capture();f.holdLookup();f.click('submit');"); await settle();
    await evaluate("f.silentActor('00000000-0000-4000-8000-000000000022');f.releaseLookup();"); await settle();
    assert.equal((await deletionCalls()).filter(c => c.method === "POST").length, 0);
    assert.deepEqual((await state()).notices, []); assert.deepEqual((await state()).writes, []);
  });

  await t.test("SDK actor A/B/A abort notifies the deletion lifetime synchronously before React settles", async () => {
    await reset(); await review(); await evaluate("f.confirm();f.capture();f.syncNotifications=0;");
    const result = await evaluate(`const lifetime=f.retained.lifetime;
      if(!lifetime) return {missing:true};
      const unsubscribe=lifetime.subscribe(()=>f.syncNotifications++);f.raw('00000000-0000-4000-8000-000000000022');
      const result={current:lifetime.isCurrent(),notifications:f.syncNotifications};unsubscribe();return result;`);
    assert.deepEqual(result, { current: false, notifications: 1 }); await settle();
    const before = await deletionCalls(); await evaluate("f.raw('00000000-0000-4000-8000-000000000021');f.oldSubmit();f.retained.onDeleted();"); await settle();
    assert.equal((await deletionCalls()).length, before.length); assert.deepEqual((await state()).writes, []); assert.deepEqual((await state()).notices, []);
  });

  for (const boundary of ["actor", "aba", "workspace", "role", "purpose", "unmount", "silent-selector"]) {
    await t.test(`${boundary}: a captured parent callback cannot delete the current card or send again`, async () => {
      await reset(); await review(); await evaluate("f.confirm();f.capture();");
      const action = boundary === "actor" ? "f.actor('00000000-0000-4000-8000-000000000022');"
        : boundary === "aba" ? "f.aba();" : boundary === "workspace" ? "f.workspace('00000000-0000-4000-8000-000000000011');"
        : boundary === "role" ? "f.patch({userRole:'admin'});" : boundary === "purpose" ? "f.patch({workspacePurpose:'mortgage_leads'});"
        : boundary === "unmount" ? "f.unmount();" : "f.select('00000000-0000-4000-8000-000000000011');";
      await evaluate(action); await settle(); const before = await deletionCalls();
      await evaluate("f.oldSubmit();f.retained.onDeleted();"); await settle();
      assert.equal((await deletionCalls()).length, before.length); assert.deepEqual((await state()).notices, []); assert.deepEqual((await state()).writes, []);
      if (boundary === "actor") assert.doesNotMatch((await state()).text, /PRIVATE_A/);
    });
  }

  for (const operation of ["inspect", "submit"]) for (const point of ["headers", "body", "rejection"]) for (const boundary of ["actor", "aba", "silent-selector", "unmount"]) {
    await t.test(`composed late ${operation} ${point} after ${boundary} cannot publish or auto-resend`, async () => {
      await reset(); let call: Snapshot["calls"][number];
      if (operation === "submit") { await review(); call = await submit(); }
      else {
        await evaluate("f.click('detail');"); await settle(); call = (await deletionCalls()).at(-1)!; assert.ok(call);
      }
      await evaluate(`f.calls.find(c=>c.id===${call.id}).held=true;`);
      if (point === "body") {
        await evaluate(`f.holdBody(${call.id},${operation === "submit" ? "f.success()" : "f.preview()"});`); await settle();
      }
      await evaluate(boundary === "actor" ? "f.actor('00000000-0000-4000-8000-000000000022');"
        : boundary === "aba" ? "f.aba();" : boundary === "unmount" ? "f.unmount();" : "f.select('00000000-0000-4000-8000-000000000011');");
      await settle();
      if (boundary === "actor" || boundary === "aba") await review();
      const before = await deletionCalls();
      await evaluate(point === "body" ? "f.releaseBody();" : point === "rejection"
        ? `f.calls.find(c=>c.id===${call.id}).reject(Error('PRIVATE_LATE_ERROR_A'));`
        : `f.answer(${call.id},${operation === "submit" ? "f.success()" : "f.preview()"});`);
      await settle(); const after = await state();
      assert.deepEqual(after.notices, []); assert.deepEqual(after.writes, []);
      assert.equal((await deletionCalls()).length, before.length, "No late response may issue another request");
      if (boundary === "actor") {
        assert.match(after.text, /PRIVATE_B/); assert.doesNotMatch(after.text, /PRIVATE_A|PRIVATE_LATE_ERROR_A/);
        assert.equal(after.checked, false);
      }
      if (boundary === "silent-selector" || boundary === "unmount") assert.equal(after.deletion, "");
    });
  }

  await t.test("uncertain deletion survives same-actor refresh with one byte-identical explicit retry, never a new request key", async () => {
    await reset(); await review(); const post = await submit();
    await evaluate(`f.calls.find(c=>c.id===${post.id}).reject(Error('synthetic response loss'));`); await settle();
    assert.match((await state()).deletion, /Результат удаления не подтверждён/);
    const before = await deletionCalls(); await evaluate("f.saved=f.wiring;f.refresh();"); await settle();
    assert.equal(await evaluate("return f.saved.request===f.wiring.request && f.saved.lifetime===f.wiring.lifetime;"), true);
    assert.equal((await deletionCalls()).length, before.length); assert.match((await state()).deletion, /Результат удаления не подтверждён/);
    await evaluate("f.click('retry');"); await settle(); const retry = (await deletionCalls()).at(-1)!;
    assert.equal(retry.body, post.body); assert.equal(retry.path, post.path); assert.equal(retry.token, "Bearer synthetic-refreshed-A");
    await evaluate(`f.answer(${retry.id},{success:true,data:{deleted:true,receiptsDeleted:1,replayed:true}});`); await settle();
    assert.equal((await state()).notices.length, 1); assert.equal((await state()).writes.length, 1);
  });

  await t.test("silent selector mismatch before an explicit uncertain retry sends nothing, even after A is selected again", async () => {
    await reset(); await review(); const post = await submit();
    await evaluate(`f.calls.find(c=>c.id===${post.id}).reject(Error('synthetic response loss'));`); await settle();
    const before = await deletionCalls();
    await evaluate("f.select('00000000-0000-4000-8000-000000000011');f.click('retry');"); await settle();
    await evaluate("f.select('00000000-0000-4000-8000-000000000001');f.oldSubmit();"); await settle();
    assert.equal((await deletionCalls()).length, before.length); assert.equal((await state()).deletion, "");
    assert.deepEqual((await state()).notices, []); assert.deepEqual((await state()).writes, []);
  });
  assert.deepEqual(exceptions, []); assert.deepEqual(consoleErrors, []);
  assert.ok(requests.every(url => url.startsWith(origin + "/")), "Only the owned loopback page/bundle is visited");
});

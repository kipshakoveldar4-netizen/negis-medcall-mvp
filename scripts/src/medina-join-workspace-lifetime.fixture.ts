import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

// Owned headless profile only. Actual React, AuthClient, api.ts, serverAuth.ts,
// authSignOut.ts and Response streams; synthetic context, SDK HTTP and CRM HTTP.
// No application startup, environment files, credentials, mail or external network.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const frontend = path.join(root, "artifacts/negis");
const require = createRequire(path.join(frontend, "package.json"));
const esbuild = createRequire(require.resolve("vite/package.json"))("esbuild");
const pageFile = "artifacts/negis/src/pages/JoinWorkspace.tsx";
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const doubles = String.raw`
import React,{useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {AuthClient} from '@supabase/supabase-js';
const contextListeners=new Set(),listeners=new Set();
const local=new Map(),tab=new Map(),sdkStorage=new Map();
const props=node=>node?.[Object.keys(node).find(key=>key.startsWith('__reactProps$'))];
const base64url=value=>btoa(JSON.stringify(value)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const jwt=(actor,revision)=>base64url({alg:'HS256',typ:'JWT'})+'.'+base64url({
 sub:actor,email:actor.toLowerCase()+'@example.invalid',session_id:'synthetic-'+actor+'-'+revision,
 aud:'authenticated',exp:Math.floor(Date.now()/1000)+3600})+'.c3ludGhldGlj';
const user=actor=>({id:actor,email:actor.toLowerCase()+'@example.invalid',aud:'authenticated',role:'authenticated',
 app_metadata:{},user_metadata:{},created_at:'2026-10-25T00:00:00Z'});
const tokenActor=token=>JSON.parse(atob(token.split('.')[1].replaceAll('-','+').replaceAll('_','/'))).sub;
let actor='A',revision=1,current,app,mounted=false;
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function storage(map){return{getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)};}
const memory=storage(sdkStorage);
const sdk=new AuthClient({url:'https://auth.join-fixture.invalid/auth/v1',storageKey:'synthetic-join-auth',
 storage:memory,persistSession:true,autoRefreshToken:false,detectSessionInUrl:false,
 lock:async(_name,_timeout,fn)=>fn(),
 fetch:async(url,init={})=>{
  const path=new URL(url).pathname,authorization=new Headers(init.headers).get('Authorization');
  f.sdkHttp.push({path,method:init.method,actor:authorization?tokenActor(authorization.replace(/^Bearer /,'')):null});
  if(path==='/auth/v1/user'&&(init.method||'GET')==='GET')return Response.json(user(tokenActor(authorization.replace(/^Bearer /,''))));
  if(path==='/auth/v1/logout'&&init.method==='POST')return new Response(null,{status:204});
  if(path==='/auth/v1/token'&&new URL(url).searchParams.get('grant_type')==='refresh_token'&&init.method==='POST'){
   revision++;return Response.json({access_token:jwt(actor,revision),refresh_token:'synthetic-refresh-'+actor,
    token_type:'bearer',expires_in:3600,user:user(actor)});}
  throw Error('Forbidden synthetic SDK route '+path);
 }});
const f={calls:[],sdkHttp:[],lookups:[],held:[],captured:{},subscriptions:[],timers:[],navigations:[],notices:[],storageWrites:[],
 holdLookups:false,lookupMode:'snapshot',failLookup:false,suppressInitial:false,signouts:0,recoveries:0,
 async mount(options={}){
  await f.cleanup();
  f.calls=[];f.sdkHttp=[];f.lookups=[];f.held=[];f.captured={};f.subscriptions=[];f.timers=[];
  f.navigations=[];f.notices=[];f.storageWrites=[];f.signouts=0;f.recoveries=0;
  local.clear();tab.clear();actor=options.actor===null?null:(options.actor||'A');revision=1;
  f.holdLookups=!!options.holdLookups;f.lookupMode=options.lookupMode||'snapshot';f.failLookup=!!options.failLookup;
  f.suppressInitial=!!options.holdLookups||!!options.failLookup;
  if(options.stashed)tab.set('negis_pending_invite',options.stashed);
  fixtureWindow.location.search=options.missing?'':options.hash||options.stashed?'':'?token=synthetic-invite';
  fixtureWindow.location.hash=options.hash?'#token=synthetic-invite':'';
  if(actor){const result=await sdk.setSession({access_token:jwt(actor,revision),refresh_token:'synthetic-refresh-'+actor});
   if(result.error)throw result.error;}
  else await sdk.signOut();
  current={user:actor?user(actor):null,session:actor?{user:user(actor)}:null,clinicId:'synthetic-workspace-A',
   userRole:'owner',workspacePurpose:'clinic_services',vertical:'clinic',rolePermissions:{crm:true},
   isSigningOut:false,isDemoMode:false,isImpersonation:false};
  app=createRoot(document.getElementById('root'));mounted=true;
  flushSync(()=>app.render(options.strict===false?<Page/>:<React.StrictMode><Page/></React.StrictMode>));
 },
 unmount(){if(mounted){flushSync(()=>app.unmount());mounted=false;}},
 async cleanup(){f.unmount();f.releaseLookups();f.releaseBodies();
  for(const call of f.calls)if(!call.settled){call.settled=true;call.reject(new TypeError('Synthetic fixture cleanup'));}
  await new Promise(resolve=>setTimeout(resolve,0));},
 patch(value){flushSync(()=>{current={...current,...value};for(const fn of contextListeners)fn();});},
 async actor(value,event){actor=value;revision++;
  if(value){const result=await sdk.setSession({access_token:jwt(value,revision),refresh_token:'synthetic-refresh-'+value});if(result.error)throw result.error;}
  else await sdk.signOut();
 },
 async refresh(){const result=await sdk.refreshSession();if(result.error)throw result.error;},
 rawEvent(index,event='SIGNED_IN',value='B'){const entry=f.subscriptions[index];if(!entry)throw Error('Missing subscription');
  entry.callback(event,value?{user:user(value),access_token:jwt(value,99)}:null);},
 markLogout(){tab.set('negis_signout_pending_v1','1');},
 clearLogout(){tab.delete('negis_signout_pending_v1');},
 releaseLookups(){f.holdLookups=false;for(const item of f.lookups)if(!item.released){item.released=true;item.resolve();}},
 button(label){const node=[...document.querySelectorAll('button')].find(node=>node.textContent.trim()===label);
  if(!node)throw Error('Missing button '+label);return node;},
 capture(label,key=label){const node=f.button(label);f.captured[key]=props(node).onClick;},
 captureInput(key='input'){const node=document.querySelector('input');if(!node)throw Error('Missing input');f.captured[key]=props(node).onChange;},
 invoke(key){void f.captured[key]({target:{value:'stale-value'}});},
 click(label){f.button(label).click();},
 fill(value){const node=document.querySelector('input');if(!node)throw Error('Missing input');
  flushSync(()=>props(node).onChange({target:{value}}));},
 double(label){const fn=props(f.button(label)).onClick;flushSync(()=>{void fn();void fn();});},
 reply(index,body={success:true,data:{workspaceId:'synthetic-invited-workspace'}},status=200,holdBody=false){
  const call=f.calls[index];if(!call||call.settled)throw Error('Missing request '+index);call.settled=true;
  if(!holdBody){call.resolve(Response.json(body,{status}));return;}
  let controller;const stream=new ReadableStream({start(c){controller=c;}});
  call.response=new Response(stream,{status,headers:{'content-type':'application/json'}});call.resolve(call.response);
  f.held.push(()=>{controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));controller.close();});
 },
 lose(index){const call=f.calls[index];if(!call||call.settled)throw Error('Missing request');call.settled=true;call.reject(new TypeError('Synthetic lost response'));},
 releaseBodies(){for(const fn of f.held.splice(0))fn();},
 fireTimers(includeCancelled=false){for(const timer of f.timers.splice(0))if(includeCancelled||!timer.cancelled)timer.fn();},
 snapshot(){return{text:document.getElementById('root').textContent,inputs:[...document.querySelectorAll('input')].map(n=>n.value),
  buttons:[...document.querySelectorAll('button')].map(n=>({label:n.textContent.trim(),disabled:n.disabled})),
  calls:f.calls.map(c=>({url:c.url,method:c.method,body:c.body,authorization:c.authorization,aborted:!!c.signal?.aborted,settled:c.settled,bodyUsed:!!c.response?.bodyUsed})),
  local:Object.fromEntries(local),tab:Object.fromEntries(tab),storageWrites:f.storageWrites,navigations:f.navigations,notices:f.notices,
  lookups:f.lookups.map(c=>({actor:c.actor,released:c.released})),subscriptions:f.subscriptions.map(c=>({active:c.active})),
  signouts:f.signouts,recoveries:f.recoveries,timers:f.timers.map(t=>({cancelled:t.cancelled})),sdkHttp:f.sdkHttp,
  context:{actor:current.user?.id,role:current.userRole,workspace:current.clinicId}};},
};
export const fixtureWindow={location:{origin:'http://join.fixture.invalid',pathname:'/join',search:'',hash:'',assign:href=>f.navigations.push(href)},
 history:{replaceState(){fixtureWindow.location.search='';fixtureWindow.location.hash='';}},
 localStorage:storage(local),sessionStorage:storage(tab)};
for(const [name,map] of [['localStorage',local],['sessionStorage',tab]]){
 Object.defineProperty(window,name,{value:{getItem:key=>map.get(key)??null,
  setItem(key,value){f.storageWrites.push({store:name,key,value:String(value)});map.set(key,String(value));},
  removeItem(key){f.storageWrites.push({store:name,key,removed:true});map.delete(key);}},configurable:true});
 fixtureWindow[name]=window[name];
}
export const inviteSetTimeout=(fn,ms)=>{if(ms!==1400)throw Error('Unexpected invite timer');const timer={fn,cancelled:false};f.timers.push(timer);return timer;};
export const inviteClearTimeout=timer=>{timer.cancelled=true;};
export function useAuth(){return useSyncExternalStore(fn=>{contextListeners.add(fn);return()=>contextListeners.delete(fn);},()=>current);}
export const hasSupabaseFrontendEnv=true;
export const supabase={auth:{
 async getSession(){const held=f.holdLookups?deferred():null,mode=f.lookupMode,fail=f.failLookup;f.failLookup=false;
  const result=await sdk.getSession();
  if(held){f.lookups.push({...held,actor:result.data.session?.user.id,released:false});await held.promise;}
  if(fail)throw Error('Synthetic lookup failure');
  return mode==='latest'?sdk.getSession():result;
 },
 onAuthStateChange(callback){const entry={callback,active:true};f.subscriptions.push(entry);listeners.add(callback);
  const result=sdk.onAuthStateChange((event,session)=>{if(event!=='INITIAL_SESSION'||!f.suppressInitial)callback(event,session);});
  return{data:{subscription:{unsubscribe(){entry.active=false;listeners.delete(callback);result.data.subscription.unsubscribe();}}}};
 },
 signOut(){f.signouts++;return sdk.signOut();},
 resetPasswordForEmail(){f.recoveries++;throw Error('Fixture forbids mail');},
}};
// Facade compatibility only. This stamp is synthetic UI lifetime data, not storage authority.
export const sessionAuth={onAuthStateChange:supabase.auth.onAuthStateChange,capture:()=>({actor,revision}),signOut(scope,options){
 if(typeof scope?.isCurrent!=='function'||!scope.isCurrent()||scope.signal?.aborted)throw Error('Synthetic sign-out requires a current caller scope');
 if(scope.expected&&(scope.expected.actor!==actor||scope.expected.revision!==revision))throw Error('Synthetic sign-out stamp retired');
 f.signouts++;return sdk.signOut(options);}};
export const WORKSPACE_SELECTOR_KEY='negis_workspace_selector';
export function useLocation(){return['/join',href=>f.navigations.push(href)];}
export const toast={error:message=>f.notices.push({kind:'error',message}),success:message=>f.notices.push({kind:'success',message})};
globalThis.fetch=(url,init={})=>{
 if(url!=='/api/crm/staff-invitations/accept'||init.method!=='POST')throw Error('Forbidden fixture HTTP '+url);
 const wait=deferred();f.calls.push({url,method:init.method,body:JSON.parse(init.body),authorization:new Headers(init.headers).get('Authorization'),
  signal:init.signal,...wait,settled:false});return wait.promise;
};
let Page;
export function install(component){Page=component;window.__joinFixture=f;}
`;

export async function startJoinWorkspaceFixture(t: TestContext, baseline: boolean) {
  t.after(() => esbuild.stop());
  const browser = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"]
    .find(existsSync);
  assert.ok(browser, "An installed local headless browser is required; installs are forbidden");
  const built = await esbuild.build({ stdin: { contents: "import JoinWorkspace from './src/pages/JoinWorkspace';import {install} from 'join-fixture';install(JoinWorkspace);",
    resolveDir: frontend, sourcefile: "join-workspace-owned.tsx", loader: "tsx" },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"', "import.meta.env": '{"BASE_URL":"/"}' },
    plugins: [{ name: "join-only", setup(build: any) {
      build.onResolve({ filter: /^(join-fixture|@\/contexts\/AuthContext|@\/lib\/(supabase|demoStorage)|wouter|sonner)$/ },
        () => ({ path: "join-doubles", namespace: "join-fixture" }));
      build.onLoad({ filter: /.*/, namespace: "join-fixture" }, () => ({ contents: doubles, loader: "tsx", resolveDir: frontend }));
      build.onResolve({ filter: /^@\// }, (args: { path: string }) => {
        const allowed: Record<string, string> = { "@/lib/api": "api.ts", "@/lib/serverAuth": "serverAuth.ts", "@/lib/authSignOut": "authSignOut.ts" };
        assert.ok(allowed[args.path], `No unrelated application import: ${args.path}`);
        return { path: path.join(frontend, "src/lib", allowed[args.path]) };
      });
      build.onLoad({ filter: /JoinWorkspace\.tsx$/ }, async () => {
        const source = baseline ? execFileSync("git", ["show", `db73c4a:${pageFile}`], { cwd: root, encoding: "utf8" })
          : await readFile(path.join(root, pageFile), "utf8");
        return { contents: "import {fixtureWindow as window,inviteSetTimeout as setTimeout,inviteClearTimeout as clearTimeout} from 'join-fixture';\n" + source,
          loader: "tsx", resolveDir: path.join(frontend, "src/pages") };
      });
    } }],
  });
  const server = createServer((req, res) => {
    const origin = `127.0.0.1:${(server.address() as any).port}`;
    if (req.headers.host !== origin || req.method !== "GET" || !["/", "/bundle.js", "/favicon.ico"].includes(req.url ?? "")) {
      res.writeHead(403); res.end(); return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; form-action 'none'");
    if (req.url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    if (req.url === "/bundle.js") { res.setHeader("Content-Type", "text/javascript; charset=utf-8"); res.end(built.outputFiles[0].text); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<!doctype html><html><head></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const profile = await mkdtemp(path.join(tmpdir(), "medina-join-workspace-owned-"));
  const child = spawn(browser, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-extensions", "--disable-sync", "--disable-component-update", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
  { windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    env: Object.fromEntries(["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "HOME", "DISPLAY"]
      .map(key => [key, process.env[key]])) });
  let startupError = "";
  child.stderr?.on("data", chunk => { startupError = (startupError + String(chunk)).slice(-8000); });
  const exited = new Promise(resolve => { child.once("exit", resolve); child.once("error", resolve); });
  let socket: WebSocket | undefined;
  let cdp: ((method: string, params?: Record<string, unknown>) => Promise<any>) | undefined;
  t.after(async () => {
    await cdp?.("Browser.close").catch(() => {});
    await Promise.race([exited, delay(4000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, delay(4000)]); }
    socket?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    const resolved = path.resolve(profile);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith("medina-join-workspace-owned-"));
    await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  let port = "";
  for (let pass = 0; pass < 250; pass++) {
    assert.equal(child.exitCode, null, `Owned browser must stay running: ${startupError}`);
    try { port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0]; } catch {}
    if (/^\d+$/.test(port)) break;
    await delay(40);
  }
  assert.match(port, /^\d+$/);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json() as any[];
  const page = targets.find(value => value.type === "page"); assert.ok(page);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const exceptions: unknown[] = [], requests: string[] = []; let sequence = 0;
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
    if (message.method === "Network.requestWillBeSent") requests.push(message.params.request.url);
    const item = pending.get(message.id); if (!item) return;
    clearTimeout(item.timer); pending.delete(message.id);
    if (message.error) item.reject(Error(JSON.stringify(message.error))); else item.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error("Owned browser closed")); }
    pending.clear();
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Owned browser connect timeout")), 10_000);
    socket!.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket!.addEventListener("error", () => { clearTimeout(timer); reject(Error("Owned browser connection failed")); }, { once: true });
  });
  cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(`Owned browser timeout: ${method}`)); }, 10_000);
    pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression: string) => {
    const result = await cdp!("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await cdp("Runtime.enable"); await cdp("Network.enable"); await cdp("Page.navigate", { url: origin });
  for (let pass = 0; pass < 100; pass++) {
    if (await evaluate("!!window.__joinFixture")) break;
    await delay(30);
  }
  assert.equal(await evaluate("!!window.__joinFixture"), true, "Fixture loaded");
  const call = (method: string, ...args: unknown[]) => evaluate(`window.__joinFixture[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
  const snapshot = () => call("snapshot");
  const until = async (predicate: (state: any) => boolean, description: string) => {
    for (let pass = 0; pass < 80; pass++) {
      const state = await snapshot(); if (predicate(state)) return state;
      await delay(10);
    }
    assert.fail(`${description}: ${JSON.stringify(await snapshot())}`);
  };
  return { call, snapshot, until,
    async set(values: Record<string, unknown>) { await evaluate(`Object.assign(window.__joinFixture,${JSON.stringify(values)})`); },
    async checkIsolation() {
      assert.deepEqual(exceptions, [], "No uncaught browser/SDK/React errors");
      assert.ok(requests.every(url => url.startsWith(origin + "/")), `Loopback-only document requests: ${requests}`);
      const state = await snapshot();
      assert.equal(state.recoveries, 0, "No synthetic mail path invoked");
      assert.ok(state.sdkHttp.every((item: any) => ["/auth/v1/user", "/auth/v1/logout", "/auth/v1/token"].includes(item.path)));
    },
  };
}

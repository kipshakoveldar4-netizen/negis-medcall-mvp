import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Installed React/ReactDOM, actual component, push.ts, crmFetch and serverAuth.
// Only Auth/SDK, Notification, serviceWorker/PushManager and HTTP are fakes.
// The owned headless profile is new, loopback-only and removed on completion.
// Run: node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-push-settings-browser.test.ts
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const frontend = path.join(root, "artifacts/negis");
const require = createRequire(path.join(frontend, "package.json"));
const esbuild = createRequire(require.resolve("vite/package.json"))("esbuild");
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const mocks = `
import {useSyncExternalStore} from 'react';
import {flushSync} from 'react-dom';
const authListeners=new Set(),sdkListeners=new Set();
const session=(id='A',revision=0)=>({user:{id},access_token:'synthetic-token-'+id+'-'+revision});
let current,sdkSession,gates=new Map();
const gate=()=>{let resolve;return{promise:new Promise(done=>resolve=done),resolve:()=>resolve()};};
async function wait(name){const held=gates.get(name);if(held)await held.promise;}
export const fixture={requests:[],messages:[],renders:0,authReads:0,permissions:0,subscriptionReads:0,subscriptions:0,unsubscriptions:0,
 reset(here=false){current={user:{id:'A'},session:session(),clinicId:'workspace-A',isImpersonation:false,isDemoMode:false,isSigningOut:false};
 sdkSession=current.session;gates=new Map();Object.assign(this,{requests:[],messages:[],renders:0,authReads:0,permissions:0,subscriptionReads:0,subscriptions:0,unsubscriptions:0,here,failUnsubscribe:false,retained:null,immediate:null});},
 hold(name){gates.set(name,gate());},release(name){const held=gates.get(name);gates.delete(name);held?.resolve();},
 patch(value){flushSync(()=>{current={...current,...value};for(const fn of authListeners)fn();});},
 emit(id,event=id?'SIGNED_IN':'SIGNED_OUT',revision=0){sdkSession=id?session(id,revision):null;for(const fn of sdkListeners)fn(event,sdkSession);},
 refresh(){flushSync(()=>{this.emit('A','TOKEN_REFRESHED',1);current={...current,session:sdkSession};for(const fn of authListeners)fn();});},
 account(id){flushSync(()=>{this.emit(id);current={...current,user:{id},session:sdkSession};for(const fn of authListeners)fn();});},
 aba(){flushSync(()=>{this.emit('B');this.emit('A');});},
 capture(){const node=document.querySelector('button');if(!node)throw Error('No committed action');
 const key=Object.keys(node).find(key=>key.startsWith('__reactProps$'));if(!key)throw Error('Missing real React committed props');this.retained=node[key].onClick;},
 beforeLookup(){flushSync(()=>{const before=this.counts();this.emit('B');this.retained();this.emit('A');this.retained();this.immediate={before,after:this.counts()};});},
 click(){const node=document.querySelector('button');if(!node)throw Error('No action');node.click();},
 counts(){return{authReads:this.authReads,permissions:this.permissions,subscriptions:this.subscriptions,unsubscriptions:this.unsubscriptions,subscriptionReads:this.subscriptionReads};},
 reply(index,status,value,holdBody=false,raw=false){const req=this.requests[index];if(!req||req.replied)throw Error('Invalid pending HTTP '+index);req.replied=true;
 let controller;const body=new ReadableStream({start(value){controller=value;}});req.controller=controller;
 const response=new Response(body,{status,headers:{'Content-Type':'application/json'}});const json=response.json.bind(response);
 response.json=()=>{req.reads++;return json();};req.resolve(response);if(!holdBody)this.body(index,value,raw);},
 body(index,value,raw=false){const req=this.requests[index];req.controller.enqueue(new TextEncoder().encode(raw?value:JSON.stringify(value)));req.controller.close();},
 list(index=this.requests.length-1,count=2){this.reply(index,200,{success:true,available:true,vapidPublicKey:'AQID',devices:Array.from({length:count},(_,id)=>({id:String(id),endpointTail:'synthetic-tail',label:'Synthetic device',lastSuccessAt:'',revoked:false,gone:false}))});},
 state(){return{text:document.getElementById('root').textContent,button:document.querySelector('button')?.textContent??null,
 disabled:document.querySelector('button')?.disabled??null,messages:[...this.messages],counts:this.counts(),here:this.here,renders:this.renders,
 listeners:sdkListeners.size,immediate:this.immediate,requests:this.requests.map(({method,url,token,body,reads,aborted})=>({method,url,token,body,reads,aborted}))};},
};
const subscription={endpoint:'https://push.example.test/private-endpoint-A',getKey:name=>new Uint8Array(name==='auth'?[11,12]:[21,22]).buffer,
 async unsubscribe(){fixture.unsubscriptions++;await wait('unsubscribe');if(fixture.failUnsubscribe)throw Error('Synthetic browser unsubscribe failure');fixture.here=false;return true;}};
const registration={pushManager:{async getSubscription(){fixture.subscriptionReads++;await wait('getSubscription');return fixture.here?subscription:null;},
 async subscribe(options){fixture.subscriptions++;if(!options.userVisibleOnly||String(new Uint8Array(options.applicationServerKey))!=='1,2,3')throw Error('Wrong subscribe contract');
 await wait('subscribe');fixture.here=true;return subscription;}}};
Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{get ready(){return wait('ready').then(()=>registration);}}});
Object.defineProperty(window,'PushManager',{configurable:true,value:class SyntheticPushManager{}});
Object.defineProperty(window,'Notification',{configurable:true,value:{permission:'default',async requestPermission(){fixture.permissions++;await wait('permission');return 'granted';}}});
globalThis.fetch=(url,init={})=>{if(!String(url).startsWith('/api/crm/push-subscriptions?workspaceId=workspace-'))throw Error('Unexpected synthetic HTTP '+url);
 if(init.cache!=='no-store')throw Error('Push requests must bypass the shared cache');
 let resolve;const promise=new Promise(done=>resolve=done);const req={method:init.method||'GET',url:String(url),token:new Headers(init.headers).get('Authorization'),
 body:init.body?JSON.parse(init.body):null,reads:0,aborted:init.signal?.aborted||false,resolve};
 init.signal?.addEventListener('abort',()=>req.aborted=true,{once:true});fixture.requests.push(req);return promise;};
export const hasSupabaseFrontendEnv=true;
export const supabase={auth:{onAuthStateChange(fn){sdkListeners.add(fn);return{data:{subscription:{unsubscribe(){sdkListeners.delete(fn);}}}};},
 async getSession(){fixture.authReads++;const captured=sdkSession;await wait('token');return{data:{session:captured},error:null};}}};
export const sessionAuth={onAuthStateChange:supabase.auth.onAuthStateChange};
export function useAuth(){fixture.renders++;return useSyncExternalStore(fn=>{authListeners.add(fn);return()=>authListeners.delete(fn);},()=>current);}
export const toast={success:value=>fixture.messages.push('success:'+value),error:value=>fixture.messages.push('error:'+value)};
// The actual sign-out fence can inspect only empty synthetic storage.
Storage.prototype.getItem=()=>null;
Storage.prototype.setItem=()=>{throw Error('Unexpected storage write');};
Storage.prototype.removeItem=()=>{throw Error('Unexpected storage removal');};
fixture.reset();
`;

async function bundle() {
  const component = path.join(frontend, "src/components/layout/PushSettings.tsx").replaceAll("\\", "/");
  const result = await esbuild.build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {PushSettings,PushSync} from ${JSON.stringify(component)};import {fixture} from 'push-fixture';
let app;fixture.unmount=()=>{if(app){flushSync(()=>app.unmount());app=null;}};
fixture.mount=(sync=false,here=false)=>{fixture.unmount();fixture.reset(here);app=createRoot(document.getElementById('root'));
flushSync(()=>app.render(sync?<PushSync/>:<PushSettings/>));};fixture.mount();window.__pushFixture=fixture;`,
    resolveDir: frontend, loader: "tsx", sourcefile: "push-owned-browser.tsx" },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
    plugins: [{ name: "synthetic-push-boundaries", setup(build: any) {
      build.onResolve({ filter: /^(push-fixture|@\/contexts\/AuthContext|@\/lib\/supabase|sonner)$/ }, () => ({ path: "mocks", namespace: "push-fixture" }));
      build.onLoad({ filter: /.*/, namespace: "push-fixture" }, () => ({ contents: mocks, loader: "tsx", resolveDir: frontend }));
      build.onResolve({ filter: /^@\// }, (args: { path: string }) => ({ path: path.join(frontend, "src", args.path.slice(2) + ".ts") }));
    } }],
  });
  return result.outputFiles[0].text;
}

async function connect(url: string, events: (method: string, params: any) => void) {
  const ws = new WebSocket(url), pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let id = 0;
  ws.addEventListener("message", event => {
    const data = JSON.parse(String(event.data));
    if (!data.id) { events(data.method, data.params); return; }
    const item = pending.get(data.id); if (!item) return;
    clearTimeout(item.timer); pending.delete(data.id);
    if (data.error) item.reject(Error(JSON.stringify(data.error))); else item.resolve(data.result);
  });
  ws.addEventListener("close", () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error("Owned browser closed")); } pending.clear(); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(Error("Owned browser connection timed out")); }, 10_000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(Error("Owned browser connection failed")); }, { once: true });
  });
  return { call(method: string, params: Record<string, unknown> = {}): Promise<any> { return new Promise((resolve, reject) => {
    const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(Error("Owned CDP timeout: " + method)); }, 10_000);
    pending.set(next, { resolve, reject, timer }); ws.send(JSON.stringify({ id: next, method, params }));
  }); }, close() { ws.close(); } };
}

test("actual React PushSettings / PushSync owned-browser acceptance", { timeout: 180_000 }, async t => {
  t.after(() => esbuild.stop());
  const browser = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(existsSync);
  assert.ok(browser, "Installed Chromium required; no install or download fallback");
  const script = await bundle();
  const server = createServer((req, res) => {
    const port = (server.address() as { port: number }).port;
    if (req.headers.host !== `127.0.0.1:${port}` || req.method !== "GET" || !["/", "/bundle.js", "/favicon.ico"].includes(req.url!)) { res.writeHead(403); res.end(); return; }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; form-action 'none'; frame-src 'none'");
    if (req.url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    if (req.url === "/bundle.js") { res.setHeader("Content-Type", "application/javascript"); res.end(script); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<!doctype html><html lang="ru"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const profile = await mkdtemp(path.join(tmpdir(), "medina-push-owned-"));
  const child = spawn(browser, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions",
    "--disable-sync", "--disable-component-update", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
  { windowsHide: true, stdio: "ignore" });
  const exited = new Promise(resolve => { child.once("exit", resolve); child.once("error", resolve); });
  let cdp: Awaited<ReturnType<typeof connect>> | undefined;
  t.after(async () => {
    if (cdp) await cdp.call("Browser.close").catch(() => {});
    await Promise.race([exited, delay(3000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, delay(3000)]); }
    cdp?.close();
    const target = path.resolve(profile);
    assert.equal(path.dirname(target), path.resolve(tmpdir())); assert.ok(path.basename(target).startsWith("medina-push-owned-"));
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  let port = "";
  for (let i = 0; i < 250; i++) {
    assert.equal(child.exitCode, null, "Owned browser exited before acceptance");
    try { port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0]; } catch {}
    if (/^\d+$/.test(port)) break; await delay(80);
  }
  assert.match(port, /^\d+$/);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json() as any[];
  const page = targets.find(value => value.type === "page"); assert.ok(page);
  const network: string[] = [], exceptions: unknown[] = [], forbidden: string[] = [];
  cdp = await connect(page.webSocketDebuggerUrl, (method, params) => {
    if (method === "Network.requestWillBeSent") network.push(params.request.url);
    if (method === "Runtime.exceptionThrown") exceptions.push(params.exceptionDetails);
    if (method === "Fetch.requestPaused") {
      const allowed = params.request.url.startsWith(origin + "/");
      if (!allowed) forbidden.push(params.request.url);
      void cdp!.call(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", { requestId: params.requestId, ...(!allowed ? { errorReason: "BlockedByClient" } : {}) }).catch(error => exceptions.push(String(error)));
    }
  });
  await cdp.call("Network.enable"); await cdp.call("Runtime.enable"); await cdp.call("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  const evaluate = async (body: string): Promise<any> => {
    const result = await cdp!.call("Runtime.evaluate", { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const act = (body: string) => evaluate(`const f=window.__pushFixture;${body}`);
  const until = async (condition: string) => {
    for (let i = 0; i < 150; i++) { if (await evaluate(condition)) return; await delay(20); }
    assert.fail(`Browser condition timed out: ${condition}; ${JSON.stringify(exceptions)}`);
  };
  const settle = () => evaluate("for(let i=0;i<8;i++)await new Promise(resolve=>setTimeout(resolve,0));");
  const state = () => act("return f.state();");
  const mount = async (here = false, sync = false) => { await act(`f.mount(${sync},${here});`); await settle(); };
  const loaded = async (here = false) => { await mount(here); await act("f.list();"); await until("return !!document.querySelector('button');"); };
  const request = (method: string) => until(`return window.__pushFixture.requests.at(-1)?.method===${JSON.stringify(method)};`);
  await cdp.call("Page.navigate", { url: origin }); await until("return !!window.__pushFixture;");

  await t.test("real effects enable, refresh and disable with confirmed HTTP and DOM rerenders", async () => {
    await loaded(); const before = await state(); assert.equal(before.requests.length, 1); assert.ok(before.renders >= 2);
    await act("f.click();"); await request("POST"); let s = await state();
    assert.equal(s.disabled, true); assert.equal(s.requests[1].token, "Bearer synthetic-token-A-0");
    assert.equal(s.requests[1].body.endpoint, "https://push.example.test/private-endpoint-A");
    await act("f.reply(1,200,{success:true});"); await request("GET"); await act("f.list();"); await settle();
    s = await state(); assert.match(s.button, /Выключить/); assert.equal(s.disabled, false); assert.equal(s.messages.length, 1);
    await act("f.click();"); await request("PATCH"); s = await state(); assert.equal(s.here, false); assert.equal(s.disabled, true);
    await act("f.reply(3,200,{success:true},true);"); await settle(); s = await state(); assert.equal(s.messages.length, 1, "PATCH headers alone are not confirmation");
    await act("f.body(3,{success:true});"); await request("GET"); await act("f.list();"); await settle();
    s = await state(); assert.match(s.button, /Включить/); assert.equal(s.disabled, false); assert.equal(s.messages.length, 2);
  });

  for (const [status, body, raw] of [[403, { success: false }, false], [503, { success: false }, false], [200, { success: false }, false],
    [200, {}, false], [200, { success: "true" }, false], [200, null, false], [200, "not-json", true]] as const) {
    await t.test(`PATCH ${status} ${JSON.stringify(body)} does not falsely confirm server revocation`, async () => {
      await loaded(true); await act("f.click();"); await request("PATCH"); await act(`f.reply(1,${status},${JSON.stringify(body)},false,${raw});`); await settle();
      const s = await state(); assert.equal(s.here, false, "local unsubscribe already happened and was not rolled back");
      assert.equal(s.counts.unsubscriptions, 1); assert.equal(s.messages.length, 1); assert.match(s.messages[0], /^error:/);
      assert.match(s.messages[0], /сервер/); assert.equal(s.messages.some((m: string) => m.startsWith("success:")), false);
    });
  }

  await t.test("browser unsubscribe failure is not described as local success or server failure", async () => {
    await loaded(true); await act("f.failUnsubscribe=true;f.click();"); await settle(); const s = await state();
    assert.equal(s.here, true); assert.match(s.button, /Выключить/); assert.equal(s.requests.length, 1);
    assert.equal(s.messages.length, 1); assert.match(s.messages[0], /^error:/); assert.doesNotMatch(s.messages[0], /сервер/);
  });

  const badReads = [[403, { success: false, vapidPublicKey: "AQID", devices: [] }, false], [503, { success: true, vapidPublicKey: "AQID", devices: [] }, false],
    [200, { success: false, vapidPublicKey: "AQID", devices: [] }, false], [200, { success: true, vapidPublicKey: 123, devices: [] }, false],
    [200, { success: true, vapidPublicKey: "AQID", devices: {} }, false], [200, { success: true, vapidPublicKey: "AQID", devices: [null] }, false],
    [200, { success: "true", vapidPublicKey: "AQID", devices: [] }, false],
    [200, { success: true, vapidPublicKey: "AQID", devices: [], available: "false" }, false],
    [200, null, false], [200, "invalid-json", true]] as const;
  for (const [status, body, raw] of badReads) await t.test(`GET ${status} ${JSON.stringify(body)} is not a ready device state`, async () => {
    await mount(); await act(`f.reply(0,${status},${JSON.stringify(body)},false,${raw});`); await settle(); const s = await state();
    assert.equal(s.button, null); assert.equal(s.counts.subscriptionReads, 0); assert.match(s.text, /Не удалось.*устройств/);
  });

  for (const [name, payload, expected] of [
    ["migration unavailable", { success: true, devices: [], vapidPublicKey: "AQID", available: false }, /миграция 044/],
    ["missing key / demo", { success: true, mode: "demo", devices: [], vapidPublicKey: "" }, /не настроены/],
  ] as const) await t.test(`valid GET ${name} retains the server's non-ready contract`, async () => {
    await mount(); await act(`f.reply(0,200,${JSON.stringify(payload)});`); await settle(); const s = await state();
    assert.equal(s.button, null); assert.match(s.text, expected); assert.deepEqual(s.messages, []);
  });

  for (const mode of ["account", "workspace", "logout", "unmount", "ABA"] as const) await t.test(`real pending permission is fenced after ${mode}`, async () => {
    await loaded(); await act("f.hold('permission');f.click();"); await settle(); const before = await state();
    assert.equal(before.counts.permissions, 1); assert.equal(before.disabled, true);
    await act(mode === "account" ? "f.account('B');" : mode === "workspace" ? "f.patch({clinicId:'workspace-B'});"
      : mode === "logout" ? "f.patch({isSigningOut:true});" : mode === "unmount" ? "f.unmount();" : "f.aba();");
    await settle(); const after = await state(); await act("f.release('permission');"); await settle(); const s = await state();
    assert.equal(s.requests.length, after.requests.length); assert.equal(s.counts.authReads, after.counts.authReads);
    assert.deepEqual(s.messages, []); assert.equal(s.requests.some((r: any) => r.method !== "GET"), false);
    if (mode === "unmount") { assert.equal(s.text, ""); assert.equal(s.listeners, 0); }
  });

  await t.test("real same-user token refresh preserves a current operation", async () => {
    await loaded(); await act("f.hold('permission');f.click();"); await settle(); await act("f.refresh();f.release('permission');"); await request("POST");
    assert.equal((await state()).requests.at(-1).token, "Bearer synthetic-token-A-1");
    await act("f.reply(1,200,{success:true});"); await request("GET"); await act("f.list();"); await settle();
    assert.equal((await state()).messages.length, 1); assert.match((await state()).button, /Выключить/);
  });

  await t.test("real committed retained handler rejects source SDK B and A/B/A before token lookup", async () => {
    await loaded(); await act("f.capture();f.beforeLookup();"); await settle(); const s = await state();
    assert.deepEqual(s.immediate.before, s.immediate.after); assert.deepEqual(s.messages, []);
    assert.equal(s.counts.permissions, 0); assert.equal(s.requests.some((r: any) => r.method !== "GET"), false);
    await act("f.list();"); await settle(); assert.match((await state()).button, /Включить/);
  });

  for (const action of ["enable", "disable"] as const) for (const stage of ["token", "headers", "body"] as const) {
    await t.test(`real ${action} late ${stage} stays silent after unmount`, async () => {
      await loaded(action === "disable"); await act(`${stage === "token" ? "f.hold('token');" : ""}f.capture();f.click();`); await settle();
      if (stage !== "token") { await request(action === "enable" ? "POST" : "PATCH"); if (stage === "body") { await act("f.reply(1,200,{success:true},true);"); await settle(); } }
      await act("f.unmount();f.retained();"); const before = await state();
      await act(stage === "token" ? "f.release('token');" : stage === "headers" ? "f.reply(1,200,{success:true});" : "f.body(1,{success:true});"); await settle();
      const s = await state(); assert.deepEqual(s.messages, []); assert.equal(s.requests.length, before.requests.length); assert.equal(s.text, ""); assert.equal(s.listeners, 0);
      if (stage !== "token") assert.equal(s.requests[1].aborted, true);
    });
  }

  for (const stage of ["headers", "body", "getSubscription"] as const) for (const mode of ["ABA", "unmount"] as const) {
    await t.test(`real load pending ${stage} ignores its old result after ${mode}`, async () => {
      await mount(true);
      const payload = { success: true, available: true, vapidPublicKey: "AQID", devices: [] };
      if (stage === "body") await act(`f.reply(0,200,${JSON.stringify(payload)},true);`);
      if (stage === "getSubscription") await act("f.hold('getSubscription');f.list(0);");
      await settle(); await act(mode === "ABA" ? "f.aba();" : "f.unmount();"); await settle(); const before = await state();
      await act(stage === "headers" ? `f.reply(0,200,${JSON.stringify(payload)});`
        : stage === "body" ? `f.body(0,${JSON.stringify(payload)});` : "f.release('getSubscription');");
      await settle(); const s = await state(); assert.equal(s.requests.length, before.requests.length); assert.equal(s.button, null);
      assert.equal(s.counts.subscriptionReads, before.counts.subscriptionReads); assert.deepEqual(s.messages, []);
      if (stage === "headers") assert.equal(s.requests[0].reads, 0);
    });
  }

  for (const action of ["enable", "disable"] as const) for (const mode of ["ABA", "unmount"] as const) {
    await t.test(`real ${action} pending getSubscription never forwards a retired endpoint after ${mode}`, async () => {
      await loaded(action === "disable"); await act("f.hold('getSubscription');f.click();"); await settle();
      await act(mode === "ABA" ? "f.aba();" : "f.unmount();"); await settle(); const before = await state();
      await act("f.release('getSubscription');"); await settle(); const s = await state();
      assert.equal(s.counts.authReads, before.counts.authReads); assert.equal(s.requests.length, before.requests.length);
      assert.equal(s.requests.some((r: any) => r.method !== "GET"), false); assert.deepEqual(s.messages, []);
    });
  }

  await t.test("real A/B/A during token lookup refuses the old write even when the resolved token is A", async () => {
    await loaded(); await act("f.hold('token');f.click();"); await settle(); assert.equal((await state()).counts.authReads, 2);
    await act("f.aba();"); await settle(); await act("f.release('token');"); await settle(); const s = await state();
    assert.equal(s.requests.length, 2, "only initial and replacement reads may dispatch");
    assert.equal(s.requests.some((r: any) => r.method !== "GET" || r.body !== null), false); assert.deepEqual(s.messages, []);
    // subscribeThisDevice completed before token lookup; no rollback is claimed.
    assert.equal(s.here, true);
    await act("f.list();"); await settle(); assert.match((await state()).button, /Выключить/);
  });

  await t.test("real workspace rerender hides old data and accepts only the replacement load", async () => {
    await loaded(); await act("f.patch({clinicId:'workspace-B'});"); await request("GET"); const before = await state(); assert.equal(before.button, null);
    assert.match(before.requests.at(-1).url, /workspaceId=workspace-B$/); await act("f.list(undefined,4);"); await settle(); assert.match((await state()).text, /Всего устройств.*4/);
  });
  await t.test("real PushSync effect repairs an existing device without permission and cleans its listener", async () => {
    await mount(true, true); await request("POST"); const s = await state(); assert.equal(s.counts.permissions, 0); assert.equal(s.counts.subscriptions, 0);
    assert.equal(s.requests[0].body.endpoint, "https://push.example.test/private-endpoint-A"); await act("f.reply(0,200,{success:true});f.unmount();"); assert.equal((await state()).listeners, 0);
  });
  await act("f.unmount();"); await settle();
  assert.deepEqual(exceptions, []); assert.deepEqual(forbidden, []);
  assert.ok(network.length >= 2); assert.ok(network.every(url => url.startsWith(origin + "/")), JSON.stringify(network));
  t.diagnostic(`Installed browser: ${path.basename(browser)}; real React effects/DOM; ${network.length} loopback resource requests; zero external page requests/exceptions`);
});

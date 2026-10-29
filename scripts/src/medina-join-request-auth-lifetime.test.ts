import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const frontend = path.join(root, "artifacts/negis");
const frontendRequire = createRequire(path.join(frontend, "package.json"));
const esbuild = createRequire(frontendRequire.resolve("vite/package.json"))("esbuild");
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const beforeReplayReset = process.argv.includes("--before-replay-reset");

// Actual JoinRequest, React/ReactDOM and validation helpers; controlled auth/API
// facades only. These tests make no SDK storage-authority or remote-auth claim.
const fixture = String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const session=actor=>actor?{user:{id:actor,email:actor.toLowerCase()+'@example.test'}}:null;
const props=node=>node?.[Object.keys(node).find(name=>name.startsWith('__reactProps$'))];
let Page,app,mounted=false,actor=null,replayGate=null,strict=false;
// Native Suspense hides/reveals layout effects without discarding component state.
function ReplayGate(){if(replayGate)throw replayGate.promise;return null;}
function RetainedStateWitness(){const[value,setValue]=React.useState('fresh-mount');f.witness=value;f.setWitness=setValue;return null;}
function tree(){const page=<React.Suspense fallback={<span>synthetic-layout-replay-hidden</span>}><ReplayGate/><RetainedStateWitness/><Page/></React.Suspense>;
 return strict?<React.StrictMode>{page}</React.StrictMode>:page;}
const f={calls:[],auth:[],lookups:[],subscriptions:[],captured:{},notices:[],navigations:[],order:[],unexpected:[],
 async mount(options={}){
  await f.cleanup();f.calls=[];f.auth=[];f.lookups=[];f.subscriptions=[];f.captured={};f.notices=[];
  f.navigations=[];f.order=[];f.unexpected=[];actor=options.actor===undefined?'A':options.actor;
  f.holdBootstrap=!!options.holdBootstrap;f.bootstrapError=!!options.bootstrapError;
  replayGate=null;strict=!!options.strict;
  app=createRoot(document.getElementById('root'));mounted=true;
  flushSync(()=>app.render(tree()));
 },
 unmount(){if(mounted){flushSync(()=>app.unmount());mounted=false;}},
 async cleanup(){f.unmount();
  for(const lookup of f.lookups)lookup.wait.resolve();
  for(const call of f.calls){if(!call.settled){call.settled=true;call.wait.reject(Error('Synthetic cleanup'));}if(call.stream){call.stream.close();call.stream=null;}}
  for(const call of f.auth)if(!call.settled){call.settled=true;call.wait.resolve({data:{user:null,session:null},error:{message:'Synthetic cleanup'}});}
  await new Promise(resolve=>setTimeout(resolve,0));
 },
 emit(value,event='SIGNED_IN'){flushSync(()=>{actor=value;for(const entry of f.subscriptions)if(entry.active)entry.callback(event,session(value));});},
 sequence(values){flushSync(()=>{for(const value of values){actor=value;for(const entry of f.subscriptions)if(entry.active)entry.callback('SIGNED_IN',session(value));}});},
 replay(index,value){flushSync(()=>f.subscriptions[index].callback('SIGNED_IN',session(value)));},
 replayReadyEffects(options={}){
  f.holdBootstrap=true;f.bootstrapError=!!options.bootstrapError;
  flushSync(()=>f.setWitness('retain-ready-state'));
  const gate=deferred();replayGate=gate;flushSync(()=>app.render(tree()));
  const hiddenActive=f.subscriptions.filter(entry=>entry.active).length;
  replayGate=null;gate.resolve();flushSync(()=>app.render(tree()));
  return{hiddenActive};
 },
 releaseBootstrap(){for(const lookup of f.lookups)lookup.wait.resolve();},
 button(label){const node=[...document.querySelectorAll('button')].find(node=>node.textContent.trim()===label);if(!node)throw Error('Missing button '+label);return node;},
 click(label){flushSync(()=>f.button(label).click());},
 double(label){const callback=props(f.button(label)).onClick;flushSync(()=>{callback();callback();});},
 fill(selector,value){const node=document.querySelector(selector);if(!node)throw Error('Missing input '+selector);flushSync(()=>props(node).onChange({target:{value}}));},
 captureButton(label,key){f.captured[key]=props(f.button(label)).onClick;},
 captureInput(selector,key){f.captured[key]=props(document.querySelector(selector)).onChange;},
 invoke(key,value='stale-private-value'){flushSync(()=>f.captured[key]({target:{value}}));},
 reply(index,body,status=200,holdBody=false){
  const call=f.calls[index];if(!call||call.settled)throw Error('Missing unsettled request '+index);call.settled=true;call.body=body;
  if(holdBody){const stream=new ReadableStream({start(controller){call.stream=controller;}});call.response=new Response(stream,{status,headers:{'content-type':'application/json'}});}
  else call.response=Response.json(body,{status});
  call.wait.resolve(call.response);
 },
 releaseBody(index){const call=f.calls[index];if(!call?.stream)throw Error('Missing held body '+index);
  call.stream.enqueue(new TextEncoder().encode(JSON.stringify(call.body)));call.stream.close();call.stream=null;},
 failBody(index){const call=f.calls[index];if(!call?.stream)throw Error('Missing held body '+index);call.stream.error(Error('Synthetic lost body'));call.stream=null;},
 lose(index){const call=f.calls[index];if(!call||call.settled)throw Error('Missing unsettled request');call.settled=true;call.wait.reject(Error('Synthetic lost response'));},
 resolveAuth(index,result){const call=f.auth[index];if(!call||call.settled)throw Error('Missing auth attempt');call.settled=true;call.wait.resolve(result);},
 rejectAuth(index){const call=f.auth[index];if(!call||call.settled)throw Error('Missing auth attempt');call.settled=true;call.wait.reject(Error('Synthetic network failure'));},
 snapshot(){return{
  text:document.getElementById('root').textContent,
  inputs:[...document.querySelectorAll('input')].map(node=>({id:node.id,type:node.type,value:node.value,disabled:node.disabled})),
  buttons:[...document.querySelectorAll('button')].map(node=>({label:node.textContent.trim(),disabled:node.disabled,pressed:node.getAttribute('aria-pressed')})),
  calls:f.calls.map(call=>({path:call.path,method:call.init.method||'GET',body:call.init.body?JSON.parse(call.init.body):null,
   expectedUserId:call.init.expectedUserId,guard:typeof call.init.dispatchGuard==='function',current:call.init.dispatchGuard?.(),
   signal:call.init.signal instanceof AbortSignal,aborted:!!call.init.signal?.aborted,settled:call.settled,bodyUsed:!!call.response?.bodyUsed})),
  auth:f.auth.map(call=>({method:call.method,credentials:call.credentials,current:call.scope?.isCurrent?.(),expectedUserId:call.scope?.expectedUserId,
   signal:call.scope?.signal instanceof AbortSignal,aborted:!!call.scope?.signal?.aborted,settled:call.settled})),
  lookups:f.lookups.length,witness:f.witness,subscriptions:f.subscriptions.map(entry=>({active:entry.active})),
  notices:f.notices,navigations:f.navigations,order:f.order,unexpected:f.unexpected,
 };},
};
export const supabase={auth:{getSession(){
 f.order.push('lookup');const wait=deferred(),captured=session(actor),failed=f.bootstrapError;
 f.lookups.push({wait});if(!f.holdBootstrap)wait.resolve();
 return wait.promise.then(()=>({data:{session:captured},error:failed?{message:'Synthetic lookup failure'}:null}));
}}};
export const sessionAuth={onAuthStateChange(callback){f.order.push('subscribe');const entry={callback,active:true};f.subscriptions.push(entry);
 return{data:{subscription:{unsubscribe(){entry.active=false;}}}};
},signInWithPassword(credentials,scope){return authCall('signin',credentials,scope);},signUp(credentials,scope){return authCall('signup',credentials,scope);}};
function authCall(method,credentials,scope){const wait=deferred();f.auth.push({method,credentials,scope,wait,settled:false});return wait.promise;}
export function crmFetch(request,init={}){
 if(request!=='/api/crm/join-request'||!['GET','POST'].includes(init.method||'GET')){f.unexpected.push(request);throw Error('Closed CRM route');}
 const wait=deferred();f.calls.push({path:request,init,wait,settled:false});return wait.promise;
}
export function useLocation(){return['/join-request',value=>f.navigations.push(value)];}
export const toast={error:message=>f.notices.push({kind:'error',message}),success:message=>f.notices.push({kind:'success',message})};
globalThis.fetch=()=>{throw Error('Real HTTP is forbidden in JoinRequest component tests');};
export function install(component){Page=component;window.__joinRequest=f;}
`;

async function browserFixture(t: TestContext) {
  t.after(() => esbuild.stop());
  const browser = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"].find(existsSync);
  assert.ok(browser, "Use an already installed local headless browser; never install one");
  const built = await esbuild.build({
    stdin: { contents: "import Page from './src/pages/JoinRequest';import {install} from 'join-request-fixture';install(Page);", resolveDir: frontend, loader: "tsx" },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "join-request-closed-imports", setup(build: any) {
      build.onResolve({ filter: /^(join-request-fixture|@\/lib\/(supabase|api)|wouter|sonner)$/ },
        () => ({ path: "controlled-facades", namespace: "join-request" }));
      build.onLoad({ filter: /.*/, namespace: "join-request" }, () => ({ contents: fixture, loader: "tsx", resolveDir: frontend }));
      build.onResolve({ filter: /^@\// }, (args: { path: string }) => { throw Error(`Unplanned application import: ${args.path}`); });
      if (beforeReplayReset) build.onLoad({ filter: /JoinRequest\.tsx$/ }, async (args: { path: string }) => {
        const source = await readFile(args.path, "utf8");
        const setupReset = [
          "    lifetime.current?.controller.abort();", "    lifetime.current = initial;",
          "    authAttempt.current = null; mutation.current = null;",
          "    readRevision.current++; formRevision.current++;",
          "    setHasSession(null); setRequests(null); setBusy(false); setSessionError(false);",
          '    setEmail(""); setPassword(""); setFullName(""); setPhone(""); setPositionNote(""); setCode("");',
        ].join("\n");
        const normalized = source.replace(/\r\n/g, "\n");
        assert.equal(normalized.split(setupReset).length, 2, "prior-setup control changes exactly the new layout reset block");
        return { contents: normalized.replace(setupReset, "    lifetime.current = initial;"), loader: "tsx", resolveDir: path.dirname(args.path) };
      });
    } }],
  });
  const server = createServer((request, response) => {
    if (request.headers.host !== `127.0.0.1:${(server.address() as any).port}` || request.method !== "GET"
      || !["/", "/bundle.js", "/favicon.ico"].includes(request.url ?? "")) { response.writeHead(403); response.end(); return; }
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; form-action 'none'");
    if (request.url === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    response.setHeader("Content-Type", request.url === "/bundle.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
    response.end(request.url === "/bundle.js" ? built.outputFiles[0].text
      : '<!doctype html><html><head></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const profile = await mkdtemp(path.join(tmpdir(), "medina-join-request-test-"));
  const child = spawn(browser, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions",
    "--edge-skip-compat-layer-relaunch",
    "--disable-sync", "--disable-component-update", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
  { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let diagnostics = "";
  child.stderr?.on("data", (chunk) => { diagnostics = (diagnostics + String(chunk)).slice(-4_000); });
  const exited = new Promise((resolve) => { child.once("exit", resolve); child.once("error", resolve); });
  let socket: WebSocket | undefined;
  let cdp: ((method: string, params?: Record<string, unknown>) => Promise<any>) | undefined;
  t.after(async () => {
    await cdp?.("Runtime.evaluate", { expression: "window.__joinRequest?.cleanup()", awaitPromise: true }).catch(() => {});
    await cdp?.("Browser.close").catch(() => {});
    await Promise.race([exited, delay(3_000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, delay(3_000)]); }
    socket?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const target = path.resolve(profile);
    assert.equal(path.dirname(target), path.resolve(tmpdir()), "recursive cleanup is confined to the owned temporary profile");
    assert.ok(path.basename(target).startsWith("medina-join-request-test-"));
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  let port = "";
  for (let pass = 0; pass < 250; pass++) {
    assert.equal(child.exitCode, null, diagnostics);
    try { port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0]; } catch {}
    if (/^\d+$/.test(port)) break;
    await delay(40);
  }
  assert.match(port, /^\d+$/);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json() as any[];
  const target = targets.find((value) => value.type === "page");
  assert.ok(target);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  let sequence = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const exceptions: unknown[] = [];
  const requests: string[] = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
    if (message.method === "Network.requestWillBeSent") requests.push(message.params.request.url);
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(Error(JSON.stringify(message.error))); else item.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error("Owned headless browser closed")); }
    pending.clear();
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Local browser connection timeout")), 10_000);
    socket!.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket!.addEventListener("error", () => { clearTimeout(timer); reject(Error("Local browser connection failed")); }, { once: true });
  });
  cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Local browser command timed out: ${method}`)); }, 10_000);
    pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression: string) => {
    const result = await cdp!("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await cdp("Runtime.enable"); await cdp("Network.enable"); await cdp("Page.navigate", { url: origin });
  for (let pass = 0; pass < 150; pass++) {
    if (await evaluate("!!window.__joinRequest")) break;
    await delay(20);
  }
  assert.equal(await evaluate("!!window.__joinRequest"), true, "actual JoinRequest component bundle loaded");
  const call = (method: string, ...args: unknown[]) => evaluate(`window.__joinRequest[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
  const snapshot = () => call("snapshot");
  const until = async (predicate: (state: any) => boolean, boundary: string) => {
    for (let pass = 0; pass < 100; pass++) {
      const state = await snapshot();
      if (predicate(state)) return state;
      await delay(10);
    }
    assert.fail(`${boundary}: ${JSON.stringify(await snapshot())}`);
  };
  return { call, snapshot, until,
    async flush() { await evaluate("new Promise(resolve=>setTimeout(resolve,0))"); return snapshot(); },
    async isolation() {
      assert.deepEqual(exceptions, [], "no uncaught React/browser errors");
      assert.ok(requests.every((url) => url.startsWith(origin + "/")), `only loopback fixture assets: ${requests}`);
      assert.deepEqual((await snapshot()).unexpected, []);
    },
  };
}

type Fixture = Awaited<ReturnType<typeof browserFixture>>;
const send = "Отправить заявку";
const sending = "Отправляем…";
const signin = "У меня есть вход";
const signup = "Я здесь впервые";
const row = (name: string, status = "rejected") => ({ id: `synthetic-${name}`, clinicName: name, status, createdAt: "2026-01-01T00:00:00Z", decidedAt: null });
const list = (name?: string, status?: string) => ({ success: true, data: { requests: name ? [row(name, status)] : [] } });
const authResult = (actor: string | null, error: string | null = null) => ({ data: { session: actor ? { user: { id: actor } } : null, user: actor ? { id: actor } : null }, error: error ? { message: error } : null });
const button = (state: any, label: string) => state.buttons.find((item: any) => item.label === label);
const input = (state: any, id: string) => state.inputs.find((item: any) => item.id === id);

function bound(call: any, actor: string) {
  assert.equal(call.expectedUserId, actor);
  assert.equal(call.guard, true, "actual component supplies dispatchGuard");
  assert.equal(call.signal, true, "actual component supplies AbortSignal");
  assert.equal(call.current, true);
  assert.equal(call.aborted, false);
}

async function ready(f: Fixture, actor: string | null = "A", rows = list()) {
  await f.call("mount", { actor });
  if (actor) {
    await f.until((state) => state.calls.length === 1, "actor-bound initial request list");
    await f.call("reply", 0, rows);
    return f.until((state) => !!button(state, send) || state.text.includes("Проверить статус"), "authenticated request view");
  }
  return f.until((state) => !!button(state, "Создать аккаунт"), "confirmed anonymous auth view");
}

async function fillRequest(f: Fixture, name = "Synthetic A") {
  await f.call("fill", "#join-code", "TEST-7K3N-Q82R");
  await f.call("fill", "#join-name", `  ${name}  `);
  await f.call("fill", "#join-phone", "  synthetic-contact  ");
  await f.call("fill", "#join-position", "  synthetic-position  ");
}

async function fillAuth(f: Fixture) {
  await f.call("fill", 'input[type="email"]', "  synthetic@example.test  ");
  await f.call("fill", 'input[type="password"]', "Synthetic-Pass9!");
}

test("JoinRequest: actual React component auth and original-actor request lifetimes", { timeout: 180_000 }, async (t) => {
  if (beforeReplayReset) t.diagnostic("Red control: only the prior layout setup is restored in memory; no runtime file is edited");
  const f = await browserFixture(t);
  await t.test("observer is installed before bootstrap and original GET is explicitly actor-bound", async () => {
    await f.call("mount", { actor: "A", holdBootstrap: true });
    let state = await f.snapshot();
    assert.deepEqual(state.order, ["subscribe", "lookup"]);
    assert.equal(state.calls.length, 0);
    await f.call("releaseBootstrap");
    state = await f.until((value) => value.calls.length === 1, "released A bootstrap");
    bound(state.calls[0], "A");
    await f.call("reply", 0, list("Synthetic original A"));
    await f.until((value) => value.text.includes("Synthetic original A"), "server-owned A list");
  });

  for (const aba of [false, true]) {
    await t.test(`bootstrap cannot overtake ${aba ? "A -> B -> A" : "A -> B"} observed account changes`, async () => {
      await f.call("mount", { actor: "A", holdBootstrap: true });
      await f.call("sequence", aba ? ["B", "A"] : ["B"]);
      const count = aba ? 2 : 1;
      await f.call("releaseBootstrap");
      let state = await f.flush();
      assert.equal(state.calls.length, count, "late bootstrap cannot trigger an old-actor read");
      bound(state.calls[count - 1], aba ? "A" : "B");
      await f.call("reply", count - 1, list("Synthetic newest actor"));
      if (aba) await f.call("reply", 0, list("Synthetic retired B"));
      state = await f.until((value) => value.text.includes("Synthetic newest actor"), "newest actor list");
      assert.equal(state.text.includes("Synthetic retired B"), false);
    });
  }

  await t.test("failed bootstrap stays neutral, not an authenticated or anonymous login claim", async () => {
    await f.call("mount", { actor: "A", bootstrapError: true });
    const state = await f.until((value) => value.text.includes("Не удалось проверить вход"), "honest failed session lookup");
    assert.equal(state.inputs.length, 0);
    assert.equal(state.calls.length, 0);
    assert.equal(state.auth.length, 0);
  });

  for (const boundary of ["B", "ABA", "unmount"] as const) {
    for (const stage of ["headers", "body", "body-error"] as const) {
      await t.test(`held GET ${stage} cannot publish after ${boundary}`, async () => {
        await f.call("mount", { actor: "A" });
        await f.until((state) => state.calls.length === 1, "A GET dispatched");
        if (stage !== "headers") {
          await f.call("reply", 0, list("Synthetic stale A"), 200, true);
          await f.until((state) => state.calls[0].bodyUsed, "native GET body consumption held");
        }
        if (boundary === "unmount") await f.call("unmount");
        else await f.call("sequence", boundary === "ABA" ? ["B", "A"] : ["B"]);
        let state = await f.snapshot();
        assert.equal(state.calls[0].aborted, true);
        assert.equal(state.calls[0].current, false);
        if (boundary !== "unmount") {
          await f.call("reply", state.calls.length - 1, list("Synthetic newest list"));
          await f.until((value) => value.text.includes("Synthetic newest list"), "current list before old GET returns");
        }
        if (stage === "headers") await f.call("reply", 0, list("Synthetic stale A"));
        else await f.call(stage === "body-error" ? "failBody" : "releaseBody", 0);
        state = await f.flush();
        assert.equal(state.text.includes("Synthetic stale A"), false);
        if (boundary !== "unmount") assert.ok(state.text.includes("Synthetic newest list"));
        assert.deepEqual(state.notices, []);
        assert.deepEqual(state.navigations, []);
      });
    }

    await t.test(`private inputs and captured POST/change callbacks are retired by ${boundary}`, async () => {
      await ready(f, "A", list("Synthetic private A"));
      await fillRequest(f);
      await f.call("captureButton", send, "old-submit");
      await f.call("captureInput", "#join-name", "old-name");
      if (boundary === "unmount") await f.call("unmount");
      else await f.call("sequence", boundary === "ABA" ? ["B", "A"] : ["B"]);
      if (boundary !== "unmount") {
        let state = await f.snapshot();
        assert.equal(state.text.includes("Synthetic private A"), false);
        await f.call("reply", state.calls.length - 1, list());
        await f.until((value) => !!button(value, send), "new actor form");
        state = await f.snapshot();
        assert.ok(state.inputs.every((value: any) => value.value === ""), "all private fields are cleared on account lifetime change");
        await f.call("fill", "#join-name", "Synthetic new private name");
      }
      const before = await f.snapshot();
      await f.call("invoke", "old-name"); await f.call("invoke", "old-submit");
      const state = await f.flush();
      assert.equal(state.calls.length, before.calls.length);
      assert.deepEqual(state.inputs, before.inputs);
      assert.deepEqual(state.notices, []);
    });
  }

  await t.test("one same-turn original-actor POST, unchanged request body and confirmed reread", async () => {
    await ready(f); await fillRequest(f);
    await f.call("double", send);
    let state = await f.until((value) => value.calls.length === 2, "one POST after original GET");
    assert.equal(state.calls.filter((value: any) => value.method === "POST").length, 1);
    bound(state.calls[1], "A");
    assert.deepEqual(state.calls[1].body, { code: "TEST7K3NQ82R", fullName: "Synthetic A", phone: "synthetic-contact", positionNote: "synthetic-position" });
    assert.ok(state.inputs.every((value: any) => value.disabled));
    await f.call("reply", 1, { success: true, data: { request: row("Synthetic confirmed", "pending") } });
    state = await f.until((value) => value.calls.length === 3, "confirmed POST triggers original actor reread");
    bound(state.calls[2], "A");
    await f.call("reply", 2, list("Synthetic confirmed", "pending"));
    state = await f.until((value) => value.text.includes("Synthetic confirmed"), "server-confirmed pending state");
    assert.equal(state.notices.length, 1);
    assert.equal(state.notices[0].kind, "success");
  });

  await t.test("settled POST callback cannot resubmit after the pending form has disappeared", async () => {
    await ready(f); await fillRequest(f);
    await f.call("captureButton", send, "settled-post");
    await f.call("click", send);
    await f.call("reply", 1, { success: true, data: { request: row("Synthetic pending receipt", "pending") } });
    await f.until((state) => state.calls.length === 3, "confirmed submission reread");
    await f.call("reply", 2, list("Synthetic pending receipt", "pending"));
    await f.until((state) => !!button(state, "Проверить статус"), "pending state hides the submission form");
    await f.call("invoke", "settled-post");
    const state = await f.flush();
    assert.equal(state.calls.filter((call: any) => call.method === "POST").length, 1,
      "settled callback must not resubmit a hidden form with its captured private payload");
  });

  await t.test("settled rejected POST callback retires while a new rendered retry remains usable", async () => {
    await ready(f); await fillRequest(f);
    await f.call("captureButton", send, "rejected-post"); await f.call("click", send);
    await f.call("reply", 1, { success: false, code: "join_code_unknown" }, 400);
    await f.until((state) => !!button(state, send) && !button(state, send).disabled, "current rejected POST settles");
    await f.call("invoke", "rejected-post");
    let state = await f.flush();
    assert.equal(state.calls.filter((call: any) => call.method === "POST").length, 1, "rejected callback cannot reuse old payload");
    assert.ok(state.notices[0].message.includes("Такого кода нет"));
    await f.call("click", send);
    state = await f.until((value) => value.calls.filter((call: any) => call.method === "POST").length === 2, "new rendered retry works");
    bound(state.calls[state.calls.length - 1], "A");
  });

  for (const boundary of ["B", "ABA", "unmount"] as const) {
    for (const completion of ["success", "body-error", "transport-error"] as const) {
      await t.test(`old POST ${completion}/finally cannot touch the new lifetime after ${boundary}`, async () => {
        await ready(f); await fillRequest(f); await f.call("click", send);
        await f.until((state) => state.calls.length === 2, "old A POST");
        if (completion !== "transport-error") {
          await f.call("reply", 1, { success: true, data: { request: row("Synthetic stale receipt") } }, 200, true);
          await f.until((state) => state.calls[1].bodyUsed, "held POST body");
        }
        if (boundary === "unmount") await f.call("unmount");
        else {
          await f.call("sequence", boundary === "ABA" ? ["B", "A"] : ["B"]);
          const state = await f.snapshot();
          await f.call("reply", state.calls.length - 1, list());
          await f.until((value) => !!button(value, send), "new actor request form");
          await fillRequest(f, "Synthetic newer name"); await f.call("click", send);
        }
        const before = await f.snapshot();
        if (completion === "transport-error") await f.call("lose", 1);
        else await f.call(completion === "body-error" ? "failBody" : "releaseBody", 1);
        const state = await f.flush();
        assert.equal(state.calls.length, before.calls.length, "no stale refresh or POST");
        assert.deepEqual(state.notices, [], "no stale success or error");
        assert.deepEqual(state.navigations, []);
        assert.equal(state.calls[1].aborted, true);
        assert.equal(state.calls[1].current, false);
        if (boundary !== "unmount") {
          assert.equal(button(state, sending)?.disabled, true, "old finally cannot release the newer POST lock");
          assert.equal(input(state, "join-name").value.trim(), "Synthetic newer name");
          bound(state.calls[state.calls.length - 1], boundary === "ABA" ? "A" : "B");
        }
      });
    }
  }

  await t.test("same-actor status rereads supersede older held bodies", async () => {
    await ready(f, "A", list("Synthetic pending", "pending"));
    await f.call("double", "Проверить статус");
    let state = await f.snapshot();
    const newest = state.calls.length - 1;
    assert.ok(newest >= 1);
    bound(state.calls[newest], "A");
    for (let index = 1; index < newest; index++) assert.equal(state.calls[index].current, false);
    await f.call("reply", newest, list("Synthetic newest read", "pending"));
    await f.until((value) => value.text.includes("Synthetic newest read"), "latest read wins");
    for (let index = 1; index < newest; index++) await f.call("reply", index, list("Synthetic retired read", "pending"));
    state = await f.flush();
    assert.equal(state.text.includes("Synthetic retired read"), false);
    assert.ok(state.text.includes("Synthetic newest read"));
  });

  await t.test("auth mode ABA retires captured credential/input callbacks", async () => {
    await ready(f, null); await fillAuth(f);
    await f.call("captureButton", "Создать аккаунт", "signup-before-mode");
    await f.call("captureInput", 'input[type="email"]', "email-before-mode");
    await f.call("click", signin); await f.call("click", signup);
    await f.call("invoke", "signup-before-mode"); await f.call("invoke", "email-before-mode");
    const state = await f.flush();
    assert.equal(state.auth.length, 0);
    assert.equal(state.inputs.find((value: any) => value.type === "password").value, "");
    assert.notEqual(state.inputs.find((value: any) => value.type === "email").value, "stale-private-value");
    assert.deepEqual(state.notices, []);
  });

  await t.test("anonymous auth has expectedUserId:null, synchronous duplicate lock and busy-disabled modes", async () => {
    await ready(f, null); await f.call("click", signin); await fillAuth(f);
    await f.call("captureButton", signup, "busy-mode");
    await f.call("double", "Войти");
    let state = await f.snapshot();
    assert.equal(state.auth.length, 1);
    assert.equal(state.auth[0].expectedUserId, null);
    assert.equal(state.auth[0].current, true);
    assert.equal(state.auth[0].signal, true);
    assert.equal(state.auth[0].credentials.email, "synthetic@example.test");
    assert.equal(state.auth[0].credentials.password, "Synthetic-Pass9!");
    assert.ok(state.inputs.every((value: any) => value.disabled));
    assert.equal(button(state, signup).disabled, true);
    assert.equal(button(state, signin).disabled, true);
    await f.call("invoke", "busy-mode");
    state = await f.snapshot();
    assert.equal(button(state, signin).pressed, "true");
    await f.call("resolveAuth", 0, authResult(null, "Invalid login credentials"));
    state = await f.until((value) => !!button(value, "Войти") && !button(value, "Войти").disabled, "current failed auth releases its own lock");
    assert.ok(state.notices[0].message.includes("неверные"));
    assert.equal(state.calls.length, 0);
  });

  await t.test("settled failed auth callback cannot replay captured password", async () => {
    await ready(f, null); await f.call("click", signin); await fillAuth(f);
    await f.call("captureButton", "Войти", "settled-auth");
    await f.call("click", "Войти");
    await f.call("resolveAuth", 0, authResult(null, "Invalid login credentials"));
    await f.until((state) => !!button(state, "Войти") && !button(state, "Войти").disabled, "failed auth settled");
    await f.call("invoke", "settled-auth");
    const state = await f.flush();
    assert.equal(state.auth.length, 1, "settled callback must not reuse its captured credentials for a new intent");
  });

  await t.test("signup without session reports confirmation without inventing a session or reading private data", async () => {
    await ready(f, null); await fillAuth(f); await f.call("click", "Создать аккаунт");
    await f.call("resolveAuth", 0, { data: { session: null, user: { id: "A" } }, error: null });
    const state = await f.until((value) => value.notices.some((notice: any) => notice.message.includes("Аккаунт создан")), "confirmation-only signup message");
    assert.equal(state.calls.length, 0);
    assert.equal(state.lookups, 1, "no unguarded post-signup getSession bootstrap");
    assert.ok(button(state, "Создать аккаунт"));
  });

  await t.test("settled confirmation-only signup callback cannot replay captured credentials", async () => {
    await ready(f, null); await fillAuth(f);
    await f.call("captureButton", "Создать аккаунт", "confirmation-signup");
    await f.call("click", "Создать аккаунт");
    await f.call("resolveAuth", 0, { data: { session: null, user: { id: "A" } }, error: null });
    await f.until((state) => !!button(state, "Создать аккаунт") && !button(state, "Создать аккаунт").disabled, "confirmation-only signup settles");
    await f.call("invoke", "confirmation-signup");
    const state = await f.flush();
    assert.equal(state.auth.length, 1, "settled confirmation callback cannot create another auth intent");
    assert.equal(state.calls.length, 0);
  });

  for (const completion of ["success", "error", "reject"] as const) {
    for (const boundary of ["B", "ABA", "unmount"] as const) {
      await t.test(`late auth ${completion}/finally is ignored after ${boundary}`, async () => {
        await ready(f, null); await fillAuth(f); await f.call("click", "Создать аккаунт");
        if (boundary === "unmount") await f.call("unmount");
        else {
          await f.call("sequence", boundary === "ABA" ? ["A", "B", "A"] : ["B"]);
          const state = await f.snapshot();
          await f.call("reply", state.calls.length - 1, list());
          await f.until((value) => !!button(value, send), "observed newer authenticated actor");
          await fillRequest(f, "Synthetic newer name"); await f.call("click", send);
        }
        const before = await f.snapshot();
        if (completion === "reject") await f.call("rejectAuth", 0);
        else await f.call("resolveAuth", 0, authResult(completion === "success" ? "A" : null, completion === "error" ? "Invalid login credentials" : null));
        const state = await f.flush();
        assert.equal(state.calls.length, before.calls.length);
        assert.equal(state.auth[0].current, false);
        assert.equal(state.auth[0].aborted, true);
        assert.deepEqual(state.notices, []);
        if (boundary !== "unmount") assert.equal(button(state, sending)?.disabled, true, "late auth finally cannot reset a newer mutation");
      });
    }
  }

  await t.test("StrictMode cleanup unsubscribes and captured observer delivery cannot revive an unmounted component", async () => {
    await f.call("mount", { actor: null, strict: true, holdBootstrap: true });
    await f.call("releaseBootstrap");
    await f.until((state) => !!button(state, "Создать аккаунт"), "StrictMode replayed anonymous bootstrap");
    let state = await f.snapshot();
    assert.equal(state.subscriptions.filter((value: any) => value.active).length, 1);
    await f.call("unmount"); await f.call("replay", state.subscriptions.length - 1, "A");
    state = await f.flush();
    assert.ok(state.subscriptions.every((value: any) => !value.active));
    assert.equal(state.calls.length, 0);
    assert.equal(state.text, "");
    assert.deepEqual(state.notices, []);
  });

  for (const failedBootstrap of [false, true]) {
    await t.test(`ready state is quarantined across retained-state layout replay with ${failedBootstrap ? "failed" : "held"} replacement bootstrap`, async () => {
      await ready(f, "A", list("Synthetic ready private list"));
      await fillRequest(f, "Synthetic ready private name");
      await f.call("click", send);
      await f.call("reply", 1, { success: true, data: { request: row("Synthetic retired replay receipt") } }, 200, true);
      await f.until((state) => state.calls[1].bodyUsed, "old mutation is busy with a held body");
      const before = await f.snapshot();
      assert.equal(button(before, sending)?.disabled, true);
      assert.ok(before.text.includes("Synthetic ready private list"));
      const replay = await f.call("replayReadyEffects", { bootstrapError: failedBootstrap });
      assert.equal(replay.hiddenActive, 0, "real Suspense hide runs the previous layout cleanup");
      let state = await f.until((value) => value.lookups > before.lookups, "revealed native layout effect starts a new bootstrap");
      assert.equal(state.witness, "retain-ready-state", "this is state-retaining effect replay, not root unmount/remount");
      assert.equal(state.subscriptions.filter((entry: any) => entry.active).length, 1);
      assert.equal(state.calls[1].aborted, true);
      assert.equal(state.calls[1].current, false);
      if (failedBootstrap) {
        await f.call("releaseBootstrap");
        state = await f.flush();
      }
      assert.equal(state.text.includes("Synthetic ready private list"), false, "old private list must not remain visible during replacement bootstrap");
      assert.equal(state.inputs.length, 0, "old private form must not remain visible during replacement bootstrap");
      assert.equal(button(state, sending), undefined, "old busy controls are quarantined too");
      if (failedBootstrap) {
        assert.ok(state.text.includes("Не удалось проверить вход"), "failed replacement bootstrap stays neutral");
        assert.equal(state.inputs.length, 0);
        assert.equal(state.text.includes("Synthetic ready private list"), false);
      }
      await f.call("releaseBody", 1);
      state = await f.flush();
      assert.equal(state.calls.length, before.calls.length, "old mutation cannot trigger a replay-era read");
      assert.deepEqual(state.notices, []);
      assert.deepEqual(state.navigations, []);
    });
  }
  await f.isolation();
});

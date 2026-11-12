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

// Real React DOM + AuthProvider + crmFetch + serverAuth, fake SDK and loopback
// HTTP only. The disposable browser never opens the application or a user profile.
// node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-doctor-schedule-lifetime.test.ts
// Add --baseline without --test to prove failures against HEAD's component.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const frontend = path.join(root, "artifacts/negis");
const require = createRequire(path.join(frontend, "package.json"));
const esbuild = createRequire(require.resolve("vite/package.json"))("esbuild");
const component = "artifacts/negis/src/components/admin/DoctorSchedule.tsx";
const baseline = process.argv.includes("--baseline");
const WA = "00000000-0000-4000-8000-000000000001";
const WB = "00000000-0000-4000-8000-000000000002";
const DA = "00000000-0000-4000-8000-000000000011";
const DB = "00000000-0000-4000-8000-000000000012";
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const entry = `
import React,{StrictMode} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {AuthProvider,useAuth} from './src/contexts/AuthContext';
import {DoctorSchedule} from './src/components/admin/DoctorSchedule';
import {clearCrmCache} from './src/lib/api';import {clearSignOutPending,markSignOutPending} from './src/lib/authSignOut';
const wa='${WA}',wb='${WB}';let app,mounted=false,auth,sdkSession,heldToken=null;
const listeners=new Set(),memory=new Map();
const f=window.__scheduleFixture={notices:[],captured:[],tokenReads:0,bodyReads:[],forbidden:[],stateWrites:0,
 session(actor='A',version=1){return{access_token:'fixture-'+actor+'-'+version,user:{id:'actor-'+actor,email:actor+'@example.test',user_metadata:{full_name:'Fixture '+actor}}};},
 sdk:{onAuthStateChange(fn){listeners.add(fn);return{data:{subscription:{unsubscribe(){listeners.delete(fn);}}}};},
  async getSession(){f.tokenReads++;const gate=heldToken;heldToken=null;if(gate)await gate;return{data:{session:sdkSession},error:null};},
  async signOut(){f.emit(null);return{error:null};}},
 emit(actor='A',event='SIGNED_IN',version=1){sdkSession=actor?f.session(actor,version):null;for(const fn of [...listeners])fn(event,sdkSession);},
 silent(actor){sdkSession=f.session(actor);},
 holdToken(){heldToken=new Promise(resolve=>f.releaseToken=()=>{heldToken=null;resolve();});},
 mount(){f.notices=[];f.captured=[];f.bodyReads=[];f.stateWrites=0;memory.clear();memory.set('negis_workspace_selector',wa);
  clearSignOutPending();clearCrmCache();sdkSession=f.session();app=createRoot(document.getElementById('root'));mounted=true;
  flushSync(()=>app.render(<StrictMode><AuthProvider><Probe/></AuthProvider></StrictMode>));},
 unmount(){if(mounted){flushSync(()=>app.unmount());mounted=false;}},
 workspace(id){flushSync(()=>auth.selectWorkspace(id));},
 signoutFence(){markSignOutPending();},
 select(name){const b=[...document.querySelectorAll('section:first-child button')].find(b=>b.firstElementChild?.textContent===name);if(!b)throw Error('Missing doctor '+name);flushSync(()=>b.click());},
 props(node){if(!node)throw Error('Missing fixture control');return node[Object.keys(node).find(k=>k.startsWith('__reactProps$'))];},
 buttons(){return [...document.querySelectorAll('button')];},
 button(text,index=0){return f.buttons().filter(b=>b.textContent===text)[index];},
 click(text,index=0){const b=f.button(text,index);if(!b)throw Error('Missing button '+text);flushSync(()=>b.click());},
 edit(name){const b=[...document.querySelectorAll('section:first-child button')].find(b=>b.firstElementChild?.textContent===name);
  flushSync(()=>b.lastElementChild.click());},
 field(selector,value,index=0,event='onChange'){const node=document.querySelectorAll(selector)[index];
  flushSync(()=>f.props(node)[event]({target:{value,checked:value},stopPropagation(){}}));},
 capture(selector,event='onClick',index=0,value='2030-01-01'){const node=document.querySelectorAll(selector)[index],handler=f.props(node)[event];
  if(!handler)throw Error('Missing handler '+event);f.captured.push(()=>handler({target:{value,checked:true},stopPropagation(){}}));},
 captureButton(text,index=0){const handler=f.props(f.button(text,index)).onClick;f.captured.push(()=>handler());},
 invoke(){flushSync(()=>{for(const fn of f.captured)fn();});},
 snapshot(){const selected=[...document.querySelectorAll('section:first-child button')].find(b=>b.className.includes('bg-[#ECFDF5]'));
  return{text:document.getElementById('root').textContent,selected:selected?.firstElementChild.textContent||'',
   notices:[...f.notices],stateWrites:f.stateWrites,tokenReads:f.tokenReads,listeners:listeners.size,bodyReads:[...f.bodyReads],
   dates:[...document.querySelectorAll('input[type=date]')].map(n=>n.value),times:[...document.querySelectorAll('input[type=time]')].map(n=>n.value),
   actor:auth?.user?.id,role:auth?.userRole,workspace:auth?.clinicId,forbidden:[...f.forbidden]};}
};
function Probe(){auth=useAuth();return <DoctorSchedule/>;}
for(const name of ['getItem','setItem','removeItem','clear'])Storage.prototype[name]=function(key,value){
 if(name==='clear')throw Error('Fixture forbids storage clear');
 if(!/^(negis_|sb-)/.test(key))throw Error('Fixture forbids unrelated storage');
 if(name==='getItem')return memory.get(key)??null;if(name==='setItem')memory.set(key,String(value));else memory.delete(key);
};
const nativeFetch=window.fetch.bind(window);window.fetch=(url,init)=>{const parsed=new URL(url,location.origin);
 if(parsed.origin!==location.origin||!/^\\/api\\/crm\\/(auth-context|clinic-doctors|doctor-schedule|admin-settings)$/.test(parsed.pathname)){
  f.forbidden.push(String(url));throw Error('Fixture forbids external/unrelated HTTP');}return nativeFetch(parsed,init);};
const nativeText=Response.prototype.text;Response.prototype.text=function(){f.bodyReads.push(this.url+'#'+(this.headers.get('x-fixture-hold')||''));return nativeText.call(this);};
f.mount();
`;

type Call = { id: number; path: string; method: string; workspace: string; token: string; body: Record<string, any>; closed: boolean };
type Hold = { path: string; method: string; stage: "headers" | "body"; status?: number; release?: (fail?: boolean) => void; call?: Call };
type Snapshot = { text: string; selected: string; notices: string[]; stateWrites: number; tokenReads: number; listeners: number;
  bodyReads: string[]; dates: string[]; times: string[]; actor: string; role: string; workspace: string; forbidden: string[] };

test("owned React/HTTP/Auth: DoctorSchedule operation ownership", { timeout: 180_000 }, async t => {
  t.after(() => esbuild.stop());
  const browserPath = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(existsSync);
  assert.ok(browserPath, "Installed Chromium required; never install or use a user browser");
  const reactPath = JSON.stringify(require.resolve("react"));
  const code = await esbuild.build({ stdin: { contents: entry, sourcefile: "doctor-schedule-owned.tsx", resolveDir: frontend, loader: "tsx" },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    alias: { "@": path.join(frontend, "src") },
    define: { "process.env.NODE_ENV": '"development"', "import.meta.env": "{}" },
    plugins: [{ name: "isolated-sdk-and-state-observer", setup(build: any) {
      build.onResolve({ filter: /^react$/ }, (args: any) => args.importer.endsWith("DoctorSchedule.tsx") ? { path: "observed-react", namespace: "fixture" } : undefined);
      build.onLoad({ filter: /^observed-react$/, namespace: "fixture" }, () => ({ contents:
        `import * as R from ${reactPath};export * from ${reactPath};export function useState(initial){const [v,set]=R.useState(initial);
        return [v,(next)=>{window.__scheduleFixture.stateWrites++;set(next);}];}`, resolveDir: frontend }));
      build.onLoad({ filter: /[\\/]lib[\\/]supabase\.ts$/ }, () => ({ contents:
        "export const hasSupabaseFrontendEnv=true;export const supabase={auth:new Proxy({},{get:(_,key)=>(...args)=>window.__scheduleFixture.sdk[key](...args)})};export const sessionAuth={onAuthStateChange:supabase.auth.onAuthStateChange};" }));
      build.onResolve({ filter: /^(sonner|wouter)$/ }, (args: any) => ({ path: args.path, namespace: "fixture" }));
      build.onLoad({ filter: /^(sonner|wouter)$/, namespace: "fixture" }, (args: any) => ({ contents: args.path === "sonner"
        ? "export const toast={success:m=>window.__scheduleFixture.notices.push('success:'+m),error:m=>window.__scheduleFixture.notices.push('error:'+m)};"
        : "const navigate=()=>{};export const useLocation=()=>['/admin',navigate];" }));
      if (baseline) build.onLoad({ filter: /[\\/]DoctorSchedule\.tsx$/ }, () => ({
        contents: execFileSync("git", ["show", `HEAD:${component}`], { cwd: root, encoding: "utf8" }), loader: "tsx" }));
    } }],
  });
  let role = "owner", calls: Call[] = [], holds: Hold[] = [], serial = 0;
  const tables = new Map<string, { doctors: any[]; shifts: any[]; timeZone: string }>();
  function table(workspace: string) {
    let data = tables.get(workspace);
    if (!data) {
      data = { doctors: [DA, DB].map((id, index) => ({ id, fullName: `Doctor ${index ? "B" : "A"}`, capacity: index ? 3 : 1, sortOrder: index, isActive: true })),
        shifts: [
          { id: "a-mon-1", doctorId: DA, weekday: 1, isWorking: true, startMinute: 540, endMinute: 1080 },
          { id: "a-mon-2", doctorId: DA, weekday: 1, isWorking: true, startMinute: 600, endMinute: 1140 },
          { id: "a-window", doctorId: DA, weekday: 1, isWorking: false, startMinute: 780, endMinute: 840 },
          { id: "b-mon", doctorId: DB, weekday: 1, isWorking: true, startMinute: 660, endMinute: 1200 },
          { id: "a-exception", doctorId: DA, weekday: null, onDate: "2030-01-10", onDateEnd: "2030-01-10", isWorking: false },
          { id: "b-exception", doctorId: DB, weekday: null, onDate: "2030-02-10", onDateEnd: "2030-02-10", isWorking: false },
        ], timeZone: "Asia/Almaty" };
      tables.set(workspace, data);
    }
    return data;
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://fixture.invalid");
    if (req.headers.host !== `127.0.0.1:${(server.address() as any).port}`) { res.writeHead(403); res.end(); return; }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'none'; form-action 'none'");
    if (req.method === "GET" && ["/", "/bundle.js", "/favicon.ico"].includes(url.pathname)) {
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      res.setHeader("Content-Type", url.pathname === "/bundle.js" ? "application/javascript" : "text/html; charset=utf-8");
      res.end(url.pathname === "/bundle.js" ? code.outputFiles[0].text : '<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); return;
    }
    if (!/^\/api\/crm\/(auth-context|clinic-doctors|doctor-schedule|admin-settings)$/.test(url.pathname)) { res.writeHead(403); res.end(); return; }
    const token = String(req.headers.authorization || "");
    if (!/^Bearer fixture-[AB]-\d+$/.test(token)) { res.writeHead(401); res.end(); return; }
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const call: Call = { id: ++serial, path: url.pathname, method: req.method || "GET", workspace: body.workspaceId || url.searchParams.get("workspaceId") || "", token, body, closed: false };
    calls.push(call); res.on("close", () => { call.closed = true; });
    let payload: any;
    if (url.pathname.endsWith("auth-context")) {
      assert.equal(call.method, "GET", "No real role/settings actions in this fixture");
      payload = { success: true, data: { memberships: [WA, WB].map((workspaceId, index) => ({ staffUserId: `fixture-staff-${index}`,
        workspaceId, workspaceName: "Fixture", role, permissions: [], vertical: "clinic", purpose: "clinic_services" })) } };
    } else {
      assert.ok([WA, WB].includes(call.workspace));
      const data = table(call.workspace);
      if (call.method === "GET") payload = { success: true, data: url.pathname.endsWith("clinic-doctors")
        ? { directoryAvailable: true, doctors: data.doctors } : { shifts: data.shifts, timeZone: data.timeZone } };
      else {
        // Accepted mutations change synthetic arrays only. Aborting the client
        // must not remove this evidence or pretend the server rolled back.
        if (url.pathname.endsWith("doctor-schedule")) {
          if (call.method === "PATCH") Object.assign(data.shifts.find(row => row.id === body.id)!, body);
          else data.shifts.push({ id: `fixture-shift-${call.id}`, weekday: null, ...body });
        } else if (url.pathname.endsWith("clinic-doctors")) Object.assign(data.doctors.find(row => row.id === body.id)!, body);
        else data.timeZone = body.value.timeZone;
        payload = { success: true, data: {} };
      }
    }
    const held = holds.find(hold => !hold.call && call.path.endsWith(hold.path) && hold.method === call.method);
    const output = JSON.stringify(payload);
    res.setHeader("Content-Type", "application/json");
    if (held) {
      held.call = call;
      res.setHeader("X-Fixture-Hold", String(call.id));
      if (held.stage === "body") { res.writeHead(held.status || 200); res.flushHeaders(); }
      let released = false;
      held.release = (fail = false) => {
        if (released) return;
        released = true;
        if (fail) { res.destroy(); return; }
        if (held.stage === "headers") res.writeHead(held.status || 200);
        res.end(output);
      };
    } else { res.writeHead(200); res.end(output); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const profile = await mkdtemp(path.join(tmpdir(), "medina-doctor-schedule-owned-"));
  const child = spawn(browserPath, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--disable-sync",
    "--disable-component-update", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
  { windowsHide: true, stdio: "ignore", env: process.platform === "win32" ? { SystemRoot: "C:\\Windows", TEMP: tmpdir(), TMP: tmpdir() } : { HOME: profile, TMPDIR: tmpdir() } });
  const exited = new Promise(resolve => { child.once("exit", resolve); child.once("error", resolve); });
  let socket: WebSocket | undefined, cdp: ((method: string, params?: Record<string, unknown>) => Promise<any>) | undefined;
  t.after(async () => {
    await cdp?.("Browser.close").catch(() => {}); await Promise.race([exited, delay(3000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, delay(3000)]); }
    socket?.close();
    assert.equal(path.dirname(profile), path.resolve(tmpdir())); assert.ok(path.basename(profile).startsWith("medina-doctor-schedule-owned-"));
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
  assert.ok(Array.isArray(targets), "Owned browser targets must be an array");
  const page = targets.find((value: any) => value.type === "page"); assert.ok(page);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const requests: string[] = [], exceptions: unknown[] = [], consoleErrors: unknown[] = []; let sequence = 0;
  socket.addEventListener("message", event => {
    const data = JSON.parse(String(event.data));
    if (data.method === "Network.requestWillBeSent") requests.push(data.params.request.url);
    if (data.method === "Runtime.exceptionThrown") exceptions.push(data.params.exceptionDetails);
    if (data.method === "Runtime.consoleAPICalled" && data.params.type === "error") consoleErrors.push(data.params.args);
    const item = pending.get(data.id); if (!item) return;
    clearTimeout(item.timer); pending.delete(data.id);
    if (data.error) item.reject(Error(JSON.stringify(data.error))); else item.resolve(data.result);
  });
  socket.addEventListener("close", () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error("Owned browser closed")); } pending.clear(); });
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(Error("Owned browser connect timeout")), 10_000);
    socket!.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket!.addEventListener("error", () => { clearTimeout(timer); reject(Error("Owned browser failed")); }, { once: true }); });
  cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(`Owned CDP timeout: ${method}`)); }, 15_000);
    pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (body: string): Promise<any> => {
    const result = await cdp!("Runtime.evaluate", { expression: `(async()=>{const f=window.__scheduleFixture;${body}})()`, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  await cdp("Network.enable"); await cdp("Runtime.enable"); await cdp("Page.navigate", { url: origin });
  const state = (): Promise<Snapshot> => evaluate("return f.snapshot();");
  async function until(check: () => Promise<boolean> | boolean, label: string) {
    for (let i = 0; i < 150; i++) { if (await check()) return; await delay(20); }
    assert.fail(`${label}: ${JSON.stringify(await state())}; exceptions: ${JSON.stringify(exceptions)}`);
  }
  await until(() => evaluate("return !!f;"), "Fixture boot");
  const settle = () => evaluate("for(let i=0;i<8;i++)await new Promise(resolve=>setTimeout(resolve,0));");
  const writes = () => calls.filter(call => call.method !== "GET");
  const reads = () => calls.filter(call => call.method === "GET" && !call.path.endsWith("auth-context"));
  const hold = (path: string, method: string, stage: Hold["stage"] = "body", status = 200) => {
    const held: Hold = { path, method, stage, status }; holds.push(held); return held;
  };
  const waiting = async (held: Hold) => { await until(() => !!held.release, "Held HTTP entered");
    if (held.stage === "body") await until(async () => (await state()).bodyReads.some(url => url.endsWith(`#${held.call!.id}`)), "Response.text entered for held request"); };
  const ready = async (selected = "Doctor A") => until(async () => (await state()).selected === selected, `Selected ${selected}`);
  const reset = async () => {
    await evaluate("f.releaseToken?.();f.unmount();"); for (const held of holds) held.release?.(); await settle();
    calls = []; holds = []; tables.clear(); role = "owner";
    await evaluate("f.mount();"); await ready(); await settle();
  };
  const pick = async (name: string) => { await evaluate(`f.select(${JSON.stringify(name)});`); await ready(name); };
  const save = async () => { await evaluate("f.click('\\u0417\\u0430\\u0434\\u0430\\u0442\\u044c 09:00\\u201318:00');"); await settle(); };
  const captureSave = () => evaluate("f.captureButton('\\u0417\\u0430\\u0434\\u0430\\u0442\\u044c 09:00\\u201318:00');");
  const noLatePublication = async (before: Snapshot, count: number) => {
    await settle(); const after = await state(); assert.equal(after.selected, before.selected); assert.deepEqual(after.notices, before.notices);
    assert.equal(after.stateWrites, before.stateWrites, "No stale setters, including finally or draft handlers"); assert.equal(calls.length, count, "No stale refresh or second dispatch");
  };

  await t.test("current selected B saves, refreshes and preserves capacity and original actor/workspace", async () => {
    await reset(); await pick("Doctor B"); const count = reads().length; await save();
    await until(() => reads().length === count + 2, "Current refresh"); await ready("Doctor B");
    assert.deepEqual(writes()[0].body, { doctorId: DB, weekday: 2, isWorking: true, startMinute: 540, endMinute: 1080, workspaceId: WA });
    assert.equal(writes()[0].token, "Bearer fixture-A-1"); assert.match((await state()).text, /3/);
    assert.equal((await state()).notices.length, 1); assert.ok((await state()).times.includes("09:00"));
    await evaluate("f.edit('Doctor B');f.field('input[inputmode=numeric]','4');f.click('\\u0421\\u043e\\u0445\\u0440\\u0430\\u043d\\u0438\\u0442\\u044c');");
    await until(() => writes().length === 2 && reads().length === count + 4, "Doctor directory refresh");
    assert.equal(writes()[1].body.id, DB); assert.equal(writes()[1].body.capacity, 4); await ready("Doctor B");
  });

  await t.test("workspace-wide pending load keeps exact newly selected doctor B, including A/B/A", async () => {
    await reset(); const held = hold("doctor-schedule", "GET"); await save(); await waiting(held);
    await pick("Doctor B"); await pick("Doctor A"); await pick("Doctor B");
    held.release!(); await settle(); assert.equal((await state()).selected, "Doctor B");
    assert.equal(writes()[0].body.doctorId, DA); assert.equal(writes()[0].workspace, WA);
  });

  await t.test("retained doctor A handlers and drafts never revive after same-workspace A/B/A", async () => {
    await reset(); await captureSave(); await evaluate("f.capture('input[type=time]','onBlur',0,'22:00');f.capture('input[type=date]','onChange',2,'2030-03-01');");
    await pick("Doctor B"); await pick("Doctor A"); const before = await state(), count = calls.length;
    await evaluate("f.invoke();"); await noLatePublication(before, count); assert.equal(writes().length, 0);
    await save(); await until(() => writes().length === 1, "Fresh A control");
  });

  for (const stage of ["headers", "body"] as const) for (const kind of ["doctor", "workspace", "role", "account", "sdk-aba", "signout", "unmount"]) {
    await t.test(`pending save ${stage}: ${kind} turnover keeps accepted owner and suppresses continuation`, async () => {
      await reset(); const held = hold("doctor-schedule", "POST", stage); await captureSave(); await save(); await waiting(held);
      assert.equal(writes().length, 1); const accepted = writes()[0];
      assert.equal(accepted.body.doctorId, DA); assert.equal(accepted.workspace, WA); assert.equal(accepted.token, "Bearer fixture-A-1");
      if (kind === "doctor") { await pick("Doctor B"); await pick("Doctor A"); }
      if (kind === "workspace") { await evaluate(`f.workspace('${WB}');`); await ready(); await evaluate(`f.workspace('${WA}');`); await ready(); }
      if (kind === "role") { role = "receptionist"; await evaluate("f.emit();"); await until(async () => (await state()).role === role, "Role revoked");
        role = "owner"; await evaluate("f.emit();"); await until(async () => (await state()).role === role, "Role restored"); await ready(); }
      if (kind === "account") { await evaluate("f.emit('B');"); await until(async () => (await state()).actor === "actor-B", "Account B"); await ready();
        await evaluate("f.emit('A');"); await until(async () => (await state()).actor === "actor-A", "Account A"); await ready(); }
      if (kind === "sdk-aba") { await evaluate("f.emit('B');f.emit('A');"); await settle(); }
      if (kind === "signout") await evaluate("f.signoutFence();");
      if (kind === "unmount") await evaluate("f.unmount();");
      await settle(); const before = await state(), count = calls.length;
      held.release!(); await evaluate("f.invoke();"); await noLatePublication(before, count);
      assert.equal(writes().length, 1, "Accepted server work remains recorded; client abort is not cancellation");
      assert.equal(writes()[0], accepted); assert.equal(table(WA).shifts.some(row => row.doctorId === DA && row.weekday === 2), true);
    });
  }

  for (const kind of ["doctor", "workspace", "role", "sdk-aba", "silent-sdk", "unmount"]) {
    await t.test(`pending SDK token lookup: ${kind} prevents any mutation dispatch`, async () => {
      await reset(); await evaluate("f.holdToken();"); const beforeTokens = (await state()).tokenReads; await save();
      assert.ok((await state()).tokenReads > beforeTokens); assert.equal(writes().length, 0);
      if (kind === "doctor") { await pick("Doctor B"); await pick("Doctor A"); }
      if (kind === "workspace") await evaluate(`f.workspace('${WB}');f.workspace('${WA}');`);
      if (kind === "role") { role = "receptionist"; await evaluate("f.emit();"); await until(async () => (await state()).role === role, "Role turnover"); }
      if (kind === "sdk-aba") await evaluate("f.emit('B');f.emit('A');");
      if (kind === "silent-sdk") await evaluate("f.silent('B');");
      if (kind === "unmount") await evaluate("f.unmount();");
      await evaluate("f.releaseToken();"); await settle(); assert.equal(writes().length, 0);
    });
  }

  for (const stage of ["headers", "body"] as const) for (const kind of ["workspace", "role", "sdk-aba", "unmount"]) {
    await t.test(`pending load ${stage}: ${kind} cannot publish original directory or refresh`, async () => {
      await reset(); const held = hold("clinic-doctors", "GET", stage); await save(); await waiting(held);
      if (kind === "workspace") { await evaluate(`f.workspace('${WB}');`); await ready(); await evaluate(`f.workspace('${WA}');`); await ready(); }
      if (kind === "role") { role = "receptionist"; await evaluate("f.emit();"); await until(async () => (await state()).role === role, "Reader role"); await ready(); }
      if (kind === "sdk-aba") { await evaluate("f.emit('B');f.emit('A');"); await settle(); }
      if (kind === "unmount") await evaluate("f.unmount();");
      await settle(); const before = await state(), count = calls.length; held.release!(); await noLatePublication(before, count);
    });
  }

  await t.test("unmounted failed-load retry is inert; fresh component can load", async () => {
    await reset(); const held = hold("clinic-doctors", "GET"); await save(); await waiting(held); held.release!(true);
    await until(async () => !(await state()).selected, "Failed directory");
    await evaluate("f.captureButton('\\u041f\\u043e\\u043f\\u0440\\u043e\\u0431\\u043e\\u0432\\u0430\\u0442\\u044c \\u0441\\u043d\\u043e\\u0432\\u0430');f.unmount();");
    const before = await state(), count = calls.length; await evaluate("f.invoke();"); await noLatePublication(before, count); await reset();
  });

  await t.test("same-actor token refresh is usable and sends only the refreshed actor token", async () => {
    await reset(); await pick("Doctor B"); await evaluate("f.emit('A','TOKEN_REFRESHED',2);"); await settle(); await ready("Doctor B"); await save();
    await until(() => writes().length === 1, "Refreshed save"); assert.equal(writes()[0].token, "Bearer fixture-A-2"); assert.equal(writes()[0].body.doctorId, DB);
  });

  await t.test("weekly multi-row edits retain overnight normalization and do not convert closed windows", async () => {
    await reset(); await evaluate("f.field('input[type=time]','22:00',0,'onBlur');");
    await until(() => writes().length === 2, "Both working rows"); await settle();
    assert.deepEqual(writes().map(call => call.body.id), ["a-mon-1", "a-mon-2"]);
    assert.ok(writes().every(call => call.body.startMinute === 1320 && call.body.endMinute === 2520 && call.body.doctorId === DA));
    assert.equal(table(WA).shifts.find(row => row.id === "a-window").isWorking, false);
  });

  await t.test("multi-row and rhythm loops stop after an accepted first write loses its doctor", async () => {
    await reset(); let held = hold("doctor-schedule", "PATCH"); await evaluate("f.field('input[type=time]','10:00',0,'onBlur');"); await waiting(held);
    await pick("Doctor B"); let before = await state(), count = calls.length; held.release!(); await noLatePublication(before, count); assert.equal(writes().length, 1);
    await reset(); held = hold("doctor-schedule", "POST");
    await evaluate("f.field('input[type=date]','2030-01-01',0);f.click('\\u0417\\u0430\\u043f\\u043e\\u043b\\u043d\\u0438\\u0442\\u044c \\u0433\\u0440\\u0430\\u0444\\u0438\\u043a');"); await waiting(held);
    await pick("Doctor B"); before = await state(); count = calls.length; held.release!(); await noLatePublication(before, count); assert.equal(writes().length, 1);
  });

  for (const operation of ["directory", "day-off", "weekly-window", "exception", "move", "timezone"]) {
    await t.test(`${operation}: retained save and pending body belong only to the original doctor lifetime`, async () => {
      await reset(); const held = hold(operation === "directory" ? "clinic-doctors" : operation === "timezone" ? "admin-settings" : "doctor-schedule",
        ["directory", "day-off", "move"].includes(operation) ? "PATCH" : "POST");
      if (operation === "directory") await evaluate("f.edit('Doctor A');f.captureButton('\\u0421\\u043e\\u0445\\u0440\\u0430\\u043d\\u0438\\u0442\\u044c');f.click('\\u0421\\u043e\\u0445\\u0440\\u0430\\u043d\\u0438\\u0442\\u044c');");
      if (operation === "day-off") await evaluate("f.captureButton('\\u0417\\u0430\\u043a\\u0440\\u044b\\u0442\\u044c \\u0434\\u0435\\u043d\\u044c');f.click('\\u0417\\u0430\\u043a\\u0440\\u044b\\u0442\\u044c \\u0434\\u0435\\u043d\\u044c');");
      if (operation === "weekly-window") await evaluate("f.click('\\u0417\\u0430\\u043a\\u0440\\u044b\\u0442\\u044c \\u043e\\u043a\\u043d\\u043e');f.captureButton('\\u0417\\u0430\\u043a\\u0440\\u044b\\u0442\\u044c \\u043e\\u043a\\u043d\\u043e',1);f.click('\\u0417\\u0430\\u043a\\u0440\\u044b\\u0442\\u044c \\u043e\\u043a\\u043d\\u043e',1);");
      if (operation === "exception") await evaluate("f.field('input[type=date]','2030-01-01',2);f.captureButton('\\u0417\\u0430\\u043a\\u0440\\u044b\\u0442\\u044c \\u0434\\u0435\\u043d\\u044c',1);f.click('\\u0417\\u0430\\u043a\\u0440\\u044b\\u0442\\u044c \\u0434\\u0435\\u043d\\u044c',1);");
      if (operation === "move") await evaluate("f.capture('input[type=date]','onBlur',1,'2030-01-05');f.field('input[type=date]','2030-01-05',1,'onBlur');");
      if (operation === "timezone") await evaluate("f.capture('select','onChange',0,'Asia/Aqtau');f.field('select','Asia/Aqtau');");
      await waiting(held); const accepted = writes()[0];
      assert.equal(accepted.workspace, WA); assert.equal(accepted.token, "Bearer fixture-A-1");
      if (["day-off", "weekly-window", "exception"].includes(operation)) assert.equal(accepted.body.doctorId, DA);
      if (operation === "directory") assert.equal(accepted.body.id, DA);
      if (operation === "move") assert.equal(accepted.body.id, "a-exception");
      if (operation === "weekly-window") assert.deepEqual(accepted.body, { doctorId: DA, weekday: 1, isWorking: false, startMinute: 780, endMinute: 840, note: "", workspaceId: WA });
      if (operation === "exception") assert.deepEqual(accepted.body, { doctorId: DA, onDate: "2030-01-01", onDateEnd: "2030-01-01", isWorking: false, note: "", workspaceId: WA });
      await pick("Doctor B"); await pick("Doctor A"); const before = await state(), count = calls.length;
      held.release!(); await evaluate("f.invoke();"); await noLatePublication(before, count); assert.equal(writes().length, 1);
    });
  }

  for (const method of ["GET", "POST"]) await t.test(`late rejected ${method} is silent after unmount`, async () => {
    await reset(); const held = hold("doctor-schedule", method); await save(); await waiting(held);
    await evaluate("f.unmount();"); const before = await state(), count = calls.length;
    held.release!(true); await noLatePublication(before, count);
  });

  await evaluate("f.unmount();"); assert.equal((await state()).listeners, 0, "All real provider/editor SDK subscriptions cleaned up");
  assert.deepEqual((await state()).forbidden, []); assert.deepEqual(exceptions, []); assert.deepEqual(consoleErrors, []);
  assert.ok(requests.length > 0); assert.deepEqual(requests.filter(url => /^https?:/.test(url) && !url.startsWith(origin + "/")), [], "Owned browser only used loopback HTTP");
});

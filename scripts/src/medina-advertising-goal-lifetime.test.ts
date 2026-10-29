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

// Real React/StrictMode, page JSX, transport, token guards and brief builder.
// Synthetic SDK, deferred HTTP, router and in-memory storage only. No app env,
// user browser/profile, service, campaign mutation, installs or database.
// Green: node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-advertising-goal-lifetime.test.ts
// Red: node scripts/node_modules/tsx/dist/cli.mjs scripts/src/medina-advertising-goal-lifetime.test.ts --baseline
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const frontend = path.join(root, "artifacts/negis");
const require = createRequire(path.join(frontend, "package.json"));
const esbuild = createRequire(require.resolve("vite/package.json"))("esbuild");
const baseline = process.argv.includes("--baseline");
const pagePath = "artifacts/negis/src/pages/AdvertisingHub.tsx";
const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const OLD = "OLD_GOAL_PRIVATE_A";
const FRESH = "FRESH_GOAL_CURRENT";
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const mocks = `
import React,{useSyncExternalStore} from 'react';
import {flushSync} from 'react-dom';
import {markSignOutPending,clearSignOutPending} from '@/lib/authSignOut';
const initial={user:{id:'A'},clinicId:'${W1}',userRole:'owner',workspacePurpose:'clinic',
 isLoading:false,isSigningOut:false,isDemoMode:false,isImpersonation:false};
let context={...initial},actor='A',selector='${W1}',token='synthetic-A';
const listeners=new Set(),sdkListeners=new Set(),local=new Map(),session=new Map();
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
export const f={calls:[],httpAttempts:[],tokens:[],writes:[],navigations:[],history:[],retained:[],holdTokens:false,prevented:0,
 patch(value){flushSync(()=>{context={...context,...value};if('clinicId' in value)selector=value.clinicId||'demo-workspace';for(const fn of listeners)fn();});},
 raw(value,event='SIGNED_IN'){actor=value;token='synthetic-'+value;for(const fn of [...sdkListeners])fn(event,value?{user:{id:value},access_token:token}:null);},
 changeActor(value){flushSync(()=>{this.raw(value);context={...context,user:{id:value}};for(const fn of listeners)fn();});},
 rotate(){flushSync(()=>{token+='-rotated';for(const fn of [...sdkListeners])fn('TOKEN_REFRESHED',{user:{id:actor},access_token:token});});},
 reset(mode='owner'){clearSignOutPending();context={...initial,userRole:mode==='demo'?'owner':mode,isDemoMode:mode==='demo',clinicId:mode==='demo'?null:'${W1}'};
  actor='A';token='synthetic-A';selector=mode==='demo'?'demo-workspace':'${W1}';local.clear();session.clear();
  this.calls=[];this.httpAttempts=[];this.tokens=[];this.writes=[];this.navigations=[];this.history=[];this.retained=[];this.holdTokens=false;this.prevented=0;},
 tombstone(){markSignOutPending();if(!clearSignOutPending())throw Error('Synthetic signout cleanup failed');},
 transition(kind){
  if(kind==='unmount'){this.unmount();this.mount();}
  else if(kind==='actor'){this.changeActor('B');this.changeActor('A');}
  else if(kind==='workspace'){this.patch({clinicId:'${W2}'});this.patch({clinicId:'${W1}'});}
  else if(kind==='role'){this.patch({userRole:'admin'});this.patch({userRole:'owner'});}
  else if(kind==='private-read'){this.patch({userRole:'manager'});this.patch({userRole:'owner'});}
  else if(kind==='membership'){this.patch({clinicId:null});this.patch({clinicId:'${W1}'});}
  else if(kind==='SDK-ABA'){flushSync(()=>{this.raw('B');this.raw('A');});}
  else {this.patch({[kind]:true});this.patch({[kind]:false});}
 },
 props(node){if(!node)throw Error('Missing rendered control');return node[Object.keys(node).find(k=>k.startsWith('__reactProps$'))];},
 controls(){const form=document.querySelector('form');return{
  prepare:this.props(form.querySelector('button[type=button]')).onClick,
  submit:this.props(form).onSubmit,
  update:this.props(form.querySelector('input')).onChange,
  refresh:this.props(document.querySelector('[aria-labelledby=advertising-summary-title] button')).onClick,
  retry:document.querySelector('[aria-labelledby=advertising-assistant-title] button')
   ?this.props(document.querySelector('[aria-labelledby=advertising-assistant-title] button')).onClick:null};},
 capture(){const c=this.controls();this.retained=[()=>c.prepare(),()=>c.submit({preventDefault:()=>this.prevented++}),
  ()=>c.update({target:{value:'${OLD}'}}),()=>c.refresh()];if(c.retry)this.retained.push(()=>c.retry());},
 invoke(){flushSync(()=>{for(const fn of this.retained)fn();});},
 invokePrivate(){flushSync(()=>{for(const fn of this.retained.slice(0,3))fn();});},
 beforeCommit(){this.raw('B');this.raw('A');for(const fn of this.retained)fn();flushSync(()=>{});},
 fill(service='${OLD}'){const fields=[...document.querySelectorAll('form input')],values=[service,'23','14','280'];
  flushSync(()=>fields.forEach((node,i)=>this.props(node).onChange({target:{value:values[i]}})));},
 click(kind){if(kind==='submit'){
  flushSync(()=>document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 }else{const node=kind==='prepare'?document.querySelector('form button[type=button]'):
  kind==='retry'?document.querySelector('[aria-labelledby=advertising-assistant-title] button'):
  document.querySelector('[aria-labelledby=advertising-summary-title] button');
  if(!node||node.disabled)throw Error('Missing enabled '+kind);flushSync(()=>node.click());}},
 payload(c,name='CURRENT_REPORT'){if(c.kind==='auth-context')return{workspaceId:c.workspace,role:c.role,isAdmin:['owner','admin'].includes(c.role)};
  if(c.kind==='meta-launches')return{launches:[{id:'synthetic-read-only',campaignName:name,status:'paused',metaCampaignId:'synthetic-history',createdAt:'2026-10-22T08:00:00Z'}]};
  if(c.kind==='meta-insights-history')return{summaries:[]};
  return{outcomes:{attributedLeads:3,unattributedLeads:0,paidAttributedDeals:1,paidUnattributedDeals:0,
   paidAppointmentDeals:1,paidAttributedAppointmentDeals:1,pendingDeals:0,attributedRevenueByCurrency:[],generatedAt:'2026-10-22T08:00:00Z'}};},
 reply(c,name='CURRENT_REPORT',heldBody=false,status=200){if(c.answered)throw Error('Duplicate fake HTTP reply');c.answered=true;
  const body={success:status<400,mode:'supabase',data:this.payload(c,name)};
  const response=Response.json(body,{status});
  const text=response.text.bind(response);response.text=async()=>{c.decoding=true;
   if(heldBody){c.bodyGate=deferred();await c.bodyGate.promise;}const value=await text();c.decoded=true;return value;};
  c.resolve(response);},
 answerPending(skip=[]){for(const c of this.calls.filter(c=>!c.answered&&!skip.includes(c.id)))this.reply(c);},
 allowAuth(){for(const c of this.calls.filter(c=>!c.answered&&c.kind==='auth-context'))this.reply(c);},
 releaseTokens(){this.holdTokens=false;for(const c of this.tokens)c.gate.resolve();},
 snapshot(){return{html:document.getElementById('root').innerHTML,text:document.getElementById('root').textContent,
  goals:[...document.querySelectorAll('form input')].map(n=>n.value),writes:this.writes,navigations:this.navigations,httpAttempts:this.httpAttempts,
  calls:this.calls.map(({id,kind,actor,workspace,role,authorization,answered,decoding,decoded,init})=>
   ({id,kind,actor,workspace,role,authorization,answered,decoding:!!decoding,decoded:!!decoded,aborted:init.signal.aborted})),
  tokens:this.tokens.length,listeners:sdkListeners.size,history:this.history,prevented:this.prevented};},
};
function storage(map){return{getItem:key=>map.get(key)??null,setItem(key,value){map.set(key,String(value));
 if(key!=='negis_signout_pending_v1')f.writes.push({key,value:String(value),actor,workspace:context.clinicId});},
 removeItem:key=>map.delete(key),clear:()=>map.clear()};}
Object.defineProperty(window,'localStorage',{value:storage(local)});
Object.defineProperty(window,'sessionStorage',{value:storage(session)});
globalThis.fetch=(input,init={})=>new Promise(resolve=>{const url=new URL(input,location.origin);
 f.httpAttempts.push({path:url.pathname,method:init.method||'GET',hasBody:init.body!==undefined});
 if(url.origin!==location.origin||!/^\\/api\\/crm\\/(meta-launches|auth-context|meta-insights-history|advertising-outcomes)$/.test(url.pathname)
  ||(init.method||'GET')!=='GET'||init.body!==undefined||init.cache!=='no-store'||!init.signal||init.signal.aborted)throw Error('Forbidden synthetic HTTP');
 f.calls.push({id:f.calls.length,kind:url.pathname.split('/').pop(),actor,workspace:url.searchParams.get('workspaceId'),role:context.userRole,
  authorization:new Headers(init.headers).get('Authorization'),init,resolve,answered:false});
 // Deliberately ignore cancellation so actual consumer lifetime guards are tested.
});
export function useAuth(){return useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn);},()=>context);}
export const hasSupabaseFrontendEnv=true;
export const supabase={auth:{async getSession(){const gate=deferred(),captured=actor?{user:{id:actor},access_token:token}:null;
 const call={gate,captured};f.tokens.push(call);if(f.holdTokens)await gate.promise;
 return{error:null,data:{session:captured}};},
 onAuthStateChange(fn){sdkListeners.add(fn);return{data:{subscription:{unsubscribe(){sdkListeners.delete(fn);}}}};}}};
export const sessionAuth={onAuthStateChange:supabase.auth.onAuthStateChange};
export const isRealWorkspace=id=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export const readWorkspaceId=()=>selector;
export const workspaceScopedKey=key=>key+'::'+selector;
export const readDemoStorage=()=>[];
export const useLocation=()=>['/advertising',destination=>f.navigations.push({destination,actor,workspace:context.clinicId})];
export const Link=({href,children})=><a href={href}>{children}</a>;
export const PageLayout=({children})=><main>{children}</main>;
export const PageHeader=()=>null;
export const MetricCard=({label,value})=><div>{label}: {value}</div>;
const Icon=()=>null;
export {Icon as AlertTriangle,Icon as ArrowRight,Icon as BarChart3,Icon as Bot,Icon as CheckCircle2,
 Icon as Clapperboard,Icon as Clock3,Icon as FlaskConical,Icon as History,Icon as Megaphone,
 Icon as MousePointerClick,Icon as RefreshCw,Icon as Rocket,Icon as Target,Icon as Upload,Icon as WalletCards};
`;

const entry = `import React,{StrictMode} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import AdvertisingHub from './src/pages/AdvertisingHub';import {f} from 'advertising-goal-owned-fake';
let app;f.mount=()=>{app=createRoot(document.getElementById('root'));flushSync(()=>app.render(<StrictMode><AdvertisingHub/></StrictMode>));};
f.unmount=()=>flushSync(()=>app.unmount());
new MutationObserver(()=>f.history.push({text:document.getElementById('root').textContent,
 goals:[...document.querySelectorAll('form input')].map(n=>n.value)})).observe(document.getElementById('root'),{subtree:true,childList:true,characterData:true,attributes:true});
window.__goalFixture=f;f.reset();f.mount();`;

type Snapshot = {
  html: string; text: string; goals: string[]; tokens: number; listeners: number; prevented: number;
  writes: Array<{ key: string; value: string; actor: string; workspace: string | null }>;
  navigations: Array<{ destination: string; actor: string; workspace: string | null }>;
  calls: Array<{ id: number; kind: string; actor: string; workspace: string; role: string; authorization: string;
    answered: boolean; decoding: boolean; decoded: boolean; aborted: boolean }>;
  httpAttempts: Array<{ path: string; method: string; hasBody: boolean }>;
  history: Array<{ text: string; goals: string[] }>;
};

test("owned React campaign-goal and refresh lifetime controls", { timeout: 180_000 }, async t => {
  t.after(() => esbuild.stop());
  const browserPath = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
  assert.ok(browserPath, "Installed Chromium required; no downloads or user browser fallback");
  const bundle = await esbuild.build({
    stdin: { contents: entry, sourcefile: "advertising-goal-owned.tsx", resolveDir: frontend, loader: "tsx" },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", metafile: true,
    define: { "process.env.NODE_ENV": '"development"', "import.meta.env.BASE_URL": '"/"', "import.meta.env.VITE_API_BASE_URL": '""' },
    plugins: [{ name: "advertising-goal-owned-only", setup(build: any) {
      build.onResolve({ filter: /^(advertising-goal-owned-fake|react|react-dom(?:\/client)?|lucide-react|wouter|@\/contexts\/AuthContext|@\/components\/.*|@\/lib\/(supabase|demoStorage))$/ }, (args: { path: string }) => {
        if (["react", "react-dom", "react-dom/client"].includes(args.path)) return { path: require.resolve(args.path) };
        return { path: "mocks", namespace: "fixture" };
      });
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: mocks, loader: "tsx", resolveDir: frontend }));
      build.onResolve({ filter: /^@\// }, (args: { path: string }) => {
        const base = path.join(frontend, "src", args.path.slice(2));
        const file = [base + ".ts", base + ".tsx"].find(existsSync); assert.ok(file, args.path); return { path: file };
      });
      build.onLoad({ filter: /AdvertisingHub\.tsx$/ }, async (args: { path: string }) => ({
        contents: baseline ? execFileSync("git", ["show", `db73c4a:${pagePath}`], { cwd: root, encoding: "utf8" }) : await readFile(args.path, "utf8"), loader: "tsx",
      }));
      build.onLoad({ filter: /\.(?:[cm]?[jt]sx?|json)$/ }, (args: { path: string }) => {
        assert.doesNotMatch(args.path, /(?:^|[/\\])\.env(?:\.|$)/);
        assert.doesNotMatch(args.path.replaceAll("\\", "/"), /\/src\/(?:contexts\/AuthContext|lib\/(?:supabase|demoStorage))\.[jt]sx?$/);
      });
    } }],
  });
  const inputs = Object.keys(bundle.metafile.inputs).map(file => file.replaceAll("\\", "/"));
  for (const file of [pagePath, "artifacts/negis/src/lib/api.ts", "artifacts/negis/src/lib/serverAuth.ts", "artifacts/negis/src/lib/authSignOut.ts", "lib/advertising/campaignBrief.ts"])
    assert.ok(inputs.some((input: string) => input.endsWith(file)), `Real source bundled: ${file}`);

  const server = createServer((req, res) => {
    if (req.headers.host !== `127.0.0.1:${(server.address() as any).port}` || req.method !== "GET" || !["/", "/bundle.js", "/favicon.ico"].includes(req.url ?? "")) {
      res.writeHead(403); res.end(); return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; form-action 'none'; frame-src 'none'");
    if (req.url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    if (req.url === "/bundle.js") { res.setHeader("Content-Type", "application/javascript"); res.end(bundle.outputFiles[0].text); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<!doctype html><html lang="ru"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const profile = await mkdtemp(path.join(tmpdir(), "medina-advertising-goal-owned-"));
  const child = spawn(browserPath, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--disable-sync",
    "--disable-component-update", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
  { windowsHide: true, stdio: "ignore", env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", TEMP: profile, TMP: profile } });
  const exited = new Promise(resolve => { child.once("exit", resolve); child.once("error", resolve); });
  let socket: WebSocket | undefined;
  let cdp: ((method: string, params?: Record<string, unknown>) => Promise<any>) | undefined;
  t.after(async () => {
    await cdp?.("Browser.close").catch(() => {});
    await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, delay(5000)]); }
    socket?.close();
    assert.equal(path.dirname(profile), path.resolve(tmpdir())); assert.ok(path.basename(profile).startsWith("medina-advertising-goal-owned-"));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  let port = "";
  for (let i = 0; i < 250; i++) {
    assert.equal(child.exitCode, null);
    try { port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0]; } catch {}
    if (/^\d+$/.test(port)) break; await delay(40);
  }
  assert.match(port, /^\d+$/);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const page = targets.find(value => value.type === "page"); assert.ok(page);
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
    socket!.addEventListener("error", () => { clearTimeout(timer); reject(Error("Owned browser connection failed")); }, { once: true }); });
  cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(`Owned CDP timeout: ${method}`)); }, 15_000);
    pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params }));
  });
  await cdp("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  socket.addEventListener("message", event => {
    const data = JSON.parse(String(event.data)); if (data.method !== "Fetch.requestPaused") return;
    const { requestId, request } = data.params;
    const allowed = request.url.startsWith(origin + "/");
    if (!allowed) exceptions.push({ forbiddenUrl: request.url });
    void cdp!(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", allowed ? { requestId } : { requestId, errorReason: "BlockedByClient" });
  });
  const evaluate = async (body: string): Promise<any> => {
    const result = await cdp!("Runtime.evaluate", { expression: `(async()=>{const f=window.__goalFixture;${body}})()`, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  await cdp("Network.enable"); await cdp("Runtime.enable"); await cdp("Page.navigate", { url: origin });
  let ready = false;
  for (let i = 0; i < 150; i++) { ready = await evaluate("return !!f;"); if (ready) break; await delay(20); }
  assert.ok(ready, JSON.stringify(exceptions));
  const drain = () => evaluate("for(let i=0;i<6;i++)await new Promise(resolve=>setTimeout(resolve,0));");
  const state = (): Promise<Snapshot> => evaluate("return f.snapshot();");
  const settle = async (skip: number[] = []) => {
    for (let i = 0; i < 4; i++) { await drain(); await evaluate(`f.answerPending(${JSON.stringify(skip)});`); }
    await drain();
  };
  const reset = async (mode = "owner") => { await evaluate(`f.unmount();f.reset('${mode}');f.mount();`); await settle(); };
  const assertNoEffects = (before: Snapshot, after: Snapshot) => {
    assert.deepEqual(after.writes, before.writes, "No old goal may enter any draft key");
    assert.deepEqual(after.navigations, before.navigations, "No old goal navigation");
    assert.equal(after.calls.length, before.calls.length, "No retained refresh dispatch");
    assert.equal(after.tokens, before.tokens, "No retained refresh token lookup");
    assert.deepEqual(after.goals, before.goals);
    assert.ok(after.html === before.html, "Retained controls cannot update the current page");
  };

  for (const mode of ["owner", "admin", "demo"]) for (const action of ["prepare", "submit"]) {
    await t.test(`positive ${mode} same-session ${action} keeps the scoped goal and does not send HTTP`, async () => {
      await reset(mode); await evaluate("f.fill();f.capture();f.rotate();"); await drain();
      const before = await state(); await evaluate(`f.click('${action}');`); await drain(); const after = await state();
      assert.equal(after.writes.length, 1); assert.equal(after.navigations.length, 1);
      assert.equal(after.calls.length, before.calls.length); assert.equal(after.tokens, before.tokens);
      assert.equal(after.goals[0], OLD, "Token rotation must not remount a same-actor form");
      const write = after.writes[0], brief = JSON.parse(write.value);
      assert.equal(write.key, `${action === "prepare" ? "negis_content_studio_goal_prefill" : "negis_ads_automation_prefill"}::${mode === "demo" ? "demo-workspace" : W1}`);
      assert.equal(brief.service, OLD); assert.equal(brief.targetPatients, 23); assert.equal(brief.durationDays, 14);
      assert.equal(brief.maxBudget, 280); assert.equal(brief.dailyBudget, 20); assert.equal(brief.sourceKind, "goal");
      assert.equal(after.navigations[0].destination, action === "prepare" ? "/content-studio" : "/ads-automation");
      assert.equal(after.listeners, 2); if (mode === "demo") assert.equal(after.calls.length, 0);
    });
  }

  await t.test("positive current refresh and assistant retry reload all three read-only reports", async () => {
    await reset(); const before = await state(); await evaluate("f.click('refresh');"); await settle(); const after = await state();
    for (const kind of ["meta-launches", "auth-context", "meta-insights-history", "advertising-outcomes"])
      assert.ok(after.calls.filter(c => c.kind === kind).length > before.calls.filter(c => c.kind === kind).length, kind);
    assert.ok(after.calls.every(c => c.workspace === W1 && c.actor === "A" && c.authorization === "Bearer synthetic-A"));
    assert.equal(after.writes.length, 0); assert.equal(after.navigations.length, 0);
    await evaluate("f.click('refresh');"); await drain();
    await evaluate("for(const c of f.calls.filter(c=>!c.answered&&c.kind==='meta-launches'))f.reply(c,'unused',false,503);"); await settle();
    assert.equal(await evaluate("return !!f.controls().retry;"), true);
    const failed = await state(); await evaluate("f.click('retry');"); await settle();
    assert.ok((await state()).calls.length > failed.calls.length, "Rendered assistant retry remains usable");
  });

  await t.test("invalid current form reports validation without drafts or navigation", async () => {
    await reset(); await evaluate("f.click('submit');"); await drain(); const after = await state();
    assert.match(after.html, /role="alert"/); assert.equal(after.writes.length, 0); assert.equal(after.navigations.length, 0);
  });

  await t.test("positive demo refresh preserves its goal without SDK lookups or HTTP", async () => {
    await reset("demo"); await evaluate("f.fill();f.click('refresh');"); await drain(); const after = await state();
    assert.equal(after.goals[0], OLD); assert.equal(after.calls.length, 0); assert.equal(after.tokens, 0);
    assert.equal(after.writes.length, 0); assert.equal(after.navigations.length, 0);
  });

  await t.test("manager refresh reads only meta-launches GET without private reports, campaign actions or mutations", async () => {
    await reset("manager"); await evaluate("f.fill();f.capture();"); const before = await state();
    await evaluate("f.invokePrivate();"); await drain();
    const denied = await state();
    assertNoEffects(before, denied); assert.equal(denied.prevented, before.prevented + 1);
    assert.deepEqual(denied.httpAttempts, before.httpAttempts, "Private actions cannot even attempt HTTP");

    await evaluate("f.click('refresh');"); await settle(); const after = await state();
    assert.equal(after.calls.length, denied.calls.length + 1, "One current Refresh issues one history GET");
    assert.deepEqual(after.httpAttempts.slice(denied.httpAttempts.length), [{ path: "/api/crm/meta-launches", method: "GET", hasBody: false }]);
    assert.ok(after.calls.every(c => c.kind === "meta-launches" && c.actor === "A" && c.workspace === W1
      && c.role === "manager" && c.authorization === "Bearer synthetic-A"), "No private CRM, Insights or auth-context reads");
    assert.ok(after.httpAttempts.every(c => c.path === "/api/crm/meta-launches" && c.method === "GET" && !c.hasBody), "No mutation attempts, including caught refusals");
    assert.deepEqual(after.writes, before.writes); assert.deepEqual(after.navigations, before.navigations);
    assert.deepEqual(after.goals, before.goals);

    await evaluate("f.invokePrivate();"); await drain();
    const stillDenied = await state(); assertNoEffects(after, stillDenied);
    assert.deepEqual(stillDenied.httpAttempts, after.httpAttempts, "Read refresh never grants campaign capabilities");
    await evaluate("f.capture();f.tombstone();"); const retired = await state();
    await evaluate("f.invoke();"); await drain(); const blocked = await state();
    assertNoEffects(retired, blocked); assert.deepEqual(blocked.httpAttempts, retired.httpAttempts);
  });

  for (const control of ["refresh", "retry"]) {
    await t.test(`retained ${control} stays inert after signout revision without a React remount`, async () => {
      await reset();
      if (control === "retry") {
        await evaluate("f.click('refresh');"); await drain();
        await evaluate("for(const c of f.calls.filter(c=>!c.answered&&c.kind==='meta-launches'))f.reply(c,'unused',false,503);"); await settle();
      }
      await evaluate(`f.fill();f.capture();f.tombstone();`); const before = await state();
      await evaluate("f.invoke();"); await drain(); assertNoEffects(before, await state());
    });
  }

  const boundaries = ["unmount", "actor", "workspace", "role", "private-read", "membership", "isLoading", "isSigningOut", "isDemoMode", "isImpersonation", "SDK-ABA"];
  for (const stage of ["token", "headers", "body"]) for (const boundary of boundaries) {
    await t.test(`${stage} wait across ${boundary} A/B/A rejects retained form/refresh and late reports`, async () => {
      await reset(); await evaluate("f.fill();f.capture();f.holdTokens=true;f.click('refresh');"); await drain();
      const start = await state(); let held: number[] = [];
      if (stage !== "token") {
        await evaluate("f.releaseTokens();"); await drain(); await evaluate("f.allowAuth();"); await drain();
        held = (await state()).calls.filter(c => !c.answered && c.kind !== "auth-context").map(c => c.id);
        assert.equal(held.length, 3, "All current report headers are deferred");
        if (stage === "body") {
          await evaluate(`for(const id of ${JSON.stringify(held)})f.reply(f.calls[id],'${OLD}',true);`); await drain();
          assert.ok((await state()).calls.filter(c => held.includes(c.id)).every(c => c.decoding && !c.decoded));
        }
      } else assert.ok(start.tokens > 0);
      await evaluate(`f.holdTokens=false;f.transition('${boundary}');f.history=[];`);
      await settle(held); const fresh = await state();
      assert.equal(fresh.goals[0], "", "The replacement lifetime starts without A's old goal");
      await evaluate(`f.fill('${FRESH}');`); await drain(); const before = await state();
      await evaluate("f.invoke();"); await drain(); assertNoEffects(before, await state());
      if (stage === "token") await evaluate("f.releaseTokens();");
      else if (stage === "headers") await evaluate(`for(const id of ${JSON.stringify(held)})f.reply(f.calls[id],'${OLD}');`);
      else await evaluate(`for(const id of ${JSON.stringify(held)})f.calls[id].bodyGate.resolve();`);
      await drain(); const after = await state(); assertNoEffects(before, after);
      assert.ok(after.history.every(view => !view.text.includes(OLD) && !view.goals.includes(OLD)), "No transient old goal/report in the replacement DOM");
      assert.equal(after.listeners, 2, "Real StrictMode/remounts leave only the current SDK subscriptions");
      await evaluate("f.click('submit');"); await drain(); const usable = await state();
      assert.equal(usable.writes.length, 1); assert.equal(JSON.parse(usable.writes[0].value).service, FRESH);
      assert.deepEqual(usable.navigations, [{ destination: "/ads-automation", actor: "A", workspace: W1 }]);
      assert.ok(usable.calls.every(c => c.actor === "A" || c.actor === "B"));
    });
  }

  for (const boundary of ["actor", "workspace", "manager"]) {
    await t.test(`late A body and retained goals cannot enter the current ${boundary} replacement`, async () => {
      await reset(); await evaluate("f.fill();f.capture();f.click('refresh');"); await drain();
      await evaluate("f.allowAuth();"); await drain();
      const held = (await state()).calls.filter(c => !c.answered).map(c => c.id);
      assert.equal(held.length, 3);
      await evaluate(`for(const id of ${JSON.stringify(held)})f.reply(f.calls[id],'${OLD}',true);`); await drain();
      await evaluate(boundary === "actor" ? "f.changeActor('B');f.history=[];" : boundary === "workspace"
        ? `f.patch({clinicId:'${W2}'});f.history=[];` : "f.patch({userRole:'manager'});f.history=[];");
      await settle(held); assert.equal((await state()).goals[0], "");
      await evaluate(`f.fill('${FRESH}');`); await drain(); const before = await state();
      await evaluate("f.invoke();"); await drain(); assertNoEffects(before, await state());
      await evaluate(`for(const id of ${JSON.stringify(held)})f.calls[id].bodyGate.resolve();`); await drain();
      const after = await state(); assertNoEffects(before, after);
      assert.ok(after.history.every(view => !view.text.includes(OLD) && !view.goals.includes(OLD)));
      await evaluate("f.click('submit');"); await drain(); const usable = await state();
      if (boundary === "manager") { assertNoEffects(before, usable); return; }
      assert.equal(usable.writes.length, 1); assert.equal(JSON.parse(usable.writes[0].value).service, FRESH);
      assert.equal(usable.writes[0].key, `negis_ads_automation_prefill::${boundary === "workspace" ? W2 : W1}`);
      assert.deepEqual(usable.navigations, [{ destination: "/ads-automation", actor: boundary === "actor" ? "B" : "A", workspace: boundary === "workspace" ? W2 : W1 }]);
      const currentCalls = usable.calls.filter(c => !held.includes(c.id) && c.id > held.at(-1)!);
      assert.ok(currentCalls.length > 0 && currentCalls.every(c => c.authorization === `Bearer synthetic-${boundary === "actor" ? "B" : "A"}`
        && c.workspace === (boundary === "workspace" ? W2 : W1)));
    });
  }

  await t.test("SDK ABA invalidates captured callbacks synchronously before React commits", async () => {
    await reset(); await evaluate("f.fill();f.capture();f.beforeCommit();"); await settle(); const after = await state();
    assert.equal(after.writes.length, 0); assert.equal(after.navigations.length, 0); assert.equal(after.goals[0], "");
    assert.equal(after.listeners, 2);
  });
  await evaluate("f.unmount();f.invoke();"); await drain();
  assert.equal((await state()).listeners, 0);
  assert.deepEqual(exceptions, []); assert.deepEqual(consoleErrors, []);
  assert.ok(requests.length >= 2 && requests.every(url => [origin + "/", origin + "/bundle.js", origin + "/favicon.ico"].includes(url)), "Only owned fixture assets used actual loopback HTTP");
});

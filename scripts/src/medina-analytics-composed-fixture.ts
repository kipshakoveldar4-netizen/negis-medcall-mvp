import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Adapted from the owned appointment-recovery Chromium fixture. Never connects
// to a user's browser. The real page, scope, hooks, reports and primitives bundle
// in memory; only app chrome, auth, storage and the CRM transport are replaced.
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const frontend = path.join(root, "artifacts/negis");
const frontendRequire = createRequire(path.join(frontend, "package.json"));
const esbuild = createRequire(frontendRequire.resolve("vite/package.json"))("esbuild") as {
  build(options: Record<string, unknown>): Promise<{ outputFiles: Array<{ text: string }>; metafile: { inputs: Record<string, unknown> } }>;
  stop(): void;
};
export const ids = Object.freeze({
  workspaceA: "00000000-0000-4000-8000-000000003301",
  workspaceB: "00000000-0000-4000-8000-000000003302",
  actorA: "00000000-0000-4000-8000-000000003303",
  actorB: "00000000-0000-4000-8000-000000003304",
});
export const panels = ["mortgage-workspace", "lead-team-analytics", "mortgage-results"] as const;
export type Panel = typeof panels[number];

const mocks = `
import {useSyncExternalStore} from 'react';
import {flushSync} from 'react-dom';
const ids=${JSON.stringify(ids)},panels=${JSON.stringify(panels)};
const initial={user:{id:ids.actorA},clinicId:ids.workspaceA,userRole:'owner',workspacePurpose:'mortgage_leads',
  isLoading:false,isSigningOut:false,isDemoMode:false,isImpersonation:false};
let context={...initial},actor=ids.actorA;
const listeners=new Set(),sdkListeners=new Set();
export const fixture={requests:[],received:[],decoding:[],decoded:[],history:[],sdkListeners,
  patch(value){flushSync(()=>{context={...context,...value};for(const fn of listeners)fn();});},
  raw(value,event='SIGNED_IN'){actor=value;for(const fn of [...sdkListeners])fn(event,value?{user:{id:value}}:null);},
  actor(value){flushSync(()=>{this.raw(value);context={...context,user:{id:value}};for(const fn of listeners)fn();});},
  aba(){flushSync(()=>{this.raw(ids.actorB);this.raw(ids.actorA);});},
  refresh(){flushSync(()=>this.raw(actor,'TOKEN_REFRESHED'));},
  reset(role='owner'){context={...initial,userRole:role};actor=ids.actorA;this.requests=[];this.received=[];this.decoding=[];this.decoded=[];this.history=[];},
  snapshot(){const root=document.getElementById('root');return {text:root.textContent,tables:root.querySelectorAll('table').length,
    rows:[...root.querySelectorAll('tbody th[scope=row]')].map(n=>n.textContent),meters:[...root.querySelectorAll('meter')].map(n=>n.value),
    cells:[...root.querySelectorAll('tbody td,tfoot td')].map(n=>n.textContent),
    stats:[...root.querySelectorAll('dd')].map(n=>n.textContent),alerts:[...root.querySelectorAll('[role=alert]')].map(n=>n.textContent),
    busy:root.querySelectorAll('[aria-busy=true]').length,requests:this.requests,received:this.received,decoding:this.decoding,decoded:this.decoded,
    listeners:sdkListeners.size};},
  control(panel,days){
    if(panel==='lead-team-analytics')return document.querySelector('select[aria-label]');
    const group=document.querySelector('[aria-label="'+(panel==='mortgage-workspace'?'\u041f\u0435\u0440\u0438\u043e\u0434 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0439 \u0441\u043e\u0442\u0440\u0443\u0434\u043d\u0438\u043a\u043e\u0432':'\u041f\u0435\u0440\u0438\u043e\u0434 \u0437\u0430\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u044f \u0434\u043e\u0433\u043e\u0432\u043e\u0440\u043e\u0432')+'"]');
    return [...(group?.querySelectorAll('button')||[])].find(n=>n.textContent.startsWith(String(days)+' '));
  },
  period(panel,days){const node=this.control(panel,days);if(!node)throw Error('Missing period control: '+panel);
    flushSync(()=>{if(node.tagName==='SELECT'){node.value=String(days);node.dispatchEvent(new Event('change',{bubbles:true}));}else node.click();});},
  reload(panel){const labels=['\u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c \u043d\u0430\u0433\u0440\u0443\u0437\u043a\u0443 \u0438 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044f','\u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c \u0440\u0430\u0431\u043e\u0442\u0443 \u043a\u043e\u043c\u0430\u043d\u0434\u044b','\u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c \u0432\u0441\u0442\u0440\u0435\u0447\u0438 \u0438 \u0434\u043e\u0433\u043e\u0432\u043e\u0440\u044b'];
    const node=document.querySelector('button[aria-label="'+labels[panels.indexOf(panel)]+'"]');
    if(!node||node.disabled)throw Error('Missing/enabled refresh: '+panel);flushSync(()=>node.click());},
  capture(){this.retained=panels.map(panel=>{const node=this.control(panel,7);
    const props=node[Object.keys(node).find(key=>key.startsWith('__reactProps$'))];
    const callback=node.tagName==='SELECT'?props.onChange:props.onClick;
    return ()=>callback({target:{value:'7'}});});},
  stale(){flushSync(()=>{for(const fn of this.retained)fn();});},
  tick:()=>new Promise(resolve=>setTimeout(resolve,30))};
export function useAuth(){return useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn);},()=>context);}
export const readWorkspaceId=()=>context.clinicId;
export const hasSupabaseFrontendEnv=true;
export const supabase={auth:{onAuthStateChange(fn){sdkListeners.add(fn);return{data:{subscription:{unsubscribe(){sdkListeners.delete(fn);}}}};}}};
export const sessionAuth={onAuthStateChange:supabase.auth.onAuthStateChange};
export function PageLayout({children}){return <main>{children}</main>;}
export async function crmFetch(input,init={}){
  const url=new URL(input,location.origin);
  if(url.origin!==location.origin||!panels.some(panel=>url.pathname==='/api/crm/'+panel)||!['GET',undefined].includes(init.method))throw Error('Forbidden fixture request');
  if(init.expectedUserId!==context.user.id||!init.signal||init.cache!=='no-store')throw Error('Missing bound scope');
  const index=fixture.requests.length;
  fixture.requests.push({panel:url.pathname.split('/').pop(),workspace:url.searchParams.get('workspaceId'),days:Number(url.searchParams.get('days')),
    actor:init.expectedUserId,role:context.userRole,abortedAtDispatch:init.signal.aborted});
  // Intentionally ignore cancellation in this adversarial local transport. Late
  // native HTTP/JSON can complete, so the actual scope and consumer guards must win.
  const response=await fetch(url,{cache:'no-store',headers:{'X-Fixture-Actor':init.expectedUserId,'X-Fixture-Role':context.userRole,'X-Fixture-Request':String(index)}});
  fixture.received.push(index);
  const json=response.json.bind(response);
  response.json=async()=>{fixture.decoding.push(index);try{return await json();}finally{fixture.decoded.push(index);}};
  return response;
}
`;

export async function analyticsBundle() {
  const entry = `import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import MortgageAnalytics from './src/pages/MortgageAnalytics';import {fixture} from 'analytics-owned-fake';
let app;
fixture.mount=()=>{app=createRoot(document.getElementById('root'));flushSync(()=>app.render(<MortgageAnalytics/>));};
fixture.unmount=()=>flushSync(()=>app.unmount());
new MutationObserver(()=>fixture.history.push(fixture.snapshot())).observe(document.getElementById('root'),{subtree:true,childList:true,characterData:true});
window.__analyticsFixture=fixture;fixture.mount();`;
  const result = await esbuild.build({
    stdin: { contents: entry, resolveDir: frontend, sourcefile: "analytics-owned.tsx", loader: "tsx" },
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    metafile: true,
    plugins: [{ name: "owned-composed-analytics", setup(build: any) {
      build.onResolve({ filter: /^(analytics-owned-fake|@\/contexts\/AuthContext|@\/components\/layout\/PageLayout|@\/lib\/(api|supabase|demoStorage))$/ },
        () => ({ path: "mocks", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: mocks, loader: "tsx", resolveDir: frontend }));
      build.onResolve({ filter: /^@\// }, (args: { path: string }) => {
        const base = path.join(frontend, "src", args.path.slice(2));
        const file = [base + ".ts", base + ".tsx"].find(existsSync);
        assert.ok(file, args.path); return { path: file };
      });
      build.onLoad({ filter: /\.(?:[cm]?[jt]sx?|json)$/ }, (args: { path: string }) => {
        assert.doesNotMatch(args.path, /(?:^|[/\\])\.env(?:\.|$)/);
        assert.doesNotMatch(args.path.replaceAll("\\", "/"), /\/src\/(?:contexts\/AuthContext|lib\/(?:api|supabase|demoStorage))\.[jt]sx?$/,
          "Real authentication/environment/transport must never enter the fixture bundle");
      });
    } }],
  });
  const inputs = Object.keys(result.metafile.inputs).map(file => file.replaceAll("\\", "/"));
  for (const file of ["pages/MortgageAnalytics.tsx", "lib/mortgage-workspace.tsx", "components/crm/lead-team-analytics.tsx",
    "components/mortgage/MortgageResults.tsx", "components/mortgage/MortgagePrimitives.tsx"]) {
    assert.ok(inputs.some(input => input.endsWith(`/src/${file}`)), `Real composition must include ${file}`);
  }
  return result.outputFiles[0].text;
}
export const stopAnalyticsBundler = () => esbuild.stop();

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function ownedAnalyticsBrowser(origin: string, readyExpression = "f && f.requests.length===3") {
  assert.equal(new URL(origin).hostname, "127.0.0.1");
  assert.equal(new URL(origin).protocol, "http:");
  const browserPath = [process.env.MEDINA_TEST_BROWSER_PATH, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]
    .find(value => value && existsSync(value));
  assert.ok(browserPath, "Existing local Chromium required; no installation/download fallback");
  const profile = await mkdtemp(path.join(tmpdir(), "medina-analytics-composed-owned-"));
  const child = spawn(browserPath, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions",
    "--disable-sync", "--disable-component-update", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
  { windowsHide: true, stdio: "ignore", env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "HOME", "DISPLAY"].includes(key))) });
  const exited = new Promise<void>(resolve => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
  let ws: WebSocket | undefined, seq = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const exceptions: unknown[] = [], requests: string[] = [];
  const call = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error(`Owned analytics timeout: ${method}`)); }, 15_000);
    pending.set(id, { resolve, reject, timer }); ws!.send(JSON.stringify({ id, method, params }));
  });
  const close = async () => {
    if (ws?.readyState === WebSocket.OPEN) await call("Browser.close").catch(() => {});
    await Promise.race([exited, delay(3000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, delay(3000)]); }
    ws?.close();
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error("Owned analytics closed")); }
    pending.clear();
    assert.equal(path.dirname(profile), path.resolve(tmpdir()));
    assert.ok(path.basename(profile).startsWith("medina-analytics-composed-owned-"));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  try {
    let port = "";
    for (let i = 0; i < 250; i++) {
      assert.equal(child.exitCode, null, "Owned browser stays live during startup");
      try { port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0]; } catch {}
      if (/^\d+$/.test(port)) break;
      await delay(80);
    }
    assert.match(port, /^\d+$/);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const page = targets.find(value => value.type === "page"); assert.ok(page);
    ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
        if (message.method === "Network.requestWillBeSent") requests.push(message.params.request.url);
        return;
      }
      const item = pending.get(message.id); if (!item) return;
      clearTimeout(item.timer); pending.delete(message.id);
      if (message.error) item.reject(Error(JSON.stringify(message.error))); else item.resolve(message.result);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws!.close(); reject(Error("Owned analytics websocket startup timed out")); }, 10_000);
      ws!.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws!.addEventListener("error", () => { clearTimeout(timer); reject(Error("Owned analytics websocket failed")); }, { once: true });
    });
    // Browser-level allowlist as well as CSP/transport guards; never attach to an
    // existing profile or allow this page to make a non-loopback request.
    await call("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    ws.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.method !== "Fetch.requestPaused") return;
      const { requestId, request } = message.params;
      const allowed = request.url.startsWith(origin + "/");
      if (!allowed) exceptions.push({ forbiddenUrl: request.url });
      void call(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", allowed ? { requestId } : { requestId, errorReason: "BlockedByClient" });
    });
    await call("Network.enable"); await call("Runtime.enable");
    const evaluate = async <T = any>(body: string): Promise<T> => {
      const result = await call("Runtime.evaluate", { expression: `(async()=>{const f=window.__analyticsFixture;${body}})()`, awaitPromise: true, returnByValue: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); return result.result.value;
    };
    const waitFor = async (expression: string) => {
      for (let i = 0; i < 150; i++) {
        if (await evaluate<boolean>(`return !!(${expression});`)) return;
        await delay(30);
      }
      throw Error(`Analytics fixture did not settle: ${expression}; ${JSON.stringify({ exceptions, state: await evaluate("return f?.snapshot();") })}`);
    };
    await call("Page.navigate", { url: origin }); await waitFor(readyExpression);
    const viewport = (width: number, height: number) => {
      assert.ok(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width >= 320 && width <= 2560 && height >= 480 && height <= 1600);
      return call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 768 });
    };
    const screenshot = async () => Buffer.from((await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data, "base64");
    return { evaluate, waitFor, close, requests, exceptions, viewport, screenshot };
  } catch (error) { await close(); throw error; }
}

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const frontend = path.join(root, "artifacts/negis");
const require = createRequire(path.join(frontend, "package.json"));
const esbuild = createRequire(require.resolve("vite/package.json"))("esbuild");
const baseline = process.env.MEDINA_TELEGRAM_REPLAY_BASELINE_REF;
assert.ok(baseline === undefined || baseline === "37e1d3e", "Only the agreed read-only baseline is supported");
const pagePath = path.join(frontend, "src/pages/ContentStudio.tsx");
const mocksPath = path.join(root, "scripts/fixtures/advertising-reports-browser-mocks.tsx");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const freshSend = "\u041e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u043e \u0432 Telegram";
const freshTest = "Telegram \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0451\u043d";
const historical = /\u0440\u0430\u043d\u0435\u0435/i;
const noResend = /\u043f\u043e\u0432\u0442\u043e\u0440\u043d\u043e \u043d\u0435 \u043e\u0442\u043f\u0440\u0430\u0432\u043b\u044f\u043b/i;
const unconfirmedNew = /\u043d\u043e\u0432\u0430\u044f (?:\u043e\u0442\u043f\u0440\u0430\u0432\u043a\u0430|\u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0430) \u043d\u0435 \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u0430/i;
const sendLabel = "\u041e\u0442\u043f\u0440\u0430\u0432\u0438\u0442\u044c \u0432 Telegram";
const testLabel = "\u041f\u0440\u043e\u0432\u0435\u0440\u0438\u0442\u044c Telegram";

async function bundle() {
  // Reuse the owned auth fixture, actual React page/transport/guard, and native HTTP store.
  const entry = `
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import ContentStudio from ${JSON.stringify(pagePath.replaceAll("\\", "/"))};
import {reportsAuthFixture as auth} from ${JSON.stringify(mocksPath.replaceAll("\\", "/"))};
import {clearCrmCache} from '@/lib/api';
const nativeFetch=window.fetch.bind(window),messages=[],requests=[],violations=[];
const f={auth,messages,requests,violations,replay:true,nonce:'match',warning:false,unknown:false,hold:null,held:null,stage:'idle',pending:0};
window.__telegramReplay=f;
window.fetch=async(input,init={})=>{
 const url=new URL(String(input),location.origin);
 if(url.origin!==location.origin||!['/api/crm/auth-context','/api/content-studio/status','/api/content-studio/usage','/api/crm/content-videos','/api/content-studio/send-telegram'].includes(url.pathname)){
  violations.push(String(input));throw Error('Unlisted fixture request');
 }
 if(url.pathname!=='/api/content-studio/send-telegram')return nativeFetch(input,init);
 const body=JSON.parse(init.body),config={replay:f.replay,nonce:f.nonce,warning:f.warning,unknown:f.unknown,hold:f.hold};f.hold=null;
 if(body.test&&(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.testRequestId)||Object.keys(body).sort().join(',')!=='test,testRequestId')){
  violations.push('Invalid test intent');throw Error('Invalid test intent');
 }
 requests.push(body);f.pending++;
 // The older owned HTTP store accepts only {test:true}; retain and echo the actual nonce here.
 // Ignore cancellation only for these synthetic replies to exercise late-response guards.
 const response=await nativeFetch(input,{...init,signal:undefined,body:JSON.stringify(body.test?{test:true}:body)});
 const value=await response.json();
 if(value.data){if(config.replay!=='absent')value.data.replayed=config.replay;
  if(body.test&&config.nonce!=='absent')value.data.testRequestId=config.nonce==='match'?body.testRequestId:'00000000-0000-4000-8000-000000000099';}
 if(config.warning)value.warning={invalid:true};
 const text=config.unknown?'{unreadable':JSON.stringify(value);
 const hold=async()=>{f.stage=config.hold;await new Promise(resolve=>{f.held=resolve;});f.stage='released';};
 let finished=false;const finish=()=>{if(!finished){finished=true;f.pending--;f.stage='done';}};
 if(config.hold==='headers'){await hold();finish();}
 const result=new Response(text,{status:response.status,headers:{'Content-Type':'application/json'}});
 const read=result.text.bind(result);result.text=async()=>{try{if(config.hold==='body')await hold();return await read();}finally{finish();}};
 return result;
};
let app=createRoot(document.getElementById('root')),epoch=0,mounted=true;
function App(){React.useSyncExternalStore(auth.subscribe,auth.snapshot);return <ContentStudio key={epoch}/>;}
f.mount=()=>{if(!mounted){app=createRoot(document.getElementById('root'));mounted=true;}flushSync(()=>app.render(<React.StrictMode><App/></React.StrictMode>));};
f.unmount=()=>{if(mounted)flushSync(()=>app.unmount());mounted=false;};
f.remount=()=>{epoch++;f.mount();};
f.reset=()=>{f.unmount();localStorage.clear();sessionStorage.clear();auth.reset();clearCrmCache();messages.length=requests.length=violations.length=0;
 Object.assign(f,{replay:true,nonce:'match',warning:false,unknown:false,hold:null,held:null,stage:'idle',pending:0});f.mount();};
f.change=action=>flushSync(()=>{if(action==='manager')auth.role('lead_manager');else if(action==='actor')auth.switchActor();else if(action==='aba')auth.switchABA();else if(action==='refresh')auth.refresh();});
f.release=()=>{const release=f.held;f.held=null;if(release)release();};
f.mount();
`;
  const result = await esbuild.build({
    stdin: { contents: entry, resolveDir: frontend, sourcefile: "telegram-replay-owned.tsx", loader: "tsx" },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
    plugins: [{ name: "owned-telegram-replay", setup(build: any) {
      build.onResolve({ filter: /^react(?:-dom)?(?:\/|$)/ }, (args: { path: string }) => ({ path: require.resolve(args.path) }));
      build.onResolve({ filter: /^(?:@\/contexts\/AuthContext|@\/lib\/supabase|@\/components\/layout\/PageLayout)$/ }, () => ({ path: mocksPath }));
      build.onResolve({ filter: /^sonner$/ }, () => ({ path: "toasts", namespace: "synthetic" }));
      build.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({
        contents: "export const toast=Object.fromEntries(['success','warning','error'].map(kind=>[kind,message=>window.__telegramReplay.messages.push({kind,message})]));",
        loader: "js",
      }));
      build.onResolve({ filter: /^@\// }, (args: { path: string }) => {
        const base = path.join(frontend, "src", args.path.slice(2));
        const resolved = [base, `${base}.ts`, `${base}.tsx`].find((value) => existsSync(value));
        assert.ok(resolved, `Resolve existing local module ${args.path}`); return { path: resolved };
      });
      if (baseline) build.onLoad({ filter: /[\\/]pages[\\/]ContentStudio\.tsx$/ }, () => ({
        contents: execFileSync("git", ["show", `${baseline}:artifacts/negis/src/pages/ContentStudio.tsx`], { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 }),
        loader: "tsx", resolveDir: path.dirname(pagePath),
      }));
    } }],
  });
  return result.outputFiles[0].text as string;
}

type Message = { kind: string; message: string };
type State = { messages: Message[]; requests: Record<string, unknown>[]; violations: string[]; pending: number;
  stage: string; receipts: Array<{ state: string }>; library: Array<{ id: string; status: string; updatedAt: string }>; text: string };

// The owned Chromium/CDP lifecycle follows scripts/fixtures/profile-session-browser.mjs.
async function connect(url: string, onEvent: (method: string, params: any) => void) {
  const ws = new WebSocket(url), pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let id = 0;
  ws.addEventListener("message", (event) => {
    const data = JSON.parse(String(event.data));
    if (!data.id) { onEvent(data.method, data.params); return; }
    const item = pending.get(data.id); if (!item) return;
    clearTimeout(item.timer); pending.delete(data.id);
    if (data.error) item.reject(Error(JSON.stringify(data.error))); else item.resolve(data.result);
  });
  ws.addEventListener("close", () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error("Owned browser closed")); } pending.clear(); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(Error("Owned browser connection timeout")); }, 10000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(Error("Owned browser connection failed")); }, { once: true });
  });
  return { call(method: string, params: Record<string, unknown> = {}): Promise<any> { return new Promise((resolve, reject) => {
    const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(Error(`Owned CDP timeout: ${method}`)); }, 15000);
    pending.set(next, { resolve, reject, timer }); ws.send(JSON.stringify({ id: next, method, params }));
  }); }, close() { ws.close(); } };
}

test("G5 actual React Telegram callback: truthful replay notices and delivery/lifetime controls", { timeout: 120000 }, async (t) => {
  t.after(() => esbuild.stop());
  const browserPath = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(existsSync);
  assert.ok(browserPath, "Installed Chromium is required; never install/download a browser");
  const script = await bundle();
  const { createTelegramDeliveryHttpFixture } = await import(pathToFileURL(path.join(root, "scripts/fixtures/telegram-delivery-http-store.mjs")).href);
  const store = createTelegramDeliveryHttpFixture();
  const server = createServer((req, res) => {
    if (req.headers.host !== `127.0.0.1:${(server.address() as { port: number }).port}`) { res.writeHead(403); res.end(); return; }
    if (store.handle(req, res)) return;
    if (req.method !== "GET" || !["/", "/bundle.js", "/favicon.ico"].includes(req.url || "")) { res.writeHead(403); res.end(); return; }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; form-action 'none'; frame-src 'none'");
    if (req.url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    res.setHeader("Content-Type", req.url === "/bundle.js" ? "application/javascript" : "text/html; charset=utf-8");
    res.end(req.url === "/bundle.js" ? script : '<!doctype html><html lang="ru"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const profile = await mkdtemp(path.join(tmpdir(), "medina-telegram-replay-owned-"));
  const child = spawn(browserPath, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--disable-sync", "--disable-component-update", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], {
    windowsHide: true, stdio: "ignore", env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "HOME", "DISPLAY"].includes(key))),
  });
  let cdp: Awaited<ReturnType<typeof connect>> | undefined;
  const exited = new Promise((resolve) => { child.once("exit", resolve); child.once("error", resolve); });
  t.after(async () => {
    if (cdp) await cdp.call("Browser.close").catch(() => {});
    await Promise.race([exited, wait(5000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, wait(5000)]); }
    cdp?.close(); store.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal(path.dirname(profile), path.resolve(tmpdir())); assert.ok(path.basename(profile).startsWith("medina-telegram-replay-owned-"));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  let port = "";
  for (let i = 0; i < 250; i++) {
    assert.equal(child.exitCode, null, "Owned browser must remain alive until cleanup");
    try { port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0]!; } catch {}
    if (/^\d+$/.test(port)) break; await wait(40);
  }
  assert.match(port, /^\d+$/);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10000) })).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const target = targets.find((value) => value.type === "page"); assert.ok(target);
  const network: string[] = [], exceptions: unknown[] = [];
  cdp = await connect(target.webSocketDebuggerUrl, (method, params) => {
    if (method === "Network.requestWillBeSent") network.push(params.request.url);
    if (method === "Runtime.exceptionThrown") exceptions.push(params.exceptionDetails);
  });
  await cdp.call("Network.enable"); await cdp.call("Runtime.enable");
  const evaluate = async <T,>(body: string): Promise<T> => {
    const result = await cdp!.call("Runtime.evaluate", { expression: `(async()=>{const f=window.__telegramReplay;${body}})()`, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const until = async (expression: string) => {
    for (let i = 0; i < 200; i++) { if (await evaluate<boolean>(`return !!(${expression});`)) return; await wait(15); }
    assert.fail(`Owned fixture did not settle: ${expression}; ${JSON.stringify(exceptions)}`);
  };
  await cdp.call("Page.navigate", { url: origin });
  await until("f && document.querySelectorAll('button').length");
  const state = () => evaluate<State>(`return {messages:f.messages,requests:f.requests,violations:f.violations,pending:f.pending,stage:f.stage,
 receipts:Object.keys(localStorage).filter(k=>k.startsWith('negis_telegram_delivery_v1::')).map(k=>JSON.parse(localStorage[k])),
 library:JSON.parse(localStorage.getItem('negis_content_studio_videos::aaaaaaaa-1111-4111-8111-111111111111')||'[]'),text:document.body.textContent};`);
  const control = async (action: string) => {
    const reply = await fetch(`${origin}/__fixture/telegram-delivery`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
    assert.equal(reply.status, 200); await reply.text();
  };
  const reset = async () => {
    await evaluate("f.unmount();"); await control("reset"); await evaluate("f.reset();");
    await until("localStorage.getItem('negis_content_studio_videos::aaaaaaaa-1111-4111-8111-111111111111')?.includes('a7000000')");
  };
  const click = (isTest: boolean) => evaluate(`const button=[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(isTest ? testLabel : sendLabel)});if(!button||button.disabled)throw Error('Telegram button unavailable');f.stage='idle';button.click();`);
  const done = () => until("f.stage==='done' && !f.pending && f.messages.length>0");
  const noFresh = (s: State) => {
    assert.ok(s.messages.every((item) => item.message !== freshSend && item.message !== freshTest), JSON.stringify(s.messages));
    assert.doesNotMatch(s.text, /\u041f\u0430\u043a\u0435\u0442 \u043e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d \u0432 Telegram|Telegram \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0451\u043d/);
    assert.deepEqual(s.violations, []);
  };

  for (const isTest of [false, true]) {
    await t.test(`${isTest ? "test" : "package"}: explicit replay is historical, not a fresh send/check`, async () => {
      await reset(); await click(isTest); await done(); const s = await state();
      assert.equal(s.requests.length, 1); noFresh(s); assert.match(s.messages.at(-1)!.message, historical); assert.match(s.messages.at(-1)!.message, noResend);
      assert.ok(s.text.includes(s.messages.at(-1)!.message), "Notice is also rendered by the actual page");
      assert.equal(store.snapshot().statusWrites, isTest ? 0 : 1);
      assert.deepEqual(s.receipts.map((item) => item.state), isTest ? [] : ["sent"]);
      if (isTest) { await click(true); await done(); const next = await state(); assert.notEqual(next.requests[0]!.testRequestId, next.requests[1]!.testRequestId); }
      else { await evaluate("f.remount();"); await click(false); await until("f.messages.length>1"); assert.equal((await state()).requests.length, 1, "Remount cannot resend a historically completed package"); }
    });
    await t.test(`${isTest ? "test" : "package"}: explicit false remains a fresh success`, async () => {
      await reset(); await evaluate("f.replay=false;"); await click(isTest); await done(); const s = await state();
      assert.deepEqual(s.messages, [{ kind: "success", message: isTest ? freshTest : freshSend }]);
      assert.equal(s.requests.length, 1); assert.equal(store.snapshot().statusWrites, isTest ? 0 : 1);
    });
    await t.test(`${isTest ? "test" : "package"}: absent legacy flag is accepted without claiming freshness`, async () => {
      await reset(); await evaluate("f.replay='absent';f.nonce='absent';"); await click(isTest); await done(); const s = await state();
      noFresh(s); assert.match(s.messages.at(-1)!.message, unconfirmedNew);
      assert.equal(store.snapshot().statusWrites, isTest ? 0 : 1);
    });
  }
  for (const isTest of [false, true]) for (const flag of ["true", "false", null, 1, {}, []]) {
    await t.test(`${isTest ? "test" : "package"}: malformed replay flag ${JSON.stringify(flag)} fails closed`, async () => {
      await reset(); await evaluate(`f.replay=${JSON.stringify(flag)};`); await click(isTest); await done(); const s = await state();
      noFresh(s); assert.equal(s.messages.at(-1)!.kind, "error"); assert.equal(store.snapshot().statusWrites, 0);
      assert.deepEqual(s.receipts.map((item) => item.state), isTest ? [] : ["uncertain"]);
      if (!isTest) { await evaluate("f.remount();"); await click(false); await until("f.messages.length>1"); assert.equal((await state()).requests.length, 1); }
    });
  }
  for (const replayed of [false, true]) for (const nonce of ["wrong", "absent"]) {
    await t.test(`test receipt replayed:${replayed} with ${nonce} intent nonce is unconfirmed`, async () => {
      await reset(); await evaluate(`f.replay=${replayed};f.nonce=${JSON.stringify(nonce)};`); await click(true); await done(); const s = await state();
      noFresh(s); assert.equal(s.messages.at(-1)!.kind, "error"); assert.equal(store.snapshot().statusWrites, 0); assert.deepEqual(s.receipts, []);
    });
  }
  for (const mode of ["partial", "unknown", "warning", "cas-conflict"]) {
    await t.test(`${mode}: no new-send claim, no retry, readiness only after CAS`, async () => {
      await reset();
      if (mode === "partial") await control("partial");
      if (mode === "unknown") await evaluate("f.unknown=true;");
      if (mode === "warning") await evaluate("f.warning=true;");
      if (mode === "cas-conflict") await evaluate("f.hold='body';");
      await click(false);
      if (mode === "cas-conflict") {
        await until("f.stage==='body'");
        // Competing valid CAS advances only the owned synthetic row version.
        const before = await state();
        const row = before.library[0]!;
        const response = await fetch(`${origin}/api/crm/content-videos?workspaceId=aaaaaaaa-1111-4111-8111-111111111111`, {
          method: "PATCH", headers: { "Content-Type": "application/json", Authorization: "Bearer fixture-ads-A" },
          body: JSON.stringify({ id: row.id, status: "telegram_ready", expectedUpdatedAt: row.updatedAt }),
        });
        assert.equal(response.status, 200); await response.text(); await evaluate("f.release();");
      }
      await done(); const s = await state(); noFresh(s);
      if (mode === "cas-conflict" || mode === "warning") assert.match(s.messages.at(-1)!.message, historical);
      assert.equal(store.snapshot().statusWrites, mode === "cas-conflict" ? 1 : 0, "Only the competing CAS may write on a conflict");
      assert.equal(s.library[0]!.status, "idea");
      assert.deepEqual(s.receipts.map((item) => item.state), [mode === "cas-conflict" ? "sent" : "uncertain"]);
      await evaluate("f.remount();"); await click(false); await until("f.messages.length>1"); assert.equal((await state()).requests.length, 1);
    });
  }
  for (const isTest of [false, true]) for (const phase of ["headers", "body"]) for (const action of ["manager", "actor", "aba", "unmount", "refresh"]) {
    await t.test(`${isTest ? "test" : "package"}: late ${phase} replay after ${action}, positive refresh control`, async () => {
      await reset(); await evaluate(`f.hold=${JSON.stringify(phase)};`); await click(isTest); await until(`f.stage===${JSON.stringify(phase)}`);
      // The other Telegram button stays clickable; the actual callback's pending fence must deny it.
      await click(!isTest); assert.equal((await state()).requests.length, 1);
      await evaluate(action === "unmount" ? "f.unmount();" : `f.change(${JSON.stringify(action)});`);
      const before = await state(); await evaluate("f.release();"); await until("f.stage==='done'");
      await evaluate("for(let i=0;i<10;i++)await new Promise(r=>setTimeout(r,0));"); const after = await state();
      assert.equal(after.requests.length, 1); noFresh(after);
      if (action === "refresh") { assert.match(after.messages.at(-1)!.message, historical); assert.equal(store.snapshot().statusWrites, isTest ? 0 : 1); }
      else { assert.deepEqual(after.messages, before.messages); assert.equal(store.snapshot().statusWrites, 0); assert.deepEqual(after.receipts.map((item) => item.state), isTest ? [] : ["uncertain"]); }
    });
  }
  assert.equal(store.snapshot().externalCalls, 0);
  assert.deepEqual(exceptions, []);
  assert.ok(network.every((url) => new URL(url).origin === origin), "Every browser request stays on the owned loopback origin");
});

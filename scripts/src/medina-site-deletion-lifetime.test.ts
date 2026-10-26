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

// Actual React/DOM/workflow, following the owned profile-session browser fixture.
// Only HTTP is fake. No app config, auth, database, customer browser or downloads.
// Green: node scripts/node_modules/tsx/dist/cli.mjs --test scripts/src/medina-site-deletion-lifetime.test.ts
// Red: node scripts/node_modules/tsx/dist/cli.mjs scripts/src/medina-site-deletion-lifetime.test.ts --baseline
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const frontend = path.join(root, "artifacts/negis");
const require = createRequire(path.join(frontend, "package.json"));
const esbuild = createRequire(require.resolve("vite/package.json"))("esbuild");
const baseline = process.argv.includes("--baseline");
const files = ["artifacts/negis/src/components/crm/site-inquiry-deletion.tsx", "artifacts/negis/src/lib/siteInquiryDeletion.ts"];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const entry = `
import React,{StrictMode} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {SiteInquiryDeletion} from './src/components/crm/site-inquiry-deletion';
import {createSiteInquiryDeletion} from './src/lib/siteInquiryDeletion';
const ids={wa:'00000000-0000-4000-8000-000000000001',la:'00000000-0000-4000-8000-000000000002',ra:'00000000-0000-4000-8000-000000000003',
 wb:'00000000-0000-4000-8000-000000000011',lb:'00000000-0000-4000-8000-000000000012',rb:'00000000-0000-4000-8000-000000000013'};
const version='2026-09-28T11:00:00.123456+00:00';
const preview=(lead=ids.la,count=1)=>({success:true,data:{leadId:lead,leadUpdatedAt:version,
 receiptIds:count===1?[ids.ra]:[ids.ra,ids.rb],receiptCount:count,reviewReasons:[],reviewRequired:false,
 confirmationRequired:true,deletionEnabled:true,deletionAvailability:'confirmation_required'}});
const success=(count=1)=>({success:true,data:{deleted:true,receiptsDeleted:count,replayed:false}});
let app,props,mounted=false,seq=0,transport=0;
const f={ids,preview,success,calls:[],preparations:[],notices:[],evidence:[],captured:[],flows:[],
 request(){const generation=++transport;return(path,init={})=>new Promise((resolve,reject)=>{
  if(init.dispatchGuard&&!init.dispatchGuard()){reject(new DOMException('Retired','AbortError'));return;}
  if(path.startsWith('/api/crm/site-inquiry-deletion-operations?')){
   const body=JSON.parse(init.body);if(body.action!=='prepare')throw Error('Unexpected preparation');f.preparations.push({path,body});
   resolve(Response.json({success:true,data:{operation:{workspaceId:new URL(path,'http://fixture.invalid').searchParams.get('workspaceId'),
    actorId:ids.ra,requestKey:body.request.requestKey,leadId:body.request.leadId,request:body.request,state:'prepared',createdAt:version,
    completedAt:null,acknowledgedAt:null,receiptsDeleted:null,replayed:false}}}));return;}
  if(!/^\\/api\\/crm\\/site-inquiry-deletion(?:-preview)?\\?/.test(path))throw Error('Unrelated fake HTTP');
  f.calls.push({id:++seq,generation,path,init,resolve,reject,settled:false});});},
 lifetime(){let current=true;const listeners=new Set();const owner={isCurrent:()=>current,
  subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},listenerCount:()=>listeners.size,
  retire(){current=false;for(const fn of [...listeners])fn();}};
  return owner;},
 render(){const{key,...rest}=props;flushSync(()=>app.render(<StrictMode><SiteInquiryDeletion key={key} {...rest}/></StrictMode>));},
 mount(){f.calls=[];f.preparations=[];f.notices=[];f.evidence=[];f.captured=[];f.flows=[];seq=0;
  props={key:'A',workspaceId:ids.wa,leadId:ids.la,request:f.request(),lifetime:f.lifetime(),
   onDeleted:()=>f.notices.push('A'),onReconciliationRequired:e=>f.evidence.push(e)};
  f.originalRequest=props.request;
  app=createRoot(document.getElementById('root'));mounted=true;f.render();},
 unmount(){if(mounted){flushSync(()=>app.unmount());mounted=false;}},
 retireActor(){props.lifetime.retire();},
 patch(value){props={...props,...value};f.render();},
 change(kind,back=false){const b=back?'a':'b';
  if(kind==='lead')f.patch({leadId:ids['l'+b],onDeleted:()=>f.notices.push(back?'A2':'B')});
  if(kind==='workspace')f.patch({workspaceId:ids['w'+b],onDeleted:()=>f.notices.push(back?'A2':'B')});
  if(kind==='request')f.patch({request:back?f.originalRequest:f.request(),onDeleted:()=>f.notices.push(back?'A2':'B')});
  if(kind==='actor'){props.lifetime.retire();f.patch({lifetime:f.lifetime(),onDeleted:()=>f.notices.push(back?'A2':'B')});}
  if(kind==='actor-key')f.patch({key:back?'A':'B',onDeleted:()=>f.notices.push(back?'A2':'B')});
 },
 reply(id,body,status=200){const c=f.calls.find(c=>c.id===id);if(!c||c.settled)throw Error('Bad fake reply');
  c.settled=true;c.resolve(Response.json(body,{status}));},
 hold(id,body,status=200){const c=f.calls.find(c=>c.id===id);let controller;
  const stream=new ReadableStream({start(c){controller=c;}});c.settled=true;c.response=new Response(stream,{status,headers:{'content-type':'application/json'}});c.resolve(c.response);
  f.release=()=>{controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));controller.close();};},
 ready(){for(const c of f.calls.filter(c=>!c.settled&&!c.held&&c.init.method!=='POST')){
  f.reply(c.id,preview(new URL(c.path,'http://fixture.invalid').searchParams.get('leadId')));}},
 button(kind){const buttons=[...document.querySelectorAll('button')];const b=buttons.find(b=>kind==='open'?b.hasAttribute('aria-expanded'):
  kind==='submit'?b.textContent.includes('Удалить заявку и'):kind==='retry'?b.textContent.includes('Повторить запрос'):b.textContent.includes('Проверить состав заново'));
  if(!b)throw Error('Missing '+kind);return b;},
 click(kind){f.button(kind).click();},confirm(){const c=document.querySelector('input[type=checkbox]');if(!c)throw Error('Missing confirmation');c.click();},
 capture(kind){const b=kind==='confirm'?document.querySelector('input[type=checkbox]'):f.button(kind);
  const key=Object.keys(b).find(k=>k.startsWith('__reactProps$'));const handler=b[key][kind==='confirm'?'onChange':'onClick'];
  f.captured.push(()=>handler({target:{checked:true},preventDefault(){}}));},
 invoke(){for(const fn of f.captured)fn();},
 snapshot(){return{calls:f.calls.map(({id,generation,path,init,settled})=>({id,generation,path,body:init.body,method:init.method||'GET',settled})),
  text:document.getElementById('root').textContent,notices:f.notices,evidence:f.evidence,
  checkbox:!!document.querySelector('input[type=checkbox]'),checked:document.querySelector('input[type=checkbox]')?.checked,
  open:document.querySelector('[aria-expanded]')?.getAttribute('aria-expanded'),html:document.getElementById('root').innerHTML};},
 workflow(options={}){const flow=createSiteInquiryDeletion(ids.wa,ids.la,f.request(),()=> '00000000-0000-4000-8000-000000000004',options.lifetime);
  f.flows.push(flow);return flow;}
};
// Storage and external network are forbidden, including accidental real configuration.
for(const name of ['getItem','setItem','removeItem','clear'])Storage.prototype[name]=()=>{throw Error('Fixture forbids persistence');};
globalThis.fetch=()=>{throw Error('Fixture forbids real HTTP');};
f.mount();window.__deletionFixture=f;
`;

type Snapshot = { calls: Array<{ id: number; generation: number; path: string; body?: string; method: string; settled: boolean }>;
  text: string; notices: string[]; evidence: Array<{ workspaceId: string; leadId: string; body: string }>;
  checkbox: boolean; checked?: boolean; open?: string; html: string };

test("owned Chromium: deletion lifetime boundaries with real React and deferred fake HTTP", { timeout: 180_000 }, async t => {
  t.after(() => esbuild.stop());
  const browserPath = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(existsSync);
  assert.ok(browserPath, "Installed Chromium required; no installation fallback");
  const code = await esbuild.build({ stdin: { contents: entry, sourcefile: "site-deletion-owned.tsx", resolveDir: frontend, loader: "tsx" },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: baseline ? [{ name: "baseline-owned-sources", setup(build: any) {
      build.onLoad({ filter: /(?:site-inquiry-deletion\.tsx|siteInquiryDeletion\.ts)$/ }, (args: { path: string }) => {
        const file = path.relative(root, args.path).replaceAll("\\", "/"); assert.ok(files.includes(file));
        return { contents: execFileSync("git", ["show", `37e1d3e:${file}`], { cwd: root, encoding: "utf8" }), loader: file.endsWith("tsx") ? "tsx" : "ts" };
      });
    } }] : [],
  });
  const server = createServer((req, res) => {
    if (req.headers.host !== `127.0.0.1:${(server.address() as any).port}` || req.method !== "GET" || !["/", "/bundle.js", "/favicon.ico"].includes(req.url ?? "")) {
      res.writeHead(403); res.end(); return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; form-action 'none'; frame-src 'none'");
    if (req.url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    if (req.url === "/bundle.js") { res.setHeader("Content-Type", "application/javascript"); res.end(code.outputFiles[0].text); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>(resolve => {
    server.close(() => resolve());
    // Chromium may leave a preconnected socket with no request to finish.
    server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const profile = await mkdtemp(path.join(tmpdir(), "medina-site-deletion-owned-"));
  const child = spawn(browserPath, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--disable-sync",
    "--disable-component-update", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
  { windowsHide: true, stdio: "ignore", env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "HOME", "DISPLAY"].includes(key))) });
  const exited = new Promise(resolve => { child.once("exit", resolve); child.once("error", resolve); });
  let socket: WebSocket | undefined;
  let cdp: ((method: string, params?: Record<string, unknown>) => Promise<any>) | undefined;
  t.after(async () => {
    await cdp?.("Browser.close").catch(() => {});
    await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, delay(5000)]); }
    socket?.close();
    assert.equal(path.dirname(profile), path.resolve(tmpdir())); assert.ok(path.basename(profile).startsWith("medina-site-deletion-owned-"));
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
  const evaluate = async (body: string): Promise<any> => {
    const result = await cdp!("Runtime.evaluate", { expression: `(async()=>{const f=window.__deletionFixture;${body}})()`, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  await cdp("Network.enable"); await cdp("Runtime.enable"); await cdp("Page.navigate", { url: origin });
  let ready = false;
  for (let i = 0; i < 150; i++) { ready = await evaluate("return !!f;"); if (ready) break; await delay(20); }
  assert.ok(ready, JSON.stringify(exceptions));
  const settle = () => evaluate("for(let i=0;i<8;i++)await new Promise(resolve=>setTimeout(resolve,0));");
  const state = (): Promise<Snapshot> => evaluate("return f.snapshot();");
  const reset = async () => { await evaluate("f.unmount();f.mount();"); await settle(); };
  const inspected = async () => { await evaluate("f.ready();"); await settle(); };
  const review = async () => { await inspected(); await evaluate("if(f.snapshot().open!=='true')f.click('open');else f.click('refresh');"); await settle(); await inspected(); };
  const submit = async () => { await evaluate("f.confirm();"); await settle(); await evaluate("f.click('submit');"); await settle();
    const call = (await state()).calls.filter(c => c.method === "POST").at(-1); assert.ok(call); return call; };

  await t.test("positive current receipt removes exactly once, and a new card can also complete", async () => {
    await reset(); await review(); const post = await submit();
    assert.deepEqual(JSON.parse(post.body!), { leadId: "00000000-0000-4000-8000-000000000002", leadUpdatedAt: "2026-09-28T11:00:00.123456+00:00",
      receiptIds: ["00000000-0000-4000-8000-000000000003"], requestKey: JSON.parse(post.body!).requestKey, confirmed: true });
    assert.match(JSON.parse(post.body!).requestKey, /^[\da-f-]{36}$/);
    assert.deepEqual((await state()).notices, []);
    await evaluate(`f.reply(${post.id},f.success());`); await settle(); assert.deepEqual((await state()).notices, ["A"]);
    await evaluate("f.change('lead');"); await settle(); await review(); const next = await submit();
    await evaluate(`f.reply(${next.id},f.success());`); await settle(); assert.deepEqual((await state()).notices, ["A", "B"]);
  });

  const boundaries = ["lead", "workspace", "request", "actor", "actor-key", "unmount"];
  for (const boundary of boundaries) {
    await t.test(`${boundary}: captured review handler cannot dispatch after its owner retires`, async () => {
      await reset(); await review(); await evaluate("f.confirm();"); await settle();
      await evaluate("f.capture('submit');f.capture('confirm');f.capture('open');f.capture('refresh');");
      await evaluate(boundary === "unmount" ? "f.unmount();" : `f.change('${boundary}');f.change('${boundary}',true);`);
      await settle(); const before = await state(); await evaluate("f.invoke();"); await settle(); const after = await state();
      assert.equal(after.calls.length, before.calls.length, "Retired handlers must not dispatch, including A/B/A");
      assert.equal(after.html, before.html, "Retired events cannot edit the current card"); assert.deepEqual(after.notices, []);
    });
  }

  for (const operation of ["inspect", "submit"]) for (const point of ["headers", "body", "rejection"]) for (const boundary of boundaries) {
    await t.test(`late ${operation} ${point} across ${boundary} A/B/A cannot expose scope, publish success or retry`, async () => {
      await reset();
      let call: Snapshot["calls"][number];
      if (operation === "submit") { await review(); call = await submit(); }
      else { call = (await state()).calls.at(-1)!; assert.ok(call); }
      await evaluate(`f.calls.find(c=>c.id===${call.id}).held=true;`);
      if (point === "body") {
        await evaluate(`f.hold(${call.id},${operation === "submit" ? "f.success()" : "f.preview(f.ids.la,2)"});`); await settle();
        assert.equal(await evaluate(`return f.calls.find(c=>c.id===${call.id}).response.bodyUsed;`), true, "Body decoding started before invalidation");
      }
      await evaluate(boundary === "unmount" ? "f.unmount();" : `f.change('${boundary}');f.change('${boundary}',true);`);
      await settle();
      if (boundary !== "unmount") await review();
      const before = await state();
      if (operation === "submit") {
        assert.deepEqual(before.evidence, [{ workspaceId: "00000000-0000-4000-8000-000000000001", leadId: "00000000-0000-4000-8000-000000000002", body: call.body }],
          "Retiring an issued mutation hands its exact original evidence to its owner");
      } else assert.deepEqual(before.evidence, []);
      await evaluate(point === "body" ? "f.release();" : point === "rejection"
        ? `f.calls.find(c=>c.id===${call.id}).reject(Error('synthetic private late failure'));`
        : `f.reply(${call.id},${operation === "submit" ? "f.success()" : "f.preview(f.ids.la,2)"});`);
      await settle(); const after = await state();
      assert.equal(after.html, before.html); assert.equal(after.calls.length, before.calls.length);
      assert.deepEqual(after.notices, []); assert.deepEqual(after.evidence, before.evidence);
      assert.doesNotMatch(after.text, /synthetic private late failure/);
    });
  }

  await t.test("actor retirement without a render immediately hides the old scope and rejects its captured retry", async () => {
    await reset(); await review(); const post = await submit();
    await evaluate(`f.calls.find(c=>c.id===${post.id}).reject(Error('synthetic response lost'));`); await settle();
    assert.match((await state()).text, /Результат удаления не подтверждён/);
    await evaluate("f.capture('retry');f.patch({});"); await settle();
    const before = (await state()).calls.length;
    await evaluate("f.retireActor();"); await settle(); await evaluate("f.invoke();"); await settle();
    const after = await state(); assert.equal(after.calls.filter(c => c.method === "POST").length, 1);
    assert.equal(after.calls.length, before);
    assert.equal(after.text, ""); assert.deepEqual(after.notices, []);
    await evaluate("f.unmount();"); assert.equal((await state()).evidence[0].body, post.body);
  });

  await t.test("an unrelated callback rerender cannot redirect an already-issued receipt to another owner", async () => {
    await reset(); await review(); const post = await submit();
    await evaluate("f.patch({onDeleted:()=>f.notices.push('wrong callback owner')});");
    await evaluate(`f.reply(${post.id},f.success());`); await settle(); assert.deepEqual((await state()).notices, ["A"]);
  });

  await t.test("existing parent without the optional hooks still fences a late response after keyed unmount", async () => {
    await reset(); await evaluate("f.patch({lifetime:undefined,onReconciliationRequired:undefined});"); await settle();
    await review(); const post = await submit();
    await evaluate("f.change('actor-key');"); await settle(); await review();
    const before = await state(); await evaluate(`f.reply(${post.id},f.success());`); await settle();
    const after = await state(); assert.equal(after.html, before.html); assert.deepEqual(after.notices, []);
    assert.equal(after.calls.length, before.calls.length);
  });

  await t.test("lost response permits same-key retry; later auth failure hides controls but preserves original-owner evidence", async () => {
    await reset(); await review(); const first = await submit();
    await evaluate(`f.calls.find(c=>c.id===${first.id}).reject(Error('synthetic lost response'));`); await settle();
    const before = (await state()).calls.length;
    await evaluate("f.patch({});f.ready();"); await settle(); assert.equal((await state()).calls.length, before);
    await evaluate("f.capture('retry');f.click('retry');"); await settle(); let retry = (await state()).calls.at(-1)!;
    assert.equal(retry.body, first.body); assert.equal(retry.path, first.path);
    await evaluate(`f.reply(${retry.id},{success:false,private:'must not appear'},401);`); await settle();
    assert.equal((await state()).text, ""); assert.equal((await state()).checkbox, false);
    const calls = (await state()).calls.length; await evaluate("f.invoke();"); await settle(); assert.equal((await state()).calls.length, calls);
    assert.deepEqual((await state()).notices, []); await evaluate("f.unmount();");
    assert.deepEqual((await state()).evidence, [{ workspaceId: "00000000-0000-4000-8000-000000000001", leadId: "00000000-0000-4000-8000-000000000002", body: first.body }]);
  });

  for (const result of ["wrong-count", "missing-replayed", "conflict"]) {
    await t.test(`current ${result} receipt does not report deletion or bypass renewed confirmation`, async () => {
      await reset(); await review(); const post = await submit();
      const body = result === "conflict" ? "{success:false,code:'deletion_scope_changed'}" : result === "wrong-count"
        ? "{success:true,data:{deleted:true,receiptsDeleted:2,replayed:false}}" : "{success:true,data:{deleted:true,receiptsDeleted:1}}";
      await evaluate(`f.reply(${post.id},${body},${result === "conflict" ? 409 : 200});`); await settle();
      assert.deepEqual((await state()).notices, []);
      if (result === "conflict") {
        assert.equal((await state()).checkbox, false); await evaluate("f.click('refresh');"); await settle(); await inspected();
        assert.equal((await state()).checked, false); const before = (await state()).calls.length;
        await evaluate("f.click('submit');"); await settle(); assert.equal((await state()).calls.length, before);
      } else assert.match((await state()).text, /Результат удаления не подтверждён/);
    });
  }

  for (const outcome of ["success", "conflict", "malformed", "rejection"]) {
    await t.test(`disposed workflow retains unresolved evidence and suppresses late ${outcome} even without React`, async () => {
      await reset(); await evaluate("f.flow=f.workflow();f.inspecting=f.flow.inspect();f.writes=0;f.flow.subscribe(()=>f.writes++);");
      await inspected(); await evaluate("await f.inspecting;f.flow.confirm(true);f.submitting=f.flow.submit();"); await settle();
      const post = (await state()).calls.at(-1)!;
      assert.equal(post.method, "POST");
      await evaluate("f.retained=f.flow.dispose();f.snapshotAfterDispose=JSON.stringify(f.flow.getSnapshot());f.writesAfterDispose=f.writes;");
      assert.deepEqual(await evaluate("return f.retained;"), { workspaceId: "00000000-0000-4000-8000-000000000001", leadId: "00000000-0000-4000-8000-000000000002", body: post.body });
      await evaluate(outcome === "rejection" ? `f.calls.find(c=>c.id===${post.id}).reject(Error('late private exception'));`
        : `f.reply(${post.id},${outcome === "success" ? "f.success()" : outcome === "conflict" ? "{code:'deletion_scope_changed'}" : "{}"},${outcome === "conflict" ? 409 : 200});`);
      await evaluate("await f.submitting;await f.flow.inspect();f.flow.confirm(true);await f.flow.submit();"); await settle();
      const after = await evaluate("return{snapshot:f.flow.getSnapshot(),sameSnapshot:JSON.stringify(f.flow.getSnapshot())===f.snapshotAfterDispose,writes:f.writes-f.writesAfterDispose,evidence:f.flow.getReconciliation(),again:f.flow.dispose()};");
      assert.equal(after.sameSnapshot, true); assert.equal(after.writes, 0);
      assert.equal(after.snapshot.visible, false); assert.equal(after.snapshot.scope, null); assert.equal(after.snapshot.confirmed, false);
      assert.equal(after.evidence.body, post.body); assert.deepEqual(after.again, after.evidence);
      assert.equal((await state()).calls.filter(c => c.method === "POST").length, 1, "No undo, cancellation proof or automatic retry is asserted");
    });
  }

  await t.test("source subscription is released on retirement, including synchronous initial retirement", async () => {
    await reset(); const before = (await state()).calls.length;
    const synchronous = await evaluate(`f.subscriptions=0;
      f.flow=f.workflow({lifetime:{isCurrent:()=>false,subscribe(fn){f.subscriptions++;fn();return()=>{f.subscriptions--;};}}});
      f.probing=f.flow.inspect();f.flow.confirm(true);f.submitting=f.flow.submit();
      return{count:f.subscriptions,snapshot:f.flow.getSnapshot()};`);
    assert.equal(synchronous.count, 0); assert.equal(synchronous.snapshot.visible, false); assert.equal((await state()).calls.length, before);
    const retired = await evaluate(`f.source=f.lifetime();f.flow=f.workflow({lifetime:f.source});
      const during=f.source.listenerCount();f.source.retire();
      return{during,after:f.source.listenerCount(),active:f.flow.isCurrent(),evidence:f.flow.getReconciliation()};`);
    assert.deepEqual(retired, { during: 1, after: 0, active: false, evidence: null });
  });
  assert.deepEqual(exceptions, []);
  assert.deepEqual(consoleErrors, [], "No React lifecycle/update warnings");
  assert.ok(requests.every(url => url.startsWith(origin + "/")), "Owned browser only visits its loopback bundle");
});

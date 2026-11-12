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

// Actual React, MobileNav, DOM, inert, native keyboard navigation and scroll.
// Only auth/router/ProfileDialog are local fakes. No customer browser/profile,
// network credentials, external URL, installed package or running CRM is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const frontend = path.join(root, "artifacts/negis");
const frontendRequire = createRequire(path.join(frontend, "package.json"));
const viteRequire = createRequire(frontendRequire.resolve("vite/package.json"));
const esbuild = viteRequire("esbuild") as { build(options: Record<string, unknown>): Promise<{ outputFiles: Array<{ text: string }> }>; stop(): void };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const mocks = `
import {useSyncExternalStore} from 'react';
import {flushSync} from 'react-dom';
import {createPortal} from 'react-dom';
const initial=()=>({user:{id:'synthetic-A'},clinicId:'synthetic-workspace',userRole:'owner',
 rolePermissions:{},vertical:'clinic',workspacePurpose:'clinic_services',isSigningOut:false,isImpersonation:false});
let current=initial();const listeners=new Set(),sdk=new Set();
export const fixture={
 patch(value){flushSync(()=>{current={...current,...value};for(const fn of listeners)fn();});},
 reset(){this.patch(initial());},
 refresh(){for(const fn of sdk)fn('TOKEN_REFRESHED',{user:{id:current.user.id}});},
 aba(){let released;flushSync(()=>{for(const fn of sdk)fn('SIGNED_IN',{user:{id:'synthetic-B'}});
 released=document.body.style.position!=='fixed';for(const fn of sdk)fn('SIGNED_IN',{user:{id:'synthetic-A'}});});return released;},
 signouts:0,navigations:[]};
export function useAuth(){return {...useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn);},()=>current),
 signOut:async()=>{fixture.signouts++;fixture.patch({isSigningOut:true});}};}
export const hasSupabaseFrontendEnv=true;
export const supabase={auth:{onAuthStateChange(fn){sdk.add(fn);return{data:{subscription:{unsubscribe(){sdk.delete(fn);}}}};}}};
export const sessionAuth={onAuthStateChange:supabase.auth.onAuthStateChange};
export function useLocation(){return['/leads',href=>fixture.navigations.push(href)];}
export function ProfileDialog({onClose}){return createPortal(<section id="profile-fixture" role="dialog"><button onClick={onClose}>Close profile</button></section>,document.body);}
`;
const entry = `
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {MobileNav} from ${JSON.stringify(path.join(frontend, "src/components/layout/MobileNav.tsx").replaceAll("\\", "/"))};
import {fixture} from 'mobile-nav-fake';
let app;fixture.mount=()=>{app=createRoot(document.getElementById('root'));flushSync(()=>app.render(<><button id="background">Background</button><MobileNav/></>));};
fixture.unmount=()=>flushSync(()=>app.unmount());fixture.mount();window.__mobileFixture=fixture;
`;

async function bundle() {
  const result = await esbuild.build({ stdin: { contents: entry, resolveDir: frontend, sourcefile: "mobile-nav-fixture.tsx", loader: "tsx" },
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "isolated-mobile-nav", setup(build: any) {
      build.onResolve({ filter: /^(mobile-nav-fake|@\/contexts\/AuthContext|@\/lib\/supabase|wouter|\.\/ProfileDialog)$/ }, () => ({ path: "mocks", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: mocks, loader: "tsx", resolveDir: frontend }));
      build.onResolve({ filter: /^@\// }, (args: { path: string }) => ({ path: path.join(frontend, "src", args.path.slice(2) + ".ts") }));
    } }],
  });
  return result.outputFiles[0].text;
}

type Cdp = { call(method: string, params?: Record<string, unknown>): Promise<any>; close(): void };
async function connect(url: string, onEvent: (method: string, params: any) => void): Promise<Cdp> {
  const ws = new WebSocket(url), pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let id = 0;
  ws.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (!message.id) { onEvent(message.method, message.params); return; }
    const item = pending.get(message.id); if (!item) return;
    clearTimeout(item.timer); pending.delete(message.id);
    if (message.error) item.reject(Error(JSON.stringify(message.error))); else item.resolve(message.result);
  });
  ws.addEventListener("close", () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error("Owned browser closed")); }
    pending.clear();
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(Error("Owned browser connection timed out")); }, 10_000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(Error("Owned browser connection failed")); }, { once: true });
  });
  return { call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(Error(`CDP timeout: ${method}`)); }, 10_000);
      pending.set(next, { resolve, reject, timer }); ws.send(JSON.stringify({ id: next, method, params }));
    });
  }, close() { ws.close(); } };
}

test("actual MobileNav owns modal background, scrolling and focus only for its live drawer", { timeout: 120_000 }, async t => {
  t.after(() => esbuild.stop());
  const browserPath = [process.env.MEDINA_TEST_BROWSER_PATH,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(value => value && existsSync(value));
  assert.ok(browserPath, "A local Chromium executable is required for real DOM modality acceptance; no download/install fallback");
  const script = await bundle();
  const stylesheet = await readFile(path.join(frontend, "src/index.css"), "utf8");
  const drawerCss = ["mobile-nav-backdrop", "mobile-nav-sheet"].map(name => {
    const rule = stylesheet.match(new RegExp(`\\.${name}\\s*\\{[^}]+\\}`)); assert.ok(rule); return rule[0];
  }).join("\n");
  const server = createServer((req, res) => {
    if (req.headers.host !== `127.0.0.1:${(server.address() as { port: number }).port}`) { res.writeHead(403); res.end(); return; }
    if (req.method !== "GET" || !["/", "/bundle.js", "/favicon.ico"].includes(req.url ?? "")) { res.writeHead(403); res.end(); return; }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; frame-src 'none'; form-action 'none'");
    if (req.url === "/bundle.js") { res.setHeader("Content-Type", "application/javascript"); res.end(script); return; }
    if (req.url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      html{overflow:auto!important;scroll-behavior:auto}body{margin:0;min-height:2400px;overflow:auto;position:relative}
      button{min-height:44px} .mobile-bottom-nav{position:fixed;bottom:0;display:flex;width:100%;background:white}
      ${drawerCss} .mobile-nav-sheet{box-sizing:border-box} @media(min-width:1024px){.lg\\:hidden{display:none}}
      </style></head><body><aside id="preserved" inert="prior-owner" aria-hidden="false">Preserved background</aside>
      <div id="root"></div><div id="plain" aria-hidden="false">Plain background</div><script src="/bundle.js"></script></body></html>`);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const profile = await mkdtemp(path.join(tmpdir(), "medina-mobile-nav-owned-"));
  const child = spawn(browserPath, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions",
    "--disable-sync", "--disable-component-update", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
  { windowsHide: true, stdio: "ignore", env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "HOME", "DISPLAY"].includes(key))) });
  let cdp: Cdp | undefined;
  const exited = new Promise<void>(resolve => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
  t.after(async () => {
    if (cdp) await cdp.call("Browser.close").catch(() => {});
    await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, delay(5000)]); }
    cdp?.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(profile), path.resolve(tmpdir()), "Only the exact owned temporary browser profile can be removed");
    assert.ok(path.basename(profile).startsWith("medina-mobile-nav-owned-"));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  let port = "";
  for (let index = 0; index < 250; index++) {
    assert.equal(child.exitCode, null, "Owned headless browser must stay live until cleanup");
    try { port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0]; } catch {}
    if (/^\d+$/.test(port)) break; await delay(80);
  }
  assert.match(port, /^\d+$/, "Owned local browser must publish a debugging port");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const page = targets.find(value => value.type === "page"); assert.ok(page);
  const requests: string[] = [], exceptions: unknown[] = [];
  cdp = await connect(page.webSocketDebuggerUrl, (method, params) => {
    if (method === "Network.requestWillBeSent") requests.push(params.request.url);
    if (method === "Runtime.exceptionThrown") exceptions.push(params.exceptionDetails);
  });
  await cdp.call("Network.enable"); await cdp.call("Runtime.enable");
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const evaluate = async <T = unknown>(body: string): Promise<T> => {
    const result = await cdp!.call("Runtime.evaluate", { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  await cdp.call("Page.navigate", { url: origin });
  let ready = false;
  for (let i = 0; i < 150; i++) { ready = await evaluate<boolean>("return !!window.__mobileFixture"); if (ready) break; await delay(40); }
  assert.equal(ready, true, JSON.stringify(exceptions));
  const open = async () => {
    await evaluate(`const trigger=document.querySelector('[aria-label="Ещё разделы"]');trigger.focus({preventScroll:true});trigger.click();`);
    assert.equal(await evaluate("return !!document.querySelector('.mobile-nav-sheet')"), true);
  };
  const closed = async () => {
    assert.deepEqual(await evaluate(`return {dialog:!!document.querySelector('.mobile-nav-sheet'),root:document.getElementById('root').hasAttribute('inert'),
      plain:document.getElementById('plain').getAttribute('aria-hidden'),preserved:document.getElementById('preserved').getAttribute('inert'),
      hidden:document.getElementById('preserved').getAttribute('aria-hidden'),position:document.body.style.position,overflow:document.body.style.overflow,
      htmlOverflow:document.documentElement.style.overflow};`),
    { dialog: false, root: false, plain: "false", preserved: "prior-owner", hidden: "false", position: "", overflow: "", htmlOverflow: "" });
  };

  await t.test("body portal is not inert while all outside roots are inert and inaccessible to focus", async () => {
    await open();
    assert.deepEqual(await evaluate(`const panel=document.querySelector('.mobile-nav-sheet');document.getElementById('background').focus();
      return {modal:panel.getAttribute('aria-modal'),root:document.getElementById('root').inert,
       hidden:document.getElementById('root').getAttribute('aria-hidden'),inside:panel.contains(document.activeElement),
       portalParent:panel.parentElement.parentElement===document.body,portalInert:!!panel.closest('[inert]'),
       body:document.body.style.position,overflow:document.documentElement.style.overflow};`),
    { modal: "true", root: true, hidden: "true", inside: true, portalParent: true, portalInert: false, body: "fixed", overflow: "hidden" });
  });
  await t.test("new outside portal is isolated and programmatic focus cannot escape", async () => {
    assert.deepEqual(await evaluate(`const node=document.createElement('div');node.id='late';node.innerHTML='<button id="late-button">Late portal</button>';
      document.body.append(node);await new Promise(resolve=>setTimeout(resolve,0));document.getElementById('late-button').focus();
      return {inert:node.inert,hidden:node.getAttribute('aria-hidden'),inside:document.querySelector('.mobile-nav-sheet').contains(document.activeElement)};`),
    { inert: true, hidden: "true", inside: true });
  });
  await t.test("native Tab and Shift-Tab wrap and Escape releases locks before restoring the trigger", async () => {
    await evaluate(`document.querySelectorAll('.mobile-nav-sheet button')[document.querySelectorAll('.mobile-nav-sheet button').length-1].focus();`);
    await cdp!.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await cdp!.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    assert.equal(await evaluate("return document.activeElement===document.querySelector('.mobile-nav-sheet button')"), true);
    await cdp!.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 8 });
    await cdp!.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 8 });
    assert.equal(await evaluate("return document.activeElement===Array.from(document.querySelectorAll('.mobile-nav-sheet button')).at(-1)"), true);
    await cdp!.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await closed();
    assert.equal(await evaluate(`return document.activeElement===document.querySelector('[aria-label="Ещё разделы"]')`), true);
    assert.equal(await evaluate("return document.getElementById('late').hasAttribute('inert')"), false);
    await evaluate("document.getElementById('late').remove()");
  });
  await t.test("fixed-body scroll lock preserves the original viewport after dismissal", async () => {
    await evaluate("window.scrollTo(0,500)"); const start = await evaluate<number>("return window.scrollY"); assert.ok(start > 0);
    await open(); assert.equal(await evaluate("return document.body.style.top"), `-${start}px`);
    await cdp!.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: 5, y: 5, deltaX: 0, deltaY: 300 }); await delay(100);
    await evaluate(`document.querySelector('[aria-label="Закрыть меню"]').click()`); await closed();
    assert.equal(await evaluate("return window.scrollY"), start);
    await evaluate("window.scrollTo(0,0)");
  });
  await t.test("same-account refresh keeps the modal usable without disturbing focus", async () => {
    await open(); const focused = await evaluate("return document.activeElement.getAttribute('aria-label')");
    await evaluate("window.__mobileFixture.refresh()");
    assert.equal(await evaluate("return document.activeElement.getAttribute('aria-label')"), focused);
    assert.equal(await evaluate("return document.getElementById('root').inert"), true);
    await evaluate(`document.querySelector('[aria-label="Закрыть меню"]').click()`); await closed();
  });
  for (const [label, patch] of [["role withdrawal", { userRole: "doctor", rolePermissions: { booking: true } }],
    ["account", { user: { id: "synthetic-B" } }], ["workspace", { clinicId: "synthetic-other" }],
    ["sign-out", { isSigningOut: true }]] as const) {
    await t.test(`${label} closes the drawer and releases only its owned state`, async () => {
      await evaluate("window.__mobileFixture.reset()"); await open();
      await evaluate(`window.__mobileFixture.patch(${JSON.stringify(patch)})`); await closed();
      await evaluate("window.__mobileFixture.reset()");
    });
  }
  await t.test("unrendered SDK A/B/A releases the old modal immediately and cannot revive it", async () => {
    await open(); assert.equal(await evaluate("return window.__mobileFixture.aba()"), true); await closed();
    await open(); await evaluate(`document.querySelector('[aria-label="Закрыть меню"]').click()`); await closed();
  });
  await t.test("profile handoff releases the navigation locks without making its own portal inert", async () => {
    await open(); await evaluate(`Array.from(document.querySelectorAll('.mobile-nav-sheet button')).find(button=>button.textContent.includes('Профиль и пароль')).click()`);
    await closed(); assert.equal(await evaluate("return !!document.getElementById('profile-fixture') && !document.getElementById('profile-fixture').closest('[inert]')"), true);
    await evaluate("document.querySelector('#profile-fixture button').click()");
  });
  await t.test("desktop breakpoint closes a mobile-only modal instead of leaving invisible locks", async () => {
    await open(); await cdp!.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await delay(100); await closed();
    await cdp!.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await delay(50);
  });
  await t.test("cleanup does not overwrite a later external owner's attributes or styles", async () => {
    await open();
    await evaluate(`document.getElementById('plain').setAttribute('inert','later-owner');document.getElementById('plain').setAttribute('aria-hidden','false');
      document.body.style.setProperty('overflow','clip','important');document.querySelector('[aria-label="Закрыть меню"]').click()`);
    assert.deepEqual(await evaluate(`return {inert:document.getElementById('plain').getAttribute('inert'),hidden:document.getElementById('plain').getAttribute('aria-hidden'),
      overflow:document.body.style.overflow,priority:document.body.style.getPropertyPriority('overflow')};`),
    { inert: "later-owner", hidden: "false", overflow: "clip", priority: "important" });
    await evaluate("document.getElementById('plain').removeAttribute('inert');document.body.style.removeProperty('overflow')"); await closed();
  });
  await t.test("unmount restores the exact pre-existing inline values and priorities", async () => {
    await evaluate(`document.body.style.setProperty('position','relative','important');document.documentElement.style.setProperty('overflow','auto','important');`);
    await open(); await evaluate("window.__mobileFixture.unmount()");
    assert.deepEqual(await evaluate(`return {dialog:!!document.querySelector('.mobile-nav-sheet'),inert:document.getElementById('root').inert,
      position:document.body.style.position,priority:document.body.style.getPropertyPriority('position'),
      overflow:document.documentElement.style.overflow,overflowPriority:document.documentElement.style.getPropertyPriority('overflow')};`),
    { dialog: false, inert: false, position: "relative", priority: "important", overflow: "auto", overflowPriority: "important" });
  });
  assert.deepEqual(exceptions, [], "No browser runtime exceptions");
  assert.ok(requests.length >= 2);
  assert.deepEqual(requests.filter(url => !url.startsWith(`${origin}/`)), [], "The page only requested its owned loopback fixture");
});

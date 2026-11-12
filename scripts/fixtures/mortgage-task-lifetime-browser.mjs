import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Adapted from profile-session-browser.mjs: owned profile, memory-only bundle,
// loopback HTTP and synthetic Responses. Never boots the app or reads its env.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const frontend = path.join(root, 'artifacts/negis');
const require = createRequire(path.join(frontend, 'package.json'));
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const mocks = `
import React,{useSyncExternalStore} from 'react';import {flushSync} from 'react-dom';
const listeners=new Set(),sdk=new Set();
const initial=()=>({user:{id:'synthetic-A'},userRole:'owner',clinicId:'synthetic-workspace-A',workspacePurpose:'mortgage_leads',isLoading:false,isSigningOut:false,isDemoMode:false,isImpersonation:false});
let current=initial(),route='/tasks';
const stamp='2026-10-25T10:00:00.123456Z';
const contact=()=>({id:'synthetic-client',name:'Contact '+current.user.id,phone:'000-'+current.user.id,notes:'',status:'new',source:'manual',responsibleUserId:'synthetic-manager',responsibleName:'Synthetic manager',createdAt:stamp,updatedAt:stamp});
const task=()=>({id:'synthetic-task',kind:'task',leadId:'synthetic-client',title:'Task '+current.user.id,notes:'',status:'open',priority:'normal',startsAt:null,endsAt:null,dueAt:null,createdAt:stamp,updatedAt:stamp,contactName:contact().name,responsibleUserId:'synthetic-manager',responsibleName:'Synthetic manager'});
function snapshot(){return{timeZone:'Asia/Qyzylorda',contacts:[contact()],contactsTotal:1,activities:[task()],activitiesTruncated:false,members:[{id:'synthetic-manager',name:'Synthetic manager',role:'lead_manager',status:'active'}],events:[],metrics:{totalLeads:1,unassignedLeads:0,inProgressLeads:0,meetingsToday:0,overdueTasks:0,activeManagers:1},memberMetrics:[],periodDays:90,page:0,pageSize:100};}
const ok=()=>({success:true,mode:'supabase',data:snapshot()});
const props=node=>node?.[Object.keys(node).find(key=>key.startsWith('__reactProps'))];
export const fixture={calls:[],held:[],captured:{},holdReads:false,
 reset(){current=initial();route='/tasks';this.calls=[];this.held=[];this.captured={};this.holdReads=false;},
 patch(value){flushSync(()=>{current={...current,...value};for(const fn of listeners)fn();});},
 emit(actor){for(const fn of [...sdk])fn('TOKEN_REFRESHED',actor?{user:{id:actor}}:null);},
 aba(){flushSync(()=>{this.emit('synthetic-B');this.emit('synthetic-A');});},
 refresh(){flushSync(()=>this.emit(current.user.id));},
 route(value){flushSync(()=>{route=value;for(const fn of listeners)fn();});},
 fill(suffix,value){const node=document.querySelector('input[id$="-'+suffix+'"],textarea[id$="-'+suffix+'"]');if(!node)throw Error('Missing field '+suffix);
 Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));},
 button(label){const node=[...document.querySelectorAll('button')].find(n=>(n.getAttribute('aria-label')||n.textContent)===label);if(!node)throw Error('Missing button '+label);return node;},
 open(edit=false){this.button(edit?'Редактировать: Task '+current.user.id:'Новая задача').click();},
 select(){const node=[...document.querySelectorAll('button')].find(n=>n.textContent.includes('Contact '+current.user.id)&&n.textContent.includes('000-'));if(!node)throw Error('Missing contact');node.click();},
 capture(action,key=action){const node=action==='submit'?document.querySelector('form'):action==='status'?this.button('Выполнить: Task '+current.user.id):document.querySelector('input[id$="-title"]');
 const fn=props(node)?.[action==='submit'?'onSubmit':action==='status'?'onClick':'onChange'];if(!fn)throw Error('Missing handler '+action);this.captured[key]=fn;},
 invoke(key){return this.captured[key]({preventDefault(){},target:{value:'Stale title'}});},
 submit(){document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));},
 status(){this.button('Выполнить: Task '+current.user.id).click();},
 answer(index,{status=200,body,holdBody=false,lost=false}={}){const call=this.calls[index];if(!call||call.answered)throw Error('Missing pending call '+index);call.answered=true;
 if(lost){call.reject(new TypeError('Synthetic lost response'));return;}
 const value=body??(call.method==='GET'?ok():{success:true,mode:'supabase'});
 if(!holdBody){call.resolve(Response.json(value,{status}));return;}
 let controller;const stream=new ReadableStream({start(c){controller=c;}});const response=new Response(stream,{status,headers:{'content-type':'application/json'}});
 this.held.push({response,release(){controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));controller.close();}});call.resolve(response);},
 release(){for(const held of this.held.splice(0))held.release();},
 state(){return{text:document.body.textContent,alerts:[...document.querySelectorAll('[role=alert]')].map(n=>n.textContent).join(' '),title:document.querySelector('input[id$="-title"]')?.value,notes:document.querySelector('textarea')?.value,dialog:!!document.querySelector('[role=dialog]'),saving:document.querySelector('fieldset')?.disabled,
 calls:this.calls.map(c=>({url:c.url,method:c.method,actor:c.actor,body:c.body,aborted:c.signal.aborted})),heldUsed:this.held.map(h=>h.response.bodyUsed),statusDisabled:document.querySelector('button[aria-label^="Выполнить:"]')?.disabled};},
};
export function useAuth(){return useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn);},()=>current);}
export const hasSupabaseFrontendEnv=true;
export const supabase={auth:{onAuthStateChange(fn){sdk.add(fn);return{data:{subscription:{unsubscribe(){sdk.delete(fn);}}}};}}};
export const sessionAuth={onAuthStateChange:supabase.auth.onAuthStateChange};
export const readWorkspaceId=()=>current.clinicId;
export async function crmFetch(url,init={}){if(!/^\\/api\\/crm\\/mortgage-workspace\\?/.test(url))throw Error('Unexpected HTTP '+url);
 const method=init.method||'GET';let resolve,reject;const pending=new Promise((yes,no)=>{resolve=yes;reject=no;});
 const call={url,method,actor:init.expectedUserId,signal:init.signal,body:init.body?JSON.parse(init.body):null,resolve,reject,answered:false};fixture.calls.push(call);
 if(method==='GET'&&!fixture.holdReads){call.answered=true;resolve(Response.json(ok()));}return pending;}
export function PageLayout({children}){return <main>{children}</main>;}
export function Link({children,href,...rest}){return <a href={href} {...rest}>{children}</a>;}
export function useLocation(){useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn);},()=>route);return[route.split('?')[0],value=>fixture.route(value)];}
export function useSearch(){useLocation();return route.split('?')[1]||'';}
globalThis.fetch=()=>{throw Error('External fetch forbidden');};
fixture.reset();
`;

async function bundle(baseline) {
  const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import Tasks from ${JSON.stringify(path.join(frontend, 'src/pages/MortgageTasks.tsx').replaceAll('\\', '/'))};
import {fixture} from 'mortgage-task-fake';let app;
fixture.mount=()=>{fixture.reset();app=createRoot(document.getElementById('root'));flushSync(()=>app.render(<React.StrictMode><Tasks/></React.StrictMode>));};
fixture.unmount=()=>flushSync(()=>app.unmount());fixture.mount();window.__taskFixture=fixture;`;
  const result = await esbuild.build({ stdin: { contents: entry, resolveDir: frontend, sourcefile: 'mortgage-task-owned.tsx', loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
    plugins: [{ name: 'owned-task', setup(build) {
      build.onResolve({ filter: /^(mortgage-task-fake|@\/contexts\/AuthContext|@\/lib\/(api|supabase|demoStorage)|@\/components\/layout\/PageLayout|wouter)$/ }, () => ({ path: 'mocks', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: mocks, loader: 'tsx', resolveDir: frontend }));
      build.onResolve({ filter: /^@\// }, args => {
        const base = path.join(frontend, 'src', args.path.slice(2));
        const resolved = [base + '.tsx', base + '.ts'].find(existsSync);
        assert.ok(resolved, args.path); return { path: resolved };
      });
      if (baseline) build.onLoad({ filter: /(?:MortgageTasks|ActivityDialog)\.tsx$/ }, async args => {
        const { execFileSync } = await import('node:child_process');
        return { contents: execFileSync('git', ['show', '37e1d3e:' + path.relative(root, args.path).replaceAll('\\', '/')], { cwd: root, encoding: 'utf8' }), loader: 'tsx' };
      });
    } }],
  });
  return result.outputFiles[0].text;
}

async function connect(url, events) {
  const ws = new WebSocket(url), pending = new Map(); let id = 0;
  ws.addEventListener('message', event => {
    const data = JSON.parse(String(event.data));
    if (!data.id) { events(data.method, data.params); return; }
    const item = pending.get(data.id); if (!item) return;
    clearTimeout(item.timer); pending.delete(data.id);
    if (data.error) item.reject(Error(JSON.stringify(data.error))); else item.resolve(data.result);
  });
  ws.addEventListener('close', () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('Owned browser closed')); } pending.clear(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(Error('Owned browser connection timed out')); }, 10_000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('Owned browser connection failed')); }, { once: true });
  });
  return { call(method, params = {}) { return new Promise((resolve, reject) => {
    const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(Error('Owned CDP timeout: ' + method)); }, 15_000);
    pending.set(next, { resolve, reject, timer }); ws.send(JSON.stringify({ id: next, method, params }));
  }); }, close() { ws.close(); } };
}

export async function startMortgageTaskBrowser(t, baseline = false) {
  t.after(() => esbuild.stop());
  const browserPath = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium']
    .find(existsSync);
  assert.ok(browserPath, 'Installed local Chromium required; no download/install fallback');
  const script = await bundle(baseline);
  const server = createServer((req, res) => {
    if (req.headers.host !== `127.0.0.1:${server.address().port}` || req.method !== 'GET' || !['/', '/bundle.js', '/favicon.ico'].includes(req.url)) { res.writeHead(403); res.end(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; form-action 'none'; frame-src 'none'");
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(script); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = await mkdtemp(path.join(tmpdir(), 'medina-mortgage-task-owned-'));
  const child = spawn(browserPath, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--disable-sync',
    '--disable-component-update', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { windowsHide: true, stdio: 'ignore', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'HOME', 'DISPLAY'].includes(key))) });
  let cdp;
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  t.after(async () => {
    if (cdp) await cdp.call('Browser.close').catch(() => {});
    await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, delay(5000)]); }
    cdp?.close(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(profile), path.resolve(tmpdir())); assert.ok(path.basename(profile).startsWith('medina-mortgage-task-owned-'));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  let port = '';
  for (let i = 0; i < 250; i++) {
    assert.equal(child.exitCode, null, 'Owned browser must remain live until cleanup');
    try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]; } catch {}
    if (/^\d+$/.test(port)) break; await delay(80);
  }
  assert.match(port, /^\d+$/);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json();
  const page = targets.find(value => value.type === 'page'); assert.ok(page);
  const requests = [], exceptions = [];
  cdp = await connect(page.webSocketDebuggerUrl, (method, params) => {
    if (method === 'Network.requestWillBeSent') requests.push(params.request.url);
    if (method === 'Runtime.exceptionThrown') exceptions.push(params.exceptionDetails);
  });
  await cdp.call('Network.enable'); await cdp.call('Runtime.enable');
  const evaluate = async body => {
    const result = await cdp.call('Runtime.evaluate', { expression: `(async()=>{const f=window.__taskFixture;${body}})()`, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  await cdp.call('Page.navigate', { url: origin });
  let ready = false;
  for (let i = 0; i < 150; i++) { ready = await evaluate('return !!f'); if (ready) break; await delay(40); }
  assert.ok(ready, JSON.stringify(exceptions));
  return { evaluate, async settle() { await evaluate('for(let i=0;i<12;i++)await new Promise(r=>setTimeout(r,0));'); },
    async wait(expression) { for (let i = 0; i < 150; i++) { if (await evaluate(`return !!(${expression});`)) return; await delay(20); } assert.fail('Fixture did not reach ' + expression); },
    async reset() { await evaluate('f.unmount();f.mount();'); },
    state: () => evaluate('return f.state();'),
    async viewport(width) { await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 }); },
    assertIsolated() {
      assert.deepEqual(exceptions, []);
      // Chromium's datetime-local control requests its built-in inline SVG icon.
      assert.ok(requests.every(url => url.startsWith(origin + '/') || url.startsWith('data:image/svg+xml;base64,')), 'No external request: ' + JSON.stringify(requests));
    },
  };
}

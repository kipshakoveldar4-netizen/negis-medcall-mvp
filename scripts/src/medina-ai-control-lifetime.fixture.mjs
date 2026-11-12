import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Owned headless profile only. Memory bundle, real React/route gate/api/serverAuth,
// synthetic Auth SDK and HTTP. No app bootstrap, env files, backend or providers.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const frontend = path.join(root, 'artifacts/negis');
const require = createRequire(path.join(frontend, 'package.json'));
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
const ts = createRequire(path.join(root, 'package.json'))('typescript');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const mocks = `
import React,{useSyncExternalStore} from 'react';import {flushSync} from 'react-dom';
import {demoAuthFromStorage} from 'control-demo-contract';
const listeners=new Set(),sdk=new Set();
const initial=()=>({user:{id:'synthetic-A'},clinicId:'synthetic-workspace-A',userRole:'owner',vertical:'clinic',workspacePurpose:'clinic_services',rolePermissions:{dashboard:true,tasks:true,booking:true,crm:true},isLoading:false,isSigningOut:false,isDemoMode:false,isImpersonation:false,signOut:async()=>{throw Error('Signout forbidden');}});
let current=initial(),actor='synthetic-A',token='synthetic-token-1',route='/ai-control-center';
const props=n=>n?.[Object.keys(n).find(k=>k.startsWith('__reactProps'))];
export const fixture={calls:[],held:[],lookups:[],captured:{},toasts:[],warnings:[],storageWrites:[],blockedDemoHTTP:0,platformMounts:0,holdReads:false,holdToken:false,
 reset(){current=initial();actor=current.user.id;token='synthetic-token-1';route='/ai-control-center';this.calls=[];this.held=[];this.lookups=[];this.captured={};this.toasts=[];this.warnings=[];this.holdReads=false;this.holdToken=false;localStorage.clear();localStorage.setItem('negis_workspace_selector',current.clinicId);this.storageWrites=[];this.blockedDemoHTTP=0;this.platformMounts=0;},
 patch(p){flushSync(()=>{current={...current,...p};if(current.clinicId)localStorage.setItem('negis_workspace_selector',current.clinicId);else localStorage.removeItem('negis_workspace_selector');for(const fn of listeners)fn();});},
 emit(id){actor=id;for(const fn of [...sdk])fn('TOKEN_REFRESHED',id?{user:{id},access_token:token}:null);},
 aba(){flushSync(()=>{this.emit('synthetic-B');this.emit('synthetic-A');});},
 refresh(){token='synthetic-token-2';flushSync(()=>this.emit(actor));},
 restore(){this.patch(initial());},
 localRows(){const stamp=new Date().toISOString();for(const [key,rows] of Object.entries({leads:[{id:'stored-lead',name:'Stored demo lead',status:'new',source:'Stored demo source',createdAt:stamp}],clients:[{id:'stored-client',name:'Stored demo client',status:'repeat',createdAt:stamp}],appointments:[{id:'stored-appointment',name:'Stored demo appointment',startsAt:stamp,createdAt:stamp}],deals:[{id:'stored-deal',title:'Stored demo sale',status:'paid',paidAt:stamp,amountMinor:567800,createdAt:stamp}]}))localStorage.setItem('negis_demo_'+key,JSON.stringify(rows));},
 demo({workspaceId='demo-workspace',userId,records=true}={}){const stamp=new Date().toISOString();
 localStorage.setItem('negis_demo_session',JSON.stringify({mode:'demo',authenticated:true,createdAt:stamp}));localStorage.setItem('negis_demo_workspace',JSON.stringify({id:workspaceId,name:'Stored demo workspace'}));localStorage.setItem('negis_demo_user',JSON.stringify(userId?{id:userId}:{}));
 if(records)this.localRows();
 actor='';this.patch({...demoAuthFromStorage(),isLoading:false});this.storageWrites=[];},
 capture(key='old',index=0){const node=[...document.querySelectorAll('button')].filter(n=>n.textContent==='Создать задачу')[index];if(!node)throw Error('Missing recommendation button');this.captured[key]=props(node).onClick;},
 invoke(key='old'){this.captured[key]();},
 click(index=0){[...document.querySelectorAll('button')].filter(n=>n.textContent==='Создать задачу')[index].click();},
 answer(index,{status=200,body,holdBody=false,lost=false,raw}={}){const c=this.calls[index];if(!c||c.answered)throw Error('Missing pending HTTP '+index);c.answered=true;
 if(lost){c.reject(new TypeError('Synthetic lost response'));return;}
 const value=body??c.defaultBody;if(!holdBody){c.resolve(raw===undefined?Response.json(value,{status}):new Response(raw,{status}));return;}
 let controller;const stream=new ReadableStream({start(c){controller=c;}});const response=new Response(stream,{status,headers:{'content-type':'application/json'}});
 const held={response,released:false,release(){if(this.released)return;this.released=true;controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));controller.close();}};this.held.push(held);c.resolve(response);},
 answerReads(options={}){this.calls.forEach((c,i)=>{if(c.method==='GET'&&!c.answered)this.answer(i,options);});},
 release(){for(const h of this.held)h.release();},
 releaseTokens(){this.holdToken=false;for(const l of this.lookups)if(l.resolve&&!l.done){l.done=true;l.resolve({data:{session:{user:{id:actor},access_token:token}},error:null});}},
 state(){return{blockedDemoHTTP:this.blockedDemoHTTP,platformMounts:this.platformMounts,text:document.body.textContent,toasts:this.toasts,warnings:this.warnings,lookups:this.lookups.length,calls:this.calls.map(c=>({url:c.url,method:c.method,body:c.body,auth:c.auth,aborted:!!c.signal?.aborted,answered:c.answered})),heldUsed:this.held.map(h=>h.response.bodyUsed),busy:[...document.querySelectorAll('button')].some(n=>n.textContent==='Создаю…'),tasks:[...document.querySelectorAll('button')].filter(n=>n.textContent==='Создать задачу').length,enabledTasks:[...document.querySelectorAll('button')].filter(n=>n.textContent==='Создать задачу'&&!n.disabled).length,route,auth:{user:current.user,clinicId:current.clinicId,userRole:current.userRole,session:current.session,isDemoMode:current.isDemoMode,workspacePurpose:current.workspacePurpose},storage:Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])),storageWrites:this.storageWrites,sdkListeners:sdk.size,sections:Object.fromEntries([...document.querySelectorAll('section[aria-label]')].map(n=>[n.getAttribute('aria-label'),n.textContent])),metrics:Object.fromEntries([...document.querySelectorAll('[data-metric-value]')].map(n=>[n.parentElement.querySelector('p').textContent,{value:n.textContent,text:n.parentElement.textContent}]))};}
};
export function useAuth(){return useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn);},()=>current);}
export const hasSupabaseFrontendEnv=true;
export const supabase={auth:{onAuthStateChange(fn){sdk.add(fn);return{data:{subscription:{unsubscribe(){sdk.delete(fn);}}}};},getSession(){const lookup={};fixture.lookups.push(lookup);if(fixture.holdToken)return new Promise(resolve=>lookup.resolve=resolve);return Promise.resolve({data:{session:{user:{id:actor},access_token:token}},error:null});}}};
export const sessionAuth={onAuthStateChange:supabase.auth.onAuthStateChange};
export function PageLayout({children}){return <main>{children}</main>;}
export function PlatformRecommendations(){fixture.platformMounts++;if(current.isDemoMode)throw Error('Remote recommendations forbidden in demo');return null;}
export function DemoPlaceholder(){throw Error('Demo placeholder forbidden');}
export const toast={success(text){fixture.toasts.push({kind:'success',text});},error(text){fixture.toasts.push({kind:'error',text});}};
export function Link({children,href}){return <a href={href}>{children}</a>;}
export function useLocation(){useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn);},()=>route);return[route,value=>{route=value;for(const fn of listeners)fn();}];}
globalThis.fetch=(url,init={})=>{
 if(current.isDemoMode){fixture.blockedDemoHTTP++;throw Error('Demo HTTP forbidden');}
 const parsed=new URL(String(url),location.origin),method=init.method||'GET';
 const resource=parsed.pathname.split('/').pop();
 if(parsed.origin!==location.origin||!['health','storage-health','meta-launches','leads','clients','appointments','deals','tasks'].includes(resource)||!(parsed.pathname.startsWith('/api/crm/')||parsed.pathname==='/api/targeting/health')||(method!=='GET'&&!(method==='POST'&&resource==='tasks')))throw Error('Forbidden transport '+url);
 const name=current.user.id+' '+current.clinicId,stamp=new Date().toISOString(),base={id:'synthetic-row',name:'Record '+name,createdAt:stamp};
 let data=resource==='health'?{meta:{configured:true}}:resource==='storage-health'?{exists:true,publicAccess:true}:resource==='meta-launches'?{launches:[{id:'synthetic-launch',status:'paused',metaCampaignId:'synthetic-campaign',createdAt:stamp,payload:{city:'City '+name}}]}:resource==='leads'?{leads:[{...base,status:'new',source:'Source '+name}]}:resource==='clients'?{clients:[{...base,status:'repeat'}]}:resource==='appointments'?{appointments:[{...base,startsAt:stamp}],timeZone:'Asia/Qyzylorda'}:resource==='deals'?{deals:[{...base,title:'Sale '+name,status:'paid',paidAt:stamp,amountMinor:123400}]}:{};
 let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});const call={url:String(url),method,body:init.body?JSON.parse(init.body):null,auth:new Headers(init.headers).get('Authorization'),signal:init.signal,resolve,reject,answered:false,defaultBody:{success:true,mode:'supabase',data}};fixture.calls.push(call);
 if(method==='GET'&&!fixture.holdReads){call.answered=true;resolve(Response.json(call.defaultBody));}return promise;
};
console.warn=(...args)=>fixture.warnings.push(args.map(String).join(' '));
for(const name of ['setItem','removeItem','clear']){const original=Storage.prototype[name];Storage.prototype[name]=function(...args){fixture.storageWrites.push([name,...args]);return original.apply(this,args);};}
fixture.reset();
`;

async function bundle(baseline) {
  const appFile = path.join(frontend, 'src/App.tsx');
  const source = await readFile(appFile, 'utf8');
  const ast = ts.createSourceFile(appFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ['ProtectedPage', 'firstAllowedRoute'];
  const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)
    || ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(ast) === 'ROUTE_PERMISSIONS'));
  assert.equal(declarations.length, 3, 'Use current route controls without copying their policy');
  const gate = `import React,{useEffect} from 'react';import {useAuth,useLocation,DemoPlaceholder} from 'control-fake';import {workspaceAllowsRoute} from '@/lib/workspaceRoutes';\n${declarations.map(n => n.getText(ast)).join('\n')}\nexport {ProtectedPage};`;
  const authFile = path.join(frontend, 'src/contexts/AuthContext.tsx');
  const authSource = await readFile(authFile, 'utf8');
  const authAst = ts.createSourceFile(authFile, authSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const demoConstants = ['DEMO_USER_KEY', 'DEMO_WORKSPACE_KEY', 'DEMO_SESSION_KEY', 'ALL_PERMISSIONS'];
  const demoDeclarations = authAst.statements.filter(node => ts.isFunctionDeclaration(node) && ['readJson', 'loadStoredDemoAuth'].includes(node.name?.text)
    || ts.isVariableStatement(node) && node.declarationList.declarations.some(d => demoConstants.includes(d.name.getText(authAst))));
  assert.equal(demoDeclarations.length, 6);
  let applyDemo;
  const visit = node => { if (ts.isVariableDeclaration(node) && node.name.getText(authAst) === 'applyDemoWorkspaceState') applyDemo = node; ts.forEachChild(node, visit); };
  visit(authAst); assert.ok(applyDemo);
  const setters = new Set();
  const findSetters = node => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text.startsWith('set')) setters.add(node.expression.text); ts.forEachChild(node, findSetters); };
  findSetters(applyDemo);
  const demoContract = `import {DEFAULT_VERTICAL} from ${JSON.stringify(path.join(root, 'lib/vertical/terms.ts').replaceAll('\\', '/'))};\n${demoDeclarations.map(n => n.getText(authAst)).join('\n')}\nexport function demoAuthFromStorage(){const state={};${[...setters].map(name => `const ${name}=value=>state.${name[3].toLowerCase()+name.slice(4)}=value;`).join('')}const ${applyDemo.getText(authAst)};const data=loadStoredDemoAuth();if(!data)throw Error('Invalid synthetic demo auth');applyDemoWorkspaceState(data);return state;}`;
  const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import Page from './src/pages/AiControlCenter';import {ProtectedPage} from 'control-gate';import {fixture} from 'control-fake';let app;fixture.mount=(gated=true)=>{app=createRoot(document.getElementById('root'));flushSync(()=>app.render(<React.StrictMode>{gated?<ProtectedPage component={Page} permission="dashboard"/>:<Page/>}</React.StrictMode>));};fixture.unmount=()=>flushSync(()=>app.unmount());fixture.remount=(hold=false,gated=true)=>{fixture.unmount();fixture.reset();fixture.holdReads=hold;fixture.mount(gated);};fixture.mount();window.__controlFixture=fixture;`;
  const result = await esbuild.build({ stdin: { contents: entry, resolveDir: frontend, sourcefile: 'control-owned.tsx', loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' }, plugins: [{ name: 'owned-control', setup(build) {
      build.onResolve({ filter: /^(control-fake|@\/contexts\/AuthContext|@\/lib\/supabase|@\/components\/layout\/PageLayout|@\/components\/crm\/PlatformRecommendations|wouter|sonner)$/ }, () => ({ path: 'fake', namespace: 'fixture' }));
      build.onResolve({ filter: /^(control-gate|control-demo-contract)$/ }, args => ({ path: args.path === 'control-gate' ? 'gate' : 'demo-contract', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'gate' ? gate : args.path === 'demo-contract' ? demoContract : mocks, loader: 'tsx', resolveDir: frontend }));
      build.onResolve({ filter: /^@\// }, args => { const base = path.join(frontend, 'src', args.path.slice(2)); const resolved = [base + '.tsx', base + '.ts'].find(existsSync); assert.ok(resolved, args.path); return { path: resolved }; });
      if (baseline) build.onLoad({ filter: /AiControlCenter\.tsx$/ }, () => ({ contents: execFileSync('git', ['show', 'db73c4a:artifacts/negis/src/pages/AiControlCenter.tsx'], { cwd: root, encoding: 'utf8' }), loader: 'tsx', resolveDir: path.join(frontend, 'src/pages') }));
    } }],
  });
  return result.outputFiles[0].text;
}

async function connect(url, onEvent) {
  const ws = new WebSocket(url), pending = new Map(); let id = 0;
  ws.addEventListener('message', event => { const data = JSON.parse(String(event.data)); if (!data.id) return onEvent(data.method, data.params); const p = pending.get(data.id); if (!p) return; clearTimeout(p.timer); pending.delete(data.id); data.error ? p.reject(Error(JSON.stringify(data.error))) : p.resolve(data.result); });
  ws.addEventListener('close', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('Owned browser closed')); } pending.clear(); });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => { ws.close(); reject(Error('Owned connection timeout')); }, 10000); ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true }); ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('Owned connection failed')); }, { once: true }); });
  return { call(method, params = {}) { return new Promise((resolve, reject) => { const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(Error('Owned CDP timeout: ' + method)); }, 15000); pending.set(next, { resolve, reject, timer }); ws.send(JSON.stringify({ id: next, method, params })); }); }, close() { ws.close(); } };
}

export async function startControlFixture(t, baseline = false) {
  t.after(() => esbuild.stop());
  const browserPath = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(existsSync);
  assert.ok(browserPath, 'Existing local Chromium required; no installation fallback');
  const script = await bundle(baseline);
  const server = createServer((req, res) => {
    if (req.headers.host !== `127.0.0.1:${server.address().port}` || req.method !== 'GET' || !['/', '/bundle.js', '/favicon.ico'].includes(req.url)) { res.writeHead(403); res.end(); return; }
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; form-action 'none'");
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    res.setHeader('Content-Type', req.url === '/bundle.js' ? 'application/javascript' : 'text/html; charset=utf-8');
    res.end(req.url === '/bundle.js' ? script : '<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = await mkdtemp(path.join(tmpdir(), 'medina-ai-control-owned-'));
  const child = spawn(browserPath, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--disable-sync', '--disable-component-update', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore', env: { SystemRoot: 'C:/Windows', WINDIR: 'C:/Windows' } });
  let cdp;
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  t.after(async () => {
    if (cdp) await cdp.call('Browser.close').catch(() => {});
    await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, delay(5000)]); }
    cdp?.close(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(profile), path.resolve(tmpdir())); assert.ok(path.basename(profile).startsWith('medina-ai-control-owned-'));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  let port = '';
  for (let i = 0; i < 200; i++) { assert.equal(child.exitCode, null); try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]; } catch {} if (/^\d+$/.test(port)) break; await delay(80); }
  assert.match(port, /^\d+$/);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10000) })).json();
  const page = targets.find(p => p.type === 'page'); assert.ok(page);
  const requests = [], exceptions = [];
  cdp = await connect(page.webSocketDebuggerUrl, (method, params) => { if (method === 'Network.requestWillBeSent') requests.push(params.request.url); if (method === 'Runtime.exceptionThrown') exceptions.push(params.exceptionDetails); });
  await cdp.call('Network.enable'); await cdp.call('Runtime.enable');
  const evaluate = async body => { const result = await cdp.call('Runtime.evaluate', { expression: `(async()=>{const f=window.__controlFixture;${body}})()`, awaitPromise: true, returnByValue: true }); assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); return result.result.value; };
  await cdp.call('Page.navigate', { url: origin });
  for (let i = 0; i < 150; i++) { if (await evaluate('return !!f;')) break; await delay(40); }
  assert.equal(await evaluate('return !!f;'), true, JSON.stringify(exceptions));
  return { evaluate, state: () => evaluate('return f.state();'),
    async settle() { await evaluate('for(let i=0;i<10;i++)await new Promise(r=>setTimeout(r,0));'); },
    async reset(hold = false, gated = true) { await evaluate(`f.remount(${hold},${gated});`); await this.settle(); },
    assertIsolated() { assert.deepEqual(exceptions, []); assert.ok(requests.every(url => url.startsWith(origin + '/')), JSON.stringify(requests)); },
  };
}

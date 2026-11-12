import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A fresh owned Chromium profile and an in-memory React bundle. No customer
// browser, session, key, backend or running CRM is used. Every auth request is fake.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const frontend = path.join(root, 'artifacts/negis');
const require = createRequire(path.join(frontend, 'package.json'));
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const mocks = `
import {useSyncExternalStore} from 'react';import {flushSync} from 'react-dom';
export class StaleAuthIntentError extends Error{name='StaleAuthIntentError';}
const expiry=Math.floor(Date.now()/1000)+3600;
let nameA='Synthetic A';
const encoded=value=>btoa(JSON.stringify(value)).replaceAll('=','').replaceAll('+','-').replaceAll('/','_');
function session(id='A',revision='one',refresh=0){return{access_token:encoded({alg:'HS256',typ:'JWT'})+'.'+encoded({sub:id,session_id:'synthetic-'+id+'-'+revision,exp:expiry,refresh})+'.c2lnbmF0dXJl',refresh_token:'synthetic-refresh-'+id,
 user:{id,email:id.toLowerCase()+'@example.test',aud:'authenticated',app_metadata:{provider:'synthetic'},user_metadata:{full_name:id==='A'?nameA:'Synthetic '+id,retained:'original'},created_at:'2026-01-01T00:00:00Z'}};}
const initial=()=>({session:session(),user:session().user,isImpersonation:false,isDemoMode:false,isSigningOut:false});
let current=initial(),sdkSession=current.session,verification,network;
let sdkRevision=0,sdkIntent=0;const stamps=new WeakMap();
const listeners=new Set(),sdk=new Set();
const deferred=()=>{let resolve;return{promise:new Promise(done=>{resolve=done}),resolve:value=>resolve(value)}};
export const fixture={requests:[],messages:[],closes:0,stage:'idle',pause:null,responseError:false,globalUpdates:0,detached:[],
 reset(){nameA='Synthetic A';current=initial();sdkSession=current.session;sdkRevision++;sdkIntent++;verification=deferred();network=deferred();this.requests=[];this.messages=[];this.closes=0;this.stage='idle';this.pause=null;this.responseError=false;this.globalUpdates=0;this.detached=[];
 this.storageTouches=[];this.broadcasts=0;this.visibilityListeners=0;},
 patch(value){flushSync(()=>{current={...current,...value};for(const fn of listeners)fn();});},
 emit(id,event=id?'SIGNED_IN':'SIGNED_OUT',revision='one',refresh=0){if(id!==(sdkSession?.user.id??null)||!['TOKEN_REFRESHED','USER_UPDATED'].includes(event))sdkIntent++;
 sdkSession=id?session(id,revision,refresh):null;sdkRevision++;flushSync(()=>{for(const fn of sdk)fn(event,sdkSession);});},
 refresh(){this.emit('A','TOKEN_REFRESHED','one',1);this.patch({session:sdkSession,user:sdkSession.user});},
 renameRemote(value){nameA=value;this.emit('A','USER_UPDATED');},
 aba(){flushSync(()=>{for(const id of ['B','A']){sdkSession=session(id);sdkRevision++;sdkIntent++;for(const fn of sdk)fn('SIGNED_IN',sdkSession);}});},
 resolveVerify(result='ok'){verification.resolve(result);},resolveNetwork(){network.resolve();},
 fill(id,value){const input=document.getElementById(id);if(!input)throw Error('Missing '+id);
 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));},
 passwords(){this.fill('profile-current-password','SyntheticCurrent42');this.fill('profile-new-password','SyntheticNew42');this.fill('profile-repeat-password','SyntheticNew42');},
 save(){[...document.querySelectorAll('button')].find(node=>node.textContent==='Сохранить').click();},
 remember(){this.detached=[...document.querySelectorAll('input[type=password]')];},
};
export const supabase={auth:{onAuthStateChange(fn){sdk.add(fn);return{data:{subscription:{unsubscribe(){sdk.delete(fn);}}}};},
 async getSession(){return{data:{session:sdkSession},error:null};},async signOut(){fixture.emit(null);return{error:null};},
 async updateUser(){fixture.globalUpdates++;throw Error('Global updateUser forbidden');}}};
// Synthetic observer/dispatch surface only; no native auth-storage guarantee.
// Explicit offline flag preserves the old unconfigured fixture branch.
export const hasSupabaseFrontendEnv=false;
const capture=()=>{const stamp=Object.freeze({revision:String(sdkRevision),intent:String(sdkIntent)});stamps.set(stamp,{actor:sdkSession?.user.id??null,revision:sdkRevision});return stamp;};
const isCurrent=stamp=>{const saved=stamp&&typeof stamp==='object'?stamps.get(stamp):null;
 return !!saved&&saved.actor===(sdkSession?.user.id??null)&&saved.revision===sdkRevision;};
export const sessionAuth={onAuthStateChange:supabase.auth.onAuthStateChange,capture,isCurrent,
 updateUserPassword(){throw Error('Password recovery is forbidden in the profile fixture');},signOut(scope){
 if(typeof scope?.isCurrent!=='function'||!scope.isCurrent()||scope.signal?.aborted)throw Error('Synthetic sign-out requires a current scope');
 if((scope.expected&&!isCurrent(scope.expected))||(scope.expectedUserId!==undefined&&scope.expectedUserId!==(sdkSession?.user.id??null)))throw new StaleAuthIntentError();
 return supabase.auth.signOut();}};
export function useAuth(){const value=useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn);},()=>current);return{...value,
 applyConfirmedProfile(confirmed,guard){if(!guard()||confirmed.id!==current.user?.id)return;current={...current,user:{...current.user,user_metadata:{...current.user.user_metadata,full_name:confirmed.user_metadata.full_name}}};for(const fn of listeners)fn();}};}
export function verifyCurrentPassword(email,password){if(email!=='a@example.test'||password!=='SyntheticCurrent42')throw Error('Synthetic verification target mismatch');fixture.stage='verification';return verification.promise;}
export const toast={success:value=>fixture.messages.push('success:'+value),error:value=>fixture.messages.push('error:'+value)};
export function PushSettings(){return null;}
fixture.storageTouches=[];fixture.broadcasts=0;fixture.visibilityListeners=0;
if(!__ACTUAL_AUTH_FIXTURE__){
for(const method of ['getItem','setItem','removeItem','clear'])Storage.prototype[method]=function(key){fixture.storageTouches.push({method,key,stack:new Error().stack});throw Error('Profile must not use browser storage');};
globalThis.BroadcastChannel=class{constructor(){fixture.broadcasts++;throw Error('Profile must not broadcast a session');}};
const addListener=window.addEventListener.bind(window);
window.addEventListener=(name,...args)=>{if(name==='visibilitychange')fixture.visibilityListeners++;return addListener(name,...args);};
}
globalThis.fetch=async(url,init)=>{if(String(url)!=='https://profile.example.test/auth/v1/user')throw Error('Unexpected external request');
 const token=new Headers(init.headers).get('Authorization');const actor=token==='Bearer '+session().access_token?'A':'UNEXPECTED';
 fixture.requests.push({method:init.method,actor,updates:init.body?JSON.parse(init.body):null});fixture.stage=init.method;
 if(fixture.pause===init.method)await network.promise;
 if(fixture.responseError&&init.method==='PUT')return Response.json({msg:'Weak password',code:'weak_password'},{status:400});
 if(init.method==='PUT')nameA=JSON.parse(init.body).data.full_name;
 const user=session().user;if(__ACTUAL_AUTH_FIXTURE__&&init.method==='PUT')user.user_metadata={...user.user_metadata,role:'injected-owner',workspaceId:'injected-workspace'};
 return Response.json(user);};
export const WORKSPACE_SELECTOR_KEY='negis_workspace_selector';export const clearListReadCache=()=>{};export const isRealWorkspace=()=>true;
export const bindWorkspaceReadScope=()=>{},clearWorkspaceReadScope=()=>{};
export class CrmApiError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code;}}
export const apiUrl=url=>url;export const clearCrmCache=()=>{};
export async function getSupabaseAccessToken(expected){return sdkSession?.user.id===expected?sdkSession.access_token:'';}
export async function crmFetch(url){if(url!=='/api/crm/auth-context')throw Error('Unexpected auth route');
 if(fixture.holdAuth)await fixture.holdAuth;return Response.json({success:true,data:{memberships:[{staffUserId:'synthetic-staff',workspaceId:'synthetic-workspace',workspaceName:'Synthetic clinic',role:'owner',permissions:[],vertical:'beauty',purpose:'clinic_services'}]}});}
export const useLocation=()=>['/dashboard',()=>{}];export function Link({children,href}){return <a href={href}>{children}</a>;}
fixture.syntheticSession=session;
fixture.reset();
`;

async function bundle(actualAuth = false) {
  const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {ProfileDialog} from ${JSON.stringify(path.join(frontend, 'src/components/layout/ProfileDialog.tsx').replaceAll('\\', '/'))};
import {fixture} from 'profile-fake';
let app;fixture.mount=()=>{fixture.reset();app=createRoot(document.getElementById('root'));flushSync(()=>app.render(<ProfileDialog onClose={()=>{fixture.closes++;app.render(null);}}/>));};
fixture.unmount=()=>{fixture.remember();flushSync(()=>app.unmount());};fixture.mount();window.__profileFixture=fixture;`;
  const authEntry = `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {AuthProvider,useAuth} from ${JSON.stringify(path.join(frontend, 'src/contexts/AuthContext.tsx').replaceAll('\\', '/'))};
import {Sidebar} from ${JSON.stringify(path.join(frontend, 'src/components/layout/Sidebar.tsx').replaceAll('\\', '/'))};
import {clearSignOutPending} from ${JSON.stringify(path.join(frontend, 'src/lib/authSignOut.ts').replaceAll('\\', '/'))};
import {fixture} from 'profile-fake';
function Probe(){fixture.context=useAuth();return null;}
let app;fixture.mount=()=>{localStorage.clear();sessionStorage.clear();clearSignOutPending();fixture.reset();fixture.holdAuth=null;app=createRoot(document.getElementById('root'));flushSync(()=>app.render(<AuthProvider><Probe/><Sidebar/></AuthProvider>));};
fixture.unmount=()=>{fixture.remember();flushSync(()=>app.unmount());};fixture.mount();window.__profileFixture=fixture;`;
  const result = await esbuild.build({ stdin: { contents: actualAuth ? authEntry : entry, resolveDir: frontend, sourcefile: 'profile-owned.tsx', loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { '__ACTUAL_AUTH_FIXTURE__': String(actualAuth), 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://profile.example.test', VITE_SUPABASE_ANON_KEY: 'synthetic-public-key' }) },
    plugins: [{ name: 'isolated-profile', setup(build) {
      build.onResolve({ filter: /^(profile-fake|@\/contexts\/AuthContext|@\/lib\/(supabase|authSessionAuthority|api|demoStorage|serverAuth)|wouter|sonner|\.\/PushSettings)$/ }, args => {
        if(actualAuth&&args.path==='@/contexts/AuthContext')return {path:path.join(frontend,'src/contexts/AuthContext.tsx')};
        return { path: 'mocks', namespace: 'fixture' };
      });
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: mocks, loader: 'tsx', resolveDir: frontend }));
      build.onResolve({ filter: /^@\// }, args => ({ path: path.join(frontend, 'src', args.path.slice(2) + '.ts') }));
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

export async function runProfileSessionBrowser(t, actualAuth = false) {
  t.after(() => esbuild.stop());
  const browserPath = [process.env.MEDINA_TEST_BROWSER_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
    .find(value => value && existsSync(value));
  assert.ok(browserPath, 'Installed local Chromium required; no installation/download fallback');
  const script = await bundle(actualAuth);
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
  const profile = await mkdtemp(path.join(tmpdir(), 'medina-profile-owned-'));
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
    assert.equal(path.dirname(profile), path.resolve(tmpdir())); assert.ok(path.basename(profile).startsWith('medina-profile-owned-'));
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
    const result = await cdp.call('Runtime.evaluate', { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  await cdp.call('Page.navigate', { url: origin });
  let ready = false;
  for (let i = 0; i < 150; i++) { ready = await evaluate('return !!window.__profileFixture'); if (ready) break; await delay(40); }
  assert.ok(ready, JSON.stringify(exceptions));
  const reset = () => evaluate('const f=window.__profileFixture;f.unmount();f.mount();');
  const waitStage = async stage => {
    for (let i = 0; i < 150; i++) { if (await evaluate(`return window.__profileFixture.stage===${JSON.stringify(stage)}`)) return; await delay(20); }
    assert.fail(`Profile did not reach ${stage}`);
  };
  const settle = () => evaluate('for(let i=0;i<25;i++)await new Promise(resolve=>setTimeout(resolve,0));');
  const state = async () => {
    const result = await evaluate(`const f=window.__profileFixture;return {requests:f.requests,messages:f.messages,closes:f.closes,global:f.globalUpdates,
      isolation:[f.storageTouches,f.broadcasts,f.visibilityListeners],visible:!!document.querySelector('[role=dialog]'),passwords:[...document.querySelectorAll('input[type=password]')].map(node=>node.value),detached:f.detached.map(node=>node.value),attributes:f.detached.map(node=>node.getAttribute('value'))};`);
    // auth-js probes storage once at module import (locks.ts). Reset starts
    // after that import; each actual profile operation must remain isolated.
    assert.deepEqual(result.isolation, [[], 0, 0]); return result;
  };

  if (actualAuth) {
    const waitAuth = async () => {
      for (let i = 0; i < 150; i++) {
        if (await evaluate('const c=window.__profileFixture.context;return c?.user?.id===\'A\'&&!c.isLoading&&c.clinicId===\'synthetic-workspace\';')) return;
        await delay(20);
      }
      assert.fail('Actual AuthProvider did not settle with synthetic membership');
    };
    const resetAuth = async () => { await reset(); await waitAuth(); };
    const context = () => evaluate(`const f=window.__profileFixture,c=f.context;return {id:c.user?.id,name:c.user?.user_metadata?.full_name,
      metadata:c.user?.user_metadata,app:c.user?.app_metadata,token:c.session?.access_token,sessionUser:c.session?.user,
      role:c.userRole,permissions:c.rolePermissions,clinic:c.clinicId,workspaces:c.availableWorkspaces,impersonation:c.isImpersonation,
      sidebar:document.querySelector('aside')?.textContent,field:document.getElementById('profile-full-name')?.value,
      messages:f.messages,requests:f.requests,global:f.globalUpdates};`);
    const open = () => evaluate('document.querySelector(\'[aria-label="Открыть профиль"]\').click();');
    for (const width of [390, 1440]) {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
      await t.test(`actual AuthProvider/Sidebar ${width}px saved name is immediate on reopen and same-actor refresh`, async () => {
        await resetAuth(); const before = await context(); await open();
        await evaluate("const f=window.__profileFixture;f.fill('profile-full-name','Confirmed A');f.save();"); await waitStage('PUT'); await settle();
        const saved = await context(); assert.equal(saved.name, 'Confirmed A'); assert.match(saved.sidebar, /Confirmed A/);
        assert.deepEqual(saved.metadata, { full_name: 'Confirmed A', retained: 'original' });
        for (const key of ['app', 'token', 'role', 'permissions', 'clinic', 'workspaces', 'sessionUser']) assert.deepEqual(saved[key], before[key], key);
        assert.equal(saved.global, 0); await open(); assert.equal((await context()).field, 'Confirmed A');
        await evaluate('window.__profileFixture.refresh();'); await settle();
        const refreshed = await context(); assert.equal(refreshed.name, 'Confirmed A'); assert.equal(refreshed.field, 'Confirmed A');
        assert.equal(refreshed.role, before.role); assert.equal(refreshed.clinic, before.clinic);
      });
      for (const scenario of ['B', 'ABA', 'impersonation', 'unmount']) {
        await t.test(`actual AuthProvider ${width}px ${scenario} rejects the delayed original result`, async () => {
          await resetAuth(); await open();
          await evaluate("const f=window.__profileFixture;f.fill('profile-full-name','Late original A');f.pause='PUT';f.save();"); await waitStage('PUT');
          await evaluate(`const f=window.__profileFixture;${scenario === 'ABA' ? 'f.aba();' : scenario === 'unmount' ? 'f.unmount();' : scenario === 'impersonation'
            ? "localStorage.setItem('negis_impersonation',JSON.stringify({active:true,clinic_id:'synthetic-imp',clinic_name:'Synthetic impersonation',owner_email:'a@example.test',issued_by:'synthetic'}));f.refresh();" : "f.emit('B');"}f.resolveNetwork();`);
          await settle(); const after = await context(); assert.notEqual(after.name, 'Late original A');
          assert.equal(after.messages.some(message => message.startsWith('success:')), false); assert.equal(after.global, 0);
          assert.deepEqual(after.requests.filter(request => request.method === 'PUT').map(request => request.actor), ['A']);
        });
      }
    }
    await t.test('actual AuthProvider retains source subject epoch across batched A/B/A and checks caller again inside updater', async () => {
      await resetAuth(); const before = await context();
      await evaluate(`const f=window.__profileFixture;f.guardChecks=0;
        f.context.applyConfirmedProfile({id:'A',user_metadata:{full_name:'Must not appear'}},()=>++f.guardChecks===1);`);
      await settle(); assert.ok(await evaluate('return window.__profileFixture.guardChecks>=2;')); assert.equal((await context()).name, before.name);
      await evaluate("const f=window.__profileFixture;const old=f.context.applyConfirmedProfile;f.aba();old({id:'A',user_metadata:{full_name:'Old epoch A'}},()=>true);");
      await settle(); assert.notEqual((await context()).name, 'Old epoch A');
      await evaluate("const f=window.__profileFixture;f.context.applyConfirmedProfile({id:'A',user_metadata:{full_name:'Queued epoch A'}},()=>true);f.aba();");
      await settle(); assert.notEqual((await context()).name, 'Queued epoch A');
    });
    await t.test('actual AuthProvider refuses wrong subject and sign-out metadata without replacing tokens or roles', async () => {
      await resetAuth(); const before = await context();
      await evaluate("const f=window.__profileFixture;f.context.applyConfirmedProfile({id:'B',user_metadata:{full_name:'Wrong B'}},()=>true);");
      await settle(); assert.deepEqual(await context(), before);
      await evaluate("const f=window.__profileFixture;const old=f.context.applyConfirmedProfile;f.context.signOut();old({id:'A',user_metadata:{full_name:'After signout'}},()=>true);");
      await settle(); const after = await context(); assert.equal(after.id, undefined); assert.notEqual(after.name, 'After signout');
    });
    await t.test('actual AuthProvider rejects a retained local publisher after unmount or stored impersonation', async () => {
      await resetAuth();
      await evaluate("const f=window.__profileFixture;const old=f.context.applyConfirmedProfile;f.unmount();old({id:'A',user_metadata:{full_name:'Unmounted name'}},()=>{throw Error('Unmount must reject before caller evaluation');});");
      await settle(); assert.notEqual((await context()).name, 'Unmounted name');
      await resetAuth(); const before = await context();
      await evaluate("const f=window.__profileFixture;const old=f.context.applyConfirmedProfile;localStorage.setItem('negis_impersonation',JSON.stringify({active:true,clinic_id:'synthetic-imp',clinic_name:'Synthetic impersonation',owner_email:'a@example.test',issued_by:'synthetic'}));old({id:'A',user_metadata:{full_name:'Impersonated name'}},()=>true);");
      await settle(); assert.deepEqual(await context(), before);
    });
    await t.test('actual AuthProvider late same-actor membership resolution cannot undo confirmed name', async () => {
      await resetAuth(); await open();
      await evaluate("const f=window.__profileFixture;f.passwords();f.fill('profile-full-name','Confirmed during refresh');f.save();f.holdAuth=new Promise(resolve=>f.releaseAuth=resolve);f.refresh();f.resolveVerify();");
      await waitStage('PUT'); await settle(); assert.equal((await context()).name, 'Confirmed during refresh');
      await evaluate('const f=window.__profileFixture;f.holdAuth=null;f.releaseAuth();'); await settle();
      assert.equal((await context()).name, 'Confirmed during refresh'); await open(); assert.equal((await context()).field, 'Confirmed during refresh');
      await evaluate('document.querySelector(\'[aria-label="Закрыть профиль"]\').click();window.__profileFixture.renameRemote("Later authoritative A");'); await settle();
      assert.equal((await context()).name, 'Later authoritative A'); await open(); assert.equal((await context()).field, 'Later authoritative A');
    });
    assert.deepEqual(exceptions, []); assert.ok(requests.every(url => url.startsWith(origin + '/'))); return;
  }

  for (const width of [390, 1440]) {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
    for (const scenario of ['B', 'ABA', 'unmount', 'impersonation', 'demo', 'signout', 'new-session']) {
      await t.test(`actual React ${width}px ${scenario} during password verification clears the original form`, async () => {
        await reset(); await evaluate('const f=window.__profileFixture;f.passwords();f.remember();f.save();'); await waitStage('verification');
        await evaluate(`const f=window.__profileFixture;${scenario === 'ABA' ? 'f.aba();' : scenario === 'unmount' ? 'f.unmount();' : scenario === 'impersonation' ? 'f.patch({isImpersonation:true});' : scenario === 'demo' ? 'f.patch({isDemoMode:true});' : scenario === 'signout' ? 'f.emit(null);' : scenario === 'new-session' ? "f.emit('A','SIGNED_IN','two');" : "f.emit('B');"}f.resolveVerify();`);
        await settle(); const result = await state();
        assert.deepEqual(result.requests, []); assert.deepEqual(result.messages, []); assert.equal(result.visible, false);
        assert.ok(result.detached.every(value => value === ''), 'Detached password controls are cleared');
        assert.ok(result.attributes.every(value => !value), 'Detached controlled password attributes are cleared'); assert.equal(result.global, 0);
      });
    }
    await t.test(`actual React ${width}px invalidation during installed SDK GET refuses PUT`, async () => {
      await reset(); await evaluate("const f=window.__profileFixture;f.pause='GET';f.save();"); await waitStage('GET');
      await evaluate("const f=window.__profileFixture;f.aba();f.resolveNetwork();"); await settle();
      const result = await state(); assert.deepEqual(result.requests.map(value => [value.method, value.actor]), [['GET', 'A']]);
      assert.deepEqual(result.messages, []); assert.equal(result.visible, false); assert.equal(result.global, 0);
    });
    await t.test(`actual React ${width}px already-issued original PUT may finish but cannot publish stale success`, async () => {
      await reset(); await evaluate("const f=window.__profileFixture;f.pause='PUT';f.save();"); await waitStage('PUT');
      await evaluate("const f=window.__profileFixture;f.emit('B');f.resolveNetwork();"); await settle();
      const result = await state(); assert.deepEqual(result.requests.map(value => [value.method, value.actor]), [['GET', 'A'], ['PUT', 'A']]);
      assert.deepEqual(result.messages, []); assert.equal(result.visible, false); assert.equal(result.global, 0);
    });
    await t.test(`actual React ${width}px same-user refresh keeps the save usable and original-actor bound`, async () => {
      await reset(); await evaluate('const f=window.__profileFixture;f.passwords();f.save();f.refresh();f.resolveVerify();'); await waitStage('PUT'); await settle();
      const result = await state(); assert.deepEqual(result.requests.map(value => [value.method, value.actor]), [['GET', 'A'], ['PUT', 'A']]);
      assert.equal(result.messages.length, 1); assert.match(result.messages[0], /^success:/); assert.equal(result.visible, false); assert.equal(result.global, 0);
    });
    await t.test(`actual React ${width}px provider refusal clears secrets without reporting success`, async () => {
      await reset(); await evaluate('const f=window.__profileFixture;f.responseError=true;f.passwords();f.save();f.resolveVerify();'); await waitStage('PUT'); await settle();
      const result = await state(); assert.equal(result.messages.length, 1); assert.match(result.messages[0], /^error:/);
      assert.deepEqual(result.passwords, ['', '', '']); assert.equal(result.visible, true); assert.equal(result.global, 0);
    });
  }
  assert.deepEqual(await evaluate('const f=window.__profileFixture;return [f.storageTouches,f.broadcasts,f.visibilityListeners];'), [[], 0, 0]);
  assert.deepEqual(exceptions, []);
  assert.ok(requests.every(url => url.startsWith(origin + '/')), 'No real auth/provider request or external URL was visited');
}

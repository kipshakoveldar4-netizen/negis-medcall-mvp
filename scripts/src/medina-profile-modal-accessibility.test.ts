import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Same owned React/Chromium/loopback pattern as profile-session-browser.mjs.
// The real dialog, profile helper and installed auth SDK run with synthetic
// auth and a fake transport. No user browser, service, env file or install.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const frontend = path.join(root, 'artifacts/negis');
const require = createRequire(path.join(frontend, 'package.json'));
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const mocks = `
import {useSyncExternalStore} from 'react';import {flushSync} from 'react-dom';
const expiry=Math.floor(Date.now()/1000)+3600;
const encode=value=>btoa(JSON.stringify(value)).replaceAll('=','').replaceAll('+','-').replaceAll('/','_');
function session(id='A',revision='one',refresh=0){return{access_token:encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:id,session_id:'synthetic-'+id+'-'+revision,exp:expiry,refresh})+'.c2lnbmF0dXJl',
 refresh_token:'synthetic-refresh-'+id,user:{id,email:id.toLowerCase()+'@example.test',aud:'authenticated',app_metadata:{},user_metadata:{full_name:'Synthetic '+id},created_at:'2026-01-01T00:00:00Z'}};}
const initial=()=>({session:session(),user:session().user,clinicId:'synthetic-workspace',userRole:'owner',workspacePurpose:'clinic_services',vertical:'clinic',rolePermissions:{},isImpersonation:false,isDemoMode:false,isSigningOut:false});
let current=initial(),verification,network;const listeners=new Set(),sdk=new Set();
const deferred=()=>{let resolve;return{promise:new Promise(done=>{resolve=done}),resolve:value=>resolve(value)}};
export const fixture={
 reset(){current=initial();verification=deferred();network=deferred();this.closes=0;this.messages=[];this.requests=[];this.detached=[];this.stage='idle';this.pause=null;this.responseError=false;this.pushVisible=false;this.outerEscapes=0;},
 patch(value){flushSync(()=>{current={...current,...value};for(const fn of listeners)fn();});},
 actor(id){this.patch({session:session(id),user:session(id).user});},
 emit(id,event=id?'SIGNED_IN':'SIGNED_OUT',revision='one',refresh=0){flushSync(()=>{for(const fn of sdk)fn(event,id?session(id,revision,refresh):null);});},
 refresh(){this.emit('A','TOKEN_REFRESHED','one',1);this.patch({session:session('A','one',1),user:session().user});},
 aba(){flushSync(()=>{for(const fn of sdk)fn('SIGNED_IN',session('B'));for(const fn of sdk)fn('SIGNED_IN',session('A'));});},
 resolveVerify(result='ok'){verification.resolve(result);},resolveNetwork(){network.resolve();},
 fill(id,value){const input=document.getElementById(id);if(!input)throw Error('Missing '+id);
 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));},
 passwords(){this.fill('profile-current-password','SyntheticCurrent42');this.fill('profile-new-password','SyntheticNew42');this.fill('profile-repeat-password','SyntheticNew42');},
 save(){document.querySelector('.neu-btn-primary').click();},
 remember(){const inputs=[...document.querySelectorAll('input[type=password]')];if(inputs.length)this.detached=inputs;},
 latePush(){this.pushVisible=true;this.patch({});},
 listenerCount(){return sdk.size;},
};
export function useAuth(){return{...useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn);},()=>current),
 applyConfirmedProfile(confirmed,guard){if(guard()&&confirmed.id===current.user?.id)fixture.patch({user:{...current.user,user_metadata:confirmed.user_metadata}});}};}
export const supabase={auth:{onAuthStateChange(fn){sdk.add(fn);return{data:{subscription:{unsubscribe(){sdk.delete(fn);}}}};}}};
export const sessionAuth={onAuthStateChange:supabase.auth.onAuthStateChange};
export const hasSupabaseFrontendEnv=true;
export function useLocation(){return['/leads',()=>{throw Error('Navigation is outside the profile handoff test');}];}
export function verifyCurrentPassword(){fixture.stage='verification';return verification.promise;}
export const toast={success:value=>fixture.messages.push('success:'+value),error:value=>fixture.messages.push('error:'+value)};
export function PushSettings(){useAuth();return fixture.pushVisible?<button id="synthetic-push">Synthetic push control</button>:null;}
globalThis.fetch=async(url,init)=>{if(String(url)!=='https://profile.example.test/auth/v1/user')throw Error('Unexpected transport');
 const token=new Headers(init.headers).get('Authorization');if(![session().access_token,session('A','one',1).access_token].some(value=>token==='Bearer '+value))throw Error('Wrong synthetic actor');
 const actor=JSON.parse(atob(token.slice(7).split('.')[1].replaceAll('-','+').replaceAll('_','/'))).sub;
 fixture.requests.push({method:init.method,actor,updates:init.body?JSON.parse(init.body):null});fixture.stage=init.method;
 if(fixture.pause===init.method)await network.promise;
 if(fixture.responseError&&init.method==='PUT')return Response.json({msg:'Weak password',code:'weak_password'},{status:400});
 return Response.json(session().user);};
fixture.reset();
`;

async function bundle() {
  const entry = `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {ProfileDialog} from ${JSON.stringify(path.join(frontend, 'src/components/layout/ProfileDialog.tsx').replaceAll('\\', '/'))};
import {MobileNav} from ${JSON.stringify(path.join(frontend, 'src/components/layout/MobileNav.tsx').replaceAll('\\', '/'))};
import {fixture} from 'profile-modal-fake';
function App({navigation=false}){const [open,setOpen]=useState(false),[opener,setOpener]=useState(true);fixture.hide=()=>flushSync(()=>setOpen(false));fixture.removeOpener=()=>flushSync(()=>setOpener(false));
 return <>{navigation?<MobileNav/>:opener&&<button id="opener" onClick={()=>setOpen(true)}>Synthetic opener</button>}<button id="outside">Outside</button>
 {open&&<ProfileDialog onClose={()=>{fixture.remember();fixture.closes++;setOpen(false);}}/>}<button id="after">After</button></>;}
let app;fixture.mount=(navigation=false)=>{fixture.reset();app=createRoot(document.getElementById('root'));flushSync(()=>app.render(<App navigation={navigation}/>));};
fixture.unmount=()=>{fixture.remember();flushSync(()=>app.unmount());};
document.addEventListener('keydown',event=>{if(event.key==='Escape')fixture.outerEscapes++;});
fixture.mount();window.__profileModal=fixture;`;
  const result = await esbuild.build({ stdin: { contents: entry, resolveDir: frontend, sourcefile: 'profile-modal-owned.tsx', loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://profile.example.test', VITE_SUPABASE_ANON_KEY: 'synthetic-public-key' }) },
    plugins: [{ name: 'isolated-profile-modal', setup(build: any) {
      build.onResolve({ filter: /^(profile-modal-fake|@\/contexts\/AuthContext|@\/lib\/supabase|sonner|wouter|\.\/PushSettings)$/ }, () => ({ path: 'mocks', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: mocks, loader: 'tsx', resolveDir: frontend }));
      build.onResolve({ filter: /^@\// }, (args: { path: string }) => ({ path: path.join(frontend, 'src', args.path.slice(2) + '.ts') }));
    } }],
  });
  return result.outputFiles[0].text;
}

type Cdp = { call(method: string, params?: Record<string, unknown>): Promise<any>; close(): void };
async function connect(url: string, events: (method: string, params: any) => void): Promise<Cdp> {
  const ws = new WebSocket(url), pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let id = 0;
  ws.addEventListener('message', event => {
    const data = JSON.parse(String(event.data));
    if (!data.id) { events(data.method, data.params); return; }
    const item = pending.get(data.id); if (!item) return;
    clearTimeout(item.timer); pending.delete(data.id);
    if (data.error) item.reject(Error(JSON.stringify(data.error))); else item.resolve(data.result);
  });
  ws.addEventListener('close', () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('Owned browser closed')); } pending.clear(); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(Error('Owned browser connection timed out')); }, 10_000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('Owned browser connection failed')); }, { once: true });
  });
  return { call(method, params = {}) { return new Promise((resolve, reject) => {
    const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(Error('Owned CDP timeout: ' + method)); }, 15_000);
    pending.set(next, { resolve, reject, timer }); ws.send(JSON.stringify({ id: next, method, params }));
  }); }, close() { ws.close(); } };
}

test('owned React ProfileDialog keyboard/focus modality at 390px and 1440px', { timeout: 180_000 }, async t => {
  t.after(() => esbuild.stop());
  const executable = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
  assert.ok(executable, 'Installed Chromium required; no install/download fallback');
  const script = await bundle();
  // Owned geometry only, not an application build or visual redesign.
  const stylesheet = await readFile(path.join(frontend, 'src/index.css'), 'utf8');
  const controls = ['neu-input', 'neu-btn', 'neu-btn-primary', 'neu-icon-btn', 'mobile-nav-backdrop', 'mobile-nav-sheet'].map(name => {
    const rule = stylesheet.match(new RegExp(`\\.${name}\\s*\\{[^}]+\\}`)); assert.ok(rule); return rule[0];
  }).join('\n');
  const server = createServer((req, res) => {
    if (req.headers.host !== `127.0.0.1:${(server.address() as { port: number }).port}` || req.method !== 'GET' || !['/', '/bundle.js', '/favicon.ico'].includes(req.url ?? '')) { res.writeHead(403); res.end(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; form-action 'none'; frame-src 'none'");
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(script); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      *{box-sizing:border-box}body{margin:0}button{min-height:32px}label{display:block}input{max-width:100%}
      .fixed{position:fixed}.inset-0{inset:0}.flex{display:flex}.items-center{align-items:center}.justify-center{justify-content:center}
      .justify-between{justify-content:space-between}.p-4{padding:16px}.p-7{padding:28px}.w-full{width:100%}
      [role=dialog]{max-width:360px;max-height:90dvh;overflow-y:auto;background:white}.space-y-3>*+*,.space-y-4>*+*{margin-top:12px}
      .mobile-bottom-nav{position:fixed;bottom:0;display:flex;width:100%;background:white}@media(min-width:1024px){.lg\\:hidden{display:none}}
      ${controls}</style></head><body><div id="root"></div><button id="replacement">Replacement screen</button><script src="/bundle.js"></script></body></html>`);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const profile = await mkdtemp(path.join(tmpdir(), 'medina-profile-modal-owned-'));
  const child = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--disable-sync',
    '--disable-component-update', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { windowsHide: true, stdio: 'ignore', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'HOME', 'DISPLAY'].includes(key))) });
  let cdp: Cdp | undefined;
  const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
  t.after(async () => {
    if (cdp) await cdp.call('Browser.close').catch(() => {});
    await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([exited, delay(5000)]); }
    cdp?.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(profile), path.resolve(tmpdir())); assert.ok(path.basename(profile).startsWith('medina-profile-modal-owned-'));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  let port = '';
  for (let i = 0; i < 250; i++) {
    assert.equal(child.exitCode, null, 'Owned browser must remain live until cleanup');
    try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]; } catch {}
    if (/^\d+$/.test(port)) break; await delay(80);
  }
  assert.match(port, /^\d+$/);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const page = targets.find(value => value.type === 'page'); assert.ok(page);
  const requests: string[] = [], exceptions: unknown[] = [];
  cdp = await connect(page.webSocketDebuggerUrl, (method, params) => {
    if (method === 'Network.requestWillBeSent') requests.push(params.request.url);
    if (method === 'Runtime.exceptionThrown') exceptions.push(params.exceptionDetails);
  });
  await cdp.call('Network.enable'); await cdp.call('Runtime.enable');
  const evaluate = async <T = any>(body: string): Promise<T> => {
    const result = await cdp!.call('Runtime.evaluate', { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  await cdp.call('Page.navigate', { url: origin });
  let ready = false;
  for (let i = 0; i < 150; i++) { ready = await evaluate('return !!window.__profileModal'); if (ready) break; await delay(40); }
  assert.ok(ready, JSON.stringify(exceptions));
  const settle = () => evaluate('for(let i=0;i<25;i++)await new Promise(resolve=>setTimeout(resolve,0));');
  const fresh = async (patch = {}) => {
    await evaluate(`const f=window.__profileModal;f.unmount();f.mount();f.patch(${JSON.stringify(patch)});`);
    await open();
  };
  const open = () => evaluate("const node=document.getElementById('opener');node.focus({preventScroll:true});node.click();");
  const key = async (key: string, shift = false) => {
    const value = key === 'Tab' ? 9 : 27;
    await cdp!.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: value, modifiers: shift ? 8 : 0 });
    await cdp!.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: value, modifiers: shift ? 8 : 0 });
  };
  const inside = () => evaluate("return !!document.querySelector('[role=dialog]')?.contains(document.activeElement)");
  const closed = async (restore: boolean) => {
    await settle();
    assert.deepEqual(await evaluate(`const f=window.__profileModal;return{visible:!!document.querySelector('[role=dialog]'),closes:f.closes,
      restored:document.activeElement===document.getElementById('opener'),listeners:f.listenerCount(),secrets:f.detached.map(node=>[node.value,node.defaultValue,node.getAttribute('value')])};`),
    { visible: false, closes: 1, restored: restore, listeners: 0, secrets: [['', '', null], ['', '', null], ['', '', null]] });
  };

  for (const width of [390, 1440]) {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
    if (width === 390) for (const method of ['Escape', 'cancel'] as const) {
      await t.test(`real MobileNav -> ProfileDialog ${method} returns focus to the retained More button`, async () => {
        await evaluate("const f=window.__profileModal;f.unmount();f.mount(true);const more=document.querySelector('[aria-label=\"Ещё разделы\"]');more.focus();more.click()");
        try {
          await evaluate("[...document.querySelectorAll('.mobile-nav-sheet button')].find(n=>n.textContent.includes('Профиль и пароль')).click()");
          assert.equal(await inside(), true);
          assert.equal(await evaluate("return document.body.style.position"), 'fixed', 'The profile must own the scroll lock after the drawer releases its lock');
          if (method === 'Escape') await key('Escape');
          else await evaluate("[...document.querySelectorAll('[role=dialog] button')].find(n=>n.textContent==='Отмена').click()");
          await settle();
          assert.deepEqual(await evaluate("return {profile:!!document.querySelector('[aria-label=\"Профиль сотрудника\"]'),drawer:!!document.getElementById('mobile-nav-drawer'),focused:document.activeElement.getAttribute('aria-label'),position:document.body.style.position,inert:document.getElementById('root').inert}"),
            { profile: false, drawer: false, focused: 'Ещё разделы', position: '', inert: false });
        } finally { await evaluate('window.__profileModal.unmount();window.__profileModal.mount()'); }
      });
    }
    await t.test(`${width}px short viewport keeps the keyboard-wrapped button inside the dialog's visible scroll area`, async () => {
      await cdp!.call('Emulation.setDeviceMetricsOverride', { width, height: 480, deviceScaleFactor: 1, mobile: width === 390 });
      try {
        await fresh();
        assert.ok(await evaluate("const panel=document.querySelector('[role=dialog]');return panel.scrollHeight>panel.clientHeight"), 'Positive control requires a genuinely overflowing dialog');
        await key('Tab', true); await settle();
        const result = await evaluate("const p=document.querySelector('[role=dialog]'),r=p.getBoundingClientRect(),b=document.activeElement.getBoundingClientRect();return{label:document.activeElement.textContent,visible:b.top>=r.top&&b.bottom<=r.bottom,scroll:p.scrollTop}");
        assert.equal(result.label, 'Сохранить'); assert.equal(result.visible, true); assert.ok(result.scroll > 0);
        await key('Tab'); await settle();
        assert.ok(await evaluate("const p=document.querySelector('[role=dialog]'),r=p.getBoundingClientRect(),b=document.activeElement.getBoundingClientRect();return document.activeElement.getAttribute('aria-label')==='Закрыть профиль'&&b.top>=r.top&&b.bottom<=r.bottom"));
      } finally {
        await evaluate('window.__profileModal.hide()');
        await cdp!.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
      }
    });
    await t.test(`${width}px native backdrop wheel cannot move the page; close restores its original scroll`, async () => {
      await evaluate("const f=window.__profileModal;f.unmount();f.mount();document.body.style.minHeight='3000px';window.scrollTo(0,240)");
      const paint = () => evaluate('await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);');
      const wheel = async () => {
        await cdp!.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 2, y: 400, deltaX: 0, deltaY: 500 });
        await paint();
      };
      try {
        await paint(); assert.equal(await evaluate('return window.scrollY'), 240);
        await open(); await paint();
        const before = await evaluate('return {x:window.scrollX,y:window.scrollY}');
        await wheel();
        assert.deepEqual(await evaluate('return {x:window.scrollX,y:window.scrollY}'), before, 'Native wheel must not move the background');
        assert.deepEqual(await evaluate("return {body:document.body.style.position,top:document.body.style.top,overflow:document.documentElement.style.overflow}"),
          { body: 'fixed', top: '-240px', overflow: 'hidden' });
        await key('Escape'); await closed(true); await paint();
        assert.equal(await evaluate('return window.scrollY'), 240);
        await wheel(); assert.ok(await evaluate('return window.scrollY>240'), 'Closing must restore usable page scrolling, not swallow the wheel');
      } finally {
        await evaluate("window.__profileModal.hide();document.body.style.removeProperty('min-height');window.scrollTo(0,0)");
      }
    });
    await t.test(`${width}px scroll cleanup preserves incoming inline styles and later owners' changes`, async () => {
      await evaluate("const f=window.__profileModal;f.unmount();f.mount();document.documentElement.style.setProperty('overflow','scroll','important');document.body.style.setProperty('position','relative');document.body.style.setProperty('width','97%','important')");
      try {
        await open();
        assert.equal(await evaluate('return document.body.style.position'), 'fixed');
        await evaluate("document.body.style.setProperty('width','98%','important')");
        await key('Escape'); await settle();
        assert.deepEqual(await evaluate("return {overflow:document.documentElement.style.overflow,priority:document.documentElement.style.getPropertyPriority('overflow'),position:document.body.style.position,width:document.body.style.width,widthPriority:document.body.style.getPropertyPriority('width')}"),
          { overflow: 'scroll', priority: 'important', position: 'relative', width: '98%', widthPriority: 'important' });
      } finally {
        await evaluate("window.__profileModal.hide();document.documentElement.style.removeProperty('overflow');document.body.style.removeProperty('position');document.body.style.removeProperty('width')");
      }
    });
    for (const change of ['account', 'workspace'] as const) await t.test(`${width}px ${change} change releases the lock without restoring an old screen's scroll`, async () => {
      await evaluate("const f=window.__profileModal;f.unmount();f.mount();document.body.style.minHeight='3000px';window.scrollTo(0,240)");
      await open();
      await evaluate("window.__priorScrollTo=window.scrollTo;window.__scrollRestores=[];window.scrollTo=function(...args){window.__scrollRestores.push(args);return window.__priorScrollTo.apply(window,args)}");
      try {
        if (change === 'account') await evaluate("window.__profileModal.actor('B')");
        else { await evaluate("window.__profileModal.patch({clinicId:'replacement-workspace'})"); await key('Escape'); }
        await settle();
        assert.deepEqual(await evaluate("return {profile:!!document.querySelector('[role=dialog]'),position:document.body.style.position,restores:window.__scrollRestores}"),
          { profile: false, position: '', restores: [] });
      } finally {
        await evaluate("window.scrollTo=window.__priorScrollTo;delete window.__priorScrollTo;window.__profileModal.hide();document.body.style.removeProperty('min-height');window.scrollTo(0,0)");
      }
    });
    await t.test(`${width}px focus entry, native Tab/Shift-Tab wrap and programmatic containment`, async () => {
      await fresh();
      assert.equal(await inside(), true, 'Opening the modal must move focus off the opener');
      assert.equal(await evaluate("return document.activeElement.getAttribute('aria-label')"), 'Закрыть профиль');
      for (const id of ['profile-full-name', 'profile-current-password', 'profile-new-password', 'profile-repeat-password']) {
        await key('Tab'); assert.equal(await evaluate('return document.activeElement.id'), id);
      }
      for (const label of ['Отмена', 'Сохранить']) {
        await key('Tab'); assert.equal(await evaluate('return document.activeElement.textContent'), label);
      }
      await key('Tab');
      assert.equal(await evaluate("return document.activeElement.getAttribute('aria-label')"), 'Закрыть профиль');
      await key('Tab', true);
      assert.equal(await evaluate("return document.activeElement.textContent"), 'Сохранить');
      await evaluate("document.getElementById('outside').focus()"); assert.equal(await inside(), true);
      await evaluate("window.__profileModal.latePush();document.getElementById('synthetic-push').focus()");
      await key('Tab'); assert.equal(await evaluate("return document.activeElement.id"), 'profile-current-password');
    });
    for (const mode of ['Escape', 'backdrop', 'cancel', 'close'] as const) {
      await t.test(`${width}px ${mode} closes once, clears secrets and restores the same opener`, async () => {
        await fresh(); await evaluate("window.__profileModal.passwords();document.getElementById('profile-new-password').focus()");
        if (mode === 'Escape') await key('Escape');
        else if (mode === 'backdrop') {
          await cdp!.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 2, y: 2, button: 'left', clickCount: 1 });
          await cdp!.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: 2, button: 'left', clickCount: 1 });
        } else await evaluate(mode === 'close' ? "document.querySelector('[aria-label=\"Закрыть профиль\"]').click()" : "document.querySelector('.neu-btn').click()");
        await closed(true); await key('Escape'); assert.equal(await evaluate('return window.__profileModal.closes'), 1);
      });
    }
    await t.test(`${width}px same-session refresh preserves focused field and successful save restores opener`, async () => {
      await fresh(); await evaluate("document.getElementById('profile-new-password').focus();window.__profileModal.refresh()");
      assert.equal(await evaluate('return document.activeElement.id'), 'profile-new-password');
      await evaluate('window.__profileModal.passwords();window.__profileModal.save();window.__profileModal.resolveVerify()'); await settle();
      await closed(true);
      assert.deepEqual(await evaluate('return window.__profileModal.requests.map(value=>value.method)'), ['GET', 'PUT']);
      assert.equal(await evaluate('return window.__profileModal.messages.length'), 1);
    });
    for (const stage of ['verification', 'PUT'] as const) {
      await t.test(`${width}px busy ${stage} traps both Tab directions and refuses all dismissal paths`, async () => {
        await fresh();
        await evaluate(`const f=window.__profileModal;f.pause='PUT';f.passwords();document.querySelector('.neu-btn-primary').focus();f.save();${stage === 'PUT' ? 'f.resolveVerify();' : ''}`);
        await settle(); assert.equal(await evaluate('return window.__profileModal.stage'), stage);
        assert.equal(await inside(), true, 'Disabled save controls need a focusable modal fallback');
        await key('Tab'); assert.equal(await inside(), true); await key('Tab', true); assert.equal(await inside(), true);
        await key('Escape');
        assert.equal(await evaluate('return window.__profileModal.outerEscapes'), 0, 'Busy Escape must not dismiss an ancestor surface');
        await evaluate("document.querySelector('[role=dialog]').parentElement.click();document.querySelector('.neu-btn').click();document.querySelector('[aria-label=\"Закрыть профиль\"]').click()");
        assert.equal(await evaluate('return window.__profileModal.closes'), 0);
        assert.equal(await evaluate("return !!document.querySelector('[role=dialog]')"), true);
        await evaluate('window.__profileModal.responseError=true;window.__profileModal.resolveVerify();window.__profileModal.resolveNetwork()'); await settle();
        assert.equal(await inside(), true); await key('Tab'); assert.equal(await inside(), true);
        await key('Escape'); await closed(true);
      });
    }
    for (const [scope, patch] of [
      ['workspace', { clinicId: 'synthetic-other' }],
      ['role', { userRole: 'doctor' }],
      ['purpose', { workspacePurpose: 'synthetic-other' }],
      ['permissions', { rolePermissions: { crm: true } }],
    ] as const) {
      await t.test(`${width}px context-only ${scope} change retains containment and Escape without old-opener restoration`, async () => {
        await fresh();
        await evaluate(`const f=window.__profileModal;f.passwords();document.getElementById('profile-new-password').focus();
          window.__restored=0;document.getElementById('opener').addEventListener('focus',()=>window.__restored++);f.patch(${JSON.stringify(patch)});`);
        assert.deepEqual(await evaluate(`return {visible:!!document.querySelector('[role=dialog]'),closes:window.__profileModal.closes,
          focused:document.activeElement.id,passwords:[...document.querySelectorAll('input[type=password]')].map(node=>node.value)};`),
        { visible: true, closes: 0, focused: 'profile-new-password', passwords: ['SyntheticCurrent42', 'SyntheticNew42', 'SyntheticNew42'] });
        await evaluate("document.querySelector('.neu-btn-primary').focus()"); await key('Tab');
        assert.equal(await evaluate("return document.activeElement.getAttribute('aria-label')"), 'Закрыть профиль');
        await key('Tab', true); assert.equal(await evaluate('return document.activeElement.textContent'), 'Сохранить');
        await evaluate("document.getElementById('outside').focus()"); assert.equal(await inside(), true);
        await key('Escape'); await closed(false);
        assert.equal(await evaluate('return window.__restored'), 0);
        await evaluate("document.getElementById('replacement').focus()"); await key('Escape');
        assert.deepEqual(await evaluate("const f=window.__profileModal;return {focused:document.activeElement.id,closes:f.closes,requests:f.requests,messages:f.messages}"),
        { focused: 'replacement', closes: 1, requests: [], messages: [] });
      });
      await t.test(`${width}px context-only ${scope} change preserves the original-account save and busy containment`, async () => {
        await fresh();
        await evaluate(`const f=window.__profileModal;f.passwords();f.fill('profile-full-name','Personal A');
          window.__restored=0;document.getElementById('opener').addEventListener('focus',()=>window.__restored++);f.patch(${JSON.stringify(patch)});
          f.pause='PUT';document.querySelector('.neu-btn-primary').focus();f.save();`);
        await settle(); assert.equal(await evaluate('return window.__profileModal.stage'), 'verification');
        assert.equal(await inside(), true);
        await key('Tab'); assert.equal(await inside(), true); await key('Tab', true); assert.equal(await inside(), true);
        await key('Escape');
        assert.deepEqual(await evaluate("const f=window.__profileModal;return {closes:f.closes,outerEscapes:f.outerEscapes,visible:!!document.querySelector('[role=dialog]')}"),
        { closes: 0, outerEscapes: 0, visible: true });
        await evaluate('window.__profileModal.resolveVerify()'); await settle();
        assert.equal(await evaluate('return window.__profileModal.stage'), 'PUT');
        assert.equal(await inside(), true); await key('Escape');
        assert.equal(await evaluate('return window.__profileModal.closes'), 0);
        await evaluate('window.__profileModal.resolveNetwork()'); await closed(false);
        assert.deepEqual(await evaluate('return window.__profileModal.requests'), [
          { method: 'GET', actor: 'A', updates: null },
          { method: 'PUT', actor: 'A', updates: { data: { full_name: 'Personal A' }, password: 'SyntheticNew42', code_challenge: null, code_challenge_method: null } },
        ]);
        assert.equal(await evaluate("return window.__profileModal.messages.filter(value=>value.startsWith('success:')).length"), 1);
        assert.equal(await evaluate('return window.__restored'), 0);
      });
    }
    for (const mode of ['account-B', 'SDK-ABA', 'new-session', 'signout', 'impersonation', 'demo'] as const) {
      await t.test(`${width}px ${mode} invalidation never restores an old actor or admits late verification`, async () => {
        await fresh(); await evaluate('window.__profileModal.passwords();window.__profileModal.save();window.__profileModal.remember()');
        const change = mode === 'account-B' ? "f.actor('B')" : mode === 'SDK-ABA' ? 'f.aba()' : mode === 'new-session' ? "f.emit('A','SIGNED_IN','two')"
          : mode === 'signout' ? 'f.patch({isSigningOut:true})' : mode === 'impersonation' ? 'f.patch({isImpersonation:true})' : 'f.patch({isDemoMode:true})';
        await evaluate(`const f=window.__profileModal;window.__restored=0;document.getElementById('opener').addEventListener('focus',()=>window.__restored++);${change};`);
        await closed(false); assert.equal(await evaluate('return window.__restored'), 0);
        await evaluate("document.getElementById('replacement').focus();window.__profileModal.resolveVerify();window.__profileModal.resolveNetwork()"); await settle();
        await key('Tab'); await evaluate("document.getElementById('replacement').focus()"); await key('Escape');
        assert.deepEqual(await evaluate("const f=window.__profileModal;return{focus:document.activeElement.id,requests:f.requests,messages:f.messages,closes:f.closes,restored:window.__restored}"),
        { focus: 'replacement', requests: [], messages: [], closes: 1, restored: 0 });
      });
    }
    for (const mode of ['B', 'ABA', 'new-session', 'signout'] as const) {
      await t.test(`${width}px queued restoration is revoked by SDK ${mode} after close/unmount`, async () => {
        await fresh();
        await evaluate(`const f=window.__profileModal;window.__restored=0;document.getElementById('opener').addEventListener('focus',()=>window.__restored++);
          document.querySelector('.neu-btn').click();f.hide();${mode === 'B' ? "f.emit('B')" : mode === 'ABA' ? 'f.aba()' : mode === 'new-session' ? "f.emit('A','SIGNED_IN','two')" : 'f.emit(null)'};`);
        await closed(false); assert.equal(await evaluate('return window.__restored'), 0);
      });
    }
    await t.test(`${width}px queued restoration survives a same-session SDK refresh`, async () => {
      await fresh();
      await evaluate("const f=window.__profileModal;document.querySelector('.neu-btn').click();f.hide();f.refresh()");
      await closed(true);
    });
    for (const mode of ['removed', 'hidden', 'disabled', 'inert', 'new-focus', 'workspace', 'role', 'purpose'] as const) {
      await t.test(`${width}px ${mode} opener/UI cannot receive restoration`, async () => {
        await fresh(); await evaluate('window.__profileModal.passwords()');
        const change = mode === 'removed' ? 'f.removeOpener()' : mode === 'hidden' ? 'node.hidden=true' : mode === 'disabled' ? 'node.disabled=true'
          : mode === 'inert' ? "node.setAttribute('inert','')" : mode === 'new-focus' ? ''
          : mode === 'workspace' ? "f.patch({clinicId:'synthetic-other'})" : mode === 'role' ? "f.patch({userRole:'doctor'})" : "f.patch({workspacePurpose:'synthetic-other'})";
        await evaluate(`const f=window.__profileModal,node=document.getElementById('opener');window.__restored=0;node.addEventListener('focus',()=>window.__restored++);${change};
          document.querySelector('.neu-btn').click();${mode === 'new-focus' ? "document.getElementById('replacement').focus();" : ''}`);
        await closed(false); assert.equal(await evaluate('return window.__restored'), 0);
      });
    }
    await t.test(`${width}px unmount during issued PUT releases listeners and ignores the late result`, async () => {
      await fresh(); await evaluate("const f=window.__profileModal;f.pause='PUT';f.passwords();f.save();f.resolveVerify()"); await settle();
      assert.equal(await evaluate('return window.__profileModal.stage'), 'PUT');
      await evaluate("window.__profileModal.unmount();document.getElementById('replacement').focus();window.__profileModal.resolveNetwork()"); await settle();
      await key('Escape'); await key('Tab'); await evaluate("document.getElementById('replacement').focus()");
      assert.deepEqual(await evaluate("const f=window.__profileModal;return{focus:document.activeElement.id,visible:!!document.querySelector('[role=dialog]'),closes:f.closes,messages:f.messages,secrets:f.detached.map(node=>node.value)}"),
      { focus: 'replacement', visible: false, closes: 0, messages: [], secrets: ['', '', ''] });
      await evaluate('window.__profileModal.mount()');
    });
    await t.test(`${width}px read-only demo has usable focus, wrap and Escape without an auth session`, async () => {
      await fresh({ session: null, user: null, isDemoMode: true }); assert.equal(await inside(), true);
      await key('Tab', true); assert.equal(await evaluate('return document.activeElement.textContent'), 'Отмена');
      await key('Escape'); await settle();
      assert.deepEqual(await evaluate("const f=window.__profileModal;return{visible:!!document.querySelector('[role=dialog]'),closes:f.closes,restored:document.activeElement.id,requests:f.requests}"),
      { visible: false, closes: 1, restored: 'opener', requests: [] });
    });
  }
  assert.deepEqual(exceptions, []);
  assert.ok(requests.length > 0 && requests.every(url => url.startsWith(origin + '/')), JSON.stringify(requests));
});

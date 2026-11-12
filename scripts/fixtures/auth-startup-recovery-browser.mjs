import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const frontend = path.join(root, 'artifacts/negis');
const frontendRequire = createRequire(path.join(frontend, 'package.json'));
const localKey = 'synthetic-startup-key-not-a-credential';
const syntheticPassword = 'SyntheticRecovery42!';
export const ids = Object.freeze({ A: '11111111-1111-4111-8111-111111111111', B: '22222222-2222-4222-8222-222222222222', workspace: '33333333-3333-4333-8333-333333333333' });
export const limits = Object.freeze({ bodyBytes: 8192, requests: 4096, authPerCase: 48, held: 4, heldLeaseMs: 20_000, events: 256 });
export const scope = 'Actual App/AuthProvider/ResetPassword/portals, actual public sessionAuth facade and frontend SDK 2.118.0. Synthetic loopback startup/recovery, actual SDK URL/user/OTP/update HTTP, and one labelled same-document B caller. Positive owner-Control enters the actual Dashboard with four exact read-only empty list DTOs. No SDK method doubles, private SDK mutation, real service, server authorization, delivery, two-tab, operational-data or broad-readiness claim. Does not repeat the prior 25 authority browser cases.';
export const coverageGaps = Object.freeze({
  clock: 'Native Date/SDK time only; this fixture has no clock API and never waits 15 minutes.',
  expiryNotExercised: [
    'Proof expiresAt boundary: min(native expires_at, native PASSWORD_RECOVERY issue time + 15 minutes).',
    'Same-actor TOKEN_REFRESHED preserves the original proof deadline rather than extending it.',
    'Recovery UI retires its form at the original proof deadline, including after a refresh.',
  ],
  delegatedExpiryChecks: 'Main proof-service units and Agent A recovery-UI clock units; their results are not asserted by this browser fixture.',
});
export const caseNames = Object.freeze(['no-hash', 'forged-user-metadata', 'forged-query-marker', 'expired-link', 'valid-recovery', 'held-recovery-validation', 'held-impersonation-verify', 'held-impersonation-otp']);
const sha = value => createHash('sha256').update(value).digest('hex');
const businessPaths = ['/api/crm/auth-context', '/api/crm/operator-account', '/api/crm/contributor-account'];
const dashboardLists = Object.freeze({ '/api/crm/appointments': 'appointments', '/api/crm/leads': 'leads', '/api/crm/clients': 'clients', '/api/crm/deals': 'deals' });
const appRoutes = new Set(['/', '/reset-password', '/operator', '/contributors', '/login', '/privacy', '/terms', '/dashboard']);
let esbuild;
export const stopStartupRecoveryBuilds = () => esbuild?.stop();

export function startupRequestAllowed(req, origin) {
  if (!origin || !['GET', 'POST', 'PUT'].includes(req.method) || req.headers.host !== new URL(origin).host
    || !req.url?.startsWith('/') || req.url.startsWith('//') || /[\\\u0000-\u0020]/.test(req.url)) return false;
  for (const key of ['origin', 'referer']) {
    if (req.headers[key]) {
      try { if (new URL(req.headers[key]).origin !== origin) return false; } catch { return false; }
    }
  }
  return req.headers['sec-fetch-site'] !== 'cross-site';
}

export function startupOperation(method, url) {
  if (url.search) return null;
  if (url.pathname === '/auth/v1/user' && method === 'GET') return 'user';
  if (url.pathname === '/auth/v1/user' && method === 'PUT') return 'password-put';
  if (url.pathname === '/auth/v1/verify' && method === 'POST') return 'otp';
  if (url.pathname === '/api/impersonation/verify' && method === 'POST') return 'imp-verify';
  if (url.pathname === '/api/impersonation/session' && method === 'POST') return 'imp-session';
  return null;
}

function makeSessions() {
  const now = Math.floor(Date.now() / 1000), exp = now + 86400;
  return Object.fromEntries(Object.entries(ids).filter(([actor]) => actor !== 'workspace').map(([actor, id]) => {
    const user = { id, email: `startup-${actor.toLowerCase()}@example.test`, aud: 'authenticated', role: 'authenticated',
      app_metadata: {}, user_metadata: { full_name: 'PRIVATE STARTUP ' + actor }, created_at: '2026-01-01T00:00:00Z' };
    const access_token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: id, aud: 'authenticated', role: 'authenticated', exp, iat: now,
        session_id: 'synthetic-startup-' + actor })).toString('base64url'), Buffer.from('synthetic-not-a-signature').toString('base64url')].join('.');
    return [actor, { access_token, refresh_token: 'synthetic-startup-refresh-' + actor, expires_in: 86400, expires_at: exp,
      token_type: 'bearer', user }];
  }));
}

const boot = String.raw`
const denied=[],traffic=[];let pending=0;
const storageListeners=new Set(),visibilityListeners=new Set();
for(const [target,type,listeners]of[[window,'storage',storageListeners],[document,'visibilitychange',visibilityListeners]]){
  const add=target.addEventListener.bind(target),remove=target.removeEventListener.bind(target);
  target.addEventListener=(name,callback,options)=>{if(name===type)listeners.add(callback);return add(name,callback,options);};
  target.removeEventListener=(name,callback,options)=>{if(name===type)listeners.delete(callback);return remove(name,callback,options);};
}
window.__startupListeners=()=>({storage:storageListeners.size,visibility:visibilityListeners.size});
const refuse=(kind,details={})=>{denied.push({kind,...details});throw Error('Closed synthetic startup fixture: '+kind);};
const allowed=(method,url)=>url.origin===location.origin&&!url.hash&&!url.username&&!url.password&&((!url.search&&(
  (method==='GET'&&['/auth/v1/user','/api/crm/auth-context','/api/crm/operator-account','/api/crm/contributor-account'].includes(url.pathname))||
  (method==='PUT'&&url.pathname==='/auth/v1/user')||
  (method==='POST'&&['/auth/v1/verify','/api/impersonation/verify','/api/impersonation/session'].includes(url.pathname))))||
  (setup.positiveOwner&&method==='GET'&&['/api/crm/appointments','/api/crm/leads','/api/crm/clients','/api/crm/deals'].includes(url.pathname)
    &&[...url.searchParams].length===1&&url.searchParams.get('workspaceId')===setup.workspaceId));
const nativeFetch=window.fetch.bind(window);
window.fetch=async(input,init={})=>{
  const url=new URL(input instanceof Request?input.url:String(input),location.origin),method=(init.method||(input instanceof Request?input.method:'GET')).toUpperCase();
  if(!allowed(method,url))return refuse('fetch',{method,path:url.pathname});
  if(traffic.length>=256)return refuse('fetch-state-cap');
  const item={method,path:url.pathname,done:false};traffic.push(item);pending++;
  try{return await nativeFetch(input,{...init,redirect:'error',credentials:'omit'});}finally{pending--;item.done=true;}
};
XMLHttpRequest.prototype.open=function(){return refuse('XMLHttpRequest');};
for(const name of['WebSocket','EventSource','Worker','SharedWorker'])if(name in window)window[name]=class{constructor(){refuse(name);}};
if(navigator.serviceWorker)navigator.serviceWorker.register=()=>Promise.reject(Error('No service worker in owned startup fixture'));
Object.defineProperty(navigator,'sendBeacon',{configurable:true,value:()=>{denied.push({kind:'beacon'});return false;}});
window.open=()=>{denied.push({kind:'window.open'});return null;};
document.addEventListener('securitypolicyviolation',event=>denied.push({kind:'CSP',directive:event.effectiveDirective}));
document.addEventListener('click',event=>{const link=event.target instanceof Element?event.target.closest('a[href]'):null;
  if(link&&new URL(link.href).origin!==location.origin){event.preventDefault();denied.push({kind:'external-link'});}},true);
window.__startupNetwork={denied,traffic,get pending(){return pending;}};
localStorage.clear();sessionStorage.clear();
const storageKey='sb-'+new URL(location.origin).hostname.split('.')[0]+'-auth-token';
if(setup.seed){const session=structuredClone(sessions[setup.seed]);if(setup.forged)session.user.user_metadata={...session.user.user_metadata,recovery:true,password_recovery:true,type:'recovery'};
  localStorage.setItem(storageKey,JSON.stringify(session));}
let route=setup.route;
if(setup.recovery){const s=sessions.A;route+='#'+new URLSearchParams({access_token:s.access_token,refresh_token:s.refresh_token,
  token_type:'bearer',expires_in:String(s.expires_in),expires_at:String(s.expires_at),type:'recovery'});}
history.replaceState(null,'',route);window.__startupCase=setup.name;window.__startupCaseRun=setup.caseRun;
await import('/entry.js');
`;

const entry = String.raw`
import React from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
import App from'./src/App';import{sessionAuth,supabase}from'./src/lib/supabase';
const sessions=__STARTUP_SESSIONS__,storageKey='sb-'+new URL(location.origin).hostname.split('.')[0]+'-auth-token';
if(typeof sessionAuth.setSession!=='function'||typeof sessionAuth.dispose!=='function'||typeof supabase.auth.dispose!=='function'||!navigator.locks)throw Error('Actual facade/proof disposal, public SDK dispose and Web Locks required');
const events=[],tasks=[],detached=[];let app,probe,watcher,watch=[],watchOverflow=false,retainedSubmit,retainedForm;
const frames=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
const hash=async raw=>raw===null?null:[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))].map(v=>v.toString(16).padStart(2,'0')).join('');
const actor=()=>JSON.parse(localStorage.getItem(storageKey)||'null')?.user?.id??null;
const f={run:crypto.randomUUID(),view:{isCurrentMutationScope:()=>true},caseName:window.__startupCase,caseRun:window.__startupCaseRun,
  observe(){if(probe)throw Error('Already observing');probe=sessionAuth.onAuthStateChange((event,session)=>{
    if(events.length>=256)throw Error('Auth event state cap');events.push({event,id:session?.user.id??null});}).data.subscription;},
  startB(){if(tasks.length)throw Error('Only one controlled replacement caller per startup case');
    const controller=new AbortController(),task={name:'replacement-B',done:false,error:null,current:true};tasks.push(task);
    task.controller=controller;task.promise=Promise.resolve().then(()=>sessionAuth.setSession({access_token:sessions.B.access_token,refresh_token:sessions.B.refresh_token},
      {isCurrent:()=>task.current,signal:controller.signal})).then(result=>{task.error=result.error?.name??(result.error?'SDKError':null);},
      error=>{task.error=error?.constructor?.name??'Error';}).finally(()=>{task.done=true;});},
  task(){const task=tasks[0];return task?{done:task.done,error:task.error,current:task.current}:null;},
  remember(){detached.length=0;detached.push(...document.querySelectorAll('input[name=password],input[name=confirm],input[type=password]'));},
  fill(selector,value){const node=document.querySelector(selector);if(!node||node.disabled)throw Error('Missing enabled field '+selector);
    flushSync(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));});},
  submit(){const form=document.querySelector('form:has(input[name=password])');if(!form)throw Error('Missing actual recovery form');
    const button=form.querySelector('button[type=submit]');if(!button||button.disabled)throw Error('Missing enabled recovery submit');flushSync(()=>button.click());},
  retainSubmit(){const form=document.querySelector('form:has(input[name=password])');if(!form)throw Error('Missing recovery form');
    retainedForm=form;retainedSubmit=form[Object.keys(form).find(key=>key.startsWith('__reactProps$'))]?.onSubmit;},
  async invokeRetiredSubmit(){if(typeof retainedSubmit!=='function')throw Error('Missing retained real submit handler');
    await retainedSubmit({preventDefault(){},persist(){},target:retainedForm,currentTarget:retainedForm,type:'submit'});},
  navigate(route){if(!['/operator','/privacy'].includes(route))throw Error('Owned route only');flushSync(()=>history.pushState(null,'',route));},
  watchPrivate(){watcher?.disconnect();watch=[];watchOverflow=false;const take=()=>{const text=document.getElementById('root').textContent;
    if(watch.length>=256){watchOverflow=true;return;}
    watch.push({A:text.includes('PRIVATE STARTUP A'),success:text.includes('\u041f\u0430\u0440\u043e\u043b\u044c \u043e\u0431\u043d\u043e\u0432\u043b\u0451\u043d'),recoveryForm:!!document.querySelector('form input[name=password]')});};
    watcher=new MutationObserver(take);watcher.observe(document.getElementById('root'),{subtree:true,childList:true,characterData:true});take();},
  async idle(){await frames();await new Promise(resolve=>setTimeout(resolve,80));await supabase.auth.getSession();await frames();},
  domSnapshot(){return{recoveryForm:!!document.querySelector('form input[name=password]'),text:(document.getElementById('root').textContent||'').slice(0,32000),events:[...events],network:window.__startupNetwork};},
  async snapshot(){const raw=localStorage.getItem(storageKey),{data,error}=await supabase.auth.getSession(),text=document.getElementById('root').textContent||'';
    let hint=null;try{const value=JSON.parse(localStorage.getItem('negis_impersonation')||'null');if(value)hint={actorId:value.auth_user_id??null,workspaceId:value.clinic_id??null};}catch{}
    return{caseName:this.caseName,caseRun:this.caseRun,run:this.run,path:location.pathname,queryKeys:[...new URLSearchParams(location.search).keys()],hashKeys:[...new URLSearchParams(location.hash.slice(1)).keys()],
      text:text.slice(0,32000),storedId:actor(),sdkId:data.session?.user.id??null,sdkError:!!error,storedHash:await hash(raw),
      revisionHash:await hash(localStorage.getItem(storageKey+'.medina-revision')),intentHash:await hash(localStorage.getItem(storageKey+'.medina-intent')),
      impersonationPresent:localStorage.getItem('negis_impersonation')!==null,impersonationHint:hint,privateA:text.includes('PRIVATE STARTUP A'),dashboardRendered:!!document.querySelector('.negis-app-shell .negis-main'),
      recoveryForm:!!document.querySelector('form input[name=password]'),success:text.includes('\u041f\u0430\u0440\u043e\u043b\u044c \u043e\u0431\u043d\u043e\u0432\u043b\u0451\u043d'),
      passwordLengths:[...document.querySelectorAll('input[name=password],input[name=confirm],input[type=password]')].map(node=>node.value.length),
      detachedPasswordLengths:detached.map(node=>node.value.length),events:[...events],task:this.task(),network:window.__startupNetwork,listeners:window.__startupListeners(),watch:[...watch],watchOverflow};},
  unmount(){if(app){this.remember();flushSync(()=>app.unmount());app=null;}},
  async shutdown(){this.unmount();watcher?.disconnect();probe?.unsubscribe();probe=null;
    for(const task of tasks){task.current=false;task.controller.abort();}
    let timer;try{await Promise.race([Promise.all(tasks.map(task=>task.promise)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Startup controlled tasks did not settle')),6000);})]);}
    finally{clearTimeout(timer);await sessionAuth.dispose();await supabase.auth.stopAutoRefresh();await supabase.auth.dispose();}
    return{rootChildren:document.getElementById('root').childElementCount,observerUnsubscribed:probe===null,facadeDisposed:true,sdkDisposed:true,
      pendingTasks:tasks.filter(task=>!task.done).length,pendingFetches:window.__startupNetwork.pending,denied:[...window.__startupNetwork.denied],watchOverflow,
      traffic:[...window.__startupNetwork.traffic],listeners:window.__startupListeners(),detachedPasswordLengths:detached.map(node=>node.value.length)};}
};
window.__appointmentRecovery=f;app=createRoot(document.getElementById('root'));flushSync(()=>app.render(<App/>));
`;

async function bundleRuntime(origin, sessions) {
  const sourceHashes = {};
  const record = async file => {
    const relative = path.relative(root, file).replaceAll('\\', '/');
    assert.ok(!relative.startsWith('../') && !/(^|\/)\.env(?:\.|$)/.test(relative), 'Closed source inputs only');
    const bytes = await readFile(file), hash = sha(bytes);
    if (sourceHashes[relative]) assert.equal(hash, sourceHashes[relative], 'Source changed during build: ' + relative);
    sourceHashes[relative] = hash; return bytes;
  };
  const sdkPath = frontendRequire.resolve('@supabase/supabase-js/package.json');
  const authPath = createRequire(sdkPath).resolve('@supabase/auth-js/package.json');
  for (const file of [sdkPath, authPath]) assert.equal(JSON.parse((await record(file)).toString()).version, '2.118.0');
  assert.equal(JSON.parse((await record(path.join(frontend, 'package.json'))).toString()).dependencies['@supabase/supabase-js'], '2.118.0');
  await record(path.join(path.dirname(authPath), 'src/GoTrueClient.ts'));
  esbuild = createRequire(frontendRequire.resolve('vite/package.json'))('esbuild');
  const result = await esbuild.build({ absWorkingDir: root, stdin: { contents: entry, resolveDir: frontend, loader: 'tsx', sourcefile: 'owned-startup-recovery.tsx' },
    bundle: true, write: false, platform: 'browser', format: 'esm', splitting: true, jsx: 'automatic', metafile: true,
    outdir: path.join(root, 'node_modules/.cache/startup-recovery-memory'), entryNames: 'entry', chunkNames: '[name]-[hash]',
    define: { 'process.env.NODE_ENV': '"production"', __STARTUP_SESSIONS__: JSON.stringify(sessions),
      'import.meta.env': JSON.stringify({ BASE_URL: '/', DEV: false, PROD: false, VITE_SUPABASE_URL: origin,
        VITE_SUPABASE_ANON_KEY: localKey, VITE_NEGIS_CONTROL_API_URL: origin }) },
    plugins: [{ name: 'actual-startup-sources-no-sdk-doubles', setup(build) {
      build.onResolve({ filter: /^@\// }, args => {
        const base = path.join(frontend, 'src', args.path.slice(2));
        const file = [base, base + '.ts', base + '.tsx', path.join(base, 'index.ts'), path.join(base, 'index.tsx')].find(existsSync);
        assert.ok(file, args.path); return { path: file };
      });
      build.onLoad({ filter: /\.(ts|tsx|css|mjs|js)$/, namespace: 'file' }, async args => {
        const relative = path.relative(root, args.path).replaceAll('\\', '/');
        if (!/^(artifacts\/negis\/src\/|lib\/|packages\/)/.test(relative) && !relative.includes('/@supabase/')) return;
        const extension = path.extname(args.path).slice(1);
        return { contents: await record(args.path), loader: extension === 'mjs' ? 'js' : extension, resolveDir: path.dirname(args.path) };
      });
    } }] });
  const inputs = Object.keys(result.metafile.inputs).map(file => file.replaceAll('\\', '/'));
  for (const [name, packagePath] of [['supabase-js', sdkPath], ['auth-js', authPath]]) {
    const matches = inputs.filter(file => file.includes('/@supabase/' + name + '/'));
    assert.ok(matches.length, 'Actual installed ' + name + ' must enter the bundle');
    for (const file of matches) assert.ok(path.resolve(root, file).startsWith(path.dirname(packagePath) + path.sep), 'Actual frontend-resolved SDK only');
  }
  for (const file of inputs.filter(file => file.includes('/@supabase/'))) await record(path.resolve(root, file));
  for (const file of ['App.tsx', 'contexts/AuthContext.tsx', 'pages/ResetPassword.tsx', 'lib/supabase.ts', 'lib/authSessionAuthority.ts'])
    assert.ok(sourceHashes['artifacts/negis/src/' + file], 'Actual composed runtime source required: ' + file);
  const tw = createRequire(frontendRequire.resolve('@tailwindcss/vite'));
  const { compile } = tw('@tailwindcss/node'), { Scanner } = tw('@tailwindcss/oxide');
  const dependencies = new Set(), css = path.join(frontend, 'src/index.css');
  const compiler = await compile((await record(css)).toString(), { base: path.dirname(css), onDependency: file => { if (file.startsWith(frontend + path.sep)) dependencies.add(file); } });
  const scanner = new Scanner({ sources: [{ base: path.join(frontend, 'src'), pattern: '**/*.{ts,tsx,css}', negated: false }] });
  const files = new Map(result.outputFiles.map(file => ['/' + path.basename(file.path), { bytes: file.contents, type: file.path.endsWith('.css') ? 'text/css' : 'application/javascript' }]));
  files.set('/style.css', { bytes: compiler.build(scanner.scan()), type: 'text/css' });
  for (const file of dependencies) await record(file);
  for (const name of ['inter-latin.woff2', 'inter-cyrillic.woff2', 'inter-cyrillic-ext.woff2'])
    files.set('/fonts/inter/' + name, { bytes: await record(path.join(frontend, 'public/fonts/inter', name)), type: 'font/woff2' });
  files.set('/favicon.svg', { bytes: await record(path.join(frontend, 'public/favicon.svg')), type: 'image/svg+xml' });
  for (const file of ['CLAUDE.md', 'scripts/fixtures/auth-startup-recovery-browser.mjs', 'scripts/fixtures/auth-startup-recovery-browser.test.mjs',
    'scripts/src/appointment-recovery-committed-fixture.ts', 'package.json', 'scripts/package.json', 'pnpm-lock.yaml']) await record(path.join(root, file));
  return { files, sourceHashes, sdk: { version: '2.118.0', package: path.relative(root, sdkPath).replaceAll('\\', '/'), authPackage: path.relative(root, authPath).replaceAll('\\', '/') } };
}

async function readBody(req) {
  assert.match(req.headers['content-type'] ?? '', /^application\/json(?:;|$)/i);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; assert.ok(size <= limits.bodyBytes); chunks.push(chunk); }
  const value = JSON.parse(Buffer.concat(chunks).toString()); assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value;
}

export async function createStartupRecoveryBrowser({ startupRecoveryRunAuthorized = false } = {}) {
  assert.equal(startupRecoveryRunAuthorized, true, 'Explicit initial-run authorization or final startup/recovery freeze is required');
  const sessions = makeSessions(), sockets = new Set(), held = new Map(), plans = [];
  let origin, bundle, activeCase, closed = false, sequence = 0, caseRequests = 0, caseSerial = 0;
  const controls = { requests: [], rejected: [], releases: [], mutations: [], bootHashes: [],
    configure(name, { positiveOwner = false } = {}) {
      assert.ok(caseNames.includes(name)); assert.equal(held.size, 0); assert.equal(plans.length, 0); caseRequests = 0;
      assert.ok(!positiveOwner || name === 'held-impersonation-otp', 'Positive owner startup uses the same held native OTP path');
      activeCase = { name, caseRun: ++caseSerial, route: '/reset-password', seed: ['no-hash', 'forged-user-metadata', 'forged-query-marker', 'expired-link'].includes(name) ? 'A' : null,
        forged: name === 'forged-user-metadata', recovery: ['valid-recovery', 'held-recovery-validation'].includes(name), positiveOwner, workspaceId: ids.workspace };
      if (name === 'forged-query-marker') activeCase.route += '?state=type=recovery';
      if (name === 'expired-link') activeCase.route += '#error=access_denied&error_code=otp_expired&type=recovery';
      if (name.startsWith('held-impersonation')) { activeCase.seed = 'A'; activeCase.route = '/operator?impersonate_token=synthetic-impersonation-A'; }
      if (name === 'held-recovery-validation') plans.push({ operation: 'user', actor: 'A', hold: true });
      if (name === 'held-impersonation-verify') plans.push({ operation: 'imp-verify', actor: 'A', hold: true });
      if (name === 'held-impersonation-otp') plans.push({ operation: 'otp', actor: 'A', hold: true });
    },
    holdPasswordPut() { assert.ok(activeCase); plans.push({ operation: 'password-put', actor: 'A', hold: true }); },
    pending: () => [...held.values()].map(({ id, operation, actor, res }) => ({ id, operation, actor, disconnected: res.destroyed })),
    unconsumed: () => plans.map(plan => ({ ...plan })),
    release(id) {
      const item = held.get(id); assert.ok(item, 'Existing held synthetic HTTP response'); held.delete(id); clearTimeout(item.timer);
      const receipt = { caseName: item.caseName, id, operation: item.operation, actor: item.actor, delivered: item.send() }; this.releases.push(receipt); return receipt;
    },
    releaseAll() { for (const id of [...held.keys()]) this.release(id); },
  };
  controls.configure('no-hash');
  const actorFrom = header => ['A', 'B'].find(actor => header === 'Bearer ' + sessions[actor].access_token);
  const reject = (req, res, reason) => { controls.rejected.push({ caseName: activeCase?.name, method: req.method, path: new URL(req.url, origin).pathname, reason }); res.writeHead(403).end(); };
  const handler = async (req, res) => {
    if (!startupRequestAllowed(req, origin)) return reject(req, res, 'host/origin/method');
    const url = new URL(req.url, origin);
    if (controls.requests.length >= limits.requests) return reject(req, res, 'request-state-cap');
    const item = { caseName: activeCase.name, caseRun: activeCase.caseRun, id: ++sequence, method: req.method, path: url.pathname }; controls.requests.push(item);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const operation = startupOperation(req.method, url);
    if (operation) {
      if (++caseRequests > limits.authPerCase) return reject(req, res, 'auth-state-cap');
      let actor = actorFrom(req.headers.authorization), data, status = 200;
      if (operation === 'imp-verify' || operation === 'imp-session') {
        const body = await readBody(req); actor = 'A';
        if (operation === 'imp-verify') {
          if (body.token !== 'synthetic-impersonation-A') return reject(req, res, 'synthetic impersonation token only');
          data = { clinicId: ids.workspace, clinicName: 'PRIVATE STARTUP A', ownerEmail: sessions.A.user.email, issuedBy: 'synthetic-control' };
        } else {
          if (body.impersonateToken !== 'synthetic-impersonation-A' || body.ownerEmail !== sessions.A.user.email) return reject(req, res, 'synthetic session exchange only');
          data = { tokenHash: 'synthetic-imp-otp-A' };
        }
      } else {
        if (req.headers.apikey !== localKey) return reject(req, res, 'synthetic SDK key only');
        if (operation === 'otp') {
          const body = await readBody(req); actor = 'A';
          if (body.token_hash !== 'synthetic-imp-otp-A' || body.type !== 'email') return reject(req, res, 'synthetic OTP only');
          data = sessions.A;
        } else {
          if (!actor) return reject(req, res, 'synthetic SDK actor only');
          data = sessions[actor].user;
          if (operation === 'password-put') {
            const body = await readBody(req);
            const allowedKeys = ['password', 'code_challenge', 'code_challenge_method'];
            if (body.password !== syntheticPassword || Object.keys(body).some(key => !allowedKeys.includes(key))
              || ('code_challenge' in body && body.code_challenge !== null)
              || ('code_challenge_method' in body && body.code_challenge_method !== null)) return reject(req, res, 'synthetic password update and null SDK PKCE fields only');
            assert.ok(controls.mutations.length < 16); controls.mutations.push({ caseName: activeCase.name, caseRun: activeCase.caseRun, actor, operation, id: item.id, bodyKeys: Object.keys(body).sort() });
            data = { ...data, updated_at: '2026-01-02T00:00:00Z' };
          }
        }
      }
      item.operation = operation; item.actor = actor;
      const planIndex = plans.findIndex(plan => plan.operation === operation && plan.actor === actor);
      const plan = planIndex < 0 ? null : plans.splice(planIndex, 1)[0];
      const bytes = JSON.stringify(data), send = () => {
        if (res.destroyed || res.writableEnded) { item.transportClosed = true; return false; }
        item.status = status; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(bytes); return true;
      };
      if (plan?.hold) {
        assert.ok(held.size < limits.held); item.held = true;
        const timer = setTimeout(() => { item.leaseExpired = true; res.destroy(); }, limits.heldLeaseMs);
        held.set(item.id, { id: item.id, caseName: activeCase.name, operation, actor, res, timer, send });
      } else send();
      return;
    }
    if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/impersonation/')) return reject(req, res, 'closed auth/startup path');
    if (url.pathname.startsWith('/api/')) {
      if (Object.hasOwn(dashboardLists, url.pathname)) {
        const actor = actorFrom(req.headers.authorization);
        if (!activeCase.positiveOwner || req.method !== 'GET' || actor !== 'A' || [...url.searchParams].length !== 1
          || url.searchParams.get('workspaceId') !== ids.workspace) return reject(req, res, 'positive owner exact read-only workspace lists only');
        item.actor = actor; item.operation = 'dashboard-list'; item.workspaceId = ids.workspace; item.status = 200;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ success: true, data: { [dashboardLists[url.pathname]]: [], timeZone: 'UTC' } })); return;
      }
      if (req.method !== 'GET' || url.search || !businessPaths.includes(url.pathname)) return reject(req, res, 'business GET auth-context/profile only');
      const actor = actorFrom(req.headers.authorization); if (!actor) return reject(req, res, 'synthetic business actor only'); item.actor = actor;
      const common = { id: ids[actor], displayName: 'PRIVATE STARTUP ' + actor };
      const memberships = actor === 'A' && activeCase.name.startsWith('held-impersonation') ? [{ staffUserId: ids.A, workspaceId: ids.workspace,
        workspaceName: 'PRIVATE STARTUP A', role: 'owner', permissions: [], vertical: 'clinic', purpose: 'clinic_services' }] : [];
      const data = url.pathname.endsWith('/auth-context') ? { memberships } : url.pathname.endsWith('/operator-account')
        ? { ...common, status: 'pending', acceptingRequests: false }
        : { ...common, revision: '44444444-4444-4444-8444-444444444444', partnerStatus: 'pending', creatorStatus: 'pending', portfolioUrls: [] };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ success: true, data })); return;
    }
    if (req.method !== 'GET' || url.search) return reject(req, res, 'closed static method/query');
    if (url.pathname === '/boot.js') {
      const bytes = 'const setup=' + JSON.stringify(activeCase) + ';const sessions=' + JSON.stringify(sessions) + ';\n' + boot;
      controls.bootHashes.push({ caseName: activeCase.name, sha256: sha(bytes) }); res.writeHead(200, { 'Content-Type': 'application/javascript' }).end(bytes); return;
    }
    if (bundle?.files.has(url.pathname)) { const file = bundle.files.get(url.pathname); res.writeHead(200, { 'Content-Type': file.type }).end(file.bytes); return; }
    if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
    if (!bundle || !appRoutes.has(url.pathname)) return reject(req, res, 'closed static path');
    const sheets = ['/style.css', ...[...bundle.files.keys()].filter(file => file.endsWith('.css') && file !== '/style.css')];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; img-src 'self' data:; worker-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" })
      .end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">'
        + sheets.map(file => '<link rel="stylesheet" href="' + file + '">').join('')
        + '</head><body><aside style="font:12px/1.5 sans-serif;padding:6px 12px;border-bottom:1px solid #777">Synthetic startup/recovery; actual App and SDK; same-document controlled B, not two tabs</aside><div id="root"></div><script type="module" src="/boot.js"></script></body></html>');
  };
  const server = createServer((req, res) => { handler(req, res).catch(() => { if (!res.headersSent) reject(req, res, 'malformed closed request'); else res.destroy(); }); });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const close = async () => {
    if (!closed) {
      closed = true; const live = [...sockets], closures = live.map(socket => new Promise(resolve => socket.once('close', resolve)));
      for (const item of held.values()) { clearTimeout(item.timer); item.res.destroy(); } held.clear(); plans.length = 0;
      server.closeAllConnections(); const closing = new Promise(resolve => server.close(resolve)); for (const socket of live) socket.destroy();
      let timer; try { await Promise.race([Promise.all([closing, ...closures]), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Startup listener did not close')), 3000); })]); }
      finally { clearTimeout(timer); }
    }
    return { listening: server.listening, held: held.size, plans: plans.length, sockets: sockets.size };
  };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = 'http://127.0.0.1:' + server.address().port; bundle = await bundleRuntime(origin, sessions);
  } catch (error) { await close(); stopStartupRecoveryBuilds(); throw error; }
  return { origin, controls, scope, limits, sourceHashes: bundle.sourceHashes, sdk: bundle.sdk,
    bundleHashes: Object.fromEntries([...bundle.files].map(([name, file]) => [name, sha(file.bytes)])), close,
    async assertSourcesUnchanged() { for (const [file, hash] of Object.entries(bundle.sourceHashes)) assert.equal(sha(await readFile(path.join(root, file))), hash, 'Startup source changed; obtain a new freeze and rebuild: ' + file); } };
}

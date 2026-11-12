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
const localKey = 'synthetic-loopback-authority-key-not-a-credential';
export const sdkVersion = '2.118.0';
export const ids = Object.freeze({ A: '11111111-1111-4111-8111-111111111111', B: '22222222-2222-4222-8222-222222222222' });
export const fixtureScope = 'Actual App/AuthProvider/portal runtime, actual lib/supabase.ts and frontend-installed SDK. Synthetic loopback auth HTTP plus GET-only auth-context/profile. Same-page controlled callers plus ONE genuine parent/same-origin iframe regression with separate App/SDK instances, shared localStorage/Web Locks and native storage events. NOT a two-tab, cross-process, server-authorization, email-delivery or operational-acceptance proof.';
const routes = new Set(['/', '/operator', '/contributors', '/privacy', '/terms', '/data-deletion', '/__authority-child']);
const businessPaths = new Set(['/api/crm/auth-context', '/api/crm/operator-account', '/api/crm/contributor-account']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let esbuild;
export const stopAuthSessionAuthorityBuilds = () => esbuild?.stop();

export function authorityRequestAllowed(req, origin) {
  if (!origin || !['GET', 'POST'].includes(req.method) || req.headers.host !== new URL(origin).host
    || !req.url?.startsWith('/') || req.url.startsWith('//') || /[\\\u0000-\u0020]/.test(req.url)) return false;
  for (const key of ['origin', 'referer']) {
    if (req.headers[key]) {
      try { if (new URL(req.headers[key]).origin !== origin) return false; } catch { return false; }
    }
  }
  return req.headers['sec-fetch-site'] !== 'cross-site';
}

export function authorityAuthOperation(method, url) {
  const query = [...url.searchParams];
  if (method === 'GET' && url.pathname === '/auth/v1/user' && !query.length) return 'user';
  if (method !== 'POST') return null;
  if (url.pathname === '/auth/v1/token' && query.length === 1 && url.searchParams.get('grant_type') === 'password') return 'password';
  if (url.pathname === '/auth/v1/logout' && query.length <= 1
    && (!query.length || (query[0][0] === 'scope' && ['global', 'local', 'others'].includes(query[0][1])))) return 'logout';
  if (url.pathname === '/auth/v1/signup' && (query.length === 0 || (query.length === 1 && query[0][0] === 'redirect_to'
    && [url.origin + '/operator', url.origin + '/contributors'].includes(query[0][1])))) return 'signup';
  if (url.pathname === '/auth/v1/verify' && !query.length) return 'verify';
  return null;
}

function syntheticSessions() {
  const exp = Math.floor(Date.now() / 1000) + 86_400;
  return Object.fromEntries(Object.entries(ids).map(([actor, id]) => {
    const user = { id, email: `authority-${actor.toLowerCase()}@example.test`, aud: 'authenticated', role: 'authenticated',
      app_metadata: {}, user_metadata: { full_name: 'Synthetic ' + actor }, created_at: '2026-01-01T00:00:00Z' };
    const access_token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: id, aud: 'authenticated', role: 'authenticated', exp, iat: exp - 86_400,
        session_id: 'synthetic-authority-' + actor })).toString('base64url'), Buffer.from('synthetic-not-a-signature').toString('base64url')].join('.');
    return [actor, { access_token, refresh_token: 'synthetic-refresh-' + actor, expires_in: 86_400, expires_at: exp, token_type: 'bearer', user }];
  }));
}

// This executes before importing App or the SDK, including module initialization.
const boot = String.raw`
const denied=[],traffic=[];let pending=0;
const track=(target,type)=>{const callbacks=new Map(),add=target.addEventListener.bind(target),remove=target.removeEventListener.bind(target);
  const capture=options=>typeof options==='boolean'?options:!!options?.capture;
  target.addEventListener=(name,callback,options)=>{if(name===type&&callback){const flags=callbacks.get(callback)||new Set();flags.add(capture(options));callbacks.set(callback,flags);}return add(name,callback,options);};
  target.removeEventListener=(name,callback,options)=>{if(name===type){const flags=callbacks.get(callback);flags?.delete(capture(options));if(flags?.size===0)callbacks.delete(callback);}return remove(name,callback,options);};
  return()=>[...callbacks.values()].reduce((count,flags)=>count+flags.size,0);};
const storageListeners=track(window,'storage'),visibilityListeners=track(document,'visibilitychange');
window.__authorityListeners=()=>({storage:storageListeners(),visibility:visibilityListeners()});
const allowed=(method,url)=>{
  if(url.origin!==location.origin||url.username||url.password||url.hash)return false;
  const q=[...url.searchParams];
  if(method==='GET')return !q.length&&['/auth/v1/user','/api/crm/auth-context','/api/crm/operator-account','/api/crm/contributor-account'].includes(url.pathname);
  if(method!=='POST')return false;
  if(url.pathname==='/auth/v1/token')return q.length===1&&url.searchParams.get('grant_type')==='password';
  if(url.pathname==='/auth/v1/signup')return !q.length||(q.length===1&&q[0][0]==='redirect_to'&&['/operator','/contributors'].some(p=>q[0][1]===location.origin+p));
  if(url.pathname==='/auth/v1/logout')return !q.length||(q.length===1&&q[0][0]==='scope'&&['global','local','others'].includes(q[0][1]));
  return url.pathname==='/auth/v1/verify'&&!q.length;
};
const refuse=(kind,detail={})=>{denied.push({kind,...detail});throw Error('Closed synthetic loopback fixture: '+kind);};
const nativeFetch=window.fetch.bind(window);
window.fetch=async(input,init={})=>{
  const url=new URL(input instanceof Request?input.url:String(input),location.origin);
  const method=(init.method||(input instanceof Request?input.method:'GET')).toUpperCase();
  if(!allowed(method,url))return refuse('fetch',{method,path:url.pathname});
  const item={method,path:url.pathname,done:false};traffic.push(item);pending++;
  try{return await nativeFetch(input,{...init,redirect:'error',credentials:'omit'});}
  finally{pending--;item.done=true;}
};
XMLHttpRequest.prototype.open=function(){return refuse('XMLHttpRequest');};
for(const name of ['WebSocket','EventSource','Worker','SharedWorker']){
  if(name in window)window[name]=class{constructor(){refuse(name);}};
}
if(navigator.serviceWorker)navigator.serviceWorker.register=()=>Promise.reject(Error('Service worker disabled in owned fixture'));
Object.defineProperty(navigator,'sendBeacon',{configurable:true,value:()=>{denied.push({kind:'beacon'});return false;}});
window.open=()=>{denied.push({kind:'window.open'});return null;};
document.addEventListener('click',event=>{const a=event.target instanceof Element?event.target.closest('a[href]'):null;
  if(a&&new URL(a.href).origin!==location.origin){event.preventDefault();denied.push({kind:'external-link'});}},true);
document.addEventListener('securitypolicyviolation',event=>denied.push({kind:'CSP',directive:event.effectiveDirective}));
window.__authorityNetwork={denied,traffic,get pending(){return pending;}};
window.__authorityDocument=location.pathname==='/__authority-child'?'iframe':'parent';
if(window.__authorityDocument==='parent'){localStorage.clear();sessionStorage.clear();}
else if(window.parent===window)refuse('child-document-must-be-framed');
history.replaceState(null,'','/operator');
await import('/entry.js');
`;

const entry = String.raw`
import React from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
import App from './src/App';import{sessionAuth,supabase,hasSupabaseFrontendEnv}from'./src/lib/supabase';
const sessions=__AUTHORITY_SYNTHETIC_SESSIONS__,ids=Object.fromEntries(Object.entries(sessions).map(([a,s])=>[a,s.user.id]));
if(!hasSupabaseFrontendEnv)throw Error('Synthetic URL/key injection failed');
for(const name of ['signInWithPassword','signUp','setSession','verifyOtp','signOut','onAuthStateChange']){
  if(typeof sessionAuth[name]!=='function')throw Error('Missing actual sessionAuth.'+name);
}
if(!navigator.locks||typeof supabase.auth.dispose!=='function')throw Error('Public SDK dispose() and Web Locks are required');
const storageKey='sb-'+new URL(location.origin).hostname.split('.')[0]+'-auth-token';
const tasks=[],events=[],storageEvents=[],closedChildren=[],scopes=new Map();let app,probe,detached=[],retainedSubmit=null,watcher,watch=[],childFrame,childRack,lockTask,releaseLock,lockController,lockRetired=false;
const sessionLockProbe={held:false};
const recordStorage=event=>{if(event.storageArea===localStorage&&[null,storageKey,storageKey+'.medina-revision',storageKey+'.medina-intent'].includes(event.key)){
  storageEvents.push({key:event.key,trusted:event.isTrusted,url:event.url,hasOld:event.oldValue!==null,hasNew:event.newValue!==null});}};
window.addEventListener('storage',recordStorage);
const frames=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
const digest=async raw=>raw===null?null:[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))].map(x=>x.toString(16).padStart(2,'0')).join('');
// view is only the unchanged owned runner's ready handshake, not an auth scope.
const f={ids,view:{isCurrentMutationScope:()=>true},run:crypto.randomUUID(),
  label:window.__authorityDocument==='iframe'?'Same-origin iframe: separate actual App and SDK instance, NOT a second tab':'Controlled second caller of actual sessionAuth in ONE page, NOT a second tab',
  runtimeHandles:()=>({facade:sessionAuth,auth:supabase.auth,window,document}),
  taskState(name){const task=tasks.find(t=>t.name===name);if(!task)return null;const{promise,...state}=task;return{...state,current:scopes.get(name)?.current??false};},
  sessionLockProbe,
  holdSessionLock(){if(lockTask)throw Error('Owned session lock probe already active');
    lockRetired=false;lockController=new AbortController();
    lockTask=navigator.locks.request('lock:'+storageKey,{mode:'exclusive',signal:lockController.signal},async()=>{
      if(lockRetired)return;sessionLockProbe.held=true;
      try{await new Promise(resolve=>{releaseLock=resolve;});}finally{sessionLockProbe.held=false;}
    }).catch(error=>{if(error.name!=='AbortError')throw error;});},
  async releaseSessionLock(){lockRetired=true;releaseLock?.();releaseLock=null;lockController?.abort();
    if(lockTask){try{await lockTask;}finally{lockTask=null;lockController=null;}}},
  openChild(){if(window.__authorityDocument!=='parent'||childFrame)throw Error('Exactly one owned child document is permitted');
    childRack=document.createElement('section');childRack.id='authority-two-document-rack';
    childRack.style.cssText='position:fixed;right:16px;bottom:16px;width:min(800px,calc(100% - 32px));height:570px;z-index:10000;background:white;border:2px solid #555';
    const label=document.createElement('div');label.textContent='Same-origin iframe: actual App + separate SDK; NOT two tabs';label.style.cssText='font:12px/1.5 sans-serif;padding:5px';
    childFrame=document.createElement('iframe');childFrame.id='authority-child';childFrame.title='Owned same-origin App and SDK regression document';
    childFrame.style.cssText='display:block;width:100%;height:530px;border:0';childFrame.src='/__authority-child';
    childRack.append(label,childFrame);document.body.append(childRack);
  },
  child(){return childFrame?.contentWindow?.__appointmentRecovery??null;},
  childRuntime(){const child=this.child();if(!child)return null;const handles=child.runtimeHandles();
    return{parentRun:this.run,childRun:child.run,parentKind:window.__authorityDocument,childKind:childFrame.contentWindow.__authorityDocument,
      distinctWindow:handles.window!==window,distinctDocument:handles.document!==document,distinctFacade:handles.facade!==sessionAuth,distinctSDK:handles.auth!==supabase.auth,
      sameOrigin:childFrame.contentWindow.location.origin===location.origin,childAppRoot:handles.document.getElementById('root').childElementCount,
      childWebLocks:!!childFrame.contentWindow.navigator.locks,sessionLockName:'lock:'+storageKey};},
  async childLocks(){if(!this.child())throw Error('Owned child is not ready');return childFrame.contentWindow.navigator.locks.query();},
  async closeChild(){await this.releaseSessionLock();if(!childFrame)return null;
    const child=this.child();let receipt;try{if(!child)throw Error('Child document never reached actual App initialization');receipt=await child.shutdown();closedChildren.push(receipt);}
    finally{childFrame.remove();childRack.remove();childFrame=null;childRack=null;}return receipt;},
  start(name,operation,actor='B'){
    if(tasks.some(t=>t.name===name))throw Error('Unique controlled operation name required');
    if(!Object.hasOwn(ids,actor))throw Error('Synthetic actors only');
    const owner={current:true,controller:new AbortController()};scopes.set(name,owner);
    const scope={isCurrent:()=>owner.current,signal:owner.controller.signal};
    const task={name,operation,actor,done:false,error:null,sessionId:null};tasks.push(task);
    const credentials={email:sessions[actor].user.email,password:'SyntheticEntry42!'};
    task.promise=Promise.resolve().then(()=>{
      if(operation==='signInWithPassword')return sessionAuth.signInWithPassword(credentials,scope);
      if(operation==='signUp')return sessionAuth.signUp({...credentials,options:{emailRedirectTo:location.origin+'/operator'}},scope);
      if(operation==='setSession')return sessionAuth.setSession({access_token:sessions[actor].access_token,refresh_token:sessions[actor].refresh_token},scope);
      if(operation==='verifyOtp')return sessionAuth.verifyOtp({email:credentials.email,token:'123456',type:'email'},scope);
      if(operation==='signOut')return sessionAuth.signOut(scope,{scope:'local'});
      throw Error('Unknown controlled operation');
    }).then(result=>{task.error=result.error?.name??(result.error?'SDKError':null);task.sessionId=result.data?.session?.user.id??null;},
      error=>{task.error=error?.constructor?.name??'Error';}).finally(()=>{task.done=true;});
  },
  invalidate(name,abort=false){const scope=scopes.get(name);if(!scope)throw Error('Missing controlled scope');scope.current=false;if(abort)scope.controller.abort();},
  observe(){if(probe)throw Error('Probe already subscribed');const result=sessionAuth.onAuthStateChange((event,session)=>events.push({event,id:session?.user.id??null}));
    if(typeof result?.data?.subscription?.unsubscribe!=='function')throw Error('Actual bridge subscription must match SDK shape');probe=result.data.subscription;},
  stopObserving(){probe?.unsubscribe();probe=null;},
  remember(){detached=[...document.querySelectorAll('input[type=password]')];},
  retainSubmit(){const form=document.querySelector('form:has(input[type=password])');if(!form)throw Error('Missing real auth form');
    retainedSubmit=form[Object.keys(form).find(k=>k.startsWith('__reactProps$'))]?.onSubmit;if(typeof retainedSubmit!=='function')throw Error('Missing actual React submit');},
  invokeRetiredSubmit(){if(!retainedSubmit)throw Error('No retained form');retainedSubmit({preventDefault(){}});},
  fill(selector,value){const node=document.querySelector(selector);if(!node||node.disabled)throw Error('Missing enabled field '+selector);
    flushSync(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));});},
  click(selector){const node=document.querySelector(selector);if(!node||node.disabled)throw Error('Missing enabled control '+selector);flushSync(()=>node.click());},
  mode(value){const buttons=[...document.querySelectorAll('[role=tab], [aria-label="\u0421\u043f\u043e\u0441\u043e\u0431 \u0432\u0445\u043e\u0434\u0430"] button')];
    const node=buttons[value==='signup'?1:0];if(!node||node.disabled)throw Error('Missing enabled auth mode');flushSync(()=>node.click());},
  submitDuplicate(){const form=document.querySelector('form:has(input[type=password])'),button=form?.querySelector('button[type=submit]');
    if(!button||button.disabled)throw Error('Missing real auth submit');flushSync(()=>{button.click();button.click();form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});},
  navigate(route){if(!['/operator','/contributors','/privacy'].includes(route))throw Error('Owned route only');flushSync(()=>history.pushState(null,'',route));},
  watchPrivate(){watcher?.disconnect();watch=[];const capture=()=>{const text=document.getElementById('root').innerText;
    watch.push({A:text.includes('PRIVATE SYNTHETIC A'),B:text.includes('PRIVATE SYNTHETIC B')});};
    watcher=new MutationObserver(capture);watcher.observe(document.getElementById('root'),{subtree:true,childList:true,characterData:true});capture();},
  async idle(){await frames();await new Promise(resolve=>setTimeout(resolve,80));await supabase.auth.getSession();await frames();},
  async snapshot(){const raw=localStorage.getItem(storageKey),stored=raw?JSON.parse(raw):null,{data,error}=await supabase.auth.getSession();
    const privateSelectors=['.portal-identity','.portal-profile-summary','.portal-mode-tabs','.portal-signout','.portal-header-actions'];
    return{path:location.pathname,documentKind:window.__authorityDocument,run:this.run,text:document.getElementById('root').innerText,storageKey,storedId:stored?.user?.id??null,storedHash:await digest(raw),
      revisionHash:await digest(localStorage.getItem(storageKey+'.medina-revision')),intentHash:await digest(localStorage.getItem(storageKey+'.medina-intent')),sdkId:data.session?.user.id??null,sdkError:!!error,
      events:[...events],storageEvents:[...storageEvents],observing:!!probe,tasks:tasks.map(({promise,...task})=>({...task,current:scopes.get(task.name)?.current??false})),
      passwordLengths:[...document.querySelectorAll('input[type=password]')].map(n=>n.value.length),detachedPasswordLengths:detached.map(n=>n.value.length),
      network:window.__authorityNetwork,listeners:window.__authorityListeners(),watch:[...watch],portal:!!document.querySelector('.portal-workspace'),
      privateIdentity:!!document.querySelector('.portal-identity'),privateProfile:!!document.querySelector('.portal-profile-summary,.portal-mode-tabs'),
      privatePortalSelectors:privateSelectors.filter(selector=>document.querySelector(selector)),publicAuthForm:!!document.querySelector('form input[type=password]'),storageKeys:Object.keys(localStorage).sort()};},
  unmount(){this.remember();if(app){flushSync(()=>app.unmount());app=null;}return{rootChildren:document.getElementById('root').childElementCount,detachedPasswordLengths:detached.map(n=>n.value.length)};},
  async shutdown(){await this.closeChild();this.unmount();watcher?.disconnect();this.stopObserving();window.removeEventListener('storage',recordStorage);
    for(const owner of scopes.values()){owner.current=false;owner.controller.abort();}
    let timer;try{await Promise.race([Promise.all(tasks.map(t=>t.promise)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Controlled tasks did not settle')),7000);})]);}
    finally{clearTimeout(timer);sessionAuth.dispose();await supabase.auth.stopAutoRefresh();await supabase.auth.dispose();}
    return{rootChildren:document.getElementById('root').childElementCount,observerUnsubscribed:!probe,sdkDisposed:true,
      pendingControlledTasks:tasks.filter(t=>!t.done).map(t=>t.name),pendingFetches:window.__authorityNetwork.pending,networkDenied:[...window.__authorityNetwork.denied],
      networkTraffic:[...window.__authorityNetwork.traffic],storageEvents:[...storageEvents],children:closedChildren,childFrames:document.querySelectorAll('#authority-child').length,
      sessionLockHeld:sessionLockProbe.held,listeners:window.__authorityListeners(),detachedPasswordLengths:detached.map(n=>n.value.length)};
  }
};
window.__appointmentRecovery=f;
document.getElementById('second-caller-label').textContent=f.label;
app=createRoot(document.getElementById('root'));flushSync(()=>app.render(<App/>));
`;

async function makeBundle(origin, sessions) {
  const sourceHashes = {};
  const record = async file => {
    const relative = path.relative(root, file).replaceAll('\\', '/');
    assert.ok(!relative.startsWith('../') && !/(^|\/)\.env(?:\.|$)/.test(relative), 'Only closed local source inputs');
    const bytes = await readFile(file), hash = sha(bytes);
    if (sourceHashes[relative]) assert.equal(hash, sourceHashes[relative], 'Source changed during build: ' + relative);
    sourceHashes[relative] = hash; return bytes;
  };
  const sdkPackage = frontendRequire.resolve('@supabase/supabase-js/package.json');
  const sdk = JSON.parse((await record(sdkPackage)).toString());
  assert.equal(sdk.version, sdkVersion, 'Wait for actual frontend SDK freeze; no baseline SDK fallback');
  const manifest = JSON.parse((await record(path.join(frontend, 'package.json'))).toString());
  assert.equal(manifest.dependencies['@supabase/supabase-js'], sdkVersion, 'Frontend dependency must be exact');
  const authPackage = createRequire(sdkPackage).resolve('@supabase/auth-js/package.json');
  const auth = JSON.parse((await record(authPackage)).toString());
  assert.equal(auth.version, sdkVersion, 'Actual matching auth SDK required');
  await record(path.join(path.dirname(authPackage), 'src/GoTrueClient.ts'));
  esbuild = createRequire(frontendRequire.resolve('vite/package.json'))('esbuild');
  const result = await esbuild.build({ absWorkingDir: root, stdin: { contents: entry, resolveDir: frontend, loader: 'tsx', sourcefile: 'owned-auth-session-authority.tsx' },
    bundle: true, write: false, platform: 'browser', format: 'esm', splitting: true, jsx: 'automatic', metafile: true,
    outdir: path.join(root, 'node_modules/.cache/auth-session-authority-memory'), entryNames: 'entry', chunkNames: '[name]-[hash]',
    define: { 'process.env.NODE_ENV': '"production"', __AUTHORITY_SYNTHETIC_SESSIONS__: JSON.stringify(sessions),
      'import.meta.env': JSON.stringify({ BASE_URL: '/', PROD: false, DEV: false, VITE_SUPABASE_URL: origin, VITE_SUPABASE_ANON_KEY: localKey }) },
    plugins: [{ name: 'actual-runtime-source-receipts', setup(build) {
      // Resolve the application's normal @/ paths to real files, never SDK/authority doubles.
      build.onResolve({ filter: /^@\// }, args => {
        const base = path.join(frontend, 'src', args.path.slice(2));
        const file = [base, base + '.ts', base + '.tsx', path.join(base, 'index.ts'), path.join(base, 'index.tsx')].find(existsSync);
        assert.ok(file, args.path); return { path: file };
      });
      build.onLoad({ filter: /\.(ts|tsx|css|mjs|js)$/, namespace: 'file' }, async args => {
        const relative = path.relative(root, args.path).replaceAll('\\', '/');
        if (!/^(artifacts\/negis\/src\/|lib\/|packages\/)/.test(relative) && !relative.includes('/@supabase/')) return;
        const loader = path.extname(args.path).slice(1);
        return { contents: await record(args.path), loader: loader === 'mjs' ? 'js' : loader, resolveDir: path.dirname(args.path) };
      });
    } }] });
  const inputs = Object.keys(result.metafile.inputs).map(file => file.replaceAll('\\', '/'));
  assert.ok(inputs.some(file => file.includes('/@supabase/supabase-js/')), 'Actual installed SDK must enter the browser bundle');
  assert.ok(inputs.some(file => file.includes('/@supabase/auth-js/')), 'Actual installed auth SDK must enter the browser bundle');
  for (const file of ['App.tsx', 'contexts/AuthContext.tsx', 'lib/supabase.ts', 'lib/authSessionAuthority.ts', 'pages/OperatorPortal.tsx', 'pages/ContributorPortal.tsx'])
    assert.ok(sourceHashes['artifacts/negis/src/' + file], 'Actual runtime source required: ' + file);
  for (const input of inputs.filter(file => file.includes('/@supabase/'))) {
    const resolved = path.resolve(root, input);
    assert.ok(resolved.startsWith(path.join(root, 'node_modules') + path.sep)
      || resolved.startsWith(path.join(frontend, 'node_modules') + path.sep), 'Installed SDK source only');
    if (input.includes('/@supabase/supabase-js/')) assert.ok(resolved.startsWith(path.dirname(sdkPackage) + path.sep), 'Frontend-resolved Supabase only');
    if (input.includes('/@supabase/auth-js/')) assert.ok(resolved.startsWith(path.dirname(authPackage) + path.sep), 'Frontend-resolved auth SDK only');
    await record(resolved);
  }
  const tailwindRequire = createRequire(frontendRequire.resolve('@tailwindcss/vite'));
  const { compile } = tailwindRequire('@tailwindcss/node'), { Scanner } = tailwindRequire('@tailwindcss/oxide');
  const cssPath = path.join(frontend, 'src/index.css'), dependencies = new Set();
  const compiler = await compile((await record(cssPath)).toString(), { base: path.dirname(cssPath),
    onDependency: file => { if (file.startsWith(frontend + path.sep)) dependencies.add(file); } });
  const scanner = new Scanner({ sources: [{ base: path.join(frontend, 'src'), pattern: '**/*.{ts,tsx,css}', negated: false }] });
  const files = new Map(result.outputFiles.map(file => ['/' + path.basename(file.path), {
    type: file.path.endsWith('.css') ? 'text/css' : 'application/javascript', bytes: file.contents }]));
  files.set('/style.css', { type: 'text/css', bytes: compiler.build(scanner.scan()) });
  files.set('/boot.js', { type: 'application/javascript', bytes: boot });
  for (const file of dependencies) await record(file);
  for (const name of ['inter-latin.woff2', 'inter-cyrillic.woff2', 'inter-cyrillic-ext.woff2'])
    files.set('/fonts/inter/' + name, { type: 'font/woff2', bytes: await record(path.join(frontend, 'public/fonts/inter', name)) });
  files.set('/favicon.svg', { type: 'image/svg+xml', bytes: await record(path.join(frontend, 'public/favicon.svg')) });
  for (const file of ['scripts/fixtures/auth-session-authority-browser.mjs', 'scripts/fixtures/auth-session-authority-browser.test.mjs',
    'scripts/src/appointment-recovery-committed-fixture.ts', 'package.json', 'scripts/package.json', 'scripts/run-pnpm.cjs', 'pnpm-lock.yaml']) await record(path.join(root, file));
  return { files, sourceHashes, sdk: { version: sdk.version, authVersion: auth.version,
    package: path.relative(root, sdkPackage).replaceAll('\\', '/'), authPackage: path.relative(root, authPackage).replaceAll('\\', '/') } };
}

async function readJson(req) {
  assert.match(req.headers['content-type'] ?? '', /^application\/json(?:;|$)/i);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; assert.ok(size <= 16_384, 'Synthetic auth body limit'); chunks.push(chunk); }
  const value = JSON.parse(Buffer.concat(chunks).toString());
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value;
}

export async function createAuthSessionAuthorityBrowser({ runtimeSdkFreezeConfirmed = false } = {}) {
  assert.equal(runtimeSdkFreezeConfirmed, true, 'Do not build/run until Main explicitly confirms runtime + SDK freeze');
  const sessions = syntheticSessions(), sockets = new Set(), held = new Map(), plans = [];
  let origin, bundle, closed = false, sequence = 0;
  const controls = { requests: [], rejected: [], releases: [],
    plan({ operation, actor, hold = false, outcome = 'session' }) {
      assert.ok(['password', 'signup', 'verify', 'logout'].includes(operation)); assert.ok(Object.hasOwn(ids, actor));
      assert.ok(['session', 'confirmation', 'error'].includes(outcome));
      plans.push({ operation, actor, hold, outcome });
    },
    pending: () => [...held.values()].map(({ id, operation, actor, res }) => ({ id, operation, actor, disconnected: res.destroyed })),
    unconsumed: () => plans.map(plan => ({ ...plan })),
    release(id) {
      const item = held.get(id); assert.ok(item, 'Existing owned held response required'); held.delete(id);
      const delivered = item.send(); const receipt = { id, operation: item.operation, actor: item.actor, delivered };
      this.releases.push(receipt); return receipt;
    },
    releaseAll() { for (const id of [...held.keys()]) this.release(id); },
  };
  const actorForHeader = header => Object.keys(sessions).find(actor => header === 'Bearer ' + sessions[actor].access_token);
  const reject = (req, res, reason) => { controls.rejected.push({ method: req.method, path: req.url, reason }); res.writeHead(403).end(); };
  const handle = async (req, res) => {
    if (!authorityRequestAllowed(req, origin)) return reject(req, res, 'host/origin/method');
    const url = new URL(req.url, origin);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const item = { id: ++sequence, method: req.method, path: url.pathname, queryKeys: [...url.searchParams.keys()] };
    controls.requests.push(item);
    if (url.pathname.startsWith('/auth/')) {
      const operation = authorityAuthOperation(req.method, url);
      if (!operation || req.headers.apikey !== localKey) return reject(req, res, 'closed auth method/path/key');
      item.operation = operation;
      if (operation === 'signup' && url.searchParams.has('redirect_to')) item.redirectPath = new URL(url.searchParams.get('redirect_to')).pathname;
      if (operation === 'user') {
        const actor = actorForHeader(req.headers.authorization); if (!actor) return reject(req, res, 'synthetic user only');
        item.actor = actor; res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(sessions[actor].user)); return;
      }
      let actor;
      if (operation === 'logout') actor = actorForHeader(req.headers.authorization);
      else {
        if (req.headers.authorization !== 'Bearer ' + localKey) return reject(req, res, 'synthetic auth header only');
        const body = await readJson(req);
        actor = Object.keys(sessions).find(actor => body.email === sessions[actor].user.email);
        if (operation === 'verify') { if (body.token !== '123456' || body.type !== 'email') return reject(req, res, 'synthetic OTP only'); }
        else if (body.password !== 'SyntheticEntry42!') return reject(req, res, 'synthetic password only');
      }
      if (!actor) return reject(req, res, 'synthetic actor only');
      item.actor = actor;
      const index = plans.findIndex(plan => plan.operation === operation && plan.actor === actor);
      if (index < 0) return reject(req, res, 'unplanned auth HTTP');
      const plan = plans.splice(index, 1)[0]; item.outcome = plan.outcome; item.held = plan.hold;
      const status = plan.outcome === 'error' ? 400 : operation === 'logout' ? 204 : 200;
      const body = plan.outcome === 'error' ? { code: 'invalid_credentials', msg: 'Synthetic refusal' }
        : plan.outcome === 'confirmation' ? sessions[actor].user : sessions[actor];
      const bytes = JSON.stringify(body);
      const send = () => {
        if (res.destroyed || res.writableEnded) { item.transportClosed = true; return false; }
        item.status = status; res.writeHead(status, { 'Content-Type': 'application/json' }).end(status === 204 ? undefined : bytes); return true;
      };
      res.once('close', () => { if (!res.writableEnded) item.transportClosed = true; });
      if (plan.hold) held.set(item.id, { id: item.id, operation, actor, res, send }); else send();
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' || !businessPaths.has(url.pathname) || url.search) return reject(req, res, 'business GET auth-context/profile only');
      const actor = actorForHeader(req.headers.authorization); if (!actor) return reject(req, res, 'synthetic business actor only');
      item.actor = actor;
      const common = { id: ids[actor], displayName: 'PRIVATE SYNTHETIC ' + actor };
      const data = url.pathname.endsWith('/auth-context') ? { memberships: [] }
        : url.pathname.endsWith('/operator-account') ? { ...common, status: 'pending', acceptingRequests: false }
          : { ...common, revision: '44444444-4444-4444-8444-444444444444', partnerStatus: 'pending', creatorStatus: 'pending', portfolioUrls: [] };
      item.status = 200; res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ success: true, data })); return;
    }
    if (req.method !== 'GET' || url.search) return reject(req, res, 'static GET without query only');
    if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
    if (bundle?.files.has(url.pathname)) {
      const file = bundle.files.get(url.pathname); res.writeHead(200, { 'Content-Type': file.type }).end(file.bytes); return;
    }
    if (!bundle || !routes.has(url.pathname)) return reject(req, res, 'closed static path');
    const isChild = url.pathname === '/__authority-child';
    if (isChild && req.headers['sec-fetch-dest'] !== 'iframe') return reject(req, res, 'owned iframe document only');
    if (isChild) item.document = 'iframe';
    const sheets = ['/style.css', ...[...bundle.files.keys()].filter(file => file.endsWith('.css') && file !== '/style.css')];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; img-src 'self' data:; worker-src 'none'; frame-src "
        + (isChild ? "'none'" : origin + '/__authority-child') + "; frame-ancestors " + (isChild ? "'self'" : "'none'") + "; base-uri 'none'; form-action 'none'" })
      .end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">'
        + sheets.map(file => '<link rel="stylesheet" href="' + file + '">').join('')
        + '</head><body><aside id="second-caller-label" role="note" style="font:12px/1.5 sans-serif;padding:6px 12px;border-bottom:1px solid #888"></aside><div id="root"></div><script type="module" src="/boot.js"></script></body></html>');
  };
  const server = createServer((req, res) => { handle(req, res).catch(() => { if (!res.headersSent) reject(req, res, 'malformed closed request'); else res.destroy(); }); });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const close = async () => {
    if (!closed) {
      const live = [...sockets];
      const socketClosures = live.map(socket => new Promise(resolve => socket.once('close', resolve)));
      closed = true; for (const item of held.values()) item.res.destroy(); held.clear(); plans.length = 0;
      server.closeAllConnections();
      const serverClosure = new Promise(resolve => server.close(resolve));
      for (const socket of live) socket.destroy();
      let timer;
      try {
        await Promise.race([Promise.all([serverClosure, ...socketClosures]), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Owned HTTP sockets did not close')), 3000);
        })]);
      } finally { clearTimeout(timer); }
    }
    return { listening: server.listening, held: held.size, plans: plans.length, sockets: sockets.size };
  };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = 'http://127.0.0.1:' + server.address().port;
    bundle = await makeBundle(origin, sessions);
  } catch (error) { await close(); stopAuthSessionAuthorityBuilds(); throw error; }
  return { origin, controls, scope: fixtureScope, sourceHashes: bundle.sourceHashes, sdk: bundle.sdk,
    bundleHashes: Object.fromEntries([...bundle.files].map(([name, file]) => [name, sha(file.bytes)])),
    async assertSourcesUnchanged() {
      for (const [file, hash] of Object.entries(bundle.sourceHashes))
        assert.equal(sha(await readFile(path.join(root, file))), hash, 'Runtime/SDK changed; obtain a new freeze and rerun: ' + file);
    }, close };
}

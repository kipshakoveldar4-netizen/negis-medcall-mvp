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
const require = createRequire(path.join(frontend, 'package.json'));
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
const tailwindRequire = createRequire(require.resolve('@tailwindcss/vite'));
const { compile } = tailwindRequire('@tailwindcss/node');
const { Scanner } = tailwindRequire('@tailwindcss/oxide');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const stopPortalAuthEntryBuilds = () => esbuild.stop();

// This simple SDK has no automatic persistence or completion-time auth events.
// It proves composed DOM lifetimes, not atomic SDK session ownership.
// Only the SDK is replaced. App, SessionContent, AuthProvider, routes, forms,
// transport guards, PortalShell, WorkspacePicker and their CSS remain actual.
const sdk = String.raw`
import { flushSync } from 'react-dom';
export const ids={A:'11111111-1111-4111-8111-111111111111',B:'22222222-2222-4222-8222-222222222222'};
let actor=null,epoch=0;const listeners=new Set(),pending=[];
const session=()=>actor?{access_token:'portal-owned:'+actor+':'+epoch,refresh_token:'synthetic-unused',
  user:{id:ids[actor],email:'owned-'+actor.toLowerCase()+'@example.test',aud:'authenticated',
  app_metadata:{provider:'owned-fixture'},user_metadata:{full_name:'Synthetic '+actor},created_at:'2026-01-01T00:00:00Z'}}:null;
const forbidden=name=>{f.forbidden.push(name);throw Error('Forbidden SDK operation: '+name);};
export class StaleAuthIntentError extends Error{name='StaleAuthIntentError';}
export const f={ids,calls:[],forbidden:[],detached:[],view:{isCurrentMutationScope:()=>true},
  select(next){if(next!==null&&!Object.hasOwn(ids,next))throw Error('Unknown synthetic actor');actor=next;epoch++;
    for(const listener of [...listeners])listener(next?'SIGNED_IN':'SIGNED_OUT',session());},
  aba(){flushSync(()=>{this.select('B');this.select('A');});},
  release(operation,outcome='error'){const index=pending.findIndex(item=>item.operation===operation);if(index<0)throw Error('Missing held '+operation);
    const item=pending.splice(index,1)[0];if(outcome==='throw'){item.reject(Error('Synthetic connection failure'));return;}
    if(outcome==='session'){this.select('A');item.resolve({data:{session:session(),user:session().user},error:null});return;}
    if(outcome==='success'&&operation==='signOut')this.select(null);
    item.resolve({data:{session:null,user:null},error:outcome==='error'?{message:'Synthetic refusal'}:null});},
  fill(selector,value){const node=document.querySelector(selector);if(!node)throw Error('Missing field '+selector);
    flushSync(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));});},
  click(selector){const node=document.querySelector(selector);if(!node||node.disabled)throw Error('Missing enabled '+selector);flushSync(()=>node.click());},
  press(text){const node=[...document.querySelectorAll('button')].find(node=>node.getClientRects().length&&node.textContent.trim()===text);
    if(!node||node.disabled)throw Error('Missing enabled '+text);flushSync(()=>node.click());},
  remember(){this.detached=[...document.querySelectorAll('input[type=password]')];},
  listenerCount(){return listeners.size;},
  snapshot(){return{path:location.pathname,text:document.body.innerText,calls:this.calls,forbidden:this.forbidden,
    pending:pending.map(item=>item.operation),listeners:listeners.size,passwords:[...document.querySelectorAll('input[type=password]')].map(node=>node.value),
    detached:this.detached.map(node=>node.value),picker:!!document.querySelector('[role=dialog][aria-label="Выбор клиники"]')};},
  resetSDK(next){if(listeners.size)throw Error('Auth subscriptions survived unmount');for(const item of pending.splice(0))item.resolve({data:{session:null},error:{message:'Fixture reset'}});
    actor=next;epoch++;this.calls=[];this.forbidden=[];this.detached=[];},
};
const hold=(operation,args)=>{f.calls.push({operation,email:args?.email,passwordLength:args?.password?.length,redirect:args?.options?.emailRedirectTo});
  return new Promise((resolve,reject)=>pending.push({operation,resolve,reject}));};
const auth={async getSession(){return{data:{session:session()},error:null};},
  onAuthStateChange(listener){listeners.add(listener);return{data:{subscription:{unsubscribe(){listeners.delete(listener);}}}};},
  signInWithPassword:args=>hold('signInWithPassword',args),signUp:args=>hold('signUp',args),signOut:()=>hold('signOut'),
};
// Scope validation is a fake-dispatch assertion, not native persistence emulation.
const scoped=(scope,operation,args)=>{if(typeof scope?.isCurrent!=='function'||!scope.isCurrent()||scope.signal?.aborted)
  return forbidden('sessionAuth.'+operation+'.scope');
  if((scope.expected&&!isCurrent(scope.expected))||(scope.expectedUserId!==undefined&&scope.expectedUserId!==(actor?ids[actor]:null)))throw new StaleAuthIntentError();
  return auth[operation](args);};
const stamps=new WeakMap();
const capture=()=>{const stamp=Object.freeze({revision:String(epoch),intent:String(epoch)});stamps.set(stamp,{actor,epoch});return stamp;};
const isCurrent=stamp=>{const saved=stamp&&typeof stamp==='object'?stamps.get(stamp):null;
  return !!saved&&saved.actor===actor&&saved.epoch===epoch;};
export const sessionAuth={onAuthStateChange:auth.onAuthStateChange,
  capture,isCurrent,updateUserPassword:()=>forbidden('sessionAuth.updateUserPassword'),
  signInWithPassword:(args,scope)=>scoped(scope,'signInWithPassword',args),
  signUp:(args,scope)=>scoped(scope,'signUp',args),signOut:(scope,options)=>scoped(scope,'signOut',options)};
export const supabase=new Proxy({auth:new Proxy(auth,{get(target,key){return key in target?target[key]:(...args)=>forbidden('auth.'+String(key));}})},
  {get(target,key){return key in target?target[key]:(...args)=>forbidden(String(key));}});
export const hasSupabaseFrontendEnv=true,arrivedByRecoveryLink=false;
export const getRecoverySessionProof=()=>null,consumeRecoverySessionProof=()=>{};
export const verifyCurrentPassword=()=>forbidden('verifyCurrentPassword');
export class AuthClient{constructor(){forbidden('AuthClient');}}
export const createClient=()=>forbidden('createClient');
`;

const entry = String.raw`
import React from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
import App from './src/App';import{f}from'portal-owned-sdk';
import{clearSignOutPending}from'./src/lib/authSignOut';
import{clearCrmCache}from'./src/lib/api';import{clearListReadCache}from'./src/lib/demoStorage';
const nativeFetch=window.fetch.bind(window);f.networkDenied=[];
window.fetch=(input,init={})=>{const url=new URL(input instanceof Request?input.url:input,location.origin),method=(init.method||(input instanceof Request?input.method:'GET')).toUpperCase();
  if(url.origin!==location.origin||method!=='GET'||!['/api/crm/auth-context','/api/crm/operator-account','/api/crm/contributor-account'].includes(url.pathname)){
    f.networkDenied.push({path:url.pathname,method});return Promise.reject(Error('Closed local GET fixture'));}
  return nativeFetch(input,init);};
Object.defineProperty(navigator,'sendBeacon',{configurable:true,value:()=>{f.networkDenied.push({method:'beacon'});return false;}});
window.open=()=>{f.networkDenied.push({method:'window.open'});return null;};
document.addEventListener('click',event=>{const link=event.target instanceof Element?event.target.closest('a[href]'):null;
  if(link&&new URL(link.href).origin!==location.origin){event.preventDefault();f.networkDenied.push({method:'external-link'});}},true);
let app;f.mount=(route='/operator',actor=null)=>{if(app)flushSync(()=>app.unmount());
  f.resetSDK(actor);localStorage.clear();sessionStorage.clear();clearSignOutPending();clearCrmCache();clearListReadCache();
  history.replaceState(null,'',route);app=createRoot(document.getElementById('root'));flushSync(()=>app.render(<App/>));};
f.navigate=route=>{if(!route.startsWith('/')||route.startsWith('//'))throw Error('Local route only');flushSync(()=>history.pushState(null,'',route));};
f.unmount=()=>{f.remember();if(app){flushSync(()=>app.unmount());app=null;}return{listeners:f.listenerCount(),pending:f.snapshot().pending,detached:f.detached.map(node=>node.value)};};
window.__appointmentRecovery=f;f.mount();
`;

export function portalAuthRequestAllowed(req, origin) {
  if (!origin || req.method !== 'GET' || req.headers.host !== new URL(origin).host
    || !req.url?.startsWith('/') || req.url.startsWith('//') || /[\\\u0000-\u0020]/.test(req.url)) return false;
  for (const key of ['origin', 'referer']) {
    if (req.headers[key]) {
      try { if (new URL(req.headers[key]).origin !== origin) return false; } catch { return false; }
    }
  }
  return req.headers['sec-fetch-site'] !== 'cross-site';
}

async function makeBundle() {
  const sourceHashes = {};
  const record = async file => {
    const relative = path.relative(root, file).replaceAll('\\', '/');
    assert.match(relative, /^(artifacts\/negis\/(src|public)\/|lib\/|packages\/|scripts\/)/);
    assert.ok(!/(^|\/)\.env(?:\.|$)/.test(relative));
    const bytes = await readFile(file);
    if (sourceHashes[relative]) assert.equal(sha(bytes), sourceHashes[relative], 'Source changed during fixture build: ' + relative);
    sourceHashes[relative] = sha(bytes); return bytes;
  };
  const result = await esbuild.build({ stdin: { contents: entry, resolveDir: frontend, loader: 'tsx', sourcefile: 'owned-portal-auth-entry.tsx' },
    bundle: true, write: false, platform: 'browser', format: 'esm', splitting: true, jsx: 'automatic', metafile: true,
    outdir: path.join(root, 'node_modules/.cache/portal-auth-entry-memory'), entryNames: 'entry', chunkNames: '[name]-[hash]',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ BASE_URL: '/', PROD: false, DEV: false }) },
    plugins: [{ name: 'closed-owned-auth-sdk', setup(build) {
      build.onResolve({ filter: /^(portal-owned-sdk|@\/lib\/(supabase|authSessionAuthority)|@supabase\/supabase-js)$/ }, () => ({ path: 'sdk', namespace: 'owned' }));
      build.onResolve({ filter: /^\.\.?\/supabase$/ }, args => path.resolve(args.resolveDir, args.path + '.ts') === path.join(frontend, 'src/lib/supabase.ts')
        ? { path: 'sdk', namespace: 'owned' } : undefined);
      build.onLoad({ filter: /.*/, namespace: 'owned' }, () => ({ contents: sdk, loader: 'tsx', resolveDir: frontend }));
      build.onResolve({ filter: /^@\// }, args => {
        const base = path.join(frontend, 'src', args.path.slice(2));
        const file = [base, base + '.ts', base + '.tsx', path.join(base, 'index.ts'), path.join(base, 'index.tsx')].find(value => existsSync(value));
        assert.ok(file, args.path); return { path: file };
      });
      build.onLoad({ filter: /\.(ts|tsx|css)$/, namespace: 'file' }, async args => {
        if (!/^(artifacts\/negis\/src\/|lib\/|packages\/)/.test(path.relative(root, args.path).replaceAll('\\', '/'))) return;
        return { contents: await record(args.path), loader: path.extname(args.path).slice(1), resolveDir: path.dirname(args.path) };
      });
    } }] });
  assert.ok(!Object.keys(result.metafile.inputs).some(file => /node_modules.*(@supabase|supabase-js)/.test(file)), 'No real auth SDK may enter the bundle');
  for (const file of ['App.tsx', 'contexts/AuthContext.tsx', 'pages/OperatorPortal.tsx', 'pages/ContributorPortal.tsx', 'components/WorkspacePicker.tsx'])
    assert.ok(sourceHashes['artifacts/negis/src/' + file], 'Actual source required: ' + file);
  const cssPath = path.join(frontend, 'src/index.css');
  const compiler = await compile((await record(cssPath)).toString(), { base: path.dirname(cssPath),
    onDependency: file => { if (file.startsWith(path.join(frontend, 'src'))) sourceHashes[path.relative(root, file).replaceAll('\\', '/')] ??= null; } });
  const scanner = new Scanner({ sources: [{ base: path.join(frontend, 'src'), pattern: '**/*.{ts,tsx,css}', negated: false }] });
  const files = new Map(result.outputFiles.map(file => ['/' + path.basename(file.path), {
    type: file.path.endsWith('.css') ? 'text/css' : 'application/javascript', bytes: file.contents }]));
  files.set('/style.css', { type: 'text/css', bytes: compiler.build(scanner.scan()) });
  for (const name of ['inter-latin.woff2', 'inter-cyrillic.woff2', 'inter-cyrillic-ext.woff2']) {
    const file = path.join(frontend, 'public/fonts/inter', name);
    files.set('/fonts/inter/' + name, { type: 'font/woff2', bytes: await record(file) });
  }
  files.set('/favicon.svg', { type: 'image/svg+xml', bytes: await record(path.join(frontend, 'public/favicon.svg')) });
  for (const file of Object.keys(sourceHashes)) if (!sourceHashes[file]) await record(path.join(root, file));
  for (const file of ['scripts/fixtures/portal-auth-entry-browser.mjs', 'scripts/fixtures/portal-auth-entry-browser.test.mjs',
    'scripts/src/appointment-recovery-committed-fixture.ts']) await record(path.join(root, file));
  return { files, sourceHashes };
}

export async function createPortalAuthEntryBrowser() {
  const { files, sourceHashes } = await makeBundle();
  const controls = { requests: [], rejected: [], held: [], holdProfiles: false, memberships: 0,
    profileName: 'PRIVATE SYNTHETIC A', release() { for (const item of this.held.splice(0)) item.send(); } };
  let origin, closed = false;
  const server = createServer((req, res) => {
    if (!portalAuthRequestAllowed(req, origin)) { controls.rejected.push({ path: req.url, method: req.method }); res.writeHead(403).end(); return; }
    const url = new URL(req.url, origin);
    controls.requests.push({ path: url.pathname, method: req.method });
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (url.pathname.startsWith('/api/')) {
      if (!['/api/crm/auth-context', '/api/crm/operator-account', '/api/crm/contributor-account'].includes(url.pathname) || url.search) {
        controls.rejected.push({ path: req.url, method: req.method }); res.writeHead(403).end(); return;
      }
      const match = /^Bearer portal-owned:([AB]):\d+$/.exec(req.headers.authorization ?? '');
      if (!match) { res.writeHead(401).end(); return; }
      const actor = match[1]; let data;
      if (url.pathname === '/api/crm/auth-context') data = { memberships: Array.from({ length: controls.memberships }, (_, index) => ({
        staffUserId: 'synthetic-staff-' + index, workspaceId: 'synthetic-workspace-' + index, workspaceName: 'Synthetic workspace ' + index,
        role: 'owner', permissions: [], vertical: 'clinic', purpose: 'clinic_services' })) };
      else {
        const common = { id: '33333333-3333-4333-8333-333333333333', displayName: actor === 'A' ? controls.profileName : 'PRIVATE SYNTHETIC B' };
        data = url.pathname.endsWith('/operator-account') ? { ...common, status: 'pending', acceptingRequests: false }
          : { ...common, revision: '44444444-4444-4444-8444-444444444444', partnerStatus: 'pending', creatorStatus: 'pending', portfolioUrls: [] };
      }
      // Capture the old response before holding it; later account changes cannot
      // silently turn the stale read into a fresh result.
      const body = JSON.stringify({ success: true, data });
      const send = () => { if (!res.destroyed && !res.writableEnded) res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(body); };
      if (controls.holdProfiles && url.pathname !== '/api/crm/auth-context') controls.held.push({ path: url.pathname, actor, res, send }); else send();
      return;
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
    if (files.has(url.pathname) && !url.search) { const file = files.get(url.pathname); res.writeHead(200, { 'Content-Type': file.type }).end(file.bytes); return; }
    if (!['/', '/operator', '/contributors', '/dashboard', '/privacy', '/terms', '/data-deletion', '/reset-password'].includes(url.pathname)) {
      controls.rejected.push({ path: req.url, method: req.method }); res.writeHead(403).end(); return;
    }
    const sheets = ['/style.css', ...[...files.keys()].filter(file => file.endsWith('.css') && file !== '/style.css')];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; img-src 'self' data:; worker-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" })
      .end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">'
        + sheets.map(file => '<link rel="stylesheet" href="' + file + '">').join('')
        + '</head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  return { origin, controls, sourceHashes, bundleHash: sha(files.get('/entry.js').bytes), styleHash: sha(files.get('/style.css').bytes),
    scope: 'Actual App/SessionContent/AuthProvider/OperatorPortal/ContributorPortal/WorkspacePicker; synthetic SDK and GET-only HTTP. The simple SDK does not autosave or emit auth events when held login promises settle: no atomic SDK persistence claim. No server authorization, database, email delivery, account provisioning, or approved operational workflow acceptance.',
    async assertSourcesUnchanged() { for (const [file, hash] of Object.entries(sourceHashes)) assert.equal(sha(await readFile(path.join(root, file))), hash, 'Runtime changed; rerun after freeze: ' + file); },
    async close() {
      if (closed) return { listening: server.listening, held: controls.held.length };
      closed = true; for (const item of controls.held.splice(0)) item.res.destroy();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      return { listening: server.listening, held: controls.held.length };
    } };
}

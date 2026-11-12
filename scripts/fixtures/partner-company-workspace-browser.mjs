import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const frontend = path.join(root, 'artifacts/negis');
const require = createRequire(path.join(frontend, 'package.json'));
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
export const stopWorkspaceBrowserBuilds = () => esbuild.stop();
export const ids = Object.freeze({ a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222',
  application: '33333333-3333-4333-8333-333333333333', revision: '44444444-4444-4444-8444-444444444444',
  previous: '55555555-5555-4555-8555-555555555555', target: '66666666-6666-4666-8666-666666666666' });
const application = { id: ids.application, revision: ids.revision, state: 'approved', workspaceId: ids.target, sourceState: 'pending_payment',
  company: { name: 'QA selected company', ownerName: 'QA applicant', purpose: 'marketing', vertical: null, timeZone: 'Asia/Almaty' },
  submittedAt: '2026-10-28T01:00:00Z', reviewedAt: '2026-10-28T02:00:00Z', expiresAt: '2026-11-01T01:00:00Z' };
const member = (workspaceId, name) => ({ staffUserId: workspaceId, workspaceId, workspaceName: name, role: 'owner', permissions: [],
  vertical: 'clinic', purpose: 'marketing' });

// Only SDK identity and HTTP responses are synthetic. Parent, client, provider,
// token binding, request guards, list, shell and router all execute unchanged.
const sdkDouble = `
export const hasSupabaseFrontendEnv=true;
export const arrivedByRecoveryLink=false;
export const getRecoverySessionProof=()=>null,consumeRecoverySessionProof=()=>{};
export class StaleAuthIntentError extends Error{name='StaleAuthIntentError';}
export const supabase={auth:{
  onAuthStateChange(callback){const q=window.__appointmentRecovery;q.listeners.add(callback);return{data:{subscription:{unsubscribe(){q.listeners.delete(callback);}}}};},
  async getSession(){return{data:{session:window.__appointmentRecovery.session},error:null};},
  async signOut(){const q=window.__appointmentRecovery;q.signOutCalls++;if(q.signOutPlan.hold)await new Promise(r=>q.releaseSignOut=r);
    if(q.signOutPlan.fail)return{error:Error('Synthetic SDK refusal')};q.emit(null);return{error:null};},
  async signInWithPassword(){throw Error('Fixture forbids credentials');}
}};
// Synthetic dispatch checks only; held replies do not model native auth storage.
const current=scope=>{if(typeof scope?.isCurrent!=='function'||!scope.isCurrent()||scope.signal?.aborted)
  throw Error('Synthetic sessionAuth requires a current caller scope');
  if((scope.expected&&!isCurrent(scope.expected))||(scope.expectedUserId!==undefined&&scope.expectedUserId!==(window.__appointmentRecovery.session?.user.id??null)))throw new StaleAuthIntentError();};
const stamps=new WeakMap();
const capture=()=>{const fixture=window.__appointmentRecovery,stamp=Object.freeze({revision:String(fixture.epoch),intent:String(fixture.intent)});
  stamps.set(stamp,{fixture,actor:fixture.session?.user.id??null,epoch:fixture.epoch});return stamp;};
const isCurrent=stamp=>{const fixture=window.__appointmentRecovery,saved=stamp&&typeof stamp==='object'?stamps.get(stamp):null;
  return !!saved&&saved.fixture===fixture&&saved.actor===(fixture.session?.user.id??null)&&saved.epoch===fixture.epoch;};
export const sessionAuth={onAuthStateChange:supabase.auth.onAuthStateChange,
  capture,isCurrent,updateUserPassword(){throw Error('Fixture forbids password recovery');},
  signOut(scope){current(scope);return supabase.auth.signOut();},
  signInWithPassword(args,scope){current(scope);return supabase.auth.signInWithPassword(args);}};
`;
const entry = `
import React,{useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Router,useLocation} from 'wouter';
import {AuthProvider,useAuth} from './src/contexts/AuthContext';
import PartnerCompany from './src/pages/PartnerCompany';
import Dashboard from './src/pages/Dashboard';
import {ProtectedPage} from './src/App';
import {readWorkspaceId} from './src/lib/demoStorage';
import {clearCrmCache} from './src/lib/api';
const ids=${JSON.stringify(ids)};
const session=id=>id?{user:{id,email:'qa@example.invalid',user_metadata:{},app_metadata:{},aud:'authenticated',created_at:'2026-10-28T00:00:00Z'},
  access_token:(id===ids.a?'synthetic.a.signature':'synthetic.b.signature'),refresh_token:'synthetic-only',expires_in:3600,token_type:'bearer'}:null;
const originalStorage={getItem:Storage.prototype.getItem,setItem:Storage.prototype.setItem,removeItem:Storage.prototype.removeItem};
const selector=()=>{try{return localStorage.getItem('negis_workspace_selector')}catch{return '<storage unavailable>'}};
const q={ids,epoch:0,intent:0,session:session(ids.a),listeners:new Set(),auth:null,denials:[],refusals:[],dashboardReads:[],signOutCalls:0,signOutPlan:{},view:{isCurrentMutationScope:()=>true},
  restoreStorage(){for(const name of Object.keys(originalStorage))Storage.prototype[name]=originalStorage[name];},
  clearCache:clearCrmCache,
  failStorage(all=false){this.restoreStorage();for(const name of Object.keys(originalStorage))Storage.prototype[name]=function(key,...args){
    if(all||(key==='negis_workspace_selector'&&name!=='getItem'))throw Error('Synthetic storage refusal');
    return originalStorage[name].call(this,key,...args);
  };},
  emit(id){this.epoch++;this.intent++;this.session=session(id);for(const cb of [...this.listeners])cb(id?'SIGNED_IN':'SIGNED_OUT',this.session);},
  switch(actor){flushSync(()=>this.emit(ids[actor]??null));},
  aba(){this.emit(ids.b);this.emit(ids.a);},
  refresh(event){this.epoch++;if(!['TOKEN_REFRESHED','USER_UPDATED'].includes(event))this.intent++;for(const cb of [...this.listeners])cb(event,this.session);},
  snapshot(){return{auth:this.auth,selector:selector(),pathname:location.pathname,signOutCalls:this.signOutCalls,
    readWorkspaceId:readWorkspaceId(),dashboardReads:this.dashboardReads,refusals:this.refusals,body:document.body.innerText};}
};
window.__appointmentRecovery=q;
localStorage.setItem('negis_workspace_selector',ids.previous);
history.replaceState({},'', '/partner-company');
const originalFetch=window.fetch.bind(window);
window.fetch=(input,init={})=>{
  const u=new URL(input instanceof Request?input.url:input,location.href);
  if(u.origin!==location.origin||!['/api/crm/partner-company','/api/crm/auth-context','/api/crm/appointments','/api/crm/leads','/api/crm/clients','/api/crm/deals'].includes(u.pathname)||(init.method||'GET')!=='GET'){
    q.refusals.push(String(input));throw Error('Only owned fixture GETs are allowed');
  }
  return originalFetch(u,init).then(response=>{
    if(['/api/crm/appointments','/api/crm/leads','/api/crm/clients','/api/crm/deals'].includes(u.pathname))
      q.dashboardReads.push({id:u.searchParams.get('workspaceId'),path:u.pathname,status:response.status});
    return response;
  });
};
window.open=()=>{q.refusals.push('window.open');return null;};
Object.defineProperty(navigator,'sendBeacon',{configurable:true,value:()=>{q.refusals.push('beacon');return false;}});
function Screen(){
  const auth=useAuth(),[location,navigate]=useLocation();
  q.auth={clinicId:auth.clinicId,userId:auth.user?.id??null,role:auth.userRole,isLoading:auth.isLoading,isSigningOut:auth.isSigningOut,
    purpose:auth.workspacePurpose,choices:auth.availableWorkspaces.map(w=>w.id)};
  q.navigate=path=>flushSync(()=>navigate(path));
  q.select=workspace=>flushSync(()=>auth.selectWorkspace(workspace));
  return location==='/partner-company'?<PartnerCompany/>:<ProtectedPage component={Dashboard} permission="dashboard"/>;
}
const mountedRoot=createRoot(document.getElementById('root'));
q.unmount=()=>{q.restoreStorage();q.releaseSignOut?.();flushSync(()=>mountedRoot.unmount());};
mountedRoot.render(<Router><AuthProvider><Screen/></AuthProvider></Router>);
`;

export async function createWorkspaceBrowser() {
  const bundle = await esbuild.build({ stdin: { contents: entry, loader: 'tsx', resolveDir: frontend, sourcefile: 'owned-workspace-handoff.tsx' },
    bundle: true, write: false, metafile: true, platform: 'browser', target: 'es2022', tsconfig: path.join(frontend, 'tsconfig.json'),
    format: 'iife', jsx: 'automatic', outfile: 'bundle.js', loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl', '.webp': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"',
      'import.meta.env': JSON.stringify({ DEV: false, BASE_URL: '/' }) }, plugins: [{ name: 'owned-sdk-double', setup(build) {
      build.onResolve({ filter: /^@\/lib\/authSessionAuthority$/ }, () => ({ path: path.join(frontend, 'src/lib/supabase.ts') }));
      build.onLoad({ filter: /[\\/]src[\\/]lib[\\/]supabase\.ts$/ }, () => ({ contents: sdkDouble, loader: 'ts' }));
      build.onLoad({ filter: /[\\/]components[\\/]layout[\\/]PageLayout\.tsx$/ }, () => ({ contents: `
        import {PortalShell} from '@/components/portals/PortalShell';
        import {Building2,ClipboardList} from 'lucide-react';
        export function PageLayout({children}){return <PortalShell title="CRM: тестовая компания" roleLabel="Локальный тест" activeId="dashboard"
          homeHref="/dashboard" items={[{id:'dashboard',label:'Главная',icon:Building2,href:'/dashboard'},
          {id:'applications',label:'Заявки компаний',icon:ClipboardList,href:'/partner-company'}]} onNavigate={()=>{}}>{children}</PortalShell>}
      `, loader: 'tsx' }));
    } }] });
  const sourceInputs = Object.keys(bundle.metafile.inputs).filter(name => !name.includes('node_modules') && !name.startsWith('<') && !path.basename(name).startsWith('owned-'))
    .map(name => path.resolve(name)).sort();
  for (const name of ['PartnerCompany.tsx', 'PartnerCompanyInbox.tsx', 'AuthContext.tsx', 'partner-company-client.ts', 'serverAuth.ts', 'api.ts'])
    assert.ok(sourceInputs.some(file => path.basename(file) === name), 'Bundle actual ' + name);
  const files = new Map(bundle.outputFiles.map(file => ['/' + path.basename(file.path), {
    type: file.path.endsWith('.css') ? 'text/css' : 'application/javascript', bytes: file.contents }]));
  const assets = path.join(frontend, 'dist/public/assets');
  const css = (await readdir(assets)).filter(name => /^index-[\w-]+\.css$/.test(name));
  assert.equal(css.length, 1);
  files.set('/built.css', { type: 'text/css', bytes: await readFile(path.join(assets, css[0])) });
  files.set('/favicon.svg', { type: 'image/svg+xml', bytes: await readFile(path.join(frontend, 'public/favicon.svg')) });
  for (const name of ['inter-latin.woff2', 'inter-cyrillic.woff2', 'inter-cyrillic-ext.woff2'])
    files.set('/fonts/inter/' + name, { type: 'font/woff2', bytes: await readFile(path.join(frontend, 'public/fonts/inter', name)) });
  const controls = { calls: [], refusals: [], errors: [], plans: [], held: [], tasks: new Set(), owner: true, dataWorkspaces: new Set([ids.target]),
    queue(kind, plan) { this.plans.push({ kind, ...plan }); },
    release() { for (const held of this.held.splice(0)) held.resolve(); },
    async reset() { this.release(); await Promise.allSettled([...this.tasks]); this.calls = []; this.refusals = []; this.errors = []; this.plans = []; this.owner = true; this.dataWorkspaces = new Set([ids.target]); },
    snapshot() { return { calls: this.calls, errors: this.errors, refusals: this.refusals, pending: this.tasks.size, held: this.held.length }; } };
  async function api(req, res, url) {
    const actor = req.headers.authorization === 'Bearer synthetic.a.signature' ? ids.a
      : req.headers.authorization === 'Bearer synthetic.b.signature' ? ids.b : null;
    assert.ok(actor, 'Actual bound client supplies a known synthetic token');
    const kind = url.pathname === '/api/crm/auth-context' ? 'auth' : ['/api/crm/appointments','/api/crm/leads','/api/crm/clients','/api/crm/deals'].includes(url.pathname) ? 'data'
      : url.searchParams.get('view') === 'workspace' ? 'workspace' : 'list';
    const call = { kind, actor, path: url.pathname + url.search, status: null }; controls.calls.push(call);
    const index = controls.plans.findIndex(plan => plan.kind === kind);
    const plan = index < 0 ? {} : controls.plans.splice(index, 1)[0];
    if (plan.hold) await new Promise(resolve => controls.held.push({ resolve }));
    let data;
    if (kind === 'auth') {
      const memberships = actor === ids.a ? [member(ids.previous, 'QA previous company'), ...(controls.owner ? [member(ids.target, 'QA selected company')] : [])] : [];
      data = { memberships, workspaceId: null, requiresWorkspaceSelection: memberships.length > 1 };
    } else if (kind === 'list') data = { items: actor === ids.a ? [application] : [], offset: 0, state: null, hasMore: false };
    else if (kind === 'workspace') {
      assert.equal(actor, ids.a); assert.equal(url.searchParams.get('applicationId'), ids.application);
      assert.equal(url.searchParams.get('revision'), ids.revision);
      assert.deepEqual([...url.searchParams.keys()].sort(), ['applicationId', 'revision', 'view']);
      data = application;
    } else { assert.ok(controls.dataWorkspaces.has(url.searchParams.get('workspaceId')), 'Never fetch previous-company data through handoff');
      data = { [url.pathname.split('/').at(-1)]: [], timeZone: 'Asia/Almaty' }; }
    call.status = plan.status ?? 200;
    const body = Object.hasOwn(plan, 'value') ? plan.value : { success: call.status === 200, ...(call.status === 200 ? { data } : { code: 'owned_refusal' }) };
    if (!res.destroyed) res.writeHead(call.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  }
  let origin;
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    if (!origin || req.headers.host !== new URL(origin).host) { res.writeHead(403).end(); return; }
    if (req.method !== 'GET') { controls.refusals.push(req.method + ' ' + req.url); res.writeHead(405).end(); return; }
    const url = new URL(req.url, origin);
    if (['/api/crm/partner-company', '/api/crm/auth-context', '/api/crm/appointments', '/api/crm/leads', '/api/crm/clients', '/api/crm/deals'].includes(url.pathname)) {
      const task = api(req, res, url).catch(error => { controls.errors.push(error.message); if (!res.destroyed) res.writeHead(500).end(); });
      controls.tasks.add(task); void task.finally(() => controls.tasks.delete(task)); return;
    }
    const file = files.get(req.url);
    if (file) { res.writeHead(200, { 'Content-Type': file.type }).end(file.bytes); return; }
    if (!['/', '/partner-company', '/dashboard'].includes(url.pathname)) { controls.refusals.push(req.url); res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; connect-src 'self'; frame-src 'none'; base-uri 'none'; form-action 'none'" })
      .end('<!doctype html><html lang="ru"><head><title>Medina OS: локальная проверка</title><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">'
        + '<link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/built.css"><link rel="stylesheet" href="/bundle.css"></head>'
        + '<body style="margin:0;font-family:Inter,sans-serif"><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, controls, sourceInputs, builtCss: path.join(assets, css[0]), async close() {
    controls.release(); await Promise.allSettled([...controls.tasks]); server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

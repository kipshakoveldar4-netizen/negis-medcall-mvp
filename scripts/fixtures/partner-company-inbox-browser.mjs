import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const inboxIds = Object.freeze({
  a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222',
  revision: '33333333-3333-4333-8333-333333333333', workspace: '44444444-4444-4444-8444-444444444444',
  otherWorkspace: '55555555-5555-4555-8555-555555555555',
});
const frontend = path.join(root, 'artifacts/negis');
const require = createRequire(path.join(frontend, 'package.json'));
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
export const stopPartnerCompanyInboxBuilds = () => esbuild.stop();
const copy = value => JSON.parse(JSON.stringify(value));

export function syntheticInboxItems(actorId = inboxIds.a) {
  assert.ok([inboxIds.a, inboxIds.b].includes(actorId));
  const actor = actorId === inboxIds.a ? 'A' : 'B';
  return Array.from({ length: 21 }, (_, index) => {
    const state = ['pending', 'approved', 'rejected'][index % 3];
    const purpose = ['clinic_services', 'marketing', 'mortgage_leads'][index % 3];
    return {
      id: `00000000-0000-4000-8000-${String((actor === 'A' ? 1000 : 2000) + index).padStart(12, '0')}`,
      revision: inboxIds.revision, state,
      company: { name: `SYNTHETIC ${actor} COMPANY ${String(index + 1).padStart(2, '0')}`
        + (index === 0 ? ' - OWNED LOCAL PRIVACY AND RESPONSIVE LAYOUT CHECK' : ''),
      ownerName: `SYNTHETIC ${actor} OWNER ${String(index + 1).padStart(2, '0')}`,
      purpose, vertical: purpose === 'clinic_services' ? 'clinic' : null, timeZone: index % 2 ? 'UTC' : 'Asia/Almaty' },
      workspaceId: state === 'approved' ? (index === 1 ? inboxIds.workspace : inboxIds.otherWorkspace) : null,
      sourceState: state === 'approved' ? 'pending_payment' : 'captured',
      submittedAt: new Date(Date.UTC(2026, 9, 28, 12) - index * 60_000).toISOString(),
      expiresAt: '2026-11-28T12:00:00.000Z', reviewedAt: state === 'pending' ? null : '2026-10-28T13:00:00.000Z',
    };
  });
}

// Identity, read transport and optional workspace callback are synthetic; both UI components are real.
const entry = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ClipboardList,Users} from 'lucide-react';
import {PartnerCompanyInbox} from './src/components/contributors/PartnerCompanyInbox';
import {PortalShell} from './src/components/portals/PortalShell';
const ids=${JSON.stringify(inboxIds)};
const originalFetch=window.fetch.bind(window);
const q={ids,bootId:crypto.randomUUID(),session:{actor:ids.a,epoch:0},valid:true,calls:[],denials:[],newApplications:[],
  workspaceEnabled:document.getElementById('root').dataset.syntheticWorkspace==='enabled',
  workspace:{calls:[],plans:[],held:[],successes:[],failures:[],
    queue(plan){this.plans.push({...plan});},
    release(id){for(const held of this.held.filter(h=>id===undefined||h.id===id)){
      this.held.splice(this.held.indexOf(held),1);held.resolve();
    }},
    snapshot(){return{syntheticOnly:true,held:this.held.map(h=>h.id),successes:this.successes,failures:this.failures,
      calls:this.calls.map(c=>({id:c.id,actorId:c.actorId,revision:c.revision,target:c.target,
        aborted:c.signal.aborted,current:c.isCurrent(),guardAtDispatch:c.guardAtDispatch,guardAtSettlement:c.guardAtSettlement,
        settled:c.settled,outcome:c.outcome,unchanged:JSON.stringify(c.application)===c.applicationJson}))};}
  },
  storageCalls:[],networkRefusals:[],revision:0,key:0,view:{isCurrentMutationScope:()=>true},
  snapshot(){return{bootId:this.bootId,session:this.session,valid:this.valid,denials:this.denials,newApplications:this.newApplications,
    workspaceEnabled:this.workspaceEnabled,workspace:this.workspace.snapshot(),
    calls:this.calls.map(c=>({actorId:c.actorId,revision:c.revision,offset:c.offset,state:c.state,aborted:c.signal.aborted,current:c.isCurrent(),
      settled:c.settled,unchanged:c.raw===undefined||JSON.stringify(c.raw)===c.rawJson})),
    storageCalls:this.storageCalls,networkRefusals:this.networkRefusals,body:document.body.innerText};}
};
window.__appointmentRecovery=q;
for(const method of ['getItem','setItem','removeItem','clear','key']){
  Storage.prototype[method]=function(){q.storageCalls.push(method);throw Error('Inbox must not use browser storage');};
}
window.fetch=(input,options={})=>{
  const u=new URL(input instanceof Request?input.url:input,location.href);
  if(u.origin!==location.origin||u.pathname!=='/fixture/inbox'||(options.method||'GET')!=='GET'){
    q.networkRefusals.push({url:String(input),method:options.method||'GET'});throw Error('Owned inbox read only; external/API/mutation fallback forbidden');
  }
  return originalFetch(u,options);
};
Object.defineProperty(navigator,'sendBeacon',{configurable:true,value:()=>{q.networkRefusals.push('beacon');return false;}});
for(const name of ['XMLHttpRequest','WebSocket','EventSource']){
  window[name]=function(){q.networkRefusals.push(name);throw Error('Owned fixture transport only');};
}
window.open=()=>{q.networkRefusals.push('window.open');return null;};
document.addEventListener('click',event=>{
  const anchor=event.target instanceof Element&&event.target.closest('a[href]');
  if(anchor&&!anchor.getAttribute('href').startsWith('#'))event.preventDefault();
},true);
function Harness(){
  const [session,setSession]=useState(q.session),[revision,setRevision]=useState(q.revision),[key,setKey]=useState(q.key),[shown,setShown]=useState(true);
  q.switch=actor=>{q.valid=true;q.session={actor:ids[actor],epoch:q.session.epoch+1};flushSync(()=>setSession(q.session));};
  q.invalidate=()=>{q.valid=false;q.session={actor:session.actor,epoch:q.session.epoch+1};flushSync(()=>setRevision(++q.revision));};
  q.gate=value=>{q.valid=value;};
  q.swapCallbacks=()=>flushSync(()=>setRevision(++q.revision));
  q.unmount=()=>flushSync(()=>setShown(false));
  q.mount=()=>flushSync(()=>{setKey(++q.key);setShown(true);});
  const request=async options=>{
    const call={...options,actorId:session.actor,revision,settled:false};q.calls.push(call);
    try{
      // Ignore AbortSignal here so real UI guards, not the transport double, fence late replies.
      const response=await fetch('/fixture/inbox?'+new URLSearchParams({actorId:session.actor,offset:String(options.offset),state:options.state??''}),
        {method:'GET',credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});
      if(!response.ok)throw Object.assign(Error('PRIVATE SYNTHETIC REFUSAL MUST NOT BE DISPLAYED'),{status:response.status});
      const raw=await response.json();call.raw=raw;call.rawJson=JSON.stringify(raw);return raw;
    }finally{call.settled=true;}
  };
  const openWorkspace=async(application,{signal,isCurrent})=>{
    if(!(signal instanceof AbortSignal)||typeof isCurrent!=='function')throw Error('Missing synthetic workspace guard');
    const call={id:q.workspace.calls.length+1,actorId:session.actor,revision,application,applicationJson:JSON.stringify(application),
      target:{applicationId:application.id,workspaceId:application.workspaceId},signal,isCurrent,
      guardAtDispatch:!signal.aborted&&isCurrent(),guardAtSettlement:null,settled:false,outcome:'pending'};
    q.workspace.calls.push(call);
    const plan=q.workspace.plans.shift()||{};
    try{
      // Deliberately settle even after abort: the real UI and supplied guard must fence stale completions.
      if(plan.hold)await new Promise(resolve=>q.workspace.held.push({id:call.id,resolve}));
      call.guardAtSettlement=!signal.aborted&&isCurrent()&&q.valid&&q.session===session;
      if(plan.status){
        call.outcome='failure';q.workspace.failures.push({id:call.id,status:plan.status,current:call.guardAtSettlement});
        throw Object.assign(Error('PRIVATE SYNTHETIC WORKSPACE REFUSAL MUST NOT BE DISPLAYED'),{status:plan.status});
      }
      call.outcome=call.guardAtSettlement?'success':'stale';
      if(call.guardAtSettlement)q.workspace.successes.push({syntheticOnly:true,actorId:session.actor,revision,...call.target});
      // A record above is synthetic evidence only: no Auth, workspace selection, navigation or provider call occurs.
    }finally{call.settled=true;}
  };
  return <PortalShell title="Заявки компаний" homeHref="/partner" roleLabel="Партнёр" displayName="SYNTHETIC LOCAL ACTOR"
    items={[{id:'companies',label:'Заявки компаний',icon:ClipboardList},
      {id:'team',label:'Вход для команды',icon:Users,href:'/login'}]} activeId="companies" onNavigate={()=>{}}>
    {shown&&<PartnerCompanyInbox key={key} actorId={session.actor} isSessionCurrent={()=>q.valid&&q.session===session} request={request}
      onAccessDenied={()=>q.denials.push({actorId:session.actor,revision})}
      onOpenWorkspace={q.workspaceEnabled?openWorkspace:undefined}
      onNewApplication={()=>q.newApplications.push({actorId:session.actor,revision})}/>}
  </PortalShell>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;

export async function createPartnerCompanyInboxBrowser() {
  const bundle = await esbuild.build({ stdin: { contents: entry, loader: 'tsx', resolveDir: frontend,
    sourcefile: 'owned-partner-company-inbox.tsx' }, bundle: true, write: false, metafile: true, platform: 'browser',
    tsconfig: path.join(frontend, 'tsconfig.json'), format: 'iife', jsx: 'automatic', outfile: 'bundle.js',
    define: { 'process.env.NODE_ENV': '"production"' } });
  const sourceInputs = Object.keys(bundle.metafile.inputs).filter(name => !name.includes('node_modules') && !path.basename(name).startsWith('owned-'))
    .map(name => path.resolve(name)).sort();
  assert.ok(sourceInputs.some(name => name.endsWith('PartnerCompanyInbox.tsx')), 'Actual inbox is bundled');
  assert.ok(sourceInputs.some(name => name.endsWith('PortalShell.tsx')), 'Actual shell is bundled');
  assert.ok(sourceInputs.every(name => !/[\\/]lib[\\/](api|supabase)\./.test(name)), 'No real API/auth client in the synthetic transport harness');
  const files = new Map(bundle.outputFiles.map(file => ['/' + path.basename(file.path), {
    type: file.path.endsWith('.css') ? 'text/css' : 'application/javascript', bytes: file.contents,
  }]));
  const assets = path.join(frontend, 'dist/public/assets');
  const builtCss = (await readdir(assets)).filter(name => /^index-[\w-]+\.css$/.test(name));
  assert.equal(builtCss.length, 1, 'Reuse exactly one existing built frontend stylesheet; do not rebuild shared assets');
  files.set('/built.css', { type: 'text/css', bytes: await readFile(path.join(assets, builtCss[0])) });
  files.set('/favicon.svg', { type: 'image/svg+xml', bytes: await readFile(path.join(frontend, 'public/favicon.svg')) });
  for (const name of ['inter-latin.woff2', 'inter-cyrillic.woff2', 'inter-cyrillic-ext.woff2']) {
    files.set('/fonts/inter/' + name, { type: 'font/woff2', bytes: await readFile(path.join(frontend, 'public/fonts/inter', name)) });
  }
  files.set('/frame.css', { type: 'text/css', bytes: `
@font-face{font-family:Inter;src:url('/fonts/inter/inter-latin.woff2') format('woff2');font-display:swap;unicode-range:U+0000-00FF;}
@font-face{font-family:Inter;src:url('/fonts/inter/inter-cyrillic.woff2') format('woff2');font-display:swap;unicode-range:U+0400-052F;}
body{margin:0;font-family:Inter,sans-serif;}` });
  const controls = {
    requests: [], errors: [], refusals: [], plans: [], held: [], tasks: new Set(), nextId: 0,
    items: new Map(), workspaceCallback: false,
    queue(plan) { this.plans.push({ ...plan }); },
    release(id) { for (const held of this.held.filter(h => id === undefined || h.id === id)) {
      this.held.splice(this.held.indexOf(held), 1); held.resolve();
    } },
    async reset() {
      this.release(); await Promise.allSettled([...this.tasks]);
      this.requests.length = 0; this.errors.length = 0; this.refusals.length = 0; this.plans.length = 0;
      this.workspaceCallback = false;
      this.items = new Map([[inboxIds.a, syntheticInboxItems(inboxIds.a)], [inboxIds.b, syntheticInboxItems(inboxIds.b)]]);
    },
    snapshot() { return { requests: copy(this.requests), errors: [...this.errors], refusals: copy(this.refusals),
      held: this.held.map(({ id }) => id), pending: this.tasks.size }; },
  };
  await controls.reset();
  async function inbox(url, res) {
    const params = url.searchParams;
    assert.deepEqual([...params.keys()].sort(), ['actorId', 'offset', 'state']);
    const actorId = params.get('actorId'), offset = Number(params.get('offset')), state = params.get('state') || null;
    assert.ok(controls.items.has(actorId), 'Only owned synthetic actors');
    assert.match(params.get('offset'), /^(0|[1-9]\d*)$/);
    assert.ok(Number.isInteger(offset) && offset >= 0 && offset <= 1_000_000);
    assert.ok(state === null || ['pending', 'approved', 'rejected'].includes(state));
    const record = { id: ++controls.nextId, method: 'GET', actorId, offset, state, status: null };
    controls.requests.push(record);
    const index = controls.plans.findIndex(p => (p.offset === undefined || p.offset === offset)
      && (p.state === undefined || p.state === state) && (p.actorId === undefined || p.actorId === actorId));
    const plan = index < 0 ? {} : controls.plans.splice(index, 1)[0];
    const matching = controls.items.get(actorId).filter(item => state === null || item.state === state);
    const value = copy(Object.hasOwn(plan, 'value') ? plan.value : { items: matching.slice(offset, offset + 20), offset, state,
      hasMore: matching.length > offset + 20 });
    if (plan.hold) await new Promise(resolve => controls.held.push({ id: record.id, resolve }));
    record.status = plan.status ?? 200;
    res.writeHead(record.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
  }
  let origin;
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!origin || req.headers.host !== new URL(origin).host) { res.writeHead(403).end(); return; }
    if (req.method !== 'GET') { controls.refusals.push({ method: req.method, url: req.url }); res.writeHead(405).end(); return; }
    const url = new URL(req.url, origin);
    if (url.pathname === '/fixture/inbox') {
      const task = inbox(url, res).catch(error => {
        controls.errors.push(error.message);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Owned inbox fixture assertion' }));
      });
      controls.tasks.add(task); void task.finally(() => controls.tasks.delete(task)); return;
    }
    const file = files.get(req.url);
    if (file) { res.writeHead(200, { 'Content-Type': file.type }).end(file.bytes); return; }
    if (req.url !== '/') { controls.refusals.push({ method: req.method, url: req.url }); res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; connect-src 'self'; frame-src 'none'; base-uri 'none'; form-action 'none'" })
      .end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">'
        + '<link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/built.css"><link rel="stylesheet" href="/frame.css">'
        + '<link rel="stylesheet" href="/bundle.css"></head><body><div id="root" data-synthetic-workspace="'
        + (controls.workspaceCallback ? 'enabled' : 'disabled') + '"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, controls, sourceInputs, builtCss: path.join(assets, builtCss[0]), async close() {
    controls.release(); await Promise.allSettled([...controls.tasks]);
    server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

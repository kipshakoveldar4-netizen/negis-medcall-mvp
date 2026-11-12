import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const companyIds = Object.freeze({
  a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222',
  sourceA: '33333333-3333-4333-8333-333333333333', sourceB: '44444444-4444-4444-8444-444444444444',
  revision: '55555555-5555-4555-8555-555555555555', approvedRevision: '66666666-6666-4666-8666-666666666666',
  workspace: '77777777-7777-4777-8777-777777777777',
});
const frontend = path.join(root, 'artifacts/negis');
const require = createRequire(path.join(frontend, 'package.json'));
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
export const stopPartnerCompanyApplicationBuilds = () => esbuild.stop();
const copy = value => JSON.parse(JSON.stringify(value));
const uuid = value => typeof value === 'string' && value.length === 36
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const commandKey = (actorId, requestId) => actorId + ':' + requestId;

// These are transport/identity doubles, not substitutes for the imported component or SQL proof.
const entry = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {PartnerCompanyApplication} from './src/components/contributors/PartnerCompanyApplication';
const ids=${JSON.stringify(companyIds)};
const originalFetch=window.fetch.bind(window);
const originalStorage={getItem:Storage.prototype.getItem,setItem:Storage.prototype.setItem,removeItem:Storage.prototype.removeItem};
const q={ids,bootId:crypto.randomUUID(),session:{actor:ids.a,epoch:0},calls:[],denials:[],heldCallbacks:[],networkRefusals:[],revision:0,key:0,
  view:{isCurrentMutationScope:()=>true},
  restoreStorage(){for(const name of Object.keys(originalStorage))Storage.prototype[name]=originalStorage[name];},
  failStorage(method){this.restoreStorage();Storage.prototype[method]=function(key,...args){
    if(key.startsWith('medina_partner_company_v1:'))throw Error('Owned storage refusal');
    return originalStorage[method].call(this,key,...args);
  };},
  snapshot(){return{bootId:this.bootId,session:this.session,denials:this.denials,
    calls:this.calls.map(c=>({operation:c.operation,body:c.body,requestId:c.requestId,sourceId:c.sourceId,revision:c.revision,actorId:c.actorId,
      frozen:c.frozen,aborted:c.signal.aborted,current:c.isCurrent()})),
    recovery:Object.keys(sessionStorage).map(key=>[key,sessionStorage.getItem(key)]),
    localStorage:Object.keys(localStorage),body:document.body.innerText,networkRefusals:this.networkRefusals};}
};
window.fetch=(url,options)=>{const u=new URL(url,location.href);
  if(u.origin!==location.origin||u.pathname!=='/fixture/operation'||options?.method!=='POST'){
    q.networkRefusals.push(String(url));throw Error('Owned fixture forbids external/API/provider fallback');
  }
  return originalFetch(u,options);
};
Object.defineProperty(navigator,'sendBeacon',{configurable:true,value:()=>{q.networkRefusals.push('beacon');return false;}});
window.open=()=>null;
document.addEventListener('click',event=>{if(event.target instanceof Element&&event.target.closest('a[href]'))event.preventDefault();},true);
function Harness(){
  const [session,setSession]=useState(q.session),[revision,setRevision]=useState(q.revision),[key,setKey]=useState(q.key),[shown,setShown]=useState(true);
  q.switch=actor=>{q.session={actor:ids[actor],epoch:q.session.epoch+1};flushSync(()=>setSession(q.session));};
  q.invalidate=()=>{q.session={actor:session.actor,epoch:q.session.epoch+1};flushSync(()=>setRevision(++q.revision));};
  q.swapCallbacks=()=>flushSync(()=>setRevision(++q.revision));
  q.remount=()=>flushSync(()=>setKey(++q.key));
  q.unmount=()=>flushSync(()=>setShown(false));
  q.mount=()=>flushSync(()=>{setKey(++q.key);setShown(true);});
  const request=async options=>{
    const call={...options,revision,actorId:session.actor,
      frozen:options.body?Object.isFrozen(options.body)&&Object.isFrozen(options.body.company):null};
    q.calls.push(call);
    // Intentionally ignore AbortSignal at the synthetic transport: stale completions exercise the real component guards.
    const response=await fetch('/fixture/operation',{method:'POST',credentials:'omit',cache:'no-store',redirect:'error',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:options.operation,actorId:session.actor,
        ...(options.body===undefined?{}:{body:options.body}),...(options.requestId===undefined?{}:{requestId:options.requestId}),
        ...(options.sourceId===undefined?{}:{sourceId:options.sourceId})})});
    if(!response.ok)throw Object.assign(Error('PRIVATE SYNTHETIC TRANSPORT REFUSAL'),{status:response.status});
    return response.json();
  };
  return <main className="owned-company-page">{shown&&<PartnerCompanyApplication key={key} actorId={session.actor}
    isSessionCurrent={()=>q.session===session} request={request} onAccessDenied={()=>q.denials.push({revision,actorId:session.actor})}/>}</main>;
}
window.__appointmentRecovery=q;
createRoot(document.getElementById('root')).render(<Harness/>);
`;

export async function createPartnerCompanyApplicationBrowser() {
  const bundle = await esbuild.build({ stdin: { contents: entry, loader: 'tsx', resolveDir: frontend,
    sourcefile: 'owned-partner-company-application.tsx' }, bundle: true, write: false, platform: 'browser',
    format: 'iife', jsx: 'automatic', outfile: 'bundle.js', define: { 'process.env.NODE_ENV': '"production"' } });
  const files = new Map(bundle.outputFiles.map(file => ['/' + path.basename(file.path), {
    type: file.path.endsWith('.css') ? 'text/css' : 'application/javascript', bytes: file.contents,
  }]));
  const assets = path.join(frontend, 'dist/public/assets');
  const builtCss = (await readdir(assets).catch(error => { if (error.code === 'ENOENT') return []; throw error; }))
    .filter(name => /^index-[\w-]+\.css$/.test(name));
  assert.ok(builtCss.length <= 1, 'At most one current frontend index stylesheet');
  if (builtCss.length) files.set('/built.css', { type: 'text/css', bytes: await readFile(path.join(assets, builtCss[0])) });
  for (const name of ['inter-latin.woff2', 'inter-cyrillic.woff2', 'inter-cyrillic-ext.woff2']) {
    files.set('/fonts/inter/' + name, { type: 'font/woff2', bytes: await readFile(path.join(frontend, 'public/fonts/inter', name)) });
  }
  files.set('/frame.css', { type: 'text/css', bytes: `
@font-face{font-family:Inter;src:url('/fonts/inter/inter-latin.woff2') format('woff2');font-display:swap;unicode-range:U+0000-00FF;}
@font-face{font-family:Inter;src:url('/fonts/inter/inter-cyrillic.woff2') format('woff2');font-display:swap;unicode-range:U+0400-052F;}
body{margin:0;background:#f5f7f6;}.owned-company-page{box-sizing:border-box;max-width:1000px;min-height:100vh;margin:0 auto;padding:24px;background:#fff;}` });

  const controls = {
    requests: [], errors: [], commands: new Map(), applications: new Map(), plans: [], held: [], tasks: new Set(),
    sources: new Map(), expiresAt: '', contextStatus: 0, contextValue: undefined, cookieAvailable: true, commits: 0,
    queue(operation, plan) { this.plans.push({ operation, ...plan }); },
    release() { for (const held of this.held.splice(0)) held.resolve(); },
    async reset() {
      this.release();
      await Promise.allSettled([...this.tasks]);
      this.requests.length = 0; this.errors.length = 0; this.commands.clear(); this.applications.clear(); this.plans.length = 0;
      this.sources = new Map([[companyIds.a, companyIds.sourceA], [companyIds.b, companyIds.sourceB]]);
      this.expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      this.contextStatus = 0; this.contextValue = undefined; this.cookieAvailable = true; this.commits = 0;
    },
    receipt(actorId, requestId) { return copy(this.commands.get(commandKey(actorId, requestId))?.receipt ?? null); },
    approve(actorId, requestId, { expired = false } = {}) {
      const key = commandKey(actorId, requestId), command = this.commands.get(key);
      assert.equal(command?.receipt.state, 'committed');
      const application = { ...command.receipt.application, revision: companyIds.approvedRevision, state: 'approved',
        workspaceId: companyIds.workspace, sourceState: expired ? 'expired' : 'pending_payment', reviewedAt: new Date().toISOString(),
        ...(expired ? { submittedAt: new Date(Date.now() - 7_200_000).toISOString(), expiresAt: new Date(Date.now() - 3_600_000).toISOString() } : {}) };
      command.receipt = { ...command.receipt, application };
      this.applications.set(key, application);
    },
    snapshot() { return { requests: copy(this.requests), commands: [...this.commands.values()].map(copy),
      applications: [...this.applications.values()].map(copy), commits: this.commits, held: this.held.length, cookieAvailable: this.cookieAvailable }; },
  };
  await controls.reset();
  const pause = async (plan, stage, record) => {
    if (plan.hold === stage) await new Promise(resolve => controls.held.push({ resolve, operation: record.operation, stage, record }));
  };
  function resultFor(input) {
    const { operation, actorId } = input;
    assert.ok([companyIds.a, companyIds.b].includes(actorId), 'Only synthetic fixture actors');
    if (operation === 'context') {
      if (controls.contextStatus || !controls.cookieAvailable) return { status: controls.contextStatus || 404, value: { error: 'Owned context unavailable' } };
      return { status: 200, value: controls.contextValue !== undefined ? copy(controls.contextValue) : {
        sourceId: controls.sources.get(actorId), expiresAt: controls.expiresAt,
        applicantEmail: actorId === companyIds.a ? 'private.a@fixture.invalid' : 'private.b@fixture.invalid',
        notice: { version: 'owned-v1', purpose: 'partner_company_registration', text: 'SYNTHETIC company registration notice. Local checks only.',
          policyRevision: 'owned-v1', policyUrl: 'https://policy.fixture.invalid/company', sha256: 'a'.repeat(64) },
      } };
    }
    const requestId = operation === 'submit' ? input.body?.requestId : input.requestId;
    assert.ok(uuid(requestId));
    const key = commandKey(actorId, requestId), existing = controls.commands.get(key);
    if (operation === 'submit') {
      if (existing) {
        assert.equal(existing.bodyJson === null || existing.bodyJson === JSON.stringify(input.body), true, 'Same command cannot change payload');
        return { status: 200, value: copy(existing.receipt) };
      }
      const sourceId = controls.sources.get(actorId);
      const application = { id: requestId, revision: companyIds.revision, state: 'pending', company: copy(input.body.company),
        workspaceId: null, sourceState: 'captured', expiresAt: controls.expiresAt, submittedAt: new Date().toISOString(), reviewedAt: null };
      const receipt = { state: 'committed', requestId, sourceId, application };
      controls.commands.set(key, { actorId, sourceId, bodyJson: JSON.stringify(input.body), receipt });
      controls.applications.set(key, application); controls.commits++;
      return { status: 200, value: copy(receipt) };
    }
    assert.ok(uuid(input.sourceId));
    if (existing && existing.sourceId !== input.sourceId) return { status: 404, value: { error: 'Owned foreign source' } };
    if (existing) return { status: 200, value: copy(existing.receipt) };
    const receipt = { state: operation === 'close' ? 'abandoned' : 'unconfirmed', requestId, sourceId: input.sourceId };
    if (operation === 'close') controls.commands.set(key, { actorId, sourceId: input.sourceId, bodyJson: null, receipt });
    return { status: 200, value: receipt };
  }
  async function operation(req, res) {
    let size = 0, chunks = [];
    for await (const chunk of req) { size += chunk.length; assert.ok(size <= 16_384); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.ok(['context', 'submit', 'read', 'close'].includes(input.operation));
    const record = { ...copy(input), status: null };
    controls.requests.push(record);
    const index = controls.plans.findIndex(plan => plan.operation === input.operation);
    const plan = index < 0 ? {} : controls.plans.splice(index, 1)[0];
    await pause(plan, 'before', record);
    let result = plan.status || plan.failure === 'before'
      ? { status: plan.status || 503, value: { error: 'Owned transport failure' } } : resultFor(input);
    await pause(plan, 'after', record);
    if (plan.failure === 'after') result = { status: 503, value: { error: 'Owned lost acknowledgement' } };
    if (plan.reply === 'wrong-source') result.value = { ...result.value, sourceId: companyIds.sourceB };
    if (plan.reply === 'wrong-request') result.value = { ...result.value, requestId: companyIds.b };
    if (plan.reply === 'wrong-application') result.value.application.id = companyIds.b;
    if (plan.reply === 'wrong-company') result.value.application.company.name = 'FOREIGN SYNTHETIC COMPANY';
    record.status = result.status;
    res.writeHead(result.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(result.value));
  }

  let origin;
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!origin || req.headers.host !== new URL(origin).host) { res.writeHead(403).end(); return; }
    if (req.url === '/fixture/operation' && req.method === 'POST' && req.headers.origin === origin) {
      const task = operation(req, res).catch(error => {
        controls.errors.push(error.message);
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Owned fixture assertion', detail: error.message }));
      });
      controls.tasks.add(task); void task.finally(() => controls.tasks.delete(task)); return;
    }
    if (req.method !== 'GET') { res.writeHead(403).end(); return; }
    const file = files.get(req.url);
    if (file) { res.writeHead(200, { 'Content-Type': file.type }).end(file.bytes); return; }
    if (req.url !== '/') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; frame-src 'none'; base-uri 'none'; form-action 'none'" })
      .end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">'
        + (builtCss.length ? '<link rel="stylesheet" href="/built.css">' : '')
        + '<link rel="stylesheet" href="/frame.css"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, controls, builtCss: builtCss[0] ?? null, async close() {
    controls.release(); await Promise.allSettled([...controls.tasks]);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  } };
}

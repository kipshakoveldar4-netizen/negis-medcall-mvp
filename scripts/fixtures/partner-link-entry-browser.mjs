import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const frontend = path.join(root, 'artifacts/negis'), require = createRequire(path.join(frontend, 'package.json'));
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
export const stopPartnerLinkBrowserBuilds = () => esbuild.stop();
const entry = `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
import{PartnerLink}from './src/components/contributors/PartnerLink';
import{PartnerEntryView}from './src/pages/PartnerEntry';
import{PortalShell}from './src/components/portals/PortalShell';
import{Users}from'lucide-react';
const ids={a:'11111111-1111-4111-8111-111111111111',b:'22222222-2222-4222-8222-222222222222',
 profileA:'33333333-3333-4333-8333-333333333333',profileB:'44444444-4444-4444-8444-444444444444',
 revision:'55555555-5555-4555-8555-555555555555',agreement:'66666666-6666-4666-8666-666666666666'};
const code='A'.repeat(32),otherCode='B'.repeat(32),policy='2026-10-27-7d-self-v1';
const copy=v=>JSON.parse(JSON.stringify(v));
const q={ids,calls:[],copies:[],denied:0,held:[],holdNext:false,holdCopy:false,copyReleases:[],
 context:{actor:ids.a,profile:ids.profileA,epoch:0},mode:'link',code,entryEpoch:0,frame:null,dropCapture:false,dropPrepare:false,
 notice:{siteKey:'owned-synthetic-site-key',notice:{version:'owned-v1',purpose:'partner_attribution',
 text:'СИНТЕТИЧЕСКОЕ СОГЛАСИЕ ДЛЯ ЛОКАЛЬНОЙ ПРОВЕРКИ. Не юридический текст.',policyRevision:'owned-v1',policyUrl:'https://policy.fixture.invalid/partner',sha256:'a'.repeat(64)}},
 linkValue:null,linkError:0,challengeError:false,challengeCalls:0,challengeHeld:false,
 view:{isCurrentMutationScope:()=>true},snapshot(){return{mode:this.mode,calls:this.calls,copies:this.copies,denied:this.denied,body:document.body.innerText};}};
const linkFor=()=>({profileId:q.context.profile,profileRevision:ids.revision,agreementRevision:ids.agreement,
 referralCode:q.context.actor===ids.a?code:otherCode,url:'https://entry.fixture.invalid/r/'+(q.context.actor===ids.a?code:otherCode),policyVersion:policy});
const pause=async value=>{if(q.holdNext){q.holdNext=false;await new Promise(resolve=>q.held.push(resolve));}return value;};
const linkRequest=async options=>{q.calls.push({op:'link',actor:q.context.actor,profile:q.context.profile});
 const result=copy(q.linkValue??linkFor()),status=q.linkError;await pause(null);if(status)throw Object.assign(Error('Синтетический отказ'),{status});return result;};
const request=async(op,body,signal)=>{q.calls.push({op,body:copy(body)});let value;
 if(op==='notice')value=copy(q.notice);
 else if(op==='prepare'){q.frame??={id:'77777777-7777-4777-8777-777777777777',capturedAt:'2026-10-28T08:00:00.000Z',expiresAt:'2026-11-04T08:00:00.000Z',policyVersion:policy};value={prepared:true,expiresAt:q.frame.expiresAt};if(q.dropPrepare){q.dropPrepare=false;await pause(null);throw Error('Ответ подготовки потерян');}}
 else if(op==='capture'){if(!q.frame)throw Error('No original frame');value=copy(q.frame);if(q.dropCapture){q.dropCapture=false;await pause(null);throw Error('Ответ потерян после сохранения');}}
 else throw Error('Unknown owned operation');return pause(value);};
const challenge=async(siteKey,element,signal)=>{q.challengeCalls++;if(q.challengeHeld)await new Promise(resolve=>q.held.push(resolve));
 if(q.challengeError)throw Error('Синтетическая недоступность проверки');return'owned-synthetic-challenge';};
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{async writeText(value){q.copies.push(value);if(q.holdCopy)await new Promise(resolve=>q.copyReleases.push(resolve));}}});
window.fetch=()=>{throw Error('Browser fixture forbids network API/provider fallback');};
Object.defineProperty(navigator,'sendBeacon',{configurable:true,value:()=>false});
window.open=()=>null;document.addEventListener('click',event=>{const a=event.target instanceof Element?event.target.closest('a[href]'):null;
 if(a&&new URL(a.getAttribute('href'),location.href).origin!==location.origin)event.preventDefault();},true);
function Harness(){const[context,setContext]=useState(q.context),[mode,setMode]=useState(q.mode),[epoch,setEpoch]=useState(q.entryEpoch),[entryCode,setCode]=useState(q.code);
 q.switch=actor=>{q.context={actor:actor==='b'?ids.b:ids.a,profile:actor==='b'?ids.profileB:ids.profileA,epoch:q.context.epoch+1};flushSync(()=>setContext(q.context));};
 q.show=value=>{q.mode=value;flushSync(()=>setMode(value));};q.remountEntry=()=>{q.entryEpoch++;flushSync(()=>setEpoch(q.entryEpoch));};
 q.changeCode=value=>{q.code=value;flushSync(()=>setCode(value));};q.release=()=>{for(const fn of q.held.splice(0))fn();};
 q.releaseCopies=()=>{for(const fn of q.copyReleases.splice(0))fn();};
 return mode==='entry'?<PartnerEntryView key={epoch} code={entryCode} request={request} challenge={challenge}/>:
 <PortalShell title="Партнёрский кабинет" roleLabel="Кабинет партнёра" homeHref="/" items={[{id:'overview',label:'Обзор',icon:Users}]} activeId="overview" onNavigate={()=>{}}>
 <PartnerLink key={context.epoch} actorId={context.actor} profileId={context.profile} isSessionCurrent={()=>q.context===context}
 request={linkRequest} onAccessDenied={()=>{q.denied++;}}/></PortalShell>;}
window.__appointmentRecovery=q;createRoot(document.getElementById('root')).render(<Harness/>);
`;

export async function createPartnerLinkEntryBrowserFixture() {
  const bundle = await esbuild.build({ stdin: { contents: entry, resolveDir: frontend, loader: 'tsx' }, bundle: true, write: false,
    platform: 'browser', format: 'iife', jsx: 'automatic', outfile: 'bundle.js',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.BASE_URL': '"/"' },
    plugins: [{ name: 'owned-partner-link-browser', setup(build) {
      build.onResolve({ filter: /^@\// }, args => {
        const base = path.join(frontend, 'src', args.path.slice(2)), file = [base + '.ts', base + '.tsx'].find(existsSync);
        assert.ok(file, args.path); return { path: file };
      });
    } }] });
  const assetsFolder = path.join(frontend, 'dist/public/assets'), names = (await readdir(assetsFolder)).filter(name => /^index-[\w-]+\.css$/.test(name));
  assert.equal(names.length, 1, 'Build current app before styled browser verification');
  const files = new Map([['/style.css', { type: 'text/css', bytes: await readFile(path.join(assetsFolder, names[0])) }]]);
  for (const file of bundle.outputFiles) files.set('/' + path.basename(file.path), { type: file.path.endsWith('.css') ? 'text/css' : 'application/javascript', bytes: file.text });
  for (const name of ['inter-latin.woff2', 'inter-cyrillic.woff2', 'inter-cyrillic-ext.woff2'])
    files.set('/fonts/inter/' + name, { type: 'font/woff2', bytes: await readFile(path.join(frontend, 'public/fonts/inter', name)) });
  files.set('/favicon.svg', { type: 'image/svg+xml', bytes: await readFile(path.join(frontend, 'public/favicon.svg')) });
  let origin;
  const server = createServer((req, res) => {
    if (!origin || req.headers.host !== new URL(origin).host || req.method !== 'GET') { res.writeHead(403).end(); return; }
    const url = new URL(req.url, origin);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (files.has(url.pathname)) { const file = files.get(url.pathname); res.writeHead(200, { 'Content-Type': file.type }).end(file.bytes); return; }
    if (url.pathname !== '/') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self'; frame-src 'none'; base-uri 'none'; form-action 'self'" })
      .end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><link rel="stylesheet" href="/style.css">'
        + (files.has('/bundle.css') ? '<link rel="stylesheet" href="/bundle.css">' : '')
        + '</head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

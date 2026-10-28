import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { createControlSubscriptionHttpFixture } from './control-subscription-browser.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),control=path.join(root,'artifacts/medina-control');
const require=createRequire(path.join(control,'package.json')),esbuild=createRequire(require.resolve('vite/package.json'))('esbuild');
async function sourceHashes(){
  const hashes={};for(const file of ['artifacts/medina-control/src/App.tsx','artifacts/medina-control/src/screens/PartnerCompanies.tsx',
    'artifacts/medina-control/src/screens/partner-companies.css','artifacts/medina-control/src/lib/api.ts','lib/crm/partner-company-contracts.ts'])
    hashes[file]=createHash('sha256').update(await readFile(path.join(root,file))).digest('hex');
  return hashes;
}
const sdk=`const ids={A:'11111111-1111-4111-8111-111111111111',B:'22222222-2222-4222-8222-222222222222'};
  let actor=new URLSearchParams(location.search).has('guest')?null:'A';const listeners=new Set();
  const session=()=>actor?{user:{id:ids[actor],email:'owned-'+actor+'@example.invalid'},access_token:'fixture-control-'+actor}:null;
  export function select(next){actor=next;for(const fn of [...listeners])fn(next?'SIGNED_IN':'SIGNED_OUT',session());}
  export const controlConfig={ready:true,apiOrigin:location.origin};
  export const supabase={auth:{getSession:async()=>({data:{session:session()},error:null}),onAuthStateChange:fn=>{listeners.add(fn);return{data:{subscription:{unsubscribe:()=>listeners.delete(fn)}}};},
    signOut:async()=>{select(null);return{error:null};},signInWithPassword:async()=>{throw Error('Use only the synthetic actor');}}};`;

// Bounded synthetic HTTP behavior only. This deliberately does not implement or
// import service/SQL authorization, transactions, workspace provisioning, or Auth.
function createPartnerCompanyQueue(){
  const endpoint='/api/crm/platform-partner-companies',copy=value=>structuredClone(value);
  const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const rows=Array.from({length:22},(_,index)=>({id:id(100-index),revision:id(1000-index),state:'pending',
    company:{name:index===0?'Synthetic company '+ 'W'.repeat(102):`Synthetic company ${index+1}`,purpose:'marketing',vertical:null,
      timeZone:'Asia/Qyzylorda',ownerName:index===0?'Synthetic owner '+ 'O'.repeat(104):`Synthetic owner ${index+1}`},
    workspaceId:null,sourceState:'captured',expiresAt:'2026-12-01T12:00:00Z',submittedAt:'2026-10-01T12:00:00Z',reviewedAt:null}));
  const operations=new Map(),requests=[],held=[];
  const state={requests,held,fault:null,denied:false,counts:{reviews:0,commits:0,retries:0,closes:0,reads:0,denied:0},
    snapshot:()=>copy({rows,requests,counts:state.counts,operations:[...operations.values()],held:held.length}),
    release(){for(const item of held.splice(0))item.send();},close(){for(const item of held.splice(0))item.res.destroy();}};
  const exact=(value,names)=>value&&typeof value==='object'&&!Array.isArray(value)
    &&Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
  const fields=['requestId','applicationId','revision','action'];
  const command=value=>exact(value,fields)&&fields.slice(0,3).every(k=>typeof value[k]==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value[k]))
    &&['approve','reject'].includes(value.action)?Object.fromEntries(fields.map(k=>[k,value[k]])):null;
  const send=(res,status,data)=>{if(!res.destroyed&&!res.writableEnded)res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}).end(JSON.stringify(status===200?{success:true,data}:{success:false,error:'Synthetic fixture refusal'}));};
  state.handle=async(req,res,url)=>{
    if(url.pathname!==endpoint)return false;
    const actor=req.headers.authorization==='Bearer fixture-control-A'?'A':req.headers.authorization==='Bearer fixture-control-B'?'B':'guest';
    const entry={actor,method:req.method,query:Object.fromEntries(url.searchParams),kind:'list'};requests.push(entry);
    if(actor!=='A'||state.denied){state.counts.denied++;send(res,404,null);return true;}
    try{
      let body;
      if(req.method==='POST'){
        if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw Error('json_required');
        const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>4096)throw Error('body_limit');chunks.push(chunk);}
        entry.rawBody=Buffer.concat(chunks).toString('utf8');body=JSON.parse(entry.rawBody);entry.body=copy(body);
      }else if(req.method!=='GET')throw Error('method');
      const kind=req.method==='POST'?(body?.operation==='close'?'close':'review'):url.searchParams.has('requestId')?'read':'list';entry.kind=kind;
      const metadata=kind==='list'?null:command(kind==='read'?Object.fromEntries(url.searchParams):kind==='close'&&exact(body,['operation',...fields])?Object.fromEntries(fields.map(k=>[k,body[k]])):body);
      if(kind!=='list'&&!metadata)throw Error('metadata');
      if(req.method==='POST'&&url.search)throw Error('query');
      const fault=state.fault?.kind===kind?state.fault:null;if(fault)state.fault=null;
      // A disconnected pooled socket can transparently replay a POST in Chromium.
      // A truncated receipt keeps the intended unknown result deterministic.
      const loseReceipt=()=>{entry.receipt='truncated';if(!res.destroyed&&!res.writableEnded)res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end('{"success":true,"data":');};
      const execute=()=>{
        let result;
        if(kind==='list'){
          const offset=url.searchParams.get('offset'),filter=url.searchParams.get('state');
          if(!/^\d{1,7}$/.test(offset||'')||Number(offset)>1000000||(filter!==null&&!['pending','approved','rejected'].includes(filter))
            ||[...url.searchParams.keys()].some(k=>!['offset','state'].includes(k))||url.searchParams.getAll('offset').length!==1||url.searchParams.getAll('state').length>1)throw Error('page');
          const filtered=rows.filter(row=>filter===null||row.state===filter),start=Number(offset);
          result={items:copy(filtered.slice(start,start+20)),offset:start,state:filter,hasMore:filtered.length>start+20};
        }else{
          const previous=operations.get(metadata.requestId);
          if(previous&&fields.some(k=>previous[k]!==metadata[k]))throw Error('original_metadata');
          if(kind==='read'){state.counts.reads++;result=previous||{...metadata,state:'unconfirmed'};}
          else if(kind==='close'){state.counts.closes++;result=previous||{...metadata,state:'abandoned'};operations.set(metadata.requestId,copy(result));}
          else{
            state.counts.reviews++;
            if(previous){state.counts.retries++;result=previous;}
            else{
              const row=rows.find(row=>row.id===metadata.applicationId);
              if(!row||row.state!=='pending'||row.revision!==metadata.revision)throw Error('changed');
              Object.assign(row,{revision:randomUUID(),state:metadata.action==='approve'?'approved':'rejected',
                workspaceId:metadata.action==='approve'?randomUUID():null,sourceState:metadata.action==='approve'?'pending_payment':'captured',reviewedAt:'2026-10-28T12:00:00Z'});
              state.counts.commits++;result={...metadata,state:'committed',application:copy(row)};operations.set(metadata.requestId,copy(result));
            }
          }
        }
        const deliver=()=>send(res,200,result);
        if(fault?.when==='after'&&fault.mode==='hold')held.push({kind,command:metadata,res,send:deliver});
        else if(fault?.when==='after'&&fault.mode==='lose')loseReceipt();else deliver();
      };
      if(fault?.when==='before'&&fault.mode==='lose')loseReceipt();
      else if(fault?.when==='before'&&fault.mode==='hold')held.push({kind,command:metadata,res,send:()=>{try{execute();}catch{send(res,409,null);}}});
      else execute();
    }catch{send(res,400,null);}
    return true;
  };
  return state;
}
export async function createControlLazyBrowser(port=0){
  assert.ok(Number.isInteger(port)&&port>=0&&port<=65535,'Owned loopback port required');
  const hashes=await sourceHashes();
  const entry=`import React,{StrictMode}from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
    import App from ${JSON.stringify(path.join(control,'src/App.tsx').replaceAll('\\','/'))};import{select,supabase}from'owned-control-sdk';
    const f={bootId:crypto.randomUUID(),view:{isCurrentMutationScope:()=>true},change(value){flushSync(()=>select(value));},aba(){flushSync(()=>{select('B');select('A');});},
      snapshot(){return{text:document.body.innerText,overflow:document.documentElement.scrollWidth>innerWidth+1};}};window.__appointmentRecovery=f;
    void supabase.auth.getSession().then(()=>createRoot(document.getElementById('root')).render(<StrictMode><App/></StrictMode>));`;
  const outdir=path.join(root,'node_modules/.cache/control-lazy-bundle');
  const result=await esbuild.build({stdin:{contents:entry,loader:'tsx',resolveDir:control,sourcefile:'owned-control-entry.tsx'},bundle:true,write:false,outdir,
    entryNames:'entry',chunkNames:'[name]-[hash]',format:'esm',splitting:true,platform:'browser',jsx:'automatic',metafile:true,
    define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'owned-control-auth-only',setup(build){
      build.onResolve({filter:/^owned-control-sdk$/},()=>({path:'sdk',namespace:'owned'}));
      build.onResolve({filter:/^\.\.?\/lib\/supabase$|^\.\/supabase$/},args=>{
        const p=path.resolve(path.dirname(args.importer),args.path+'.ts');return p===path.join(control,'src/lib/supabase.ts')?{path:'sdk',namespace:'owned'}:undefined;
      });
      build.onLoad({filter:/.*/,namespace:'owned'},()=>({contents:sdk,loader:'ts'}));
    }}]});
  const screens={};for(const[key,value]of Object.entries(result.metafile.outputs)){
    const match=value.entryPoint?.replaceAll('\\','/').match(/\/screens\/(\w+)\.tsx$/);if(match)screens[match[1]]='/'+path.basename(key);
  }
  assert.deepEqual(Object.keys(screens).sort(),['ClinicCard','Contributors','Onboarding','Operators','Overview','PartnerCompanies']);
  const files=new Map(result.outputFiles.map(file=>['/'+path.basename(file.path),{type:file.path.endsWith('.css')?'text/css':'application/javascript',data:file.contents}]));
  files.set('/control.css',{type:'text/css',data:await readFile(path.join(control,'src/styles.css'))});
  const fixture=createControlSubscriptionHttpFixture(),companies=createPartnerCompanyQueue(),controls={requests:[],api:[],held:[],hold:null,fail:null};let origin;
  const server=createServer(async(req,res)=>{
    if(!origin||req.headers.host!==new URL(origin).host){res.writeHead(403).end();return;}const url=new URL(req.url,origin);
    controls.requests.push(url.pathname);
    if(url.pathname.startsWith('/api/')){
      controls.api.push({path:url.pathname,method:req.method});
      if(await companies.handle(req,res,url))return;
      if(url.pathname==='/api/crm/platform-contributors'&&req.method==='GET'){
        const allowed=req.headers.authorization==='Bearer fixture-control-A';res.writeHead(allowed?200:404,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(allowed?{success:true,data:{items:[],hasMore:false}}:{success:false,error:'Не найдено.'}));return;
      }
      if(fixture.handle(req,res))return;res.writeHead(404).end();return;
    }
    if(req.method!=='GET'){res.writeHead(405).end();return;}
    if(url.pathname==='/favicon.ico'){res.writeHead(204).end();return;}
    if(url.pathname==='/'){
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'"})
        .end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Medina Control — тестовый стенд</title><link rel="stylesheet" href="/control.css"><link rel="stylesheet" href="/entry.css"></head><body>'+(url.searchParams.get('demo')==='1'?'<p role="note" style="margin:0;padding:10px 16px">Тестовая панель · вымышленные данные</p>':'')+'<div id="root"></div><script type="module" src="/entry.js"></script></body></html>');return;
    }
    const file=files.get(url.pathname);if(!file){res.writeHead(404).end();return;}
    const send=()=>{if(!res.destroyed)res.writeHead(200,{'Content-Type':file.type,'Cache-Control':'no-store'}).end(file.data);};
    if(controls.fail===url.pathname){controls.fail=null;res.writeHead(503,{'Cache-Control':'no-store'}).end();return;}
    if(controls.hold===url.pathname){controls.hold=null;controls.held.push(send);return;}send();
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});origin='http://127.0.0.1:'+server.address().port;
  return{origin,screens,sourceHashes:hashes,controls,fixture,companies,get listening(){return server.listening;},release(){for(const send of controls.held.splice(0))send();companies.release();},async close(){controls.held=[];companies.close();fixture.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
export const stopControlLazyBuilds=()=>esbuild.stop();

export async function createControlProductionGuest(){
  const hashes=await sourceHashes();
  const settings={NODE_ENV:'production',VITE_MEDINA_CONTROL_MODE:'isolated-preview',
    VITE_MEDINA_API_URL:'https://negis-medcall-mvp-api-server-abc123def-yeldar-s-projects.vercel.app',
    VITE_SUPABASE_URL:'https://ukiobbwsdoblooynzlnx.supabase.co',VITE_SUPABASE_ANON_KEY:'sb_publishable_owned_control_guest_fixture'};
  const previous=Object.fromEntries(Object.keys(settings).map(k=>[k,process.env[k]]));Object.assign(process.env,settings);let result;
  try{const{build}=await import(pathToFileURL(require.resolve('vite')).href);result=await build({configFile:path.join(control,'vite.config.ts'),envDir:false,logLevel:'silent',build:{write:false,emptyOutDir:false}});}
  finally{for(const[key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;}
  assert.ok(!Array.isArray(result));
  const files=new Map(result.output.map(file=>['/'+file.fileName,{type:file.type==='chunk'?'application/javascript':file.fileName.endsWith('.css')?'text/css':'text/html; charset=utf-8',data:file.type==='chunk'?file.code:file.source}]));
  const index=files.get('/index.html');assert.ok(index);files.set('/',{...index,data:String(index.data).replace('<head>','<head><script src="/owned-observer.js"></script>')});
  files.set('/owned-observer.js',{type:'application/javascript',data:`window.__appointmentRecovery={view:{isCurrentMutationScope:()=>true},snapshot:()=>({text:document.body.innerText})};`});
  const screens=result.output.filter(f=>f.type==='chunk'&&f.facadeModuleId?.replaceAll('\\','/').match(/\/screens\/(Overview|ClinicCard|Onboarding|Operators|Contributors|PartnerCompanies)\.tsx$/)).map(f=>'/'+f.fileName);
  assert.equal(screens.length,6);const requests=[],api=[];let origin;
  const server=createServer((req,res)=>{
    if(!origin||req.headers.host!==new URL(origin).host){res.writeHead(403).end();return;}const url=new URL(req.url,origin);requests.push(url.pathname);
    if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/auth/')){api.push(url.pathname);res.writeHead(403).end();return;}
    if(req.method!=='GET'){res.writeHead(405).end();return;}if(url.pathname==='/favicon.ico'){res.writeHead(204).end();return;}
    const file=files.get(url.pathname);if(!file){res.writeHead(404).end();return;}
    res.writeHead(200,{'Content-Type':file.type,'Cache-Control':'no-store',
      'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'"}).end(file.data);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
  return{origin,requests,api,screens,sourceHashes:hashes,async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}

export async function createControlGuestBrowser(){
  // Reuse the owned split bundle; never load Vite config, env files, or a real SDK.
  const server=await createControlLazyBrowser();
  return{origin:server.origin,url:server.origin+'/?guest=1',requests:server.controls.requests,api:server.controls.api,
    screens:Object.values(server.screens),close:()=>server.close()};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  for(const key of Object.keys(process.env))if(!['PATH','Path','SystemRoot','WINDIR','COMSPEC','TEMP','TMP','PATHEXT','APPDATA','LOCALAPPDATA'].includes(key))delete process.env[key];
  const server=await createControlLazyBrowser(Number(process.argv.find(a=>a.startsWith('--port='))?.slice(7)||5272));
  process.stdout.write(server.origin+'/?demo=1\n');
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await server.close();stopControlLazyBuilds();process.exit(0);});
}

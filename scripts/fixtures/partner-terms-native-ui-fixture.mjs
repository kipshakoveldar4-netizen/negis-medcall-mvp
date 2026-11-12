import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { root } from '../src/appointment-recovery-committed-fixture.ts';
const frontend=path.join(root,'artifacts/negis'),control=path.join(root,'artifacts/medina-control');
const require=createRequire(path.join(frontend,'package.json')),esbuild=createRequire(require.resolve('vite/package.json'))('esbuild');
const argumentsByRpc={execute_growth_partner_terms:['p_actor','p_side','p_profile','p_request','p_profile_revision','p_revision','p_action','p_payload'],
  read_growth_partner_terms:['p_actor','p_side','p_profile','p_request','p_close','p_action'],read_growth_partner_ledger:['p_actor'],
  read_growth_creator_jobs:['p_actor','p_workspace','p_staff','p_offset']};
const fields='id,revision,display_name,portfolio_urls,partner_status,creator_status';
export function partnerUiNativeAdapter(fixture){
  const controls={calls:[],reads:[],holdNext:false,held:null};
  const query=async(sql,args)=>{const db=await fixture.connect();try{await db.query('set role service_role');return await db.query(sql,args);}finally{await db.end();}};
  return{controls,release(){controls.held?.();controls.held=null;},adapter:{
    async rpc(name,args){assert.ok(Object.hasOwn(argumentsByRpc,name),'Only partner public entry RPCs');const names=argumentsByRpc[name];
      assert.deepEqual(Object.keys(args).sort(),[...names].sort());controls.calls.push({name,args:structuredClone(args)});
      if(name==='execute_growth_partner_terms'&&controls.holdNext){controls.holdNext=false;await new Promise(resolve=>{controls.held=resolve;});}
      try{return{data:(await query(`select public.${name}(${names.map((_,i)=>'$'+(i+1)).join(',')}) value`,names.map(k=>args[k]))).rows[0].value,error:null};}
      catch(e){return{data:null,error:{code:e.code,message:'PRIVATE_OWNED_PARTNER_SQL'}};}
    },
    from(table){assert.equal(table,'growth_contributor_profiles','No direct terms, commands, partners or other business table');
      let selected=false,actor=null,offset=null,end=null;const order=[];
      const run=async single=>{assert.ok(selected);assert.ok(single?actor!==null&&offset===null:actor===null&&offset!==null&&end===offset+20&&order.join(',')==='created_at:desc,id:asc');
        controls.reads.push({table,actor,offset});
        try{const rows=(await query(`select ${fields} from public.growth_contributor_profiles ${single?'where auth_user_id=$1':'order by created_at desc,id asc limit $1 offset $2'}`,
          single?[actor]:[end-offset+1,offset])).rows;assert.ok(!single||rows.length<=1);return{data:single?rows[0]??null:rows,error:null};}
        catch(e){return{data:null,error:{code:e.code,message:'PRIVATE_OWNED_PARTNER_READ'}};}};
      const q={select(value){assert.equal(value,fields);selected=true;return q;},eq(column,value){assert.equal(column,'auth_user_id');assert.equal(actor,null);actor=value;return q;},
        order(column,options){assert.ok(['created_at','id'].includes(column));order.push(column+':'+(options?.ascending===false?'desc':'asc'));return q;},
        range(start,last){assert.ok(Number.isInteger(start)&&start>=0);offset=start;end=last;return q;},maybeSingle(){return run(true);},then(resolve,reject){return run(false).then(resolve,reject);}};return q;
    },
  }};
}

export async function partnerUiNativeBundle(f){
  const component=p=>JSON.stringify(p.replaceAll('\\','/'));
  const sdk=`export const hasSupabaseFrontendEnv=true,controlConfig={ready:true,apiOrigin:''};
    let actor=new URLSearchParams(location.search).get('actor')||${JSON.stringify(f.owner)};const listeners=new Set(),tokens=${JSON.stringify(f.tokens)};
    const session=()=>actor?{user:{id:actor},access_token:tokens[actor]}:null;
    export function change(next){actor=next;for(const fn of [...listeners])fn('SIGNED_IN',session());}
    export const supabase={auth:{getSession:async()=>({data:{session:session()},error:null}),onAuthStateChange:fn=>{listeners.add(fn);return{data:{subscription:{unsubscribe:()=>listeners.delete(fn)}}};},signOut:async()=>{change(null);return{error:null};}}};
    // Observer-only portal compatibility; this fixture never dispatches auth writes.
    export const sessionAuth={onAuthStateChange:supabase.auth.onAuthStateChange};
    export const useAuth=()=>({signOut:async()=>{await supabase.auth.signOut();}});`;
  const entry=`import React,{StrictMode,useState}from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
    import{Contributors}from ${component(path.join(control,'src/screens/Contributors.tsx'))};
    import ContributorPortal from ${component(path.join(frontend,'src/pages/ContributorPortal.tsx'))};import{change,supabase}from'owned-partner-sdk';
    const owner=${JSON.stringify(f.owner)},initial={actor:new URLSearchParams(location.search).get('actor')||owner,mode:new URLSearchParams(location.search).get('mode')||'platform',epoch:0};
    const f={bootId:crypto.randomUUID(),ids:${JSON.stringify({owner:f.owner,a:f.a,b:f.b,profileA:f.profileA,profileB:f.profileB})},view:{isCurrentMutationScope:()=>true},snapshot(){return{text:document.body.innerText,overflow:document.documentElement.scrollWidth>innerWidth+1};}};window.__appointmentRecovery=f;
    function Host(){const[v,setView]=useState(initial);f.change=(mode,actor=mode==='platform'?owner:f.ids.a)=>{change(actor);history.replaceState(null,'','/?mode='+mode+'&actor='+actor);document.querySelector('#theme').href=mode==='platform'?'/control.css':'/style.css';flushSync(()=>setView(p=>({mode,actor,epoch:p.epoch+1})));};
      return <><p style={{padding:16}}>Тестовый сервер и одноразовая база</p>{v.mode==='platform'?<main className="main" key={v.epoch}><Contributors/></main>:<ContributorPortal key={v.epoch}/>}</>;}
    void supabase.auth.getSession().then(()=>createRoot(document.getElementById('root')).render(<StrictMode><Host/></StrictMode>));`;
  const result=await esbuild.build({stdin:{contents:entry,resolveDir:frontend,loader:'tsx'},bundle:true,write:false,outfile:'bundle.js',format:'iife',platform:'browser',jsx:'automatic',
    define:{'process.env.NODE_ENV':'"production"','import.meta.env.BASE_URL':'"/"','import.meta.env.VITE_API_BASE_URL':'""'},plugins:[{name:'owned-partner-sdk-only',setup(build){
      build.onResolve({filter:/^(owned-partner-sdk|@\/lib\/supabase|@\/contexts\/AuthContext)$/},()=>({path:'sdk',namespace:'owned'}));
      build.onResolve({filter:/^\.\/supabase$/},args=>args.importer===path.join(control,'src/lib/api.ts').replaceAll('\\','/')||path.normalize(args.importer)===path.join(control,'src/lib/api.ts')?{path:'sdk',namespace:'owned'}:undefined);
      build.onLoad({filter:/.*/,namespace:'owned'},()=>({contents:sdk,loader:'ts'}));
      build.onResolve({filter:/^@\//},args=>{const base=path.join(frontend,'src',args.path.slice(2)),p=[base+'.ts',base+'.tsx'].find(existsSync);assert.ok(p,args.path);return{path:p};});
    }}]});
  return{js:result.outputFiles.find(p=>p.path.endsWith('.js')).contents,css:result.outputFiles.find(p=>p.path.endsWith('.css'))?.contents??Buffer.alloc(0)};
}

export async function partnerUiNativeServer(handler,bundle){
  const folder=path.join(frontend,'dist/public/assets'),names=(await readdir(folder)).filter(n=>/^index-[\w-]+\.css$/.test(n));assert.equal(names.length,1,'Build current frontend first');
  const files=new Map([['/bundle.js',{type:'application/javascript',data:bundle.js}],['/components.css',{type:'text/css',data:bundle.css}],
    ['/style.css',{type:'text/css',data:await readFile(path.join(folder,names[0]))}],['/control.css',{type:'text/css',data:await readFile(path.join(control,'src/styles.css'))}]]);
  for(const name of ['inter-latin.woff2','inter-cyrillic.woff2','inter-cyrillic-ext.woff2'])files.set('/fonts/inter/'+name,{type:'font/woff2',data:await readFile(path.join(frontend,'public/fonts/inter',name))});
  const controls={mode:'',held:[],active:new Set(),requests:[],errors:[]};let origin;
  const routes=new Set(['partner-terms','platform-partner-terms','contributor-account','platform-contributors','partner-ledger','creator-jobs']);
  const server=createServer(async(req,out)=>{
    if(!origin||req.headers.host!==new URL(origin).host){out.writeHead(403).end();return;}
    const url=new URL(req.url,origin);if(req.method==='GET'&&files.has(url.pathname)){const file=files.get(url.pathname);out.writeHead(200,{'Content-Type':file.type,'Cache-Control':'no-store'}).end(file.data);return;}
    if(req.method==='GET'&&url.pathname==='/'){out.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
      'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'"})
      .end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><link id="theme" rel="stylesheet" href="'+(url.searchParams.get('mode')==='partner'?'/style.css':'/control.css')+'"><link rel="stylesheet" href="/components.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');return;}
    const route=url.pathname.slice('/api/crm/'.length);if(!url.pathname.startsWith('/api/crm/')||!routes.has(route)){out.writeHead(404).end();return;}
    const query={path:[route]};for(const[k,v]of url.searchParams)query[k]=query[k]===undefined?v:Array.isArray(query[k])?[...query[k],v]:[query[k],v];req.query=query;
    const business=req.method==='POST'&&['partner-terms','platform-partner-terms'].includes(route);const mode=business?controls.mode:'';if(business)controls.mode='';
    const run=async()=>{let status=200,payload;const headers={};const res={setHeader(k,v){headers[k]=v;return res;},status(v){status=v;return res;},end(v){payload=v;return res;},json(v){payload=v;return res;}};
      await handler(req,res);const raw=JSON.stringify(payload);controls.requests.push({route,method:req.method,status,body:req.body,cache:headers['Cache-Control']});
      const send=()=>{if(!out.destroyed)out.writeHead(status,{...headers,'Content-Type':'application/json'}).end(raw);};
      if(business&&status===200&&mode==='after'){controls.held.push({send});return;}
      if(business&&status===200&&mode==='drop'){if(!out.destroyed){out.writeHead(status,{...headers,'Content-Type':'application/json','Content-Length':Buffer.byteLength(raw)+1});out.flushHeaders();out.write('{"success":');setTimeout(()=>out.destroy(),15).unref();}return;}send();
    };
    const execute=()=>{const task=run().catch(e=>{controls.errors.push(e.message);if(!out.destroyed)out.writeHead(500).end();});controls.active.add(task);void task.finally(()=>controls.active.delete(task));return task;};
    await execute();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
  return{origin,controls,async release(){for(const item of controls.held.splice(0))if(item.run)await item.run();else item.send();},
    async close(){controls.held=[];for(const task of [...controls.active])await task;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
export const stopPartnerUiBuilds=()=>esbuild.stop();

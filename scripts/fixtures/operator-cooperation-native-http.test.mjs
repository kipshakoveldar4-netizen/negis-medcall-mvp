import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp,readFile,readdir,writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Script } from 'node:vm';
import test from 'node:test';
import { startNativePostgres } from './native-postgres.mjs';
import { readReviewedChain } from './migration-chain-review.mjs';
import { seedOperatorCommandFixture,cleanupOperatorCommandFixture } from './operator-command-recovery-fixture.mjs';
import { ownedRecoveryBrowser,root } from '../src/appointment-recovery-committed-fixture.ts';

const frontend=path.join(root,'artifacts/negis'),require=createRequire(path.join(frontend,'package.json'));
const ts=createRequire(path.join(root,'package.json'))('typescript'),esbuild=createRequire(require.resolve('vite/package.json'))('esbuild');
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const row=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const rpcArguments={
  execute_clinic_operator_command_v2:['p_command_id','p_workspace_id','p_staff_user_id','p_auth_user_id','p_action','p_request_id','p_operator_id','p_clinic_brief','p_price_minor','p_lead_scope'],
  execute_growth_operator_command_v2:['p_command_id','p_request_id','p_operator_user_id','p_action'],
  read_operator_request_command_v2:['p_command_id','p_actor_user_id','p_origin','p_workspace_id','p_staff_user_id'],
  close_operator_request_command_v2:['p_command_id','p_actor_user_id','p_origin','p_workspace_id','p_staff_user_id','p_action','p_target_id'],
};
function adapter(fixture){
  async function query(sql,args=[]){const db=await fixture.connect();try{await db.query('set role service_role');return await db.query(sql,args);}finally{await db.end();}}
  return{
    async rpc(name,args){
      assert.ok(Object.hasOwn(rpcArguments,name),'No legacy writer or unrelated RPC');assert.deepEqual(Object.keys(args).sort(),[...rpcArguments[name]].sort());
      try{return{data:(await query(`select public.${name}(${rpcArguments[name].map((_,i)=>'$'+(i+1)).join(',')}) value`,rpcArguments[name].map(key=>args[key]))).rows[0].value,error:null};}
      catch(error){return{data:null,error:{code:error.code,message:error.message}};}
    },
    from(table){
      assert.ok(['growth_operator_profiles','growth_operator_requests'].includes(table));
      const alias=table==='growth_operator_profiles'?'p':'q',filters=[],values=[],order=[];let selection,joins='';
      const columns=new Set(['id','auth_user_id','workspace_id','operator_id','status','accepting_requests','created_at','display_name']);
      const q={
        select(fields){
          if(table==='growth_operator_profiles'){
            assert.ok(['id','id,display_name,status,accepting_requests'].includes(fields));selection=fields.split(',').map(x=>'p.'+x).join(',');
          }else if(fields==='id')selection='q.id';
          else{
            const base='id,clinic_brief,status,price_per_arrival_minor,currency,lead_scope';
            assert.ok([base+',workspaces(name)',base+',growth_operator_profiles(display_name)'].includes(fields));
            selection=base.split(',').map(x=>'q.'+x).join(',');
            if(fields.endsWith('workspaces(name)')){joins=' join public.workspaces w on w.id=q.workspace_id';selection+=",jsonb_build_object('name',w.name) workspaces";}
            else{joins=' join public.growth_operator_profiles p on p.id=q.operator_id';selection+=",jsonb_build_object('display_name',p.display_name) growth_operator_profiles";}
          }return q;
        },
        eq(column,value){assert.ok(columns.has(column));values.push(value);filters.push(`${alias}.${column}=$${values.length}`);return q;},
        order(column,options){assert.ok(columns.has(column));order.push(`${alias}.${column}${options?.ascending===false?' desc':''}`);return q;},
        async run(start=0,count=2){assert.ok(selection&&Number.isInteger(start)&&start>=0&&Number.isInteger(count)&&count>0&&count<=26);
          try{return{data:(await query(`select ${selection} from public.${table} ${alias}${joins}${filters.length?' where '+filters.join(' and '):''}${order.length?' order by '+order.join(','):''} offset ${start} limit ${count}`,values)).rows,error:null};}
          catch(error){return{data:null,error:{code:error.code,message:error.message}};}
        },
        range(start,end){return q.run(start,end-start+1);},
        async maybeSingle(){const r=await q.run();assert.ok(r.error||r.data.length<=1);return{...r,data:r.data?.[0]??null};},
      };return q;
    },
  };
}
async function handlers(dbAdapter,identities){
  function evaluate(source,imports={}){const exports={};new Script(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)
    .runInNewContext({exports,Error,require(name){assert.ok(Object.hasOwn(imports,name),name);return imports[name];}});return exports;}
  const contracts=evaluate(await readFile(path.join(root,'lib/crm/operator-contracts.ts'),'utf8'));
  return evaluate(await readFile(path.join(root,'lib/crm/operators.ts'),'utf8'),{
    '../auth/server':{isUuidValue:uuid,requireAuthenticatedUser:async req=>{const id=/^Bearer owned:([0-9a-f-]{36})$/i.exec(req.headers.authorization??'')?.[1];assert.ok(identities.has(id));return{id};}},
    '../auth/platform':{readPlatformOwner:()=>null},'../supabase/server':{getSupabaseServerClient:()=>dbAdapter},
    './operator-contracts':contracts,'./server':{readWorkspaceContext:req=>req.ownedContext??null},
  });
}
async function bundle(f,origin,action){
  const clinic=origin==='clinic',actor=clinic?f.auth:f.operatorAuth;
  const component=JSON.stringify(path.join(frontend,'src/components',action==='propose'?'admin/ClinicOperators.tsx':'operators/OperatorRequests.tsx').replaceAll('\\','/'));
  const mocks=`export const hasSupabaseFrontendEnv=true,isSignOutPending=()=>false,getSignOutRevision=()=>0;
    export const supabase={auth:{getSession:async()=>({data:{session:{user:{id:f.actor},access_token:'owned:'+f.actor}},error:null})}};`;
  const entry=`import React from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
    import{${action==='propose'?'ClinicOperators':'OperatorRequests'} as Component}from ${component};
    const f={actor:'${actor}',view:{isCurrentMutationScope:()=>true},snapshot(){return{actor:this.actor,text:document.body.innerText,
      commands:Object.keys(sessionStorage).filter(k=>k.startsWith('medina_operator_command_v1')).map(k=>[k,sessionStorage.getItem(k)]),
      overflow:document.documentElement.scrollWidth>innerWidth+1,alerts:[...document.querySelectorAll('[role=alert]')].map(n=>n.textContent)};}};
    window.__appointmentRecovery=f;window.confirm=()=>true;
    function Host(){const[revision,setRevision]=React.useState(0),live=React.useRef({active:true});const scope=live.current;
      f.switchActor=id=>{scope.active=false;live.current={active:true};f.actor=id;flushSync(()=>setRevision(x=>x+1));};
      return <main className="mx-auto min-w-0 w-full max-w-4xl p-4"><h1 className="mb-4 text-lg font-semibold">Операторы</h1>
        <Component key={revision} actorId={f.actor} ${clinic?`workspaceId='${f.w}'`:''} isSessionCurrent={()=>scope.active}/></main>;}
    createRoot(document.getElementById('root')).render(<Host/>);`;
  // f is the explicitly owned browser state, not a real SDK session.
  return(await esbuild.build({stdin:{contents:entry,resolveDir:frontend,loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',
    define:{'process.env.NODE_ENV':'"production"','import.meta.env.BASE_URL':'"/"','import.meta.env.VITE_API_BASE_URL':'""'},
    plugins:[{name:'owned-cooperation-native',setup(build){
      build.onResolve({filter:/^@\/lib\/(supabase|authSignOut)$/},()=>({path:'sdk',namespace:'owned'}));
      build.onLoad({filter:/.*/,namespace:'owned'},()=>({contents:mocks.replaceAll('f.actor','window.__appointmentRecovery.actor'),loader:'ts'}));
      build.onResolve({filter:/^@\//},args=>{const base=path.join(frontend,'src',args.path.slice(2)),file=[base+'.ts',base+'.tsx'].find(existsSync);assert.ok(file,args.path);return{path:file};});
    }}]})).outputFiles[0].text;
}
async function assets(){
  const directory=path.join(frontend,'dist/public/assets'),names=(await readdir(directory)).filter(name=>/^index-[\w-]+\.css$/.test(name));
  assert.equal(names.length,1,'Build the current application before styled native acceptance');
  const result=new Map([['/style.css',{type:'text/css',data:await readFile(path.join(directory,names[0]))}]]);
  for(const name of ['inter-latin.woff2','inter-cyrillic.woff2','inter-cyrillic-ext.woff2'])result.set('/fonts/inter/'+name,{type:'font/woff2',data:await readFile(path.join(frontend,'public/fonts/inter',name))});
  return result;
}
async function serverFor(fixture,api,identities,code,files){
  const controls={mode:'',held:[],business:[],results:[],errors:[],active:new Set()};let origin;
  const server=createServer(async(req,res)=>{
    if(!origin||req.headers.host!==new URL(origin).host){res.writeHead(403).end();return;}
    const url=new URL(req.url,origin);res.setHeader('Cache-Control','no-store');
    if(files.has(url.pathname)){const file=files.get(url.pathname);res.setHeader('Content-Type',file.type);res.end(file.data);return;}
    if(url.pathname==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(code);return;}
    if(url.pathname==='/'){
      res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'");
      res.end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');return;
    }
    if(!['/api/crm/operator-inbox','/api/crm/clinic-operator-requests','/api/crm/operator-directory'].includes(url.pathname)){res.writeHead(404).end();return;}
    const actor=/^Bearer owned:([0-9a-f-]{36})$/i.exec(req.headers.authorization??'')?.[1];
    if(!identities.has(actor)){res.writeHead(401,{'Content-Type':'application/json'}).end('{"success":false}');return;}
    try{
      const parts=[];let length=0;for await(const part of req){length+=part.length;assert.ok(length<=8192);parts.push(part);}
      const body=length?JSON.parse(Buffer.concat(parts).toString('utf8')):undefined;
      const business=req.method!=='GET'&&body?.action!=='abandon';
      if(business)controls.business.push({key:body.commandId,actor,path:url.pathname,method:req.method});
      const execute=async()=>{
        let status=200,payload;
        const request={method:req.method,headers:req.headers,body,query:Object.fromEntries(url.searchParams)};
        if(url.pathname!=='/api/crm/operator-inbox'&&uuid(request.query.workspaceId)){
          const db=await fixture.connect();try{const member=await row(db,"select id,workspace_id,role from public.staff_users where workspace_id=$1 and auth_user_id=$2 and status='active'",[request.query.workspaceId,actor]);
            if(member)request.ownedContext={userId:actor,staffUserId:member.id,workspaceId:member.workspace_id,role:member.role};}finally{await db.end();}
        }
        const response={setHeader:(key,value)=>res.setHeader(key,value),status(value){status=value;return response;},json(value){payload=JSON.parse(JSON.stringify(value));return response;}};
        if(url.pathname==='/api/crm/operator-inbox')await api.handleOperatorInbox(request,response);
        else await api.handleClinicOperators(request,response,url.pathname==='/api/crm/operator-directory');
        controls.results.push({status,state:payload?.data?.state,key:payload?.data?.commandId});
        const send=()=>{if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(payload));}};
        if(business&&status<300){
          const mode=controls.mode;controls.mode='';
          if(mode==='after'){controls.held.push({send});return;}
          if(mode==='partial'){payload={success:true,data:{commandId:body.commandId}};send();return;}
          if(mode==='drop'){
            res.writeHead(status,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(JSON.stringify(payload))+1});res.flushHeaders();res.write('{"success":');setTimeout(()=>res.destroy(),20).unref();return;
          }
        }send();
      };
      const run=()=>{const task=execute().catch(error=>{controls.errors.push(error.message);if(!res.destroyed)res.writeHead(500).end();});controls.active.add(task);void task.finally(()=>controls.active.delete(task));return task;};
      if(business&&controls.mode==='before'){controls.mode='';controls.held.push({run});return;}
      await run();
    }catch(error){controls.errors.push(error.message);if(!res.destroyed)res.writeHead(500).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  return{origin,controls,async release(){for(const held of controls.held.splice(0))if(held.run)await held.run();else held.send();},
    async close(){controls.held=[];for(const task of [...controls.active])await task;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
async function until(action){for(let n=0;n<200;n++){if(await action())return;await delay(20);}assert.fail('Owned cooperation HTTP condition did not settle');}

test('keyed cooperation through real forms, owned HTTP and native SQL',{timeout:360000},async t=>{
  assert.equal(process.env.MEDINA_TEST_POSTGRES_NATIVE,'1','Explicit owned native opt-in; no DSN/download/container fallback');
  const chain=await readReviewedChain(path.join(root,'migrations')),fixture=await startNativePostgres();t.after(()=>fixture.close());t.after(()=>esbuild.stop());
  const db=await fixture.connect();await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;grant usage on schema public to anon,authenticated,service_role;
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);alter table storage.objects enable row level security;`);
  for(const entry of chain)await db.query(entry.source);
  const identities=new Set(),api=await handlers(adapter(fixture),identities),files=await assets();
  const output=await mkdtemp(path.join(root,'node_modules/.cache/operator-cooperation-http-'));
  const cases=[];
  for(const width of [375,1440])for(const [origin,action]of[['clinic','propose'],['clinic','withdraw'],['clinic','end'],['operator','accept'],['operator','decline'],['operator','end']])cases.push({width,origin,action,scenario:'drop'});
  for(const scenario of ['before','after','partial','account'])cases.push({width:375,origin:'clinic',action:'propose',scenario});
  for(const scenario of ['before','after'])cases.push({width:1440,origin:'operator',action:'accept',scenario});
  for(const c of cases)await t.test(`${c.width} ${c.origin} ${c.action}: ${c.scenario}`,async()=>{
    const f=await seedOperatorCommandFixture(db);f.otherActor=randomUUID();for(const id of[f.auth,f.operatorAuth,f.otherActor])identities.add(id);
    if(c.action!=='propose'){
      const proposed=await row(db,"select public.execute_clinic_operator_command_v2($1,$2,$3,$4,'propose',null,$5,'Owned technical terms, no payment',0,'assigned') value",[randomUUID(),f.w,f.staff,f.auth,f.operator]);
      f.request=proposed.value.requestId;
      if(c.action==='end')await db.query("select public.execute_growth_operator_command_v2($1,$2,$3,'accept')",[randomUUID(),f.request,f.operatorAuth]);
    }
    const count=async()=>row(db,`select (select count(*)::int from public.growth_operator_requests where workspace_id=$1) requests,
      (select count(*)::int from public.growth_operator_request_commands where workspace_id=$1) commands,
      (select count(*)::int from public.growth_operator_command_fences where actor_auth_user_id=any($2::uuid[])) fences`,[f.w,[f.auth,f.operatorAuth]]);
    const baseline=await count(),server=await serverFor(fixture,api,identities,await bundle(f,c.origin,c.action),files);let browser,failure;
    try{
      browser=await ownedRecoveryBrowser(server.origin);await browser.viewport(c.width,900);const run=browser.evaluate,wait=browser.waitFor,snapshot=()=>run('return f.snapshot();');
      await run('await document.fonts.ready;');
      if(c.action==='propose'){
        await wait("[...document.querySelectorAll('button')].some(n=>n.textContent.trim()==='Предложить сотрудничество')");
        await run("[...document.querySelectorAll('button')].find(n=>n.textContent.trim()==='Предложить сотрудничество').click();");
        await wait("!!document.querySelector('form textarea')");
        await run("const a=document.querySelector('textarea'),p=document.querySelector('input[inputmode=decimal]');for(const [el,value]of[[a,'Owned technical terms, no payment'],[p,'0']]){Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}");
      }else await wait('!!document.querySelector(\'article\')');
      server.controls.mode=c.scenario==='account'?'after':c.scenario;
      if(c.action==='propose')await run("document.querySelector('form').requestSubmit();");
      else{const label={withdraw:'Отозвать',end:'Завершить сотрудничество',accept:'Принять условия',decline:'Отклонить'}[c.action];await run(`[...document.querySelectorAll('article button')].find(n=>n.textContent.trim()===${JSON.stringify(label)}).click();`);}
      await until(()=>server.controls.business.length===1);await wait('f.snapshot().commands.length===1');
      const saved=await snapshot(),command=JSON.parse(saved.commands[0][1]);assert.equal(command.commandId,server.controls.business[0].key);
      assert.doesNotMatch(saved.commands[0][1],/Owned|brief|price|phone|token|payload/);assert.equal(saved.overflow,false);
      const fits=await run("return [...document.querySelectorAll('button')].filter(n=>n.offsetWidth).every(n=>n.scrollWidth<=n.clientWidth+1&&n.getBoundingClientRect().right<=innerWidth+1);");assert.equal(fits,true,'Visible controls fit their mobile/desktop containers');
      if(c.scenario==='drop'&&['propose','accept'].includes(c.action)){const image=await browser.screenshot();assert.ok(image.length>4096);await writeFile(path.join(output,`${c.width}-${c.origin}-${c.action}.png`),image);}
      if(['drop','partial'].includes(c.scenario)){
        await until(()=>server.controls.results.some(r=>r.key===command.commandId));await browser.load();await wait('f.snapshot().commands.length===1');
      }
      if(c.scenario==='account'){
        await until(()=>server.controls.held.length===1);
        await run(`f.switchActor('${f.otherActor}');`);await wait("f.snapshot().alerts.length>0");assert.equal((await snapshot()).commands.length,1,'Opaque other-actor storage remains private, not deleted');
        assert.equal(await run("return !!document.querySelector('[aria-label=\"Неподтверждённая отправка\"]');"),false);
        await run(`f.switchActor('${f.auth}');`);await wait("!!document.querySelector('[aria-label=\"Неподтверждённая отправка\"]') && !document.body.innerText.includes('Загружаем') && document.querySelectorAll('article').length===1");
        await until(()=>server.controls.active.size===0);const before=await snapshot();await server.release();await delay(80);assert.deepEqual(await snapshot(),before,'The old actor reply cannot acknowledge returned A');
      }
      const close=['before','after'].includes(c.scenario);
      if(close){
        await until(()=>server.controls.held.length===1);
        const held=await count();
        assert.equal(held.commands,baseline.commands+(c.scenario==='after'?1:0),'The fixture must establish the intended commit/fence winner before recovery');
      }
      await run(`[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(close?'Закрыть отправку':'Проверить результат')}).click();`);
      await wait('f.snapshot().commands.length===0');await until(()=>server.controls.active.size===0);
      if(close){const before=await snapshot();await server.release();await delay(80);assert.deepEqual(await snapshot(),before,'A retired original response cannot overwrite the confirmed result');}
      const final=await count(),added=c.action==='propose'?1:0;
      assert.deepEqual(final,c.scenario==='before'?{...baseline,fences:baseline.fences+1}:{...baseline,requests:baseline.requests+added,commands:baseline.commands+1});
      assert.equal(server.controls.business.length,1,'No automatic repeat of the business POST/PATCH');
      assert.deepEqual(server.controls.errors,[]);assert.deepEqual(browser.exceptions,[]);assert.equal((await snapshot()).overflow,false);
      assert.ok(browser.requests.every(url=>new URL(url).origin===server.origin),'Only the owned HTTP origin, including fonts');
    }catch(error){failure=error;}
    const cleanup=[];
    try{if(browser)await browser.close();}catch(error){cleanup.push(error);}
    try{await server.close();}catch(error){cleanup.push(error);}
    try{await db.query('delete from public.growth_operator_command_fences where actor_auth_user_id=any($1::uuid[])',[[f.auth,f.operatorAuth]]);await cleanupOperatorCommandFixture(db,f);}catch(error){cleanup.push(error);}
    if(failure||cleanup.length)throw new AggregateError([failure,...cleanup].filter(Boolean),'Owned cooperation HTTP case failed');
  });
  for(const table of['growth_operator_command_fences','growth_operator_request_commands','growth_operator_requests','growth_operator_profiles','staff_users','workspaces'])assert.equal((await row(db,`select count(*)::int n from public.${table}`)).n,0,table+' cleanup');
  t.diagnostic(`Actual forms/HTTP/handler/service SQL; exact ${chain[0].file} through ${chain.at(-1).file}, ${chain.length} raw files. Synthetic Auth/SDK and Node adapter only. Styled proof: ${output}`);
});

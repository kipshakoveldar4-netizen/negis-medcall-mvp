import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {seedDeletionOperation} from './site-deletion-operations-cases.mjs';

// Actual handler/model/SQL composition, synthetic request/response transport.
// This does not claim a remote HTTP/Auth/PostgREST or browser acceptance.
const require=createRequire(import.meta.url);
const {createSiteDeletionOperationsHandler,createSiteInquiryDeletionHandler}=require('../../lib/crm/site-inquiry-deletion.ts');
const {attachWorkspaceContext}=require('../../lib/crm/server.ts');
const {setSupabaseServerClientFactoryForTests}=require('../../lib/supabase/server.ts');
const {createSiteInquiryDeletion}=await import('../../artifacts/negis/src/lib/siteInquiryDeletion.ts');
const {parseSiteDeletionOperations,siteDeletionIntentBody}=await import('../../artifacts/negis/src/lib/siteDeletionOperations.ts');
const directory=new URL('../../migrations/',import.meta.url);
const parameters={prepare_site_deletion_operation:['p_workspace','p_site_key','p_staff','p_actor','p_request'],
  execute_site_deletion_operation:['p_workspace','p_site_key','p_staff','p_actor','p_request'],
  read_site_deletion_operations:['p_workspace','p_site_key','p_staff','p_actor','p_request_key'],
  close_site_deletion_operation:['p_workspace','p_site_key','p_staff','p_actor','p_request_key','p_action']};

test('101 actual handler/model/SQL recovery without browser persistence or automatic retry',{timeout:180000},async t=>{
  const pg=new PGlite();t.after(()=>pg.close());
  const db={query:async(sql,args=[])=>args.length?pg.query(sql,args):(await pg.exec(sql)).at(-1)};
  await db.query('create role anon;create role authenticated;create role service_role bypassrls;grant usage on schema public to anon,authenticated,service_role');
  const selected=new Set([9,10,11,13,14,19,58,62,93,101]);
  for(const file of (await readdir(directory)).sort()) if(selected.has(Number(file.slice(0,3))))
    await db.query((await readFile(new URL(file,directory),'utf8')).replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/i,''));
  t.mock.method(globalThis,'fetch',async()=>{throw Error('External fetch forbidden');});
  t.after(()=>setSupabaseServerClientFactoryForTests(null));
  async function scenario(name,action) {let passed=false;await t.test(name,async()=>{
    await db.query('begin');try {
      const f=await seedDeletionOperation(db),rpcCalls=[],httpCalls=[];let override,drop='';
      setSupabaseServerClientFactoryForTests(()=>({async rpc(name,args){
        assert.ok(parameters[name],'Only reviewed operation RPCs are permitted');rpcCalls.push({name,args});
        if(override)return override(name,args);
        await db.query('savepoint synthetic_rpc');
        try {
          await db.query('set role service_role');
          const values=parameters[name].map(key=>key==='p_request'?JSON.stringify(args[key]):args[key]??null);
          const result=await db.query(`select public.${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) as result`,values);
          await db.query('reset role;release savepoint synthetic_rpc');return{data:result.rows[0].result,error:null};
        }catch(error){await db.query('rollback to savepoint synthetic_rpc;release savepoint synthetic_rpc');return{data:null,error:{message:error.message}};}
      }}));
      const env=()=>({MEDINA_PUBLIC_SITE_WORKSPACE_ID:f.workspace,MEDINA_SITE_INTAKE_KEY:f.siteKey});
      const operations=createSiteDeletionOperationsHandler(env),execute=createSiteInquiryDeletionHandler(env);
      async function http(path,init={},actor={userId:f.actor,staffUserId:f.staff,role:'owner',workspaceId:f.workspace}) {
        if(init.dispatchGuard&&!init.dispatchGuard())throw new DOMException('Retired','AbortError');
        const url=new URL(path,'http://fixture.invalid');assert.equal(url.origin,'http://fixture.invalid');
        const method=init.method??'GET';httpCalls.push({path,method,body:init.body});
        if(url.pathname.endsWith('site-inquiry-deletion-preview')) return Response.json({success:true,data:{
          leadId:f.request.leadId,leadUpdatedAt:f.request.leadUpdatedAt,receiptIds:f.request.receiptIds,receiptCount:2,
          reviewReasons:[],reviewRequired:false,confirmationRequired:true,deletionEnabled:true,deletionAvailability:'confirmation_required'}});
        const req={method,query:Object.fromEntries(url.searchParams),headers:{'content-type':'application/json'},body:init.body?JSON.parse(init.body):undefined};
        if(actor)attachWorkspaceContext(req,{...actor,permissions:[]});
        let status=0,body;const res={setHeader(name,value){assert.equal(name,'Cache-Control');assert.equal(value,'no-store');},status(value){status=value;return res;},json(value){body=value;}};
        await(url.pathname.endsWith('site-inquiry-deletion-operations')?operations:execute)(req,res);
        if(status===200&&((drop==='prepare'&&req.body?.action==='prepare')||(drop==='execute'&&url.pathname.endsWith('site-inquiry-deletion'))))throw Error('SYNTHETIC lost ACK');
        assert.ok(status>=200&&status<600);return Response.json(body,{status});
      }
      const base=`/api/crm/site-inquiry-deletion?workspaceId=${f.workspace}`,recovery=`/api/crm/site-inquiry-deletion-operations?workspaceId=${f.workspace}`;
      const lifetime={actorId:f.actor,active:true,isCurrent(){return this.active;}};
      const flow=()=>createSiteInquiryDeletion(f.workspace,f.request.leadId,http,()=>f.request.requestKey,lifetime);
      await action({f,db,http,base,recovery,rpcCalls,httpCalls,lifetime,flow,setDrop:value=>{drop=value;},setOverride:value=>{override=value;}});passed=true;
    }finally{setSupabaseServerClientFactoryForTests(null);await db.query('rollback');}
  });assert.ok(passed,'Stop after failed actual handler/model scenario: '+name);}

  await scenario('current confirmation prepares before executing and returns only the verified erasure result',async c=>{
    const flow=c.flow();await flow.inspect();flow.confirm(true);await flow.submit();assert.equal(flow.getSnapshot().phase,'done');
    assert.deepEqual(c.rpcCalls.map(x=>x.name),['prepare_site_deletion_operation','execute_site_deletion_operation']);
    assert.equal((await c.db.query('select count(*)::int as n from public.crm_site_consent_receipts')).rows[0].n,0);
    assert.equal((await c.db.query('select count(*)::int as n from public.crm_site_inquiry_deletions')).rows[0].n,1);
  });
  await scenario('lost committed ACK survives flow disposal; a fresh read recovers completion without another POST',async c=>{
    c.setDrop('execute');const flow=c.flow();await flow.inspect();flow.confirm(true);await flow.submit();
    assert.equal(flow.getSnapshot().phase,'uncertain');assert.equal(JSON.parse(flow.dispose().body).requestKey,c.f.request.requestKey);
    c.setDrop('');const posts=c.httpCalls.filter(x=>x.method==='POST').length;
    const read=parseSiteDeletionOperations(await(await c.http(c.recovery)).json(),c.f.workspace,c.f.actor);
    assert.equal(read.operations[0].state,'committed');assert.equal(c.httpCalls.filter(x=>x.method==='POST').length,posts);
    assert.equal(read.operations[0].request.requestKey,c.f.request.requestKey);
    const response=await c.http(c.base,{method:'POST',body:siteDeletionIntentBody(read.operations[0].request)});
    assert.deepEqual(await response.json(),{success:true,data:{deleted:true,receiptsDeleted:2,replayed:true}});
    assert.equal((await c.db.query('select count(*)::int as n from public.crm_site_inquiry_deletions')).rows[0].n,1);
  });
  await scenario('lost preparation ACK cannot trigger execution; new reader returns the exact still-pending intent',async c=>{
    c.setDrop('prepare');const flow=c.flow();await flow.inspect();flow.confirm(true);await flow.submit();flow.dispose();
    assert.deepEqual(c.rpcCalls.map(x=>x.name),['prepare_site_deletion_operation']);c.setDrop('');
    const read=parseSiteDeletionOperations(await(await c.http(c.recovery)).json(),c.f.workspace,c.f.actor);
    assert.equal(read.operations[0].state,'prepared');assert.deepEqual(read.operations[0].request,c.f.request);
    assert.equal((await c.db.query('select count(*)::int as n from public.leads')).rows[0].n,1);
  });
  await scenario('an original prepared operation is invisible to another active administrator and foreign workspace',async c=>{
    const flow=c.flow();c.setDrop('prepare');await flow.inspect();flow.confirm(true);await flow.submit();c.setDrop('');
    const other={userId:c.f.otherActor,staffUserId:c.f.otherStaff,role:'admin',workspaceId:c.f.workspace};
    assert.deepEqual((await(await c.http(c.recovery,{},other)).json()).data.operations,[]);
    const reply=await c.http(c.base,{method:'POST',body:JSON.stringify(c.f.request)},other);assert.equal(reply.status,409);assert.equal((await reply.json()).code,'deletion_request_conflict');
    assert.equal((await c.http(c.recovery,{},null)).status,401);
    assert.equal((await c.http(c.recovery,{}, {...other,role:'lead_manager'})).status,403);
  });
  await scenario('scope loss immediately after preparation suppresses execution and leaves recoverable original intent',async c=>{
    c.setDrop('prepare');const flow=c.flow();await flow.inspect();flow.confirm(true);await flow.submit();
    c.lifetime.active=false;flow.dispose();c.setDrop('');await flow.submit();
    assert.deepEqual(c.rpcCalls.map(x=>x.name),['prepare_site_deletion_operation']);
    assert.equal((await(await c.http(c.recovery)).json()).data.operations[0].state,'prepared');
  });
  await scenario('explicit abandon fences execution; a later acknowledgement hides only the terminal row',async c=>{
    await c.http(c.recovery,{method:'POST',body:JSON.stringify({action:'prepare',request:c.f.request})});
    const abandoned=await c.http(c.recovery,{method:'POST',body:JSON.stringify({action:'abandon',requestKey:c.f.request.requestKey})});
    assert.equal((await abandoned.json()).data.operation.state,'abandoned');
    assert.equal((await c.http(c.base,{method:'POST',body:JSON.stringify(c.f.request)})).status,409);
    await c.http(c.recovery,{method:'POST',body:JSON.stringify({action:'acknowledge',requestKey:c.f.request.requestKey})});
    assert.deepEqual((await(await c.http(c.recovery)).json()).data.operations,[]);
    assert.equal((await c.db.query('select count(*)::int as n from public.leads')).rows[0].n,1);
  });
  await scenario('extra identities and actions are refused before any RPC or receipt creation',async c=>{
    for(const body of [{action:'execute',requestKey:c.f.request.requestKey},{action:'prepare',request:{...c.f.request,actorId:c.f.otherActor}},
      {action:'abandon',requestKey:c.f.request.requestKey,workspaceId:c.f.workspace},{action:'acknowledge',requestKey:[]},null]) {
      assert.equal((await c.http(c.recovery,{method:'POST',body:JSON.stringify(body)})).status,400);
    }
    assert.deepEqual(c.rpcCalls,[]);
  });
  await scenario('malformed or wrong-actor RPC receipts fail closed and never echo private diagnostics',async c=>{
    const flow=c.flow();c.setDrop('prepare');await flow.inspect();flow.confirm(true);await flow.submit();c.setDrop('');
    const real=(await(await c.http(c.recovery)).json()).data;
    for(const value of [{...real,complete:false},{...real,operations:[{...real.operations[0],actorId:c.f.otherActor}]},
      {...real,operations:[real.operations[0],real.operations[0]]},{...real,operations:[{...real.operations[0],request:{...c.f.request,phone:'PRIVATE'}}]}]) {
      c.setOverride(()=>({data:value,error:null}));const reply=await c.http(c.recovery);assert.equal(reply.status,503);
      assert.deepEqual(await reply.json(),{success:false,code:'site_deletion_unavailable'});
    }
  });
});

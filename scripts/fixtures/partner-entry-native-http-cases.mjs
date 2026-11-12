import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { seedPartnerLedger } from './partner-ledger-cases.mjs';
import { partnerEntryHttpFixture, stopPartnerEntryBuilds, ENTRY_ORIGIN, ENTRY_ACTOR, ENTRY_OTHER } from './partner-entry-http-fixture.mjs';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
async function until(check){for(let n=0;n<200;n++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Owned entry condition did not settle');}

export async function startOwnedPartnerHttp(handler,paths=['/api/crm/partner-entry']){
  const state={dropCapture:false,dropNextPost:false,requests:[],errors:[]};let origin;
  const server=createServer(async(req,out)=>{
    if(!origin||req.headers.host!==new URL(origin).host){out.writeHead(403).end();return;}
    const url=new URL(req.url,origin);if(!paths.includes(url.pathname)){out.writeHead(404).end();return;}
    const query={path:[url.pathname.slice('/api/crm/'.length)]};for(const[k,v]of url.searchParams)query[k]=query[k]===undefined?v:Array.isArray(query[k])?[...query[k],v]:[query[k],v];req.query=query;
    const res={setHeader(k,v){out.setHeader(k,v);return res;},status(v){out.statusCode=v;return res;},end(v){out.end(v);return res;},json(v){
      state.requests.push({op:query.op,status:out.statusCode});const raw=JSON.stringify(v);out.setHeader('Content-Type','application/json; charset=utf-8');
      if(((state.dropCapture&&query.op==='capture')||(state.dropNextPost&&req.method==='POST'))&&out.statusCode===200){state.dropCapture=false;state.dropNextPost=false;out.setHeader('Content-Length',Buffer.byteLength(raw)+1);out.flushHeaders();out.write('{"success":');setTimeout(()=>out.destroy(),10).unref();}
      else out.end(raw);return res;
    }};
    try{await handler(req,res);}catch(error){state.errors.push(error.message);if(!out.destroyed)out.writeHead(500).end('{"success":false}');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
  return{origin,state,async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
async function setup(db,fixture){
  const partner=await seedPartnerLedger(db),calls=[],ids=new Set(),controls={holdClaim:false,holdCapture:false,held:null,malformed:false};
  const argNames={capture_growth_partner_source_v2:['p_intent','p_capability_hash','p_code','p_source','p_started_at'],claim_growth_partner_source:['p_actor','p_intent','p_capability_hash'],read_growth_partner_source:['p_actor','p_intent']};
  const adapter={async rpc(name,args){assert.ok(Object.hasOwn(argNames,name),'Only gateway RPCs, no direct table or legacy capture');assert.deepEqual(Object.keys(args).sort(),[...argNames[name]].sort());
    calls.push({name,args:structuredClone(args)});ids.add(args.p_intent);
    if((name==='claim_growth_partner_source'&&controls.holdClaim)||(name==='capture_growth_partner_source_v2'&&controls.holdCapture)){
      controls.holdClaim=false;controls.holdCapture=false;await new Promise(resolve=>{controls.held=resolve;});
    }
    const client=await fixture.connect();try{await client.query('set role service_role');const data=(await one(client,'select public.'+name+'('+argNames[name].map((_,i)=>'$'+(i+1)).join(',')+') value',argNames[name].map(k=>args[k]))).value;
      if(controls.malformed&&name==='capture_growth_partner_source_v2'){controls.malformed=false;return{data:{prepared:true},error:null};}return{data,error:null};
    }catch(error){return{data:null,error:{code:error.code}};}finally{await client.end();}
  }};
  const f=await partnerEntryHttpFixture(adapter),server=await startOwnedPartnerHttp(f.handler);
  const release=()=>{controls.held?.();controls.held=null;};
  async function call(op,{cookie,token,body={},expectJson=true}={}){
    const response=await fetch(server.origin+'/api/crm/partner-entry?op='+op,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{Origin:ENTRY_ORIGIN,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
    assert.equal(response.headers.get('Cache-Control'),'no-store');if(!expectJson)return response;
    const value=await response.json();assert.doesNotMatch(JSON.stringify(value),/owned-only-not-credential|owned-turnstile-not-credential|PRIVATE_/);
    return{status:response.status,value,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  return{f,partner,server,calls,controls,release,call,async prepare(){const p=await call('prepare',{body:{code:partner.code,source:'link',consent:true,consentVersion:f.notice.version,challengeToken:'owned-token'}});assert.equal(p.status,200);assert.ok(p.cookie);return p.cookie;},
    async close(){release();f.close();await server.close();assert.deepEqual(server.state.errors,[]);assert.deepEqual(f.state.unexpected,[]);
      if(ids.size)await db.query('delete from public.growth_partner_sources where id=any($1::uuid[])',[[...ids]]);
      await db.query('delete from public.growth_partners where id=$1',[partner.partner]);await db.query('delete from public.growth_contributor_profiles where id=$1',[partner.profile]);}
  };
}
export async function exercisePartnerEntryHttp(db,fixture,t){
  t.after(stopPartnerEntryBuilds);
  await t.test('entry actual HTTP -> full compiled router -> real source SQL, synthetic Auth/Turnstile/notice only',async()=>{
    const x=await setup(db,fixture);try{const cookie=await x.prepare();assert.equal(x.calls.length,0);const a=await x.call('capture',{cookie});assert.equal(a.status,200);assert.equal((await x.call('capture',{cookie})).value.data.id,a.value.data.id);
      const claimed=await x.call('claim',{cookie,token:'owned.owner.signature'});assert.equal(claimed.status,200);assert.equal(claimed.value.data.state,'captured');
      assert.equal((await x.call('read',{cookie,token:'owned.other.signature'})).status,403);assert.equal((await x.call('read',{cookie,token:'owned.owner.signature'})).status,200);
      assert.equal((await one(db,'select actor_auth_user_id actor from public.growth_partner_sources where id=$1',[a.value.data.id])).actor,ENTRY_ACTOR);
      assert.equal(x.f.state.challenges.length,1);assert.equal((await one(db,'select count(*)::int n from public.growth_referrals')).n,0);
    }finally{await x.close();}
  });
  await t.test('entry a committed capture with lost HTTP body is recovered on the same sealed intent without another row',async()=>{
    const x=await setup(db,fixture);try{const cookie=await x.prepare();x.server.state.dropCapture=true;
      const lost=await x.call('capture',{cookie,expectJson:false});await assert.rejects(lost.json());const recovered=await x.call('capture',{cookie});assert.equal(recovered.status,200);
      assert.equal((await one(db,'select count(*)::int n from public.growth_partner_sources')).n,1);assert.equal(x.f.state.challenges.length,1);
    }finally{await x.close();}
  });
  await t.test('entry malformed actual committed acknowledgement stays unconfirmed, exact cookie retry resolves it',async()=>{
    const x=await setup(db,fixture);try{const cookie=await x.prepare();x.controls.malformed=true;assert.equal((await x.call('capture',{cookie})).status,503);
      assert.equal((await x.call('capture',{cookie})).status,200);assert.equal((await one(db,'select count(*)::int n from public.growth_partner_sources')).n,1);
    }finally{await x.close();}
  });
  await t.test('entry two verified accounts cannot both claim one source, including a delayed original HTTP request',async()=>{
    const x=await setup(db,fixture);let pending;try{const cookie=await x.prepare();const receipt=await x.call('capture',{cookie});x.controls.holdClaim=true;
      pending=x.call('claim',{cookie,token:'owned.owner.signature'});await until(()=>x.controls.held);
      assert.equal((await x.call('claim',{cookie,token:'owned.other.signature'})).status,200);x.release();assert.equal((await pending).status,403);
      assert.equal((await one(db,'select actor_auth_user_id actor from public.growth_partner_sources where id=$1',[receipt.value.data.id])).actor,ENTRY_OTHER);
      assert.equal((await x.call('read',{cookie,token:'owned.owner.signature'})).status,403);
    }finally{x.release();if(pending)await pending;await x.close();}
  });
  await t.test('entry partner approval revoked after the HTTP request but before SQL prevents the first write',async()=>{
    const x=await setup(db,fixture);let pending;try{const cookie=await x.prepare();x.controls.holdCapture=true;pending=x.call('capture',{cookie});await until(()=>x.controls.held);
      await db.query("update public.growth_contributor_profiles set partner_status='suspended' where id=$1",[x.partner.profile]);x.release();assert.equal((await pending).status,403);
      assert.equal((await one(db,'select count(*)::int n from public.growth_partner_sources')).n,0);
    }finally{x.release();if(pending)await pending;await x.close();}
  });
  await t.test('entry real chunked over-limit response arrives before request EOF without provider or DB access',async()=>{
    const x=await setup(db,fixture);try{
      const r=await new Promise((resolve,reject)=>{const url=new URL(x.server.origin);const request=httpRequest({host:url.hostname,port:url.port,path:'/api/crm/partner-entry?op=prepare',method:'POST',headers:{Origin:ENTRY_ORIGIN,'Content-Type':'application/json','Transfer-Encoding':'chunked',Connection:'close'},timeout:10000},res=>{
        request.end();const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())}));res.on('error',reject);
      });request.on('error',reject);request.on('timeout',()=>request.destroy(Error('Owned chunked timeout')));request.write(Buffer.alloc(8192));request.write(' ');});
      assert.equal(r.status,413);assert.equal(r.body.code,'request_body_too_large');assert.equal(x.calls.length,0);assert.equal(x.f.state.challenges.length,0);
    }finally{await x.close();}
  });
}

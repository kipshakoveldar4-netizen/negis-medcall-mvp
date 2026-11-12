import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { partnerEntryHttpFixture,stopPartnerEntryBuilds,ENTRY_ACTOR,ENTRY_OTHER,ENTRY_ORIGIN } from './partner-entry-http-fixture.mjs';
import { startOwnedPartnerHttp } from './partner-entry-native-http-cases.mjs';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const allowed={execute_growth_partner_terms:['p_actor','p_side','p_profile','p_request','p_profile_revision','p_revision','p_action','p_payload'],
  read_growth_partner_terms:['p_actor','p_side','p_profile','p_request','p_close','p_action']};
async function setup(db,fixture){
  const applied=(await one(db,"select public.apply_growth_contributor($1,'Owned HTTP partner',true,true,'{}') v",[ENTRY_OTHER])).v;
  const profile=(await one(db,"select public.review_growth_contributor($1,$2,$3,'partner','approve') v",[applied.id,applied.revision,ENTRY_ACTOR])).v;
  const controls={malformed:false,hold:false,held:null},calls=[];
  const adapter={async rpc(name,args){assert.ok(Object.hasOwn(allowed,name));assert.deepEqual(Object.keys(args).sort(),[...allowed[name]].sort());calls.push({name,args:structuredClone(args)});
    if(controls.hold){controls.hold=false;await new Promise(resolve=>{controls.held=resolve;});}
    const client=await fixture.connect();try{await client.query('set role service_role');const v=(await one(client,'select public.'+name+'('+allowed[name].map((_,i)=>'$'+(i+1)).join(',')+') v',allowed[name].map(k=>args[k]))).v;
      if(controls.malformed){controls.malformed=false;return{data:{state:'unconfirmed',requestId:args.p_request,profileId:args.p_profile},error:null};}return{data:v,error:null};
    }catch(e){return{data:null,error:{code:e.code,message:'PRIVATE_TERMS_DIAGNOSTIC'}};}finally{await client.end();}
  }};
  const f=await partnerEntryHttpFixture(adapter,{approved:false,env:{MEDINA_PLATFORM_OWNER_IDS:ENTRY_ACTOR,MEDINA_PARTNER_ENTRY_ENABLED:'false'}});
  const server=await startOwnedPartnerHttp(f.handler,['/api/crm/partner-terms','/api/crm/platform-partner-terms']);
  const release=()=>{controls.held?.();controls.held=null;};
  async function call(platform=false,{method='GET',token=platform?'owned.owner.signature':'owned.other.signature',body,query={},expectJson=true}={}){
    const q=new URLSearchParams(method==='GET'?{profileId:profile.id,...query}:query);
    const response=await fetch(server.origin+'/api/crm/'+(platform?'platform-partner-terms':'partner-terms')+'?'+q,{method,redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{Origin:ENTRY_ORIGIN,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    assert.equal(response.headers.get('cache-control'),'no-store');if(!expectJson)return response;
    const value=await response.json();assert.doesNotMatch(JSON.stringify(value),/PRIVATE_|owned-only-not-credential|auth_user_id|offered_by|decided_by/);return{status:response.status,value};
  }
  const offerBody=()=>({requestId:randomUUID(),profileId:profile.id,profileRevision:profile.revision,revision:null,action:'offer',
    payload:{firstCommissionBps:1750,renewalCommissionBps:650,terms:'Fictional HTTP terms only'}});
  async function offer(){const c=offerBody(),r=await call(true,{method:'POST',body:c});assert.equal(r.status,200);return r.value.data.result.agreement.revision;}
  const acceptBody=revision=>({requestId:randomUUID(),profileId:profile.id,profileRevision:profile.revision,revision,action:'accept',payload:{accepted:true}});
  return{profile,call,offer,offerBody,acceptBody,calls,controls,release,server,async close(){release();f.close();await server.close();assert.deepEqual(f.state.unexpected,[]);assert.deepEqual(server.state.errors,[]);
    await db.query('delete from public.growth_partner_term_commands where profile_id=$1',[profile.id]);await db.query('delete from public.growth_partner_terms where profile_id=$1',[profile.id]);
    await db.query('delete from public.growth_partners where auth_user_id=$1',[ENTRY_OTHER]);await db.query('delete from public.growth_contributor_profiles where id=$1',[profile.id]);}};
}
export async function exercisePartnerTermsHttp(db,fixture,t){
  t.after(stopPartnerEntryBuilds);
  await t.test('terms real HTTP/router requires verified identity or platform allowlist before reading body/storage',async()=>{
    const x=await setup(db,fixture);try{
      assert.equal((await x.call(false,{token:null})).status,401);assert.equal((await x.call(true,{token:null})).status,404);
      assert.equal((await x.call(true,{token:'owned.other.signature'})).status,404);assert.equal(x.calls.length,0);
      assert.equal((await x.call(true,{method:'POST',body:{...x.offerBody(),actor:ENTRY_OTHER}})).status,400);
      assert.equal((await x.call(false,{query:{workspaceId:randomUUID()}})).status,400);assert.equal(x.calls.length,0);
      assert.equal((await x.call(false,{method:'POST',body:x.offerBody()})).status,403);assert.equal(x.calls.length,0);
    }finally{await x.close();}
  });
  await t.test('terms actual HTTP -> real SQL proposal, partner acceptance and code; no cross-actor read or client-picked identity',async()=>{
    const x=await setup(db,fixture);try{const rev=await x.offer(),pending=await x.call();assert.equal(pending.status,200);assert.equal(pending.value.data.agreement.referralCode,null);
      assert.equal((await x.call(false,{token:'owned.owner.signature'})).status,403);const c=x.acceptBody(rev),a=await x.call(false,{method:'POST',body:c});
      assert.equal(a.status,200);assert.match(a.value.data.result.agreement.referralCode,/^[A-F0-9]{32}$/);
      assert.equal(x.calls.at(-1).args.p_actor,ENTRY_OTHER);assert.equal(x.calls.at(-1).args.p_side,'partner');
      assert.equal((await x.call(false,{method:'POST',body:{...c,owner:ENTRY_ACTOR}})).status,400);
    }finally{await x.close();}
  });
  await t.test('terms actual committed activation with lost HTTP ACK recovers one code via receipt and exact retry',async()=>{
    const x=await setup(db,fixture);try{const c=x.acceptBody(await x.offer());x.server.state.dropNextPost=true;
      const lost=await x.call(false,{method:'POST',body:c,expectJson:false});await assert.rejects(lost.json());
      const receipt=await x.call(false,{query:{requestId:c.requestId}}),again=await x.call(false,{method:'POST',body:c});
      assert.equal(receipt.status,200);assert.deepEqual(again.value,receipt.value);
      assert.equal((await one(db,'select count(*)::int n from public.growth_partners')).n,1);
      assert.equal((await x.call(false,{method:'POST',body:{operation:'close',requestId:c.requestId,profileId:x.profile.id,action:'accept'}})).value.data.state,'committed');
    }finally{await x.close();}
  });
  await t.test('terms malformed committed ACK is not success and retry does not repeat commercial activation',async()=>{
    const x=await setup(db,fixture);try{const c=x.acceptBody(await x.offer());x.controls.malformed=true;
      assert.equal((await x.call(false,{method:'POST',body:c})).status,503);const retry=await x.call(false,{method:'POST',body:c});assert.equal(retry.status,200);
      assert.equal((await one(db,'select count(*)::int n from public.growth_partners')).n,1);
    }finally{await x.close();}
  });
  await t.test('terms approval revoked between actual HTTP Auth and SQL denies the pending acceptance',async()=>{
    const x=await setup(db,fixture);let pending;try{const c=x.acceptBody(await x.offer());x.controls.hold=true;pending=x.call(false,{method:'POST',body:c});
      for(let n=0;n<200&&!x.controls.held;n++)await new Promise(r=>setTimeout(r,10));assert.ok(x.controls.held);
      await db.query("update public.growth_contributor_profiles set partner_status='suspended' where id=$1",[x.profile.id]);x.release();assert.equal((await pending).status,403);
      assert.equal((await one(db,'select count(*)::int n from public.growth_partners')).n,0);
    }finally{x.release();if(pending)await pending;await x.close();}
  });
}

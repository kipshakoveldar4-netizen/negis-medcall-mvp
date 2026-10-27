import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import { Readable } from 'node:stream';
import { partnerEntryHttpFixture,stopPartnerEntryBuilds,ENTRY_ACTOR,ENTRY_OTHER,ENTRY_ORIGIN } from './partner-entry-http-fixture.mjs';
after(stopPartnerEntryBuilds);
const profile='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',revision='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',requestId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const terms={firstCommissionBps:1250,renewalCommissionBps:650,terms:'Owned proposal text\nNo real agreement.'};
const snapshot=(state='pending')=>({profileId:profile,profileRevision:revision,state:'managed',agreement:{...terms,revision:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',state,
  offeredAt:'2026-10-27T01:00:00.000000Z',decidedAt:state==='pending'?null:'2026-10-27T02:00:00.000000Z',commercialStatus:state==='accepted'?'active':null,
  referralCode:state==='accepted'?'A'.repeat(32):null}});
const offer=()=>({requestId,profileId:profile,profileRevision:revision,revision:null,action:'offer',payload:{...terms}});
const receipt=(action='offer')=>({state:'committed',requestId,profileId:profile,action,result:snapshot({offer:'pending',accept:'accepted',cancel:'cancelled',decline:'declined'}[action])});
async function setup(){const state={calls:[],value:snapshot(),error:null},adapter={async rpc(name,args){state.calls.push({name,args:structuredClone(args)});return{data:state.value,error:state.error};}};
  const f=await partnerEntryHttpFixture(adapter,{approved:false,env:{MEDINA_PLATFORM_OWNER_IDS:ENTRY_ACTOR,MEDINA_PARTNER_ENTRY_ENABLED:'false'}});
  async function call(platform=false,{method='GET',body,query={},token=platform?'owned.owner.signature':'owned.other.signature'}={}){
    const req=Readable.from([Buffer.from(body===undefined?'':JSON.stringify(body))]);Object.assign(req,{method,url:'/api/crm/'+(platform?'platform-partner-terms':'partner-terms'),
      query:{path:[platform?'platform-partner-terms':'partner-terms'],...(method==='GET'?{profileId:profile}:{}),...query},headers:{origin:ENTRY_ORIGIN,'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})}});
    const res={statusCode:200,headers:{},body:null,setHeader(k,v){this.headers[k.toLowerCase()]=v;return this;},status(v){this.statusCode=v;return this;},json(v){this.body=JSON.parse(JSON.stringify(v));return this;},end(v){this.body=v;return this;}};
    await f.handler(req,res);assert.equal(res.headers['cache-control'],'no-store');assert.deepEqual(f.state.unexpected,[]);
    assert.doesNotMatch(JSON.stringify(res.body),/PRIVATE_|owned-only-not-credential/);return res;
  }
  return{f,state,call,close:()=>f.close()};
}
test('terms contracts retain exact negotiated values and immutable result identity, never defaults',async()=>{
  const x=await setup();try{
    assert.ok(x.f.terms.parsePartnerOffer(terms));assert.ok(x.f.terms.parsePartnerTermsCommand(offer()));
    assert.ok(x.f.terms.parsePartnerTermsSnapshot(snapshot('accepted')));assert.ok(x.f.terms.parsePartnerTermsReceipt(receipt('accept')));
    for(const change of [{...terms,firstCommissionBps:null},{...terms,renewalCommissionBps:'650'},{...terms,firstCommissionBps:1250.5},
      {...terms,firstCommissionBps:999},{...terms,renewalCommissionBps:1001},{...terms,terms:''},{...terms,terms:'x'.repeat(2001)},
      {...terms,terms:'bad\u0000'},{...terms,owner:ENTRY_ACTOR}])assert.equal(x.f.terms.parsePartnerOffer(change),null);
    const s=snapshot();s.agreement.state={toString(){throw Error('Do not coerce untrusted values');}};assert.equal(x.f.terms.parsePartnerTermsSnapshot(s),null);
  }finally{x.close();}
});
test('terms DTO rejects state/code/decision/identity contradictions and private extra fields',async()=>{
  const x=await setup();try{const parse=x.f.terms.parsePartnerTermsSnapshot;
    for(const mutate of [v=>{v.agreement.referralCode='A'.repeat(32);},v=>{v.agreement.decidedAt='2026-01-01T00:00:00Z';},
      v=>{v.agreement.auth_user_id=ENTRY_OTHER;},v=>{v.profileId='bad';},v=>{v.agreement.firstCommissionBps=500;},v=>{v.agreement.offeredAt='2026-02-31T00:00:00Z';}]){
      const v=snapshot();mutate(v);assert.equal(parse(v),null);
    }
    for(const mutate of [v=>{v.agreement.commercialStatus=null;},v=>{v.agreement.referralCode=null;},v=>{v.agreement.decidedAt=null;},v=>{v.agreement.referralCode='FOREIGN_CODE';},
      v=>{v.agreement.offeredAt='2026-10-27T01:00:00.000900Z';v.agreement.decidedAt='2026-10-27T01:00:00.000800Z';}]){
      const v=snapshot('accepted');mutate(v);assert.equal(parse(v),null);
    }
    const r=receipt('accept');r.result.profileId=ENTRY_ACTOR;assert.equal(x.f.terms.parsePartnerTermsReceipt(r),null);
    for(const [offered,decided]of [['.1Z','.100000Z'],['.000900Z','.000901Z'],['Z','.000001Z']]){
      const v=snapshot('accepted');v.agreement.offeredAt='2026-10-27T01:00:00'+offered;v.agreement.decidedAt='2026-10-27T01:00:00'+decided;assert.ok(parse(v));
    }
  }finally{x.close();}
});
test('actual router denies anonymous/ordinary clinic authority before terms storage or body',async()=>{
  const x=await setup();try{assert.equal((await x.call(false,{token:null})).statusCode,401);assert.equal((await x.call(true,{token:null})).statusCode,404);
    assert.equal((await x.call(true,{token:'owned.other.signature'})).statusCode,404);assert.equal(x.state.calls.length,0);
    const hidden=await x.call(true,{token:null}),missing=await x.call(false,{token:null,query:{path:['owned-unregistered-route']}});
    assert.deepEqual(hidden.body,missing.body);assert.deepEqual(hidden.headers,missing.headers);
  }finally{x.close();}
});
test('actual router derives side/actor from verified Auth or platform allowlist; body cannot select either',async()=>{
  const x=await setup();try{x.state.value=receipt();assert.equal((await x.call(true,{method:'POST',body:offer()})).statusCode,200);
    assert.equal(x.state.calls[0].args.p_actor,ENTRY_ACTOR);assert.equal(x.state.calls[0].args.p_side,'platform');
    x.state.value=receipt('accept');const accept={...offer(),revision:snapshot().agreement.revision,action:'accept',payload:{accepted:true}};
    assert.equal((await x.call(false,{method:'POST',body:accept})).statusCode,200);assert.equal(x.state.calls.at(-1).args.p_actor,ENTRY_OTHER);
    for(const field of ['actor','side','workspaceId','staffId','owner'])assert.equal((await x.call(false,{method:'POST',body:{...accept,[field]:ENTRY_ACTOR}})).statusCode,400);
    assert.equal((await x.call(false,{method:'POST',body:offer()})).statusCode,403);
  }finally{x.close();}
});
test('terms exact query and body reject extra selectors, arrays, missing revisions and coerced acceptance before SQL',async()=>{
  const x=await setup();try{
    for(const query of [{profileId:[profile]},{requestId:['bad']},{workspaceId:ENTRY_ACTOR},{actor:ENTRY_ACTOR}])assert.equal((await x.call(false,{query})).statusCode,400);
    for(const change of [{...offer(),profileRevision:null},{...offer(),revision:'bad'},{...offer(),action:'approve'},
      {...offer(),payload:{...terms,firstCommissionBps:'1250'}},{...offer(),action:'accept',revision:snapshot().agreement.revision,payload:{accepted:'true'}}])
      assert.equal((await x.call(true,{method:'POST',body:change})).statusCode,400);
    assert.equal(x.state.calls.length,0);
  }finally{x.close();}
});
test('HTTP mutations do not accept unknown, foreign, contradictory or mismatched terms ACKs as success',async()=>{
  const x=await setup();try{
    for(const v of [{state:'unconfirmed',requestId,profileId:profile},{...receipt(),requestId:ENTRY_ACTOR},{...receipt(),profileId:ENTRY_ACTOR},
      {...receipt(),action:'accept'},{...receipt(),result:{...snapshot(),profileRevision:ENTRY_ACTOR}},
      {...receipt(),result:{...snapshot(),agreement:{...snapshot().agreement,firstCommissionBps:2500}}},
      {...receipt(),private:'extra'}]){x.state.value=v;assert.equal((await x.call(true,{method:'POST',body:offer()})).statusCode,503);}
    x.state.value=receipt();assert.equal((await x.call(true,{method:'POST',body:{...offer(),profileRevision:revision.toUpperCase()}})).statusCode,200);
  }finally{x.close();}
});
test('unknown read is distinct from explicit close and committed close never means business cancellation',async()=>{
  const x=await setup();try{x.state.value={state:'unconfirmed',requestId,profileId:profile};assert.equal((await x.call(false,{query:{requestId}})).statusCode,200);
    x.state.value={state:'abandoned',requestId,profileId:profile,action:'accept'};assert.equal((await x.call(false,{method:'POST',body:{operation:'close',requestId,profileId:profile,action:'accept'}})).statusCode,200);
    assert.equal(x.state.calls.at(-1).args.p_close,true);x.state.value=receipt('accept');assert.equal((await x.call(false,{method:'POST',body:{operation:'close',requestId,profileId:profile,action:'accept'}})).statusCode,200);
  }finally{x.close();}
});
test('terms SQL errors are sanitized and refusals/conflicts stay distinct from unknown outcome',async()=>{
  const x=await setup();try{for(const [code,status]of [['P1141',403],['P1142',400],['P1143',409],['P1145',409],['P1144',503],['42P01',503]]){
      x.state.error={code,message:'PRIVATE_SQL_TERMS'};assert.equal((await x.call()).statusCode,status);
    }
  }finally{x.close();}
});

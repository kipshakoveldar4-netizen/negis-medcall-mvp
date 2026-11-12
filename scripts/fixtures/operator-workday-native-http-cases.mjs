import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { partnerEntryHttpFixture, stopPartnerEntryBuilds, ENTRY_ORIGIN } from './partner-entry-http-fixture.mjs';
import { startOwnedPartnerHttp } from './partner-entry-native-http-cases.mjs';
import { seedOperatorWorkday, cleanupOperatorWorkday } from './operator-workday-cases.mjs';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];

export async function exerciseOperatorWorkdayHttp(db,fixture,t){
  t.after(stopPartnerEntryBuilds);
  const x=await seedOperatorWorkday(db,{companies:1,visits:2,label:'OWNEDHTTP_A'}),other=await seedOperatorWorkday(db,{companies:1,visits:1,label:'OWNEDHTTP_B'});
  const controls={hold:false,release:null,error:null,malformed:false},calls=[];
  const adapter={async rpc(name,args){
    assert.equal(name,'read_growth_operator_workday');assert.deepEqual(Object.keys(args).sort(),['p_actor','p_offset']);calls.push(structuredClone(args));
    if(controls.hold){controls.hold=false;await new Promise(resolve=>{controls.release=resolve;});}
    if(controls.error)return{data:null,error:{code:controls.error,message:'PRIVATE_WORKDAY_INTERNAL'}};
    const client=await fixture.connect();try{
      await client.query('set role service_role');const data=(await one(client,'select public.read_growth_operator_workday($1,$2) v',[args.p_actor,args.p_offset])).v;
      return{data:controls.malformed?{...data,offset:args.p_offset+1}:data,error:null};
    }catch(error){return{data:null,error:{code:error.code,message:'PRIVATE_WORKDAY_INTERNAL'}};}finally{await client.end();}
  }};
  const f=await partnerEntryHttpFixture(adapter,{approved:false,identities:new Map([['owned.operator.signature',x.actor],['owned.other.signature',other.actor],['owned.nonoperator.signature',randomUUID()]]),env:{MEDINA_PARTNER_ENTRY_ENABLED:'false'}});
  const server=await startOwnedPartnerHttp(f.handler,['/api/crm/operator-workday','/api/crm/operator-workday/extra']);
  const release=()=>{controls.release?.();controls.release=null;};
  async function call(query='',{method='GET',token='owned.operator.signature',suffix=''}={}){
    const response=await fetch(server.origin+'/api/crm/operator-workday'+suffix+(query?'?'+query:''),{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{Origin:ENTRY_ORIGIN,...(token?{Authorization:'Bearer '+token}:{})}});
    const value=await response.json();assert.equal(response.headers.get('cache-control'),'no-store');
    assert.doesNotMatch(JSON.stringify(value),/PRIVATE_|owned-only-not-credential|auth_user_id|workspace_id|price_minor|approved_by|notes/);
    return{status:response.status,value};
  }
  try{
    await t.test('123 actual HTTP/Auth/router/native SQL reads only the verified operator and rejects workspace/identity/clock selectors',async()=>{
      assert.equal((await call('',{token:null})).status,401);assert.equal(calls.length,0);
      for(const query of ['workspaceId='+x.companies[0].workspace,'requestId='+other.companies[0].request,'actor='+other.actor,'now=2026-01-01','timeZone=UTC','limit=1000','offset=-1','offset=00','offset=1000001','offset=0&offset=20']){
        assert.equal((await call(query)).status,400,query);assert.equal(calls.length,0);
      }
      for(const method of ['POST','PATCH','DELETE'])assert.equal((await call('',{method})).status,405);
      assert.equal((await call('',{suffix:'/extra'})).status,404);assert.equal(calls.length,0);
      const own=await call();assert.equal(own.status,200);assert.equal(own.value.data.companies.length,1);assert.equal(own.value.data.today.items.length,2);
      assert.ok(own.value.data.today.items.every(a=>a.clientName.startsWith('OWNEDHTTP_A')));assert.doesNotMatch(JSON.stringify(own.value),/OWNEDHTTP_B/);
      assert.deepEqual(calls.at(-1),{p_actor:x.actor,p_offset:0});
      const b=await call('',{token:'owned.other.signature'});assert.equal(b.status,200);assert.ok(b.value.data.today.items.every(a=>a.clientName.startsWith('OWNEDHTTP_B')));
      assert.equal((await call('',{token:'owned.nonoperator.signature'})).status,403);
      for(const table of ['platform_subscription_payments','growth_partner_commissions','growth_partner_payouts','deals'])assert.equal((await one(db,'select count(*)::int n from public.'+table)).n,0);
    });
    await t.test('123 actual HTTP missing/locked/stronger-isolation/wrong-page results stay safely unavailable, not zero or stale contacts',async()=>{
      controls.malformed=true;assert.equal((await call()).status,503);controls.malformed=false;
      for(const code of ['PGRST202','55P03','40001','P1232']){controls.error=code;const r=await call();assert.equal(r.status,503);assert.equal(r.value.data,undefined);}
      controls.error=null;const empty=await call('offset=20');assert.equal(empty.status,200);assert.equal(empty.value.data.today.total,'2');assert.deepEqual(empty.value.data.today.items,[]);
    });
    await t.test('123 approval revoked after actual HTTP Auth before the native reader refuses without publishing contacts',async()=>{
      controls.hold=true;const pending=call();try{
        for(let i=0;i<200&&!controls.release;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(controls.release);
        await db.query("update public.growth_operator_profiles set status='suspended',accepting_requests=false where id=$1",[x.profile]);
        release();const r=await pending;assert.equal(r.status,403);assert.equal(r.value.data,undefined);
      }finally{release();await pending;}
    });
  }finally{release();f.close();await server.close();assert.deepEqual(f.state.unexpected,[]);assert.deepEqual(server.state.errors,[]);assert.deepEqual(f.state.challenges,[]);await cleanupOperatorWorkday(db,x);await cleanupOperatorWorkday(db,other);}
}

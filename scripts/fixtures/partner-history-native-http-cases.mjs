import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { partnerEntryHttpFixture, stopPartnerEntryBuilds, ENTRY_ORIGIN } from './partner-entry-http-fixture.mjs';
import { startOwnedPartnerHttp } from './partner-entry-native-http-cases.mjs';
import { seedPartnerLedger, seedReferral, partnerPayment } from './partner-ledger-cases.mjs';
import { cleanupPartnerHistory } from './partner-history-cases.mjs';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
export async function exercisePartnerHistoryHttp(db,fixture,t){
  t.after(stopPartnerEntryBuilds);
  const setup=async()=>{
    const x=await seedPartnerLedger(db),other=await seedPartnerLedger(db);await partnerPayment(db,await seedReferral(db,x),'900719925474099300');
    const controls={hold:false,release:null,malformed:false,error:null},calls=[];
    const adapter={async rpc(name,args){
      assert.equal(name,'read_growth_partner_history');assert.deepEqual(Object.keys(args).sort(),['p_actor','p_month','p_offset']);
      calls.push(structuredClone(args));
      if(controls.hold){controls.hold=false;await new Promise(resolve=>{controls.release=resolve;});}
      if(controls.error)return{data:null,error:{code:controls.error,message:'PRIVATE_HISTORY_DIAGNOSTIC'}};
      const client=await fixture.connect();try{
        await client.query('set role service_role');const value=(await one(client,'select public.read_growth_partner_history($1,$2,$3) v',[args.p_actor,args.p_offset,args.p_month])).v;
        return{data:controls.malformed?{...value,offset:args.p_offset+1}:value,error:null};
      }catch(error){return{data:null,error:{code:error.code,message:'PRIVATE_HISTORY_DIAGNOSTIC'}};}finally{await client.end();}
    }};
    const f=await partnerEntryHttpFixture(adapter,{approved:false,identities:new Map([['owned.partner.signature',x.actor],['owned.other.signature',other.actor]]),
      env:{MEDINA_PARTNER_ENTRY_ENABLED:'false'}});
    const server=await startOwnedPartnerHttp(f.handler,['/api/crm/partner-history','/api/crm/partner-history/extra']);
    const release=()=>{controls.release?.();controls.release=null;};
    async function call(query='',{method='GET',token='owned.partner.signature',suffix=''}={}){
      const response=await fetch(server.origin+'/api/crm/partner-history'+suffix+(query?'?'+query:''),{method,redirect:'error',signal:AbortSignal.timeout(10000),
        headers:{Origin:ENTRY_ORIGIN,...(token?{Authorization:'Bearer '+token}:{})}});
      const value=await response.json();assert.equal(response.headers.get('cache-control'),'no-store');
      assert.doesNotMatch(JSON.stringify(value),/PRIVATE_|owned-only-not-credential|auth_user_id|workspace_id|payment_id|request_key|confirmed_by/);
      return{status:response.status,value};
    }
    return{x,other,controls,calls,call,release,async close(){release();f.close();await server.close();
      assert.deepEqual(f.state.unexpected,[]);assert.deepEqual(f.state.challenges,[]);assert.deepEqual(server.state.errors,[]);
      await cleanupPartnerHistory(db,x);await cleanupPartnerHistory(db,other);}};
  };
  await t.test('122 actual HTTP/Auth/router only reads the verified actor, without a selected workspace or financial action',async()=>{
    const x=await setup();try{
      assert.equal((await x.call('',{token:null})).status,401);assert.equal(x.calls.length,0);
      for(const query of ['partnerId='+randomUUID(),'workspaceId='+randomUUID(),'actor='+x.other.actor,'limit=100','offset=0&offset=20','month=2026-01&month=2026-02','offset=-1','offset=00','offset=1000001','month=0000-01','month=2026-13']){
        assert.equal((await x.call(query)).status,400,query);assert.equal(x.calls.length,0);
      }
      for(const method of ['POST','PATCH','DELETE'])assert.equal((await x.call('',{method})).status,405);
      assert.equal((await x.call('',{suffix:'/extra'})).status,404);assert.equal(x.calls.length,0);
      const own=await x.call();assert.equal(own.status,200);assert.equal(own.value.data.items.length,1);
      assert.equal(own.value.data.items[0].amountMinor,'90071992547409930');
      assert.deepEqual(x.calls.at(-1),{p_actor:x.x.actor,p_offset:0,p_month:null});
      const other=await x.call('',{token:'owned.other.signature'});assert.equal(other.status,200);assert.deepEqual(other.value.data.items,[]);
      assert.equal((await one(db,'select count(*)::integer n from public.platform_subscription_payments')).n,1);
      assert.equal((await one(db,'select count(*)::integer n from public.growth_partner_payouts')).n,0);
    }finally{await x.close();}
  });
  await t.test('122 actual HTTP response stays unavailable for wrong-page DTO, missing reader and lock errors',async()=>{
    const x=await setup();try{
      x.controls.malformed=true;assert.equal((await x.call()).status,503);x.controls.malformed=false;
      assert.equal((await x.call('offset=20&month=2026-01')).status,200);
      for(const code of ['PGRST202','55P03','40001','P1092']){x.controls.error=code;assert.equal((await x.call()).status,503);}
      x.controls.error=null;assert.equal((await x.call()).status,200);
    }finally{await x.close();}
  });
  await t.test('122 approval revoked after HTTP Auth but before SQL cannot disclose the pending journal',async()=>{
    const x=await setup();let pending;
    try{
      x.controls.hold=true;pending=x.call();
      for(let i=0;i<200&&!x.controls.release;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(x.controls.release);
      await db.query("update public.growth_contributor_profiles set partner_status='suspended' where id=$1",[x.x.profile]);
      x.release();const result=await pending;assert.equal(result.status,403);assert.equal(result.value.data,undefined);
      assert.equal((await one(db,'select count(*)::integer n from public.growth_partner_commissions')).n,1);
    }finally{x.release();if(pending)await pending;await x.close();}
  });
}

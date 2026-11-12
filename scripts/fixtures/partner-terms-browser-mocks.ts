import { parsePartnerTermsCommand,type PartnerTermsSnapshot } from "../../lib/crm/partner-terms-contracts";
import type { ContributorProfile } from "../../lib/crm/contributor-contracts";
export const ids={owner:"11111111-1111-4111-8111-111111111111",a:"33333333-3333-4333-8333-333333333333",b:"44444444-4444-4444-8444-444444444444",
  profileA:"55555555-5555-4555-8555-555555555555",profileB:"66666666-6666-4666-8666-666666666666"};
let actor:string|null=window.location.pathname==="/review"?ids.owner:new URLSearchParams(location.search).get('actor')==='b'?ids.b:ids.a,epoch=0;
const listeners=new Set<(...args:any[])=>void>();
const profiles=new Map<string,ContributorProfile>([[ids.a,{id:ids.profileA,revision:crypto.randomUUID(),displayName:"Тестовая Александра Константинопольская",portfolioUrls:[],partnerStatus:"approved",creatorStatus:null}],
  [ids.b,{id:ids.profileB,revision:crypto.randomUUID(),displayName:"Тестовый Борис",portfolioUrls:[],partnerStatus:"approved",creatorStatus:null}]]);
const heads=new Map<string,PartnerTermsSnapshot>(),receipts=new Map<string,any>(),intents=new Map<string,string>();
const calls:{path:string;method:string;actor:string|null;body:any}[]=[];
let hold:{path:string;method:string;release?:()=>void}|null=null,lose=false,failBefore=false,denied=false;
const session=()=>actor?{user:{id:actor},access_token:"owned-not-a-token"}:null;
export const hasSupabaseFrontendEnv=true;
export const supabase={auth:{getSession:async()=>({data:{session:session()},error:null}),
  onAuthStateChange:(fn:(...args:any[])=>void)=>{listeners.add(fn);return{data:{subscription:{unsubscribe:()=>listeners.delete(fn)}}};},
  signOut:async()=>{switchActor(null);return{error:null};},signInWithPassword:async()=>({data:{session:session()},error:null})}};
// Observer-only compatibility; this fixture does not test auth writes.
export const sessionAuth={onAuthStateChange:supabase.auth.onAuthStateChange};
export function switchActor(next:string|null){if(next!==actor){actor=next;epoch++;}for(const l of listeners)l("SIGNED_IN",session());}
export function captureControlAccess(){const origin=actor,version=epoch;return{actorId:origin??"",isCurrent:()=>origin===ids.owner&&actor===origin&&version===epoch};}
export function subscribeControlActor(fn:(s:any)=>void){const listener=(_e:any,s:any)=>fn(s);listeners.add(listener);return()=>listeners.delete(listener);}
export async function verifyControlAccess(){return captureControlAccess();}
export class OperatorApiError extends Error{constructor(message:string,readonly status:number){super(message);}}
const fail=(status:number,message="Доступ к партнёрству изменился.")=>{throw new OperatorApiError(message,status);};
const profileFor=(id:string)=>[...profiles.values()].find(p=>p.id===id);
function currentHead(id:string):PartnerTermsSnapshot{const p=profileFor(id);if(!p)return fail(403);
  const h=heads.get(id);return h?{...h,profileRevision:p.revision}:{state:"not_offered",profileId:id,profileRevision:p.revision,agreement:null};}
// UI doubles only. SQL/HTTP commit, locks and authority are verified independently.
async function request(path:string,body:any,method:string,valid:()=>boolean){
  if(!valid())throw Error("Stale fixture dispatch");const origin=actor,url=new URL(path,"http://owned.invalid"),route=url.pathname.replace(/^\//,"");
  calls.push({path,method,actor:origin,body:structuredClone(body??null)});if(failBefore&&method==="POST"){failBefore=false;throw Error("Тестовый ответ потерян до обработки");}
  let result:any;
  if(route==="contributor-account")result=profiles.get(origin!);
  else if(route==="platform-contributors"){
    if(origin!==ids.owner||denied)return fail(404);result={items:[...profiles.values()],hasMore:false};
  }else if(route==="partner-ledger"){
    if(profiles.get(origin!)?.partnerStatus!=="approved"||denied)return fail(403);
    const h=heads.get(profiles.get(origin!)!.id);
    result=h?.state==='managed'&&h.agreement.state==='accepted'?{state:'ready',generatedAt:new Date().toISOString(),
      firstCommissionBps:h.agreement.firstCommissionBps,renewalCommissionBps:h.agreement.renewalCommissionBps,
      registrations:'0',paidCompanies:'0',firstPayments:'0',renewals:'0',balances:[]}:{state:"not_activated"};
  }else if(["partner-terms","platform-partner-terms"].includes(route)){
    const platform=route.startsWith("platform-"),profileId=method==="GET"?url.searchParams.get("profileId"):body?.profileId,p=profileFor(profileId);
    if(denied||!p||(platform?origin!==ids.owner:profiles.get(origin!)?.id!==profileId||p.partnerStatus!=="approved"))return fail(platform?404:403);
    const requestId=method==="GET"?url.searchParams.get("requestId"):body?.requestId,key=origin+":"+requestId;
    if(method==="GET"&&!requestId)result=currentHead(profileId);
    else if(method==="GET")result=receipts.get(key)??{state:"unconfirmed",profileId,requestId};
    else if(body.operation==="close"){
      result=receipts.get(key)??{state:"abandoned",profileId,requestId,action:body.action};receipts.set(key,result);
    }else{
      const c=parsePartnerTermsCommand(body);if(!c)return fail(400,"Проверьте условия.");
      if(!(platform?["offer","cancel"]:["accept","decline"]).includes(c.action))return fail(403);
      const old=receipts.get(key);if(old){if(old.state==="committed"&&intents.get(key)!==JSON.stringify(body))return fail(409);result=old;}
      else{
        const h=currentHead(profileId),previous=h.agreement;
        if(c.profileRevision!==p.revision||(previous?.revision??null)!==c.revision||previous?.state==="accepted")return fail(409,"Условия изменились.");
        if(c.action==="offer"){
          if(p.partnerStatus!=="approved"||previous?.state==="pending")return fail(409);
          const v=c.payload as any;result={...h,state:"managed",agreement:{...v,revision:crypto.randomUUID(),state:"pending",offeredAt:new Date().toISOString(),decidedAt:null,commercialStatus:null,referralCode:null}};
        }else{
          if(previous?.state!=="pending")return fail(409);
          result={...h,agreement:{...previous,revision:crypto.randomUUID(),state:{accept:"accepted",cancel:"cancelled",decline:"declined"}[c.action],decidedAt:new Date().toISOString(),
            commercialStatus:c.action==="accept"?"active":null,referralCode:c.action==="accept"?crypto.randomUUID().replaceAll("-","").toUpperCase():null}};
        }
        heads.set(profileId,result);result={state:"committed",requestId,profileId,action:c.action,result};receipts.set(key,result);intents.set(key,JSON.stringify(body));
      }
    }
  }else throw Error("Unknown owned UI route: "+route);
  const captured=structuredClone(result),held=hold?.path===route&&hold.method===method&&!hold.release?hold:null;
  if(held)await new Promise<void>(resolve=>{held.release=resolve;});
  if(lose&&method==="POST"){lose=false;throw Error("Тестовый потерянный ответ");}return captured;
}
export async function operatorApi(path:string,body?:unknown,method="POST",signal?:AbortSignal,expected?:string,guard?:()=>boolean){
  return request(path,body,body===undefined?"GET":method,()=>!signal?.aborted&&(!expected||actor===expected)&&guard?.()!==false);
}
export async function controlFetch(path:string,init:RequestInit={},scope:{isCurrent:()=>boolean}){
  const data=await request(path.replace('/api/crm/',""),init.body?JSON.parse(String(init.body)):undefined,init.method??"GET",()=>!init.signal?.aborted&&scope.isCurrent());
  return new Response(JSON.stringify({success:true,data}),{status:200,headers:{"Content-Type":"application/json"}});
}
export const controlConfig={ready:true};
const seed=(window as any).__partnerTermsBackendSeed;
if(seed){profiles.clear();for(const[k,v]of seed.profiles)profiles.set(k,v);heads.clear();for(const[k,v]of seed.heads)heads.set(k,v);
  receipts.clear();for(const[k,v]of seed.receipts)receipts.set(k,v);intents.clear();for(const[k,v]of seed.intents)intents.set(k,v);}
Object.assign(window,{__partnerTermsQA:{ids,profiles,heads,receipts,intents,calls,switchActor,
  holdNext:(path:string,method="POST")=>{hold={path,method};},release:()=>{const h=hold;hold=null;h?.release?.();},
  loseNext:()=>{lose=true;},failBeforeNext:()=>{failBefore=true;},deny:(v=true)=>{denied=v;},
  dump:()=>({profiles:[...profiles],heads:[...heads],receipts:[...receipts],intents:[...intents]})}});

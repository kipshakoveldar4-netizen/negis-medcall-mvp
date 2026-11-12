import { parsePartnerTermsCommand, type PartnerTermsAction, type PartnerTermsCommand } from "../../../../lib/crm/partner-terms-contracts";
export type PartnerTermsSide = "platform" | "partner";
export type PartnerTermsAttempt = { actorId: string; profileId: string; side: PartnerTermsSide; requestId: string; action: PartnerTermsAction };
export type PartnerTermsStorage = Pick<Storage,"getItem"|"setItem"|"removeItem">;
export type PartnerTermsWrite = Omit<PartnerTermsCommand,"requestId">;
const uuid=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
export const partnerTermsActionAllowed=(side:PartnerTermsSide,action:unknown)=>typeof action==="string"&&(side==="platform"?["offer","cancel"]:["accept","decline"]).includes(action);
const valid=(v:unknown):v is PartnerTermsAttempt=>{
  if(!v||typeof v!=="object"||Array.isArray(v))return false;const r=v as Record<string,unknown>;
  return Object.keys(r).length===5&&["actorId","profileId","side","requestId","action"].every(k=>Object.hasOwn(r,k))
    &&uuid(r.actorId)&&uuid(r.profileId)&&uuid(r.requestId)&&(r.side==="platform"||r.side==="partner")&&partnerTermsActionAllowed(r.side,r.action);
};
const key=(actor:string,profile:string,side:PartnerTermsSide)=>`medina_partner_terms_v1:${actor}:${side}:${profile}`;
export function partnerTermsStorage():PartnerTermsStorage|null{try{return window.sessionStorage;}catch{return null;}}
export function restorePartnerTerms(storage:PartnerTermsStorage|null,actorId:string,profileId:string,side:PartnerTermsSide):{attempt:PartnerTermsAttempt|null;error:string}{
  const failed={attempt:null,error:"Ключ исходной отправки недоступен. Новая отправка заблокирована."};
  if(!storage||!uuid(actorId)||!uuid(profileId)||(side!=="platform"&&side!=="partner"))return failed;
  try{const raw=storage.getItem(key(actorId,profileId,side));if(raw===null)return{attempt:null,error:""};
    if(raw.length>1024)return failed;const value:unknown=JSON.parse(raw);
    return valid(value)&&value.actorId===actorId&&value.profileId===profileId&&value.side===side?{attempt:{...value},error:""}:failed;
  }catch{return failed;}
}
export function persistPartnerTerms(storage:PartnerTermsStorage|null,attempt:PartnerTermsAttempt){
  if(!storage||!valid(attempt))return false;
  try{const name=key(attempt.actorId,attempt.profileId,attempt.side),raw=JSON.stringify(attempt);
    if(storage.getItem(name)!==null)return false;storage.setItem(name,raw);return storage.getItem(name)===raw;
  }catch{return false;}
}
export function clearPartnerTerms(storage:PartnerTermsStorage|null,attempt:PartnerTermsAttempt){
  if(!storage||!valid(attempt))return false;
  try{const name=key(attempt.actorId,attempt.profileId,attempt.side);if(storage.getItem(name)!==JSON.stringify(attempt))return false;
    storage.removeItem(name);return storage.getItem(name)===null;
  }catch{return false;}
}
export function parsePartnerTermsWrite(value:unknown,profileId:string,side:PartnerTermsSide):PartnerTermsWrite|null{
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.hasOwn(value,"requestId"))return null;
  const c=parsePartnerTermsCommand({requestId:"00000000-0000-4000-8000-000000000001",...value});
  if(!c||c.profileId!==profileId||!partnerTermsActionAllowed(side,c.action))return null;
  const{requestId:_id,...write}=c;return write;
}
export function partnerPercentToBps(value:string,kind:"first"|"renewal"):number|null{
  if(!/^\d{1,2}([.,]\d{1,2})?$/.test(value.trim()))return null;
  const[whole,fraction=""]=value.trim().replace(",",".").split("."),bps=Number(BigInt(whole)*100n+BigInt(fraction.padEnd(2,"0")));
  return bps>=(kind==="first"?1000:500)&&bps<=(kind==="first"?5000:1000)?bps:null;
}

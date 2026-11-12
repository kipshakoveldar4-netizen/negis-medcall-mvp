import { useLayoutEffect,useRef,useState } from "react";
import { parsePartnerTermsReceipt } from "../../../../lib/crm/partner-terms-contracts";
import { clearPartnerTerms,parsePartnerTermsWrite,partnerTermsStorage,persistPartnerTerms,restorePartnerTerms,
  type PartnerTermsAttempt,type PartnerTermsSide,type PartnerTermsWrite } from "./partnerTermsAttempt";
const failure=(message:string)=>Object.assign(new Error(message),{status:503});
export function usePartnerTermsCommand(actorId:string,profileId:string,side:PartnerTermsSide,isSessionCurrent:()=>boolean){
  type Owner={mounted:boolean;expired:boolean;actorId:string;profileId:string;side:PartnerTermsSide;guard:()=>boolean;
    attempt:PartnerTermsAttempt|null;error:string;draft:{attempt:PartnerTermsAttempt;json:string}|null};
  const[,render]=useState(0),storage=partnerTermsStorage();
  const initial=():Owner=>({mounted:false,expired:false,actorId,profileId,side,guard:isSessionCurrent,attempt:null,error:"",draft:null});
  const[owner,setOwner]=useState(initial),live=useRef<Owner|null>(null);
  // Effect replay replaces ownership; old callbacks never become live again.
  useLayoutEffect(()=>{const next={...initial(),...restorePartnerTerms(storage,actorId,profileId,side),mounted:true};live.current=next;setOwner(next);
    return()=>{next.mounted=false;next.draft=null;if(live.current===next)live.current=null;};},[actorId,profileId,side]);
  const current=(attempt?:PartnerTermsAttempt)=>{
    if(live.current!==owner||!owner.mounted||owner.expired||owner.actorId!==actorId||owner.profileId!==profileId||owner.side!==side)return false;
    if(!owner.guard()){owner.expired=true;owner.draft=null;return false;}return !attempt||owner.attempt===attempt;
  };
  return{lifetime:owner,isCurrent:current,attempt:current()?owner.attempt:null,error:current()?owner.error:"",
    blocked:!current()||Boolean(owner.attempt||owner.error),canRetry:current()&&owner.attempt!==null&&owner.draft?.attempt===owner.attempt,
    claim(value:PartnerTermsWrite){
      if(!current()||owner.attempt||owner.error)return null;
      const write=parsePartnerTermsWrite(value,profileId,side);if(!write)throw failure("Проверьте условия и версию профиля.");
      const previous=restorePartnerTerms(storage,actorId,profileId,side);
      if(previous.attempt||previous.error){Object.assign(owner,previous);render(n=>n+1);return null;}
      try{const attempt:PartnerTermsAttempt={actorId,profileId,side,requestId:crypto.randomUUID(),action:write.action};
        if(!persistPartnerTerms(storage,attempt))throw Error();owner.attempt=attempt;owner.draft={attempt,json:JSON.stringify({requestId:attempt.requestId,...write})};
        render(n=>n+1);return attempt;
      }catch{owner.error="Не удалось сохранить ключ отправки. Запрос не отправлен.";render(n=>n+1);return null;}
    },
    payload(attempt:PartnerTermsAttempt){return current(attempt)&&owner.draft?.attempt===attempt?JSON.parse(owner.draft.json) as unknown:null;},
    complete(attempt:PartnerTermsAttempt,value:unknown){
      if(!current(attempt))return null;const receipt=parsePartnerTermsReceipt(value);
      if(!receipt||receipt.requestId!==attempt.requestId||receipt.profileId!==attempt.profileId
        ||("action"in receipt&&receipt.action!==attempt.action))throw failure("Исходная отправка не подтверждена.");
      if(receipt.state==="unconfirmed")return null;
      if(receipt.state==="committed"&&owner.draft?.attempt===attempt){
        const body=JSON.parse(owner.draft.json),s=receipt.result;
        if(s.profileRevision!==body.profileRevision||s.state!=="managed"||s.agreement.revision===body.revision
          ||(attempt.action==="offer"&&(["firstCommissionBps","renewalCommissionBps","terms"]as const).some(k=>s.state!=="managed"||s.agreement[k]!==body.payload[k])))
          throw failure("Ответ не совпадает с исходными условиями.");
      }
      if(!clearPartnerTerms(storage,attempt))throw failure("Результат подтверждён, но ключ не очищен. Новая отправка заблокирована.");
      owner.attempt=null;owner.draft=null;render(n=>n+1);return receipt;
    },
    expire(){if(live.current!==owner)return;owner.expired=true;owner.draft=null;render(n=>n+1);},
  };
}

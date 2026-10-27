import type { VercelRequest,VercelResponse } from "@vercel/node";
import { isUuidValue,requireAuthenticatedUser } from "../auth/server";
import { readPlatformOwner } from "../auth/platform";
import { getSupabaseServerClient } from "../supabase/server";
import { parsePartnerTermsCommand,parsePartnerTermsReceipt,parsePartnerTermsSnapshot } from "./partner-terms-contracts";

const object=(v:unknown):Record<string,unknown>|null=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:null;
const keys=(v:Record<string,unknown>,expected:string[])=>Object.keys(v).length===expected.length&&expected.every(k=>Object.hasOwn(v,k));
export async function handlePartnerTerms(req:VercelRequest,res:VercelResponse,platform=false){
  res.setHeader("Cache-Control","no-store");
  const fail=(status:number,code:string,error:string)=>res.status(status).json({success:false,code,error});
  const owner=platform?readPlatformOwner(req):null;
  if(platform&&!owner)return fail(404,"not_found","Не найдено.");
  const actor=platform?owner!.userId:(await requireAuthenticatedUser(req)).id;
  if(!["GET","POST"].includes(req.method??""))return fail(405,"method_not_allowed","Метод не разрешён.");
  const allowed=req.method==="GET"?["path","profileId","requestId"]:["path"];
  if(Object.keys(req.query).some(k=>!allowed.includes(k)))return fail(400,"invalid_partner_terms_query","Параметры запроса не разрешены.");
  let profileId:string,requestId:string|null=null,close=false,action:string|null=null;
  let params:Record<string,unknown>={},command:ReturnType<typeof parsePartnerTermsCommand>=null;
  if(req.method==="GET"){
    if(!isUuidValue(req.query.profileId)||(req.query.requestId!==undefined&&!isUuidValue(req.query.requestId))
      ||(req.body!=null&&(!object(req.body)||Object.keys(req.body).length)))return fail(400,"invalid_partner_terms_query","Укажите профиль и исходную операцию.");
    profileId=req.query.profileId as string;requestId=req.query.requestId as string??null;
  }else{
    const v=object(req.body);
    if(v?.operation==="close"){
      if(!keys(v,["operation","requestId","profileId","action"])||!isUuidValue(v.requestId)||!isUuidValue(v.profileId)
        ||typeof v.action!=="string"||!["offer","cancel","accept","decline"].includes(v.action))return fail(400,"invalid_partner_terms_command","Укажите исходную операцию.");
      profileId=v.profileId as string;requestId=v.requestId as string;action=v.action;close=true;
    }else{
      command=parsePartnerTermsCommand(v);
      if(!command)return fail(400,"invalid_partner_terms_command","Проверьте версии, проценты и условия.");
      ({profileId,requestId,action}=command);
      params={p_profile_revision:command.profileRevision,p_revision:command.revision,p_action:command.action,p_payload:command.payload};
    }
    if(!(platform?["offer","cancel"]:["accept","decline"]).includes(action!))return fail(403,"partner_terms_access_denied","Действие недоступно для этой стороны.");
  }
  const db=getSupabaseServerClient();
  const unavailable=()=>fail(503,"partner_terms_unconfirmed","Результат не подтверждён. Проверьте исходную операцию перед повтором.");
  if(!db)return unavailable();
  const scope={p_actor:actor,p_side:platform?"platform":"partner",p_profile:profileId,p_request:requestId};
  try{
    const {data,error}=await db.rpc(command?"execute_growth_partner_terms":"read_growth_partner_terms",
      {...scope,...(command?params:{p_close:close,p_action:action})});
    if(error){
      if(error.code==="P1141")return fail(403,"partner_terms_access_denied","Доступ к партнёрству изменился. Обновите профиль.");
      if(error.code==="P1142")return fail(400,"invalid_partner_terms_command","Проверьте поля условий.");
      if(error.code==="P1143"||error.code==="P1145")return fail(409,"partner_terms_changed","Условия или исходная операция изменились. Обновите состояние.");
      return unavailable();
    }
    const parsed=requestId===null?parsePartnerTermsSnapshot(data):parsePartnerTermsReceipt(data);
    if(!parsed||parsed.profileId.toLowerCase()!==profileId.toLowerCase())return unavailable();
    if(requestId!==null){
      if(!("requestId"in parsed)||parsed.requestId.toLowerCase()!==requestId.toLowerCase()
        ||(req.method==="POST"&&parsed.state==="unconfirmed")||("action"in parsed&&action!==null&&parsed.action!==action))return unavailable();
      if(command&&parsed.state==="committed"){
        if(parsed.result.profileRevision.toLowerCase()!==command.profileRevision.toLowerCase())return unavailable();
        if(command.action==="offer"&&parsed.result.state==="managed"){
          const expected=command.payload as {firstCommissionBps:number;renewalCommissionBps:number;terms:string};
          if((["firstCommissionBps","renewalCommissionBps","terms"]as const).some(k=>parsed.result.state!=="managed"||parsed.result.agreement[k]!==expected[k]))return unavailable();
        }
      }
    }
    return res.status(200).json({success:true,data:parsed});
  }catch{return unavailable();}
}

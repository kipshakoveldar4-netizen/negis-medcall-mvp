import { useEffect,useLayoutEffect,useRef,useState } from "react";
import { Check,Clipboard,RefreshCw,Send,X } from "lucide-react";
import { parsePartnerTermsSnapshot,type PartnerTermsAction,type PartnerTermsSnapshot } from "../../../../../lib/crm/partner-terms-contracts";
import { partnerPercentToBps,type PartnerTermsAttempt,type PartnerTermsSide,type PartnerTermsWrite } from "../../lib/partnerTermsAttempt";
import { usePartnerTermsCommand } from "../../lib/usePartnerTermsCommand";
import "./partner-terms.css";

export type PartnerTermsRequest=(options:{method:"GET"|"POST";body?:unknown;requestId?:string;signal:AbortSignal;isCurrent:()=>boolean})=>Promise<unknown>;
type Props={actorId:string;profileId:string;side:PartnerTermsSide;isSessionCurrent:()=>boolean;request:PartnerTermsRequest;
  onAccessDenied:()=>void;approvedProfileRevision?:string|null;onRefreshProfile?:()=>void;onClose?:()=>void;onResolved?:()=>void;onReady?:()=>void};
const labels={offer:"Предложение условий",cancel:"Отзыв предложения",accept:"Принятие условий",decline:"Отказ от условий"};
const states={pending:"Ожидает решения",accepted:"Условия приняты",cancelled:"Предложение отозвано",declined:"Предложение отклонено"};
const emptyDraft=()=>({base:"",first:"",renewal:"",terms:"",accepted:false,closeAccepted:false});
const status=(e:unknown)=>e&&typeof e==="object"&&"status"in e?Number(e.status):0;
export function PartnerTerms({actorId,profileId,side,isSessionCurrent,request,onAccessDenied,approvedProfileRevision,onRefreshProfile,onClose,onResolved,onReady}:Props){
  const command=usePartnerTermsCommand(actorId,profileId,side,isSessionCurrent);
  const[view,setView]=useState<{snapshot:PartnerTermsSnapshot;lifetime:object;epoch:number}|null>(null),[revision,setRevision]=useState(0);
  const[draft,setDraft]=useState(emptyDraft),[error,setError]=useState(""),[message,setMessage]=useState(""),[busy,setBusy]=useState(false),[denied,setDenied]=useState(false);
  const[confirmation,setConfirmation]=useState<{action:"cancel"|"decline";view:NonNullable<typeof view>}|null>(null);
  const epoch=useRef(0),refusal=useRef(false),pending=useRef<{attempt:PartnerTermsAttempt;controller:AbortController}|null>(null);
  const latest=useRef({view,draft,confirmation});latest.current={view,draft,confirmation};
  const unknown=useRef<PartnerTermsAttempt|null>(null);
  const current=()=>!refusal.current&&command.isCurrent();
  function refresh(){if(!current())return;epoch.current++;setView(null);setConfirmation(null);unknown.current=null;
    setDraft(v=>({...v,accepted:false,closeAccepted:false}));setRevision(v=>v+1);}
  function refuse(){if(!current())return;refusal.current=true;command.expire();pending.current?.controller.abort();pending.current=null;
    setView(null);setDraft(emptyDraft());setConfirmation(null);setBusy(false);setDenied(true);setError("Доступ к партнёрству изменился.");onAccessDenied();}
  useLayoutEffect(()=>{refusal.current=false;epoch.current++;setView(null);setDraft(emptyDraft());setError("");setMessage("");setConfirmation(null);unknown.current=null;
    return()=>{epoch.current++;pending.current?.controller.abort();pending.current=null;};},[command.lifetime]);
  useEffect(()=>{
    if(!current())return;const controller=new AbortController(),started=epoch.current,lifetime=command.lifetime;
    const valid=()=>!controller.signal.aborted&&current()&&epoch.current===started&&command.lifetime===lifetime;
    void request({method:"GET",signal:controller.signal,isCurrent:valid}).then(value=>{
      if(!valid())return;const snapshot=parsePartnerTermsSnapshot(value);
      if(!snapshot||snapshot.profileId!==profileId)throw Error("Не удалось подтвердить условия партнёрства.");
      const base=snapshot.profileRevision+":"+(snapshot.agreement?.revision??"new");
      setDraft(v=>v.base===base?{...v,accepted:false,closeAccepted:false}:{...emptyDraft(),base});
      setView({snapshot,lifetime,epoch:started});if(!command.attempt)setError("");
    }).catch(e=>{if(!valid())return;setView(null);setDraft(emptyDraft());
      if([401,403,404].includes(status(e)))refuse();else setError(e instanceof Error?e.message:"Не удалось загрузить условия.");});
    return()=>controller.abort();
  },[revision,command.lifetime]);
  useEffect(()=>{const visible=()=>{if(document.visibilityState==="visible")refresh();};
    window.addEventListener("focus",refresh);document.addEventListener("visibilitychange",visible);
    return()=>{window.removeEventListener("focus",refresh);document.removeEventListener("visibilitychange",visible);};},[command.lifetime]);
  const activeView=current()&&view?.lifetime===command.lifetime&&view.epoch===epoch.current?view:null;
  useEffect(()=>{if(activeView&&current())onReady?.();},[view,onReady]);
  const snapshot=activeView?.snapshot??null,agreement=snapshot?.state==="managed"?snapshot.agreement:null;
  const btn=side==="platform"?"btn":"neu-btn",primary=side==="platform"?"btn btn-primary":"neu-btn neu-btn-primary";
  const sameView=(v:NonNullable<typeof view>)=>current()&&latest.current.view===v&&v.lifetime===command.lifetime&&v.epoch===epoch.current;
  async function send(attempt:PartnerTermsAttempt,mode:"write"|"read"|"close"){
    if(!current()||!command.isCurrent(attempt)||pending.current)return;
    const controller=new AbortController(),ticket={attempt,controller};pending.current=ticket;setBusy(true);setError("");setMessage("");
    const valid=()=>!controller.signal.aborted&&current()&&command.isCurrent(attempt)&&pending.current===ticket;
    try{
      const body=mode==="write"?command.payload(attempt):mode==="close"?{operation:"close",requestId:attempt.requestId,profileId,action:attempt.action}:undefined;
      if(mode==="write"&&body===null)throw Error("Исходное тело недоступно. Проверьте результат отправки.");
      const result=await request({method:mode==="read"?"GET":"POST",body,requestId:mode==="read"?attempt.requestId:undefined,signal:controller.signal,isCurrent:valid});
      if(!valid())return;const completed=command.complete(attempt,result);
      if(!completed){unknown.current=attempt;setMessage("Результат пока не подтверждён.");return;}
      unknown.current=null;setDraft(emptyDraft());setMessage(completed.state==="abandoned"?"Неподтверждённая отправка закрыта.":"Исходная отправка подтверждена.");
      refresh();onRefreshProfile?.();if(completed.state==="committed")onResolved?.();
    }catch(e){if(!valid())return;if([401,403,404].includes(status(e)))refuse();else{setError(e instanceof Error?e.message:"Результат не подтверждён.");refresh();}}
    finally{if(pending.current===ticket){pending.current=null;if(current())setBusy(false);}}
  }
  function write(value:PartnerTermsWrite,source:NonNullable<typeof view>){
    if(!sameView(source)||command.blocked||pending.current)return;
    try{const attempt=command.claim(value);if(attempt)void send(attempt,"write");}catch(e){if(current())setError(e instanceof Error?e.message:"Проверьте условия.");}
  }
  function propose(event:React.FormEvent){event.preventDefault();if(!activeView||!sameView(activeView)||latest.current.draft!==draft||approvedProfileRevision!==snapshot?.profileRevision)return;
    const firstCommissionBps=partnerPercentToBps(draft.first,"first"),renewalCommissionBps=partnerPercentToBps(draft.renewal,"renewal");
    if(firstCommissionBps===null||renewalCommissionBps===null||!draft.terms.trim()){setError("Укажите первую долю 10–50%, продления 5–10% и текст условий.");return;}
    write({profileId,profileRevision:snapshot!.profileRevision,revision:agreement?.revision??null,action:"offer",payload:{firstCommissionBps,renewalCommissionBps,terms:draft.terms}},activeView);
  }
  function accept(){if(!activeView||!agreement||!sameView(activeView)||latest.current.draft!==draft||!draft.accepted)return;
    write({profileId,profileRevision:activeView.snapshot.profileRevision,revision:agreement.revision,action:"accept",payload:{accepted:true}},activeView);}
  function confirm(){if(!confirmation||latest.current.confirmation!==confirmation||!sameView(confirmation.view))return;
    const s=confirmation.view.snapshot;if(s.state!=="managed")return;
    write({profileId,profileRevision:s.profileRevision,revision:s.agreement.revision,action:confirmation.action,payload:{}},confirmation.view);setConfirmation(null);}
  function closeAttempt(){const attempt=command.attempt;
    if(!attempt||unknown.current!==attempt||!draft.closeAccepted||latest.current.draft!==draft)return;void send(attempt,"close");}
  if(denied)return <section className="partner-terms" aria-label="Условия партнёрства"><p role="alert">Доступ к партнёрству изменился.</p></section>;
  if(!current())return <section className="partner-terms" aria-label="Условия партнёрства"><p role="status">Проверяем доступ…</p></section>;
  return <section className="partner-terms" aria-label="Условия партнёрства">
    <header><h3>Условия партнёрства</h3><div className="pt-actions"><button className={`${btn} pt-icon`} type="button" title="Обновить условия" aria-label="Обновить условия" disabled={busy} onClick={()=>{refresh();onRefreshProfile?.();}}><RefreshCw size={16}/></button>
      {onClose&&<button className={`${btn} pt-icon`} type="button" title="Закрыть условия партнёра" aria-label="Закрыть условия партнёра" onClick={()=>{if(current())onClose();}}><X size={16}/></button>}</div></header>
    {(error||command.error)&&<p role="alert" className="pt-error">{error||command.error}</p>}{message&&<p role="status">{message}</p>}
    {command.attempt&&<section className="pt-recovery" aria-label="Результат отправки условий"><h4>{labels[command.attempt.action]}</h4>
      <div className="pt-actions"><button type="button" className={btn} disabled={busy} onClick={()=>{const a=command.attempt;if(a)void send(a,"read");}}><RefreshCw size={15}/>Проверить результат</button>
        {command.canRetry&&<button type="button" className={btn} disabled={busy} onClick={()=>{const a=command.attempt;if(a)void send(a,"write");}}><Send size={15}/>Повторить исходную отправку</button>}</div>
      {unknown.current===command.attempt&&<><label className="pt-check"><input type="checkbox" checked={draft.closeAccepted} disabled={busy} onChange={e=>setDraft(v=>({...v,closeAccepted:e.target.checked}))}/><span>Закрыть неподтверждённую отправку. Уже сохранённое действие не отменяется.</span></label>
        <button type="button" className={btn} disabled={busy||!draft.closeAccepted} onClick={closeAttempt}><X size={15}/>Закрыть отправку</button></>}
    </section>}
    {!snapshot&&!error&&!command.error&&<p role="status">Загружаем условия…</p>}
    {snapshot?.state==="legacy_unmanaged"&&<p role="status">Коммерческий аккаунт создан ранее. Для изменения условий нужна отдельная сверка.</p>}
    {snapshot?.state==="not_offered"&&<p role="status">Предложение условий пока не получено.</p>}
    {agreement&&<><p className="pt-state">{states[agreement.state]}</p><dl className="pt-rates"><div><dt>Первая оплата</dt><dd>{(agreement.firstCommissionBps/100).toLocaleString("ru-RU")}%</dd></div><div><dt>Продления</dt><dd>{(agreement.renewalCommissionBps/100).toLocaleString("ru-RU")}%</dd></div></dl>
      <div className="pt-copy">{agreement.terms}</div>
      <p className="pt-date">Предложено {new Date(agreement.offeredAt).toLocaleString("ru-RU")}{agreement.decidedAt&&` · Решение ${new Date(agreement.decidedAt).toLocaleString("ru-RU")}`}</p>
      {agreement.state==="accepted"&&agreement.referralCode&&<div className="pt-code"><span>Партнёрский код</span><code>{agreement.referralCode}</code>
        <button type="button" className={`${btn} pt-icon`} title="Скопировать партнёрский код" aria-label="Скопировать партнёрский код" onClick={()=>{
          if(!activeView||!sameView(activeView))return;const value=agreement.referralCode!;
          void(async()=>{try{await navigator.clipboard.writeText(value);if(sameView(activeView))setMessage("Код скопирован.");}
            catch{if(sameView(activeView))setError("Не удалось скопировать код.");}})();
        }}><Clipboard size={16}/></button></div>}
      {agreement.commercialStatus==="suspended"&&<p role="status">Коммерческий доступ приостановлен.</p>}
    </>}
    {side==="partner"&&agreement?.state==="pending"&&activeView&&!command.blocked&&<div className="pt-decision">
      <label className="pt-check"><input type="checkbox" checked={draft.accepted} disabled={busy} onChange={e=>setDraft(v=>({...v,accepted:e.target.checked}))}/><span>Принимаю указанные проценты и текст условий этого предложения.</span></label>
      <div className="pt-actions"><button type="button" className={primary} disabled={busy||!draft.accepted} onClick={accept}><Check size={16}/>Принять условия</button>
        <button type="button" className={btn} disabled={busy} onClick={()=>{if(sameView(activeView))setConfirmation({action:"decline",view:activeView});}}>Отклонить</button></div>
    </div>}
    {side==="platform"&&agreement?.state==="pending"&&activeView&&!command.blocked&&<button type="button" className={btn} disabled={busy} onClick={()=>{if(sameView(activeView))setConfirmation({action:"cancel",view:activeView});}}><X size={16}/>Отозвать предложение</button>}
    {side==="platform"&&snapshot&&snapshot.state!=="legacy_unmanaged"&&(!agreement||["cancelled","declined"].includes(agreement.state))&&!command.blocked&&activeView&&
      (approvedProfileRevision===snapshot.profileRevision?<form className="pt-form" aria-label="Предложение партнёрских условий" onSubmit={propose}>
        <fieldset disabled={busy}><label><span>Первая оплата, %</span><input type="text" inputMode="decimal" autoComplete="off" value={draft.first} maxLength={5} required onChange={e=>setDraft(v=>({...v,first:e.target.value}))}/></label>
          <label><span>Продления, %</span><input type="text" inputMode="decimal" autoComplete="off" value={draft.renewal} maxLength={5} required onChange={e=>setDraft(v=>({...v,renewal:e.target.value}))}/></label>
          <label className="pt-wide"><span>Текст предложения</span><textarea rows={5} value={draft.terms} maxLength={2000} required onChange={e=>setDraft(v=>({...v,terms:e.target.value}))}/></label></fieldset>
        <button type="submit" className={primary} disabled={busy}><Send size={16}/>Предложить условия</button>
      </form>:<p role="status">Обновите заявку партнёра перед новым предложением.</p>)}
    {confirmation&&sameView(confirmation.view)&&<section className="pt-confirm" aria-label="Подтверждение решения по условиям"><p>{confirmation.action==="cancel"?"Отозвать это предложение?":"Отклонить это предложение?"}</p><div className="pt-actions">
      <button type="button" className={primary} disabled={busy} onClick={confirm}><Check size={16}/>Подтвердить</button><button type="button" className={btn} disabled={busy} onClick={()=>setConfirmation(null)}>Отмена</button></div></section>}
  </section>;
}

import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { operatorApi } from "@/lib/operatorApi";
import { parsePartnerLedger, type PartnerLedger as Ledger } from "../../../../../lib/crm/partner-contracts";
import { formatArrivalPrice } from "../../../../../lib/crm/operator-contracts";

function amount(value: string, currency: string) {
  return currency === "KZT" ? formatArrivalPrice(value,currency) : `${BigInt(value).toLocaleString("ru-RU")} ${currency} (мин. ед.)`;
}
export function PartnerLedger({ userId, isActorCurrent, onAccessDenied }: {
  userId: string; isActorCurrent: () => boolean; onAccessDenied: () => void;
}) {
  const [ledger,setLedger]=useState<Ledger|null>(null), [error,setError]=useState(""), [revision,setRevision]=useState(0);
  const mounted=useRef(false),generation=useRef(0);
  const current=()=>mounted.current&&isActorCurrent();
  const refresh=()=>{if(!current())return;generation.current++;setLedger(null);setError("");setRevision(n=>n+1);};
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;};},[]);
  useEffect(()=>{
    const controller=new AbortController(),epoch=generation.current;
    const valid=()=>!controller.signal.aborted&&current()&&generation.current===epoch;
    void operatorApi<unknown>("partner-ledger",undefined,"GET",controller.signal,userId,valid).then(value=>{
      if(!valid())return;
      const parsed=parsePartnerLedger(value);
      if(!parsed)throw Error("Не удалось подтвердить партнёрскую статистику.");
      setLedger(parsed);
    }).catch(err=>{
      if(!valid())return;
      setLedger(null);setError(err instanceof Error?err.message:"Не удалось загрузить статистику.");
      if(err&&typeof err==="object"&&"status" in err&&[401,403].includes(Number(err.status)))onAccessDenied();
    });
    return()=>controller.abort();
  },[userId,revision]);
  useEffect(()=>{
    const visible=()=>{if(document.visibilityState==="visible")refresh();};
    window.addEventListener("focus",refresh);document.addEventListener("visibilitychange",visible);
    return()=>{window.removeEventListener("focus",refresh);document.removeEventListener("visibilitychange",visible);};
  },[]);
  return <section aria-label="Партнёрская статистика" className="min-w-0 space-y-4 border-t pt-5">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Партнёрская статистика</h2><p className="mt-1 text-xs text-muted-foreground">За всё время</p></div><button type="button" className="neu-btn" title="Обновить статистику партнёра" aria-label="Обновить статистику партнёра" onClick={refresh}><RefreshCw size={16}/></button></header>
    {error&&<p role="alert" className="break-words text-sm">{error}</p>}
    {!ledger&&!error&&<p role="status">Загружаем статистику…</p>}
    {ledger?.state==="not_activated"&&<p role="status" className="text-sm text-muted-foreground">Партнёрский аккаунт ещё не активирован.</p>}
    {ledger?.state==="suspended"&&<p role="status" className="text-sm text-muted-foreground">Партнёрство приостановлено.</p>}
    {ledger?.state==="ready"&&<>
      <dl className="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">{[
        ["Привлечено компаний",ledger.registrations],["Оплатившие компании",ledger.paidCompanies],["Первые оплаты",ledger.firstPayments],["Продления",ledger.renewals],
      ].map(([title,value])=><div className="min-w-0" key={title}><dt className="text-sm text-muted-foreground">{title}</dt><dd className="mt-1 break-all text-xl font-semibold tabular-nums">{BigInt(value).toLocaleString("ru-RU")}</dd></div>)}</dl>
      <dl className="flex flex-wrap gap-x-8 gap-y-3 border-t pt-4">{[["Доля от первой оплаты",ledger.firstCommissionBps],["Доля от продления",ledger.renewalCommissionBps]].map(([title,value])=><div key={title} className="min-w-0"><dt className="text-sm text-muted-foreground">{title}</dt><dd className="mt-1 text-sm font-medium">{value===null?"Ставка не согласована":`${(Number(value)/100).toLocaleString("ru-RU")}%`}</dd></div>)}</dl>
      {ledger.balances.length===0?<p role="status" className="text-sm text-muted-foreground">Подтверждённых начислений и выплат пока нет.</p>:<div className="divide-y">{ledger.balances.map(b=><article key={b.currency} className="min-w-0 space-y-3 py-4"><h3 className="font-medium">{b.currency}</h3><dl className="grid gap-3 sm:grid-cols-3">{[["Начислено",b.earnedMinor],["Выплачено",b.paidMinor],["Доступно",b.availableMinor]].map(([title,value])=><div key={title} className="min-w-0"><dt className="text-sm text-muted-foreground">{title}</dt><dd className="mt-1 break-words text-base font-semibold tabular-nums [overflow-wrap:anywhere]">{amount(value,b.currency)}</dd></div>)}</dl></article>)}</div>}
      <p className="text-xs text-muted-foreground">Обновлено: {new Date(ledger.generatedAt).toLocaleString("ru-RU")}</p>
    </>}
  </section>;
}

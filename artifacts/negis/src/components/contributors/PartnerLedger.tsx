import { useEffect, useRef, useState } from "react";
import { Building2, CircleAlert, Coins, CreditCard, LoaderCircle, RefreshCw, Users, Wallet } from "lucide-react";
import { operatorApi } from "@/lib/operatorApi";
import { parsePartnerLedger, type PartnerLedger as Ledger } from "../../../../../lib/crm/partner-contracts";
import { formatArrivalPrice } from "../../../../../lib/crm/operator-contracts";
import "./PartnerLedger.css";

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
  return <section aria-label="Партнёрская статистика" className="partner-ledger" aria-busy={!ledger&&!error}>
    <header className="pl-header">
      <div><h2>Партнёрская статистика</h2><p>За всё время</p></div>
      <button type="button" className="pl-refresh" title="Обновить статистику партнёра" aria-label="Обновить статистику партнёра" onClick={refresh}><RefreshCw size={18} aria-hidden="true" /></button>
    </header>
    {error&&<p role="alert" className="pl-state pl-error"><CircleAlert size={20} aria-hidden="true" /><span>{error}</span></p>}
    {!ledger&&!error&&<p role="status" className="pl-state"><LoaderCircle size={20} className="pl-spinner" aria-hidden="true" /><span>Загружаем статистику…</span></p>}
    {ledger?.state==="not_activated"&&<p role="status" className="pl-state">Партнёрский аккаунт ещё не активирован.</p>}
    {ledger?.state==="suspended"&&<p role="status" className="pl-state">Партнёрство приостановлено.</p>}
    {ledger?.state==="ready"&&<>
      <dl className="pl-metrics">{([
        ["Привлечено компаний",ledger.registrations,Building2],
        ["Оплатившие компании",ledger.paidCompanies,Users],
        ["Первые оплаты",ledger.firstPayments,CreditCard],
        ["Продления",ledger.renewals,RefreshCw],
      ] as const).map(([title,value,Icon])=><div className="pl-metric" key={title}>
        <dt><Icon size={22} aria-hidden="true" /><span>{title}</span></dt>
        <dd>{BigInt(value).toLocaleString("ru-RU")}</dd>
      </div>)}</dl>
      <section className="pl-balances" aria-label="Подтверждённые начисления">
        <h3>Подтверждённые начисления</h3>
        {ledger.balances.length===0
          ? <p role="status" className="pl-empty">Подтверждённых начислений и выплат пока нет.</p>
          : ledger.balances.map(b=><article key={b.currency} className="pl-currency">
            <h4>{b.currency}</h4>
            <dl className="pl-balance-row">{([
              ["Начислено",b.earnedMinor,Wallet],
              ["Выплачено",b.paidMinor,CreditCard],
              ["Доступно",b.availableMinor,Coins],
            ] as const).map(([title,value,Icon])=><div key={title} className="pl-balance">
              <dt><Icon size={24} aria-hidden="true" /><span>{title}</span></dt>
              <dd>{amount(value,b.currency)}</dd>
            </div>)}</dl>
          </article>)}
      </section>
      <dl className="pl-rates">{[["Доля от первой оплаты",ledger.firstCommissionBps],["Доля от продления",ledger.renewalCommissionBps]].map(([title,value])=><div key={title}>
        <dt>{title}</dt><dd>{value===null?"Ставка не согласована":`${(Number(value)/100).toLocaleString("ru-RU")}%`}</dd>
      </div>)}</dl>
      <p className="pl-updated">Обновлено: <time dateTime={ledger.generatedAt}>{new Date(ledger.generatedAt).toLocaleString("ru-RU")}</time></p>
    </>}
  </section>;
}

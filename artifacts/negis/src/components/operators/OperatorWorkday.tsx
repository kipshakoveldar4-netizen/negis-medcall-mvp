import { useRef, useState } from "react";
import { Building2, ChevronLeft, ChevronRight, RefreshCw, Users } from "lucide-react";
import { useOperatorList } from "@/lib/operatorApi";
import { OperatorLeads } from "./OperatorLeads";
import { OPERATOR_PAGE_SIZE, operatorLeadScopeLabels, type OperatorRequest } from "../../../../../lib/crm/operator-contracts";
import "./OperatorWorkday.css";

export function OperatorWorkday({ actorId, isSessionCurrent, onAccessDenied, onCooperations }: {
  actorId: string;
  isSessionCurrent: () => boolean;
  onAccessDenied: () => void;
  onCooperations: () => void;
}) {
  const list = useOperatorList<OperatorRequest>("operator-inbox", true, onAccessDenied, { actorId, isSessionCurrent });
  const [selection, setSelection] = useState<string | null>(null);
  const accepted = list.data?.items.filter(item => item.status === "accepted") ?? [];
  const selected = accepted.find(item => item.id === selection) ?? accepted[0] ?? null;
  const live = useRef({ actorId, data: list.data, selected: selected?.id });
  if (live.current.actorId !== actorId || live.current.data !== list.data || live.current.selected !== selected?.id) {
    live.current = { actorId, data: list.data, selected: selected?.id };
  }
  const frame = live.current;
  const isCurrent = () => live.current === frame && isSessionCurrent();
  return <section className="operator-workday" aria-label="Рабочие заявки оператора">
    <header className="operator-workday__heading"><div><h2>Мои заявки</h2><p>Только подтверждённое сотрудничество</p></div>
      <button type="button" className="neu-btn" title="Обновить компании" aria-label="Обновить компании" onClick={list.refresh}><RefreshCw size={17}/></button>
    </header>
    {list.error && <p role="alert">{list.error}</p>}
    {!list.data && !list.error && <p role="status">Загружаем компании…</p>}
    {list.data && <>
      {selected ? <>
        <div className="operator-workday__scope"><Building2 size={20} aria-hidden="true"/>
          <label>Компания<select className="neu-input" value={selected.id} onChange={event => {
            if (isCurrent() && accepted.some(item => item.id === event.target.value)) setSelection(event.target.value);
          }}>{accepted.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
          <span className="portal-status">{operatorLeadScopeLabels[selected.leadScope || "assigned"]}</span>
        </div>
        <OperatorLeads key={selected.id} actorId={actorId} requestId={selected.id} leadScope={selected.leadScope || "assigned"}
          isSessionCurrent={isCurrent} onAccessDenied={onAccessDenied}/>
      </> : <div className="operator-workday__empty"><Users size={28} aria-hidden="true"/><h3>Пока нет подтверждённых компаний</h3>
        <button type="button" className="neu-btn" onClick={onCooperations}>Предложения о сотрудничестве</button></div>}
      {(list.offset > 0 || list.data.hasMore) && <nav className="operator-workday__pages" aria-label="Страницы компаний">
        <button type="button" className="neu-btn" disabled={list.offset === 0} onClick={list.previous}><ChevronLeft size={17}/>Назад</button>
        <span>Компании на странице {Math.floor(list.offset / OPERATOR_PAGE_SIZE) + 1}</span>
        <button type="button" className="neu-btn" disabled={!list.data.hasMore} onClick={list.next}>Далее<ChevronRight size={17}/></button>
      </nav>}
    </>}
  </section>;
}

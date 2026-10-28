import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  Banknote, CalendarX2, ChevronLeft, ChevronRight, CircleAlert, CircleCheck,
  CreditCard, LoaderCircle, RefreshCw,
} from "lucide-react";
import { operatorApi, OperatorApiError } from "@/lib/operatorApi";
import {
  PARTNER_HISTORY_PAGE_SIZE, parsePartnerHistory, partnerHistoryMonth,
  type PartnerHistoryItem, type PartnerHistoryPage,
} from "../../../../../lib/crm/partner-history-contracts";
import { formatArrivalPrice } from "../../../../../lib/crm/operator-contracts";
import "./PartnerHistory.css";

type HistoryScope = {
  userId: string;
  isActorCurrent: () => boolean;
  expired: boolean;
  denied: boolean;
};
type HistoryRequest = {
  scope: HistoryScope;
  offset: number;
  month: string | null;
  revision: number;
};
type HistoryResponse = {
  request: HistoryRequest;
  data: PartnerHistoryPage | null;
  error: string;
};

const MAX_OFFSET = 1_000_000;
const dateFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit", month: "short", year: "numeric", timeZone: "UTC",
});
const timeFormat = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC",
});
const kinds = {
  first_payment: { label: "Первая оплата", Icon: CreditCard },
  renewal: { label: "Продление", Icon: RefreshCw },
  payout: { label: "Выплата партнёру", Icon: Banknote },
} as const;

function scopeCurrent(scope: HistoryScope) {
  if (scope.expired) return false;
  if (!scope.userId || !scope.isActorCurrent()) {
    scope.expired = true;
    return false;
  }
  return true;
}

function historyAmount(item: PartnerHistoryItem) {
  return item.currency === "KZT"
    ? formatArrivalPrice(item.amountMinor, item.currency)
    : `${BigInt(item.amountMinor).toLocaleString("ru-RU")} ${item.currency} (мин. ед.)`;
}

function HistoryDate({ value }: { value: string }) {
  const date = new Date(value);
  return <time dateTime={value} title={value} className="ph-date">
    <span>{dateFormat.format(date)}</span>
    <span className="ph-time">{timeFormat.format(date)} UTC</span>
  </time>;
}

function HistoryKind({ kind }: { kind: PartnerHistoryItem["kind"] }) {
  const { label, Icon } = kinds[kind];
  return <span className={`ph-kind${kind === "payout" ? " ph-kind--payout" : ""}`}>
    <Icon size={16} aria-hidden="true" /><span>{label}</span>
  </span>;
}

function ConfirmedBadge() {
  return <span className="ph-confirmed"><CircleCheck size={14} aria-hidden="true" />Подтверждено</span>;
}

export function PartnerHistory({ userId, isActorCurrent, onAccessDenied }: {
  userId: string;
  isActorCurrent: () => boolean;
  onAccessDenied: () => void;
}) {
  const captionId = useId();
  const scope = useRef<HistoryScope>({ userId, isActorCurrent, expired: false, denied: false });
  if (scope.current.userId !== userId) {
    scope.current.expired = true;
    scope.current = { userId, isActorCurrent, expired: false, denied: false };
  }
  const renderedScope = scope.current;
  if (!isActorCurrent()) renderedScope.expired = true;

  const [request, setRequest] = useState<HistoryRequest>({
    scope: renderedScope, offset: 0, month: null, revision: 0,
  });
  const [response, setResponse] = useState<HistoryResponse | null>(null);
  const mounted = useRef(false);
  const active = useRef<{ request: HistoryRequest; controller: AbortController } | null>(null);
  const live = useRef({ request, response, scope: renderedScope, isActorCurrent, onAccessDenied });
  live.current = { request, response, scope: renderedScope, isActorCurrent, onAccessDenied };

  // A new actor lifetime never inherits a previous actor's page or result.
  if (request.scope !== renderedScope) {
    setRequest({ scope: renderedScope, offset: 0, month: null, revision: request.revision + 1 });
  }

  function current(original: HistoryRequest) {
    if (!mounted.current || original.scope !== renderedScope || live.current.request !== original || live.current.scope !== original.scope
      || !scopeCurrent(original.scope)) return false;
    if (!live.current.isActorCurrent()) {
      original.scope.expired = true;
      return false;
    }
    return true;
  }

  function replaceRequest(next: HistoryRequest) {
    active.current?.controller.abort();
    active.current = null;
    live.current.request = next;
    live.current.response = null;
    setResponse(null);
    setRequest(next);
  }

  function refresh(original: HistoryRequest, manual = false) {
    if (live.current.scope !== renderedScope) return;
    if (!current(original)) {
      if (!manual && live.current.request === original) {
        active.current?.controller.abort();
        setResponse(null);
      }
      return;
    }
    if (manual && live.current.response?.request !== original) return;
    replaceRequest({ ...original, revision: original.revision + 1 });
  }

  function selectMonth(original: HistoryRequest, month: string | null) {
    if (!current(original) || !partnerHistoryMonth(month) || original.month === month) return;
    replaceRequest({ ...original, month, offset: 0, revision: original.revision + 1 });
  }

  function movePage(original: HistoryRequest, direction: -1 | 1) {
    const result = live.current.response;
    if (!current(original) || result?.request !== original || result.data?.state !== "ready") return;
    if (direction === 1 && (!result.data.hasMore || original.offset > MAX_OFFSET - PARTNER_HISTORY_PAGE_SIZE)) return;
    const offset = Math.max(0, original.offset + direction * PARTNER_HISTORY_PAGE_SIZE);
    if (offset === original.offset) return;
    replaceRequest({ ...original, offset, revision: original.revision + 1 });
  }

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.controller.abort();
      active.current = null;
    };
  }, []);

  useEffect(() => {
    if (!current(request)) return;
    const controller = new AbortController();
    active.current = { request, controller };
    const valid = () => !controller.signal.aborted && active.current?.controller === controller && current(request);
    if (!valid()) return () => controller.abort();
    const query = new URLSearchParams({ offset: String(request.offset) });
    if (request.month !== null) query.set("month", request.month);
    void operatorApi<unknown>(
      `partner-history?${query}`, undefined, "GET", controller.signal, request.scope.userId, valid,
    ).then(value => {
      if (!valid()) return;
      const parsed = parsePartnerHistory(value, { offset: request.offset, month: request.month });
      if (!parsed) throw new Error("Не удалось подтвердить данные истории. Попробуйте обновить историю.");
      setResponse({ request, data: parsed, error: "" });
    }).catch(error => {
      if (!valid()) return;
      if (error instanceof OperatorApiError && (error.status === 401 || error.status === 403)) {
        request.scope.denied = true;
        request.scope.expired = true;
        controller.abort();
        setResponse({ request, data: null, error: "Доступ к истории изменился. Обновите профиль." });
        live.current.onAccessDenied();
        return;
      }
      setResponse({
        request, data: null,
        error: error instanceof Error ? error.message : "Не удалось загрузить историю. Попробуйте позже.",
      });
    });
    return () => {
      controller.abort();
      if (active.current?.controller === controller) active.current = null;
    };
  }, [request]);

  useEffect(() => {
    const revalidate = () => refresh(live.current.request);
    const visible = () => { if (document.visibilityState === "visible") revalidate(); };
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [renderedScope]);

  const available = request.scope === renderedScope && scopeCurrent(renderedScope);
  const result = available && response?.request === request ? response : null;
  const page = result?.data?.state === "ready" ? result.data : null;
  const pending = available && result === null;
  const error = !available
    ? renderedScope.denied ? "Доступ к истории изменился. Обновите профиль." : "История недоступна для текущего профиля."
    : result?.error ?? "";
  const emptyMessage = request.offset > 0
    ? "На этой странице нет подтверждённых записей."
    : request.month === null
      ? "Подтверждённых начислений и выплат пока нет."
      : "За выбранный месяц подтверждённых начислений и выплат пока нет.";
  const showPagination = available && result?.data?.state !== "not_activated" && result?.data?.state !== "suspended";

  return <section className="partner-history" aria-label="История начислений и выплат" aria-busy={pending}>
    <header className="ph-header">
      <div className="ph-heading">
        <h2>История начислений и выплат</h2>
        <p>{request.month === null ? "За всё время" : `За ${request.month}`}</p>
      </div>
      <div className="ph-controls">
        <label className="ph-month"><span>Месяц</span><input
          type="month" min="0001-01" max="9999-12" value={request.month ?? ""}
          aria-describedby={captionId} disabled={!available}
          onChange={event => selectMonth(request, event.target.value || null)}
        /></label>
        <button type="button" className="ph-icon-button" title="За всё время" aria-label="Показать историю за всё время"
          disabled={!available || request.month === null} onClick={() => selectMonth(request, null)}>
          <CalendarX2 size={18} aria-hidden="true" />
        </button>
        <button type="button" className="ph-icon-button" title="Обновить историю" aria-label="Обновить историю"
          disabled={!available || pending} onClick={() => refresh(request, true)}>
          <RefreshCw size={18} aria-hidden="true" />
        </button>
      </div>
    </header>
    <p id={captionId} className="ph-caption">Даты подтверждения и месяцы указаны в UTC.</p>
    {error && <p role="alert" className="ph-state ph-error"><CircleAlert size={20} aria-hidden="true" /><span>{error}</span></p>}
    {pending && <p role="status" className="ph-state"><LoaderCircle size={20} className="ph-spinner" aria-hidden="true" /><span>Загружаем историю…</span></p>}
    {result?.data?.state === "not_activated" && <p role="status" className="ph-state">Партнёрский аккаунт ещё не активирован.</p>}
    {result?.data?.state === "suspended" && <p role="status" className="ph-state">Партнёрство приостановлено. История недоступна.</p>}
    {page && <>
      {page.items.length === 0 ? <p role="status" className="ph-state">{emptyMessage}</p> : <>
        <div className="ph-table-wrap">
          <table className="ph-table" aria-label="Подтверждённые начисления и выплаты" aria-describedby={captionId}>
            <colgroup><col className="ph-column-date" /><col className="ph-column-kind" /><col className="ph-column-status" /><col className="ph-column-amount" /></colgroup>
            <thead><tr><th scope="col">Дата подтверждения</th><th scope="col">Основание</th><th scope="col">Статус</th><th scope="col" className="ph-amount">Сумма</th></tr></thead>
            <tbody>{page.items.map(item => <tr key={`${item.kind}:${item.id}`}>
              <td><HistoryDate value={item.occurredAt} /></td>
              <td><HistoryKind kind={item.kind} /></td>
              <td><ConfirmedBadge /></td>
              <td className={`ph-amount${item.kind === "payout" ? " ph-amount--payout" : ""}`}>{historyAmount(item)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <ul className="ph-cards" aria-label="Подтверждённые начисления и выплаты" aria-describedby={captionId}>
          {page.items.map(item => <li className="ph-card" key={`${item.kind}:${item.id}`}>
            <div className="ph-card-heading"><HistoryKind kind={item.kind} /><ConfirmedBadge /></div>
            <dl>
              <div><dt>Дата подтверждения</dt><dd><HistoryDate value={item.occurredAt} /></dd></div>
              <div className="ph-card-amount"><dt>Сумма</dt><dd className={item.kind === "payout" ? "ph-amount--payout" : undefined}>{historyAmount(item)}</dd></div>
            </dl>
          </li>)}
        </ul>
      </>}
    </>}
    {showPagination && <footer className="ph-footer">
      <p className="ph-page-summary" role="status">{page && page.items.length > 0
        ? `Записи ${request.offset + 1}–${request.offset + page.items.length}`
        : `Страница ${Math.floor(request.offset / PARTNER_HISTORY_PAGE_SIZE) + 1}`}</p>
      <nav className="ph-pagination" aria-label="Страницы истории">
        <button type="button" className="ph-icon-button" title="Предыдущая страница" aria-label="Предыдущая страница истории"
          disabled={pending || !page || request.offset === 0} onClick={() => movePage(request, -1)}><ChevronLeft size={18} aria-hidden="true" /></button>
        <button type="button" className="ph-icon-button" title="Следующая страница" aria-label="Следующая страница истории"
          disabled={pending || !page?.hasMore || request.offset > MAX_OFFSET - PARTNER_HISTORY_PAGE_SIZE} onClick={() => movePage(request, 1)}><ChevronRight size={18} aria-hidden="true" /></button>
      </nav>
      {page && <p className="ph-updated">Обновлено: <time dateTime={page.generatedAt}>{dateFormat.format(new Date(page.generatedAt))}, {timeFormat.format(new Date(page.generatedAt))} UTC</time></p>}
    </footer>}
  </section>;
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CalendarPlus, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  CircleAlert, LoaderCircle, RefreshCw, Save, Search,
} from "lucide-react";
import { operatorApi, OperatorApiError } from "@/lib/operatorApi";
import { OperatorBookingForm } from "./OperatorBookingForm";
import { formatArrivalPrice, operatorBookingStatusLabels, type OperatorBooking } from "../../../../../lib/crm/operator-contracts";
import {
  OPERATOR_LEAD_SEARCH_PAGE_SIZE, OPERATOR_LEAD_SEARCH_PATH, operatorLeadGroupLabels, operatorLeadGroups,
  parseOperatorLeadSearchBody, parseOperatorLeadSearchReport,
  type OperatorLeadSearchQuery, type OperatorLeadSearchReport,
  type OperatorSearchCompany, type OperatorSearchLead,
} from "../../../../../lib/crm/operator-lead-search-contracts";
import "./OperatorLeadExplorer.css";

type ExplorerProps = {
  actorId: string;
  isSessionCurrent: () => boolean;
  onAccessDenied: () => void;
};
type ExplorerScope = ExplorerProps & { expired: boolean; denied: boolean };
type SearchRequest = {
  scope: ExplorerScope;
  query: OperatorLeadSearchQuery;
  revision: number;
  onAccessDenied: () => void;
};
type SearchResponse = { request: SearchRequest; data: OperatorLeadSearchReport | null; error: string };
type LeadSelection = {
  request: SearchRequest;
  report: OperatorLeadSearchReport;
  item: OperatorSearchLead;
  company: OperatorSearchCompany;
};
type StageAttempt = { selection: LeadSelection; stageId: string };

const initialQuery = (): OperatorLeadSearchQuery => ({ search: "", group: "all", requestId: null, offset: 0 });
const MAX_OFFSET = 1_000_000;
const DENIED = "Доступ к заявкам изменился. Обновите профиль.";
const SEARCH_UNAVAILABLE = "Не удалось подтвердить данные заявок. Обновите список.";
const groups = ["all", ...operatorLeadGroups] as const;
const utcDate = new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", dateStyle: "short", timeStyle: "short" });
const countLabel = (value: string) => BigInt(value).toLocaleString("ru-RU");
const leadName = (item: OperatorSearchLead) => item.name.trim() || "Имя не указано";

function scopeCurrent(scope: ExplorerScope) {
  if (scope.expired) return false;
  if (!scope.actorId || !scope.isSessionCurrent()) {
    scope.expired = true;
    return false;
  }
  return true;
}

function CreatedAt({ value }: { value: string | null }) {
  return value === null ? <>Не указано</> : <time dateTime={value}>{utcDate.format(new Date(value))} UTC</time>;
}

export function OperatorLeadExplorer({ actorId, isSessionCurrent, onAccessDenied }: ExplorerProps) {
  const scope = useRef<ExplorerScope>({ actorId, isSessionCurrent, onAccessDenied, expired: false, denied: false });
  if (scope.current.actorId !== actorId) {
    scope.current.expired = true;
    scope.current = { actorId, isSessionCurrent, onAccessDenied, expired: false, denied: false };
  }
  const renderedScope = scope.current;
  if (!isSessionCurrent()) renderedScope.expired = true;

  const [request, setRequest] = useState<SearchRequest>({ scope: renderedScope, query: initialQuery(), revision: 0, onAccessDenied });
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [draft, setDraft] = useState("");
  const [selection, setSelection] = useState<LeadSelection | null>(null);
  const [stageAttempt, setStageAttempt] = useState<StageAttempt | null>(null);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const mounted = useRef(false);
  const active = useRef<{ request: SearchRequest; controller: AbortController } | null>(null);
  const selected = useRef<LeadSelection | null>(null);
  // A query change or read refresh cannot release an unsettled stage send.
  const pendingStage = useRef<StageAttempt | null>(null);
  const live = useRef({ scope: renderedScope, request, response, isSessionCurrent });
  live.current = { scope: renderedScope, request, response, isSessionCurrent };

  if (request.scope !== renderedScope) {
    selected.current = null;
    pendingStage.current = null;
    setRequest({ scope: renderedScope, query: initialQuery(), revision: request.revision + 1, onAccessDenied });
    setResponse(null);
    setDraft("");
    setSelection(null);
    setStageAttempt(null);
    setNotice("");
    setActionError("");
  }

  function lifetimeCurrent(original: ExplorerScope) {
    if (!mounted.current || scope.current !== original || live.current.scope !== original || !scopeCurrent(original)) return false;
    if (!live.current.isSessionCurrent()) {
      original.expired = true;
      return false;
    }
    return true;
  }

  function requestCurrent(original: SearchRequest) {
    return lifetimeCurrent(original.scope) && live.current.request === original;
  }

  function reportCurrent(original: SearchRequest, report: OperatorLeadSearchReport) {
    return requestCurrent(original) && live.current.response?.request === original && live.current.response.data === report;
  }

  function selectionCurrent(original: LeadSelection) {
    return selected.current === original && reportCurrent(original.request, original.report)
      && original.report.items.includes(original.item) && original.report.companies.includes(original.company)
      && original.item.requestId === original.company.requestId;
  }

  function clearResponse() {
    active.current?.controller.abort();
    active.current = null;
    selected.current = null;
    live.current.response = null;
    setResponse(null);
    setSelection(null);
  }

  function replaceRequest(original: SearchRequest, query: OperatorLeadSearchQuery) {
    if (!requestCurrent(original)) return;
    clearResponse();
    const next = { ...original, query, revision: original.revision + 1, onAccessDenied };
    live.current.request = next;
    setRequest(next);
    setNotice("");
    setActionError("");
  }

  function refresh(original: SearchRequest, report?: OperatorLeadSearchReport) {
    if (report && !reportCurrent(original, report)) return;
    replaceRequest(original, { ...original.query });
  }

  function deny(original: SearchRequest) {
    if (!requestCurrent(original)) return;
    original.scope.denied = true;
    original.scope.expired = true;
    clearResponse();
    setDraft("");
    setNotice("");
    setActionError("");
    const next = { ...live.current.request, query: initialQuery() };
    live.current.request = next;
    setRequest(next);
    original.onAccessDenied();
  }

  function movePage(original: SearchRequest, report: OperatorLeadSearchReport, direction: -1 | 1) {
    if (!reportCurrent(original, report)) return;
    if (direction === 1 && (!report.hasMore || original.query.offset > MAX_OFFSET - OPERATOR_LEAD_SEARCH_PAGE_SIZE)) return;
    const offset = Math.max(0, original.query.offset + direction * OPERATOR_LEAD_SEARCH_PAGE_SIZE);
    if (offset !== original.query.offset) replaceRequest(original, { ...original.query, offset });
  }

  function changeGroup(original: SearchRequest, report: OperatorLeadSearchReport, group: OperatorLeadSearchQuery["group"]) {
    if (reportCurrent(original, report) && group !== original.query.group) {
      replaceRequest(original, { ...original.query, group, offset: 0 });
    }
  }

  async function changeStage(original: LeadSelection, stageId: string) {
    if (!selectionCurrent(original) || pendingStage.current) return;
    const stages = original.report.stageOptions.find(option => option.requestId === original.item.requestId)?.items;
    if (stageId === original.item.stageId || !stages?.some(stage => stage.id === stageId)) return;
    const attempt: StageAttempt = { selection: original, stageId };
    pendingStage.current = attempt;
    setStageAttempt(attempt);
    setNotice("");
    setActionError("");
    const canDispatch = () => pendingStage.current === attempt && selectionCurrent(original);
    try {
      await operatorApi(
        `operator-leads?requestId=${encodeURIComponent(original.item.requestId)}`,
        { leadId: original.item.id, stageId, expectedStageId: original.item.stageId, expectedStatus: original.item.status },
        "PATCH", undefined, original.request.scope.actorId, canDispatch,
      );
      if (!selectionCurrent(original)) return;
      replaceRequest(original.request, { ...original.request.query, offset: 0 });
      setNotice("Стадия заявки сохранена.");
    } catch (error) {
      if (error instanceof OperatorApiError && (error.status === 401 || error.status === 403)) {
        deny(original.request);
        return;
      }
      if (!selectionCurrent(original)) return;
      replaceRequest(original.request, { ...original.request.query, offset: 0 });
      const uncertain = !(error instanceof OperatorApiError) || error.status >= 500 || error.status === 0;
      setActionError(uncertain
        ? "Сохранение стадии не подтверждено. Данные запрошены заново; повторная отправка не выполнялась."
        : error instanceof Error ? error.message : "Не удалось сохранить стадию.");
    } finally {
      if (pendingStage.current === attempt) {
        pendingStage.current = null;
        if (lifetimeCurrent(original.request.scope)) setStageAttempt(null);
      }
    }
  }

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.controller.abort();
      active.current = null;
      selected.current = null;
    };
  }, []);

  useEffect(() => {
    if (!requestCurrent(request)) return;
    const controller = new AbortController();
    active.current = { request, controller };
    const valid = () => !controller.signal.aborted && active.current?.controller === controller && requestCurrent(request);
    void operatorApi<unknown>(
      OPERATOR_LEAD_SEARCH_PATH, request.query, "POST", controller.signal, request.scope.actorId, valid,
    ).then(value => {
      if (!valid()) return;
      const report = parseOperatorLeadSearchReport(value, request.query);
      if (!report) throw new Error(SEARCH_UNAVAILABLE);
      if (!valid()) return;
      const next = { request, data: report, error: "" };
      live.current.response = next;
      setResponse(next);
    }).catch(error => {
      if (!valid()) return;
      if (error instanceof OperatorApiError && (error.status === 401 || error.status === 403)) {
        deny(request);
        return;
      }
      const next = { request, data: null, error: SEARCH_UNAVAILABLE };
      live.current.response = next;
      setResponse(next);
    });
    return () => {
      controller.abort();
      if (active.current?.controller === controller) active.current = null;
    };
  }, [request]);

  useEffect(() => {
    const revalidate = () => refresh(request);
    const visible = () => { if (document.visibilityState === "visible") revalidate(); };
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [request]);

  const available = request.scope === renderedScope && scopeCurrent(renderedScope) && isSessionCurrent();
  const result = available && response?.request === request ? response : null;
  const report = result?.data ?? null;
  const loading = available && result === null;
  const error = !available ? renderedScope.denied ? DENIED : "Заявки недоступны для текущего профиля." : result?.error ?? "";
  const busy = available && stageAttempt !== null && pendingStage.current === stageAttempt && stageAttempt.selection.request.scope === renderedScope;
  const expanded = selection && selected.current === selection && selection.request === request && selection.report === report ? selection : null;
  const companies = new Map(report?.companies.map(company => [company.requestId, company]));
  const bookingCurrent = useCallback(() => selection !== null && selectionCurrent(selection) && pendingStage.current === null, [selection]);
  const bookingDenied = useCallback(() => {
    if (selection && selectionCurrent(selection)) deny(selection.request);
  }, [selection]);
  const booked = useCallback((booking: OperatorBooking) => {
    if (!booking || !selection || !selectionCurrent(selection) || pendingStage.current) return;
    const when = booking.startsAt === null ? "Время не указано" : new Intl.DateTimeFormat("ru-RU", {
      timeZone: booking.timeZone, dateStyle: "short", timeStyle: "short",
    }).format(new Date(booking.startsAt));
    const requiresReview = booking.startsAt === null || !booking.doctorName?.trim() || !booking.service?.trim()
      || booking.priceMinor === null || booking.durationMinutes === null || booking.status === null;
    const result = booking.status === "cancelled" ? "Запись отменена" : booking.status === "no_show" ? "Пациент не пришёл"
      : requiresReview ? "Запись требует проверки" : "Запись сохранена";
    const status = booking.status === null ? "Статус не указан" : operatorBookingStatusLabels[booking.status];
    replaceRequest(selection.request, { ...selection.request.query, offset: 0 });
    setNotice(`${result}: ${when}, ${booking.doctorName?.trim() || "Специалист не указан"}. ${booking.service?.trim() || "Услуга не указана"}. ${formatArrivalPrice(booking.priceMinor, "KZT")}. ${status}.`);
  }, [selection]);

  return <section className="operator-lead-explorer" aria-label="Заявки оператора" aria-busy={loading}>
    <header className="operator-lead-explorer__heading">
      <h3>Мои заявки</h3>
      <button type="button" className="operator-lead-explorer__icon-button" title="Обновить заявки" aria-label="Обновить заявки"
        disabled={!available} onClick={() => refresh(request, report ?? undefined)}><RefreshCw size={18} aria-hidden="true" /></button>
    </header>
    <form className="operator-lead-explorer__toolbar" onSubmit={event => {
      event.preventDefault();
      if (!requestCurrent(request)) return;
      const query = parseOperatorLeadSearchBody({ ...request.query, search: draft, offset: 0 });
      if (!query) return;
      setDraft(query.search);
      replaceRequest(request, query);
    }}>
      <div className="operator-lead-explorer__search">
        <input type="search" aria-label="Поиск заявок" placeholder="Имя, телефон, компания" maxLength={120} value={available ? draft : ""}
          disabled={!available} onChange={event => { if (requestCurrent(request)) setDraft(event.target.value); }} />
        <button type="submit" className="operator-lead-explorer__icon-button" aria-label="Найти заявки" title="Найти заявки" disabled={!available}>
          <Search size={18} aria-hidden="true" />
        </button>
      </div>
      <label className="operator-lead-explorer__company">Компания
        <select aria-label="Компания заявок" value={available ? request.query.requestId ?? "" : ""} disabled={!report} onChange={event => {
          if (!report || !reportCurrent(request, report)) return;
          const requestId = event.target.value || null;
          if (requestId !== null && !report.companies.some(company => company.requestId === requestId)) return;
          if (requestId !== request.query.requestId) replaceRequest(request, { ...request.query, requestId, offset: 0 });
        }}>
          <option value="">Все компании</option>
          {report?.companies.map(company => <option key={company.requestId} value={company.requestId}>{company.displayName}</option>)}
        </select>
      </label>
    </form>
    <label className="operator-lead-explorer__group-select">Статус
      <select aria-label="Группа заявок" value={available ? request.query.group : "all"} disabled={!report} onChange={event => {
        const group = groups.find(group => group === event.target.value);
        if (report && group !== undefined) changeGroup(request, report, group);
      }}>
        {groups.map(group => <option key={group} value={group}>{operatorLeadGroupLabels[group]}: {report ? countLabel(report.totals[group]) : "-"}</option>)}
      </select>
    </label>
    <div className="operator-lead-explorer__groups" role="group" aria-label="Группы заявок">
      {groups.map(group => <button type="button" key={group} data-lead-group={group} aria-pressed={available && request.query.group === group}
        disabled={!report} onClick={() => {
          if (report) changeGroup(request, report, group);
        }}><span>{operatorLeadGroupLabels[group]}</span><span className="operator-lead-explorer__count">{report ? countLabel(report.totals[group]) : "-"}</span></button>)}
    </div>
    {(error || actionError) && <p role="alert" className="operator-lead-explorer__state operator-lead-explorer__error"><CircleAlert size={18} aria-hidden="true" /><span>{error || actionError}</span></p>}
    {notice && available && <p role="status" className="operator-lead-explorer__notice">{notice}</p>}
    {busy && <p role="status" className="operator-lead-explorer__notice"><LoaderCircle size={16} className="operator-lead-explorer__spinner" aria-hidden="true" />Сохраняем стадию...</p>}
    {loading && <p role="status" className="operator-lead-explorer__state"><LoaderCircle size={20} className="operator-lead-explorer__spinner" aria-hidden="true" />Загружаем заявки...</p>}
    {report && <>
      <div className="operator-lead-explorer__columns" aria-hidden="true"><span>Пациент</span><span>Компания</span><span>Стадия</span><span>Создана, UTC</span><span /></div>
      <ol className="operator-lead-explorer__list">
        {report.items.map(item => {
          const company = companies.get(item.requestId)!;
          const open = expanded?.item === item;
          return <li key={`${item.requestId}:${item.id}`} data-lead-id={item.id} className="operator-lead-explorer__item">
            <div className="operator-lead-explorer__row">
              <div className="operator-lead-explorer__contact"><strong>{leadName(item)}</strong><span>{item.phone.trim() || "Телефон не указан"}</span></div>
              <p className="operator-lead-explorer__row-company">{company.displayName}</p>
              <div className="operator-lead-explorer__row-stage"><span className={`operator-lead-explorer__badge operator-lead-explorer__badge--${item.group}`}>{operatorLeadGroupLabels[item.group]}</span><span>{item.stageName || item.status || "Не указана"}</span></div>
              <p className="operator-lead-explorer__created"><CreatedAt value={item.createdAt} /></p>
              <button type="button" className="operator-lead-explorer__icon-button" aria-label={`Открыть заявку: ${leadName(item)}`} title={open ? "Закрыть заявку" : "Открыть заявку"}
                aria-expanded={open} aria-controls={`operator-lead-details-${item.id}`} onClick={() => {
                  if (!reportCurrent(request, report)) return;
                  const next = open ? null : { request, report, item, company };
                  selected.current = next;
                  setSelection(next);
                }}>{open ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}</button>
            </div>
            {open && expanded && <LeadDetails key={`${request.revision}:${item.requestId}:${item.id}`} selection={expanded} busy={busy}
              isCurrent={bookingCurrent} onAccessDenied={bookingDenied} onBooked={booked}
              onStageChange={stageId => { if (selectionCurrent(expanded)) void changeStage(expanded, stageId); }} />}
          </li>;
        })}
      </ol>
      {report.items.length === 0 && <p role="status" className="operator-lead-explorer__state">{report.companies.length === 0 ? "Нет доступных компаний." : "Заявки не найдены."}</p>}
      <footer className="operator-lead-explorer__footer">
        <p role="status">{report.items.length > 0
          ? `Заявки ${request.query.offset + 1}-${request.query.offset + report.items.length} из ${countLabel(report.matched)}`
          : `Найдено: ${countLabel(report.matched)}`}</p>
        <nav aria-label="Страницы заявок" className="operator-lead-explorer__pages">
          <button type="button" className="operator-lead-explorer__icon-button" aria-label="Предыдущая страница заявок" title="Предыдущая страница"
            disabled={request.query.offset === 0} onClick={() => movePage(request, report, -1)}><ChevronLeft size={18} aria-hidden="true" /></button>
          <button type="button" className="operator-lead-explorer__icon-button" aria-label="Следующая страница заявок" title="Следующая страница"
            disabled={!report.hasMore || request.query.offset > MAX_OFFSET - OPERATOR_LEAD_SEARCH_PAGE_SIZE} onClick={() => movePage(request, report, 1)}><ChevronRight size={18} aria-hidden="true" /></button>
        </nav>
      </footer>
    </>}
  </section>;
}

function LeadDetails({ selection, busy, isCurrent, onAccessDenied, onBooked, onStageChange }: {
  selection: LeadSelection;
  busy: boolean;
  isCurrent: () => boolean;
  onAccessDenied: () => void;
  onBooked: (booking: OperatorBooking) => void;
  onStageChange: (stageId: string) => void;
}) {
  const { item, report, company, request } = selection;
  const [stageId, setStageId] = useState(item.stageId ?? "");
  const [booking, setBooking] = useState<object | null>(null);
  const bookingScope = useRef<object | null>(null);
  const bookingOpen = booking !== null;
  const stages = report.stageOptions.find(option => option.requestId === item.requestId)?.items ?? [];
  const knownStage = stages.some(stage => stage.id === stageId);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      bookingScope.current = null;
    };
  }, []);
  const current = useCallback(() => mounted.current && isCurrent(), [isCurrent]);
  const bookingSessionCurrent = useCallback(() => booking !== null && bookingScope.current === booking && current(), [booking, current]);
  const denied = useCallback(() => { if (bookingSessionCurrent()) onAccessDenied(); }, [bookingSessionCurrent, onAccessDenied]);
  const booked = useCallback((value: OperatorBooking) => { if (bookingSessionCurrent()) onBooked(value); }, [bookingSessionCurrent, onBooked]);

  return <section id={`operator-lead-details-${item.id}`} className="operator-lead-explorer__details" aria-label={`Заявка: ${leadName(item)}`}>
    <dl className="operator-lead-explorer__fields">
      <div><dt>Имя</dt><dd>{leadName(item)}</dd></div>
      <div><dt>Телефон</dt><dd>{item.phone.trim() || "Не указан"}</dd></div>
      <div><dt>Компания</dt><dd>{company.displayName}</dd></div>
      <div><dt>Текущая стадия</dt><dd>{item.stageName || "Не указана"}</dd></div>
      <div><dt>Текущий статус</dt><dd>{item.status || "Не указан"}</dd></div>
      <div><dt>Создана, UTC</dt><dd><CreatedAt value={item.createdAt} /></dd></div>
      {item.source && <div><dt>Источник</dt><dd>{item.source}</dd></div>}
    </dl>
    <div className="operator-lead-explorer__actions">
      {stages.length > 0 && <form className="operator-lead-explorer__stage-editor" onSubmit={event => {
        event.preventDefault();
        if (current() && !busy && !bookingOpen && knownStage && stageId !== item.stageId) onStageChange(stageId);
      }}>
        <label>Стадия заявки<select aria-label={`Стадия заявки: ${leadName(item)}`} value={stageId} disabled={busy || bookingOpen}
          onChange={event => { if (current() && !busy && !bookingOpen) setStageId(event.target.value); }}>
          {!stages.some(stage => stage.id === item.stageId) && <option value={item.stageId ?? ""}>{item.stageName || item.status || "Выберите стадию"}</option>}
          {stages.map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
        </select></label>
        <button type="submit" className="operator-lead-explorer__icon-button" title="Сохранить стадию" aria-label={`Сохранить стадию: ${leadName(item)}`}
          disabled={busy || bookingOpen || !knownStage || stageId === item.stageId}><Save size={18} aria-hidden="true" /></button>
      </form>}
      <button type="button" className="operator-lead-explorer__booking-button" disabled={busy} aria-expanded={bookingOpen}
        onClick={() => {
          if (!current() || busy || bookingScope.current !== booking) return;
          const next = bookingOpen ? null : {};
          bookingScope.current = next;
          setBooking(next);
        }}><CalendarPlus size={17} aria-hidden="true" />{bookingOpen ? "Закрыть запись" : "Записать пациента"}</button>
    </div>
    {bookingOpen && !busy && <OperatorBookingForm actorId={request.scope.actorId} requestId={item.requestId} leadId={item.id}
      isSessionCurrent={bookingSessionCurrent} onAccessDenied={denied} onBooked={booked} />}
  </section>;
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CalendarCheck2, CalendarClock, ChevronLeft, ChevronRight,
  CircleAlert, CircleCheck, ClipboardList, LoaderCircle, Phone,
  RefreshCw, UserCheck,
} from "lucide-react";
import { operatorApi, OperatorApiError } from "@/lib/operatorApi";
import { OperatorLeadExplorer } from "./OperatorLeadExplorer";
import {
  operatorArrivalCheckLabels, operatorBookingStatusLabels,
} from "../../../../../lib/crm/operator-contracts";
import {
  OPERATOR_WORKDAY_PAGE_SIZE, parseOperatorWorkday,
  type OperatorWorkdayCompany, type OperatorWorkdayReport, type OperatorWorkdayVisit,
} from "../../../../../lib/crm/operator-workday-contracts";
import "./OperatorWorkday.css";

type WorkdayScope = {
  actorId: string;
  isSessionCurrent: () => boolean;
  expired: boolean;
  denied: boolean;
};
type WorkdayRequest = { scope: WorkdayScope; offset: number; revision: number };
type WorkdayResponse = { request: WorkdayRequest; data: OperatorWorkdayReport | null; error: string };

const MAX_OFFSET = 1_000_000;
const localDateFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
});

function scopeCurrent(scope: WorkdayScope) {
  if (scope.expired) return false;
  if (!scope.actorId || !scope.isSessionCurrent()) {
    scope.expired = true;
    return false;
  }
  return true;
}

function countLabel(value: string) {
  return BigInt(value).toLocaleString("ru-RU");
}

function CompanyDate({ company }: { company: OperatorWorkdayCompany }) {
  return company.localDate && company.timeZone
    ? <><time dateTime={company.localDate}>{localDateFormat.format(new Date(`${company.localDate}T00:00:00Z`))}</time><span>{company.timeZone}</span></>
    : <span>Часовой пояс не подтверждён</span>;
}

function Visit({ item, company }: { item: OperatorWorkdayVisit; company: OperatorWorkdayCompany }) {
  if (!company.timeZone || !company.localDate) return null;
  const time = new Intl.DateTimeFormat("ru-RU", {
    timeZone: company.timeZone, hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const confirmation = item.clinicConfirmedAt && new Intl.DateTimeFormat("ru-RU", {
    timeZone: company.timeZone, dateStyle: "short", timeStyle: "short",
  }).format(new Date(item.clinicConfirmedAt));
  return <li className="operator-workday__visit">
    <div className="operator-workday__visit-heading">
      <p className="operator-workday__visit-time"><CalendarClock size={17} aria-hidden="true" />
        <time dateTime={item.startsAt}>{time.format(new Date(item.startsAt))}</time>
      </p>
      <span className={`operator-workday__status operator-workday__status--${item.status}`}
        aria-label={`Текущий статус: ${item.status === "unknown" ? "Неизвестен" : operatorBookingStatusLabels[item.status]}`}>
        {item.status === "unknown" ? "Неизвестен" : operatorBookingStatusLabels[item.status]}
      </span>
    </div>
    <p className="operator-workday__client">{item.clientName.trim() || "Имя не указано"}</p>
    <p className="operator-workday__phone"><Phone size={14} aria-hidden="true" />{item.clientPhone.trim() || "Телефон не указан"}</p>
    <p className="operator-workday__company-name">{company.displayName}</p>
    <p className="operator-workday__local-date"><CompanyDate company={company} /></p>
    <p className={confirmation ? "operator-workday__confirmation" : "operator-workday__caption"}>
      {confirmation && <CircleCheck size={14} aria-hidden="true" />}{confirmation ? "Приход подтверждён клиникой" : "Приход не подтверждён"}
    </p>
    <details className="operator-workday__visit-more"><summary>Подробности записи</summary><dl className="operator-workday__visit-details">
      <div><dt>Услуга</dt><dd>{item.service.trim() || "Не указана"}</dd></div>
      <div><dt>Специалист</dt><dd>{item.doctorName.trim() || "Не указан"}</dd></div>
      <div><dt>Подтверждение клиники</dt><dd className={confirmation ? "operator-workday__confirmation" : undefined}>
        {confirmation ? <><CircleCheck size={14} aria-hidden="true" /><span>Приход подтверждён<time dateTime={item.clinicConfirmedAt!}>{confirmation}</time></span></> : "Приход не подтверждён"}
      </dd></div>
      {item.operatorCheckResult && <div><dt>Проверка оператора</dt><dd>{operatorArrivalCheckLabels[item.operatorCheckResult]}</dd></div>}
    </dl></details>
  </li>;
}

export function OperatorWorkday({ actorId, isSessionCurrent, onAccessDenied }: {
  actorId: string;
  isSessionCurrent: () => boolean;
  onAccessDenied: () => void;
  onCooperations: () => void;
}) {
  const scope = useRef<WorkdayScope>({ actorId, isSessionCurrent, expired: false, denied: false });
  if (scope.current.actorId !== actorId) {
    scope.current.expired = true;
    scope.current = { actorId, isSessionCurrent, expired: false, denied: false };
  }
  const renderedScope = scope.current;
  if (!isSessionCurrent()) renderedScope.expired = true;

  const [request, setRequest] = useState<WorkdayRequest>({ scope: renderedScope, offset: 0, revision: 0 });
  const [response, setResponse] = useState<WorkdayResponse | null>(null);
  const mounted = useRef(false);
  const unmounted = useRef(false);
  const active = useRef<{ request: WorkdayRequest; controller: AbortController } | null>(null);
  const live = useRef({ request, response, scope: renderedScope, isSessionCurrent, onAccessDenied });
  live.current = { request, response, scope: renderedScope, isSessionCurrent, onAccessDenied };

  // Returning to the same actor later must not revive an earlier lifetime.
  if (request.scope !== renderedScope) {
    setRequest({ scope: renderedScope, offset: 0, revision: request.revision + 1 });
    setResponse(null);
  }

  function current(original: WorkdayRequest) {
    if (!mounted.current || original.scope !== renderedScope || live.current.scope !== original.scope
      || live.current.request !== original || !scopeCurrent(original.scope)) return false;
    if (!live.current.isSessionCurrent()) {
      original.scope.expired = true;
      return false;
    }
    return true;
  }

  function clearResponse() {
    active.current?.controller.abort();
    active.current = null;
    live.current.response = null;
    setResponse(null);
  }

  function replaceRequest(next: WorkdayRequest) {
    clearResponse();
    live.current.request = next;
    setRequest(next);
  }

  function refresh(original: WorkdayRequest, manual = false) {
    if (live.current.scope !== renderedScope) return;
    if (!current(original)) {
      if (!manual && live.current.request === original) clearResponse();
      return;
    }
    if (manual && live.current.response?.request !== original) return;
    replaceRequest({ ...original, revision: original.revision + 1 });
  }

  function movePage(original: WorkdayRequest, direction: -1 | 1) {
    const result = live.current.response;
    if (!current(original) || result?.request !== original || result.data?.today.state !== "ready") return;
    if (direction === 1 && (!result.data.today.hasMore || original.offset > MAX_OFFSET - OPERATOR_WORKDAY_PAGE_SIZE)) return;
    const offset = Math.max(0, original.offset + direction * OPERATOR_WORKDAY_PAGE_SIZE);
    if (offset !== original.offset) replaceRequest({ ...original, offset, revision: original.revision + 1 });
  }

  function deny(original: WorkdayRequest) {
    if (!current(original)) return;
    original.scope.denied = true;
    original.scope.expired = true;
    clearResponse();
    setResponse({ request: original, data: null, error: "Доступ к рабочему дню изменился. Обновите профиль." });
    live.current.onAccessDenied();
  }

  useLayoutEffect(() => {
    mounted.current = true;
    unmounted.current = false;
    return () => {
      mounted.current = false;
      unmounted.current = true;
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
    void operatorApi<unknown>(
      `operator-workday?offset=${request.offset}`, undefined, "GET", controller.signal, request.scope.actorId, valid,
    ).then(value => {
      if (!valid()) return;
      const parsed = parseOperatorWorkday(value, request.offset);
      if (!parsed) throw new Error("Не удалось подтвердить данные рабочего дня. Попробуйте обновить сводку.");
      setResponse({ request, data: parsed, error: "" });
    }).catch(error => {
      if (!valid()) return;
      if (error instanceof OperatorApiError && (error.status === 401 || error.status === 403)) {
        deny(request);
        return;
      }
      setResponse({ request, data: null, error: error instanceof Error ? error.message : "Не удалось загрузить рабочий день." });
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
  const report = result?.data ?? null;
  const pending = available && result === null;
  const error = !available
    ? renderedScope.denied ? "Доступ к рабочему дню изменился. Обновите профиль." : "Рабочий день недоступен для текущего профиля."
    : result?.error ?? "";
  const companies = new Map(report?.companies.map(company => [company.requestId, company]));
  const today = report?.today;

  return <section className="operator-workday" aria-label="Рабочие заявки оператора" aria-busy={pending}>
    <header className="operator-workday__heading">
      <div><h2>Мой рабочий день</h2><p>Подтверждённое сотрудничество</p></div>
      <button type="button" className="operator-workday__icon-button" title="Обновить рабочий день" aria-label="Обновить рабочий день"
        disabled={!available || pending} onClick={() => refresh(request, true)}><RefreshCw size={18} aria-hidden="true" /></button>
    </header>
    {error && <p className="operator-workday__state operator-workday__error" role="alert"><CircleAlert size={20} aria-hidden="true" /><span>{error}</span></p>}
    {pending && <p className="operator-workday__state" role="status"><LoaderCircle size={20} className="operator-workday__spinner" aria-hidden="true" /><span>Загружаем рабочий день…</span></p>}
    {report &&
      <div className="operator-workday__summary">
        <p className="operator-workday__caption">По всем подтверждённым компаниям</p>
        <dl className="operator-workday__metrics" aria-label="Сводка рабочего дня">
          <div><ClipboardList size={23} aria-hidden="true" /><dt>Доступные заявки</dt><dd className={report.summary.availableLeads.length > 12 ? "operator-workday__number--long" : undefined}>{countLabel(report.summary.availableLeads)}</dd></div>
          <div><CalendarCheck2 size={23} aria-hidden="true" /><dt>Записей создано</dt><dd className={report.summary.attributedBookings.length > 12 ? "operator-workday__number--long" : undefined}>{countLabel(report.summary.attributedBookings)}</dd></div>
          <div><UserCheck size={23} aria-hidden="true" /><dt>Приходов подтверждено</dt><dd className={report.summary.clinicConfirmedArrivals.length > 12 ? "operator-workday__number--long" : undefined}>{countLabel(report.summary.clinicConfirmedArrivals)}</dd></div>
        </dl>
        <div className="operator-workday__summary-notes">
          <p><Phone size={14} aria-hidden="true" />Контакты: <span>Учёт не ведётся</span></p>
          <p>Записи и приходы за всё время</p>
          {report.summary.undatedBookings !== "0" && <p>Записей без времени: {countLabel(report.summary.undatedBookings)}</p>}
        </div>
      </div>}
      <div className="operator-workday__body">
        <div className="operator-workday__leads">
          {available && <OperatorLeadExplorer key={actorId} actorId={actorId}
            isSessionCurrent={() => !unmounted.current && scope.current === renderedScope && scopeCurrent(renderedScope) && live.current.isSessionCurrent()}
            onAccessDenied={() => {
              if (scope.current === renderedScope && scopeCurrent(renderedScope)) deny(live.current.request);
            }} />}
        </div>
        <aside className="operator-workday__today" aria-label="Записи на сегодня">
          <header className="operator-workday__today-heading"><h3>Сегодня</h3><CalendarClock size={20} aria-hidden="true" /></header>
          <p className="operator-workday__caption">Местное время компаний</p>
          {report && report.companies.length > 0 && <details className="operator-workday__company-days"><summary>Даты компаний</summary>
            <ul>{report.companies.map(company => <li key={company.requestId}><strong>{company.displayName}</strong><CompanyDate company={company} /></li>)}</ul>
          </details>}
          {today?.state === "unavailable_timezone" && <div className="operator-workday__unavailable" role="status">
            <CircleAlert size={20} aria-hidden="true" /><div><p>Записи на сегодня недоступны</p><p>Нужен поддерживаемый часовой пояс компаний:</p>
              <ul>{report?.companies.filter(company => company.timeZone === null).map(company => <li key={company.requestId}>{company.displayName}</li>)}</ul>
            </div>
          </div>}
          {today?.state === "ready" && <>
            <dl className="operator-workday__today-totals" aria-label="Итоги за сегодня">
              <div><dt>Всего записей</dt><dd>{countLabel(today.total)}</dd></div>
              <div><dt>Требуют внимания</dt><dd>{countLabel(today.actionable)}</dd></div>
            </dl>
            {today.items.length > 0 ? <ol className="operator-workday__agenda">{today.items.map(item => {
              const company = companies.get(item.requestId);
              return company ? <Visit key={item.appointmentId} item={item} company={company} /> : null;
            })}</ol> : <p className="operator-workday__state" role="status">{request.offset > 0 ? "На этой странице записей нет." : "На сегодня записей нет."}</p>}
            <footer className="operator-workday__today-footer">
              <p role="status">{today.items.length > 0
                ? `Записи ${request.offset + 1}–${request.offset + today.items.length} из ${countLabel(today.total)}`
                : `Страница ${Math.floor(request.offset / OPERATOR_WORKDAY_PAGE_SIZE) + 1}`}</p>
              <nav className="operator-workday__pages" aria-label="Страницы записей на сегодня">
                <button type="button" className="operator-workday__icon-button" title="Предыдущая страница" aria-label="Предыдущая страница записей на сегодня"
                  disabled={request.offset === 0} onClick={() => movePage(request, -1)}><ChevronLeft size={18} aria-hidden="true" /></button>
                <button type="button" className="operator-workday__icon-button" title="Следующая страница" aria-label="Следующая страница записей на сегодня"
                  disabled={!today.hasMore || request.offset > MAX_OFFSET - OPERATOR_WORKDAY_PAGE_SIZE} onClick={() => movePage(request, 1)}><ChevronRight size={18} aria-hidden="true" /></button>
              </nav>
            </footer>
          </>}
          {!report && <p className="operator-workday__state" role="status">{pending ? "Загружаем записи…" : "Записи на сегодня недоступны."}</p>}
        </aside>
      </div>
  </section>;
}

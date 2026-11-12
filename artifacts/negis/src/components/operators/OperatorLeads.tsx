import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Save,
  Search,
} from "lucide-react";
import { operatorApi, OperatorApiError, useOperatorList } from "@/lib/operatorApi";
import { OperatorBookingForm } from "./OperatorBookingForm";
import {
  formatArrivalPrice,
  operatorBookingStatusLabels,
  type OperatorLead,
  type OperatorLeadScope,
  type OperatorLeadList,
  type OperatorLeadStage,
} from "../../../../../lib/crm/operator-contracts";

export function OperatorLeads({
  actorId,
  isSessionCurrent,
  requestId,
  workspaceId,
  leadScope,
  onAccessDenied,
}: {
  actorId: string;
  isSessionCurrent?: () => boolean;
  requestId: string;
  workspaceId?: string;
  leadScope: OperatorLeadScope;
  onAccessDenied?: () => void;
}) {
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const base = workspaceId
    ? `clinic-operator-leads?workspaceId=${encodeURIComponent(workspaceId)}&requestId=${encodeURIComponent(requestId)}`
    : `operator-leads?requestId=${encodeURIComponent(requestId)}`;
  return (
    <section
      className="min-w-0 space-y-3 border-t pt-3"
      aria-label="Заявки оператора"
    >
      <h4 className="font-semibold">
        {workspaceId && leadScope === "assigned"
          ? "Назначение заявок"
          : "Доступные заявки"}
      </h4>
      {workspaceId && (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmittedSearch(search.trim());
          }}
        >
          <input
            className="neu-input w-full min-w-0"
            aria-label="Имя в заявке"
            placeholder="Поиск по имени"
            maxLength={120}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button
            type="submit"
            className="neu-btn shrink-0"
            title="Найти заявки"
            aria-label="Найти заявки"
          >
            <Search size={16} />
          </button>
        </form>
      )}
      <LeadList
        key={`${requestId}:${submittedSearch}:${workspaceId || "operator"}`}
        actorId={actorId}
        isSessionCurrent={isSessionCurrent}
        path={`${base}&search=${encodeURIComponent(submittedSearch)}`}
        requestId={requestId}
        clinic={Boolean(workspaceId)}
        canAssign={Boolean(workspaceId) && leadScope === "assigned"}
        onAccessDenied={onAccessDenied}
      />
    </section>
  );
}

function LeadList({
  actorId,
  isSessionCurrent,
  path,
  requestId,
  clinic,
  canAssign,
  onAccessDenied,
}: {
  actorId: string;
  isSessionCurrent?: () => boolean;
  path: string;
  requestId: string;
  clinic: boolean;
  canAssign: boolean;
  onAccessDenied?: () => void;
}) {
  const list = useOperatorList<OperatorLead, OperatorLeadList>(path, true, onAccessDenied, { actorId, isSessionCurrent });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [bookingLeadId, setBookingLeadId] = useState<string | null>(null);
  const mounted = useRef(false);
  // A list refresh must not release an unresolved mutation's submission lock.
  const pending = useRef<object | null>(null);
  const currentView = useRef({ path, actorId, offset: list.offset, data: list.data });
  const identityChanged = currentView.current.path !== path || currentView.current.actorId !== actorId;
  const scopeChanged = identityChanged || currentView.current.offset !== list.offset;
  if (scopeChanged || currentView.current.data !== list.data) {
    currentView.current = { path, actorId, offset: list.offset, data: list.data };
    if (identityChanged) {
      pending.current = null;
      if (busy) setBusy(false);
    }
    if (scopeChanged) {
      setError("");
      setNotice("");
      setBookingLeadId(null);
    }
  }
  const renderedView = currentView.current;
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const refresh = list.refresh;
  const bookingAccessDenied = useCallback(() => {
    if (!mounted.current || isSessionCurrent?.() === false || currentView.current.path !== path || currentView.current.actorId !== actorId) return;
    setBookingLeadId(null);
    setError("Доступ к заявке изменился. Список обновлён.");
    refresh();
    onAccessDenied?.();
  }, [refresh, onAccessDenied, path, actorId, isSessionCurrent]);
  const isBookingSessionCurrent = useCallback(() => mounted.current
    && currentView.current === renderedView && isSessionCurrent?.() !== false, [renderedView, isSessionCurrent]);
  useEffect(() => {
    // Mobile browsers commonly restore a tab without firing window focus. Close
    // the open form, hide stale contacts and recheck access on either signal.
    let lastRevalidation = 0;
    const revalidateAccess = () => {
      const now = Date.now();
      if (now - lastRevalidation < 250) return;
      lastRevalidation = now;
      setBookingLeadId(null);
      setError("");
      setNotice("");
      refresh();
    };
    const revalidateVisibleTab = () => {
      if (document.visibilityState === "visible") revalidateAccess();
    };
    window.addEventListener("focus", revalidateAccess);
    document.addEventListener("visibilitychange", revalidateVisibleTab);
    return () => {
      window.removeEventListener("focus", revalidateAccess);
      document.removeEventListener("visibilitychange", revalidateVisibleTab);
    };
  }, [refresh]);
  async function assign(item: OperatorLead, assigned: boolean) {
    const isCurrent = () => mounted.current && isSessionCurrent?.() !== false && currentView.current === renderedView;
    if (!actorId || pending.current || !isCurrent()) return;
    const attempt = {};
    const isSameScope = () => mounted.current && isSessionCurrent?.() !== false && pending.current === attempt
      && currentView.current.path === path && currentView.current.actorId === actorId;
    pending.current = attempt;
    setBusy(true);
    setError("");
    try {
      await operatorApi(path, { leadId: item.id, assigned }, "PATCH", undefined, actorId, isCurrent);
      if (!isCurrent()) return;
      refresh();
    } catch (err) {
      const accessDenied = err instanceof OperatorApiError && [401, 403].includes(err.status);
      if (accessDenied ? !isSameScope() : !isCurrent()) return;
      if (accessDenied) {
        setBookingLeadId(null);
        onAccessDenied?.();
      }
      setError(
        err instanceof Error ? err.message : "Не удалось назначить заявку.",
      );
      refresh();
    } finally {
      if (pending.current === attempt) {
        if (isSameScope()) setBusy(false);
        pending.current = null;
      }
    }
  }
  async function changeStage(item: OperatorLead, stageId: string) {
    const isCurrent = () => mounted.current && isSessionCurrent?.() !== false && currentView.current === renderedView;
    if (!actorId || pending.current || !isCurrent()) return;
    const attempt = {};
    const isSameScope = () => mounted.current && isSessionCurrent?.() !== false && pending.current === attempt
      && currentView.current.path === path && currentView.current.actorId === actorId;
    pending.current = attempt;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operatorApi(
        path,
        {
          leadId: item.id,
          stageId,
          expectedStageId: item.stageId ?? null,
          expectedStatus: item.status,
        },
        "PATCH",
        undefined,
        actorId,
        isCurrent,
      );
      if (!isCurrent()) return;
      setNotice("Стадия заявки сохранена.");
    } catch (err) {
      const accessDenied = err instanceof OperatorApiError && [401, 403].includes(err.status);
      if (accessDenied ? !isSameScope() : !isCurrent()) return;
      if (accessDenied) {
        setBookingLeadId(null);
        if (!isCurrent()) refresh();
        onAccessDenied?.();
      }
      setError(
        err instanceof Error ? err.message : "Не удалось сохранить стадию.",
      );
    } finally {
      // Recheck authorization on both success and failure, removing stale contacts.
      if (isCurrent()) {
        refresh();
      }
      if (pending.current === attempt) {
        if (isSameScope()) setBusy(false);
        pending.current = null;
      }
    }
  }
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm opacity-70">
          {clinic
            ? "Изменение назначения не меняет ответственного сотрудника в CRM."
            : "Стадии заявок"}
        </p>
        <button
          className="neu-btn shrink-0"
          type="button"
          title="Обновить заявки"
          aria-label="Обновить заявки"
          onClick={refresh}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {(error || list.error) && (
        <p role="alert" className="break-words text-sm text-red-700">
          {error || list.error}
        </p>
      )}
      {!list.data && !list.error && <p role="status">Загружаем заявки…</p>}
      {notice && !list.error && (
        <p role="status" className="text-sm text-emerald-700">
          {notice}
        </p>
      )}
      {!clinic && list.data?.stageEditingAvailable === false && (
        <p className="text-sm opacity-70">
          Изменение стадий ещё не подключено. Доступен только просмотр.
        </p>
      )}
      {!clinic &&
        list.data?.stageEditingAvailable &&
        !list.data.stages?.length && (
          <p className="text-sm opacity-70">
            В клинике пока нет активных стадий заявок.
          </p>
        )}
      {list.data?.items.length === 0 && (
        <p className="text-sm">
          {clinic ? "Заявки не найдены." : "Доступных заявок пока нет."}
        </p>
      )}
      <div className="divide-y">
        {list.data?.items.map((item) => (
          <div
            key={item.id}
            className="flex flex-wrap items-start justify-between gap-3 py-3"
          >
            <div className="min-w-0 flex-1 break-words">
              <p className="font-medium">{item.name || "Имя не указано"}</p>
              <p className="text-sm">{item.phone || "Телефон не указан"}</p>
              <p className="text-sm">
                Стадия: {item.stageName || item.status || "Не указана"}
              </p>
              {item.source && (
                <p className="text-xs opacity-70">Источник: {item.source}</p>
              )}
            </div>
            {canAssign && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={item.assigned === true}
                  disabled={busy}
                  aria-label={`Назначить заявку: ${item.name || "без имени"}`}
                  onChange={(event) => void assign(item, event.target.checked)}
                />
                Назначена
              </label>
            )}
            {!clinic &&
              list.data?.stageEditingAvailable &&
              Boolean(list.data?.stages?.length) && (
                <LeadStageEditor
                  key={`${item.id}:${item.stageId}:${item.status}`}
                  item={item}
                  stages={list.data?.stages ?? []}
                  busy={busy}
                  onSave={(stageId) => void changeStage(item, stageId)}
                />
              )}
            {!clinic && actorId && (
              <button
                type="button"
                className="neu-btn"
                disabled={busy}
                aria-expanded={bookingLeadId === item.id}
                onClick={() =>
                  setBookingLeadId(bookingLeadId === item.id ? null : item.id)
                }
              >
                {bookingLeadId === item.id
                  ? "Закрыть запись"
                  : "Записать пациента"}
              </button>
            )}
            {!clinic && actorId && bookingLeadId === item.id && (
              <OperatorBookingForm
                key={item.id}
                actorId={actorId}
                isSessionCurrent={isBookingSessionCurrent}
                requestId={requestId}
                leadId={item.id}
                onAccessDenied={bookingAccessDenied}
                onBooked={(booking) => {
                  const when = booking.startsAt === null ? "Время не указано" : new Intl.DateTimeFormat("ru-RU", {
                    timeZone: booking.timeZone,
                    dateStyle: "short",
                    timeStyle: "short",
                  }).format(new Date(booking.startsAt));
                  const requiresReview = booking.startsAt === null || !booking.doctorName?.trim() || !booking.service?.trim()
                    || booking.priceMinor === null || booking.durationMinutes === null || booking.status === null;
                  const result = booking.status === "cancelled" ? "Запись отменена"
                    : booking.status === "no_show" ? "Пациент не пришёл"
                    : requiresReview ? "Запись требует проверки" : "Запись сохранена";
                  const status = booking.status === null ? "Статус не указан" : operatorBookingStatusLabels[booking.status];
                  setNotice(`${result}: ${when}, ${booking.doctorName?.trim() || "Специалист не указан"}. ${booking.service?.trim() || "Услуга не указана"}. ${formatArrivalPrice(booking.priceMinor, "KZT")}. ${status}.`);
                  setBookingLeadId(null);
                  refresh();
                }}
              />
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button
          className="neu-btn"
          type="button"
          disabled={busy || list.offset === 0}
          onClick={list.previous}
        >
          <ChevronLeft size={16} />
          Назад
        </button>
        <button
          className="neu-btn"
          type="button"
          disabled={busy || !list.data?.hasMore}
          onClick={list.next}
        >
          Далее
          <ChevronRight size={16} />
        </button>
      </div>
    </>
  );
}

function LeadStageEditor({
  item,
  stages,
  busy,
  onSave,
}: {
  item: OperatorLead;
  stages: OperatorLeadStage[];
  busy: boolean;
  onSave: (stageId: string) => void;
}) {
  const [stageId, setStageId] = useState(item.stageId ?? "");
  const knownStage = stages.some((stage) => stage.id === stageId);
  return (
    <form
      className="flex w-full min-w-0 items-end gap-2 sm:max-w-sm"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && knownStage) onSave(stageId);
      }}
    >
      <label className="min-w-0 flex-1 text-sm">
        Стадия заявки
        <select
          className="neu-input mt-1 w-full min-w-0"
          value={stageId}
          disabled={busy}
          aria-label={`Стадия заявки: ${item.name || "без имени"}`}
          onChange={(event) => setStageId(event.target.value)}
        >
          {!knownStage && (
            <option value={stageId}>
              {item.stageName || item.status || "Выберите стадию"}
            </option>
          )}
          {stages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        className="neu-btn shrink-0"
        disabled={busy || !knownStage || stageId === item.stageId}
        title="Сохранить стадию"
        aria-label={`Сохранить стадию: ${item.name || "без имени"}`}
      >
        <Save size={18} />
      </button>
    </form>
  );
}

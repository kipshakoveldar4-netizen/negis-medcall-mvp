import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Phone,
  PhoneOff,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { operatorApi, OperatorApiError, useOperatorList } from "@/lib/operatorApi";
import {
  formatArrivalPrice,
  operatorArrivalCheckLabels,
  type OperatorArrival,
  type OperatorArrivalCheckResult,
} from "../../../../../lib/crm/operator-contracts";

const statusLabels: Record<string, string> = {
  scheduled: "Запланировано",
  confirmed: "Подтверждено",
  arrived: "Пациент пришёл",
  no_show: "Не пришёл",
  cancelled: "Отменено",
};

const callOptions: Array<{
  value: OperatorArrivalCheckResult;
  label: string;
  Icon: typeof CheckCircle2;
}> = [
  { value: "confirmed", label: "Подтвердил", Icon: CheckCircle2 },
  { value: "unconfirmed", label: "Не подтвердил", Icon: XCircle },
  { value: "unreachable", label: "Не дозвонился", Icon: PhoneOff },
];

function dateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Время не указано"
    : new Intl.DateTimeFormat("ru-RU", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

export function OperatorArrivals({
  actorId,
  isSessionCurrent,
  requestId,
  workspaceId,
  onAccessDenied,
}: {
  actorId: string;
  isSessionCurrent?: () => boolean;
  requestId: string;
  workspaceId?: string;
  onAccessDenied?: () => void;
}) {
  const clinic = Boolean(workspaceId);
  const path = clinic
    ? `clinic-operator-arrivals?workspaceId=${encodeURIComponent(workspaceId!)}&requestId=${encodeURIComponent(requestId)}`
    : `operator-arrivals?requestId=${encodeURIComponent(requestId)}`;
  const list = useOperatorList<OperatorArrival>(path, true, clinic ? undefined : onAccessDenied, { actorId, isSessionCurrent });
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const pending = useRef(new Map<string, object>());
  const scope = useRef({ path, actorId });
  if (scope.current.path !== path || scope.current.actorId !== actorId) {
    scope.current = { path, actorId };
    pending.current = new Map();
    if (busyIds.size) setBusyIds(new Set());
  }
  const renderedScope = scope.current;
  // A mutation belongs to its visible list snapshot, including refreshes/pages.
  const currentView = useRef({ path, actorId, offset: list.offset, data: list.data });
  const scopeChanged =
    currentView.current.path !== path ||
    currentView.current.actorId !== actorId ||
    currentView.current.offset !== list.offset;
  if (scopeChanged || currentView.current.data !== list.data) {
    currentView.current = { path, actorId, offset: list.offset, data: list.data };
    if (scopeChanged) setError("");
  }
  const renderedView = currentView.current;
  const isSameScope = () => mounted.current && scope.current === renderedScope && isSessionCurrent?.() !== false;
  const isCurrent = () => isSameScope() && currentView.current === renderedView;
  function ownCommand(key: string) {
    if (!actorId || !isCurrent() || pending.current.has(key)) return null;
    // Own each row before rendering. Refreshes retire its reply, not its lease.
    const attempt = {};
    pending.current.set(key, attempt);
    setBusyIds(value => new Set(value).add(key));
    setError("");
    return attempt;
  }
  function releaseCommand(key: string, attempt: object) {
    if (!isSameScope() || pending.current.get(key) !== attempt) return;
    pending.current.delete(key);
    setBusyIds(value => {
      const next = new Set(value);
      next.delete(key);
      return next;
    });
  }
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const revalidate = () => list.refresh();
    const revalidateVisible = () => {
      if (document.visibilityState === "visible") list.refresh();
    };
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidateVisible);
    return () => {
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidateVisible);
    };
  }, [list.refresh]);

  async function confirm(item: OperatorArrival) {
    const key = `confirm:${item.appointmentId}`;
    const attempt = ownCommand(key);
    if (!attempt) return;
    try {
      await operatorApi(
        path,
        { appointmentId: item.appointmentId },
        "POST",
        undefined,
        actorId,
        isCurrent,
      );
      if (!isCurrent()) return;
      list.refresh();
    } catch (err) {
      const accessDenied = err instanceof OperatorApiError && [401, 403].includes(err.status);
      if (accessDenied ? !isSameScope() : !isCurrent()) return;
      if (accessDenied) {
        list.refresh();
        if (!clinic) onAccessDenied?.();
      }
      setError(
        err instanceof Error ? err.message : "Не удалось подтвердить приход",
      );
    } finally {
      releaseCommand(key, attempt);
    }
  }

  async function saveCall(
    item: OperatorArrival,
    result: OperatorArrivalCheckResult,
  ) {
    if (!item.arrivalId) return;
    const key = `call:${item.arrivalId}`;
    const attempt = ownCommand(key);
    if (!attempt) return;
    try {
      await operatorApi(
        path,
        { arrivalId: item.arrivalId, result },
        "PATCH",
        undefined,
        actorId,
        isCurrent,
      );
      if (!isCurrent()) return;
      list.refresh();
    } catch (err) {
      const accessDenied = err instanceof OperatorApiError && [401, 403].includes(err.status);
      if (accessDenied ? !isSameScope() : !isCurrent()) return;
      if (accessDenied) {
        list.refresh();
        if (!clinic) onAccessDenied?.();
      }
      setError(
        err instanceof Error
          ? err.message
          : "Не удалось сохранить результат звонка",
      );
    } finally {
      releaseCommand(key, attempt);
    }
  }

  return (
    <section
      className="min-w-0 border-t pt-3 space-y-3"
      aria-label="Приходы пациентов"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-semibold">
          {clinic ? "Приходы по записям оператора" : "Контрольные звонки"}
        </h4>
        <button
          type="button"
          className="neu-btn"
          onClick={list.refresh}
          aria-label="Обновить приходы"
          title="Обновить приходы"
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {(error || list.error) && (
        <p role="alert" className="break-words text-sm text-red-700">
          {error || list.error}
        </p>
      )}
      {!list.data && !list.error && <p role="status">Загружаем приходы…</p>}
      {list.data?.items.length === 0 && (
        <p className="text-sm opacity-70">
          {clinic
            ? "Записей этого оператора пока нет."
            : "Клиника пока не подтвердила ни одного прихода."}
        </p>
      )}
      <div className="divide-y" style={{ borderColor: "var(--negis-border)" }}>
        {list.data?.items.map((item) => (
          <article key={item.appointmentId} className="min-w-0 py-3 space-y-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium break-words">
                  {item.clientName || "Пациент"}
                </p>
                <p className="text-sm opacity-75 break-words">
                  {dateTime(item.startsAt)} ·{" "}
                  {item.service || "Услуга не указана"}
                </p>
                {item.doctorName && (
                  <p className="text-sm opacity-75 break-words">
                    {item.doctorName}
                  </p>
                )}
              </div>
              <span className="text-sm opacity-70">
                {statusLabels[item.status] || item.status}
              </span>
            </div>
            {item.arrivalId ? (
              <p className="text-sm">
                Клиника подтвердила приход ·{" "}
                {formatArrivalPrice(item.priceMinor, item.currency || "KZT")}
              </p>
            ) : item.status === "arrived" ? (
              <button
                type="button"
                className="neu-btn-primary"
                disabled={busyIds.has(`confirm:${item.appointmentId}`)}
                onClick={() => void confirm(item)}
              >
                <CheckCircle2 size={16} />
                Подтвердить приход
              </button>
            ) : (
              <p className="text-sm opacity-70">
                Сначала отметьте запись статусом «Пришёл».
              </p>
            )}
            {!clinic && item.arrivalId && (
              <>
                {item.clientPhone && (
                  <a
                    className="neu-btn inline-flex"
                    href={`tel:${item.clientPhone}`}
                  >
                    <Phone size={16} />
                    Позвонить пациенту
                  </a>
                )}
                <div
                  className="flex flex-wrap gap-2"
                  role="group"
                  aria-label="Результат контрольного звонка"
                >
                  {callOptions.map(({ value, label, Icon }) => (
                    <button
                      key={value}
                      type="button"
                      className={
                        item.operatorCheckResult === value
                          ? "neu-btn-primary"
                          : "neu-btn"
                      }
                      disabled={busyIds.has(`call:${item.arrivalId}`)}
                      aria-pressed={item.operatorCheckResult === value}
                      onClick={() => void saveCall(item, value)}
                    >
                      <Icon size={16} />
                      {label}
                    </button>
                  ))}
                </div>
                {item.operatorCheckResult && (
                  <p className="text-sm font-medium">
                    {operatorArrivalCheckLabels[item.operatorCheckResult]}
                  </p>
                )}
              </>
            )}
          </article>
        ))}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          className="neu-btn"
          onClick={list.previous}
          disabled={list.offset === 0}
        >
          <ChevronLeft size={16} />
          Назад
        </button>
        <button
          type="button"
          className="neu-btn"
          onClick={list.next}
          disabled={!list.data?.hasMore}
        >
          Далее
          <ChevronRight size={16} />
        </button>
      </div>
    </section>
  );
}

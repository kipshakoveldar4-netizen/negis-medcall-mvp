import { useEffect, useState } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Phone,
  PhoneOff,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { operatorApi, useOperatorList } from "@/lib/operatorApi";
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
  requestId,
  workspaceId,
}: {
  requestId: string;
  workspaceId?: string;
}) {
  const clinic = Boolean(workspaceId);
  const path = clinic
    ? `clinic-operator-arrivals?workspaceId=${encodeURIComponent(workspaceId!)}&requestId=${encodeURIComponent(requestId)}`
    : `operator-arrivals?requestId=${encodeURIComponent(requestId)}`;
  const list = useOperatorList<OperatorArrival>(path);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

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
    setBusyId(item.appointmentId);
    setError("");
    try {
      await operatorApi(path, { appointmentId: item.appointmentId }, "POST");
      list.refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Не удалось подтвердить приход",
      );
    } finally {
      setBusyId(null);
    }
  }

  async function saveCall(
    item: OperatorArrival,
    result: OperatorArrivalCheckResult,
  ) {
    if (!item.arrivalId) return;
    setBusyId(item.arrivalId);
    setError("");
    try {
      await operatorApi(path, { arrivalId: item.arrivalId, result }, "PATCH");
      list.refresh();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Не удалось сохранить результат звонка",
      );
    } finally {
      setBusyId(null);
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
                disabled={busyId === item.appointmentId}
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
                      disabled={busyId === item.arrivalId}
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

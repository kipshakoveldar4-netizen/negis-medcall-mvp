import { useEffect, useRef, useState } from "react";
import { CalendarPlus, RefreshCw } from "lucide-react";
import {
  operatorApi,
  OperatorApiError,
  useOperatorList,
} from "@/lib/operatorApi";
import { OperatorCatalogPagination } from "./OperatorServiceCatalog";
import {
  formatArrivalPrice,
  type OperatorBooking,
  type OperatorDoctor,
  type OperatorService,
} from "../../../../../lib/crm/operator-contracts";

export function OperatorBookingForm({
  requestId,
  leadId,
  onBooked,
  onAccessDenied,
}: {
  requestId: string;
  leadId: string;
  onBooked: (booking: OperatorBooking) => void;
  onAccessDenied: () => void;
}) {
  const [context, setContext] = useState<{ timeZone: string | null } | null>(
    null,
  );
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setContext(null);
    setError("");
    const controller = new AbortController();
    void operatorApi<{ timeZone: string | null }>(
      `operator-bookings?requestId=${encodeURIComponent(requestId)}&leadId=${encodeURIComponent(leadId)}`,
      undefined,
      "GET",
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) setContext(data);
      })
      .catch((err) => {
        if (
          !controller.signal.aborted &&
          err instanceof OperatorApiError &&
          [401, 403].includes(err.status)
        ) {
          onAccessDenied();
          return;
        }
        if (!controller.signal.aborted)
          setError(
            err instanceof Error ? err.message : "Не удалось открыть запись",
          );
      });
    return () => controller.abort();
  }, [requestId, leadId, revision, onAccessDenied]);
  return (
    <section
      aria-label="Запись пациента"
      className="w-full min-w-0 space-y-3 border-t pt-3"
    >
      <h5 className="font-semibold">Запись пациента</h5>
      {error && (
        <div className="space-y-2">
          <p role="alert" className="text-sm break-words text-red-700">
            {error}
          </p>
          <button
            className="neu-btn"
            type="button"
            title="Повторить проверку доступа"
            aria-label="Повторить проверку доступа"
            onClick={() => setRevision((n) => n + 1)}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      )}
      {!context && !error && <p role="status">Проверяем доступ к записи…</p>}
      {context && !context.timeZone && (
        <p role="status" className="text-sm">
          Клинике нужно настроить часовой пояс и график мастера.
        </p>
      )}
      {context?.timeZone && (
        <BookingFields
          requestId={requestId}
          leadId={leadId}
          timeZone={context.timeZone}
          onBooked={onBooked}
          onAccessDenied={onAccessDenied}
        />
      )}
    </section>
  );
}

function BookingFields({
  requestId,
  leadId,
  timeZone,
  onBooked,
  onAccessDenied,
}: {
  requestId: string;
  leadId: string;
  timeZone: string;
  onBooked: (booking: OperatorBooking) => void;
  onAccessDenied: () => void;
}) {
  const doctors = useOperatorList<OperatorDoctor>(
    `operator-services?requestId=${encodeURIComponent(requestId)}`,
  );
  const [doctorId, setDoctorId] = useState("");
  const [selected, setSelected] = useState<OperatorService[]>([]);
  const [startsLocal, setStartsLocal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [catalogValid, setCatalogValid] = useState(false);
  // One key survives retries and input edits while this form is open.
  const [requestKey] = useState(() => crypto.randomUUID());
  const inFlight = useRef(false);
  const doctor = doctors.data?.items.find((item) => item.id === doctorId);
  const minutes = selected.reduce(
    (sum, item) => sum + (item.durationMinutes ?? 0),
    0,
  );
  const total = selected.reduce(
    (sum, item) => sum + BigInt(item.priceMinor ?? "0"),
    0n,
  );
  const ready =
    !!doctor &&
    catalogValid &&
    selected.length > 0 &&
    selected.length <= 20 &&
    selected.every(
      (item) => item.priceMinor !== null && item.durationMinutes !== null,
    ) &&
    minutes > 0 &&
    minutes <= 600 &&
    total <= 10000000000n &&
    !!startsLocal;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const saved = await operatorApi<OperatorBooking>(
        `operator-bookings?requestId=${encodeURIComponent(requestId)}`,
        {
          leadId,
          requestKey,
          doctorId,
          serviceIds: selected.map((item) => item.id),
          startsLocal,
          timeZone,
        },
      );
      onBooked(saved);
    } catch (err) {
      if (err instanceof OperatorApiError && [401, 403].includes(err.status)) {
        onAccessDenied();
        return;
      }
      setError(
        err instanceof Error ? err.message : "Не удалось сохранить запись",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="min-w-0 space-y-3"
    >
      <fieldset disabled={busy} className="min-w-0 space-y-3">
        {doctors.error && (
          <p role="alert" className="text-sm text-red-700">
            {doctors.error}
          </p>
        )}
        {!doctors.data && !doctors.error && (
          <p role="status">Загружаем мастеров…</p>
        )}
        {doctors.data?.items.length === 0 && (
          <p>В клинике пока нет активных мастеров.</p>
        )}
        <label className="block min-w-0 text-sm">
          Мастер
          <select
            className="neu-input mt-1 w-full min-w-0 max-w-full"
            value={doctor?.id ?? ""}
            onChange={(event) => {
              setDoctorId(event.target.value);
              setSelected([]);
              setCatalogValid(false);
            }}
          >
            <option value="">Выберите мастера</option>
            {doctors.data?.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <OperatorCatalogPagination
          {...doctors}
          hasMore={!!doctors.data?.hasMore}
        />
        {doctor && (
          <ServicePicker
            key={doctor.id}
            requestId={requestId}
            doctorId={doctor.id}
            selected={selected}
            onChange={setSelected}
            onValidity={setCatalogValid}
          />
        )}
        {selected.length > 0 && (
          <div className="text-sm space-y-1" aria-label="Итог записи">
            <p className="break-words">
              {selected.map((item) => item.name).join(" + ")}
            </p>
            <p>
              По прайсу: {formatArrivalPrice(total.toString(), "KZT")} ·{" "}
              {minutes} мин
            </p>
            {(minutes > 600 || total > 10000000000n) && (
              <p role="alert">Уменьшите количество услуг в записи.</p>
            )}
          </div>
        )}
        <label className="block min-w-0 text-sm">
          Дата и время клиники ({timeZone})
          <input
            type="datetime-local"
            required
            className="neu-input mt-1 w-full min-w-0 max-w-full"
            value={startsLocal}
            onChange={(event) => setStartsLocal(event.target.value)}
          />
        </label>
      </fieldset>
      {error && (
        <p role="alert" className="text-sm break-words text-red-700">
          {error}
        </p>
      )}
      <button
        type="submit"
        className="neu-btn-primary w-full sm:w-auto"
        disabled={busy || !ready}
      >
        <CalendarPlus size={16} />
        {busy ? "Сохраняем…" : "Создать запись"}
      </button>
    </form>
  );
}

function ServicePicker({
  requestId,
  doctorId,
  selected,
  onChange,
  onValidity,
}: {
  requestId: string;
  doctorId: string;
  selected: OperatorService[];
  onChange: (items: OperatorService[]) => void;
  onValidity: (valid: boolean) => void;
}) {
  const list = useOperatorList<OperatorService>(
    `operator-services?requestId=${encodeURIComponent(requestId)}&doctorId=${encodeURIComponent(doctorId)}`,
  );
  useEffect(() => {
    onValidity(!!list.data && !list.error);
  }, [list.data, list.error, onValidity]);
  return (
    <section aria-label="Услуги для записи" className="min-w-0 space-y-2">
      <p className="text-sm font-medium">Услуги мастера</p>
      {list.error && (
        <p role="alert" className="text-sm text-red-700">
          {list.error}
        </p>
      )}
      {!list.data && !list.error && <p role="status">Загружаем услуги…</p>}
      {list.data?.items.length === 0 && (
        <p className="text-sm">У мастера пока нет услуг в прайсе.</p>
      )}
      {list.data?.items.map((item) => {
        const checked = selected.some((service) => service.id === item.id);
        const available =
          item.priceMinor !== null && item.durationMinutes !== null;
        return (
          <label key={item.id} className="flex gap-3 py-2 text-sm min-w-0">
            <input
              type="checkbox"
              className="mt-1 shrink-0"
              checked={checked}
              disabled={!available || (!checked && selected.length >= 20)}
              onChange={() =>
                onChange(
                  checked
                    ? selected.filter((service) => service.id !== item.id)
                    : [...selected, item],
                )
              }
            />
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">
              {item.name}
              <br />
              {item.priceMinor === null
                ? "Цена не указана"
                : formatArrivalPrice(item.priceMinor, item.currency)}
              {item.durationMinutes === null
                ? " · Длительность не указана"
                : ` · ${item.durationMinutes} мин`}
            </span>
          </label>
        );
      })}
      <OperatorCatalogPagination {...list} hasMore={!!list.data?.hasMore} />
    </section>
  );
}

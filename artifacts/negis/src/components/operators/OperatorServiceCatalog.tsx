import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useOperatorList } from "@/lib/operatorApi";
import {
  formatArrivalPrice,
  type OperatorDoctor,
  type OperatorService,
} from "../../../../../lib/crm/operator-contracts";

function Pagination({
  previous,
  next,
  offset,
  hasMore,
}: {
  previous: () => void;
  next: () => void;
  offset: number;
  hasMore: boolean;
}) {
  return (
    <div className="flex gap-2">
      <button
        type="button"
        className="neu-btn"
        onClick={previous}
        disabled={!offset}
        title="Предыдущая страница"
        aria-label="Предыдущая страница"
      >
        <ChevronLeft size={16} />
      </button>
      <button
        type="button"
        className="neu-btn"
        onClick={next}
        disabled={!hasMore}
        title="Следующая страница"
        aria-label="Следующая страница"
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
}

function Services({
  requestId,
  doctorId,
}: {
  requestId: string;
  doctorId: string;
}) {
  const list = useOperatorList<OperatorService>(
    `operator-services?requestId=${encodeURIComponent(requestId)}&doctorId=${encodeURIComponent(doctorId)}`,
  );
  useEffect(() => {
    window.addEventListener("focus", list.refresh);
    return () => window.removeEventListener("focus", list.refresh);
  }, [list.refresh]);
  return (
    <section aria-label="Услуги мастера" className="min-w-0 space-y-3">
      {list.error && (
        <p role="alert" className="break-words text-sm text-red-700">
          {list.error}
        </p>
      )}
      {!list.data && !list.error && <p role="status">Загружаем услуги…</p>}
      {list.data?.items.length === 0 && (
        <p className="text-sm opacity-70">
          У этого мастера пока нет услуг в прайсе.
        </p>
      )}
      <ul className="divide-y" style={{ borderColor: "var(--negis-border)" }}>
        {list.data?.items.map((service) => (
          <li key={service.id} className="py-3 min-w-0 space-y-1">
            <p className="font-medium break-words [overflow-wrap:anywhere]">
              {service.name}
            </p>
            <p className="text-sm break-words">
              {service.priceMinor === null
                ? "Цена не указана"
                : formatArrivalPrice(service.priceMinor, service.currency)}
            </p>
            <p className="text-sm opacity-70">
              {service.durationMinutes === null
                ? "Длительность не указана"
                : `${service.durationMinutes} мин`}
            </p>
          </li>
        ))}
      </ul>
      <Pagination {...list} hasMore={!!list.data?.hasMore} />
    </section>
  );
}

export function OperatorServiceCatalog({ requestId }: { requestId: string }) {
  const list = useOperatorList<OperatorDoctor>(
    `operator-services?requestId=${encodeURIComponent(requestId)}`,
  );
  const [doctorId, setDoctorId] = useState("");
  const doctor = list.data?.items.find((item) => item.id === doctorId);
  useEffect(() => {
    window.addEventListener("focus", list.refresh);
    return () => window.removeEventListener("focus", list.refresh);
  }, [list.refresh]);
  return (
    <section
      aria-label="Прайс клиники"
      className="min-w-0 space-y-3 border-t pt-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="font-semibold">Услуги и цены</h4>
        <button
          type="button"
          className="neu-btn"
          onClick={list.refresh}
          title="Обновить прайс"
          aria-label="Обновить прайс"
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {list.error && (
        <p role="alert" className="break-words text-sm text-red-700">
          {list.error}
        </p>
      )}
      {!list.data && !list.error && <p role="status">Загружаем мастеров…</p>}
      {list.data?.items.length === 0 && (
        <p className="text-sm opacity-70">
          В клинике пока нет активных мастеров.
        </p>
      )}
      {!!list.data?.items.length && (
        <label className="block min-w-0 space-y-2">
          <span className="text-sm font-medium">Мастер</span>
          <select
            className="neu-input w-full min-w-0 max-w-full"
            value={doctor?.id || ""}
            onChange={(event) => setDoctorId(event.target.value)}
          >
            <option value="">Выберите мастера</option>
            {list.data.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.specialty ? ` — ${item.specialty}` : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      <Pagination {...list} hasMore={!!list.data?.hasMore} />
      {doctor && (
        <Services
          key={`${requestId}:${doctor.id}`}
          requestId={requestId}
          doctorId={doctor.id}
        />
      )}
    </section>
  );
}

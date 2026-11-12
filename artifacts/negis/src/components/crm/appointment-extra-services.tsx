import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  appointmentPriceFromInput,
  type AppointmentServiceItem,
} from "../../../../../lib/crm/appointment-services";

type Service = {
  id: string;
  name: string;
  basePriceMinor: number | null;
  durationMinutes: number | null;
};

export function AppointmentExtraServices({
  items,
  catalog,
  primaryId,
  onChange,
}: {
  items: AppointmentServiceItem[];
  catalog: Service[];
  primaryId: string;
  onChange: (items: AppointmentServiceItem[]) => void;
}) {
  const [error, setError] = useState("");
  const available = catalog.filter(
    (s) => s.id !== primaryId && !items.some((item) => item.serviceId === s.id),
  );
  function add(service?: Service) {
    if (items.length >= 19) {
      setError("В одной записи может быть не более 20 услуг.");
      return;
    }
    setError("");
    onChange([
      ...items,
      {
        serviceId: service?.id ?? "",
        name: service?.name ?? "",
        priceMinor: service?.basePriceMinor ?? null,
        durationMinutes: service?.durationMinutes ?? 60,
      },
    ]);
  }
  function update(index: number, patch: Partial<AppointmentServiceItem>) {
    onChange(
      items.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  }
  return (
    <section
      className="min-w-0 space-y-3 md:col-span-2"
      aria-label="Дополнительные услуги"
    >
      <h3 className="font-semibold">Дополнительные услуги</h3>
      {items.map((item, index) => (
        <div
          key={`${index}:${item.serviceId}`}
          className="border-t pt-3 space-y-2"
        >
          <div className="flex items-start gap-2">
            <label className="min-w-0 flex-1 text-sm">
              Услуга {index + 2}
              <input
                className="neu-input mt-1 w-full"
                required
                maxLength={200}
                value={item.name}
                onChange={(e) => update(index, { name: e.target.value })}
              />
            </label>
            <button
              type="button"
              className="neu-btn shrink-0 mt-6"
              title={`Убрать услугу ${index + 2}`}
              aria-label={`Убрать услугу ${index + 2}`}
              onClick={() => onChange(items.filter((_, i) => i !== index))}
            >
              <X size={16} />
            </button>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <ServicePrice
              value={item.priceMinor}
              onChange={(priceMinor) => update(index, { priceMinor })}
              index={index}
            />
            <label className="min-w-0 text-sm">
              Длительность услуги {index + 2}, мин
              <input
                className="neu-input mt-1 w-full"
                type="number"
                min={1}
                max={600}
                step={1}
                required
                value={item.durationMinutes || ""}
                onChange={(e) =>
                  update(index, { durationMinutes: Number(e.target.value) })
                }
              />
            </label>
          </div>
        </div>
      ))}
      <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-2">
        {available.length > 0 && (
          <label className="min-w-0 flex-1 text-sm">
            Добавить услугу из прайса
            <select
              className="neu-input mt-1 w-full"
              value=""
              disabled={items.length >= 19}
              onChange={(e) => {
                const service = available.find((s) => s.id === e.target.value);
                if (service) add(service);
              }}
            >
              <option value="">Выберите ещё услугу</option>
              {available.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                  {service.basePriceMinor === null
                    ? ""
                    : ` · ${service.basePriceMinor / 100} ₸`}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className="neu-btn"
          disabled={items.length >= 19}
          onClick={() => add()}
        >
          <Plus size={16} />
          Добавить вручную
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}

function ServicePrice({
  value,
  index,
  onChange,
}: {
  value: number | null;
  index: number;
  onChange: (price: number | null) => void;
}) {
  const [input, setInput] = useState(value === null ? "" : String(value / 100));
  const [error, setError] = useState("");
  useEffect(() => {
    if (value !== null && !Number.isFinite(value)) return;
    let parsed;
    try {
      parsed = appointmentPriceFromInput(input);
    } catch {
      parsed = Number.NaN;
    }
    if (parsed !== value) setInput(value === null ? "" : String(value / 100));
    setError("");
  }, [value]);
  return (
    <label className="min-w-0 text-sm">
      Цена услуги {index + 2}, ₸
      <input
        className="neu-input mt-1 w-full"
        type="number"
        min={0}
        max={100000000}
        step="0.01"
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          try {
            if (e.target.validity.badInput) throw new Error("Invalid price");
            onChange(appointmentPriceFromInput(e.target.value));
            setError("");
          } catch {
            onChange(Number.NaN);
            setError("Проверьте цену");
          }
        }}
      />
      {error && (
        <span role="alert" className="text-red-700">
          {error}
        </span>
      )}
    </label>
  );
}

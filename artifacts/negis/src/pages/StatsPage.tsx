import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3 } from "lucide-react";

import { PageLayout } from "@/components/layout/PageLayout";
import { useAuth } from "@/contexts/AuthContext";
import { crmFetch } from "@/lib/api";
import { getAppointmentStatusLabel } from "@/pages/AppointmentsPage";

// Статистика владельца — раздел «Статистика» из кабинета запись.кз.
//
// Главное правило экрана: числа с разным смыслом не склеиваются. «Оплачено в
// продажах» — деньги в кассе. «По ценам записей» — ожидание по договорённостям,
// и рядом честно стоит, у скольких пришедших цены нет вовсе. Загрузка мастера
// показывается только там, где есть график: занятые часы без знаменателя
// честнее выдуманного процента.

interface Stats {
  appointments: { total: number; byStatus: Record<string, number>; lostSharePercent: number };
  money: {
    paidMinor: number;
    paidCount: number;
    averageTicketMinor: number | null;
    arrivedPricedMinor: number;
    arrivedWithoutPrice: number;
  };
  masters: Array<{
    doctorId: string;
    name: string;
    appointments: number;
    busyMinutes: number;
    scheduledMinutes: number | null;
    loadPercent: number | null;
    pricedMinor: number;
  }>;
  services: Array<{ name: string; count: number; pricedMinor: number }>;
  clients: { withCard: number; newClients: number; returning: number; withoutCard: number };
  truncated: boolean;
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function tenge(minor: number): string {
  return `${Math.round(minor / 100).toLocaleString("ru-RU")} ₸`;
}

function hours(minutes: number): string {
  const whole = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${whole} ч ${rest} мин` : `${whole} ч`;
}

const PRESETS = [
  { key: "week", label: "7 дней", days: 7 },
  { key: "month", label: "30 дней", days: 30 },
  { key: "quarter", label: "90 дней", days: 90 },
] as const;

export default function StatsPage() {
  const { clinicId } = useAuth();
  const [preset, setPreset] = useState<(typeof PRESETS)[number]["key"]>("month");
  const [stats, setStats] = useState<Stats | null>(null);
  const [period, setPeriod] = useState<{ from: string; to: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");

  const range = useMemo(() => {
    const days = PRESETS.find((entry) => entry.key === preset)?.days ?? 30;
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - (days - 1));
    return { from: dateKey(from), to: dateKey(to) };
  }, [preset]);

  const load = useCallback(async () => {
    if (!clinicId) return;
    setLoaded(false);
    setLoadError("");
    try {
      const query = new URLSearchParams({ workspaceId: clinicId, from: range.from, to: range.to });
      const response = await crmFetch(`/api/crm/salon-stats?${query.toString()}`);
      const payload = (await response.json()) as { success?: boolean; stats?: Stats | null; from?: string; to?: string; error?: string };
      if (!response.ok || !payload.success) throw new Error(payload.error || "Не удалось посчитать статистику");
      setStats(payload.stats ?? null);
      setPeriod(payload.from && payload.to ? { from: payload.from, to: payload.to } : null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Не удалось посчитать статистику");
    } finally {
      setLoaded(true);
    }
  }, [clinicId, range.from, range.to]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <PageLayout>
      <header className="negis-glass-hero p-5 sm:p-6">
        <h1 className="text-xl font-black text-[#0F172A] sm:text-2xl">Статистика</h1>
        <p className="mt-2 text-sm font-semibold leading-relaxed text-[#475569]">
          Записи, деньги, загрузка мастеров и услуги за период. Всё считается по реальным данным салона.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {PRESETS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className="neu-btn px-4 py-2 text-sm"
              style={preset === entry.key ? { color: "#0D9488", fontWeight: 800 } : undefined}
              onClick={() => setPreset(entry.key)}
            >
              {entry.label}
            </button>
          ))}
          {period ? (
            <span className="self-center text-xs font-bold text-[#64748B] tabular-nums">
              {period.from} — {period.to}
            </span>
          ) : null}
        </div>
      </header>

      {!loaded ? (
        <section className="negis-glass mt-5 flex min-h-40 items-center justify-center p-8">
          <p className="text-sm font-bold text-[#64748B]">Считаем…</p>
        </section>
      ) : loadError ? (
        <section className="negis-glass mt-5 p-4" style={{ borderLeft: "4px solid #dc2626" }}>
          <p className="text-sm font-black" style={{ color: "#b91c1c" }}>Не удалось посчитать статистику</p>
          <p className="mt-1 text-sm font-semibold text-[#475569]">Это сбой связи, а не нулевые показатели.</p>
          <button type="button" className="neu-btn mt-3 px-4 py-2 text-sm" onClick={() => void load()}>
            Попробовать снова
          </button>
        </section>
      ) : !stats ? (
        <section className="negis-glass mt-5 flex flex-col items-center p-8 text-center">
          <BarChart3 size={28} className="text-[#94A3B8]" />
          <p className="mt-3 text-sm font-black text-[#0F172A]">Статистика доступна на рабочем пространстве</p>
        </section>
      ) : (
        <div className="mt-5 space-y-5">
          {stats.truncated ? (
            <p className="rounded-2xl bg-amber-50 p-3 text-sm font-black text-amber-800">
              Записей за период больше, чем поместилось в расчёт, — числа ниже неполные. Сузьте период.
            </p>
          ) : null}

          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="negis-glass p-4">
              <p className="text-xs font-black uppercase tracking-[0.12em] text-[#64748B]">Записей за период</p>
              <p className="mt-1 text-2xl font-black tabular-nums text-[#0F172A]">{stats.appointments.total}</p>
              <p className="mt-1 text-xs font-semibold text-[#64748B]">
                {Object.entries(stats.appointments.byStatus)
                  .map(([status, count]) => `${getAppointmentStatusLabel(status)}: ${count}`)
                  .join(" · ") || "—"}
              </p>
            </div>
            <div className="negis-glass p-4">
              <p className="text-xs font-black uppercase tracking-[0.12em] text-[#64748B]">Оплачено в продажах</p>
              <p className="mt-1 text-2xl font-black tabular-nums text-[#0F172A]">{tenge(stats.money.paidMinor)}</p>
              <p className="mt-1 text-xs font-semibold text-[#64748B]">
                {stats.money.paidCount > 0 && stats.money.averageTicketMinor !== null
                  ? `${stats.money.paidCount} продаж · средний чек ${tenge(stats.money.averageTicketMinor)}`
                  : "Оплаченных продаж не было"}
              </p>
            </div>
            <div className="negis-glass p-4">
              <p className="text-xs font-black uppercase tracking-[0.12em] text-[#64748B]">По ценам записей</p>
              <p className="mt-1 text-2xl font-black tabular-nums text-[#0F172A]">{tenge(stats.money.arrivedPricedMinor)}</p>
              <p className="mt-1 text-xs font-semibold text-[#64748B]">
                {stats.money.arrivedWithoutPrice > 0
                  ? `Пришедшие с ценой; ещё ${stats.money.arrivedWithoutPrice} визитов без цены — итог неполный`
                  : "Сумма цен пришедших записей"}
              </p>
            </div>
            <div className="negis-glass p-4">
              <p className="text-xs font-black uppercase tracking-[0.12em] text-[#64748B]">Отмены и неявки</p>
              <p className="mt-1 text-2xl font-black tabular-nums text-[#0F172A]">{stats.appointments.lostSharePercent}%</p>
              <p className="mt-1 text-xs font-semibold text-[#64748B]">
                Клиенты: {stats.clients.newClients} новых · {stats.clients.returning} постоянных
                {stats.clients.withoutCard > 0 ? ` · ${stats.clients.withoutCard} записей без карточки` : ""}
              </p>
            </div>
          </section>

          <section className="negis-glass p-4">
            <p className="text-sm font-black text-[#0F172A]">Мастера</p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse text-left text-sm">
                <thead>
                  <tr className="text-xs font-black uppercase tracking-[0.1em] text-[#94A3B8]">
                    <th className="px-2 py-2">Мастер</th>
                    <th className="px-2 py-2">Записей</th>
                    <th className="px-2 py-2">Занято</th>
                    <th className="px-2 py-2">Загрузка</th>
                    <th className="px-2 py-2">По ценам записей</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.masters.map((master) => (
                    <tr key={master.doctorId || master.name} style={{ borderTop: "1px solid var(--negis-border)" }}>
                      <td className="px-2 py-2 font-black text-[#0F172A]">{master.name}</td>
                      <td className="px-2 py-2 font-semibold tabular-nums text-[#475569]">{master.appointments}</td>
                      <td className="px-2 py-2 font-semibold tabular-nums text-[#475569]">{hours(master.busyMinutes)}</td>
                      <td className="px-2 py-2 font-semibold tabular-nums text-[#475569]">
                        {master.loadPercent === null ? "график не задан" : `${master.loadPercent}%`}
                      </td>
                      <td className="px-2 py-2 font-semibold tabular-nums text-[#475569]">{tenge(master.pricedMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="negis-glass p-4">
            <p className="text-sm font-black text-[#0F172A]">Популярные услуги</p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[420px] border-collapse text-left text-sm">
                <thead>
                  <tr className="text-xs font-black uppercase tracking-[0.1em] text-[#94A3B8]">
                    <th className="px-2 py-2">Услуга</th>
                    <th className="px-2 py-2">Записей</th>
                    <th className="px-2 py-2">По ценам записей</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.services.map((service) => (
                    <tr key={service.name} style={{ borderTop: "1px solid var(--negis-border)" }}>
                      <td className="px-2 py-2 font-black text-[#0F172A]">{service.name}</td>
                      <td className="px-2 py-2 font-semibold tabular-nums text-[#475569]">{service.count}</td>
                      <td className="px-2 py-2 font-semibold tabular-nums text-[#475569]">{tenge(service.pricedMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </PageLayout>
  );
}

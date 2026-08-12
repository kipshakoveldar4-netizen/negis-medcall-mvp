import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { PageLayout } from "@/components/layout/PageLayout";
import { crmFetch } from "@/lib/api";
import { PLAN_KEYS, PLANS, formatMinor, type PlanKey } from "../../../../lib/billing/plans";

// Панель владельца платформы Medina: подключённые клиники и выручка.
//
// Единственный экран, который читает поперёк клиник. Доступ к нему решает не
// роль в базе — её владелец клиники может назначить себе, — а список
// идентификаторов в переменной окружения на стороне сервера. Здесь, в браузере,
// проверять нечего: если сервер не считает вас владельцем платформы, маршрут
// отвечает 404, и экран честно говорит, что панели нет.
//
// Сумм, посчитанных в коде, на этом экране нет ни одной. Выручка складывается
// из строк подписок; нет строк — ноль, а не правдоподобное число.

type Clinic = {
  id: string;
  name: string;
  ownerEmail: string;
  createdAt: string;
  plan: string;
  subscriptionStatus: string;
  priceMinor: number;
  currency: string;
  billingPeriod: string;
  monthlyMinor: number;
  // null — «не смог посчитать», а не ноль. Мёртвая клиника и сбой чтения
  // выглядят одинаково только если их сложить в одно число.
  staffCount: number | null;
  leadCount: number | null;
  appointmentCount: number | null;
};

type Totals = {
  clinics: number;
  withSubscription: number;
  paying: number;
  currency: string;
  mixedCurrencies: boolean;
  monthlyRevenueMinor: number;
};

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="neu-card p-5">
      <p className="text-xs font-black uppercase tracking-[0.1em] text-[#94A3B8]">{label}</p>
      <p className="mt-2 text-2xl font-black text-[#0F172A]">{value}</p>
      {hint ? <p className="mt-1 text-xs font-semibold text-[#64748B]">{hint}</p> : null}
    </div>
  );
}

/** Заголовок страницы: PageLayout принимает только содержимое. */
function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="negis-glass-hero p-5 sm:p-6">
      <h1 className="text-xl font-black text-[#0F172A] sm:text-2xl">{title}</h1>
      {subtitle ? <p className="mt-2 text-sm font-semibold leading-relaxed text-[#475569]">{subtitle}</p> : null}
    </header>
  );
}

export default function PlatformOwnerPage() {
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "forbidden" | "error">("loading");
  const [editing, setEditing] = useState<string>("");
  const [plan, setPlan] = useState<PlanKey>("basic");
  const [price, setPrice] = useState("");
  const [period, setPeriod] = useState<"monthly" | "yearly">("monthly");
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const response = await crmFetch("/api/crm/platform-overview");
      if (response.status === 404) {
        setState("forbidden");
        return;
      }
      if (!response.ok) {
        setState("error");
        return;
      }
      const body = await response.json();
      setClinics(Array.isArray(body?.data?.clinics) ? body.data.clinics : []);
      setTotals(body?.data?.totals || null);
      setState("ready");
    } catch {
      setState("error");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function startEditing(clinic: Clinic) {
    setEditing(clinic.id);
    const nextPlan = (PLAN_KEYS as readonly string[]).includes(clinic.plan) ? (clinic.plan as PlanKey) : "basic";
    setPlan(nextPlan);

    // Период берётся у самой подписки, а не назначается формой.
    //
    // Прежде форма всегда отправляла monthly. У клиники на годовой подписке
    // price_minor — годовая сумма, и правка тарифа превращала её в месячную по
    // годовой цене: выручка платформы вырастала в двенадцать раз одним нажатием.
    const nextPeriod = clinic.billingPeriod === "yearly" ? "yearly" : "monthly";
    setPeriod(nextPeriod);

    // Уже назначенная цена показывается как есть, включая ноль: бесплатный
    // доступ существует и подставлять поверх него прайс нельзя. Подсказка из
    // тарифа берётся только когда подписки нет вовсе.
    const assigned = clinic.plan ? clinic.priceMinor : PLANS[nextPlan].suggestedMonthlyMinor;
    setPrice(String(Math.trunc(assigned / 100)));
  }

  async function saveSubscription(clinicId: string) {
    const typed = price.replace(/\s/g, "");
    // Пустое поле — это не ноль: Number("") равен нулю, и подписка сохранялась
    // бы бесплатной с зелёным сообщением об успехе.
    if (!typed) {
      toast.error("Укажите цену. Ноль — законное значение, но его нужно ввести явно.");
      return;
    }
    const whole = Number(typed);
    if (!Number.isFinite(whole) || whole < 0) {
      toast.error("Цена должна быть неотрицательным числом");
      return;
    }
    setSaving(true);
    try {
      const response = await crmFetch("/api/crm/platform-subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: clinicId,
          plan,
          priceMinor: Math.round(whole * 100),
          billingPeriod: period,
          currency: "KZT",
        }),
      });
      if (!response.ok) throw new Error(String(response.status));
      toast.success("Подписка сохранена");
      setEditing("");
      await load();
    } catch {
      toast.error("Не удалось сохранить подписку");
    } finally {
      setSaving(false);
    }
  }

  if (state === "loading") {
    return (
      <PageLayout>
      <PageHeader title="Платформа" />
        <div className="flex items-center gap-2 text-sm font-semibold text-[#64748B]">
          <Loader2 className="animate-spin" size={16} /> Читаю клиники…
        </div>
      </PageLayout>
    );
  }

  if (state === "forbidden") {
    return (
      <PageLayout>
      <PageHeader title="Страница не найдена" />
        <p className="text-sm font-semibold text-[#475569]">Такой страницы нет.</p>
      </PageLayout>
    );
  }

  if (state === "error") {
    return (
      <PageLayout>
      <PageHeader title="Платформа" />
        <p className="text-sm font-semibold text-rose-700">
          Не удалось прочитать список клиник. Это отказ чтения, а не «клиник нет» — цифры показывать не буду.
        </p>
      </PageLayout>
    );
  }

  const currency = totals?.currency || "KZT";

  return (
    <PageLayout>
      <PageHeader title="Платформа Medina" subtitle="Подключённые клиники и выручка платформы." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Клиник" value={String(totals?.clinics ?? 0)} />
        <Metric label="С подпиской" value={String(totals?.withSubscription ?? 0)} />
        <Metric label="Платящих" value={String(totals?.paying ?? 0)} />
        <Metric
          label="Выручка в месяц"
          value={totals?.mixedCurrencies ? "—" : formatMinor(totals?.monthlyRevenueMinor ?? 0, currency)}
          hint={
            totals?.mixedCurrencies
              ? "У клиник разные валюты — складывать их нельзя"
              : "Сумма действующих подписок, годовые приведены к месяцу"
          }
        />
      </div>

      <section className="mt-8">
        <h2 className="text-lg font-black text-[#0F172A]">Клиники</h2>
        {clinics.length === 0 ? (
          <p className="mt-3 text-sm font-semibold text-[#64748B]">Клиник пока нет.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[880px] border-separate border-spacing-y-2 text-sm">
              <thead>
                <tr className="text-left text-xs font-black uppercase tracking-[0.1em] text-[#94A3B8]">
                  <th className="px-4 py-2">Клиника</th>
                  <th className="px-4 py-2">Тариф</th>
                  <th className="px-4 py-2">В месяц</th>
                  <th className="px-4 py-2">Сотрудники</th>
                  <th className="px-4 py-2">Заявки</th>
                  <th className="px-4 py-2">Записи</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {clinics.map((clinic) => (
                  <tr key={clinic.id} className="rounded-2xl bg-white/70">
                    <td className="px-4 py-3">
                      <p className="font-black text-[#0F172A]">{clinic.name}</p>
                      <p className="text-xs font-semibold text-[#64748B]">{clinic.ownerEmail || "почта не указана"}</p>
                    </td>
                    <td className="px-4 py-3 font-semibold text-[#334155]">
                      {clinic.plan ? PLANS[clinic.plan as PlanKey]?.title || clinic.plan : "нет подписки"}
                    </td>
                    <td className="px-4 py-3 font-semibold text-[#334155]">
                      {clinic.plan ? formatMinor(clinic.monthlyMinor, clinic.currency) : "—"}
                    </td>
                    <td className="px-4 py-3 font-semibold text-[#334155]">{clinic.staffCount ?? "—"}</td>
                    <td className="px-4 py-3 font-semibold text-[#334155]">{clinic.leadCount ?? "—"}</td>
                    <td className="px-4 py-3 font-semibold text-[#334155]">{clinic.appointmentCount ?? "—"}</td>
                    <td className="px-4 py-3">
                      <button type="button" className="neu-btn text-sm" onClick={() => startEditing(clinic)}>
                        {clinic.plan ? "Изменить" : "Назначить"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing ? (
        <section className="mt-6 neu-card p-5">
          <h3 className="text-base font-black text-[#0F172A]">Подписка клиники</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <label className="text-sm font-semibold text-[#334155]">
              Тариф
              <select
                className="neu-input mt-1 w-full"
                value={plan}
                onChange={(event) => {
                  const next = event.target.value as PlanKey;
                  setPlan(next);
                  // Подсказка тарифа — месячная. При годовом периоде подставлять
                  // её в поле нельзя: получилась бы годовая цена, равная месячной.
                  if (period === "monthly") setPrice(String(Math.trunc(PLANS[next].suggestedMonthlyMinor / 100)));
                }}
              >
                {PLAN_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {PLANS[key].title}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-semibold text-[#334155]">
              Период
              <select
                className="neu-input mt-1 w-full"
                value={period}
                onChange={(event) => setPeriod(event.target.value === "yearly" ? "yearly" : "monthly")}
              >
                <option value="monthly">Помесячно</option>
                <option value="yearly">За год</option>
              </select>
            </label>
            <label className="text-sm font-semibold text-[#334155]">
              {period === "yearly" ? "Цена за год, ₸" : "Цена в месяц, ₸"}
              <input className="neu-input mt-1 w-full" value={price} onChange={(event) => setPrice(event.target.value)} />
            </label>
            <div className="flex items-end gap-2">
              <button
                type="button"
                className="neu-btn-primary justify-center"
                disabled={saving}
                onClick={() => void saveSubscription(editing)}
              >
                {saving ? <Loader2 className="animate-spin" size={16} /> : null}
                Сохранить
              </button>
              <button type="button" className="neu-btn justify-center" onClick={() => setEditing("")}>
                Отмена
              </button>
            </div>
          </div>
          <p className="mt-3 text-xs font-semibold text-[#64748B]">
            {PLANS[plan].summary} Цена подставлена как подсказка — сохранится то, что стоит в поле.
          </p>
        </section>
      ) : null}
    </PageLayout>
  );
}

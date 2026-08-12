import { useEffect, useMemo, useState } from "react";

import { crmFetch } from "@/lib/api";
import { PLAN_KEYS, PLANS, formatMinor, type PlanKey } from "../../../../../lib/billing/plans";

// Тариф клиники и калькулятор стоимости.
//
// В кабинете стоял блок «Пилотное подключение» с одной фразой про то, что
// условия согласуются с менеджером. Тарифов на экране не было вовсе: их ключи
// жили во фронтенде, цен не было нигде, и клиника не могла узнать, за что и
// сколько платит.
//
// Что здесь показано и откуда взято:
//
// ТЕКУЩИЙ ТАРИФ — из строки подписки этой клиники (/api/crm/subscription).
// Нет строки — так и написано: «тариф не назначен». Подставить сюда цену из
// прайса значило бы показать счёт, которого никто не выставлял.
//
// ЦЕНЫ В СЕТКЕ — прайс продукта. Это не то же самое, что счёт клиники: у неё
// может быть особое условие, и тогда её цена берётся из подписки, а не отсюда.
//
// КАЛЬКУЛЯТОР считает только нашу часть счёта. Расходы на Wazzup и рекламный
// бюджет Meta вводит оператор: это чужие тарифы, они меняются без нашего
// ведома, и вписывать их в продукт значило бы утверждать чужие цены как свои.

type Subscription = {
  plan?: string;
  status?: string;
  price_minor?: number;
  currency?: string;
  billing_period?: string;
};

type ReadState = "loading" | "ready" | "error";

function readNumber(value: string): number {
  const parsed = Number(value.replace(/\s/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function PlanCalculator() {
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [state, setState] = useState<ReadState>("loading");

  const [plan, setPlan] = useState<PlanKey>("standard");
  const [months, setMonths] = useState("12");
  const [wazzup, setWazzup] = useState("");
  const [adBudget, setAdBudget] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await crmFetch("/api/crm/subscription");
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json();
        if (cancelled) return;
        const found = (body?.data?.subscription || null) as Subscription | null;
        setSubscription(found);
        if (found?.plan && (PLAN_KEYS as readonly string[]).includes(found.plan)) setPlan(found.plan as PlanKey);
        setState("ready");
      } catch {
        // Отказ чтения — не «тарифа нет». Второе клиника прочитала бы как
        // «нам ничего не выставлено», и это была бы неправда о её же счёте.
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const definition = PLANS[plan];

  // Своя часть счёта: цена подписки, если она назначена, иначе прайс.
  const monthlyMinor = useMemo(() => {
    const assigned = subscription?.plan === plan ? Number(subscription?.price_minor) : NaN;
    if (Number.isFinite(assigned)) {
      return subscription?.billing_period === "yearly" ? Math.trunc(assigned / 12) : assigned;
    }
    return definition.suggestedMonthlyMinor;
  }, [plan, subscription, definition]);

  const monthCount = Math.max(1, Math.trunc(readNumber(months) || 1));
  const ownTotal = monthlyMinor * monthCount;
  const externalMonthly = Math.round((readNumber(wazzup) + readNumber(adBudget)) * 100);
  const grandTotal = ownTotal + externalMonthly * monthCount;

  return (
    <section className="neu-card" aria-label="Тариф и стоимость">
      <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#64748B]">Тариф и стоимость</p>

      {state === "loading" ? (
        <p className="mt-2 text-sm text-[#64748B]">Читаю тариф…</p>
      ) : state === "error" ? (
        <p className="mt-2 text-sm font-semibold text-rose-700">
          Не удалось прочитать тариф. Это отказ чтения, а не «тариф не назначен» — цифру показывать не буду.
        </p>
      ) : subscription?.plan ? (
        <h2 className="mt-1 text-base font-black text-[#0F172A]">
          {PLANS[subscription.plan as PlanKey]?.title || subscription.plan} ·{" "}
          {formatMinor(Number(subscription.price_minor) || 0, subscription.currency || "KZT")}
          {subscription.billing_period === "yearly" ? " за год" : " в месяц"}
        </h2>
      ) : (
        <>
          <h2 className="mt-1 text-base font-black text-[#0F172A]">Тариф не назначен</h2>
          <p className="mt-1 text-sm text-[#64748B]">
            Условия согласуются с менеджером Medina OS. Ниже — прайс продукта и расчёт стоимости.
          </p>
        </>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {PLAN_KEYS.map((key) => {
          const item = PLANS[key];
          const current = subscription?.plan === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setPlan(key)}
              className={`rounded-2xl border p-4 text-left ${
                plan === key ? "border-[#0F172A] bg-white" : "border-[#D8E4EC] bg-white/65"
              }`}
            >
              <p className="text-sm font-black text-[#0F172A]">
                {item.title}
                {current ? " · ваш" : ""}
              </p>
              <p className="mt-1 text-lg font-black text-[#0F172A]">{formatMinor(item.suggestedMonthlyMinor, item.currency)}</p>
              <p className="text-xs font-semibold text-[#64748B]">в месяц</p>
              <ul className="mt-2 space-y-1 text-xs font-semibold text-[#475569]">
                {item.includes.slice(0, 4).map((line) => (
                  <li key={line}>— {line}</li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>

      <p className="mt-3 text-xs font-semibold text-[#64748B]">
        {definition.summary}{" "}
        {definition.limits.images > 0
          ? `Изображений в месяц: ${definition.limits.images}.`
          : "Генерация изображений на этом тарифе не входит."}{" "}
        {definition.limits.videoSeconds > 0 ? `Видео: ${definition.limits.videoSeconds} секунд в месяц.` : ""}
      </p>

      <div className="mt-5 rounded-2xl border border-[#D8E4EC] bg-white/65 p-4">
        <p className="text-xs font-black uppercase tracking-[0.1em] text-[#64748B]">Расчёт стоимости</p>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="text-sm font-semibold text-[#334155]">
            Месяцев
            <input className="neu-input mt-1 w-full" value={months} onChange={(event) => setMonths(event.target.value)} />
          </label>
          {/*
            Расходы на Wazzup и рекламу вводит оператор, а не подставляет
            продукт. Это чужие тарифы: они меняются без нашего ведома, и
            вписать их сюда числом значило бы утверждать чужую цену как свою.
          */}
          <label className="text-sm font-semibold text-[#334155]">
            Wazzup в месяц, ₸
            <input
              className="neu-input mt-1 w-full"
              placeholder="по счёту вендора"
              value={wazzup}
              onChange={(event) => setWazzup(event.target.value)}
            />
          </label>
          <label className="text-sm font-semibold text-[#334155]">
            Реклама в месяц, ₸
            <input
              className="neu-input mt-1 w-full"
              placeholder="ваш бюджет"
              value={adBudget}
              onChange={(event) => setAdBudget(event.target.value)}
            />
          </label>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div>
            <p className="text-xs font-semibold text-[#64748B]">Medina за {monthCount} мес.</p>
            <p className="text-lg font-black text-[#0F172A]">{formatMinor(ownTotal)}</p>
          </div>
          <div>
            <p className="text-xs font-semibold text-[#64748B]">Сторонние сервисы</p>
            <p className="text-lg font-black text-[#0F172A]">{formatMinor(externalMonthly * monthCount)}</p>
          </div>
          <div>
            <p className="text-xs font-semibold text-[#64748B]">Всего</p>
            <p className="text-lg font-black text-[#0F172A]">{formatMinor(grandTotal)}</p>
          </div>
        </div>

        <p className="mt-3 text-xs font-semibold leading-relaxed text-[#64748B]">
          Wazzup и рекламный бюджет Meta оплачиваются напрямую вендорам и в тариф Medina не входят — впишите свои
          суммы, чтобы увидеть счёт целиком. Автоматической оплаты в продукте нет: тариф назначает менеджер.
        </p>
      </div>
    </section>
  );
}

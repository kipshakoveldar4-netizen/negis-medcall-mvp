import { useEffect, useRef, useState } from "react";
import { controlFetch } from "../lib/api";
import { PLAN_KEYS, PLANS, formatMinor, type PlanKey } from "../../../../lib/billing/plans";

// Обзор платформы: клиники, подписки, выручка. Логика назначения подписки
// перенесена из страницы /platform внутри CRM один в один — включая уроки,
// оплаченные багами: период берётся у подписки, а не у формы; пустая цена не
// превращается в ноль; причина отказа сервера показывается словами.

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
  // null — «не смог посчитать», а не ноль: сбой чтения не притворяется пустотой.
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

export function Overview({ onOpenClinic }: { onOpenClinic: (id: string) => void }) {
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "forbidden" | "error">("loading");
  const [editing, setEditing] = useState("");
  const [plan, setPlan] = useState<PlanKey>("basic");
  const [price, setPrice] = useState("");
  const [period, setPeriod] = useState<"monthly" | "yearly">("monthly");
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function load() {
    try {
      const response = await controlFetch("/api/crm/platform-overview");
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
    setFlash(null);
    setEditing(clinic.id);
    const nextPlan = (PLAN_KEYS as readonly string[]).includes(clinic.plan) ? (clinic.plan as PlanKey) : "basic";
    setPlan(nextPlan);
    // Период — у самой подписки: форма, всегда шлющая monthly, однажды
    // превратила годовую цену в месячную и раздула выручку в двенадцать раз.
    const nextPeriod = clinic.billingPeriod === "yearly" ? "yearly" : "monthly";
    setPeriod(nextPeriod);
    // Назначенная цена показывается как есть, включая ноль; подсказка тарифа —
    // только когда подписки нет вовсе.
    const assigned = clinic.plan ? clinic.priceMinor : PLANS[nextPlan].suggestedMonthlyMinor;
    setPrice(String(Math.trunc(assigned / 100)));
  }

  async function saveSubscription(clinicId: string) {
    const typed = price.replace(/\s/g, "");
    // Пустое поле — не ноль: Number("") равен нулю, и подписка молча стала бы бесплатной.
    if (!typed) {
      setFlash({ kind: "error", text: "Укажите цену. Ноль — законное значение, но его нужно ввести явно." });
      return;
    }
    const whole = Number(typed);
    if (!Number.isFinite(whole) || whole < 0) {
      setFlash({ kind: "error", text: "Цена должна быть неотрицательным числом." });
      return;
    }
    setSaving(true);
    setFlash(null);
    try {
      const response = await controlFetch("/api/crm/platform-subscriptions", {
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
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        // Сервер называет причину — прятать её за общим «не удалось» нельзя.
        const reason = [body?.error, ...(Array.isArray(body?.details) ? body.details : [])]
          .filter(Boolean)
          .join(" ");
        setFlash({ kind: "error", text: reason || "Не удалось сохранить подписку" });
        return;
      }
      setFlash({ kind: "ok", text: "Подписка сохранена" });
      setEditing("");
      await load();
    } catch {
      setFlash({ kind: "error", text: "Сеть не ответила — подписка не сохранена" });
    } finally {
      setSaving(false);
    }
  }

  const editingClinic = clinics.find((clinic) => clinic.id === editing) || null;
  const editorRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (editing) editorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [editing]);

  if (state === "loading") {
    return <p className="muted">Читаю клиники…</p>;
  }

  if (state === "forbidden") {
    // Сервер ответил 404: этот аккаунт — не владелец платформы, либо сессия
    // истекла — платформенные маршруты отвечают одинаково на оба случая,
    // чтобы не выдавать существования панели. Портал не рассказывает больше.
    return (
      <>
        <h1 className="page-title">Страница не найдена</h1>
        <p className="page-sub">Такой страницы нет. Если вы владелец платформы — выйдите и войдите снова.</p>
      </>
    );
  }

  if (state === "error") {
    return (
      <>
        <h1 className="page-title">Платформа</h1>
        <div className="notice error">
          Не удалось прочитать список клиник. Это отказ чтения, а не «клиник нет» — цифры показывать не буду.
        </div>
      </>
    );
  }

  const currency = totals?.currency || "KZT";

  return (
    <>
      <h1 className="page-title">Платформа Medina</h1>
      <p className="page-sub">Подключённые клиники и выручка платформы.</p>

      <div className="metrics">
        <div className="metric"><div className="l">Клиник</div><div className="v">{totals?.clinics ?? 0}</div></div>
        <div className="metric"><div className="l">С подпиской</div><div className="v">{totals?.withSubscription ?? 0}</div></div>
        <div className="metric"><div className="l">Платящих</div><div className="v">{totals?.paying ?? 0}</div></div>
        <div className="metric">
          <div className="l">Выручка в месяц</div>
          <div className="v">{totals?.mixedCurrencies ? "—" : formatMinor(totals?.monthlyRevenueMinor ?? 0, currency)}</div>
          <div className="h">
            {totals?.mixedCurrencies
              ? "У клиник разные валюты — складывать их нельзя"
              : "Сумма действующих подписок, годовые приведены к месяцу"}
          </div>
        </div>
      </div>

      {flash ? <div className={`notice ${flash.kind}`}>{flash.text}</div> : null}

      <section className="panel">
        <div className="panel-title">Клиники</div>
        {clinics.length === 0 ? (
          <p className="muted" style={{ padding: "10px 18px 16px" }}>Клиник пока нет.</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Клиника</th>
                  <th>Создана</th>
                  <th>Тариф</th>
                  <th>В месяц</th>
                  <th>Сотрудники</th>
                  <th>Заявки</th>
                  <th>Записи</th>
                  <th aria-label="Действия" />
                </tr>
              </thead>
              <tbody>
                {clinics.map((clinic) => (
                  <tr key={clinic.id}>
                    <td>
                      {/* Имя ведёт в карточку клиники: активность, модули, сигналы. */}
                      <button type="button" className="linklike cell-main" onClick={() => onOpenClinic(clinic.id)}>
                        {clinic.name}
                      </button>
                      <div className="cell-sub">{clinic.ownerEmail || "почта не указана"}</div>
                    </td>
                    <td className="num">{clinic.createdAt.slice(0, 10) || "—"}</td>
                    <td>{clinic.plan ? PLANS[clinic.plan as PlanKey]?.title || clinic.plan : <span className="muted">нет подписки</span>}</td>
                    <td className="num">{clinic.plan ? formatMinor(clinic.monthlyMinor, clinic.currency) : "—"}</td>
                    <td className="num">{clinic.staffCount ?? "—"}</td>
                    <td className="num">{clinic.leadCount ?? "—"}</td>
                    <td className="num">{clinic.appointmentCount ?? "—"}</td>
                    <td>
                      <button type="button" className="btn" onClick={() => startEditing(clinic)}>
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
        <section ref={editorRef} className="editor">
          <h3>Подписка клиники{editingClinic ? ` — ${editingClinic.name}` : ""}</h3>
          {editingClinic ? (
            <p className="sub">
              {editingClinic.ownerEmail || "почта не указана"} · создана {editingClinic.createdAt.slice(0, 10) || "—"}
            </p>
          ) : null}
          <div className="fields">
            <div className="field">
              <label htmlFor="plan">Тариф</label>
              <select
                id="plan"
                value={plan}
                onChange={(event) => {
                  const next = event.target.value as PlanKey;
                  setPlan(next);
                  // Подсказка тарифа — месячная; при годовом периоде её
                  // подставлять нельзя: вышла бы годовая цена, равная месячной.
                  if (period === "monthly") setPrice(String(Math.trunc(PLANS[next].suggestedMonthlyMinor / 100)));
                }}
              >
                {PLAN_KEYS.map((key) => (
                  <option key={key} value={key}>{PLANS[key].title}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="period">Период</label>
              <select id="period" value={period} onChange={(event) => setPeriod(event.target.value === "yearly" ? "yearly" : "monthly")}>
                <option value="monthly">Помесячно</option>
                <option value="yearly">За год</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="price">{period === "yearly" ? "Цена за год, ₸" : "Цена в месяц, ₸"}</label>
              <input id="price" inputMode="numeric" value={price} onChange={(event) => setPrice(event.target.value)} />
            </div>
            <div className="actions">
              <button type="button" className="btn-primary" disabled={saving} onClick={() => void saveSubscription(editing)}>
                {saving ? "Сохраняю…" : "Сохранить"}
              </button>
              <button type="button" className="btn" onClick={() => setEditing("")}>Отмена</button>
            </div>
          </div>
          <p className="hint">{PLANS[plan].summary} Цена подставлена как подсказка — сохранится то, что стоит в поле.</p>
        </section>
      ) : null}
    </>
  );
}

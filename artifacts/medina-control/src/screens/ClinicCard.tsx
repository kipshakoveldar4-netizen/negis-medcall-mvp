import { useEffect, useRef, useState } from "react";
import { controlFetch } from "../lib/api";
import { formatMinor, PLANS, type PlanKey } from "../../../../lib/billing/plans";
import { capitalize, termsFor, readVertical } from "../../../../lib/vertical/terms";

// Карточка клиники: активность по неделям, статус модулей и сигналы здоровья.
//
// Правила сигналов живут на сервере (lib/crm/clinic-signals.ts) и приходят
// структурой {key, level, data} — здесь только слова. Слова зависят от ниши:
// у клиники «врачей», у салона «мастеров», и словарь для этого один на весь
// продукт. null в любом счётчике показывается прочерком: «не смог посчитать»
// не притворяется нулём.

type Weekly = { from: string; to: string; leads: number | null; appointments: number | null };
type Signal = { key: string; level: "ok" | "warn"; data: Record<string, number> };

type Card = {
  clinic: {
    id: string;
    name: string;
    ownerEmail: string;
    createdAt: string;
    vertical: string;
    timeZone: string;
    plan: string;
    subscriptionStatus: string;
    monthlyMinor: number;
    currency: string;
    billingPeriod: string;
  };
  counts: {
    staff: number | null;
    doctors: number | null;
    doctorsWithSchedule: number | null;
    services: number | null;
    whatsappChannels: number | null;
    clients: number | null;
  };
  weekly: Weekly[];
  signals: Signal[];
};

function signalText(signal: Signal, vertical: ReturnType<typeof readVertical>): { title: string; why: string } {
  const terms = termsFor(vertical);
  const d = signal.data;
  switch (signal.key) {
    case "no_appointments_7d":
      return { title: "Новых записей нет 7 дней", why: "За неделю не заведено ни одной записи — возможно, продуктом не пользуются." };
    case "appointments_flowing":
      return { title: "Записи ведутся", why: `${d.count} новых за 7 дней.` };
    case "no_leads_7d":
      return { title: "Заявок нет 7 дней", why: "Ни одной новой заявки за неделю. Стоит посмотреть каналы притока: рекламу и WhatsApp." };
    case "leads_flowing":
      return { title: "Заявки приходят", why: `${d.count} за 7 дней.` };
    case "timezone_missing":
      return { title: "Часовой пояс не задан", why: "График при записи не применяется, «сегодня» на сводке может считаться неверно." };
    case "no_specialists":
      return { title: `Справочник ${terms.specialistGenitivePlural} пуст`, why: "Запись работает свободным текстом: график и ёмкость не применяются." };
    case "schedule_incomplete":
      return {
        title: `График заполнен у ${d.have} из ${d.total} ${terms.specialistGenitivePlural}`,
        why: "Запись к остальным ничем не ограничена — возможны накладки по времени.",
      };
    case "schedule_complete":
      return { title: "График заполнен у всех", why: `${capitalize(terms.specialistPlural)} с расписанием: ${d.total}.` };
    case "no_services":
      return { title: "Прайс пуст", why: "Справочник услуг не заполнен — услуги в записях и продажах набираются текстом." };
    case "no_subscription":
      return { title: "Подписки нет", why: "Тариф не назначен или подписка не активна. Назначить можно на «Обзоре»." };
    case "whatsapp_disconnected":
      return { title: "WhatsApp не подключён", why: "Заявки из WhatsApp не попадают в CRM." };
    case "whatsapp_connected":
      return { title: "WhatsApp подключён", why: "Канал приёма заявок работает." };
    default:
      // Неизвестный сигнал с сервера новее портала — честно показать ключ,
      // а не спрятать: владелец увидит, что порталу пора обновиться.
      return { title: signal.key, why: "" };
  }
}

function numberOrDash(value: number | null): string {
  return value === null ? "—" : String(value);
}

function weekLabel(range: Weekly): string {
  // По-русски: «с 15 авг», а не машинное ММ-ДД, которое читается как день-месяц.
  return new Date(range.from).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

/** Чипу нужно ТРИ состояния: «не смог посчитать» — не то же, что «выключен». */
function chipState(value: number | null): "on" | "off" | "unknown" {
  if (value === null) return "unknown";
  return value > 0 ? "on" : "off";
}

export function ClinicCard({ workspaceId, onBack }: { workspaceId: string; onBack: () => void }) {
  const [card, setCard] = useState<Card | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  // Смена экрана роняет фокус в body: нажатая кнопка размонтировалась вместе
  // со списком. Клавиатура и скринридер продолжают с заголовка карточки.
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (state === "ready") titleRef.current?.focus();
  }, [state]);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    void (async () => {
      try {
        const response = await controlFetch(`/api/crm/platform-clinic?workspaceId=${encodeURIComponent(workspaceId)}`);
        const body = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok || !body?.data) {
          setState("error");
          return;
        }
        setCard(body.data as Card);
        setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  if (state === "loading") return <p className="muted" role="status">Читаю карточку клиники…</p>;
  if (state === "error" || !card) {
    return (
      <>
        <button type="button" className="btn" onClick={onBack}>← Обзор</button>
        <div className="notice error" style={{ marginTop: 12 }}>
          Не удалось прочитать карточку. Это отказ чтения, а не «данных нет».
        </div>
      </>
    );
  }

  const vertical = readVertical(card.clinic.vertical);
  const terms = termsFor(vertical);
  const planTitle = card.clinic.plan ? PLANS[card.clinic.plan as PlanKey]?.title || card.clinic.plan : "нет подписки";
  const warns = card.signals.filter((signal) => signal.level === "warn");

  // Высота столбиков — от максимума по обеим сериям, чтобы недели сравнивались
  // друг с другом честно. Нет данных — нет столбика, есть прочерк.
  const weekly = [...card.weekly].reverse();
  const maxCount = Math.max(1, ...weekly.flatMap((week) => [week.leads ?? 0, week.appointments ?? 0]));

  return (
    <>
      <button type="button" className="btn" onClick={onBack}>← Обзор</button>
      <h1 ref={titleRef} tabIndex={-1} className="page-title" style={{ marginTop: 14 }}>{card.clinic.name}</h1>
      <p className="page-sub">
        {vertical === "beauty" ? "салон красоты" : "клиника"} · {card.clinic.ownerEmail || "почта не указана"} ·{" "}
        {card.clinic.plan
          ? `${planTitle} · ${formatMinor(card.clinic.monthlyMinor, card.clinic.currency)}/мес`
          : "подписка не назначена"}
      </p>

      <div className="metrics">
        <div className="metric"><div className="l">Заявки, 7 дн</div><div className="v">{numberOrDash(card.weekly[0]?.leads ?? null)}</div></div>
        <div className="metric"><div className="l">Записи, 7 дн</div><div className="v">{numberOrDash(card.weekly[0]?.appointments ?? null)}</div></div>
        <div className="metric"><div className="l">Сотрудники</div><div className="v">{numberOrDash(card.counts.staff)}</div></div>
        <div className="metric"><div className="l">{capitalize(terms.specialistPlural)}</div><div className="v">{numberOrDash(card.counts.doctors)}</div></div>
        <div className="metric"><div className="l">Клиенты</div><div className="v">{numberOrDash(card.counts.clients)}</div></div>
      </div>

      <section className="panel" style={{ padding: "16px 18px", marginBottom: 16 }}>
        {/* «Всё в порядке» имеет право звучать только когда сигналы посчитаны:
            пустой список — это «не посчитаны», а не вердикт. */}
        <h2 className="section-title">
          Сигналы{card.signals.length === 0 ? " · не посчитаны" : warns.length > 0 ? ` · ${warns.length} требуют внимания` : " · всё в порядке"}
        </h2>
        {card.signals.length === 0 ? (
          <p className="muted">Посчитать сигналы не удалось — данных для правил нет.</p>
        ) : (
          card.signals.map((signal) => {
            const text = signalText(signal, vertical);
            return (
              <div key={signal.key} className={`signal ${signal.level}`}>
                <span className="bar" />
                <span>
                  <b>{text.title}</b>
                  {text.why ? <span className="why">{text.why}</span> : null}
                </span>
              </div>
            );
          })
        )}
      </section>

      <div className="two-col">
        <section className="panel" style={{ padding: "16px 18px" }}>
          <h2 className="section-title">Активность по неделям</h2>
          <p className="muted" style={{ fontSize: 12.5, margin: "0 0 10px" }}>
            Сколько заявок и записей завели за каждую из четырёх последних недель.
          </p>
          <div className="weeks">
            {weekly.map((week) => (
              <div key={week.from} className="week">
                <div className="week-bars">
                  {/* null — не ноль: вместо столбика рисуется пунктирная
                      заглушка, визуально отличная от честного нуля. */}
                  {week.leads === null ? (
                    <div className="week-bar nodata" title="заявки: не удалось посчитать" />
                  ) : (
                    <div className="week-bar leads" style={{ height: `${Math.round((week.leads / maxCount) * 64)}px` }} title={`заявки: ${week.leads}`} />
                  )}
                  {week.appointments === null ? (
                    <div className="week-bar nodata" title="записи: не удалось посчитать" />
                  ) : (
                    <div className="week-bar appts" style={{ height: `${Math.round((week.appointments / maxCount) * 64)}px` }} title={`записи: ${week.appointments}`} />
                  )}
                </div>
                <div className="week-nums">{numberOrDash(week.leads)} / {numberOrDash(week.appointments)}</div>
                <div className="week-label">с {weekLabel(week)}</div>
              </div>
            ))}
          </div>
          <p className="legend"><span className="dot leads" /> заявки · <span className="dot appts" /> записи</p>
        </section>

        <section className="panel" style={{ padding: "16px 18px" }}>
          <h2 className="section-title">Модули</h2>
          <div className="chips">
            <span className={`chip ${chipState(card.counts.whatsappChannels)}`}>WhatsApp: {(card.counts.whatsappChannels ?? 0) > 0 ? "подключён" : card.counts.whatsappChannels === null ? "—" : "нет"}</span>
            <span className={`chip ${card.clinic.timeZone ? "on" : "off"}`}>Часовой пояс: {card.clinic.timeZone || "не задан"}</span>
            <span className={`chip ${chipState(card.counts.doctors)}`}>{capitalize(terms.specialistPlural)}: {numberOrDash(card.counts.doctors)}</span>
            <span className={`chip ${chipState(card.counts.doctorsWithSchedule)}`}>С графиком: {numberOrDash(card.counts.doctorsWithSchedule)}</span>
            <span className={`chip ${chipState(card.counts.services)}`}>Услуги в прайсе: {numberOrDash(card.counts.services)}</span>
            <span className={`chip ${card.clinic.subscriptionStatus === "active" ? "on" : "off"}`}>Подписка: {card.clinic.subscriptionStatus === "active" ? planTitle : "нет"}</span>
          </div>
          <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>
            Прочерк — «не удалось посчитать», а не ноль.
          </p>
        </section>
      </div>
    </>
  );
}

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
type AccessStaff = { email: string; role: string; status: string; linked: boolean };
type AccessInvitation = { email: string; role: string; status: string; createdAt: string; expiresAt: string };

/** История приглашений: живые все; завершённые — свежайшее ПО КАЖДОЙ почте
    (не просто последние по дате: иначе истёкшее приглашение администратора,
    ради диагностики которого раздел существует, вытеснялось бы тремя чужими),
    максимум пять. */
function visibleInvitations(invitations: AccessInvitation[]): { shown: AccessInvitation[]; hidden: number } {
  const pending = invitations.filter((invitation) => invitation.status === "pending");
  const finished = invitations.filter((invitation) => invitation.status !== "pending");
  const seenEmails = new Set<string>();
  const latestPerEmail: AccessInvitation[] = [];
  for (const invitation of finished) {
    const key = invitation.email.toLowerCase();
    if (seenEmails.has(key)) continue;
    seenEmails.add(key);
    latestPerEmail.push(invitation);
  }
  const shownFinished = latestPerEmail.slice(0, 5);
  return { shown: [...pending, ...shownFinished], hidden: finished.length - shownFinished.length };
}

// Слова — те же, что клиника видит у себя в «Настройки → Сотрудники»
// (roleLabels в artifacts/negis/src/lib/permissions.ts): владелец платформы и
// владелец клиники должны называть одну роль одним словом. Синхронность
// закрепляет MC16; выдуманных ролей здесь нет — только каталог продукта.
const ROLE_LABELS: Record<string, string> = {
  owner: "Владелец",
  admin: "Администратор",
  receptionist: "Ресепшн",
  marketer: "Маркетолог",
  doctor: "Врач",
  manager: "Менеджер",
};

const INVITATION_LABELS: Record<string, { label: string; cls: string }> = {
  pending: { label: "ждёт принятия", cls: "off" },
  accepted: { label: "принято", cls: "on" },
  expired: { label: "истекло", cls: "off" },
  revoked: { label: "отозвано", cls: "off" },
};

const STAFF_STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  active: { label: "активен", cls: "on" },
  inactive: { label: "отключён", cls: "off" },
};

type Card = {
  access?: {
    staff: AccessStaff[] | null;
    ownerInvitations: AccessInvitation[] | null;
    staffInvitations?: AccessInvitation[] | null;
    // null — не смог прочитать; lastAt: "" — прочитал, входов не было;
    // accountMissing — Auth ответил 404: аккаунт удалён, вход невозможен.
    ownerSignIn?: { lastAt: string; accountMissing?: boolean } | null;
  };
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

type Recommendation = {
  id: string;
  title: string;
  body: string;
  actionPath: string;
  signalKey: string;
  status: string;
  createdAt: string;
  readAt: string;
  resolvedAt: string;
};

/** Куда логично вести кнопку совета, родившегося из сигнала. */
const SIGNAL_ACTIONS: Record<string, string> = {
  no_appointments_7d: "/appointments",
  no_leads_7d: "/ads-automation",
  timezone_missing: "/staff-schedule",
  no_specialists: "/staff-schedule",
  schedule_incomplete: "/staff-schedule",
  no_services: "/services",
  whatsapp_disconnected: "/marketplace",
};

const RECO_STATUS: Record<string, { label: string; cls: string }> = {
  sent: { label: "отправлена", cls: "off" },
  read: { label: "прочитана", cls: "unknown" },
  done: { label: "сделана", cls: "on" },
  dismissed: { label: "скрыта", cls: "off" },
};

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
  // null — читаем; error — отказ чтения (не «советов нет»); иначе — данные.
  const [recos, setRecos] = useState<{ items: Recommendation[]; available: boolean } | { error: true } | null>(null);
  const [composer, setComposer] = useState<{ open: boolean; title: string; body: string; actionPath: string; signalKey: string }>(
    { open: false, title: "", body: "", actionPath: "", signalKey: "" },
  );
  const [sending, setSending] = useState(false);
  const [recoFlash, setRecoFlash] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  // Ссылка перевыпуска живёт в состоянии, а не в данных карточки: в базе
  // только хэш, второй раз её никто не покажет.
  const [reissueBusy, setReissueBusy] = useState(false);
  const [reissueLink, setReissueLink] = useState("");
  const [reissueError, setReissueError] = useState("");
  const [reissueCopied, setReissueCopied] = useState(false);

  async function loadRecommendations() {
    try {
      const response = await controlFetch(`/api/crm/platform-recommendations?workspaceId=${encodeURIComponent(workspaceId)}`);
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.data) {
        // Отказ чтения — своё состояние: вечное «Читаю…» при недоданном
        // гранте на таблицу выглядело бы как зависание без причины.
        setRecos({ error: true });
        return;
      }
      setRecos({
        items: Array.isArray(body.data.items) ? (body.data.items as Recommendation[]) : [],
        available: body.data.available !== false,
      });
    } catch {
      setRecos({ error: true });
    }
  }

  function openComposer(prefill: { title: string; body: string; signalKey: string }) {
    setRecoFlash(null);
    setComposer({
      open: true,
      title: prefill.title,
      body: prefill.body,
      actionPath: SIGNAL_ACTIONS[prefill.signalKey] || "",
      signalKey: prefill.signalKey,
    });
  }

  async function sendRecommendation() {
    if (!composer.title.trim() || !composer.body.trim()) {
      setRecoFlash({ kind: "error", text: "Нужны заголовок и текст — пустая рекомендация не несёт совета." });
      return;
    }
    setSending(true);
    setRecoFlash(null);
    try {
      const response = await controlFetch("/api/crm/platform-recommendations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          title: composer.title.trim(),
          body: composer.body.trim(),
          actionPath: composer.actionPath,
          signalKey: composer.signalKey,
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const reason = [body?.error, ...(Array.isArray(body?.details) ? body.details : [])].filter(Boolean).join(" ");
        setRecoFlash({ kind: "error", text: reason || "Не удалось отправить рекомендацию" });
        return;
      }
      setRecoFlash({ kind: "ok", text: "Рекомендация отправлена — владелец клиники увидит её в CRM." });
      setComposer({ open: false, title: "", body: "", actionPath: "", signalKey: "" });
      await loadRecommendations();
    } catch {
      setRecoFlash({ kind: "error", text: "Сеть не ответила — рекомендация не отправлена." });
    } finally {
      setSending(false);
    }
  }

  async function reissueInvitation() {
    if (reissueBusy) return;
    setReissueBusy(true);
    setReissueError("");
    try {
      const response = await controlFetch("/api/crm/platform-invitation-reissue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.success !== true || typeof body?.data?.acceptUrl !== "string") {
        // Показанная ранее ссылка убирается ПО КОДУ, а не по факту ошибки:
        // reissue_incomplete — сервер отозвал прежние приглашения, а новое не
        // выписал; owner_already_member — приглашение потеряло смысл. При
        // сетевом сбое или отказе на шаге revoke старая ссылка остаётся
        // единственной действующей, и стирать её с экрана было бы враньём.
        const code = typeof body?.code === "string" ? body.code : "";
        if (code === "reissue_incomplete" || code === "owner_already_member") {
          setReissueLink("");
          setReissueCopied(false);
          try {
            const fresh = await fetchCard();
            if (fresh) setCard(fresh);
          } catch {
            // Карточка обновится при следующем открытии.
          }
        }
        const reason = [body?.error, ...(Array.isArray(body?.details) ? body.details : [])].filter(Boolean).join(" ");
        setReissueError(reason || "Перевыпустить не удалось. Попробуйте ещё раз.");
        return;
      }
      setReissueCopied(false);
      setReissueLink(body.data.acceptUrl);
      // Список приглашений обновляется с сервера: старое стало «отозвано»,
      // новое «ждёт принятия». Сбой обновления ссылку не трогает.
      try {
        const fresh = await fetchCard();
        if (fresh) setCard(fresh);
      } catch {
        // Карточка обновится при следующем открытии.
      }
    } catch {
      setReissueError("Сеть не ответила — приглашение не перевыпущено.");
    } finally {
      setReissueBusy(false);
    }
  }

  // Привязка номера WhatsApp: заявки клиники приходят на её номер, и до сих
  // пор эта строка заводилась руками в SQL Editor.
  const [numberInput, setNumberInput] = useState("");
  const [numberBusy, setNumberBusy] = useState(false);
  const [numberFlash, setNumberFlash] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function linkWhatsappNumber() {
    if (numberBusy || !numberInput.trim()) return;
    setNumberBusy(true);
    setNumberFlash(null);
    try {
      const response = await controlFetch("/api/crm/platform-whatsapp-number", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, phoneNumberId: numberInput.trim() }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.success !== true) {
        const reason = [body?.error, ...(Array.isArray(body?.details) ? body.details : [])].filter(Boolean).join(" ");
        setNumberFlash({ kind: "error", text: reason || "Не удалось привязать номер" });
        return;
      }
      setNumberInput("");
      setNumberFlash({
        kind: "ok",
        text: body.data?.alreadyLinked
          ? "Номер уже был за этой клиникой — приём включён."
          : "Номер привязан: заявки с него будут приходить этой клинике.",
      });
      // Счётчик «WhatsApp» в чипах читается с сервера — перечитываем карточку.
      try {
        const fresh = await fetchCard();
        if (fresh) setCard(fresh);
      } catch {
        // Обновится при следующем открытии.
      }
    } catch {
      setNumberFlash({ kind: "error", text: "Сеть не ответила — неизвестно, привязался ли номер. Проверьте чип «WhatsApp» ниже." });
    } finally {
      setNumberBusy(false);
    }
  }

  // Таймер «Скопировано» один: повторный клик перезапускает его, а не
  // наслаивает второй, который погасил бы свежую подпись раньше времени.
  const copiedTimerRef = useRef<number | null>(null);

  async function copyReissueLink() {
    if (!reissueLink) return;
    try {
      await navigator.clipboard.writeText(reissueLink);
      setReissueCopied(true);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setReissueCopied(false), 2500);
    } catch {
      // Буфер недоступен — ссылка выделяется и копируется руками.
    }
  }
  // Смена экрана роняет фокус в body: нажатая кнопка размонтировалась вместе
  // со списком. Клавиатура и скринридер продолжают с заголовка карточки.
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (state === "ready") titleRef.current?.focus();
  }, [state]);

  async function fetchCard(): Promise<Card | null> {
    const response = await controlFetch(`/api/crm/platform-clinic?workspaceId=${encodeURIComponent(workspaceId)}`);
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.data) return null;
    return body.data as Card;
  }

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    // Состояние перевыпуска принадлежит клинике: owner-ссылка одной не имеет
    // права пережить переход к другой, даже если компонент не размонтируется.
    setReissueLink("");
    setReissueError("");
    setReissueCopied(false);
    void (async () => {
      try {
        const data = await fetchCard();
        if (cancelled) return;
        if (!data) {
          setState("error");
          return;
        }
        setCard(data);
        setState("ready");
        void loadRecommendations();
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // Появление одноразовой ссылки — событие: фокус переносится на её блок,
  // иначе скринридер после нажатия кнопки слышит тишину.
  const reissueBlockRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (reissueLink) reissueBlockRef.current?.focus();
  }, [reissueLink]);

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

  // Кнопка перевыпуска прячется, когда строка владельца уже есть: сервер в
  // этом случае откажет (owner_already_member), и кнопка обещала бы
  // невозможное. Условие зеркалит серверную проверку: staff_users с ролью
  // owner — независимо от привязки входа.
  const accessStaff = card.access ? card.access.staff : null;
  const accessInvitations = card.access ? card.access.ownerInvitations : null;
  const accessStaffInvitations = card.access ? card.access.staffInvitations ?? null : null;
  const ownerSignIn = card.access ? card.access.ownerSignIn ?? null : null;
  const ownerRow = Array.isArray(accessStaff) ? accessStaff.find((person) => person.role === "owner") : undefined;
  const ownerInside = Boolean(ownerRow);
  const hasPendingInvitation = Array.isArray(accessInvitations) && accessInvitations.some((invitation) => invitation.status === "pending");
  // Истёкшее приглашение при пустом штате — самый требующий действия случай:
  // причина пустоты называется именно тогда, когда нужен перевыпуск.
  const latestExpired = Array.isArray(accessInvitations)
    ? accessInvitations.find((invitation) => invitation.status === "expired")
    : undefined;

  // Высота столбиков — от максимума по обеим сериям, чтобы недели сравнивались
  // друг с другом честно. Нет данных — нет столбика, есть прочерк.
  const weekly = [...card.weekly].reverse();
  const maxCount = Math.max(1, ...weekly.flatMap((week) => [week.leads ?? 0, week.appointments ?? 0]));

  return (
    <>
      <button type="button" className="btn" onClick={onBack}>← Обзор</button>
      <h1 ref={titleRef} tabIndex={-1} className="page-title" style={{ marginTop: 14 }}>{card.clinic.name}</h1>
      <p className="page-sub">
        {vertical === "beauty" ? "салон красоты" : vertical === "dental" ? "стоматология" : "клиника"} · {card.clinic.ownerEmail || "почта не указана"} ·{" "}
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
                {signal.level === "warn" ? (
                  <button
                    type="button"
                    className="btn reco-btn"
                    onClick={() => openComposer({ title: text.title, body: text.why, signalKey: signal.key })}
                  >
                    Рекомендовать
                  </button>
                ) : null}
              </div>
            );
          })
        )}
      </section>

      <section className="panel" style={{ padding: "16px 18px", marginBottom: 16 }}>
        <h2 className="section-title">Доступ</h2>
        {!card.access ? (
          <p className="muted">Данные о доступе не пришли — API старше портала, раздел появится после деплоя.</p>
        ) : (
          <>
            {accessStaff === null ? (
              <p className="muted">Список сотрудников прочитать не удалось. Это отказ чтения, а не «никого нет».</p>
            ) : accessStaff.length === 0 ? (
              // Причина пустоты не выдумывается: про приглашение говорим
              // только когда его состояние действительно видно.
              <p className="muted">
                Внутри пока никого
                {hasPendingInvitation
                  ? " — приглашение владельца ещё не принято"
                  : latestExpired
                    ? ` — приглашение владельца истекло ${latestExpired.expiresAt.slice(0, 10)}, перевыпустите его кнопкой ниже`
                    : ""}
                .
              </p>
            ) : (
              accessStaff.map((person, index) => {
                const staffStatus = STAFF_STATUS_LABELS[person.status] || { label: person.status || "статус не записан", cls: "unknown" };
                return (
                  <div key={`${person.email}-${index}`} className="reco-row">
                    <span className="reco-main">
                      <b>{person.email || "почта не записана"}</b>
                      <span className="why">{ROLE_LABELS[person.role] || person.role}</span>
                    </span>
                    <span className="reco-meta">
                      <span className={`chip ${staffStatus.cls}`}>{staffStatus.label}</span>
                      {/* Строка без auth_user_id — легаси или заведённая руками:
                          сама она не привяжется, приглашение на эту почту сервер
                          отклонит (already_member). «Ещё» здесь не обещается. */}
                      <span className={`chip ${person.linked ? "on" : "off"}`}>{person.linked ? "вход привязан" : "вход не привязан"}</span>
                      {/* «Вход привязан» ≠ «работал»: при парольном подключении
                          привязка есть с первой секунды. Отвечает Auth-журнал. */}
                      {person.role === "owner" && ownerSignIn ? (
                        <span className={`chip ${ownerSignIn.lastAt ? "on" : "off"}`}>
                          {ownerSignIn.accountMissing
                            ? "аккаунт входа удалён"
                            : ownerSignIn.lastAt
                              ? `входил ${ownerSignIn.lastAt.slice(0, 10)}`
                              : "ещё не входил"}
                        </span>
                      ) : null}
                    </span>
                  </div>
                );
              })
            )}

            {/* Приглашения сотрудников: без них поддержка не могла ответить на
                «пригласила администратора, она не может войти». Отказ чтения
                не маскируется под «приглашений нет». */}
            {accessStaffInvitations === null && card.access ? (
              <p className="muted" style={{ marginTop: 12 }}>Приглашения сотрудников прочитать не удалось.</p>
            ) : null}
            {accessStaffInvitations !== null && accessStaffInvitations.length > 0 ? (
              <>
                <h3 className="section-title" style={{ marginTop: 18 }}>Приглашения сотрудников</h3>
                {(() => {
                  const { shown, hidden } = visibleInvitations(accessStaffInvitations);
                  return (
                    <>
                      {shown.map((invitation, index) => {
                        const label = INVITATION_LABELS[invitation.status] || { label: invitation.status, cls: "off" };
                        return (
                          <div key={`${invitation.createdAt}-${index}`} className="reco-row">
                            <span className="reco-main">
                              <b>{invitation.email}</b>
                              <span className="why">
                                {ROLE_LABELS[invitation.role] || invitation.role} · выписано {invitation.createdAt.slice(0, 10)}
                                {invitation.status === "pending" ? ` · действует до ${invitation.expiresAt.slice(0, 10)}` : ""}
                              </span>
                            </span>
                            <span className="reco-meta">
                              <span className={`chip ${label.cls}`}>{label.label}</span>
                            </span>
                          </div>
                        );
                      })}
                      {hidden > 0 ? <p className="muted" style={{ fontSize: 12.5 }}>Ещё {hidden} завершённых не показаны.</p> : null}
                    </>
                  );
                })()}
              </>
            ) : null}

            <h3 className="section-title" style={{ marginTop: 18 }}>Приглашение владельца</h3>
            {accessInvitations === null ? (
              <p className="muted">Историю приглашений прочитать не удалось.</p>
            ) : accessInvitations.length === 0 ? (
              // Причина пустого списка отсюда не видна (пространство до
              // портала или сбой на выписке) — и не утверждается.
              <p className="muted">Приглашений владельцу в базе нет.</p>
            ) : (
              (() => {
                const { shown, hidden } = visibleInvitations(accessInvitations);
                return (
                  <>
                    {shown.map((invitation, index) => {
                      const label = INVITATION_LABELS[invitation.status] || { label: invitation.status, cls: "off" };
                      return (
                        <div key={`${invitation.createdAt}-${index}`} className="reco-row">
                          <span className="reco-main">
                            <b>{invitation.email}</b>
                            <span className="why">
                              выписано {invitation.createdAt.slice(0, 10)}
                              {invitation.status === "pending" ? ` · действует до ${invitation.expiresAt.slice(0, 10)}` : ""}
                            </span>
                          </span>
                          <span className="reco-meta">
                            <span className={`chip ${label.cls}`}>{label.label}</span>
                          </span>
                        </div>
                      );
                    })}
                    {hidden > 0 ? <p className="muted" style={{ fontSize: 12.5 }}>Ещё {hidden} завершённых не показаны.</p> : null}
                  </>
                );
              })()
            )}

            {ownerInside ? (
              <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
                {ownerRow?.linked
                  ? "Владелец внутри — новое приглашение не нужно."
                  : "Строка владельца заведена, но вход не привязан. Новое приглашение сервер не выпишет: владелец уже числится сотрудником."}
              </p>
            ) : (
              <div style={{ marginTop: 12 }}>
                <button type="button" className="btn" disabled={reissueBusy} onClick={() => void reissueInvitation()}>
                  {reissueBusy ? "Выписываю…" : "Перевыпустить приглашение"}
                </button>
              </div>
            )}
            {reissueError ? (
              <div className="notice error" role="alert" style={{ marginTop: 10 }}>{reissueError}</div>
            ) : null}
            {reissueLink ? (
              <div className="result-block" ref={reissueBlockRef} tabIndex={-1}>
                <div className="label">Новая ссылка приглашения</div>
                <div className="result-link">
                  <code>{reissueLink}</code>
                  <button type="button" className="btn-primary" onClick={() => void copyReissueLink()}>
                    {reissueCopied ? "Скопировано" : "Скопировать"}
                  </button>
                </div>
                <p className="muted" style={{ fontSize: 12.5, margin: "10px 0 0" }}>
                  Прежние ссылки отозваны. Действует 7 дней, показывается один раз — передайте владельцу сами: WhatsApp, почта, любой канал.
                </p>
              </div>
            ) : null}
          </>
        )}
        <p className="muted" style={{ fontSize: 12.5, margin: "12px 0 0" }}>
          Сотрудников приглашает владелец сам из кабинета: «Настройки → Сотрудники». С портала приглашается только владелец.
        </p>
      </section>

      <section className="panel" style={{ padding: "16px 18px", marginBottom: 16 }}>
        <h2 className="section-title">
          WhatsApp{card.counts.whatsappChannels === null
            ? " · не смог прочитать"
            : card.counts.whatsappChannels > 0
              ? ` · подключён (${card.counts.whatsappChannels})`
              : " · не подключён"}
        </h2>
        <p className="muted" style={{ fontSize: 12.5, margin: "0 0 10px" }}>
          Заявки из WhatsApp попадают в CRM клиники по её номеру. Нужен <b>phone_number_id</b> из Meta → WhatsApp →
          API Setup — длинное число, а не сам телефон. Сначала номер должен быть привязан к WABA и подписан на
          поле <b>messages</b> в настройках вебхука.
        </p>
        <div className="field" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label htmlFor="wa-number" className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
            Идентификатор номера WhatsApp
          </label>
          <input
            id="wa-number"
            inputMode="numeric"
            placeholder="phone_number_id, например 123456789012345"
            value={numberInput}
            onChange={(event) => setNumberInput(event.target.value)}
            style={{ flex: 1, minWidth: 0 }}
          />
          <button type="button" className="btn-primary" disabled={numberBusy} onClick={() => void linkWhatsappNumber()} style={{ whiteSpace: "nowrap" }}>
            {numberBusy ? "Привязываю…" : "Привязать номер"}
          </button>
        </div>
        {numberFlash ? (
          <div className={`notice ${numberFlash.kind}`} style={{ marginTop: 10 }}>{numberFlash.text}</div>
        ) : null}
        <p className="muted" style={{ fontSize: 12.5, margin: "10px 0 0" }}>
          Один номер принимает сообщения в одну клинику: занятый номер сюда не переносится — его сначала отвязывают там,
          где он сейчас. Токены Meta живут в переменных окружения и здесь не нужны.
        </p>
      </section>

      <section className="panel" style={{ padding: "16px 18px", marginBottom: 16 }}>
        <div className="reco-head">
          <h2 className="section-title" style={{ margin: 0 }}>Рекомендации клинике</h2>
          <button type="button" className="btn" onClick={() => openComposer({ title: "", body: "", signalKey: "" })}>
            Написать рекомендацию
          </button>
        </div>
        {recoFlash ? <div className={`notice ${recoFlash.kind}`}>{recoFlash.text}</div> : null}

        {composer.open ? (
          <div className="composer">
            <div className="field">
              <label htmlFor="reco-title">Заголовок</label>
              <input id="reco-title" value={composer.title} onChange={(event) => setComposer((c) => ({ ...c, title: event.target.value }))} />
            </div>
            <div className="field">
              <label htmlFor="reco-body">Текст совета</label>
              <textarea id="reco-body" rows={3} value={composer.body} onChange={(event) => setComposer((c) => ({ ...c, body: event.target.value }))} />
            </div>
            <div className="composer-row">
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="reco-action">Кнопка ведёт в раздел</label>
                <select id="reco-action" value={composer.actionPath} onChange={(event) => setComposer((c) => ({ ...c, actionPath: event.target.value }))}>
                  <option value="">Без кнопки</option>
                  <option value="/appointments">Записи</option>
                  <option value="/staff-schedule">{capitalize(terms.specialistPlural)} и график</option>
                  <option value="/services">Услуги</option>
                  <option value="/ads-automation">Реклама</option>
                  <option value="/marketplace">Маркет</option>
                  <option value="/admin">Настройки</option>
                </select>
              </div>
              <div className="composer-actions">
                <button type="button" className="btn-primary" disabled={sending} onClick={() => void sendRecommendation()}>
                  {sending ? "Отправляю…" : "Отправить"}
                </button>
                <button type="button" className="btn" onClick={() => setComposer((c) => ({ ...c, open: false }))}>Отмена</button>
              </div>
            </div>
            <p className="muted" style={{ fontSize: 12.5, margin: "8px 0 0" }}>
              Совет появится у владельца клиники в CRM карточкой с этой кнопкой. Вы увидите здесь, прочитан ли он и сделан ли.
            </p>
          </div>
        ) : null}

        {recos === null ? (
          <p className="muted" role="status">Читаю рекомендации…</p>
        ) : "error" in recos ? (
          <div className="notice error">
            Не удалось прочитать рекомендации. Это отказ чтения, а не «советов нет».{" "}
            <button type="button" className="btn" onClick={() => { setRecos(null); void loadRecommendations(); }}>Повторить</button>
          </div>
        ) : !recos.available ? (
          <p className="muted">
            Таблица рекомендаций ещё не применена — выполните migrations/037_platform_recommendations.sql в SQL-редакторе Supabase,
            и раздел заработает без передеплоя.
          </p>
        ) : recos.items.length === 0 ? (
          <p className="muted">Этой клинике ещё ничего не советовали.</p>
        ) : (
          recos.items.map((reco) => {
            const status = RECO_STATUS[reco.status] || { label: reco.status, cls: "off" };
            // Дата — по статусу: «прочитана, но неделю не сделана» видно из
            // разницы между отправкой и датой у чипа.
            const statusDate =
              reco.status === "read" ? reco.readAt : reco.status === "done" || reco.status === "dismissed" ? reco.resolvedAt : "";
            return (
              <div key={reco.id} className="reco-row">
                <span className="reco-main">
                  <b>{reco.title}</b>
                  <span className="why">{reco.body}</span>
                </span>
                <span className="reco-meta">
                  <span className={`chip ${status.cls}`}>{status.label}{statusDate ? ` ${statusDate.slice(0, 10)}` : ""}</span>
                  <span className="reco-date">отправлена {reco.createdAt.slice(0, 10)}</span>
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

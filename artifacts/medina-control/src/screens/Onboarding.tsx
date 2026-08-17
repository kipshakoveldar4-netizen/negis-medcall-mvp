import { useRef, useState } from "react";
import { controlFetch } from "../lib/api";

// Подключение клиники с портала — вариант А.
//
// Форма заменяет цепочку «Invite user в Supabase → provision-скрипт с
// ноутбука»: портал создаёт пространство, настройки ниши и пояса и выписывает
// владельцу приглашение. Пароль не проходит здесь нигде: владелец получает
// ссылку и задаёт его сам на странице /join продукта. Ссылка показывается
// один раз — в базе лежит только её хэш.

const TIME_ZONES = [
  "Asia/Almaty",
  "Asia/Aqtobe",
  "Asia/Aqtau",
  "Asia/Atyrau",
  "Asia/Oral",
  "Asia/Qostanay",
  "Asia/Qyzylorda",
  "Asia/Tashkent",
  "Asia/Bishkek",
  "Europe/Moscow",
];

type Result = {
  workspaceId: string;
  name: string;
  vertical?: string;
  ownerEmail: string;
  acceptUrl: string;
  emailSent: boolean;
  emailStatus?: string;
};

function emailStatusText(result: Result): string {
  if (result.emailSent) return "Supabase отправил владельцу письмо со ссылкой. Продублируйте её сами, если письмо затеряется.";
  if (result.emailStatus === "already_registered") {
    return "У этой почты уже есть аккаунт, поэтому письмо-приглашение не отправлялось. Передайте ссылку сами. Если владелец не помнит пароль или его не было — на странице по ссылке есть «Выслать письмо для пароля»: он задаст пароль и откроет ссылку ещё раз.";
  }
  return "Письмо не ушло — передайте ссылку владельцу сами: WhatsApp, почта, любой канал.";
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [vertical, setVertical] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [timeZone, setTimeZone] = useState("Asia/Almaty");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string[]>([]);
  // Живое приглашение — не тупик: 409 приносит id пространства, и той же
  // формой выписывается новая ссылка (старая отзывается сервером).
  const [reissueWorkspaceId, setReissueWorkspaceId] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [copied, setCopied] = useState(false);
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError([]);
    try {
      const response = await controlFetch("/api/crm/platform-onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, vertical, ownerEmail, ownerName, timeZone }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.success !== true) {
        const reasons = [body?.error, ...(Array.isArray(body?.details) ? body.details : [])].filter(Boolean);
        setError(reasons.length > 0 ? reasons : ["Не удалось подключить клинику. Попробуйте ещё раз."]);
        setReissueWorkspaceId(
          body?.code === "invitation_already_pending" && typeof body?.data?.existingWorkspaceId === "string"
            ? body.data.existingWorkspaceId
            : "",
        );
        return;
      }
      setResult(body.data as Result);
      titleRef.current?.focus();
    } catch {
      setError(["Сеть не ответила — клиника не подключена."]);
    } finally {
      setBusy(false);
    }
  }

  async function reissue() {
    if (busy || !reissueWorkspaceId) return;
    setBusy(true);
    setError([]);
    try {
      const response = await controlFetch("/api/crm/platform-invitation-reissue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: reissueWorkspaceId }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.success !== true) {
        const reasons = [body?.error, ...(Array.isArray(body?.details) ? body.details : [])].filter(Boolean);
        setError(reasons.length > 0 ? reasons : ["Перевыпустить не удалось. Попробуйте ещё раз."]);
        return;
      }
      setReissueWorkspaceId("");
      setResult(body.data as Result);
      titleRef.current?.focus();
    } catch {
      setError(["Сеть не ответила — приглашение не перевыпущено."]);
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.acceptUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // Буфер недоступен — ссылка выделяется и копируется руками.
    }
  }

  if (result) {
    return (
      <>
        <h1 ref={titleRef} tabIndex={-1} className="page-title">{result.vertical ? "Клиника подключена" : "Приглашение перевыпущено"}</h1>
        <p className="page-sub">
          «{result.name}» · {result.vertical === "beauty" ? "салон красоты" : result.vertical === "clinic" ? "клиника" : "прежняя ссылка отозвана"} · {result.ownerEmail}
        </p>

        <div className="panel" style={{ padding: "18px 20px", maxWidth: 720 }}>
          <h2 className="section-title">Ссылка приглашения владельца</h2>
          <p className="muted" style={{ fontSize: 13, margin: "0 0 4px" }}>
            По ней владелец задаёт себе пароль и попадает в свой кабинет. Действует 7 дней, показывается один раз.
          </p>
          <div className="result-block">
            <div className="result-link">
              <code>{result.acceptUrl}</code>
              <button type="button" className="btn-primary" onClick={() => void copyLink()}>
                {copied ? "Скопировано" : "Скопировать"}
              </button>
            </div>
          </div>
          <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>{emailStatusText(result)}</p>
        </div>

        <div className="panel" style={{ padding: "18px 20px", maxWidth: 720 }}>
          <h2 className="section-title">Дальше</h2>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            1. Назначьте тариф на «Обзоре» — кнопка «Назначить» у новой клиники.<br />
            2. Когда владелец примет приглашение, его активность появится в карточке клиники.
          </p>
          <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
            <button type="button" className="btn" onClick={onDone}>К обзору</button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setResult(null);
                setName("");
                setVertical("");
                setOwnerEmail("");
                setOwnerName("");
              }}
            >
              Подключить ещё одну
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <h1 className="page-title">Подключить клинику</h1>
      <p className="page-sub">Пространство, ниша, часовой пояс и приглашение владельцу — одной формой. Пароль владелец задаёт сам.</p>

      <form className="panel" style={{ padding: "20px", maxWidth: 640 }} onSubmit={(event) => void submit(event)}>
        <div className="editor" style={{ border: 0, padding: 0, margin: 0, boxShadow: "none" }}>
          <div className="fields" style={{ gridTemplateColumns: "1fr" }}>
            <div className="field">
              <label htmlFor="ob-name">Название</label>
              <input id="ob-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Салон «Люкс»" />
            </div>
            <div className="field">
              <label htmlFor="ob-vertical">Ниша</label>
              {/* Пустой первый пункт намеренно: ниша меняет правила проверки
                  рекламы, и выбрать её молча значило бы выбрать за клиента. */}
              <select id="ob-vertical" value={vertical} onChange={(event) => setVertical(event.target.value)}>
                <option value="">— выберите —</option>
                <option value="beauty">Салон красоты</option>
                <option value="clinic">Медицинская клиника</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="ob-email">Почта владельца</label>
              <input id="ob-email" type="email" value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} placeholder="owner@salon.kz" />
            </div>
            <div className="field">
              <label htmlFor="ob-owner">Имя владельца</label>
              <input id="ob-owner" value={ownerName} onChange={(event) => setOwnerName(event.target.value)} placeholder="Необязательно" />
            </div>
            <div className="field">
              <label htmlFor="ob-tz">Часовой пояс</label>
              <select id="ob-tz" value={timeZone} onChange={(event) => setTimeZone(event.target.value)}>
                {TIME_ZONES.map((zone) => (
                  <option key={zone} value={zone}>{zone}</option>
                ))}
              </select>
            </div>
          </div>
          {error.length > 0 ? (
            <div className="notice error" role="alert">
              {error.map((line) => (
                <div key={line}>{line}</div>
              ))}
              {reissueWorkspaceId ? (
                <div style={{ marginTop: 10 }}>
                  <button type="button" className="btn" disabled={busy} onClick={() => void reissue()}>
                    {busy ? "Выписываю…" : "Перевыпустить приглашение"}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="actions" style={{ marginTop: 16 }}>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? "Подключаю…" : "Подключить"}
            </button>
            <button type="button" className="btn" onClick={onDone}>Отмена</button>
          </div>
        </div>
      </form>
    </>
  );
}

import { useEffect, useRef, useState } from "react";
import { controlFetch } from "../lib/api";

// Подключение клиники с портала.
//
// Два способа, и выбор между ними — это выбор, кто задаёт пароль:
//
//   «Логин и пароль» (по умолчанию) — владелец платформы задаёт почту и
//   пароль сам и передаёт их владельцу клиники из рук в руки. Письмо не
//   отправляется вовсе, вход работает сразу. Пароль не сохраняется нигде,
//   кроме хэша в Supabase, и показывается один раз на экране результата.
//
//   «Ссылка-приглашение» — прежний путь: владелец получает ссылку и задаёт
//   пароль сам на странице /join. Нужен, когда у почты уже есть аккаунт:
//   задать пароль чужому аккаунту отсюда нельзя — это был бы захват входа.

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

type Mode = "credentials" | "invite";

type Result = {
  workspaceId: string;
  name: string;
  vertical?: string;
  ownerEmail: string;
  acceptUrl: string;
  emailSent: boolean;
  emailStatus?: string;
};

type CredsResult = {
  workspaceId: string;
  name: string;
  vertical: string;
  ownerEmail: string;
  timeZone: string;
  loginUrl: string;
};

function emailStatusText(result: Result): string {
  if (result.emailSent) return "Supabase отправил владельцу письмо со ссылкой. Продублируйте её сами, если письмо затеряется.";
  if (result.emailStatus === "already_registered") {
    return "У этой почты уже есть аккаунт, поэтому письмо-приглашение не отправлялось. Передайте ссылку сами. Если владелец не помнит пароль или его не было — на странице по ссылке есть «Выслать письмо для пароля»: он задаст пароль и откроет ссылку ещё раз.";
  }
  return "Письмо не ушло — передайте ссылку владельцу сами: WhatsApp, почта, любой канал.";
}

/** Без 0/O/1/l/I: пароль диктуют голосом и переписывают с бумажки. */
function generatePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = new Uint32Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => alphabet[n % alphabet.length]).join("");
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<Mode>("credentials");
  const [name, setName] = useState("");
  const [vertical, setVertical] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [timeZone, setTimeZone] = useState("Asia/Almaty");
  // Поле видимое намеренно: пароль здесь не «свой секрет», а данные, которые
  // оператор сейчас передаст дальше — скрытые точки только плодят опечатки.
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string[]>([]);
  // Живое приглашение — не тупик: 409 приносит id пространства, и той же
  // формой выписывается новая ссылка (старая отзывается сервером).
  const [reissueWorkspaceId, setReissueWorkspaceId] = useState("");
  // Занятая почта в парольном режиме — подсказка переключиться на приглашение.
  const [offerInvite, setOfferInvite] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [credsResult, setCredsResult] = useState<CredsResult | null>(null);
  // Пароль на экране результата — из локального состояния, сервер его не
  // возвращает. Живёт до ухода с экрана и нигде больше.
  const [shownPassword, setShownPassword] = useState("");
  const [copied, setCopied] = useState(false);
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  // Фокус — эффектом, а не сразу после setState: в момент вызова экран
  // результата ещё не отрендерен и titleRef.current был бы null всегда.
  useEffect(() => {
    if (result || credsResult) titleRef.current?.focus();
  }, [result, credsResult]);

  /** Смена режима гасит ошибки прежнего: их советы и кнопки — про другой путь. */
  function switchMode(next: Mode) {
    setMode(next);
    setError([]);
    setOfferInvite(false);
    setReissueWorkspaceId("");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError([]);
    setOfferInvite(false);
    // Иначе после сетевой ошибки под ней висела бы кнопка перевыпуска
    // ПРЕЖНЕЙ почты — и била бы по чужому подключению.
    setReissueWorkspaceId("");
    try {
      if (mode === "credentials") {
        const response = await controlFetch("/api/crm/platform-onboarding-credentials", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, vertical, ownerEmail, ownerName, timeZone, password }),
        });
        const body = await response.json().catch(() => null);
        if (!response.ok || body?.success !== true) {
          const reasons = [body?.error, ...(Array.isArray(body?.details) ? body.details : [])].filter(Boolean);
          setError(reasons.length > 0 ? reasons : ["Не удалось подключить клинику. Попробуйте ещё раз."]);
          // existingWorkspaceId приходит и с занятой почтой: это след нашего
          // прерванного прохода, и чинится он перевыпуском, а не вторым
          // пространством через инвайт-режим.
          const existingWorkspaceId =
            (body?.code === "invitation_already_pending" || body?.code === "email_already_registered") &&
            typeof body?.data?.existingWorkspaceId === "string"
              ? body.data.existingWorkspaceId
              : "";
          setReissueWorkspaceId(existingWorkspaceId);
          setOfferInvite(body?.code === "email_already_registered" && !existingWorkspaceId);
          return;
        }
        setShownPassword(password);
        setPassword("");
        setCredsResult(body.data as CredsResult);
        return;
      }

      const response = await controlFetch("/api/crm/platform-onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Пароль в инвайт-путь не уходит даже заполненным полем.
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
    } catch {
      setError(["Сеть не ответила — приглашение не перевыпущено."]);
    } finally {
      setBusy(false);
    }
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // Буфер недоступен — значение выделяется и копируется руками.
    }
  }

  function resetForm() {
    setResult(null);
    setCredsResult(null);
    setShownPassword("");
    setName("");
    setVertical("");
    setOwnerEmail("");
    setOwnerName("");
    setPassword("");
  }

  if (credsResult) {
    return (
      <>
        <h1 ref={titleRef} tabIndex={-1} className="page-title">Клиника подключена — вход по логину и паролю</h1>
        <p className="page-sub">
          «{credsResult.name}» · {credsResult.vertical === "beauty" ? "салон красоты" : "клиника"} · {credsResult.ownerEmail}
        </p>

        <div className="panel" style={{ padding: "18px 20px", maxWidth: 720 }}>
          <h2 className="section-title">Данные для входа</h2>
          <p className="muted" style={{ fontSize: 13, margin: "0 0 4px" }}>
            Письмо не отправлялось и не требуется: вход работает сразу. Пароль показывается один раз —
            после ухода с этого экрана он нигде не хранится, восстановить его владелец сможет
            через «Забыли пароль?» на странице входа.
          </p>
          <div className="result-block">
            <div className="label">Логин</div>
            <div className="result-link">
              <code>{credsResult.ownerEmail}</code>
            </div>
            <div className="label" style={{ marginTop: 10 }}>Пароль</div>
            <div className="result-link">
              <code>{shownPassword}</code>
              <button type="button" className="btn-primary" onClick={() => void copyText(shownPassword)}>
                {copied ? "Скопировано" : "Скопировать"}
              </button>
            </div>
            <div className="label" style={{ marginTop: 10 }}>Страница входа</div>
            <div className="result-link">
              <code>{credsResult.loginUrl}</code>
            </div>
          </div>
          <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
            Передайте логин и пароль владельцу лично — голосом или личным сообщением, не в общем чате.
            Посоветуйте сменить пароль после первого входа.
          </p>
        </div>

        <div className="panel" style={{ padding: "18px 20px", maxWidth: 720 }}>
          <h2 className="section-title">Дальше</h2>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            1. Назначьте тариф на «Обзоре» — кнопка «Назначить» у новой клиники.<br />
            2. Активность владельца появится в карточке клиники после первого входа.
          </p>
          <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
            <button type="button" className="btn" onClick={onDone}>К обзору</button>
            <button type="button" className="btn" onClick={resetForm}>Подключить ещё одну</button>
          </div>
        </div>
      </>
    );
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
              <button type="button" className="btn-primary" onClick={() => void copyText(result.acceptUrl)}>
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
            <button type="button" className="btn" onClick={resetForm}>Подключить ещё одну</button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <h1 className="page-title">Подключить клинику</h1>
      <p className="page-sub">Пространство, ниша, часовой пояс — и вход для владельца: логином с паролем или ссылкой-приглашением.</p>

      <form className="panel" style={{ padding: "20px", maxWidth: 640 }} onSubmit={(event) => void submit(event)}>
        <div className="editor" style={{ border: 0, padding: 0, margin: 0, boxShadow: "none" }}>
          <div className="fields" style={{ gridTemplateColumns: "1fr" }}>
            <div className="field">
              <label id="ob-mode-label">Способ подключения</label>
              <div role="group" aria-labelledby="ob-mode-label" style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className={mode === "credentials" ? "btn-primary" : "btn"}
                  aria-pressed={mode === "credentials"}
                  onClick={() => switchMode("credentials")}
                >
                  Логин и пароль
                </button>
                <button
                  type="button"
                  className={mode === "invite" ? "btn-primary" : "btn"}
                  aria-pressed={mode === "invite"}
                  onClick={() => switchMode("invite")}
                >
                  Ссылка-приглашение
                </button>
              </div>
              <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0" }}>
                {mode === "credentials"
                  ? "Вы задаёте пароль и передаёте его владельцу. Без письма, вход работает сразу. Не подходит, если у почты уже есть аккаунт."
                  : "Владелец получает ссылку и задаёт пароль сам. Единственный путь для почты, у которой уже есть аккаунт."}
              </p>
            </div>
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
              <label htmlFor="ob-email">Почта владельца{mode === "credentials" ? " (логин)" : ""}</label>
              <input id="ob-email" type="email" value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} placeholder="owner@salon.kz" />
            </div>
            <div className="field">
              <label htmlFor="ob-owner">Имя владельца</label>
              <input id="ob-owner" value={ownerName} onChange={(event) => setOwnerName(event.target.value)} placeholder="Необязательно" />
            </div>
            {mode === "credentials" ? (
              <div className="field">
                <label htmlFor="ob-password">Пароль владельца</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    id="ob-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="8–72 символа"
                    autoComplete="off"
                    style={{ flex: 1 }}
                  />
                  <button type="button" className="btn" onClick={() => setPassword(generatePassword())}>
                    Сгенерировать
                  </button>
                </div>
              </div>
            ) : null}
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
              {offerInvite ? (
                <div style={{ marginTop: 10 }}>
                  <button type="button" className="btn" onClick={() => switchMode("invite")}>
                    Переключить на приглашение
                  </button>
                </div>
              ) : null}
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

import { useEffect, useRef, useState } from "react";
import { captureControlAccess, controlFetch, subscribeControlActor } from "../lib/api";
import {
  parsePartnerCompanyPage, parsePartnerCompanyReviewCommand, parsePartnerCompanyReviewReceipt,
  type PartnerCompanyApplication, type PartnerCompanyPage, type PartnerCompanyReviewCommand,
  type PartnerCompanyState,
} from "../../../../lib/crm/partner-company-contracts";
import "./partner-companies.css";

const ENDPOINT = "/api/crm/platform-partner-companies";
const PAGE_SIZE = 20;
const stateLabels = { pending: "На рассмотрении", approved: "Одобрено", rejected: "Отклонено" };
const purposeLabels = { clinic_services: "Услуги", marketing: "Маркетинг", mortgage_leads: "Ипотечные заявки" };
const verticalLabels = { clinic: "Клиника", beauty: "Красота", dental: "Стоматология" };
const UNKNOWN = "Результат решения не подтверждён. Проверьте исходную отправку перед новым решением.";
const STORAGE_ERROR = "Ключ восстановления недоступен. Новые решения заблокированы.";
type Page = { offset: number; state: PartnerCompanyState | null; serial: number };
type View = { page: Page; data: PartnerCompanyPage };
type Selection = { page: Page; application: PartnerCompanyApplication };
type Confirmation = { selection: Selection; action: PartnerCompanyReviewCommand["action"] };
type Attempt = { command: PartnerCompanyReviewCommand; selection?: Selection; body?: string };
type Task = { controller: AbortController; isCurrent(): boolean };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function sameCommand(a: PartnerCompanyReviewCommand, b: PartnerCompanyReviewCommand) {
  return a.requestId === b.requestId && a.applicationId === b.applicationId && a.revision === b.revision && a.action === b.action;
}
function date(value: string) {
  return new Date(value).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}

export function PartnerCompanies() {
  const [origin] = useState(captureControlAccess);
  const [page, setPage] = useState<Page>({ offset: 0, state: "pending", serial: 0 });
  const [view, setView] = useState<View | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [accepted, setAccepted] = useState<Confirmation | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [unconfirmedRead, setUnconfirmedRead] = useState<Attempt | null>(null);
  const [closeAccepted, setCloseAccepted] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const [expired, setExpired] = useState(false);
  const [listError, setListError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const alive = useRef(false);
  const refusal = useRef(false);
  const authorized = useRef(false);
  const storageReady = useRef(false);
  const pageRef = useRef(page);
  const viewRef = useRef(view);
  const selectionRef = useRef(selected);
  const confirmationRef = useRef(confirmation);
  const acceptedRef = useRef(accepted);
  const attemptRef = useRef(attempt);
  const readRef = useRef(unconfirmedRead);
  const closeRef = useRef(closeAccepted);
  const listTask = useRef<AbortController | null>(null);
  const taskRef = useRef<Task | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const detailRef = useRef<HTMLElement | null>(null);
  const storageKey = `medina-control:partner-company-review:v1:${encodeURIComponent(origin.actorId)}`;
  const live = () => alive.current && !refusal.current && origin.isCurrent();
  const sameSelection = (value: Selection) => live() && selectionRef.current === value && pageRef.current === value.page
    && viewRef.current?.page === value.page && viewRef.current.data.items.includes(value.application);

  function clearSelection() {
    selectionRef.current = null; confirmationRef.current = null; acceptedRef.current = null;
    setSelected(null); setConfirmation(null); setAccepted(null);
  }
  function setPending(value: Attempt | null) {
    attemptRef.current = value; readRef.current = null; closeRef.current = null;
    setAttempt(value); setUnconfirmedRead(null); setCloseAccepted(null);
  }
  function retire(accessDenied: boolean) {
    refusal.current = true; authorized.current = false; storageReady.current = false;
    listTask.current?.abort(); taskRef.current?.controller.abort(); taskRef.current = null;
    viewRef.current = null; setView(null); clearSelection(); setPending(null);
    setNotice(null); setListError(""); setStorageError(""); setBusy(false);
    if (accessDenied) setDenied(true); else setExpired(true);
  }
  function readStored(): PartnerCompanyReviewCommand | null {
    if (!live() || !authorized.current) throw Error(STORAGE_ERROR);
    const raw = window.sessionStorage.getItem(storageKey);
    if (!live()) throw Error(STORAGE_ERROR);
    if (raw === null) return null;
    const parsed = raw.length <= 2048 ? parsePartnerCompanyReviewCommand(JSON.parse(raw)) : null;
    if (!parsed || !live()) throw Error(STORAGE_ERROR);
    return parsed;
  }
  function restorePending() {
    storageReady.current = false;
    try {
      const stored = readStored(), previous = attemptRef.current;
      if (previous && (!stored || !sameCommand(previous.command, stored))) throw Error(STORAGE_ERROR);
      if (stored && !previous) setPending({ command: stored });
      if (!live()) return;
      storageReady.current = true; setStorageError("");
    } catch { if (live()) setStorageError(STORAGE_ERROR); }
  }
  function refresh(nextOffset = pageRef.current.offset, nextState = pageRef.current.state) {
    if (!live() || taskRef.current) return;
    listTask.current?.abort(); clearSelection();
    viewRef.current = null; setView(null); setListError("");
    const next = { offset: nextOffset, state: nextState, serial: pageRef.current.serial + 1 };
    pageRef.current = next; setPage(next);
  }

  useEffect(() => {
    alive.current = true;
    const unsubscribe = subscribeControlActor(() => { if (alive.current && !origin.isCurrent()) retire(false); });
    if (!origin.isCurrent()) retire(false);
    return () => {
      alive.current = false; authorized.current = false; storageReady.current = false;
      listTask.current?.abort(); taskRef.current?.controller.abort(); taskRef.current = null;
      unsubscribe();
    };
  }, [origin]);
  useEffect(() => {
    if (!live()) return;
    const controller = new AbortController(); listTask.current = controller;
    const current = () => live() && pageRef.current === page && listTask.current === controller && !controller.signal.aborted;
    const scope = { actorId: origin.actorId, isCurrent: current };
    void (async () => {
      try {
        const query = new URLSearchParams({ offset: String(page.offset) });
        if (page.state !== null) query.set("state", page.state);
        const response = await controlFetch(`${ENDPOINT}?${query}`, { signal: controller.signal }, scope);
        if (!current()) return;
        if ([401, 403, 404].includes(response.status)) { retire(true); return; }
        const payload = record(await response.json());
        if (!current()) return;
        const data = payload?.success === true ? parsePartnerCompanyPage(payload.data, page) : null;
        if (!response.ok || !data) throw Error("Не удалось загрузить заявки компаний.");
        authorized.current = true;
        restorePending();
        if (!current()) return;
        const next = { page, data }; viewRef.current = next; setView(next); setListError("");
      } catch {
        if (current()) { viewRef.current = null; setView(null); setListError("Не удалось загрузить заявки компаний."); }
        else if (alive.current && !refusal.current && !origin.isCurrent()) retire(false);
      }
    })();
    return () => { controller.abort(); if (listTask.current === controller) listTask.current = null; };
  }, [page, origin]);
  useEffect(() => {
    const focused = () => refresh();
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", focused); document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", focused); document.removeEventListener("visibilitychange", visible); };
  }, [origin]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (confirmation && sameSelection(confirmation.selection) && dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, [confirmation]);
  useEffect(() => { if (selected && sameSelection(selected)) detailRef.current?.focus(); }, [selected]);

  function select(application: PartnerCompanyApplication, source: View) {
    if (!live() || taskRef.current || viewRef.current !== source || pageRef.current !== source.page || !source.data.items.includes(application)) return;
    clearSelection();
    const next = { page: source.page, application }; selectionRef.current = next; setSelected(next);
  }
  function openDecision(source: Selection, action: Confirmation["action"]) {
    if (!sameSelection(source) || source.application.state !== "pending" || taskRef.current || attemptRef.current || !storageReady.current) return;
    const next = { selection: source, action };
    confirmationRef.current = next; acceptedRef.current = null;
    setConfirmation(next); setAccepted(null);
  }
  function cancelDecision(value: Confirmation) {
    if (!live() || taskRef.current || confirmationRef.current !== value) return;
    confirmationRef.current = null; acceptedRef.current = null; setConfirmation(null); setAccepted(null);
  }
  function confirmDecision(value: Confirmation) {
    if (!sameSelection(value.selection) || confirmationRef.current !== value || acceptedRef.current !== value
      || taskRef.current || attemptRef.current || !storageReady.current || value.selection.application.state !== "pending") return;
    try {
      // Persist only immutable operation metadata, never company or owner details.
      const command = parsePartnerCompanyReviewCommand({ requestId: crypto.randomUUID(), applicationId: value.selection.application.id,
        revision: value.selection.application.revision, action: value.action });
      if (!command || readStored() !== null) throw Error(STORAGE_ERROR);
      const body = JSON.stringify(command);
      if (!sameSelection(value.selection)) return;
      window.sessionStorage.setItem(storageKey, body);
      const stored = readStored();
      if (!stored || !sameCommand(command, stored) || !sameSelection(value.selection)) throw Error(STORAGE_ERROR);
      const next = { command, body, selection: value.selection };
      setPending(next); confirmationRef.current = null; acceptedRef.current = null;
      setConfirmation(null); setAccepted(null);
      void send(next, "write");
    } catch {
      if (live()) {
        cancelDecision(value); restorePending();
        storageReady.current = false; setStorageError(STORAGE_ERROR);
      }
    }
  }
  async function send(value: Attempt, mode: "write" | "read" | "close") {
    if (!live() || !authorized.current || taskRef.current || attemptRef.current !== value) return;
    if (mode === "write" && (!value.body || !value.selection || !sameSelection(value.selection))) return;
    if (mode === "close" && (readRef.current !== value || closeRef.current !== value)) return;
    // A delayed close may still succeed; it must never revive a write retry.
    if (mode === "close") { value.body = undefined; value.selection = undefined; }
    const controller = new AbortController();
    const task: Task = { controller, isCurrent: () => live() && taskRef.current === task && attemptRef.current === value
      && !controller.signal.aborted && (mode !== "write" || (!!value.selection && sameSelection(value.selection))) };
    taskRef.current = task;
    readRef.current = null; closeRef.current = null; setUnconfirmedRead(null); setCloseAccepted(null);
    setBusy(true); setNotice(null);
    try {
      const query = new URLSearchParams(value.command);
      const response = await controlFetch(`${ENDPOINT}${mode === "read" ? `?${query}` : ""}`, {
        method: mode === "read" ? "GET" : "POST", signal: controller.signal,
        ...(mode === "read" ? {} : { headers: { "Content-Type": "application/json" },
          body: mode === "write" ? value.body : JSON.stringify({ operation: "close", ...value.command }) }),
      }, { actorId: origin.actorId, isCurrent: task.isCurrent });
      if (!task.isCurrent()) return;
      if ([401, 403, 404].includes(response.status)) { retire(true); return; }
      const payload = record(await response.json());
      if (!task.isCurrent()) return;
      const receipt = response.ok && payload?.success === true ? parsePartnerCompanyReviewReceipt(payload.data) : null;
      if (!receipt || !sameCommand(value.command, receipt)) throw Error(UNKNOWN);
      if (receipt.state === "unconfirmed") {
        if (mode === "read") { readRef.current = value; setUnconfirmedRead(value); }
        setNotice({ error: true, text: UNKNOWN }); return;
      }
      let cleared = false;
      try {
        const stored = readStored();
        if (stored && !sameCommand(stored, value.command)) throw Error(STORAGE_ERROR);
        if (!task.isCurrent()) return;
        window.sessionStorage.removeItem(storageKey);
        cleared = task.isCurrent() && readStored() === null;
      } catch { /* A terminal receipt does not excuse an unverified storage clear. */ }
      if (!task.isCurrent()) return;
      const text = receipt.state === "committed" ? receipt.application.state === "approved"
          ? `Одобрение подтверждено. Новое рабочее пространство: ${receipt.application.workspaceId}. Владелец: ${receipt.application.company.ownerName}.`
          : "Отклонение заявки подтверждено. Рабочее пространство не создано."
        : "Исходная отправка закрыта. Решение по ней не сохранено.";
      if (!cleared) {
        setPending({ command: value.command });
        storageReady.current = false; setStorageError(STORAGE_ERROR);
        setNotice({ error: true, text: `${text} Не удалось удалить ключ восстановления. Проверьте результат ещё раз.` });
        return;
      }
      setPending(null); storageReady.current = true; setStorageError("");
      setNotice({ error: false, text });
      // A receipt proves the original decision, not the current list page.
      taskRef.current = null; setBusy(false); refresh();
    } catch {
      if (task.isCurrent()) setNotice({ error: true, text: UNKNOWN });
      else if (alive.current && !refusal.current && !origin.isCurrent()) retire(false);
    } finally {
      if (taskRef.current === task) { taskRef.current = null; if (live()) setBusy(false); }
    }
  }

  const activeView = live() && view?.page === page && pageRef.current === page ? view : null;
  const activeSelection = selected && sameSelection(selected) ? selected : null;
  const application = activeSelection?.application;
  const activeConfirmation = confirmation && confirmationRef.current === confirmation && sameSelection(confirmation.selection) ? confirmation : null;
  const locked = busy || !!attempt || !!storageError || !storageReady.current;
  if (denied) return <section className="partner-companies"><h1 className="page-title">Доступ закрыт</h1><p role="alert">Доступ только у владельца платформы.</p></section>;
  if (expired || !origin.isCurrent()) return <section className="partner-companies"><p role="status">Сеанс изменился. Обновите страницу и проверьте вход.</p></section>;
  return <section className="partner-companies" aria-label="Заявки компаний">
    <header className="pc-heading"><div><h1 className="page-title">Компании партнёров</h1><p className="page-sub">Заявки на новое рабочее пространство.</p></div>
      <button type="button" className="btn pc-icon" title="Обновить список" aria-label="Обновить список" disabled={busy} onClick={() => refresh()}><span aria-hidden="true">{"\u21bb"}</span></button></header>
    <div className="pc-toolbar"><label htmlFor="pc-state">Статус</label><select id="pc-state" value={page.state ?? "all"} disabled={busy}
      onChange={event => { const value = event.target.value; if (["all", "pending", "approved", "rejected"].includes(value)) refresh(0, value === "all" ? null : value as PartnerCompanyState); }}>
      <option value="pending">На рассмотрении</option><option value="approved">Одобрено</option><option value="rejected">Отклонено</option><option value="all">Все</option>
    </select><span className="pc-count">{activeView ? `${activeView.data.items.length} на странице` : "Загрузка"}</span></div>
    {storageError && <p role="alert" className="pc-error">{storageError}</p>}
    {notice && <p role={notice.error ? "alert" : "status"} className={notice.error ? "pc-error" : "pc-success"}>{notice.text}</p>}
    {attempt && <section className="pc-recovery" aria-label="Восстановление исходного решения">
      <h2>Незавершённое решение: {attempt.command.action === "approve" ? "одобрение" : "отклонение"}</h2>
      <dl className="pc-metadata"><div><dt>Заявка</dt><dd><code>{attempt.command.applicationId}</code></dd></div><div><dt>Исходная версия</dt><dd><code>{attempt.command.revision}</code></dd></div><div><dt>Запрос</dt><dd><code>{attempt.command.requestId}</code></dd></div></dl>
      <div className="pc-actions"><button type="button" className="btn" disabled={busy} onClick={() => void send(attempt, "read")}>Проверить результат</button>
        {attempt.body && attempt.selection && sameSelection(attempt.selection) && <button type="button" className="btn" disabled={busy || unconfirmedRead !== attempt} onClick={() => { if (readRef.current === attempt) void send(attempt, "write"); }}>Повторить исходную отправку</button>}</div>
      {unconfirmedRead === attempt && <><label className="pc-check"><input type="checkbox" checked={closeAccepted === attempt} disabled={busy}
        onChange={event => { if (live() && attemptRef.current === attempt && readRef.current === attempt) { const next = event.target.checked ? attempt : null; closeRef.current = next; setCloseAccepted(next); } }} />
        <span>Закрыть неподтверждённую отправку. Уже сохранённое решение не отменяется.</span></label>
        <button type="button" className="btn" disabled={busy || closeAccepted !== attempt} onClick={() => void send(attempt, "close")}>Закрыть отправку</button></>}
    </section>}
    {listError && <p className="pc-error" role="alert">{listError}</p>}
    {!activeView && !listError && <p role="status">Загружаем заявки компаний...</p>}
    {activeView?.data.items.length === 0 && <p className="pc-empty">Заявок с этим статусом нет.</p>}
    {!!activeView?.data.items.length && <div className="pc-layout"><div className="pc-list" aria-label="Список заявок">
      {activeView.data.items.map(item => <button type="button" className={`pc-row${application === item ? " is-selected" : ""}`} key={item.id} disabled={busy}
        aria-pressed={application === item} onClick={() => select(item, activeView)}>
        <span className="pc-row-name">{item.company.name}<small>{item.company.ownerName}</small></span>
        <span className={`pc-state pc-state-${item.state}`}>{stateLabels[item.state]}</span>
        <span className="pc-row-meta">{purposeLabels[item.company.purpose]}<time dateTime={item.submittedAt}>{date(item.submittedAt)}</time></span>
      </button>)}
    </div>
      {application && activeSelection ? <section className="pc-detail" aria-label="Выбранная заявка" tabIndex={-1} ref={detailRef}>
        <div className="pc-detail-heading"><h2>{application.company.name}</h2><button type="button" className="btn pc-icon" title="Закрыть заявку" aria-label="Закрыть заявку" disabled={busy} onClick={() => { if (sameSelection(activeSelection) && !taskRef.current) clearSelection(); }}><span aria-hidden="true">{"\u00d7"}</span></button></div>
        <span className={`pc-state pc-state-${application.state}`}>{stateLabels[application.state]}</span>
        <dl className="pc-facts"><div><dt>Владелец</dt><dd>{application.company.ownerName}</dd></div><div><dt>Направление</dt><dd>{purposeLabels[application.company.purpose]}</dd></div>
          {application.company.vertical && <div><dt>Специализация</dt><dd>{verticalLabels[application.company.vertical]}</dd></div>}
          <div><dt>Часовой пояс</dt><dd>{application.company.timeZone}</dd></div><div><dt>Подана</dt><dd><time dateTime={application.submittedAt}>{date(application.submittedAt)}</time></dd></div>
          <div><dt>Срок источника</dt><dd><time dateTime={application.expiresAt}>{date(application.expiresAt)}</time></dd></div>
          {application.reviewedAt && <div><dt>Рассмотрена</dt><dd><time dateTime={application.reviewedAt}>{date(application.reviewedAt)}</time></dd></div>}
          {application.workspaceId && <div><dt>Новое пространство</dt><dd><code>{application.workspaceId}</code></dd></div>}
          <div><dt>ID заявки</dt><dd><code>{application.id}</code></dd></div><div><dt>Версия</dt><dd><code>{application.revision}</code></dd></div>
        </dl>
        {application.state === "pending" && <><p className="pc-consequence">Одобрение создаст новое рабочее пространство. Заявитель станет его владельцем.</p>
          <div className="pc-actions"><button type="button" className="btn-primary" disabled={locked} onClick={() => openDecision(activeSelection, "approve")}>Одобрить</button>
            <button type="button" className="btn pc-reject" disabled={locked} onClick={() => openDecision(activeSelection, "reject")}>Отклонить</button></div></>}
      </section> : <div className="pc-detail-placeholder" aria-hidden="true" />}
    </div>}
    <nav className="pc-pagination" aria-label="Страницы заявок"><button type="button" className="btn pc-icon" title="Предыдущая страница" aria-label="Предыдущая страница" disabled={busy || page.offset === 0} onClick={() => { if (pageRef.current === page) refresh(Math.max(0, page.offset - PAGE_SIZE)); }}><span aria-hidden="true">{"\u2190"}</span></button>
      <span>Страница {Math.floor(page.offset / PAGE_SIZE) + 1}</span><button type="button" className="btn pc-icon" title="Следующая страница" aria-label="Следующая страница" disabled={busy || !activeView?.data.hasMore || page.offset + PAGE_SIZE > 1000000}
        onClick={() => { if (viewRef.current === activeView && activeView?.data.hasMore && pageRef.current === page) refresh(page.offset + PAGE_SIZE); }}><span aria-hidden="true">{"\u2192"}</span></button></nav>
    {activeConfirmation && <dialog className="pc-dialog" ref={dialogRef} aria-labelledby="pc-confirm-title" aria-describedby="pc-confirm-description"
      onCancel={event => { event.preventDefault(); cancelDecision(activeConfirmation); }}>
      <h2 id="pc-confirm-title">{activeConfirmation.action === "approve" ? "Одобрить компанию?" : "Отклонить заявку?"}</h2>
      <p className="pc-dialog-company">{activeConfirmation.selection.application.company.name}</p>
      <p id="pc-confirm-description">{activeConfirmation.action === "approve" ? "Будет создано новое рабочее пространство. Его владельцем станет заявитель: " + activeConfirmation.selection.application.company.ownerName + "." : "Заявка будет отклонена. Рабочее пространство не будет создано."}</p>
      <label className="pc-check"><input type="checkbox" checked={accepted === activeConfirmation} onChange={event => {
        if (confirmationRef.current === activeConfirmation && sameSelection(activeConfirmation.selection)) { const next = event.target.checked ? activeConfirmation : null; acceptedRef.current = next; setAccepted(next); }
      }} /><span>{activeConfirmation.action === "approve" ? "Подтверждаю создание нового пространства с заявителем-владельцем." : "Подтверждаю отклонение этой заявки."}</span></label>
      <div className="pc-actions"><button type="button" className="btn" autoFocus onClick={() => cancelDecision(activeConfirmation)}>Отмена</button>
        <button type="button" className={activeConfirmation.action === "approve" ? "btn-primary" : "btn pc-reject"} disabled={accepted !== activeConfirmation || locked} onClick={() => confirmDecision(activeConfirmation)}>
          {activeConfirmation.action === "approve" ? "Создать новое пространство" : "Отклонить заявку"}</button></div>
    </dialog>}
  </section>;
}

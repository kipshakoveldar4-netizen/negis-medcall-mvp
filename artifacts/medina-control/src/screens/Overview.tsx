import { useEffect, useRef, useState } from "react";
import { captureControlAccess, controlFetch } from "../lib/api";
import {
  clearPendingSubscription, formatSubscriptionAmount, formatSubscriptionPriceInput, parseSubscriptionHistory, parseSubscriptionPriceInput,
  persistPendingSubscription, readPendingSubscription, validateSubscriptionReceipt,
  type PendingSubscriptionOperation, type SubscriptionHistoryItem, type SubscriptionPayload,
  type SubscriptionReplacePayload, type SubscriptionStatus, type SubscriptionStatusPayload,
} from "../lib/subscription-operation";
import { PLAN_KEYS, PLANS, type PlanKey } from "../../../../lib/billing/plans";

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
  subscriptionId: string;
  subscriptionStatus: string;
  priceMinor: number;
  currency: string;
  billingPeriod: string;
  monthlyMinor: number;
  // null — «не смог посчитать», а не ноль: сбой чтения не притворяется пустотой.
  staffCount: number | null;
  leadCount: number | null;
  appointmentCount: number | null;
  ownerAccess: { state: "inside" | "pending" | "accepted_no_member" | "expired" | "none"; expiresAt: string } | null;
};

/** Чип застрявшего онбординга: показывается только когда владелец НЕ внутри. */
function ownerAccessLabel(access: Clinic["ownerAccess"]): string {
  if (!access || access.state === "inside") return "";
  if (access.state === "pending") return `владелец не принял${access.expiresAt ? ` · до ${access.expiresAt.slice(0, 10)}` : ""}`;
  if (access.state === "expired") return `приглашение истекло${access.expiresAt ? ` ${access.expiresAt.slice(0, 10)}` : ""}`;
  if (access.state === "accepted_no_member") return "принято, но владелец не внутри — откройте карточку";
  return "владелец не приглашён";
}

type Totals = {
  clinics: number;
  withSubscription: number;
  paying: number;
  currency: string;
  mixedCurrencies: boolean;
  monthlyRevenueMinor: number;
};

type Access = ReturnType<typeof captureControlAccess>;
type Task = { scope: Access; controller: AbortController };
type Pending = {
  operation: PendingSubscriptionOperation;
  payload?: SubscriptionPayload;
  body?: string;
  confirmed?: "committed" | "abandoned";
};
const UNCONFIRMED = "Сохранение не подтверждено";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function isOverview(value: unknown): value is { clinics: Clinic[]; totals: Totals } {
  const data = record(value);
  const totals = record(data?.totals);
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const optionalCount = (value: unknown) => value === null || count(value);
  return !!data && Array.isArray(data.clinics) && data.clinics.every((value: unknown) => {
    const clinic = record(value);
    const access = record(clinic?.ownerAccess);
    return !!clinic && typeof clinic.id === "string" && !!clinic.id
      && ["name", "ownerEmail", "createdAt", "plan", "subscriptionId", "subscriptionStatus", "currency", "billingPeriod"]
        .every((key) => typeof clinic[key] === "string")
      && count(clinic.priceMinor) && count(clinic.monthlyMinor)
      && optionalCount(clinic.staffCount) && optionalCount(clinic.leadCount) && optionalCount(clinic.appointmentCount)
      && (clinic.ownerAccess === null || (!!access && typeof access.expiresAt === "string"
        && ["inside", "pending", "accepted_no_member", "expired", "none"].includes(String(access.state))));
  }) && !!totals && count(totals.clinics) && count(totals.withSubscription) && count(totals.paying)
    && count(totals.monthlyRevenueMinor) && typeof totals.currency === "string" && typeof totals.mixedCurrencies === "boolean";
}

export function Overview({ onOpenClinic }: { onOpenClinic: (id: string) => void }) {
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "forbidden" | "error">("loading");
  const [editing, setEditing] = useState("");
  const [plan, setPlan] = useState<PlanKey>("basic");
  const [price, setPrice] = useState("");
  const [period, setPeriod] = useState("monthly");
  const [priceCurrency, setPriceCurrency] = useState(PLANS.basic.currency);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [history, setHistory] = useState<SubscriptionHistoryItem[]>([]);
  const [historyState, setHistoryState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [flash, setFlash] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const ownerRef = useRef<Access | null>(null);
  const mountedRef = useRef(false);
  const editorEpochRef = useRef(0);
  const authorizedRef = useRef(false);
  const taskRef = useRef<Task | null>(null);
  const historyTaskRef = useRef<Task | null>(null);
  const historyRef = useRef<SubscriptionHistoryItem[]>([]);
  const mutexRef = useRef<Task | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  function invalidateHistory() {
    historyTaskRef.current?.controller.abort();
    historyTaskRef.current = null;
  }

  function invalidateTask(includeHistory = true) {
    taskRef.current?.controller.abort();
    taskRef.current = null;
    mutexRef.current = null;
    if (includeHistory) invalidateHistory();
  }

  function beginTask(lock = false): Task | null {
    const owner = ownerRef.current;
    const access = captureControlAccess();
    if (!mountedRef.current || mutexRef.current || !owner?.actorId || !owner.isCurrent()
      || access.actorId !== owner.actorId || !access.isCurrent()) return null;
    invalidateTask(false);
    const controller = new AbortController();
    const task: Task = {
      controller,
      scope: { actorId: access.actorId, isCurrent: () => taskRef.current === task
        && ownerRef.current === owner && owner.isCurrent() && access.isCurrent() && !controller.signal.aborted },
    };
    taskRef.current = task;
    if (lock) mutexRef.current = task;
    return task;
  }

  function finishTask(task: Task) {
    if (!task.scope.isCurrent()) return;
    if (mutexRef.current === task) mutexRef.current = null;
    setSaving(false);
    taskRef.current = null;
  }

  async function load(task: Task, restorePending = false) {
    if (!task.scope.isCurrent()) return false;
    authorizedRef.current = false;
    setClinics([]);
    setTotals(null);
    setState("loading");
    try {
      const response = await controlFetch("/api/crm/platform-overview", { signal: task.controller.signal }, task.scope);
      if (!task.scope.isCurrent()) return false;
      if (response.status === 404) {
        setState("forbidden");
        return false;
      }
      if (response.status !== 200) {
        setState("error");
        return false;
      }
      const body: unknown = await response.json();
      if (!task.scope.isCurrent()) return false;
      const envelope = record(body);
      if (envelope?.success !== true || !isOverview(envelope?.data)) {
        setState("error");
        return false;
      }
      if (restorePending) {
        const stored = readPendingSubscription(task.scope);
        if (!task.scope.isCurrent()) return false;
        const restored = stored ? { operation: stored } : null;
        pendingRef.current = restored;
        setPending(restored);
      }
      authorizedRef.current = true;
      setClinics(envelope.data.clinics);
      setTotals(envelope.data.totals);
      setState("ready");
      return true;
    } catch {
      if (task.scope.isCurrent()) {
        authorizedRef.current = false;
        setState("error");
      }
      return false;
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    ownerRef.current = captureControlAccess();
    const task = beginTask();
    if (task) void load(task, true).finally(() => finishTask(task));
    else setState("error");
    return () => {
      mountedRef.current = false;
      authorizedRef.current = false;
      ownerRef.current = null;
      invalidateTask();
    };
  }, []);

  function startEditing(clinic: Clinic) {
    if (!authorizedRef.current || !ownerRef.current?.isCurrent()) return;
    invalidateTask();
    editorEpochRef.current++;
    setSaving(false);
    setFlash(null);
    setEditing(clinic.id);
    const nextPlan = (PLAN_KEYS as readonly string[]).includes(clinic.plan) ? (clinic.plan as PlanKey) : "basic";
    setPlan(nextPlan);
    // Период — у самой подписки: форма, всегда шлющая monthly, однажды
    // превратила годовую цену в месячную и раздула выручку в двенадцать раз.
    const nextPeriod = clinic.plan || clinic.billingPeriod === "yearly" || clinic.billingPeriod === "monthly"
      ? clinic.billingPeriod : "monthly";
    setPeriod(nextPeriod);
    setPriceCurrency(clinic.plan ? clinic.currency : PLANS[nextPlan].currency);
    // Назначенная цена показывается как есть, включая ноль; подсказка тарифа —
    // только когда подписки нет вовсе.
    const assigned = clinic.plan ? clinic.priceMinor : PLANS[nextPlan].suggestedMonthlyMinor;
    setPrice(formatSubscriptionPriceInput(assigned));
    void loadHistory(clinic.id, editorEpochRef.current);
  }

  async function loadHistory(workspaceId: string, epoch: number) {
    const owner = ownerRef.current;
    const access = captureControlAccess();
    if (!isEditorCurrent(epoch) || !authorizedRef.current || !owner || access.actorId !== owner.actorId || !access.isCurrent()) return;
    invalidateHistory();
    const controller = new AbortController();
    const task: Task = { controller, scope: {
      actorId: access.actorId,
      isCurrent: () => historyTaskRef.current === task && ownerRef.current === owner
        && isEditorCurrent(epoch) && access.isCurrent() && !controller.signal.aborted,
    } };
    historyTaskRef.current = task;
    historyRef.current = [];
    setHistory([]);
    setHistoryState("loading");
    try {
      const query = new URLSearchParams({ workspaceId });
      const response = await controlFetch(`/api/crm/platform-subscriptions?${query}`, { signal: controller.signal }, task.scope);
      if (!task.scope.isCurrent()) return;
      if (response.status !== 200) {
        setHistoryState("error");
        return;
      }
      const body: unknown = await response.json();
      if (!task.scope.isCurrent()) return;
      const items = parseSubscriptionHistory(body, workspaceId);
      if (!items) {
        setHistoryState("error");
        return;
      }
      historyRef.current = items;
      setHistory(items);
      setHistoryState("ready");
    } catch {
      if (task.scope.isCurrent()) setHistoryState("error");
    } finally {
      if (task.scope.isCurrent()) historyTaskRef.current = null;
    }
  }

  async function saveSubscription(clinicId: string, editorEpoch: number) {
    if (!isEditorCurrent(editorEpoch) || mutexRef.current || pendingRef.current || !authorizedRef.current) return;
    const clinic = clinics.find((item) => item.id === clinicId);
    if (!clinic || editing !== clinicId) return;
    if (!price.trim()) {
      setFlash({ kind: "error", text: "Укажите цену. Ноль — законное значение, но его нужно ввести явно." });
      return;
    }
    const priceMinor = parseSubscriptionPriceInput(price);
    if (priceMinor === null) {
      setFlash({ kind: "error", text: "Укажите неотрицательную цену цифрами, не более двух знаков после точки или запятой, в допустимом диапазоне." });
      return;
    }
    if (!/^[A-Z]{3}$/.test(priceCurrency)) {
      setFlash({ kind: "error", text: "Не удалось определить валюту подписки. Обновите сведения о клинике." });
      return;
    }
    if (period !== "monthly" && period !== "yearly") {
      setFlash({ kind: "error", text: "Выберите период подписки." });
      return;
    }
    const task = beginTask(true);
    if (!task) return;
    try {
      const payload: SubscriptionReplacePayload = Object.freeze({
        workspaceId: clinicId,
        requestKey: crypto.randomUUID(),
        expectedActiveId: clinic.subscriptionId || null,
        plan,
        priceMinor,
        billingPeriod: period,
        currency: priceCurrency,
      });
      await submitOperation(task, payload);
      if (!task.scope.isCurrent()) return;
    } catch {
      if (task.scope.isCurrent()) setFlash({ kind: "error", text: pendingRef.current ? UNCONFIRMED : "Не удалось подготовить запрос. Подписка не отправлена." });
    } finally {
      finishTask(task);
    }
  }

  function anotherActiveKnown(item: SubscriptionHistoryItem) {
    const activeId = clinics.find((clinic) => clinic.id === item.workspace_id)?.subscriptionId;
    return (!!activeId && activeId !== item.id)
      || historyRef.current.some((row) => row.workspace_id === item.workspace_id && row.status === "active" && row.id !== item.id);
  }

  async function changeSubscriptionStatus(item: SubscriptionHistoryItem, status: SubscriptionStatus, epoch: number) {
    if (!isEditorCurrent(epoch) || mutexRef.current || pendingRef.current || !authorizedRef.current
      || !historyRef.current.some((row) => row.id === item.id && row.updated_at === item.updated_at && row.status === item.status)
      || !((item.status === "active" && (status === "paused" || status === "cancelled"))
        || (item.status === "paused" && (status === "active" || status === "cancelled")))
      || (status === "active" && anotherActiveKnown(item))) return;
    const task = beginTask(true);
    if (!task) return;
    try {
      const payload: SubscriptionStatusPayload = Object.freeze({
        workspaceId: item.workspace_id, requestKey: crypto.randomUUID(), subscriptionId: item.id,
        expectedUpdatedAt: item.updated_at, expectedStatus: item.status, status,
      });
      await submitOperation(task, payload);
      if (!task.scope.isCurrent()) return;
    } catch {
      if (task.scope.isCurrent()) setFlash({ kind: "error", text: pendingRef.current ? UNCONFIRMED : "Не удалось подготовить запрос. Подписка не отправлена." });
    } finally {
      finishTask(task);
    }
  }

  async function submitOperation(task: Task, payload: SubscriptionPayload) {
    if (!task.scope.isCurrent() || !authorizedRef.current) return;
    const next: Pending = {
      operation: { requestKey: payload.requestKey, workspaceId: payload.workspaceId, kind: "subscriptionId" in payload ? "status" : "replace" },
      payload, body: JSON.stringify(payload),
    };
    if (!persistPendingSubscription(task.scope, next.operation)) {
      if (task.scope.isCurrent()) setFlash({ kind: "error", text: "Не удалось сохранить ключ восстановления. Запрос не отправлен; проверьте доступ к хранилищу браузера." });
      return;
    }
    if (!task.scope.isCurrent()) return;
    pendingRef.current = next;
    setPending(next);
    await sendOperation(task, next, "write");
    if (!task.scope.isCurrent()) return;
  }

  async function sendOperation(task: Task, current: Pending, action: "write" | "check" | "abandon") {
    if (!task.scope.isCurrent() || !authorizedRef.current || pendingRef.current !== current) return;
    if (action === "write" && (!current.payload || !current.body)) return;
    const unknownText = current.confirmed
      ? `${current.confirmed === "committed" ? "Подписка сохранена" : "Запрос отменён"}. Не удалось проверить ключ восстановления.`
      : UNCONFIRMED;
    setSaving(true);
    setFlash(null);
    try {
      const { operation } = current;
      const query = new URLSearchParams({ workspaceId: operation.workspaceId, requestKey: operation.requestKey });
      const response = await controlFetch(`/api/crm/platform-subscriptions${action === "check" ? `?${query}` : ""}`, {
        method: action === "check" ? "GET" : action === "write" && operation.kind === "status" ? "PATCH" : "POST",
        signal: task.controller.signal,
        ...(action === "check" ? {} : {
          headers: { "Content-Type": "application/json" },
          body: action === "write" ? current.body : JSON.stringify({
            workspaceId: operation.workspaceId, requestKey: operation.requestKey, abandon: true,
          }),
        }),
      }, task.scope);
      if (!task.scope.isCurrent()) return;
      const body: unknown = await response.json().catch(() => null);
      if (!task.scope.isCurrent()) return;
      const outcome = response.ok
        ? validateSubscriptionReceipt(body, task.scope.actorId, operation, current.payload, action === "write")
        : "unconfirmed";
      if (outcome === "unconfirmed") {
        const envelope = record(body);
        const reason = !response.ok && response.status < 500 && typeof envelope?.error === "string" ? envelope.error : "";
        setFlash({ kind: "error", text: reason ? `${unknownText}. ${reason}` : unknownText });
        return;
      }
      const cleared = clearPendingSubscription(task.scope, operation);
      if (!task.scope.isCurrent()) return;
      const remaining: Pending | null = cleared ? null : { operation, confirmed: outcome };
      pendingRef.current = remaining;
      setPending(remaining);
      invalidateHistory();
      editorEpochRef.current++;
      setEditing("");
      const confirmedText = outcome === "abandoned"
        ? "Запрос отменён. Изменения по нему не сохранены."
        : action === "abandon" ? "Запрос уже был выполнен. Подписка сохранена; запрошена актуальная сводка."
          : "Подписка сохранена; запрошена актуальная сводка.";
      setFlash({ kind: cleared ? "ok" : "error", text: confirmedText
        + (cleared ? "" : " Не удалось удалить ключ восстановления. Проверьте результат ещё раз.") });
      await load(task);
      if (!task.scope.isCurrent()) return;
    } catch {
      if (task.scope.isCurrent()) setFlash({ kind: "error", text: unknownText });
    }
  }

  async function recoverSubscription(current: Pending, action: "write" | "check" | "abandon") {
    if (pendingRef.current !== current || !authorizedRef.current || (action === "write" && !current.body)) return;
    const task = beginTask(true);
    if (!task) return;
    try {
      await sendOperation(task, current, action);
      if (!task.scope.isCurrent()) return;
    } finally {
      finishTask(task);
    }
  }

  function isEditorCurrent(epoch: number) {
    return mountedRef.current && !!ownerRef.current?.isCurrent() && editorEpochRef.current === epoch;
  }

  function closeEditor(epoch: number) {
    if (!isEditorCurrent(epoch)) return;
    invalidateTask();
    editorEpochRef.current++;
    setSaving(false);
    setFlash(null);
    setEditing("");
    historyRef.current = [];
    setHistory([]);
    setHistoryState("idle");
  }

  function retryOverview() {
    if (!mountedRef.current) return;
    if (ownerRef.current?.actorId === "") ownerRef.current = captureControlAccess();
    const task = beginTask();
    if (task) void load(task, true).finally(() => finishTask(task));
  }

  const editingClinic = clinics.find((clinic) => clinic.id === editing) || null;
  const editorEpoch = editorEpochRef.current;
  const editorRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (editing) editorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [editing]);

  if (state === "loading" || (ownerRef.current?.actorId && !ownerRef.current.isCurrent())) {
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
        {flash ? <div className={`notice ${flash.kind}`} role="status">{flash.text}</div> : null}
        <button type="button" className="btn" onClick={retryOverview}>Повторить загрузку</button>
      </>
    );
  }

  const currency = totals?.currency || "KZT";

  return (
    <>
      <h1 className="page-title">Платформа Medina</h1>
      <p className="page-sub">Подключённые клиники и назначенные подписки.</p>

      <div className="metrics">
        <div className="metric"><div className="l">Клиник</div><div className="v">{totals?.clinics ?? 0}</div></div>
        <div className="metric"><div className="l">С подпиской</div><div className="v">{totals?.withSubscription ?? 0}</div></div>
        <div className="metric"><div className="l">С платным тарифом</div><div className="v">{totals?.paying ?? 0}</div></div>
        <div className="metric">
          <div className="l">Стоимость в месяц</div>
          <div className="v">{totals?.mixedCurrencies ? "—" : formatSubscriptionAmount(totals?.monthlyRevenueMinor ?? 0, currency)}</div>
          <div className="h">
            {totals?.mixedCurrencies
              ? "У клиник разные валюты — складывать их нельзя"
              : "Сумма действующих подписок, годовые приведены к месяцу"}
          </div>
        </div>
      </div>

      {flash ? <div className={`notice ${flash.kind}`} role="status">{flash.text}</div> : null}
      {pending ? (
        <div className="notice error" role="status" aria-live="polite">
          <div>{saving ? "Проверяем результат операции…"
            : pending.confirmed === "committed" ? "Подписка сохранена"
              : pending.confirmed === "abandoned" ? "Запрос отменён" : UNCONFIRMED}</div>
          <div style={{ marginTop: 6, overflowWrap: "anywhere" }}>
            {clinics.find((clinic) => clinic.id === pending.operation.workspaceId)?.name || "Клиника недоступна в текущем обзоре"}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
            <button type="button" className="btn" disabled={saving} onClick={() => void recoverSubscription(pending, "check")}>Проверить сохранение</button>
            {pending.body ? <button type="button" className="btn" disabled={saving} onClick={() => void recoverSubscription(pending, "write")}>Повторить сохранение</button> : null}
            <button type="button" className="btn" disabled={saving} onClick={() => void recoverSubscription(pending, "abandon")}>Отменить запрос</button>
          </div>
        </div>
      ) : null}

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
                      {ownerAccessLabel(clinic.ownerAccess) ? (
                        <div style={{ marginTop: 4 }}>
                          <span className="chip off">{ownerAccessLabel(clinic.ownerAccess)}</span>
                        </div>
                      ) : null}
                    </td>
                    <td className="num">{clinic.createdAt.slice(0, 10) || "—"}</td>
                    <td>{clinic.plan ? PLANS[clinic.plan as PlanKey]?.title || clinic.plan : <span className="muted">нет действующей подписки</span>}</td>
                    <td className="num">{clinic.plan ? formatSubscriptionAmount(clinic.monthlyMinor, clinic.currency) : "—"}</td>
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
          <h3 style={{ overflowWrap: "anywhere" }}>Подписка клиники{editingClinic ? ` — ${editingClinic.name}` : ""}</h3>
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
                disabled={saving || !!pending}
                value={plan}
                onChange={(event) => {
                  if (!isEditorCurrent(editorEpoch) || pendingRef.current) return;
                  const next = event.target.value as PlanKey;
                  setPlan(next);
                  if (!editingClinic?.plan) setPriceCurrency(PLANS[next].currency);
                  // Подсказка тарифа — месячная; при годовом периоде её
                  // подставлять нельзя: вышла бы годовая цена, равная месячной.
                  if (period === "monthly" && (!editingClinic?.plan || priceCurrency === PLANS[next].currency)) {
                    setPrice(formatSubscriptionPriceInput(PLANS[next].suggestedMonthlyMinor));
                  }
                }}
              >
                {PLAN_KEYS.map((key) => (
                  <option key={key} value={key}>{PLANS[key].title}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="period">Период</label>
              <select id="period" disabled={saving || !!pending} value={period} onChange={(event) => {
                if (isEditorCurrent(editorEpoch) && !pendingRef.current) setPeriod(event.target.value);
              }}>
                {period !== "monthly" && period !== "yearly" ? <option value={period} disabled>Выберите период</option> : null}
                <option value="monthly">Помесячно</option>
                <option value="yearly">За год</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="price">{period === "yearly" ? "Цена за год" : period === "monthly" ? "Цена в месяц" : "Цена"}, {priceCurrency === "KZT" ? "₸" : priceCurrency || "валюта не указана"}</label>
              <input id="price" inputMode="decimal" disabled={saving || !!pending} value={price} onChange={(event) => {
                if (isEditorCurrent(editorEpoch) && !pendingRef.current) setPrice(event.target.value);
              }} />
            </div>
            <div className="actions" style={{ flexWrap: "wrap" }}>
              <button type="button" className="btn-primary" disabled={saving || !!pending} onClick={() => void saveSubscription(editing, editorEpoch)}>
                {saving ? "Сохраняю…" : "Сохранить"}
              </button>
              <button type="button" className="btn" onClick={() => closeEditor(editorEpoch)}>{pending ? "Закрыть" : "Отмена"}</button>
            </div>
          </div>
          <p className="hint">{PLANS[plan].summary} Цена подставлена как подсказка — сохранится то, что стоит в поле.</p>
          <h4 style={{ margin: "22px 0 10px", fontSize: 14 }}>История подписок</h4>
          {historyState === "loading" ? <p className="muted" role="status">Читаю подписки…</p> : null}
          {historyState === "error" ? (
            <div className="notice error" role="status">
              <p style={{ marginTop: 0 }}>Не удалось прочитать историю подписок. Список неизвестен.</p>
              <button type="button" className="btn" onClick={() => void loadHistory(editing, editorEpoch)}>Повторить чтение</button>
            </div>
          ) : null}
          {historyState === "ready" && history.length === 0 ? <p className="muted">Подписок пока нет.</p> : null}
          {historyState === "ready" && history.length > 0 ? (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th>Тариф</th><th>Условия</th><th>Статус</th><th>Изменена</th><th aria-label="Действия с подпиской" /></tr>
                </thead>
                <tbody>
                  {history.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <div>{PLANS[item.plan].title}</div>
                        <div className="cell-sub" style={{ overflowWrap: "anywhere", whiteSpace: "normal" }}>{item.id}</div>
                      </td>
                      <td>{formatSubscriptionAmount(item.price_minor, item.currency)} / {item.billing_period === "yearly" ? "год" : "месяц"}</td>
                      <td>{item.status === "active" ? "Действует" : item.status === "paused" ? "Приостановлена" : "Отменена"}</td>
                      <td className="num">{item.updated_at.slice(0, 10)}</td>
                      <td>
                        {item.status !== "cancelled" ? (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                            {item.status === "active" ? (
                              <button type="button" className="btn" disabled={saving || !!pending}
                                onClick={() => void changeSubscriptionStatus(item, "paused", editorEpoch)}>Приостановить</button>
                            ) : (
                              <button type="button" className="btn" disabled={saving || !!pending || anotherActiveKnown(item)}
                                title={anotherActiveKnown(item) ? "У клиники уже есть другая действующая подписка" : undefined}
                                onClick={() => void changeSubscriptionStatus(item, "active", editorEpoch)}>Возобновить</button>
                            )}
                            <button type="button" className="btn" disabled={saving || !!pending}
                              onClick={() => void changeSubscriptionStatus(item, "cancelled", editorEpoch)}>Отменить подписку</button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

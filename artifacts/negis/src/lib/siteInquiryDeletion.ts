import { parseSiteDeletionOperationResponse, siteDeletionIntentBody } from "./siteDeletionOperations";

export type DeletionRequestInit = RequestInit & { dispatchGuard?: () => boolean };
export type DeletionRequest = (path: string, init?: DeletionRequestInit) => Promise<Response>;
// Owners may retire an actor/session epoch without waiting for a React render.
// Once false, that epoch must never become current again (including A/B/A).
export type DeletionLifetime = {
  actorId?: string;
  isCurrent: () => boolean;
  subscribe?: (listener: () => void) => () => void;
};
export type DeletionReconciliation = { workspaceId: string; leadId: string; body: string };
export type DeletionScope = {
  leadId: string;
  leadUpdatedAt: string;
  receiptIds: string[];
  receiptCount: number;
  reviewReasons: string[];
  deletionEnabled: boolean;
  deletionAvailability: "disabled" | "schema_not_ready" | "review_required" | "confirmation_required";
};
export type DeletionState = {
  phase: "checking" | "hidden" | "review" | "submitting" | "uncertain" | "error" | "done";
  visible: boolean;
  scope: DeletionScope | null;
  confirmed: boolean;
  message: string;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function parseDeletionScope(value: unknown, leadId: string): DeletionScope | null {
  const envelope = record(value);
  const data = record(envelope?.data);
  if (envelope?.success !== true || !data || data.leadId !== leadId || !uuid.test(leadId)
    || typeof data.leadUpdatedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(data.leadUpdatedAt)
    || !Array.isArray(data.receiptIds) || data.receiptIds.length < 1 || data.receiptIds.length > 200
    || !data.receiptIds.every((id): id is string => typeof id === "string" && uuid.test(id))
    || new Set(data.receiptIds.map((id) => id.toLowerCase())).size !== data.receiptIds.length
    || data.receiptCount !== data.receiptIds.length || data.confirmationRequired !== true
    || !Array.isArray(data.reviewReasons) || !data.reviewReasons.every((reason): reason is string => typeof reason === "string")
    || data.reviewRequired !== (data.reviewReasons.length > 0)
    || typeof data.deletionEnabled !== "boolean") return null;
  const availability = data.deletionAvailability;
  if (availability !== "disabled" && availability !== "schema_not_ready" && availability !== "review_required" && availability !== "confirmation_required") return null;
  if (data.deletionEnabled !== (availability === "confirmation_required")
    || (data.deletionEnabled && data.reviewRequired)
    || (availability === "review_required" && !data.reviewRequired)) return null;
  return {
    leadId, leadUpdatedAt: data.leadUpdatedAt, receiptIds: [...data.receiptIds],
    receiptCount: data.receiptCount, reviewReasons: [...data.reviewReasons],
    deletionEnabled: data.deletionEnabled, deletionAvailability: availability,
  };
}

const conflictMessages: Record<string, string> = {
  deletion_scope_changed: "Состав или данные заявки изменились. Проверьте состав заново и подтвердите удаление ещё раз.",
  deletion_requires_review: "У заявки появились связи с рабочими данными. Нужен отдельный разбор.",
  site_deletion_disabled: "Удаление для этого сайта отключено.",
  site_inquiry_not_found: "Заявка больше недоступна. Обновите список заявок.",
  deletion_request_conflict: "Запрос не соответствует подтверждённому составу. Проверьте состав заново.",
  deletion_operation_not_prepared: "Подтверждение запроса не сохранено. Проверьте операции удаления.",
  deletion_operation_abandoned: "Выполнение этого запроса отменено.",
  deletion_operation_capacity: "Журнал операций заполнен. Нужен разбор сохранённых подтверждений.",
  invalid_deletion_request: "Не удалось подтвердить состав. Проверьте его заново.",
};

// A lost response keeps the original scope/key in memory. Only an explicit retry
// may resend it; no optimistic removal or automatic background retry is allowed.
export function createSiteInquiryDeletion(workspaceId: string, leadId: string, request: DeletionRequest, newKey: () => string, lifetime?: DeletionLifetime) {
  let state: DeletionState = { phase: "checking", visible: false, scope: null, confirmed: false, message: "" };
  let submission: string | null = null;
  let revision = 0;
  let disposed = false;
  let unsubscribeLifetime = () => {};
  const listeners = new Set<() => void>();
  const set = (next: DeletionState) => { state = next; listeners.forEach((listener) => listener()); };
  // This owner-only evidence is never part of the rendered snapshot. Disposal
  // fences publication, not the server mutation, so it must not clear the body.
  const getReconciliation = (): DeletionReconciliation | null => submission === null ? null : { workspaceId, leadId, body: submission };
  const dispose = () => {
    if (!disposed) {
      disposed = true;
      ++revision;
      unsubscribeLifetime();
      set({ phase: "hidden", visible: false, scope: null, confirmed: false, message: "" });
      listeners.clear();
    }
    return getReconciliation();
  };
  const isCurrent = () => {
    if (!disposed && lifetime) {
      try { if (!lifetime.isCurrent()) dispose(); } catch { dispose(); }
    }
    return !disposed;
  };
  unsubscribeLifetime = lifetime?.subscribe?.(() => { isCurrent(); }) ?? unsubscribeLifetime;
  // A source may synchronously report retirement while subscribing.
  if (disposed) unsubscribeLifetime();
  const locked = () => state.phase === "submitting" || state.phase === "uncertain" || state.phase === "done";
  const base = `/api/crm/site-inquiry-deletion?workspaceId=${encodeURIComponent(workspaceId)}`;
  return {
    dispose, isCurrent, getReconciliation,
    getSnapshot: () => state,
    subscribe(listener: () => void) { if (!isCurrent()) return () => {}; listeners.add(listener); return () => { listeners.delete(listener); }; },
    async inspect() {
      if (!isCurrent() || locked()) return;
      const current = ++revision;
      submission = null;
      set({ phase: "checking", visible: state.visible, scope: null, confirmed: false, message: "" });
      try {
        if (!uuid.test(workspaceId) || !uuid.test(leadId)) throw new Error("invalid_scope");
        if (!isCurrent()) return;
        const response = await request(`/api/crm/site-inquiry-deletion-preview?workspaceId=${encodeURIComponent(workspaceId)}&leadId=${encodeURIComponent(leadId)}`, { cache: "no-store", dispatchGuard: isCurrent });
        if (!isCurrent() || current !== revision) return;
        const scope = response.ok ? parseDeletionScope(await response.json(), leadId) : null;
        if (!isCurrent() || current !== revision) return;
        if (!scope) throw new Error("unverified_scope");
        set({ phase: "review", visible: true, scope, confirmed: false, message: "" });
      } catch {
        if (!isCurrent() || current !== revision) return;
        set({ phase: state.visible ? "error" : "hidden", visible: state.visible, scope: null, confirmed: false,
          message: "Не удалось проверить доступ и состав заявки. Удаление недоступно." });
      }
    },
    confirm(confirmed: boolean) {
      if (isCurrent() && state.phase === "review" && state.scope?.deletionEnabled) set({ ...state, confirmed });
    },
    async submit() {
      if (!isCurrent()) return;
      const scope = state.scope;
      if (!scope || (state.phase !== "uncertain" && !(state.phase === "review" && state.confirmed && scope.deletionEnabled))) return;
      try {
        if (!submission) {
          const requestKey = newKey();
          if (!isCurrent()) return;
          if (!uuid.test(requestKey)) throw new Error("invalid_request_key");
          submission = JSON.stringify({ leadId, leadUpdatedAt: scope.leadUpdatedAt, receiptIds: scope.receiptIds, requestKey, confirmed: true });
        }
      } catch {
        if (!isCurrent()) return;
        set({ ...state, phase: "error", scope: null, confirmed: false, message: "Не удалось подготовить запрос. Проверьте состав заново." });
        return;
      }
      const current = ++revision;
      set({ ...state, phase: "submitting", message: "" });
      try {
        if (!isCurrent()) return;
        const preparedResponse = await request(`/api/crm/site-inquiry-deletion-operations?workspaceId=${encodeURIComponent(workspaceId)}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "prepare", request: JSON.parse(submission!) }), cache: "no-store", dispatchGuard: isCurrent,
        });
        if (!isCurrent() || current !== revision) return;
        if (preparedResponse.status === 401 || preparedResponse.status === 403) { dispose(); return; }
        const preparedBody: unknown = await preparedResponse.json();
        if (!isCurrent() || current !== revision) return;
        const prepared = preparedResponse.ok ? parseSiteDeletionOperationResponse(preparedBody, workspaceId, lifetime?.actorId) : null;
        if (!prepared || siteDeletionIntentBody(prepared.request) !== submission) throw new Error("unconfirmed_preparation");
        if (prepared.state === "abandoned") {
          submission = null;
          set({ phase: "error", visible: true, scope: null, confirmed: false, message: conflictMessages.deletion_operation_abandoned });
          return;
        }
        if (prepared.state === "committed") {
          submission = null;
          set({ phase: "done", visible: true, scope: null, confirmed: false, message: "Заявка и её копии согласия удалены." });
          return;
        }
        if (!isCurrent()) return;
        const response = await request(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: submission, cache: "no-store", dispatchGuard: isCurrent });
        if (!isCurrent() || current !== revision) return;
        if (response.status === 401 || response.status === 403) { dispose(); return; }
        const body = record(await response.json());
        if (!isCurrent() || current !== revision) return;
        const result = record(body?.data);
        if (response.ok && body?.success === true && result?.deleted === true
          && result.receiptsDeleted === scope.receiptCount && typeof result.replayed === "boolean") {
          submission = null;
          set({ ...state, phase: "done", confirmed: false, scope: null, message: "Заявка и её копии согласия удалены." });
          return;
        }
        const code = typeof body?.code === "string" ? body.code : "";
        if ([400, 404, 409].includes(response.status) && Object.hasOwn(conflictMessages, code)) {
          submission = null;
          set({ ...state, phase: "error", scope: null, confirmed: false, message: conflictMessages[code] });
          return;
        }
        // Even a later auth failure cannot prove that an earlier lost request did not commit.
        throw new Error("unconfirmed_result");
      } catch {
        if (!isCurrent() || current !== revision) return;
        set({ ...state, phase: "uncertain", message: "Результат удаления не подтверждён. Запрос мог выполниться. Повторите тот же запрос; повтор не создаст новое удаление. Если доступ истёк, сначала восстановите вход." });
      }
    },
  };
}

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Check, X, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { operatorApi, OperatorApiError, useOperatorList } from "@/lib/operatorApi";
import { getSupabaseAccessToken } from "@/lib/serverAuth";
import { supabase } from "@/lib/supabase";
import { OperatorLeads } from "./OperatorLeads";
import { OperatorServiceCatalog } from "./OperatorServiceCatalog";
import { OperatorArrivals } from "./OperatorArrivals";
import { OperatorCommandRecovery } from "./OperatorCommandRecovery";
import { useOperatorCommand } from "@/lib/useOperatorCommand";
import type { OperatorCommandAttempt } from "@/lib/operatorCommandAttempt";
import {
  formatArrivalPrice,
  operatorStatusLabels,
  operatorLeadScopeLabels,
  type OperatorRequest,
  type OperatorCommandAction,
  type OperatorCommandResult,
} from "../../../../../lib/crm/operator-contracts";

export function OperatorRequests({
  workspaceId,
  actorId,
  isSessionCurrent,
  onAccessDenied,
}: {
  workspaceId?: string;
  actorId: string;
  isSessionCurrent?: () => boolean;
  onAccessDenied?: () => void;
}) {
  const path = workspaceId
    ? `clinic-operator-requests?workspaceId=${encodeURIComponent(workspaceId)}`
    : "operator-inbox";
  const list = useOperatorList<OperatorRequest>(path, true, workspaceId ? undefined : onAccessDenied);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const command = useOperatorCommand(actorId, workspaceId, "transition", isSessionCurrent);
  const [openRequest, setOpenRequest] = useState<string | null>(null);
  const [openCatalog, setOpenCatalog] = useState<string | null>(null);
  const [openArrivals, setOpenArrivals] = useState<string | null>(null);
  const mounted = useRef(false);
  const pending = useRef<object | null>(null);
  const scope = useRef({ path, actorId, expired: false });
  if (scope.current.path !== path || scope.current.actorId !== actorId) {
    scope.current = { path, actorId, expired: false };
    pending.current = null;
  }
  const renderedScope = scope.current;
  // A mutation belongs to its visible list snapshot, including refreshes/pages.
  const currentView = useRef({ path, actorId, offset: list.offset, data: list.data });
  const scopeChanged =
    currentView.current.path !== path ||
    currentView.current.actorId !== actorId ||
    currentView.current.offset !== list.offset;
  if (scopeChanged || currentView.current.data !== list.data) {
    currentView.current = { path, actorId, offset: list.offset, data: list.data };
    if (busy && !pending.current) setBusy(false);
    if (scopeChanged) {
      setError("");
      setNotice("");
      setOpenRequest(null);
      setOpenCatalog(null);
      setOpenArrivals(null);
    }
  }
  const renderedView = currentView.current;
  // A request-level refusal refreshes the list, not the other request's form.
  const refreshingRefusal = useRef<{
    scope: typeof renderedScope;
    offset: number;
    data: NonNullable<typeof list.data>;
    id: string;
  } | null>(null);
  const retained = refreshingRefusal.current;
  if (retained && (retained.scope !== renderedScope || retained.offset !== list.offset
    || renderedScope.expired || isSessionCurrent?.() === false || list.error
    || (list.data && list.data !== retained.data))) refreshingRefusal.current = null;
  const visibleData = list.data ?? refreshingRefusal.current?.data ?? null;
  const refusedRequestId = !list.data ? refreshingRefusal.current?.id : undefined;
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const isScopeCurrent = useCallback(() => {
    if (!mounted.current || scope.current !== renderedScope || renderedScope.expired) return false;
    if (isSessionCurrent?.() === false) {
      renderedScope.expired = true;
      return false;
    }
    return true;
  }, [renderedScope, isSessionCurrent]);
  const isActorCurrent = useCallback(async (allowSignedOut = false) => {
    if (!isScopeCurrent()) return false;
    let token = "";
    try { token = await getSupabaseAccessToken(actorId); } catch { /* Unknown ownership fails closed. */ }
    if (!isScopeCurrent()) return false;
    if (!token) {
      if (allowSignedOut) {
        try {
          const { data, error } = await supabase.auth.getSession();
          if (!isScopeCurrent()) return false;
          // A missing session still revokes this view; a different account
          // must never receive a denial captured by the previous actor.
          if (!error && !data.session) return true;
        } catch { /* Unknown ownership still fails closed. */ }
      }
      // Once a different/missing actor is observed, A -> B -> A cannot revive
      // callbacks captured by the old view, even without a parent auth event.
      renderedScope.expired = true;
      return false;
    }
    return true;
  }, [actorId, isScopeCurrent, renderedScope]);
  const invalidateAccess = useCallback(async () => {
    if (!await isActorCurrent(true)) return;
    refreshingRefusal.current = null;
    setOpenRequest(null);
    setOpenCatalog(null);
    setOpenArrivals(null);
    setError("Доступ оператора изменился.");
    list.refresh();
    onAccessDenied?.();
  }, [isActorCurrent, list.refresh, onAccessDenied]);
  function resolved(attempt: OperatorCommandAttempt, result: Exclude<OperatorCommandResult, { state: "unconfirmed" }>) {
    if (!isScopeCurrent() || !command.isCurrent()) return;
    pending.current = null; setBusy(false); setError("");
    if (result.state === "committed") {
      setOpenRequest(value => value === attempt.targetId ? null : value);
      setOpenCatalog(value => value === attempt.targetId ? null : value);
      setOpenArrivals(value => value === attempt.targetId ? null : value);
      setNotice("Результат действия подтверждён."); list.refresh();
    } else setNotice("Повтор отправки закрыт.");
  }
  async function change(id: string, action: string) {
    const isCurrent = () => isScopeCurrent() && currentView.current === renderedView;
    if (pending.current || command.blocked || !actorId || !isCurrent()) return;
    // Own the command before a native dialog or React's disabled render. A
    // refresh may retire its view, but cannot admit a second unresolved action.
    const attempt = {};
    pending.current = attempt;
    if (
      action === "end" &&
      !window.confirm(
        "Завершить сотрудничество с этой клиникой или оператором?",
      )
    ) {
      if (pending.current === attempt) pending.current = null;
      return;
    }
    if (!isCurrent() || pending.current !== attempt) {
      if (pending.current === attempt) pending.current = null;
      return;
    }
    const operation = command.claim(action as OperatorCommandAction, id);
    if (!operation) { if (pending.current === attempt) pending.current = null; return; }
    const ownsCommand = () => isCurrent() && command.isCurrent(operation);
    const isSameScope = isScopeCurrent;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await operatorApi<unknown>(
        path,
        { id, action, commandId: operation.commandId },
        "PATCH",
        undefined,
        actorId,
        ownsCommand,
      );
      if (!ownsCommand() || !await isActorCurrent() || !ownsCommand()) return;
      const confirmed = command.complete(operation, value);
      if (confirmed) resolved(operation, confirmed);
    } catch (err) {
      if (!command.isCurrent(operation)) return;
      const accessDenied = err instanceof OperatorApiError && [401, 403].includes(err.status);
      const requestRefused = err instanceof OperatorApiError && [404, 409].includes(err.status);
      // Refusal invalidates this actor/path even after a newer page or refresh.
      const ownsReply = accessDenied || requestRefused ? isSameScope : isCurrent;
      if (!ownsReply() || !await isActorCurrent(accessDenied) || !ownsReply()) return;
      if (requestRefused) {
        setOpenRequest((value) => isSameScope() && value === id ? null : value);
        setOpenCatalog((value) => isSameScope() && value === id ? null : value);
        setOpenArrivals((value) => isSameScope() && value === id ? null : value);
        // Exact-ID invalidation also applies on a newer page. Its old reply
        // must not replace that page's error, busy state or pending read.
        if (!isCurrent()) return;
        setError(err.message);
        if (list.data) refreshingRefusal.current = { scope: renderedScope, offset: list.offset, data: list.data, id };
        list.refresh();
        return;
      }
      if (accessDenied) {
        refreshingRefusal.current = null;
        setOpenRequest(null);
        setOpenCatalog(null);
        setOpenArrivals(null);
        list.refresh();
        if (!workspaceId) onAccessDenied?.();
      }
      setError(
        err instanceof Error ? err.message : "Не удалось изменить предложение",
      );
    } finally {
      if (pending.current === attempt) {
        pending.current = null;
        if (isSameScope()) setBusy(false);
      }
    }
  }
  return (
    <section
      className="min-w-0 space-y-3"
      aria-label="Предложения о сотрудничестве"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">
          {workspaceId ? "Ваши предложения" : "Предложения клиник"}
        </h2>
        <button
          className="neu-btn"
          type="button"
          onClick={list.refresh}
          aria-label="Обновить предложения"
          title="Обновить предложения"
        >
          <RefreshCw size={16} />
        </button>
      </div>
      <OperatorCommandRecovery key={`${actorId}:${path}:${command.attempt?.commandId ?? "idle"}`} command={command} onResolved={resolved} onAccessDenied={() => void invalidateAccess()} />
      {notice && <p role="status" className="break-words text-sm">{notice}</p>}
      {(error || list.error) && (
        <p role="alert" className="break-words text-sm text-red-700">
          {error || list.error}
        </p>
      )}
      {!visibleData && !list.error && <p role="status">Загружаем предложения…</p>}
      {visibleData?.items.length === 0 && (
        <p className="text-sm opacity-70">Предложений пока нет.</p>
      )}
      {visibleData?.items.map((item) => (
        <article
          key={item.id}
          className="min-w-0 rounded-lg border p-4 space-y-3"
          style={{ borderColor: "var(--negis-border)" }}
        >
          <div className="flex flex-wrap justify-between gap-2">
            <h3 className="font-semibold break-words min-w-0">
              {item.displayName || "Предложение о сотрудничестве"}
            </h3>
            <span className="text-sm opacity-70">
              {operatorStatusLabels[item.status]}
            </span>
          </div>
          <p className="whitespace-pre-wrap break-words text-sm">
            {item.clinicBrief}
          </p>
          <p className="font-medium">
            {formatArrivalPrice(item.pricePerArrivalMinor, item.currency)} за
            подтверждённый приход
          </p>
          <p className="text-sm">
            Доступ: {operatorLeadScopeLabels[item.leadScope || "assigned"]}
          </p>
          <div className="flex flex-wrap gap-2">
            {item.status === "requested" && (
              <>
                {!workspaceId && (
                  <button
                    type="button"
                    className="neu-btn-primary"
                    disabled={busy || command.blocked}
                    onClick={() => void change(item.id, "accept")}
                  >
                    <Check size={16} />
                    Принять условия
                  </button>
                )}
                <button
                  type="button"
                  className="neu-btn"
                  disabled={busy || command.blocked}
                  onClick={() =>
                    void change(item.id, workspaceId ? "withdraw" : "decline")
                  }
                >
                  <X size={16} />
                  {workspaceId ? "Отозвать" : "Отклонить"}
                </button>
              </>
            )}
            {item.status === "accepted" && item.id !== refusedRequestId && (
              <>
                {!workspaceId && (
                  <button
                    type="button"
                    className="neu-btn"
                    aria-expanded={openCatalog === item.id}
                    onClick={() =>
                      setOpenCatalog(openCatalog === item.id ? null : item.id)
                    }
                  >
                    {openCatalog === item.id ? "Скрыть прайс" : "Услуги и цены"}
                  </button>
                )}
                <button
                  type="button"
                  className="neu-btn"
                  aria-expanded={openArrivals === item.id}
                  onClick={() =>
                    setOpenArrivals(openArrivals === item.id ? null : item.id)
                  }
                >
                  {openArrivals === item.id
                    ? "Скрыть приходы"
                    : workspaceId
                      ? "Подтвердить приходы"
                      : "Приходы и звонки"}
                </button>
                <button
                  type="button"
                  className="neu-btn"
                  aria-expanded={openRequest === item.id}
                  onClick={() =>
                    setOpenRequest(openRequest === item.id ? null : item.id)
                  }
                >
                  {openRequest === item.id
                    ? "Скрыть заявки"
                    : workspaceId && item.leadScope !== "clinic"
                      ? "Назначить заявки"
                      : "Открыть заявки"}
                </button>
                <button
                  type="button"
                  className="neu-btn"
                  disabled={busy || command.blocked}
                  onClick={() => void change(item.id, "end")}
                >
                  Завершить сотрудничество
                </button>
              </>
            )}
          </div>
          {item.status === "accepted" && item.id !== refusedRequestId && openRequest === item.id && (
            <OperatorLeads
              key={`${item.id}:leads`}
              actorId={actorId}
              isSessionCurrent={isSessionCurrent}
              requestId={item.id}
              workspaceId={workspaceId}
              leadScope={item.leadScope || "assigned"}
              onAccessDenied={workspaceId ? undefined : invalidateAccess}
            />
          )}
          {!workspaceId && item.status === "accepted" && item.id !== refusedRequestId && openCatalog === item.id && (
            <OperatorServiceCatalog key={`${item.id}:catalog`} requestId={item.id} onAccessDenied={invalidateAccess} />
          )}
          {item.status === "accepted" && item.id !== refusedRequestId && openArrivals === item.id && (
            <OperatorArrivals
              key={`${item.id}:arrivals`}
              actorId={actorId}
              isSessionCurrent={isSessionCurrent}
              requestId={item.id}
              workspaceId={workspaceId}
              onAccessDenied={workspaceId ? undefined : invalidateAccess}
            />
          )}
        </article>
      ))}
      <div className="flex gap-2">
        <button
          type="button"
          className="neu-btn"
          onClick={list.previous}
          disabled={list.offset === 0}
        >
          <ChevronLeft size={16} />
          Назад
        </button>
        <button
          type="button"
          className="neu-btn"
          onClick={list.next}
          disabled={!list.data?.hasMore}
        >
          Далее
          <ChevronRight size={16} />
        </button>
      </div>
    </section>
  );
}

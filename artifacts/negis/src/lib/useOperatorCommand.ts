import { useLayoutEffect, useRef, useState } from "react";
import { OperatorApiError } from "@/lib/operatorApi";
import { clearOperatorCommand, operatorCommandStorage, persistOperatorCommand, restoreOperatorCommand,
  type OperatorCommandAttempt } from "./operatorCommandAttempt";
import { parseOperatorCommandResult, type OperatorCommandAction } from "../../../../lib/crm/operator-contracts";

export function useOperatorCommand(actorId: string, workspaceId: string | undefined,
  channel: OperatorCommandAttempt["channel"], isSessionCurrent?: () => boolean) {
  const [, render] = useState(0);
  const storage = operatorCommandStorage();
  const createScope = () => ({ actorId, workspaceId: workspaceId ?? null, channel, mounted: false, expired: false,
    ...restoreOperatorCommand(storage, actorId, workspaceId ?? null, channel) });
  const live = useRef<ReturnType<typeof createScope> | null>(null);
  if (!live.current || live.current.actorId !== actorId || live.current.workspaceId !== (workspaceId ?? null) || live.current.channel !== channel) {
    if (live.current) live.current.mounted = false;
    live.current = createScope();
  }
  const scope = live.current;
  useLayoutEffect(() => {
    scope.mounted = true;
    // A mount/effect replay adopts a new object, never revives an in-flight owner.
    const restored = restoreOperatorCommand(storage, actorId, workspaceId ?? null, channel);
    scope.attempt = restored.attempt; scope.error = restored.error;
    if (restored.attempt || restored.error) render(value => value + 1);
    return () => { scope.mounted = false; };
  }, [scope]);
  const isCurrent = (attempt?: OperatorCommandAttempt) => {
    if (live.current !== scope || !scope.mounted || scope.expired) return false;
    if (isSessionCurrent?.() === false) { scope.expired = true; return false; }
    return !attempt || scope.attempt === attempt;
  };
  return {
    attempt: scope.attempt,
    error: scope.error,
    blocked: Boolean(scope.attempt || scope.error),
    path: workspaceId ? `clinic-operator-requests?workspaceId=${encodeURIComponent(workspaceId)}` : "operator-inbox",
    isCurrent,
    claim(action: OperatorCommandAction, targetId: string): OperatorCommandAttempt | null {
      if (!isCurrent() || scope.attempt || scope.error) return null;
      const previous = restoreOperatorCommand(storage, actorId, workspaceId ?? null, channel);
      if (previous.attempt || previous.error) {
        scope.attempt = previous.attempt; scope.error = previous.error; render(value => value + 1); return null;
      }
      try {
        const attempt: OperatorCommandAttempt = { actorId, workspaceId: workspaceId ?? null, channel, commandId: crypto.randomUUID(), action, targetId };
        if (!persistOperatorCommand(storage, attempt)) throw new Error();
        scope.attempt = attempt; render(value => value + 1); return attempt;
      } catch {
        scope.error = "Не удалось сохранить безопасный ключ отправки. Отправка не начата.";
        render(value => value + 1); return null;
      }
    },
    complete(attempt: OperatorCommandAttempt, value: unknown) {
      if (!isCurrent(attempt)) return null;
      const result = parseOperatorCommandResult(value, attempt.commandId, attempt);
      if (!result) throw new OperatorApiError("Результат исходной отправки не подтверждён.", 503);
      if (result.state === "unconfirmed") return null;
      if (!clearOperatorCommand(storage, attempt)) throw new OperatorApiError("Результат подтверждён, но ключ отправки не очищен. Новая отправка заблокирована.", 503);
      scope.attempt = null; render(value => value + 1); return result;
    },
  };
}
export type OperatorCommandController = ReturnType<typeof useOperatorCommand>;

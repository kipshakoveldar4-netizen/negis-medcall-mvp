import { useLayoutEffect, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { operatorApi, OperatorApiError } from "@/lib/operatorApi";
import type { OperatorCommandController } from "@/lib/useOperatorCommand";
import type { OperatorCommandAttempt } from "@/lib/operatorCommandAttempt";
import type { OperatorCommandResult } from "../../../../../lib/crm/operator-contracts";

export function OperatorCommandRecovery({ command, onResolved, onAccessDenied }: {
  command: OperatorCommandController;
  onResolved: (attempt: OperatorCommandAttempt, result: Exclude<OperatorCommandResult, { state: "unconfirmed" }>) => void;
  onAccessDenied?: () => void;
}) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const mounted = useRef(false), pending = useRef<object | null>(null);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const attempt = command.attempt;
  const isCurrent = () => mounted.current && Boolean(attempt) && command.isCurrent(attempt!);
  async function recover(close: boolean) {
    if (!attempt || pending.current || !isCurrent()) return;
    const owner = {}; pending.current = owner;
    if (close && !window.confirm("Закрыть повтор этой отправки? Если действие уже сохранено, будет показан его результат.")) { pending.current = null; return; }
    if (!isCurrent()) { if (pending.current === owner) pending.current = null; return; }
    setBusy(true); setMessage("");
    try {
      const value = await operatorApi<unknown>(close ? command.path : `${command.path}${command.path.includes("?") ? "&" : "?"}commandId=${encodeURIComponent(attempt.commandId)}`,
        close ? { action: "abandon", commandId: attempt.commandId, commandAction: attempt.action, targetId: attempt.targetId } : undefined,
        "PATCH", undefined, attempt.actorId, isCurrent);
      if (!isCurrent()) return;
      const result = command.complete(attempt, value);
      if (result) onResolved(attempt, result);
      else setMessage("Результат ещё не подтверждён. Исходный ключ сохранён.");
    } catch (error) {
      if (!isCurrent()) return;
      setMessage(error instanceof Error ? error.message : "Не удалось проверить отправку");
      if (error instanceof OperatorApiError && [401, 403].includes(error.status)) onAccessDenied?.();
    } finally {
      if (pending.current === owner) { pending.current = null; if (mounted.current && command.isCurrent()) setBusy(false); }
    }
  }
  if (command.error) return <p role="alert" className="break-words text-sm text-red-700">{command.error}</p>;
  if (!attempt) return null;
  return <aside aria-label="Неподтверждённая отправка" className="min-w-0 space-y-2 border-y py-3">
    <p role="status" className="text-sm">Результат отправки ещё не подтверждён.</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" className="neu-btn" disabled={busy} onClick={() => void recover(false)}><RefreshCw size={16} />Проверить результат</button>
      <button type="button" className="neu-btn" disabled={busy} onClick={() => void recover(true)}><X size={16} />Закрыть отправку</button>
    </div>
    {message && <p role="alert" className="break-words text-sm">{message}</p>}
  </aside>;
}

import { useLayoutEffect, useRef, useState } from "react";
import { OperatorApiError } from "@/lib/operatorApi";
import { clearCreatorCommand, creatorCommandStorage, parseCreatorWrite, persistCreatorCommand, restoreCreatorCommand,
  type CreatorCommandAttempt, type CreatorWrite } from "./creatorCommandAttempt";
import { parseCreatorCommandResult } from "../../../../lib/crm/creator-job-contracts";

export function useCreatorCommand(actorId: string, workspaceId: string | undefined, isSessionCurrent: () => boolean) {
  type Owner = { mounted: boolean; expired: boolean; actorId: string; workspaceId: string | null; guard: () => boolean;
    attempt: CreatorCommandAttempt | null; error: string; draft: { attempt: CreatorCommandAttempt; json: string } | null };
  const [, render] = useState(0);
  const initial = (): Owner => ({ mounted: false, expired: false, actorId, workspaceId: workspaceId ?? null,
    guard: isSessionCurrent, attempt: null, error: "", draft: null });
  const [owner, setOwner] = useState(initial);
  const live = useRef<Owner | null>(null);
  const storage = creatorCommandStorage();
  useLayoutEffect(() => {
    // Effect replay gets a new owner; no old callback can become current again.
    const next = { ...initial(), ...restoreCreatorCommand(storage, actorId, workspaceId ?? null), mounted: true };
    live.current = next; setOwner(next);
    return () => { next.mounted = false; next.draft = null; if (live.current === next) live.current = null; };
  }, [actorId, workspaceId]);
  const isCurrent = (attempt?: CreatorCommandAttempt) => {
    if (live.current !== owner || !owner.mounted || owner.expired || owner.actorId !== actorId || owner.workspaceId !== (workspaceId ?? null)) return false;
    if (!owner.guard()) { owner.expired = true; owner.draft = null; return false; }
    return !attempt || owner.attempt === attempt;
  };
  return {
    lifetime: owner,
    attempt: isCurrent() ? owner.attempt : null,
    error: isCurrent() ? owner.error : "",
    blocked: !isCurrent() || Boolean(owner.attempt || owner.error),
    isCurrent,
    claim(value: CreatorWrite) {
      if (!isCurrent() || owner.attempt || owner.error) return null;
      const write = parseCreatorWrite(value, workspaceId ?? null);
      if (!write) throw new OperatorApiError("Проверьте условия задания и действие.", 400);
      const previous = restoreCreatorCommand(storage, actorId, workspaceId ?? null);
      if (previous.attempt || previous.error) { Object.assign(owner, previous); render(n => n + 1); return null; }
      try {
        const attempt: CreatorCommandAttempt = { actorId, workspaceId: workspaceId ?? null, requestId: crypto.randomUUID(),
          action: write.action, targetId: write.action === "create" ? write.terms.creatorId : write.jobId };
        if (!persistCreatorCommand(storage, attempt)) throw Error();
        owner.attempt = attempt; owner.draft = { attempt, json: JSON.stringify({ requestId: attempt.requestId, ...write }) };
        render(n => n + 1); return attempt;
      } catch {
        owner.error = "Не удалось сохранить ключ отправки. Отправка не начата.";
        render(n => n + 1); return null;
      }
    },
    payload(attempt: CreatorCommandAttempt) {
      return isCurrent(attempt) && owner.draft?.attempt === attempt ? JSON.parse(owner.draft.json) as unknown : null;
    },
    canRetry: isCurrent() && owner.attempt !== null && owner.draft?.attempt === owner.attempt,
    complete(attempt: CreatorCommandAttempt, value: unknown) {
      if (!isCurrent(attempt)) return null;
      const result = parseCreatorCommandResult(value, { requestId: attempt.requestId, action: attempt.action, targetId: attempt.targetId });
      if (!result) throw new OperatorApiError("Результат исходной отправки не подтверждён.", 503);
      if (result.state === "unconfirmed") return null;
      if (!clearCreatorCommand(storage, attempt)) throw new OperatorApiError("Результат подтверждён, но ключ не очищен. Новая отправка заблокирована.", 503);
      owner.attempt = null; owner.draft = null; render(n => n + 1); return result;
    },
    expire() { if (live.current !== owner) return; owner.expired = true; owner.draft = null; render(n => n + 1); },
  };
}
export type CreatorCommandController = ReturnType<typeof useCreatorCommand>;

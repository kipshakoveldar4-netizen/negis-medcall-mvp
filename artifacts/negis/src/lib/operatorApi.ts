import { useCallback, useEffect, useRef, useState } from "react";
import { CrmApiError, crmFetch, crmErrorMessage } from "@/lib/api";
import {
  OPERATOR_PAGE_SIZE,
  type OperatorList,
} from "../../../../lib/crm/operator-contracts";

export class OperatorApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function operatorApi<T>(
  path: string,
  body?: unknown,
  method = "POST",
  signal?: AbortSignal,
  expectedUserId?: string,
  dispatchGuard?: () => boolean,
): Promise<T> {
  const requestMethod = body === undefined ? "GET" : method;
  let response: Response;
  try {
    response = await crmFetch(`/api/crm/${path}`, {
      method: requestMethod,
      signal,
      expectedUserId,
      dispatchGuard,
      cache: "no-store",
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
  } catch (error) {
    // Missing sessions fail before a Response exists. Forms must still take
    // their access-denied path rather than treating this as an uncertain write.
    if (error instanceof CrmApiError) {
      throw new OperatorApiError(crmErrorMessage(error), error.status);
    }
    throw error;
  }
  if (response.status === 401 || response.status === 403) {
    throw new OperatorApiError(crmErrorMessage(response.status), response.status);
  }
  const payload = (await response.json().catch(() => null)) as {
    success?: boolean;
    error?: string;
    code?: string;
    data?: T;
  } | null;
  if (
    !response.ok ||
    payload?.success !== true ||
    (requestMethod.toUpperCase() === "GET" && !Object.hasOwn(payload, "data"))
  ) {
    throw new OperatorApiError(
      payload?.code === "authorization_unavailable"
        ? "Сервис входа не ответил. Попробуйте обновить данные чуть позже."
        : typeof payload?.error === "string" && payload.error && response.status !== 401 && response.status !== 403
          ? payload.error
          : crmErrorMessage(response.status),
      response.status,
    );
  }
  return payload.data as T;
}

type OperatorListOwner = {
  actorId: string;
  isSessionCurrent?: () => boolean;
};
type OperatorListScope = { owner: OperatorListOwner | undefined; expired: boolean };

function isOperatorListScopeCurrent(scope: OperatorListScope): boolean {
  if (scope.expired) return false;
  if (scope.owner && (!scope.owner.actorId || scope.owner.isSessionCurrent?.() === false)) {
    scope.expired = true;
    return false;
  }
  return true;
}

export function useOperatorList<
  T,
  TList extends OperatorList<T> = OperatorList<T>,
>(path: string, enabled = true, onAccessDenied?: () => void, owner?: OperatorListOwner) {
  // Legacy unowned callers keep their contract. Owned reads never infer an actor
  // from the SDK, and a retired lifetime cannot revive when its actor returns.
  const scope = useRef<OperatorListScope>({ owner, expired: false });
  if (Boolean(scope.current.owner) !== Boolean(owner) || scope.current.owner?.actorId !== owner?.actorId
    || (scope.current.owner?.isSessionCurrent !== owner?.isSessionCurrent && !isOperatorListScopeCurrent(scope.current))) {
    scope.current = { owner, expired: false };
  }
  const renderedScope = scope.current;
  if (owner?.isSessionCurrent?.() === false) renderedScope.expired = true;
  const [request, setRequest] = useState({ path, enabled, scope: renderedScope, offset: 0, revision: 0 });
  const [response, setResponse] = useState<{
    request: typeof request;
    data: TList | null;
    error: string;
  } | null>(null);
  const live = useRef({ path, enabled, request, scope: renderedScope, onAccessDenied });
  live.current = { path, enabled, request, scope: renderedScope, onAccessDenied };

  // Adjust this hook's state before children render, not in a passive effect.
  // Each scope change gets a new identity, including A -> B -> A transitions.
  if (request.path !== path || request.enabled !== enabled || request.scope !== renderedScope) {
    setRequest({
      path,
      enabled,
      scope: renderedScope,
      offset: request.path === path && request.scope === renderedScope ? request.offset : 0,
      revision: request.revision + 1,
    });
  }
  const refresh = useCallback(() => {
    // Invalidate the result before effects run, even if an old GET completes.
    setResponse(null);
    setRequest((value) => ({ ...value, revision: value.revision + 1 }));
  }, []);
  useEffect(() => {
    setResponse(null);
    if (!request.enabled || !isOperatorListScopeCurrent(request.scope)) return;
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && live.current.request === request
      && live.current.path === request.path && live.current.enabled === request.enabled
      && live.current.scope === request.scope && isOperatorListScopeCurrent(request.scope);
    void operatorApi<TList>(
      `${request.path}${request.path.includes("?") ? "&" : "?"}offset=${request.offset}`,
      undefined,
      "GET",
      controller.signal,
      request.scope.owner?.actorId,
      isCurrent,
    )
      .then((result) => {
        if (isCurrent())
          setResponse({ request, data: result, error: "" });
      })
      .catch((error) => {
        if (isCurrent()) {
          setResponse({
            request,
            data: null,
            error:
              error instanceof Error
                ? error.message
                : "Не удалось загрузить список",
          });
          if (error instanceof OperatorApiError && [401, 403].includes(error.status))
            live.current.onAccessDenied?.();
        }
      });
    return () => controller.abort();
  }, [request]);
  const current =
    enabled &&
    request.path === path &&
    request.enabled === enabled &&
    request.scope === renderedScope &&
    isOperatorListScopeCurrent(renderedScope) &&
    response?.request === request
      ? response
      : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? "",
    refresh,
    offset: request.path === path ? request.offset : 0,
    previous: () =>
      setRequest((value) => {
        const offset = Math.max(0, value.offset - OPERATOR_PAGE_SIZE);
        return offset === value.offset ? value : { ...value, offset };
      }),
    next: () =>
      setRequest((value) => ({
        ...value,
        offset: value.offset + OPERATOR_PAGE_SIZE,
      })),
  };
}

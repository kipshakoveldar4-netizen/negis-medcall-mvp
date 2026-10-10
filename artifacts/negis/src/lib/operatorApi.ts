import { useCallback, useEffect, useState } from "react";
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
): Promise<T> {
  const requestMethod = body === undefined ? "GET" : method;
  let response: Response;
  try {
    response = await crmFetch(`/api/crm/${path}`, {
      method: requestMethod,
      signal,
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

export function useOperatorList<
  T,
  TList extends OperatorList<T> = OperatorList<T>,
>(path: string, enabled = true) {
  const [request, setRequest] = useState({ path, enabled, offset: 0, revision: 0 });
  const [response, setResponse] = useState<{
    request: typeof request;
    data: TList | null;
    error: string;
  } | null>(null);

  // Adjust this hook's state before children render, not in a passive effect.
  // Each scope change gets a new identity, including A -> B -> A transitions.
  if (request.path !== path || request.enabled !== enabled) {
    setRequest({
      path,
      enabled,
      offset: request.path === path ? request.offset : 0,
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
    if (!request.enabled) return;
    const controller = new AbortController();
    void operatorApi<TList>(
      `${request.path}${request.path.includes("?") ? "&" : "?"}offset=${request.offset}`,
      undefined,
      "GET",
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted)
          setResponse({ request, data: result, error: "" });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setResponse({
            request,
            data: null,
            error:
              error instanceof Error
                ? error.message
                : "Не удалось загрузить список",
          });
      });
    return () => controller.abort();
  }, [request]);
  const current =
    enabled &&
    request.path === path &&
    request.enabled === enabled &&
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

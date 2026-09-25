import { useCallback, useEffect, useState } from "react";
import { crmFetch, crmErrorMessage } from "@/lib/api";
import {
  OPERATOR_PAGE_SIZE,
  type OperatorList,
} from "../../../../lib/crm/operator-contracts";

export async function operatorApi<T>(
  path: string,
  body?: unknown,
  method = "POST",
  signal?: AbortSignal,
): Promise<T> {
  const response = await crmFetch(`/api/crm/${path}`, {
    method: body === undefined ? "GET" : method,
    signal,
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const payload = (await response.json().catch(() => null)) as {
    success?: boolean;
    error?: string;
    code?: string;
    data?: T;
  } | null;
  if (!response.ok || !payload?.success) {
    throw new Error(
      payload?.code === "authorization_unavailable"
        ? "Сервис входа не ответил. Попробуйте обновить данные чуть позже."
        : payload?.error && response.status !== 401 && response.status !== 403
          ? payload.error
          : crmErrorMessage(response.status),
    );
  }
  return payload.data as T;
}

export function useOperatorList<
  T,
  TList extends OperatorList<T> = OperatorList<T>,
>(path: string, enabled = true) {
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<TList | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    setData(null);
    setError("");
    if (!enabled) return;
    const controller = new AbortController();
    void operatorApi<TList>(
      `${path}${path.includes("?") ? "&" : "?"}offset=${offset}`,
      undefined,
      "GET",
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : "Не удалось загрузить список",
          );
      });
    return () => controller.abort();
  }, [path, enabled, offset, revision]);
  return {
    data: enabled ? data : null,
    error,
    refresh,
    offset,
    previous: () =>
      setOffset((value) => Math.max(0, value - OPERATOR_PAGE_SIZE)),
    next: () => setOffset((value) => value + OPERATOR_PAGE_SIZE),
  };
}

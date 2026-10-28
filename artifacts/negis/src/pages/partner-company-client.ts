import { apiUrl, crmFetch, CrmApiError } from "@/lib/api";
import type { PartnerCompanyApplicationRequest } from "@/components/contributors/PartnerCompanyApplication";

/** The entry cookie belongs to this origin and must never follow a remote API base. */
export function companyRequestForActor(actorId: string, isActorCurrent: () => boolean): PartnerCompanyApplicationRequest {
  return async options => {
    const path = options.operation === "context" || options.operation === "submit"
      ? `/api/crm/partner-entry/company?op=${options.operation}`
      : options.operation === "read"
        ? `/api/crm/partner-company?${new URLSearchParams({ requestId: options.requestId ?? "", sourceId: options.sourceId ?? "" })}`
        : "/api/crm/partner-company";
    const url = new URL(apiUrl(path), window.location.origin);
    if (url.username || url.password || url.hash || url.origin !== window.location.origin
      || url.pathname !== path.split("?")[0] || url.search !== new URL(path, window.location.origin).search)
      throw new CrmApiError(503, "same_origin_required", "Заявка доступна только на основном адресе платформы.");
    const isCurrent = () => isActorCurrent() && options.isCurrent();
    const body = options.operation === "context" ? {} : options.operation === "close"
      ? { operation: "close", requestId: options.requestId, sourceId: options.sourceId } : options.body;
    const response = await crmFetch(path, {
      method: options.operation === "read" ? "GET" : "POST",
      ...(options.operation === "read" ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
      signal: options.signal, expectedUserId: actorId, dispatchGuard: isCurrent,
      credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
    });
    options.signal.throwIfAborted();
    if (!isCurrent()) throw new DOMException("Account changed", "AbortError");
    if (!response.ok) throw new CrmApiError(response.status, "partner_company_request_failed",
      response.status === 403 ? "Доступ к заявке изменился." : "Не удалось подтвердить результат. Проверьте исходную заявку.");
    const value: unknown = await response.json();
    options.signal.throwIfAborted();
    if (!isCurrent()) throw new DOMException("Account changed", "AbortError");
    if (!value || typeof value !== "object" || !("success" in value) || value.success !== true || !("data" in value))
      throw new Error("Не удалось проверить ответ сервера.");
    return value.data;
  };
}

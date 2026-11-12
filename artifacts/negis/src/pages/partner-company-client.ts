import { apiUrl, crmFetch, CrmApiError } from "@/lib/api";
import type { PartnerCompanyApplicationRequest } from "@/components/contributors/PartnerCompanyApplication";
import { parsePartnerCompanyApplication, type PartnerCompanyState } from "../../../../lib/crm/partner-company-contracts";

type Scope = { signal: AbortSignal; isCurrent(): boolean };

async function requestCompany(actorId: string, isActorCurrent: () => boolean, options: Scope, path: string, method: "GET" | "POST", body?: unknown) {
  const url = new URL(apiUrl(path), window.location.origin);
  if (url.username || url.password || url.hash || url.origin !== window.location.origin
    || url.pathname !== path.split("?")[0] || url.search !== new URL(path, window.location.origin).search)
    throw new CrmApiError(503, "same_origin_required", "Заявка доступна только на основном адресе платформы.");
  const isCurrent = () => isActorCurrent() && options.isCurrent();
  const response = await crmFetch(path, {
    method, ...(method === "GET" ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
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
}

/** The entry cookie belongs to this origin and must never follow a remote API base. */
export function companyRequestForActor(actorId: string, isActorCurrent: () => boolean): PartnerCompanyApplicationRequest {
  return async options => {
    const path = options.operation === "context" || options.operation === "submit"
      ? `/api/crm/partner-entry/company?op=${options.operation}`
      : options.operation === "read"
        ? `/api/crm/partner-company?${new URLSearchParams({ requestId: options.requestId ?? "", sourceId: options.sourceId ?? "" })}`
        : "/api/crm/partner-company";
    const body = options.operation === "context" ? {} : options.operation === "close"
      ? { operation: "close", requestId: options.requestId, sourceId: options.sourceId } : options.body;
    return requestCompany(actorId, isActorCurrent, options, path, options.operation === "read" ? "GET" : "POST", body);
  };
}

export function companyInboxRequestForActor(actorId: string, isActorCurrent: () => boolean) {
  return async (options: Scope & { offset: number; state: PartnerCompanyState | null }): Promise<unknown> => {
    if (!Number.isInteger(options.offset) || options.offset < 0 || options.offset > 1000000
      || (options.state !== null && options.state !== "pending" && options.state !== "approved" && options.state !== "rejected"))
      throw new CrmApiError(400, "invalid_partner_company_query", "Проверьте параметры списка.");
    const query = new URLSearchParams({ view: "list", offset: String(options.offset) });
    if (options.state !== null) query.set("state", options.state);
    return requestCompany(actorId, isActorCurrent, options, "/api/crm/partner-company?" + query, "GET");
  };
}

export function companyWorkspaceRequestForActor(actorId: string, isActorCurrent: () => boolean) {
  return async (options: Scope & { applicationId: string; revision: string }) => {
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
    if (typeof options.applicationId !== "string" || typeof options.revision !== "string"
      || !uuid.test(options.applicationId) || !uuid.test(options.revision))
      throw new CrmApiError(400, "invalid_partner_company_query", "Проверьте выбранную заявку.");
    const query = new URLSearchParams({ view: "workspace", applicationId: options.applicationId, revision: options.revision });
    const value = await requestCompany(actorId, isActorCurrent, options, "/api/crm/partner-company?" + query, "GET");
    const application = parsePartnerCompanyApplication(value);
    if (!application || application.state !== "approved" || application.id.toLowerCase() !== options.applicationId.toLowerCase()
      || application.revision.toLowerCase() !== options.revision.toLowerCase())
      throw new CrmApiError(503, "partner_company_unconfirmed", "Не удалось подтвердить выбранную компанию.");
    return application;
  };
}

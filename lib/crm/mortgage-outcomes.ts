import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isUuidValue } from "../auth/server";
import { getSupabaseServerClient } from "../supabase/server";
import { readWorkspaceContext } from "./server";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function instant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
    || !Number.isFinite(Date.parse(value))) return false;
  const day = value.slice(0, 10);
  return new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
}

export function validateMortgageContract(body: unknown, method: string) {
  const b = record(body), keys = method === "POST" ? ["leadId", "requestId", "signedAt", "reference"] : ["leadId", "requestId", "id", "reason"];
  if (!Object.keys(b).length || Object.keys(b).some(key => !keys.includes(key))
    || !isUuidValue(b.leadId) || !isUuidValue(b.requestId)) return null;
  if (method === "POST") {
    if (!instant(b.signedAt) || typeof b.reference !== "string" || b.reference.length > 100) return null;
    return { leadId: b.leadId, requestId: b.requestId, id: null, payload: { signedAt: new Date(b.signedAt).toISOString(), reference: b.reference.trim() } };
  }
  if (method !== "PATCH" || !isUuidValue(b.id) || typeof b.reason !== "string" || !b.reason.trim() || b.reason.length > 500) return null;
  return { leadId: b.leadId, requestId: b.requestId, id: b.id, payload: { reason: b.reason.trim() } };
}

function json(res: VercelResponse, status: number, body: unknown) {
  res.setHeader("Cache-Control", "private, no-store");
  return res.status(status).json(body);
}

export async function handleMortgageOutcomes(req: VercelRequest, res: VercelResponse, resource: "contracts" | "results") {
  const context = readWorkspaceContext(req), method = req.method || "GET";
  const allowed = resource === "results" ? ["owner", "admin"] : ["owner", "admin", "lead_manager"];
  if (!context || context.purpose !== "mortgage_leads" || !allowed.includes(context.role)
    || !isUuidValue(context.workspaceId) || !isUuidValue(context.staffUserId) || !isUuidValue(context.userId)
    || (method === "PATCH" && context.role === "lead_manager")) {
    return json(res, 403, { success: false, code: "workspace_access_denied", error: "Недостаточно прав" });
  }
  const params: Record<string, unknown> = { p_workspace_id: context.workspaceId, p_staff_user_id: context.staffUserId, p_auth_user_id: context.userId };
  let rpc: string;
  if (resource === "results") {
    if (method !== "GET") return json(res, 405, { success: false, code: "method_not_allowed" });
    const days = req.query.days === undefined ? 30 : typeof req.query.days === "string" && ["7", "30", "90"].includes(req.query.days) ? Number(req.query.days) : 0;
    if (!days) return json(res, 400, { success: false, code: "invalid_period", error: "Недопустимый период" });
    rpc = "read_mortgage_results"; params.p_days = days;
  } else if (method === "GET") {
    if (!isUuidValue(req.query.leadId)) return json(res, 400, { success: false, code: "invalid_contract", error: "Не указан клиент" });
    rpc = "read_mortgage_contracts"; params.p_lead_id = req.query.leadId;
  } else if (method === "POST" || method === "PATCH") {
    const draft = validateMortgageContract(req.body, method);
    if (!draft) return json(res, 400, { success: false, code: "invalid_contract", error: "Проверьте данные договора" });
    rpc = "save_mortgage_contract";
    Object.assign(params, { p_lead_id: draft.leadId, p_contract_id: draft.id, p_request_id: draft.requestId, p_payload: draft.payload });
  } else return json(res, 405, { success: false, code: "method_not_allowed" });
  const client = getSupabaseServerClient();
  if (!client) return json(res, 503, { success: false, code: "storage_not_configured", error: "Хранилище недоступно" });
  try {
    const { data, error } = await client.rpc(rpc, params);
    if (error) {
      const errors: Record<string, [number, string, string]> = {
        P7001: [403, "workspace_access_denied", "Доступ отозван"],
        P7002: [404, "resource_not_found", "Клиент или договор недоступны"],
        P7008: [503, "timezone_not_configured", "Не указан часовой пояс пространства"],
        P7803: [400, "invalid_contract", "Проверьте данные и дату заключения договора"],
        P7804: [409, "contract_already_recorded", "Договор для этого клиента уже учтён. Обновите карточку"],
        P7805: [409, "contract_already_corrected", "Запись уже исправлена. Обновите карточку"],
        P7806: [409, "lead_requires_assignment", "Сначала назначьте клиенту активного сотрудника"],
        P7807: [409, "request_conflict", "Этот ключ запроса уже использован для другого действия"],
      };
      const selected = errors[error.code];
      if (selected) return json(res, selected[0], { success: false, code: selected[1], error: selected[2] });
      if (["PGRST202", "42883", "42P01"].includes(error.code)) {
        return json(res, 503, { success: false, code: "schema_not_ready", error: "Учёт договоров ещё не подключён к этой базе" });
      }
      throw new Error("outcomes_unavailable");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid_response");
    if (resource === "results") {
      const timeZone = record(data).timeZone;
      if (typeof timeZone !== "string" || !timeZone) throw new Error("invalid_response");
      new Intl.DateTimeFormat("en-GB", { timeZone }).format(0);
    }
    return json(res, 200, { success: true, mode: "supabase", data });
  } catch {
    return json(res, 502, { success: false, code: "outcomes_unavailable", error: "Не удалось загрузить результаты" });
  }
}

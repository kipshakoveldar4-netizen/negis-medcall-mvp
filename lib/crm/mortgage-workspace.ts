import type { VercelRequest, VercelResponse } from "@vercel/node";
import { readWorkspaceContext } from "./server";
import { getSupabaseServerClient } from "../supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function instant(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(v);
  if (!m || Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4]) > 59 || !Number.isFinite(Date.parse(v))) return false;
  return new Date(`${m[1]}T00:00:00Z`).toISOString().slice(0,10) === m[1];
}
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown) => typeof v === "string" ? v.trim() : "";

export function validateMortgageActivity(body: unknown, method: string) {
  const b = record(body);
  const keys = new Set(["id", "expectedUpdatedAt", "requestId", "kind", "leadId", "title", "notes", "status", "priority", "startsAt", "endsAt", "dueAt"]);
  if (Object.keys(b).some(k => !keys.has(k)) || (b.kind !== "meeting" && b.kind !== "task")
    || !UUID.test(text(b.leadId)) || typeof b.title !== "string" || !text(b.title) || text(b.title).length > 200
    || (b.notes !== undefined && (typeof b.notes !== "string" || b.notes.length > 10000))
    || (b.priority !== undefined && !["low", "normal", "high"].includes(text(b.priority)))) return null;
  const status = b.status === undefined ? "open" : b.status;
  if (typeof status !== "string" || !(b.kind === "meeting" ? ["open", "done", "cancelled", "missed"] : ["open", "in_progress", "done", "cancelled"]).includes(status)) return null;
  if (method === "POST" && (!UUID.test(text(b.requestId)) || b.id !== undefined || b.expectedUpdatedAt !== undefined)) return null;
  if (method === "PATCH" && (!UUID.test(text(b.id)) || !instant(b.expectedUpdatedAt))) return null;
  if (b.kind === "meeting") {
    if (!instant(b.startsAt) || !instant(b.endsAt) || b.dueAt != null) return null;
    const duration = Date.parse(String(b.endsAt)) - Date.parse(String(b.startsAt));
    if (duration < 5 * 60000 || duration > 24 * 3600000) return null;
  } else if (b.startsAt != null || b.endsAt != null || (b.dueAt != null && !instant(b.dueAt))) return null;
  return {
    kind: b.kind, leadId: b.leadId, title: text(b.title), notes: text(b.notes), status,
    priority: text(b.priority) || "normal", startsAt: b.kind === "meeting" ? b.startsAt : null,
    endsAt: b.kind === "meeting" ? b.endsAt : null, dueAt: b.kind === "task" ? b.dueAt ?? null : null,
  };
}

export async function handleMortgageWorkspace(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  const context = readWorkspaceContext(req);
  if (!context || context.purpose !== "mortgage_leads" || !["owner", "admin", "lead_manager"].includes(context.role)
    || !UUID.test(context.workspaceId) || !UUID.test(context.staffUserId) || !UUID.test(context.userId)) {
    return res.status(403).json({ success: false, error: "Раздел недоступен", code: "workspace_access_denied" });
  }
  const method = req.method || "GET";
  const params: Record<string, unknown> = { p_workspace_id: context.workspaceId, p_staff_user_id: context.staffUserId, p_auth_user_id: context.userId };
  let rpc: string;
  if (method === "GET") {
    if (["q","page","days","leadId","from","to"].some(k => req.query[k] !== undefined && typeof req.query[k] !== "string")) {
      return res.status(400).json({ success: false, error: "Некорректные фильтры", code: "invalid_filter" });
    }
    const q = text(req.query.q);
    const page = Number(req.query.page ?? 0);
    const days = Number(req.query.days ?? 30);
    const leadId = text(req.query.leadId);
    const from = req.query.from == null ? null : text(req.query.from);
    const to = req.query.to == null ? null : text(req.query.to);
    if (q.length > 100 || !Number.isInteger(page) || page < 0 || page > 100000 || ![7, 30, 90].includes(days)
      || (leadId && !UUID.test(leadId)) || (from !== null && !instant(from)) || (to !== null && !instant(to))
      || (from && to && (Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > 366 * 86400000))) {
      return res.status(400).json({ success: false, error: "Некорректные фильтры", code: "invalid_filter" });
    }
    rpc = "read_mortgage_workspace";
    Object.assign(params, { p_query: q, p_page: page, p_lead_id: leadId || null, p_from: from, p_to: to, p_days: days });
  } else if (["POST", "PATCH"].includes(method)) {
    const payload = validateMortgageActivity(req.body, method);
    if (!payload) return res.status(400).json({ success: false, error: "Проверьте клиента, название, время и статус", code: "invalid_activity" });
    const b = record(req.body);
    rpc = "save_mortgage_activity";
    Object.assign(params, { p_activity_id: method === "PATCH" ? b.id : null, p_expected_updated_at: method === "PATCH" ? b.expectedUpdatedAt : null,
      p_request_id: method === "POST" ? b.requestId : null, p_payload: payload });
  } else return res.status(405).json({ success: false, error: "Метод недоступен" });
  const supabase = getSupabaseServerClient();
  if (!supabase) return res.status(503).json({ success: false, error: "Хранилище недоступно", code: "storage_not_configured" });
  try {
    const { data, error } = await supabase.rpc(rpc, params);
    if (error) {
      const errors: Record<string, [number, string, string]> = {
        P7001: [403, "Доступ отозван", "workspace_access_denied"],
        P7002: [404, "Клиент или запись недоступны", "resource_not_found"],
        P7003: [400, "Проверьте данные записи", "invalid_activity"],
        P7004: [409, "На это время уже назначена встреча", "meeting_conflict"],
        P7005: [409, "Запись уже изменена. Обновите данные перед сохранением", "activity_changed"],
        P7006: [409, "Сначала назначьте клиенту активного менеджера", "lead_requires_assignment"],
        P7007: [409, "Этот ключ уже использован для другой записи", "request_conflict"],
        P7008: [503, "Не указан часовой пояс пространства", "timezone_not_configured"],
      };
      const selected = errors[error.code];
      if (selected) return res.status(selected[0]).json({ success: false, error: selected[1], code: selected[2] });
      if (["PGRST202", "42883", "42P01"].includes(error.code)) {
        return res.status(503).json({ success: false, error: "Новые разделы ещё не подключены к этой базе", code: "schema_not_ready" });
      }
      return res.status(502).json({ success: false, error: "Не удалось выполнить запрос", code: "mortgage_unavailable" });
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return res.status(502).json({ success: false, error: "Некорректный ответ хранилища" });
    return res.status(200).json({ success: true, mode: "supabase", data });
  } catch {
    return res.status(502).json({ success: false, error: "Не удалось выполнить запрос", code: "mortgage_unavailable" });
  }
}

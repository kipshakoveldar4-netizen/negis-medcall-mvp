import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isUuidValue } from "../auth/server";
import { getSupabaseServerClient } from "../supabase/server";
import { readWorkspaceContext } from "./server";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const counters = ["new", "inProgress", "booked", "postponed", "lost", "other"] as const;
const validCount = (value: unknown, cap: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= cap;
const invalid = (): never => { throw new Error("analytics_incomplete"); };

function timestamp(value: unknown): string {
  if (typeof value !== "string") return invalid();
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) return invalid();
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  calendar.setUTCHours(Number(parts[4]), Number(parts[5]), Number(parts[6]), 0);
  const actual = [calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, calendar.getUTCDate(),
    calendar.getUTCHours(), calendar.getUTCMinutes(), calendar.getUTCSeconds()];
  if (actual.some((part, index) => part !== Number(parts[index + 1]))) return invalid();
  return new Date(Date.parse(value)).toISOString();
}

function normalizeAnalytics(value: unknown, workspaceId: string, days: number) {
  const data = record(value), period = record(data.period);
  if (typeof data.workspaceId !== "string" || data.workspaceId.toLowerCase() !== workspaceId.toLowerCase()) return invalid();
  if (typeof data.timeZone !== "string" || !data.timeZone) return invalid();
  try { new Intl.DateTimeFormat("en-GB", { timeZone: data.timeZone }).format(0); } catch { return invalid(); }
  const generatedAt = timestamp(data.generatedAt), from = timestamp(period.from), to = timestamp(period.to);
  // Validate PostgreSQL's sub-millisecond remainder before ISO normalization
  // drops it; otherwise a different cutoff or duration can appear identical.
  const remainder = (value: unknown) => Number((String(value).match(/\.(\d{1,6})/)?.[1] ?? "").padEnd(6, "0").slice(3));
  if (period.days !== days || generatedAt !== to || Date.parse(to) - Date.parse(from) !== days * 86_400_000
    || remainder(data.generatedAt) !== remainder(period.to) || remainder(period.from) !== remainder(period.to)) return invalid();
  if (!validCount(data.totalLeads, 20_000) || !validCount(data.unassignedLeads, 20_000)
    || !validCount(data.otherAssigneeLeads, 20_000) || !Array.isArray(data.members) || data.members.length > 1000
    || typeof data.activityStatus !== "string" || !["available", "unavailable"].includes(data.activityStatus)) return invalid();
  const ids = new Set<string>();
  let assignedTotal = 0, eventTotal = 0;
  const members = data.members.map((value) => {
    const member = record(value), assigned = record(member.assigned), activity = record(member.activity);
    if (!isUuidValue(member.staffId) || typeof member.staffId !== "string" || ids.has(member.staffId.toLowerCase())
      || typeof member.name !== "string" || !member.name.trim() || member.name.length > 1000
      || !["owner", "admin", "lead_manager"].includes(String(member.role)) || typeof member.role !== "string"
      || typeof member.status !== "string" || member.status.length > 100) return invalid();
    const staffId = member.staffId.toLowerCase();
    ids.add(staffId);
    if (!validCount(assigned.total, 20_000) || counters.some((key) => !validCount(assigned[key], 20_000))
      || counters.reduce((sum, key) => sum + (assigned[key] as number), 0) !== assigned.total) return invalid();
    assignedTotal += assigned.total;
    let normalizedActivity = null;
    if (data.activityStatus === "unavailable") {
      if (member.activity !== null) return invalid();
    } else {
      if (!validCount(activity.createdEvents, 30_000) || !validCount(activity.updatedEvents, 30_000)
        || !validCount(activity.touchedLeads, 30_000)) return invalid();
      const events = activity.createdEvents + activity.updatedEvents;
      const lastRecordedAt = activity.lastRecordedAt === null ? null : timestamp(activity.lastRecordedAt);
      if (activity.touchedLeads > events || (events === 0 ? activity.touchedLeads !== 0 || lastRecordedAt !== null
        : activity.touchedLeads === 0 || lastRecordedAt === null)
        || (lastRecordedAt !== null && (lastRecordedAt < from || lastRecordedAt > to))) return invalid();
      eventTotal += events;
      normalizedActivity = { createdEvents: activity.createdEvents, updatedEvents: activity.updatedEvents,
        touchedLeads: activity.touchedLeads, lastRecordedAt };
    }
    return { staffId, name: member.name.trim(), role: member.role, status: member.status,
      assigned: { total: assigned.total, new: assigned.new as number, inProgress: assigned.inProgress as number,
        booked: assigned.booked as number, postponed: assigned.postponed as number, lost: assigned.lost as number, other: assigned.other as number },
      activity: normalizedActivity };
  }).sort((a, b) => a.name.localeCompare(b.name, "ru") || a.staffId.localeCompare(b.staffId));
  if (eventTotal > 30_000 || assignedTotal + data.unassignedLeads + data.otherAssigneeLeads !== data.totalLeads) return invalid();
  return { timeZone: data.timeZone, generatedAt, period: { days, from, to }, totalLeads: data.totalLeads, unassignedLeads: data.unassignedLeads,
    otherAssigneeLeads: data.otherAssigneeLeads, activityStatus: data.activityStatus, members };
}

function json(res: VercelResponse, status: number, body: unknown) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(status).json(body);
}

export async function handleLeadTeamAnalytics(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return json(res, 405, { success: false, code: "method_not_allowed" });
  const context = readWorkspaceContext(req);
  if (!context || !isUuidValue(context.workspaceId) || !isUuidValue(context.staffUserId) || !isUuidValue(context.userId)
    || context.purpose !== "mortgage_leads" || !["owner", "admin"].includes(context.role)) {
    return json(res, 403, { success: false, code: "workspace_access_denied", error: "Недостаточно прав" });
  }
  const rawDays = req.query.days;
  const days = rawDays === undefined ? 30 : typeof rawDays === "string" && ["7", "30", "90"].includes(rawDays) ? Number(rawDays) : 0;
  if (!days) return json(res, 400, { success: false, code: "invalid_period", error: "Недопустимый период" });
  const client = getSupabaseServerClient();
  if (!client) return json(res, 503, { success: false, error: "Хранилище недоступно" });
  try {
    const { data, error } = await client.rpc("read_lead_team_analytics", {
      p_workspace_id: context.workspaceId, p_staff_user_id: context.staffUserId, p_auth_user_id: context.userId, p_days: days,
    });
    if (error) {
      const code = record(error).code;
      if (code === "P7001") return json(res, 403, { success: false, code: "workspace_access_denied", error: "Недостаточно прав" });
      if (code === "P8303") return json(res, 400, { success: false, code: "invalid_period", error: "Недопустимый период" });
      if (code === "P7008") return json(res, 503, { success: false, code: "timezone_not_configured", error: "Не указан часовой пояс пространства" });
      if (code === "42883" || code === "PGRST202") return json(res, 503, { success: false, code: "analytics_unavailable", error: "Сводка команды временно недоступна" });
      return json(res, 502, { success: false, code: "analytics_incomplete", error: "Не удалось загрузить полную сводку команды" });
    }
    const analytics = normalizeAnalytics(data, context.workspaceId, days);
    return json(res, 200, { success: true, mode: "supabase", data: { analytics } });
  } catch {
    return json(res, 502, { success: false, code: "analytics_incomplete", error: "Не удалось загрузить полную сводку команды" });
  }
}

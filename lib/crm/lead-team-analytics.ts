import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isUuidValue } from "../auth/server";
import { getSupabaseServerClient } from "../supabase/server";
import { readWorkspaceContext } from "./server";

type Row = Record<string, unknown>;
type Page = { data: unknown; error: unknown; count: number | null };
type Assigned = { total: number; new: number; inProgress: number; booked: number; lost: number; other: number };
type Activity = { updatedEvents: number; createdEvents: number; touchedLeads: number; lastRecordedAt: string | null };
const PAGE_SIZE = 500;
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const emptyAssigned = (): Assigned => ({ total: 0, new: 0, inProgress: 0, booked: 0, lost: 0, other: 0 });
const emptyActivity = (): Activity => ({ updatedEvents: 0, createdEvents: 0, touchedLeads: 0, lastRecordedAt: null });

// Never turn a PostgREST ceiling, failed page or changing row count into a total.
async function completeRows(fetchPage: (from: number, to: number) => PromiseLike<Page>, cap: number, workspaceId: string) {
  const result: Row[] = [];
  const seen = new Set<string>();
  let expected: number | null = null;
  do {
    const page = await fetchPage(result.length, result.length + PAGE_SIZE - 1);
    if (page.error || !Array.isArray(page.data) || !Number.isSafeInteger(page.count) || page.count! < 0 || page.count! > cap) {
      throw new Error("analytics_incomplete");
    }
    expected ??= page.count;
    if (page.count !== expected || page.data.length !== Math.min(PAGE_SIZE, expected! - result.length)) {
      throw new Error("analytics_incomplete");
    }
    for (const value of page.data) {
      const row = record(value);
      const id = text(row.id);
      if (!isUuidValue(id) || seen.has(id) || row.workspace_id !== workspaceId) throw new Error("analytics_incomplete");
      seen.add(id);
      result.push(row);
    }
  } while (result.length < expected!);
  return result;
}

function bucket(status: unknown, semanticGroup: unknown): Exclude<keyof Assigned, "total"> {
  const group = text(semanticGroup) || text(status).toLowerCase();
  if (group === "new" || group === "новая") return "new";
  if (group === "in_progress" || group === "в работе") return "inProgress";
  if (group === "booked" || group === "записана") return "booked";
  if (group === "lost" || group === "потеряна") return "lost";
  return "other";
}

function json(res: VercelResponse, status: number, body: unknown) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(status).json(body);
}

export async function handleLeadTeamAnalytics(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return json(res, 405, { success: false, code: "method_not_allowed" });
  const context = readWorkspaceContext(req);
  if (!context || !isUuidValue(context.workspaceId) || context.purpose !== "mortgage_leads"
    || !["owner", "admin"].includes(context.role)) {
    return json(res, 403, { success: false, code: "workspace_access_denied", error: "Недостаточно прав" });
  }
  const rawDays = req.query.days;
  const days = rawDays === undefined ? 30 : typeof rawDays === "string" && ["7", "30", "90"].includes(rawDays) ? Number(rawDays) : 0;
  if (!days) return json(res, 400, { success: false, code: "invalid_period", error: "Недопустимый период" });
  const client = getSupabaseServerClient();
  if (!client) return json(res, 503, { success: false, error: "Хранилище недоступно" });
  const workspaceId = context.workspaceId;
  const generatedAt = new Date().toISOString();
  const from = new Date(Date.parse(generatedAt) - days * 86_400_000).toISOString();
  try {
    const staff = await completeRows((start, end) => client.from("staff_users")
      .select("id,workspace_id,full_name,role,status", { count: "exact" }).eq("workspace_id", workspaceId)
      .order("id", { ascending: true }).range(start, end), 1_000, workspaceId);
    const stages = await completeRows((start, end) => client.from("lead_stages")
      .select("id,workspace_id,semantic_group", { count: "exact" }).eq("workspace_id", workspaceId)
      .order("id", { ascending: true }).range(start, end), 1_000, workspaceId);
    const leads = await completeRows((start, end) => client.from("leads")
      .select("id,workspace_id,responsible_user_id,status,stage_id", { count: "exact" }).eq("workspace_id", workspaceId)
      .order("id", { ascending: true }).range(start, end), 20_000, workspaceId);
    const members = staff.filter((row) => ["owner", "admin", "lead_manager"].includes(text(row.role))).map((row) => ({
      staffId: text(row.id), name: text(row.full_name) || "Сотрудник", role: text(row.role), status: text(row.status),
      assigned: emptyAssigned(), activity: emptyActivity() as Activity | null,
    })).sort((a, b) => a.name.localeCompare(b.name, "ru") || a.staffId.localeCompare(b.staffId));
    const memberById = new Map(members.map((member) => [member.staffId, member]));
    const stageById = new Map(stages.map((stage) => [text(stage.id), stage.semantic_group]));
    let unassignedLeads = 0, otherAssigneeLeads = 0;
    for (const lead of leads) {
      const responsibleId = text(lead.responsible_user_id);
      const member = memberById.get(responsibleId);
      if (!responsibleId) unassignedLeads += 1;
      else if (!member) otherAssigneeLeads += 1;
      else {
        member.assigned.total += 1;
        member.assigned[bucket(lead.status, stageById.get(text(lead.stage_id)))] += 1;
      }
    }
    let activityStatus: "available" | "unavailable" = "available";
    try {
      // Count the recorded actor, not today's assignee. No names, notes or
      // contact values from the journal are loaded into this aggregate.
      const events = await completeRows((start, end) => client.from("audit_logs")
        .select("id,workspace_id,actor_staff_user_id,entity_id,action,created_at", { count: "exact" })
        .eq("workspace_id", workspaceId).eq("entity_type", "lead").eq("actor_kind", "manual")
        .in("action", ["created", "updated"]).gte("created_at", from).lte("created_at", generatedAt)
        .order("id", { ascending: true }).range(start, end), 30_000, workspaceId);
      const touched = new Map<string, Set<string>>();
      for (const event of events) {
        const member = memberById.get(text(event.actor_staff_user_id));
        if (!member) continue;
        const timestamp = Date.parse(text(event.created_at)), entityId = text(event.entity_id);
        if (!isUuidValue(entityId) || !Number.isFinite(timestamp) || timestamp < Date.parse(from) || timestamp > Date.parse(generatedAt)
          || !["created", "updated"].includes(text(event.action))) throw new Error("analytics_incomplete");
        const at = new Date(timestamp).toISOString();
        const activity = member.activity!;
        if (event.action === "created") activity.createdEvents += 1;
        else activity.updatedEvents += 1;
        const ids = touched.get(member.staffId) ?? new Set<string>();
        ids.add(entityId);
        touched.set(member.staffId, ids);
        activity.touchedLeads = ids.size;
        if (!activity.lastRecordedAt || at > activity.lastRecordedAt) activity.lastRecordedAt = at;
      }
    } catch {
      activityStatus = "unavailable";
      for (const member of members) member.activity = null;
    }
    return json(res, 200, { success: true, mode: "supabase", data: { analytics: {
      generatedAt, period: { days, from, to: generatedAt }, totalLeads: leads.length,
      unassignedLeads, otherAssigneeLeads, activityStatus, members,
    } } });
  } catch {
    return json(res, 502, { success: false, code: "analytics_incomplete", error: "Не удалось загрузить полную сводку команды" });
  }
}

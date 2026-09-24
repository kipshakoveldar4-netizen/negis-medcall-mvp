import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isUuidValue, requireAuthenticatedUser } from "../auth/server";
import { getSupabaseServerClient } from "../supabase/server";
import { readWorkspaceContext } from "./server";
import { OPERATOR_PAGE_SIZE, type OperatorLead } from "./operator-contracts";

type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const FIELDS = "id,full_name,phone,status,source,created_at";
function json(res: VercelResponse, status: number, data: unknown) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(data);
}
function fail(
  res: VercelResponse,
  status: number,
  error: string,
  code = "operator_leads_unavailable",
) {
  return json(res, status, { success: false, error, code });
}
function dbError(res: VercelResponse, error: unknown, operator = false) {
  const code = str(record(error).code);
  if (["PGRST205", "PGRST202", "42P01", "42703", "42883"].includes(code))
    return fail(
      res,
      503,
      "Доступ к заявкам ещё не подключён. Требуется миграция 054.",
      "operator_leads_not_provisioned",
    );
  if (code === "P0001")
    return fail(
      res,
      operator ? 403 : 409,
      operator
        ? "Доступ к заявкам закрыт. Проверьте статус сотрудничества."
        : "Условия или права изменились. Обновите список.",
    );
  return fail(
    res,
    503,
    "Не удалось загрузить или сохранить заявки. Попробуйте позже.",
  );
}
function lead(value: unknown): OperatorLead {
  const row = record(value);
  return {
    id: str(row.id),
    name: str(row.full_name),
    phone: str(row.phone),
    status: str(row.status),
    source: str(row.source),
    createdAt: str(row.created_at),
  };
}
function offset(req: VercelRequest): number | null {
  const value = req.query.offset ?? "0";
  return typeof value === "string" && /^\d{1,6}$/.test(value)
    ? Number(value)
    : null;
}

export async function handleOperatorLeads(
  req: VercelRequest,
  res: VercelResponse,
) {
  const user = await requireAuthenticatedUser(req);
  const requestId = req.query.requestId;
  const start = offset(req);
  if (!isUuidValue(requestId) || start === null)
    return fail(res, 400, "Выберите клинику и страницу списка.");
  const db = getSupabaseServerClient();
  if (!db) return fail(res, 503, "Хранилище не настроено.");
  // The RPC rechecks the accepted agreement, verified identity, approval and scope
  // at every read. No staff membership or caller-supplied workspace grants access.
  const { data, error } = await db.rpc("read_growth_operator_leads", {
    p_request_id: requestId,
    p_operator_user_id: user.id,
    p_offset: start,
  });
  if (error) return dbError(res, error, true);
  if (!Array.isArray(data))
    return fail(res, 503, "Не удалось проверить доступные заявки.");
  return json(res, 200, {
    success: true,
    data: {
      items: data.slice(0, OPERATOR_PAGE_SIZE).map(lead),
      hasMore: data.length > OPERATOR_PAGE_SIZE,
    },
  });
}

export async function handleClinicOperatorLeads(
  req: VercelRequest,
  res: VercelResponse,
) {
  const context = readWorkspaceContext(req);
  if (!context || !["owner", "admin", "manager"].includes(context.role))
    return fail(res, 403, "Недостаточно прав.");
  const requestId = req.query.requestId;
  const start = offset(req);
  if (!isUuidValue(requestId) || start === null)
    return fail(res, 400, "Выберите предложение и страницу списка.");
  const db = getSupabaseServerClient();
  if (!db) return fail(res, 503, "Хранилище не настроено.");
  const { data: agreement, error: agreementError } = await db
    .from("growth_operator_requests")
    .select("id,lead_scope")
    .eq("workspace_id", context.workspaceId)
    .eq("id", requestId)
    .eq("status", "accepted")
    .maybeSingle();
  if (agreementError) return dbError(res, agreementError);
  if (!agreement)
    return fail(res, 404, "Действующее сотрудничество не найдено.");
  if (req.method === "PATCH") {
    const body = record(req.body);
    if (!isUuidValue(body.leadId) || typeof body.assigned !== "boolean")
      return fail(res, 400, "Выберите заявку и действие.");
    if (record(agreement).lead_scope !== "assigned")
      return fail(
        res,
        409,
        "В этом режиме оператору доступны все заявки клиники.",
      );
    const { error } = await db.rpc("set_growth_operator_lead_assignment", {
      p_request_id: requestId,
      p_lead_id: body.leadId,
      p_staff_id: context.staffUserId,
      p_assigned: body.assigned,
    });
    return error ? dbError(res, error) : json(res, 200, { success: true });
  }
  const searchValue = req.query.search ?? "";
  if (typeof searchValue !== "string" || searchValue.length > 120)
    return fail(res, 400, "Сократите поисковый запрос.");
  let query = db
    .from("leads")
    .select(FIELDS)
    .eq("workspace_id", context.workspaceId);
  // One typed filter, not a user-composed PostgREST expression. Wildcards are escaped.
  const search = searchValue.trim().replace(/[\\%_]/g, "\\$&");
  if (search) query = query.ilike("full_name", `%${search}%`);
  const { data, error } = await query
    .order("created_at", { ascending: false, nullsFirst: false })
    .order("id")
    .range(start, start + OPERATOR_PAGE_SIZE);
  if (error) return dbError(res, error);
  if (!Array.isArray(data))
    return fail(res, 503, "Не удалось проверить список заявок.");
  const rows = data.slice(0, OPERATOR_PAGE_SIZE);
  const assigned = new Set<string>();
  if (rows.length) {
    const { data: assignments, error: assignmentError } = await db
      .from("growth_operator_lead_assignments")
      .select("lead_id")
      .eq("workspace_id", context.workspaceId)
      .eq("operator_request_id", requestId)
      .eq("assigned", true)
      .in(
        "lead_id",
        rows.map((row) => str(record(row).id)),
      );
    if (assignmentError) return dbError(res, assignmentError);
    if (!Array.isArray(assignments))
      return fail(res, 503, "Не удалось проверить назначения заявок.");
    for (const row of assignments) assigned.add(str(record(row).lead_id));
  }
  return json(res, 200, {
    success: true,
    data: {
      items: rows.map((row) => ({
        ...lead(row),
        assigned:
          record(agreement).lead_scope === "clinic" ||
          assigned.has(str(record(row).id)),
      })),
      hasMore: data.length > OPERATOR_PAGE_SIZE,
    },
  });
}

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuthenticatedUser, isUuidValue } from "../auth/server";
import { readPlatformOwner } from "../auth/platform";
import { getSupabaseServerClient } from "../supabase/server";
import { readWorkspaceContext } from "./server";
import {
  OPERATOR_PAGE_SIZE,
  type OperatorProfile,
  type OperatorRequest,
} from "./operator-contracts";

type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const PROFILE_FIELDS = "id,display_name,status,accepting_requests";
const REQUEST_FIELDS =
  "id,clinic_brief,status,price_per_arrival_minor,currency";

function json(res: VercelResponse, status: number, data: unknown) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(data);
}
function fail(
  res: VercelResponse,
  status: number,
  error: string,
  code = "operator_request_failed",
) {
  return json(res, status, { success: false, error, code });
}
function dbError(res: VercelResponse, error: unknown) {
  const code = str(record(error).code);
  if (["PGRST205", "PGRST202", "42P01", "42703", "42883"].includes(code)) {
    return fail(
      res,
      503,
      "Раздел операторов ещё не подключён. Владелец платформы должен применить миграцию 052.",
      "operators_not_provisioned",
    );
  }
  if (["23505", "23514", "P0001"].includes(code)) {
    return fail(
      res,
      409,
      "Предложение или статус оператора изменились. Обновите список и проверьте условия.",
      "operator_conflict",
    );
  }
  return fail(
    res,
    503,
    "Не удалось сохранить или загрузить данные операторов. Попробуйте позже.",
  );
}
function profile(value: unknown): OperatorProfile {
  const row = record(value);
  return {
    id: str(row.id),
    displayName: str(row.display_name),
    status: row.status as OperatorProfile["status"],
    acceptingRequests: row.accepting_requests === true,
  };
}
function request(
  value: unknown,
  relation: "workspaces" | "growth_operator_profiles",
): OperatorRequest {
  const row = record(value);
  const related = record(row[relation]);
  return {
    id: str(row.id),
    displayName: str(related.name || related.display_name),
    clinicBrief: str(row.clinic_brief),
    status: row.status as OperatorRequest["status"],
    currency: str(row.currency),
    pricePerArrivalMinor:
      row.price_per_arrival_minor == null
        ? null
        : String(row.price_per_arrival_minor),
  };
}
function page(req: VercelRequest) {
  const value = req.query.offset ?? "0";
  return typeof value === "string" && /^\d{1,6}$/.test(value)
    ? Number(value)
    : 0;
}
function list(
  res: VercelResponse,
  rows: unknown[] | null,
  mapper: (value: unknown) => unknown,
) {
  return json(res, 200, {
    success: true,
    data: {
      items: (rows || []).slice(0, OPERATOR_PAGE_SIZE).map(mapper),
      hasMore: (rows || []).length > OPERATOR_PAGE_SIZE,
    },
  });
}

/** Router authorization remains mandatory; handlers also fail closed without verified context. */
export async function handlePlatformOperators(
  req: VercelRequest,
  res: VercelResponse,
) {
  const owner = readPlatformOwner(req);
  if (!owner) return fail(res, 404, "Не найдено");
  const db = getSupabaseServerClient();
  if (!db) return fail(res, 503, "Хранилище не настроено");
  if (req.method === "GET") {
    const offset = page(req);
    const { data, error } = await db
      .from("growth_operator_profiles")
      .select(PROFILE_FIELDS)
      .order("created_at", { ascending: false })
      .order("id")
      .range(offset, offset + OPERATOR_PAGE_SIZE);
    return error ? dbError(res, error) : list(res, data, profile);
  }
  const body = record(req.body);
  const action = str(body.action);
  if (
    !isUuidValue(body.id) ||
    !["approve", "suspend"].includes(action)
  )
    return fail(res, 400, "Выберите оператора и действие");
  const patch =
    action === "approve"
      ? {
          status: "approved",
          approved_by: owner.userId,
          approved_at: new Date().toISOString(),
          accepting_requests: false,
        }
      : { status: "suspended", accepting_requests: false };
  const { data, error } = await db
    .from("growth_operator_profiles")
    .update(patch)
    .eq("id", body.id)
    .in(
      "status",
      action === "approve" ? ["pending", "suspended"] : ["approved"],
    )
    .select(PROFILE_FIELDS)
    .maybeSingle();
  if (error) return dbError(res, error);
  return data
    ? json(res, 200, { success: true, data: profile(data) })
    : fail(res, 409, "Статус изменился. Обновите список.");
}

export async function handleOperatorAccount(
  req: VercelRequest,
  res: VercelResponse,
) {
  const user = await requireAuthenticatedUser(req);
  const db = getSupabaseServerClient();
  if (!db) return fail(res, 503, "Хранилище не настроено");
  const { data: existing, error: readError } = await db
    .from("growth_operator_profiles")
    .select(PROFILE_FIELDS)
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (readError) return dbError(res, readError);
  if (req.method === "GET")
    return json(res, 200, {
      success: true,
      data: existing ? profile(existing) : null,
    });
  const body = record(req.body);
  if (req.method === "POST") {
    if (existing)
      return json(res, 200, { success: true, data: profile(existing) });
    const name = str(body.displayName);
    if (!name || name.length > 120)
      return fail(res, 400, "Укажите имя, не более 120 символов");
    // The applicant cannot supply identity, approval, membership or availability.
    const { data, error } = await db
      .from("growth_operator_profiles")
      .insert({
        auth_user_id: user.id,
        display_name: name,
        status: "pending",
        accepting_requests: false,
      })
      .select(PROFILE_FIELDS)
      .single();
    return error
      ? dbError(res, error)
      : json(res, 201, { success: true, data: profile(data) });
  }
  if (typeof body.acceptingRequests !== "boolean")
    return fail(res, 400, "Укажите доступность");
  const { data, error } = await db
    .from("growth_operator_profiles")
    .update({ accepting_requests: body.acceptingRequests })
    .eq("auth_user_id", user.id)
    .eq("status", "approved")
    .select(PROFILE_FIELDS)
    .maybeSingle();
  if (error) return dbError(res, error);
  return data
    ? json(res, 200, { success: true, data: profile(data) })
    : fail(res, 403, "Нужно одобрение владельца платформы");
}

export async function handleOperatorInbox(
  req: VercelRequest,
  res: VercelResponse,
) {
  const user = await requireAuthenticatedUser(req);
  const db = getSupabaseServerClient();
  if (!db) return fail(res, 503, "Хранилище не настроено");
  const { data: p, error: pe } = await db
    .from("growth_operator_profiles")
    .select("id")
    .eq("auth_user_id", user.id)
    .eq("status", "approved")
    .maybeSingle();
  if (pe) return dbError(res, pe);
  if (!p) return fail(res, 403, "Нужно одобрение владельца платформы");
  const operatorId = str(record(p).id);
  if (req.method === "GET") {
    const offset = page(req);
    const { data, error } = await db
      .from("growth_operator_requests")
      .select(`${REQUEST_FIELDS},workspaces(name)`)
      .eq("operator_id", operatorId)
      .order("created_at", { ascending: false })
      .order("id")
      .range(offset, offset + OPERATOR_PAGE_SIZE);
    return error
      ? dbError(res, error)
      : list(res, data, (row) => request(row, "workspaces"));
  }
  const body = record(req.body);
  if (
    !isUuidValue(body.id) ||
    !["accept", "decline", "end"].includes(String(body.action))
  )
    return fail(res, 400, "Выберите предложение и действие");
  // Scope even the preflight; the accept RPC rechecks the verified user atomically.
  const { data: target, error: targetError } = await db
    .from("growth_operator_requests")
    .select("id")
    .eq("id", body.id)
    .eq("operator_id", operatorId)
    .maybeSingle();
  if (targetError) return dbError(res, targetError);
  if (!target) return fail(res, 404, "Предложение не найдено");
  if (body.action === "accept") {
    const { error } = await db.rpc("accept_growth_operator_request", {
      p_request_id: body.id,
      p_operator_user_id: user.id,
    });
    return error ? dbError(res, error) : json(res, 200, { success: true });
  }
  const ending = body.action === "end";
  const { data, error } = await db
    .from("growth_operator_requests")
    .update(
      ending
        ? { status: "ended", ended_at: new Date().toISOString() }
        : { status: "declined" },
    )
    .eq("id", body.id)
    .eq("operator_id", operatorId)
    .eq("status", ending ? "accepted" : "requested")
    .select("id")
    .maybeSingle();
  if (error) return dbError(res, error);
  return data
    ? json(res, 200, { success: true })
    : fail(res, 409, "Предложение изменилось. Обновите список.");
}

export async function handleClinicOperators(
  req: VercelRequest,
  res: VercelResponse,
  directory = false,
) {
  const context = readWorkspaceContext(req);
  if (!context || !["owner", "admin", "manager"].includes(context.role))
    return fail(res, 403, "Недостаточно прав");
  const db = getSupabaseServerClient();
  if (!db) return fail(res, 503, "Хранилище не настроено");
  if (req.method === "GET") {
    const offset = page(req);
    if (directory) {
      const { data, error } = await db
        .from("growth_operator_profiles")
        .select(PROFILE_FIELDS)
        .eq("status", "approved")
        .eq("accepting_requests", true)
        .order("display_name")
        .order("id")
        .range(offset, offset + OPERATOR_PAGE_SIZE);
      return error ? dbError(res, error) : list(res, data, profile);
    }
    const { data, error } = await db
      .from("growth_operator_requests")
      .select(`${REQUEST_FIELDS},growth_operator_profiles(display_name)`)
      .eq("workspace_id", context.workspaceId)
      .order("created_at", { ascending: false })
      .order("id")
      .range(offset, offset + OPERATOR_PAGE_SIZE);
    return error
      ? dbError(res, error)
      : list(res, data, (row) => request(row, "growth_operator_profiles"));
  }
  const body = record(req.body);
  if (req.method === "POST") {
    const brief = str(body.clinicBrief);
    const amount = str(body.pricePerArrivalMinor);
    if (
      !isUuidValue(body.operatorId) ||
      !brief ||
      brief.length > 2000 ||
      !/^\d{1,16}$/.test(amount) ||
      BigInt(amount) > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return fail(
        res,
        400,
        "Нужны оператор, описание клиники до 2000 символов и согласованная цена за приход в тенге",
      );
    }
    const { data, error } = await db
      .from("growth_operator_requests")
      .insert({
        workspace_id: context.workspaceId,
        requested_by_staff_user_id: context.staffUserId,
        operator_id: body.operatorId,
        clinic_brief: brief,
        price_per_arrival_minor: amount,
        currency: "KZT",
        status: "requested",
      })
      .select("id")
      .single();
    return error
      ? dbError(res, error)
      : json(res, 201, { success: true, data: { id: record(data).id } });
  }
  if (!isUuidValue(body.id) || !["withdraw", "end"].includes(String(body.action)))
    return fail(res, 400, "Выберите предложение и действие");
  const ending = body.action === "end";
  const { data, error } = await db
    .from("growth_operator_requests")
    .update(
      ending
        ? { status: "ended", ended_at: new Date().toISOString() }
        : { status: "declined" },
    )
    .eq("id", body.id)
    .eq("workspace_id", context.workspaceId)
    .eq("status", ending ? "accepted" : "requested")
    .select("id")
    .maybeSingle();
  if (error) return dbError(res, error);
  return data
    ? json(res, 200, { success: true })
    : fail(res, 409, "Предложение недоступно или уже изменилось.");
}

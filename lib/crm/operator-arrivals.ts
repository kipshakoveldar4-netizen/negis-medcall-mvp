import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isUuidValue, requireAuthenticatedUser } from "../auth/server";
import { getSupabaseServerClient } from "../supabase/server";
import {
  OPERATOR_PAGE_SIZE,
  type OperatorArrival,
  type OperatorArrivalCheckResult,
} from "./operator-contracts";
import { readWorkspaceContext } from "./server";

type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const results = new Set<OperatorArrivalCheckResult>([
  "confirmed",
  "unconfirmed",
  "unreachable",
]);

function json(res: VercelResponse, status: number, payload: unknown) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(payload);
}

function fail(
  res: VercelResponse,
  status: number,
  error: string,
  code = "operator_arrivals_unavailable",
) {
  return json(res, status, { success: false, error, code });
}

function offset(req: VercelRequest): number | null {
  const value = req.query.offset ?? "0";
  return typeof value === "string" && /^\d{1,6}$/.test(value)
    ? Number(value)
    : null;
}

function parseArrival(
  value: unknown,
  includePhone: boolean,
): OperatorArrival | null {
  const row = record(value);
  const result = text(row.operator_check_result);
  const arrivalId = row.arrival_id === null ? null : text(row.arrival_id);
  const priceMinor = row.price_minor === null ? null : text(row.price_minor);
  const currency = row.currency === null ? null : text(row.currency);
  if (
    !isUuidValue(row.appointment_id) ||
    (arrivalId !== null && !isUuidValue(arrivalId)) ||
    (priceMinor !== null && !/^\d+$/.test(priceMinor)) ||
    (currency !== null && !/^[A-Z]{3}$/.test(currency)) ||
    (result && !results.has(result as OperatorArrivalCheckResult))
  )
    return null;
  const item: OperatorArrival = {
    appointmentId: text(row.appointment_id),
    arrivalId,
    clientName: text(row.client_name),
    startsAt: text(row.starts_at),
    service: text(row.service),
    doctorName: text(row.doctor_name),
    status: text(row.status),
    priceMinor,
    currency,
    clinicConfirmedAt:
      row.clinic_confirmed_at === null ? null : text(row.clinic_confirmed_at),
    operatorCheckedAt:
      row.operator_checked_at === null ? null : text(row.operator_checked_at),
    operatorCheckResult: result ? (result as OperatorArrivalCheckResult) : null,
  };
  if (includePhone) item.clientPhone = text(row.client_phone);
  return item;
}

function list(res: VercelResponse, data: unknown, includePhone: boolean) {
  const raw = record(data).items;
  if (!Array.isArray(raw))
    return fail(res, 503, "Не удалось проверить список приходов.");
  const parsed = raw.map((value) => parseArrival(value, includePhone));
  if (parsed.some((value) => value === null))
    return fail(res, 503, "Не удалось проверить список приходов.");
  return json(res, 200, {
    success: true,
    data: {
      items: parsed.slice(0, OPERATOR_PAGE_SIZE),
      hasMore: parsed.length > OPERATOR_PAGE_SIZE,
    },
  });
}

function databaseError(res: VercelResponse, error: unknown, operator: boolean) {
  const row = record(error);
  const code = text(row.code);
  const message = text(row.message);
  if (["PGRST202", "PGRST205", "42P01", "42703", "42883"].includes(code))
    return fail(
      res,
      503,
      "Подтверждение приходов ещё не подключено. Требуется миграция 066.",
      "operator_arrivals_not_provisioned",
    );
  if (code === "P0001") {
    if (message === "operator_check_invalid")
      return fail(res, 400, "Выберите результат контрольного звонка.");
    if (message === "clinic_confirmation_required")
      return fail(
        res,
        403,
        "Подтвердить приход может только сотрудник клиники.",
      );
    if (message === "clinic_arrival_required")
      return fail(res, 409, "Сначала отметьте запись статусом «Пришёл».");
    if (message === "operator_arrival_unavailable")
      return fail(res, 409, "Эта запись не была создана выбранным оператором.");
    if (message === "arrival_already_assigned")
      return fail(res, 409, "Приход уже закреплён за другим соглашением.");
    if (
      message === "accepted_assignment_required" ||
      message === "operator_arrival_access_denied"
    )
      return fail(
        res,
        operator ? 403 : 409,
        operator
          ? "Доступ к приходам закрыт. Проверьте статус сотрудничества."
          : "Сотрудничество изменилось. Обновите список.",
      );
  }
  return fail(
    res,
    503,
    "Не удалось загрузить или сохранить приходы. Попробуйте позже.",
  );
}

export async function handleOperatorArrivals(
  req: VercelRequest,
  res: VercelResponse,
) {
  const user = await requireAuthenticatedUser(req);
  const requestId = req.query.requestId;
  const start = offset(req);
  if (!isUuidValue(requestId) || start === null)
    return fail(res, 400, "Выберите сотрудничество и страницу списка.");
  const db = getSupabaseServerClient();
  if (!db) return fail(res, 503, "Приходы временно недоступны.");
  if (req.method === "PATCH") {
    const body = record(req.body);
    const result = text(body.result) as OperatorArrivalCheckResult;
    if (
      Object.keys(body).some((key) => !["arrivalId", "result"].includes(key)) ||
      !isUuidValue(body.arrivalId) ||
      !results.has(result)
    )
      return fail(res, 400, "Выберите приход и результат контрольного звонка.");
    const { error } = await db.rpc("record_growth_operator_control_call", {
      p_arrival_id: body.arrivalId,
      p_operator_user_id: user.id,
      p_result: result,
    });
    return error
      ? databaseError(res, error, true)
      : json(res, 200, { success: true });
  }
  if (req.method !== "GET") return fail(res, 405, "Метод недоступен.");
  const { data, error } = await db.rpc("read_growth_operator_arrivals", {
    p_request_id: requestId,
    p_operator_user_id: user.id,
    p_offset: start,
  });
  return error ? databaseError(res, error, true) : list(res, data, true);
}

export async function handleClinicOperatorArrivals(
  req: VercelRequest,
  res: VercelResponse,
) {
  const context = readWorkspaceContext(req);
  if (!context || !["owner", "admin", "manager"].includes(context.role))
    return fail(res, 403, "Недостаточно прав.");
  const requestId = req.query.requestId;
  const start = offset(req);
  if (!isUuidValue(requestId) || start === null)
    return fail(res, 400, "Выберите сотрудничество и страницу списка.");
  const db = getSupabaseServerClient();
  if (!db) return fail(res, 503, "Приходы временно недоступны.");
  if (req.method === "POST") {
    const body = record(req.body);
    if (
      Object.keys(body).some((key) => key !== "appointmentId") ||
      !isUuidValue(body.appointmentId)
    )
      return fail(res, 400, "Выберите запись для подтверждения прихода.");
    const { error } = await db.rpc("confirm_growth_operator_booking_arrival", {
      p_request_id: requestId,
      p_appointment_id: body.appointmentId,
      p_clinic_staff_id: context.staffUserId,
    });
    return error
      ? databaseError(res, error, false)
      : json(res, 200, { success: true });
  }
  if (req.method !== "GET") return fail(res, 405, "Метод недоступен.");
  const { data, error } = await db.rpc("read_clinic_operator_arrivals", {
    p_request_id: requestId,
    p_clinic_staff_id: context.staffUserId,
    p_offset: start,
  });
  return error ? databaseError(res, error, false) : list(res, data, false);
}

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isUuidValue, requireAuthenticatedUser } from "../auth/server";
import { getSupabaseServerClient } from "../supabase/server";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const messages: Record<string, [number, string]> = {
  operator_access_denied: [403, "Доступ к заявке закрыт. Обновите список."],
  operator_booking_invalid: [400, "Проверьте услуги и будущее время записи."],
  operator_booking_retry_conflict: [
    409,
    "Эта отправка уже сохранена с другими параметрами. Обновите список.",
  ],
  operator_booking_contact_required: [
    409,
    "Попросите клинику заполнить имя и телефон в заявке.",
  ],
  operator_booking_schedule_required: [
    409,
    "Клинике нужно настроить часовой пояс и график мастера.",
  ],
  operator_booking_timezone_changed: [
    409,
    "Часовой пояс клиники изменился. Откройте форму заново.",
  ],
  operator_booking_doctor_unavailable: [
    409,
    "Мастер недоступен. Обновите прайс.",
  ],
  operator_booking_service_unavailable: [
    409,
    "Услуга недоступна у выбранного мастера. Обновите прайс.",
  ],
  operator_booking_price_required: [
    409,
    "Клинике нужно указать цену и длительность выбранных услуг.",
  ],
  operator_booking_outside_schedule: [
    409,
    "Запись не помещается в рабочее время мастера. Выберите другое время или уточните график у клиники.",
  ],
  operator_booking_time_taken: [
    409,
    "Это время уже занято. Выберите другое время.",
  ],
  operator_booking_already_exists: [
    409,
    "По этой заявке уже создана запись на это время. Уточните её у клиники.",
  ],
  operator_booking_client_unavailable: [
    409,
    "Клиент в заявке недоступен. Обратитесь в клинику.",
  ],
  operator_booking_client_ambiguous: [
    409,
    "Найдено несколько клиентов с этим телефоном. Клиника должна связать заявку с нужным клиентом.",
  ],
};

export async function handleOperatorBookings(
  req: VercelRequest,
  res: VercelResponse,
) {
  res.setHeader("Cache-Control", "no-store");
  const fail = (status: number, error: string) =>
    res.status(status).json({ success: false, error });
  const user = await requireAuthenticatedUser(req);
  const requestId = req.query.requestId;
  const body = record(req.body);
  const leadId = req.method === "GET" ? req.query.leadId : body.leadId;
  if (!isUuidValue(requestId) || !isUuidValue(leadId))
    return fail(400, "Выберите доступную заявку");
  const db = getSupabaseServerClient();
  if (!db) return fail(503, "Запись временно недоступна");
  const args: Record<string, unknown> = {
    p_request_id: requestId,
    p_operator_user_id: user.id,
    p_lead_id: leadId,
  };
  if (req.method === "POST") {
    const allowed = new Set([
      "leadId",
      "requestKey",
      "doctorId",
      "serviceIds",
      "startsLocal",
      "timeZone",
    ]);
    const local = typeof body.startsLocal === "string" ? body.startsLocal : "";
    const parsed = Date.parse(`${local}:00Z`);
    if (
      Object.keys(body).some((key) => !allowed.has(key)) ||
      !isUuidValue(body.requestKey) ||
      !isUuidValue(body.doctorId) ||
      !Array.isArray(body.serviceIds) ||
      !body.serviceIds.length ||
      body.serviceIds.length > 20 ||
      !body.serviceIds.every(isUuidValue) ||
      new Set(body.serviceIds).size !== body.serviceIds.length ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) ||
      !Number.isFinite(parsed) ||
      new Date(parsed).toISOString().slice(0, 16) !== local ||
      typeof body.timeZone !== "string" ||
      !body.timeZone ||
      body.timeZone.length > 80
    )
      return fail(400, "Выберите мастера, услуги из прайса и время записи");
    Object.assign(args, {
      p_request_key: body.requestKey,
      p_doctor_id: body.doctorId,
      p_service_ids: body.serviceIds,
      p_starts_local: local,
      p_time_zone: body.timeZone,
    });
  } else if (req.method !== "GET") return fail(405, "Метод недоступен");
  const { data, error } = await db.rpc(
    req.method === "GET"
      ? "read_growth_operator_booking_context"
      : "create_growth_operator_booking",
    args,
  );
  if (error) {
    const e = record(error);
    if (["PGRST202", "42883", "42703", "PGRST204"].includes(String(e.code)))
      return fail(
        503,
        "Запись оператором ещё не подключена. Требуется миграция 057.",
      );
    const known = e.code === "P0001" ? messages[String(e.message)] : undefined;
    if (known) return fail(...known);
    return fail(
      503,
      "Не удалось подтвердить запись. Повторите отправку без изменения параметров.",
    );
  }
  const row = record(data);
  if (req.method === "GET") {
    if (row.timeZone !== null && typeof row.timeZone !== "string")
      return fail(503, "Не удалось прочитать настройки записи");
    return res
      .status(200)
      .json({ success: true, data: { timeZone: row.timeZone } });
  }
  if (!isUuidValue(row.id))
    return fail(
      503,
      "Не удалось подтвердить запись. Повторите отправку без изменения параметров.",
    );
  return res.status(200).json({
    success: true,
    data: {
      id: row.id,
      startsAt: row.startsAt,
      service: row.service,
      doctorName: row.doctorName,
      priceMinor: row.priceMinor,
      durationMinutes: row.durationMinutes,
      status: row.status,
      timeZone: row.timeZone,
    },
  });
}

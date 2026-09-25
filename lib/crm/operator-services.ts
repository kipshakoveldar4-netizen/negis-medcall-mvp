import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isUuidValue, requireAuthenticatedUser } from "../auth/server";
import { getSupabaseServerClient } from "../supabase/server";
import { OPERATOR_PAGE_SIZE } from "./operator-contracts";

type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");

export async function handleOperatorServices(
  req: VercelRequest,
  res: VercelResponse,
) {
  res.setHeader("Cache-Control", "no-store");
  const fail = (status: number, error: string) =>
    res.status(status).json({ success: false, error });
  if (req.method !== "GET") return fail(405, "Доступен только просмотр прайса");
  const user = await requireAuthenticatedUser(req);
  const { requestId, doctorId } = req.query;
  const offset = req.query.offset ?? "0";
  if (
    !isUuidValue(requestId) ||
    (doctorId !== undefined && !isUuidValue(doctorId)) ||
    typeof offset !== "string" ||
    !/^\d{1,6}$/.test(offset)
  )
    return fail(400, "Выберите клинику и мастера");
  const db = getSupabaseServerClient();
  if (!db) return fail(503, "Прайс временно недоступен");
  const unavailable = () =>
    fail(503, "Не удалось загрузить прайс. Попробуйте позже.");
  const { data: profile, error: profileError } = await db
    .from("growth_operator_profiles")
    .select("id")
    .eq("auth_user_id", user.id)
    .eq("status", "approved")
    .maybeSingle();
  if (profileError) return unavailable();
  if (!profile) return fail(403, "Доступ оператора не подтверждён");
  const { data: agreement, error: agreementError } = await db
    .from("growth_operator_requests")
    .select("workspace_id")
    .eq("id", requestId)
    .eq("operator_id", record(profile).id)
    .eq("status", "accepted")
    .maybeSingle();
  if (agreementError) return unavailable();
  if (!agreement)
    return fail(403, "Нет действующего сотрудничества с клиникой");
  // The tenant comes only from the authenticated operator's accepted agreement.
  const workspaceId = record(agreement).workspace_id;
  if (!isUuidValue(workspaceId)) return unavailable();
  const start = Number(offset);
  if (doctorId === undefined) {
    const { data, error } = await db
      .from("clinic_doctors")
      .select("id,full_name,specialty")
      .eq("workspace_id", workspaceId)
      .eq("is_active", true)
      .order("full_name")
      .order("id")
      .range(start, start + OPERATOR_PAGE_SIZE);
    if (error || !Array.isArray(data)) return unavailable();
    return res.status(200).json({
      success: true,
      data: {
        items: data.slice(0, OPERATOR_PAGE_SIZE).map((value: unknown) => {
          const row = record(value);
          return {
            id: text(row.id),
            name: text(row.full_name),
            specialty: text(row.specialty),
          };
        }),
        hasMore: data.length > OPERATOR_PAGE_SIZE,
      },
    });
  }
  const { data: doctor, error: doctorError } = await db
    .from("clinic_doctors")
    .select("id")
    .eq("id", doctorId)
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .maybeSingle();
  if (doctorError) return unavailable();
  if (!doctor) return fail(404, "Мастер недоступен. Обновите прайс.");
  const { data, error } = await db
    .from("clinic_services")
    .select("id,name,base_price_minor::text,duration_minutes")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .or(`doctor_id.eq.${doctorId},doctor_id.is.null`)
    .order("name")
    .order("id")
    .range(start, start + OPERATOR_PAGE_SIZE);
  if (error || !Array.isArray(data)) return unavailable();
  return res.status(200).json({
    success: true,
    data: {
      items: data.slice(0, OPERATOR_PAGE_SIZE).map((value: unknown) => {
        const row = record(value);
        return {
          id: text(row.id),
          name: text(row.name),
          priceMinor:
            typeof row.base_price_minor === "string" &&
            /^\d+$/.test(row.base_price_minor)
              ? row.base_price_minor
              : null,
          currency: "KZT",
          durationMinutes:
            typeof row.duration_minutes === "number" &&
            Number.isInteger(row.duration_minutes) &&
            row.duration_minutes > 0
              ? row.duration_minutes
              : null,
        };
      }),
      hasMore: data.length > OPERATOR_PAGE_SIZE,
    },
  });
}

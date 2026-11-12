import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuthenticatedUser } from "../auth/server";
import { getSupabaseServerClient } from "../supabase/server";
import { parsePartnerHistory, partnerHistoryMonth } from "./partner-history-contracts";

export async function handlePartnerHistory(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const fail = (status: number, error: string) => res.status(status).json({ success: false, error });
  if (req.method !== "GET") return fail(405, "Метод не разрешён.");
  const user = await requireAuthenticatedUser(req);
  const rawOffset = req.query.offset ?? "0", month = req.query.month ?? null;
  if (Object.keys(req.query).some(key => !["path", "offset", "month"].includes(key))
    || typeof rawOffset !== "string" || !/^(?:0|[1-9]\d{0,6})$/.test(rawOffset) || Number(rawOffset) > 1_000_000
    || !partnerHistoryMonth(month) || req.body != null && (typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length > 0)) {
    return fail(400, "Проверьте период и страницу истории.");
  }
  const expected = { offset: Number(rawOffset), month };
  const db = getSupabaseServerClient();
  const unavailable = () => fail(503, "Не удалось подтвердить историю начислений. Попробуйте позже.");
  if (!db) return unavailable();
  try {
    const { data, error } = await db.rpc("read_growth_partner_history", { p_actor: user.id, p_offset: expected.offset, p_month: month });
    if (error) return error.code === "P1091" ? fail(403, "Доступ партнёра изменился. Обновите профиль.") : unavailable();
    const history = parsePartnerHistory(data, expected);
    return history ? res.status(200).json({ success: true, data: history }) : unavailable();
  } catch { return unavailable(); }
}

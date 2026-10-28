import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuthenticatedUser } from "../auth/server";
import { getSupabaseServerClient } from "../supabase/server";
import { parseOperatorWorkday } from "./operator-workday-contracts";

export async function handleOperatorWorkday(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const fail = (status: number, error: string) => res.status(status).json({ success: false, error });
  if (req.method !== "GET") return fail(405, "Метод не разрешён.");
  const actor = await requireAuthenticatedUser(req), offset = req.query.offset ?? "0";
  if (Object.keys(req.query).some(key => !["path", "offset"].includes(key)) || typeof offset !== "string"
    || !/^(?:0|[1-9]\d{0,6})$/.test(offset) || Number(offset) > 1000000
    || req.body != null && (typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length > 0)) {
    return fail(400, "Проверьте страницу сводки.");
  }
  const db = getSupabaseServerClient(), unavailable = () => fail(503, "Не удалось подтвердить полную сводку. Попробуйте обновить её.");
  if (!db) return unavailable();
  try {
    const { data, error } = await db.rpc("read_growth_operator_workday", { p_actor: actor.id, p_offset: Number(offset) });
    if (error) return error.code === "P1231" ? fail(403, "Доступ оператора изменился. Обновите профиль.") : unavailable();
    const report = parseOperatorWorkday(data, Number(offset));
    return report ? res.status(200).json({ success: true, data: report }) : unavailable();
  } catch { return unavailable(); }
}

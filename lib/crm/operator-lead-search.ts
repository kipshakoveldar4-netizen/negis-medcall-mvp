import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuthenticatedUser } from "../auth/server";
import { getSupabaseServerClient } from "../supabase/server";
import { parseOperatorLeadSearchQuery, parseOperatorLeadSearchReport } from "./operator-lead-search-contracts";

export async function handleOperatorLeadSearch(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const fail = (status: number, error: string) => res.status(status).json({ success: false, error });
  if (req.method !== "GET") return fail(405, "Метод не разрешён.");
  const actor = await requireAuthenticatedUser(req), query = parseOperatorLeadSearchQuery(req.query);
  const length = req.headers["content-length"], encoding = req.headers["transfer-encoding"];
  if (!query || encoding !== undefined || length !== undefined && length !== "0"
    || req.body != null && (typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length)) return fail(400, "Проверьте поиск и страницу заявок.");
  const db = getSupabaseServerClient(), unavailable = () => fail(503, "Не удалось подтвердить полный список заявок. Попробуйте обновить его.");
  if (!db) return unavailable();
  try {
    const { data, error } = await db.rpc("read_growth_operator_lead_search", {
      p_actor: actor.id, p_search: query.search, p_group: query.group, p_request_id: query.requestId, p_offset: query.offset,
    });
    if (error) return error.code === "P1241" ? fail(403, "Доступ к заявкам изменился. Обновите кабинет.") : unavailable();
    const report = parseOperatorLeadSearchReport(data, query);
    return report ? res.status(200).json({ success: true, data: report }) : unavailable();
  } catch { return unavailable(); }
}

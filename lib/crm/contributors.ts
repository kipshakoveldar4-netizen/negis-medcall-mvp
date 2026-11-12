import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuthenticatedUser, isUuidValue } from "../auth/server";
import { readPlatformOwner } from "../auth/platform";
import { getSupabaseServerClient } from "../supabase/server";
import { CONTRIBUTOR_PAGE_SIZE, parseContributorApplication, parseContributorProfile } from "./contributor-contracts";

const FIELDS = "id,revision,display_name,portfolio_urls,partner_status,creator_status";
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
function dto(v: unknown) {
  const row = record(v);
  const result = parseContributorProfile({ id: row.id, revision: row.revision, displayName: row.display_name,
    portfolioUrls: row.portfolio_urls, partnerStatus: row.partner_status, creatorStatus: row.creator_status });
  if (!result) throw new Error("Invalid contributor receipt");
  return result;
}
function json(res: VercelResponse, status: number, data: unknown) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(data);
}
const fail = (res: VercelResponse, status: number, error: string) => json(res, status, { success: false, error });
function dbError(res: VercelResponse, error: unknown) {
  const code = record(error).code;
  if (code === "P1051") return fail(res, 400, "Проверьте поля заявки.");
  if (code === "P1052") return fail(res, 409, "Заявка изменилась. Обновите список перед решением.");
  return fail(res, 503, "Кабинет блогера временно недоступен. Попробуйте позже.");
}
export async function handleContributorAccount(req: VercelRequest, res: VercelResponse) {
  const user = await requireAuthenticatedUser(req);
  const db = getSupabaseServerClient();
  if (!db) return fail(res, 503, "Хранилище не настроено.");
  if (req.method === "GET") {
    const { data, error } = await db.from("growth_contributor_profiles").select(FIELDS).eq("auth_user_id", user.id).maybeSingle();
    if (error) return dbError(res, error);
    try { return json(res, 200, { success: true, data: data ? dto(data) : null }); } catch { return dbError(res, null); }
  }
  if (req.method !== "POST") return fail(res, 405, "Метод не разрешён.");
  const application = parseContributorApplication(req.body);
  if (!application) return fail(res, 400, "Укажите имя, роль и до пяти публичных HTTPS-ссылок без повторов.");
  const { data, error } = await db.rpc("apply_growth_contributor", { p_actor: user.id,
    p_name: application.displayName, p_partner: application.partner, p_creator: application.creator, p_urls: application.portfolioUrls });
  if (error) return dbError(res, error);
  try { return json(res, 200, { success: true, data: dto(data) }); } catch { return dbError(res, null); }
}
export async function handlePlatformContributors(req: VercelRequest, res: VercelResponse) {
  const owner = readPlatformOwner(req);
  if (!owner) return fail(res, 404, "Не найдено.");
  const db = getSupabaseServerClient();
  if (!db) return fail(res, 503, "Хранилище не настроено.");
  if (req.method === "GET") {
    const raw = req.query.offset ?? "0";
    if (typeof raw !== "string" || !/^\d{1,6}$/.test(raw)) return fail(res, 400, "Некорректная страница.");
    const offset = Number(raw);
    const { data, error } = await db.from("growth_contributor_profiles").select(FIELDS)
      .order("created_at", { ascending: false }).order("id").range(offset, offset + CONTRIBUTOR_PAGE_SIZE);
    if (error) return dbError(res, error);
    try { return json(res, 200, { success: true, data: { items: (data || []).slice(0, CONTRIBUTOR_PAGE_SIZE).map(dto), hasMore: (data || []).length > CONTRIBUTOR_PAGE_SIZE } }); }
    catch { return dbError(res, null); }
  }
  if (req.method !== "PATCH") return fail(res, 405, "Метод не разрешён.");
  const body = record(req.body);
  if (Object.keys(body).some(k => !["id", "revision", "role", "action"].includes(k))
    || !isUuidValue(body.id) || !isUuidValue(body.revision)
    || typeof body.role !== "string" || !["partner", "creator"].includes(body.role)
    || typeof body.action !== "string" || !["approve", "suspend"].includes(body.action))
    return fail(res, 400, "Выберите заявку, роль и действие.");
  const { data, error } = await db.rpc("review_growth_contributor", { p_id: body.id, p_revision: body.revision,
    p_owner: owner.userId, p_role: body.role, p_action: body.action });
  if (error) return dbError(res, error);
  try { return json(res, 200, { success: true, data: dto(data) }); } catch { return dbError(res, null); }
}

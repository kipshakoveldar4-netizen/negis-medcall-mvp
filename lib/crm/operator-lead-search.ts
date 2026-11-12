import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuthenticatedUser } from "../auth/server";
import { getSupabaseServerClient } from "../supabase/server";
import { OPERATOR_LEAD_SEARCH_PATH, parseOperatorLeadSearchBody, parseOperatorLeadSearchRpcReport } from "./operator-lead-search-contracts";

const crmPrefix = "/api/crm/";
const searchPath = crmPrefix + OPERATOR_LEAD_SEARCH_PATH;
const rewritePaths = [crmPrefix + "[...path].ts", crmPrefix + "%5B...path%5D.ts"];
const rewriteQuery = `?path=${OPERATOR_LEAD_SEARCH_PATH}`;

export function operatorLeadSearchRouteSegments(url: string | undefined): string[] | undefined {
  if (!url) return undefined;
  const queryStart = url.indexOf("?");
  const pathname = queryStart < 0 ? url : url.slice(0, queryStart);
  if (pathname === searchPath || pathname.startsWith(searchPath + "/")) {
    return pathname.slice(crmPrefix.length).split("/");
  }
  if (queryStart >= 0 && rewritePaths.includes(pathname)) {
    const path = new URLSearchParams(url.slice(queryStart + 1)).getAll("path")
      .find(value => value === OPERATOR_LEAD_SEARCH_PATH || value.startsWith(OPERATOR_LEAD_SEARCH_PATH + "/"));
    if (path !== undefined) return path.split("/");
  }
  return undefined;
}

function hasOnlyRoutingPath(req: VercelRequest) {
  const rewritten = rewritePaths.some(path => req.url === path + rewriteQuery);
  if (!rewritten && req.url !== searchPath) return false;
  if (Object.keys(req.query).some(key => key !== "path")) return false;
  const path = req.query.path;
  return (!rewritten && path === undefined) || path === OPERATOR_LEAD_SEARCH_PATH
    || (Array.isArray(path) && path.length === 1 && path[0] === OPERATOR_LEAD_SEARCH_PATH);
}

export async function handleOperatorLeadSearch(req: VercelRequest, res: VercelResponse) {
  const fail = (status: number, error: string) => res.status(status).json({ success: false, error });
  if (req.method !== "POST") return fail(405, "Метод не разрешён.");
  const actor = await requireAuthenticatedUser(req);
  const invalid = () => fail(400, "Проверьте поиск и страницу заявок.");
  // Accept Vercel's exact catch-all rewrite, not a caller's query or a path alias.
  if (!hasOnlyRoutingPath(req)) return invalid();
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(contentType.trim())) return invalid();
  const query = parseOperatorLeadSearchBody(req.body);
  if (!query) return invalid();
  const db = getSupabaseServerClient(), unavailable = () => fail(503, "Не удалось подтвердить полный список заявок. Попробуйте обновить его.");
  if (!db) return unavailable();
  try {
    const { data, error } = await db.rpc("read_growth_operator_lead_search", {
      p_actor: actor.id, p_search: query.search, p_group: query.group, p_request_id: query.requestId, p_offset: query.offset,
    });
    if (error) return error.code === "P1241" ? fail(403, "Доступ к заявкам изменился. Обновите кабинет.") : unavailable();
    const report = parseOperatorLeadSearchRpcReport(data, query);
    return report ? res.status(200).json({ success: true, data: report }) : unavailable();
  } catch { return unavailable(); }
}

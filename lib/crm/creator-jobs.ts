import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isUuidValue, requireAuthenticatedUser } from "../auth/server";
import { getSupabaseServerClient } from "../supabase/server";
import { readWorkspaceContext } from "./server";
import { parseCreatorJobAction, parseCreatorJobPage, parseCreatorJobTerms, parseCreatorCommandIdentity, parseCreatorCommandResult,
  parseCreatorDirectory, parseCreatorJobDetail, type CreatorCommandIdentity } from "./creator-job-contracts";

type Scope = { p_actor: string; p_workspace: string | null; p_staff: string | null };
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const keys = (row: Record<string, unknown>, allowed: string[]) => Object.keys(row).length === allowed.length && allowed.every(key => Object.hasOwn(row, key));
function fail(res: VercelResponse, status: number, code: string, error: string) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json({ success: false, code, error });
}
function unavailable(res: VercelResponse, mutation: boolean) {
  return fail(res, 503, mutation ? "creator_job_outcome_unconfirmed" : "creator_jobs_unavailable", mutation
    ? "Результат не подтверждён. Проверьте состояние операции перед повтором."
    : "Не удалось проверить задания. Попробуйте позже.");
}
function dbError(res: VercelResponse, error: unknown, mutation: boolean) {
  const code = object(error)?.code;
  if (code === "P1101" || code === "P1111") return fail(res, 403, "creator_job_access_denied", "Доступ к заданиям изменился. Обновите профиль.");
  if (code === "P1102") return fail(res, 400, "invalid_creator_command", "Проверьте поля задания и результата.");
  if (code === "P1103" || code === "P1113") return fail(res, 409, "creator_command_conflict", "Этот ключ уже относится к другому действию.");
  if (code === "P1104") return fail(res, 409, "creator_job_changed", "Задание или условия изменились. Обновите карточку.");
  if (["PGRST202", "PGRST205", "42P01", "42703", "42883"].includes(String(code)))
    return fail(res, 503, "creator_jobs_not_ready", "Задания авторов ещё не подключены к этой базе.");
  return unavailable(res, mutation);
}
async function scope(req: VercelRequest, clinic: boolean): Promise<Scope | null> {
  if (!clinic) return { p_actor: (await requireAuthenticatedUser(req)).id, p_workspace: null, p_staff: null };
  const context = readWorkspaceContext(req);
  if (!context || !["owner", "admin"].includes(context.role) || !isUuidValue(context.userId)
    || !isUuidValue(context.workspaceId) || !isUuidValue(context.staffUserId)) return null;
  if (req.query.workspaceId !== undefined && req.query.workspaceId !== context.workspaceId) return null;
  return { p_actor: context.userId, p_workspace: context.workspaceId, p_staff: context.staffUserId };
}
function validQuery(req: VercelRequest, clinic: boolean, receipt: boolean) {
  const allowed = ["path", ...(clinic ? ["workspaceId"] : []), ...(receipt ? ["requestId"] : req.method === "GET" ? ["offset"] : [])];
  return Object.keys(req.query).every(key => allowed.includes(key));
}
function pageOffset(value: unknown): number | null {
  if (value === undefined) return 0;
  return typeof value === "string" && /^(0|[1-9]\d{0,6})$/.test(value) && Number(value) <= 1000000 ? Number(value) : null;
}

export async function handleCreatorJobs(req: VercelRequest, res: VercelResponse, clinic = false, receipt = false) {
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "POST"].includes(req.method ?? "")) return fail(res, 405, "method_not_allowed", "Метод не разрешён.");
  const identity = await scope(req, clinic);
  if (!identity) return fail(res, 403, "creator_job_access_denied", "Недостаточно прав для заданий компании.");
  if (!(receipt && req.method === "POST" ? Object.keys(req.query).every(key => ["path", ...(clinic ? ["workspaceId"] : [])].includes(key)) : validQuery(req, clinic, receipt)))
    return fail(res, 400, "invalid_creator_query", "Параметры запроса не разрешены.");
  if (req.method === "GET" && req.body != null && (!object(req.body) || Object.keys(req.body).length))
    return fail(res, 400, "invalid_creator_query", "Тело запроса чтения не разрешено.");
  let rpc: string;
  let params: Record<string, unknown> = { ...identity };
  let requestId: string | null = null;
  let expected: CreatorCommandIdentity | undefined;
  let expectedTerms: ReturnType<typeof parseCreatorJobTerms> = null;
  if (receipt && req.method === "GET") {
    if (!isUuidValue(req.query.requestId)) return fail(res, 400, "invalid_creator_query", "Не указан ключ операции.");
    requestId = req.query.requestId as string;
    rpc = "read_growth_creator_command_v2"; params.p_request = requestId;
  } else if (receipt) {
    const body = object(req.body);
    const identity = parseCreatorCommandIdentity({ requestId: body?.requestId, action: body?.action, targetId: body?.targetId });
    if (!body || !keys(body, ["requestId", "action", "targetId", "operation"]) || body.operation !== "close" || !identity)
      return fail(res, 400, "invalid_creator_command", "Укажите исходную отправку для проверки и закрытия.");
    const allowed = clinic ? ["create", "request_changes", "approve", "cancel"] : ["accept", "decline", "submit"];
    if (!allowed.includes(identity.action)) return fail(res, 403, "creator_job_access_denied", "Действие недоступно для этой стороны задания.");
    requestId = identity.requestId; expected = identity;
    rpc = "close_growth_creator_command_v2";
    params = { ...params, p_request: requestId, p_action: identity.action, p_target: identity.targetId };
  } else if (req.method === "GET") {
    const offset = pageOffset(req.query.offset);
    if (offset === null) return fail(res, 400, "invalid_creator_query", "Некорректная страница.");
    rpc = "read_growth_creator_jobs"; params.p_offset = offset;
  } else {
    const body = object(req.body);
    if (!body || !isUuidValue(body.requestId)) return fail(res, 400, "invalid_creator_command", "Не указан ключ операции.");
    requestId = body.requestId as string;
    let payload: unknown;
    if (body.action === "create") {
      if (!clinic) return fail(res, 403, "creator_job_access_denied", "Автор не создаёт задание от имени компании.");
      const terms = parseCreatorJobTerms(body.terms);
      if (!keys(body, ["requestId", "action", "terms"]) || !terms) return fail(res, 400, "invalid_creator_command", "Укажите автора, срок, сумму и условия задания.");
      payload = terms;
      expectedTerms = terms;
      expected = { requestId, action: "create", targetId: terms.creatorId };
      params = { ...params, p_job: null, p_revision: null };
    } else {
      const command = parseCreatorJobAction({ action: body.action, payload: body.payload });
      if (!keys(body, ["requestId", "jobId", "revision", "action", "payload"]) || !command || !isUuidValue(body.jobId) || !isUuidValue(body.revision))
        return fail(res, 400, "invalid_creator_command", "Проверьте задание, версию и действие.");
      const allowed = clinic ? ["request_changes", "approve", "cancel"] : ["accept", "decline", "submit"];
      if (!allowed.includes(command.action)) return fail(res, 403, "creator_job_access_denied", "Действие недоступно для этой стороны задания.");
      payload = command.payload;
      expected = { requestId, action: command.action, targetId: body.jobId as string };
      params = { ...params, p_job: body.jobId, p_revision: body.revision };
    }
    rpc = "execute_growth_creator_job_v2";
    params = { ...params, p_request: requestId, p_action: body.action, p_payload: payload };
  }
  const db = getSupabaseServerClient();
  if (!db) return unavailable(res, req.method === "POST");
  try {
    const { data, error } = await db.rpc(rpc, params);
    if (error) return dbError(res, error, req.method === "POST");
    const parsed = rpc === "read_growth_creator_jobs" ? parseCreatorJobPage(data) : parseCreatorCommandResult(data, expected);
    if (!parsed || (requestId !== null && (!("requestId" in parsed) || parsed.requestId.toLowerCase() !== requestId.toLowerCase()))) return unavailable(res, req.method === "POST");
    if ("state" in parsed && ((req.method === "POST" && parsed.state === "unconfirmed")
      || (parsed.state === "committed" && expectedTerms !== null && (["title", "brief", "rightsTerms", "feeMinor", "currency", "dueAt"] as const)
        .some(key => parsed.result.job[key] !== expectedTerms![key])))) return unavailable(res, req.method === "POST");
    return res.status(200).json({ success: true, data: parsed });
  } catch { return unavailable(res, req.method === "POST"); }
}

export async function handleCreatorJobReads(req: VercelRequest, res: VercelResponse, clinic: boolean, directory = false) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return fail(res, 405, "method_not_allowed", "Метод не разрешён.");
  const identity = await scope(req, clinic);
  if (!identity || (directory && !clinic)) return fail(res, 403, "creator_job_access_denied", "Недостаточно прав для заданий компании.");
  const allowed = ["path", "offset", ...(clinic ? ["workspaceId"] : []), ...(directory ? [] : ["jobId"])];
  const offset = pageOffset(req.query.offset);
  if (Object.keys(req.query).some(key => !allowed.includes(key)) || offset === null || (!directory && !isUuidValue(req.query.jobId))
    || (req.body != null && (!object(req.body) || Object.keys(req.body).length)))
    return fail(res, 400, "invalid_creator_query", "Проверьте задание и страницу.");
  const db = getSupabaseServerClient();
  if (!db) return unavailable(res, false);
  try {
    const { data, error } = await db.rpc(directory ? "read_growth_creator_directory" : "read_growth_creator_job_detail",
      { ...identity, ...(directory ? {} : { p_job: req.query.jobId }), p_offset: offset });
    if (error) return dbError(res, error, false);
    const parsed = directory ? parseCreatorDirectory(data) : parseCreatorJobDetail(data);
    if (!parsed || (!directory && (!("job" in parsed) || parsed.job.id.toLowerCase() !== (req.query.jobId as string).toLowerCase()
      || parsed.history.offset !== offset))) return unavailable(res, false);
    return res.status(200).json({ success: true, data: parsed });
  } catch { return unavailable(res, false); }
}

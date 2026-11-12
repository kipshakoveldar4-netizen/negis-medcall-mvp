import type { VercelRequest, VercelResponse } from "@vercel/node";
import { canAssignRole, isStaffRole } from "../auth/permissions";
import { isSyntheticEmail } from "../auth/staff-logins";
import { requireAuthenticatedUser, requireWorkspaceRole, WorkspaceAdminAuthError } from "../auth/server";
import { getSupabaseServerClient } from "../supabase/server";
import { generateJoinCode, isJoinCodeShape, normalizeJoinCode } from "./join-codes";
import { readWorkspaceContext } from "./server";
import { escapeLikePattern, normalizeEmail } from "./staff-invitations";

// Третий путь зачисления: человек просится сам, клиника подтверждает.
//
// Первые два начинает клиника — приглашение по почте и логин с паролем из рук в
// руки. Оба требуют, чтобы администратор завёл каждого поимённо, и владелец
// попросил обратное направление: «сотрудник регистрируется, выбирает, в какой
// салон он хочет войти, дальше админ одобряет или отклоняет».
//
// Три вещи, которые делают этот путь безопасным:
//
//   — личность заявителя берётся ТОЛЬКО из проверенного JWT. auth_user_id из
//     тела запроса — ровно та дыра, ради которой отключён POST /api/crm/staff:
//     подделанный идентификатор в строке заявки означал бы, что одобрение
//     привяжет клинику к чужому аккаунту, а админ этого не увидит — он смотрит
//     на имя и почту;
//   — роль называет ОДОБРЯЮЩИЙ в момент решения, а не заявитель при подаче.
//     Селект ролей в заявке приезжал бы к админу предзаполненным, и «Одобрить»
//     нажималось бы не глядя;
//   — Supabase Admin API здесь не вызывается ни разу: аккаунт у человека уже
//     свой. Отсюда и password_reset_required: false — пароль ему никто не
//     задавал.
//
// Важная асимметрия со сменой пароля (staff-credentials): там отказ, если у
// аккаунта есть членство в ДРУГОЙ клинике, потому что пароль пишется в
// АККАУНТ. Одобрение пишет только локальную строку staff_users — работать в
// двух клиниках законно, для этого и существует выбор клиники при входе.
// Проверять здесь чужие членства было бы вредно.

const REQUEST_STATUS_PENDING = "pending";
/** Промахов по коду за окно, после которых — отказ. */
const CODE_MISS_LIMIT = 10;
const CODE_MISS_WINDOW_MINUTES = 60;
/** Потолок ждущих заявок на клинику: выше него экран админа перестаёт читаться. */
const MAX_PENDING_PER_WORKSPACE = 50;
/** Сколько часов после отказа заявка в ту же клинику не подаётся заново. */
const REJECT_COOLDOWN_HOURS = 24;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonRecord;
}

function readString(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function sendJson(res: VercelResponse, status: number, body: JsonRecord) {
  res.status(status).json(body);
}

function serviceUnavailable(res: VercelResponse) {
  return sendJson(res, 503, { success: false, error: "Хранилище не настроено", code: "storage_not_configured" });
}

/**
 * Таблиц ещё нет — миграция 038 не применена. Это отдельный ответ, а не общий
 * сбой: между выкладкой кода и применением миграции проходит время, и экран
 * должен сказать правду, а не советовать обновить страницу.
 */
function isMissingTable(error: unknown): boolean {
  const record = asRecord(error);
  const code = typeof record.code === "string" ? record.code : "";
  const message = typeof record.message === "string" ? record.message.toLowerCase() : "";
  return code === "42P01" || code === "PGRST205" || message.includes("does not exist") || message.includes("schema cache");
}

function notProvisioned(res: VercelResponse) {
  return sendJson(res, 503, {
    success: false,
    error: "Заявки по коду ещё не активированы",
    code: "not_provisioned",
    details: ["Примените migrations/038_staff_join_requests.sql в SQL Editor — после этого код клиники и очередь заявок заработают."],
  });
}

/**
 * Журнал по образцу auditInvitation: только идентификаторы и исход. Ни кода, ни
 * почты, ни телефона, ни текста сообщения — строка лога с кодом клиники это
 * розданная входная дверь.
 */
function audit(event: string, fields: Record<string, string | undefined>) {
  const tail = Object.entries(fields)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.log(`[join-requests] ${event}${tail ? ` ${tail}` : ""}`);
}

// ── Заявитель ──────────────────────────────────────────────────────────────

/** GET/POST /api/crm/join-request — маршрут вида bootstrap: членства ещё нет. */
export async function handleJoinRequest(req: VercelRequest, res: VercelResponse) {
  let user: { id: string; email?: string };
  try {
    user = await requireAuthenticatedUser(req);
  } catch (error) {
    if (error instanceof WorkspaceAdminAuthError) {
      return sendJson(res, error.statusCode, { success: false, error: error.message, code: error.code });
    }
    return serviceUnavailable(res);
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) return serviceUnavailable(res);

  const method = (req.method || "GET").toUpperCase();
  if (method === "GET") return listOwnRequests(supabase, user, res);
  if (method !== "POST") {
    return sendJson(res, 405, { success: false, error: "Method not allowed", code: "method_not_allowed" });
  }
  return submitRequest(supabase, user, req, res);
}

type SupabaseClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>;

/**
 * Свои заявки и ничего больше. Заявитель видит статус, дату и название клиники
 * — название он и так держит в руках вместе с кодом, а увидеть его нужно, чтобы
 * убедиться, что попал в свою клинику, а не в стоматологию через дорогу.
 *
 * НЕ отдаётся: decision_note (свободный текст админа чужой клиники — это
 * неконтролируемый канал наружу из арендатора), кто решал, workspaceId, код.
 */
async function listOwnRequests(supabase: SupabaseClient, user: { id: string }, res: VercelResponse) {
  const { data, error } = await supabase
    .from("staff_join_requests")
    .select("id, status, created_at, decided_at, granted_role, workspace_id, workspaces(name)")
    .eq("auth_user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) return isMissingTable(error) ? notProvisioned(res) : serviceUnavailable(res);

  const requests = (data ?? []).map((row: unknown) => {
    const record = row as JsonRecord & { workspaces?: { name?: string } | { name?: string }[] | null };
    const joined = Array.isArray(record.workspaces) ? record.workspaces[0] : record.workspaces;
    return {
      id: String(record.id),
      status: String(record.status),
      createdAt: String(record.created_at),
      decidedAt: record.decided_at ? String(record.decided_at) : null,
      clinicName: joined?.name ? String(joined.name) : "",
      // Роль — только одобренному: он сейчас войдёт именно ею.
      ...(record.status === "approved" && record.granted_role ? { role: String(record.granted_role) } : {}),
    };
  });

  return sendJson(res, 200, { success: true, mode: "supabase", data: { requests } });
}

/**
 * Подача заявки.
 *
 * Это ПЕРВЫЙ в проекте путь записи, открытый любому аутентифицированному:
 * членства он не требует по определению. Поэтому здесь единственный в проекте
 * ограничитель частоты, и он живёт в базе, а не в памяти процесса — на Vercel
 * каждая инвокация может попасть в новый инстанс, и счётчик в модуле не считал
 * бы ничего. Пишутся только промахи по коду: удачные подачи ограничены
 * частичным уникальным индексом «одна живая заявка на клинику».
 */
async function submitRequest(supabase: SupabaseClient, user: { id: string; email?: string }, req: VercelRequest, res: VercelResponse) {
  const body = asRecord(req.body);
  const code = normalizeJoinCode(body.code);
  const fullName = readString(body.fullName, 120);
  const phone = readString(body.phone, 32);
  const positionNote = readString(body.positionNote, 120);

  if (!fullName) {
    return sendJson(res, 400, {
      success: false, error: "Validation error", code: "validation_error",
      details: ["Укажите имя и код клиники — без них заявку не отправить."],
    });
  }
  // Служебный домен выдаёт система, и самозапись — единственное место, где
  // человек приносит адрес с улицы. Пусти сюда служебный адрес — посторонний
  // занял бы логин раньше клиники и пришёл бы в очередь заявок с адресом,
  // который выглядит выданным платформой.
  if (isSyntheticEmail(user.email)) {
    audit("synthetic_email_refused", { user: user.id });
    return sendJson(res, 403, {
      success: false, error: "Служебный адрес", code: "synthetic_email_refused",
      details: ["Этот аккаунт заведён клиникой. Войдите своим логином — заявка по коду для него не нужна."],
    });
  }
  if (!isJoinCodeShape(code)) {
    // Синтаксический отказ не зависит от того, существует ли клиника, поэтому
    // он не является оракулом и отвечает честно.
    return sendJson(res, 400, {
      success: false, error: "Validation error", code: "join_code_invalid",
      details: ["Код выглядит иначе: четыре буквы и восемь знаков, например MEDI-7K3N-Q82R."],
    });
  }

  // Счётчик промахов проверяется ДО обращения к таблице кодов.
  //
  // Честно про его силу: это НЕ полноценный лимит. Залп параллельных запросов
  // успевает прочитать счётчик раньше, чем первые промахи станут видимы, а
  // аккаунт заводится тут же на экране заявителя, то есть счётчик обнуляется
  // новой почтой. Настоящая защита кода — его энтропия (≈40 бит); счётчик
  // ловит ручной перебор и оставляет след в базе, по которому перебор видно.
  const windowStart = new Date(Date.now() - CODE_MISS_WINDOW_MINUTES * 60_000).toISOString();
  const { count: misses, error: missError } = await supabase
    .from("staff_join_code_attempts")
    .select("id", { count: "exact", head: true })
    .eq("auth_user_id", user.id)
    .gte("created_at", windowStart);
  if (missError) return isMissingTable(missError) ? notProvisioned(res) : serviceUnavailable(res);
  if ((misses ?? 0) >= CODE_MISS_LIMIT) {
    audit("code_throttled", { user: user.id });
    return sendJson(res, 429, {
      success: false, error: "Too many attempts", code: "join_code_throttled",
      details: ["Слишком много попыток с неверным кодом. Попробуйте через час."],
    });
  }

  const { data: codeRow, error: codeError } = await supabase
    .from("workspace_join_codes")
    .select("id, workspace_id, revoked_at")
    .eq("code", code)
    .is("revoked_at", null)
    .maybeSingle();
  if (codeError) return isMissingTable(codeError) ? notProvisioned(res) : serviceUnavailable(res);

  if (!codeRow) {
    await supabase.from("staff_join_code_attempts").insert({ auth_user_id: user.id });
    audit("code_miss", { user: user.id });
    // В теле — только код отказа: ни имени, ни идентификатора клиники.
    return sendJson(res, 404, {
      success: false, error: "Join code not found", code: "join_code_unknown",
      details: ["Такого кода нет. Проверьте символы и спросите код у руководителя."],
    });
  }

  const workspaceId = String((codeRow as { workspace_id: string }).workspace_id);
  const joinCodeId = String((codeRow as { id: string }).id);

  // Уже в команде — заявка не нужна: человек просто входит.
  // Только ДЕЙСТВУЮЩЕЕ членство закрывает путь. Строка на паузе входа не даёт
  // (членства фильтруются по status = active), и отказ «просто войдите» запирал
  // вернувшегося сотрудника между двумя экранами: на входе ему отвечали
  // «аккаунт не привязан к клинике», а в заявке — «вы уже работаете».
  const { data: existingMember, error: memberError } = await supabase
    .from("staff_users")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (memberError) return serviceUnavailable(res);
  if (existingMember) {
    return sendJson(res, 409, {
      success: false, error: "Already a member", code: "already_member",
      details: ["Вы уже работаете в этой клинике. Просто войдите."],
    });
  }

  // Свежий отказ — кулдаун. Политика живёт в маршруте, а не в схеме: она будет
  // меняться, и check-constraint не видит предыдущую строку.
  const { data: recent, error: recentError } = await supabase
    .from("staff_join_requests")
    .select("id, status, decided_at")
    .eq("workspace_id", workspaceId)
    .eq("auth_user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1);
  if (recentError) return serviceUnavailable(res);
  const latest = (recent ?? [])[0] as { status?: string; decided_at?: string | null } | undefined;
  if (latest?.status === REQUEST_STATUS_PENDING) {
    return sendJson(res, 409, {
      success: false, error: "Request already pending", code: "join_request_pending",
      details: ["Заявка уже отправлена — она на рассмотрении."],
    });
  }
  if (latest?.status === "rejected" && latest.decided_at) {
    const hoursSince = (Date.now() - new Date(latest.decided_at).getTime()) / 3_600_000;
    if (hoursSince < REJECT_COOLDOWN_HOURS) {
      return sendJson(res, 409, {
        success: false, error: "Recently rejected", code: "join_request_recently_rejected",
        details: [`Клиника отклонила заявку. Подать заново можно через ${Math.max(1, Math.ceil(REJECT_COOLDOWN_HOURS - hoursSince))} ч.`],
        retryAfterHours: Math.max(1, Math.ceil(REJECT_COOLDOWN_HOURS - hoursSince)),
      });
    }
  }

  // Потолок очереди: тот, кому однажды диктовали код, иначе набивает её сотней
  // заявок с разных аккаунтов, и настоящая заявка тонет.
  const { count: pendingCount, error: pendingError } = await supabase
    .from("staff_join_requests")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("status", REQUEST_STATUS_PENDING);
  if (pendingError) return serviceUnavailable(res);
  if ((pendingCount ?? 0) >= MAX_PENDING_PER_WORKSPACE) {
    audit("queue_full", { workspace: workspaceId, user: user.id });
    return sendJson(res, 429, {
      success: false, error: "Queue is full", code: "join_queue_full",
      details: ["Очередь заявок этой клиники переполнена. Попросите администратора разобрать её и попробуйте позже."],
    });
  }

  const { data: inserted, error: insertError } = await supabase
    .from("staff_join_requests")
    .insert({
      workspace_id: workspaceId,
      join_code_id: joinCodeId,
      // Из ПРОВЕРЕННОГО JWT, а не из тела: см. шапку модуля.
      auth_user_id: user.id,
      email: normalizeEmail(user.email ?? ""),
      full_name: fullName,
      phone,
      position_note: positionNote,
      status: REQUEST_STATUS_PENDING,
    })
    .select("id, status, created_at")
    .maybeSingle();

  if (insertError || !inserted) {
    // Гонка двойного тапа: частичный уникальный индекс отвечает конфликтом
    // 23505, и это 409, а не 500. Любой ДРУГОЙ отказ базы — не «уже подана»:
    // выдавать сбой за успешную подачу значит оставить человека ждать заявку,
    // которой нет.
    const conflict = (insertError as { code?: string } | null)?.code === "23505";
    if (!conflict) return serviceUnavailable(res);
    return sendJson(res, 409, {
      success: false, error: "Request already pending", code: "join_request_pending",
      details: ["Заявка уже отправлена — она на рассмотрении."],
    });
  }

  audit("submitted", { workspace: workspaceId, request: String((inserted as { id: string }).id), user: user.id });

  const { data: workspace } = await supabase.from("workspaces").select("name").eq("id", workspaceId).maybeSingle();
  return sendJson(res, 201, {
    success: true,
    mode: "supabase",
    data: {
      request: {
        id: String((inserted as { id: string }).id),
        status: REQUEST_STATUS_PENDING,
        createdAt: String((inserted as { created_at: string }).created_at),
        clinicName: workspace ? String((workspace as { name?: string }).name ?? "") : "",
      },
    },
  });
}

// ── Очередь клиники ────────────────────────────────────────────────────────

/** GET/PATCH /api/crm/staff-join-requests — за правом manage_staff. */
export async function handleStaffJoinRequests(req: VercelRequest, res: VercelResponse) {
  const context = readWorkspaceContext(req);
  if (!context) {
    return sendJson(res, 403, { success: false, error: "Access denied", code: "workspace_access_denied" });
  }
  const supabase = getSupabaseServerClient();
  if (!supabase) return serviceUnavailable(res);

  const method = (req.method || "GET").toUpperCase();
  if (method === "GET") return listWorkspaceRequests(supabase, context.workspaceId, res);
  if (method !== "PATCH") {
    return sendJson(res, 405, { success: false, error: "Method not allowed", code: "method_not_allowed" });
  }
  return decideRequest(supabase, context, req, res);
}

/**
 * Очередь клиники. auth_user_id заявителя наружу НЕ отдаётся: это глобальный
 * идентификатор платформы, клинике он не нужен ни для чего (все действия
 * адресуются id заявки), а на руках он позволяет сопоставлять одного человека
 * между клиниками.
 */
async function listWorkspaceRequests(supabase: SupabaseClient, workspaceId: string, res: VercelResponse) {
  const columns = "id, status, email, full_name, phone, position_note, created_at, decided_at, decision_note, granted_role, join_code_id, workspace_join_codes(revoked_at)";

  // Ждущие берутся ОТДЕЛЬНЫМ запросом и целиком. Пока список был «100 самых
  // свежих любого статуса», сотня заявок от одного человека, знающего код,
  // выдавливала настоящую заявку с экрана навсегда: отклонение мусора не
  // помогало — отклонённые строки занимали те же места.
  const pending = await supabase
    .from("staff_join_requests")
    .select(columns)
    .eq("workspace_id", workspaceId)
    .eq("status", REQUEST_STATUS_PENDING)
    .order("created_at", { ascending: false })
    .limit(MAX_PENDING_PER_WORKSPACE + 10);
  if (pending.error) {
    if (isMissingTable(pending.error)) return notProvisioned(res);
    // Честный отказ чтения: пустой список означал бы «заявок нет», а это не то
    // же самое, что «прочитать не удалось».
    return serviceUnavailable(res);
  }

  const decided = await supabase
    .from("staff_join_requests")
    .select(columns)
    .eq("workspace_id", workspaceId)
    .neq("status", REQUEST_STATUS_PENDING)
    .order("decided_at", { ascending: false })
    .limit(30);
  if (decided.error) return serviceUnavailable(res);

  const requests = [...(pending.data ?? []), ...(decided.data ?? [])].map((row: unknown) => {
    const record = row as JsonRecord & { workspace_join_codes?: { revoked_at?: string | null } | { revoked_at?: string | null }[] | null };
    const joinCode = Array.isArray(record.workspace_join_codes) ? record.workspace_join_codes[0] : record.workspace_join_codes;
    return {
      id: String(record.id),
      status: String(record.status),
      email: String(record.email ?? ""),
      fullName: String(record.full_name ?? ""),
      phone: String(record.phone ?? ""),
      positionNote: String(record.position_note ?? ""),
      createdAt: String(record.created_at),
      decidedAt: record.decided_at ? String(record.decided_at) : null,
      decisionNote: String(record.decision_note ?? ""),
      grantedRole: record.granted_role ? String(record.granted_role) : null,
      // Ради этого поля коды и живут отдельной таблицей: «код утёк, отклоняю
      // всё, что пришло по старому» — один взгляд вместо расследования.
      viaRevokedCode: Boolean(joinCode?.revoked_at),
    };
  });

  return sendJson(res, 200, { success: true, mode: "supabase", data: { requests } });
}

type WorkspaceContext = NonNullable<ReturnType<typeof readWorkspaceContext>>;

/**
 * Решение по заявке.
 *
 * Порядок обязателен: сначала заявка ЗАХВАТЫВАЕТСЯ условным обновлением
 * (`status = 'pending'` в условии), и только потом пишется членство. Два
 * администратора, нажавшие «Одобрить» одновременно, иначе создали бы две строки
 * staff_users на одного человека. Если вставка членства не удалась — заявка
 * возвращается в pending: одобренная заявка без сотрудника хуже отказа, очередь
 * говорит «готово», а человек войти не может.
 */
async function decideRequest(supabase: SupabaseClient, context: WorkspaceContext, req: VercelRequest, res: VercelResponse) {
  const body = asRecord(req.body);
  const requestId = readString(body.id, 64);
  const decision = readString(body.decision, 16);
  const note = readString(body.note, 500);
  const role = readString(body.role, 32);

  if (!requestId || (decision !== "approve" && decision !== "reject")) {
    return sendJson(res, 400, { success: false, error: "Validation error", code: "validation_error", details: ["Нужны заявка и решение."] });
  }
  if (decision === "approve") {
    if (!isStaffRole(role)) {
      return sendJson(res, 400, { success: false, error: "Validation error", code: "role_required", details: ["Выберите роль — без неё нельзя одобрить."] });
    }
    if (!canAssignRole(context.role, role)) {
      return sendJson(res, 403, {
        success: false, error: "Permission denied", code: "permission_denied",
        details: ["Назначать можно только роли ниже своей, и владельца не назначает никто."],
      });
    }
  }

  const decidedAt = new Date().toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from("staff_join_requests")
    .update({
      status: decision === "approve" ? "approved" : "rejected",
      decided_at: decidedAt,
      decided_by_staff_user_id: context.staffUserId,
      decision_note: note,
      ...(decision === "approve" ? { granted_role: role } : {}),
    })
    .eq("id", requestId)
    // Арендатор — из проверенного контекста, никогда из тела.
    .eq("workspace_id", context.workspaceId)
    .eq("status", REQUEST_STATUS_PENDING)
    .select("id, auth_user_id, email, full_name, phone, created_at")
    .maybeSingle();

  if (claimError) return serviceUnavailable(res);
  if (!claimed) {
    // Чужая клиника, несуществующая строка и уже решённая заявка отвечают
    // одинаково: идентификаторы не перебираются.
    return sendJson(res, 404, {
      success: false, error: "Join request not found", code: "join_request_not_found",
      details: ["Заявку уже обработали. Обновите список."],
    });
  }

  const request = claimed as { id: string; auth_user_id: string; email: string; full_name: string; phone: string; created_at: string };

  if (decision === "reject") {
    audit("decided", { workspace: context.workspaceId, request: request.id, decision: "reject", by: context.staffUserId });
    return sendJson(res, 200, { success: true, mode: "supabase", data: { id: request.id, status: "rejected" } });
  }

  const enrolled = await attachMembership(supabase, context.workspaceId, request, role);
  if (enrolled.kind === "failed" || enrolled.kind === "email_taken") {
    // Возврат в очередь обязателен: одобренная заявка без сотрудника — худшее
    // из состояний, она исчезает с экрана (там только pending), решить её
    // повторно нельзя, а человеку показано «доступ открыт».
    const { data: restored, error: restoreError } = await supabase
      .from("staff_join_requests")
      .update({ status: REQUEST_STATUS_PENDING, decided_at: null, decided_by_staff_user_id: null, granted_role: null, decision_note: "" })
      .eq("id", request.id)
      .select("id")
      .maybeSingle();
    if (restoreError || !restored) {
      // База отказала и на откате — заявка застряла одобренной без сотрудника.
      // Молчать здесь нельзя: снаружи это выглядит как «ничего не произошло».
      audit("rollback_failed", { workspace: context.workspaceId, request: request.id, by: context.staffUserId });
      return sendJson(res, 503, {
        success: false, error: "Approval stuck", code: "join_request_stuck",
        details: ["Заявка отмечена одобренной, но сотрудник не создан. Сообщите владельцу платформы — строку нужно поправить руками."],
      });
    }
    if (enrolled.kind === "email_taken") {
      return sendJson(res, 409, {
        success: false, error: "Email already used in this clinic", code: "staff_email_taken",
        details: ["В клинике уже есть сотрудник с такой почтой. Этот адрес заявитель назвал сам, и подтверждения ему нет — такого человека зачисляют ссылкой-приглашением: она и доказывает, что почта его."],
      });
    }
    return serviceUnavailable(res);
  }

  await supabase.from("staff_join_requests").update({ created_staff_user_id: enrolled.staffUserId }).eq("id", request.id);

  // Живое приглашение на тот же адрес гасится: иначе в одну клинику ведут два
  // пути сразу, и второй создаст второй профиль тому же человеку.
  if (request.email) {
    const { error: revokeError } = await supabase
      .from("staff_invitations")
      .update({ revoked_at: decidedAt })
      .eq("workspace_id", context.workspaceId)
      .ilike("email", escapeLikePattern(request.email))
      .is("accepted_at", null)
      .is("revoked_at", null);
    if (revokeError) {
      // Громко: невидимое приглашение в живых — это второй вход, о котором
      // никто не знает.
      audit("invitation_revoke_failed", { workspace: context.workspaceId, request: request.id });
    }
  }

  audit("decided", {
    workspace: context.workspaceId, request: request.id, decision: "approve",
    role, staffUser: enrolled.staffUserId, by: context.staffUserId,
  });

  return sendJson(res, 200, {
    success: true,
    mode: "supabase",
    data: {
      id: request.id,
      status: "approved",
      staffUserId: enrolled.staffUserId,
      // Экран обязан сказать правду: у «уже в команде» роль осталась прежней,
      // а тост «роль такая-то» был бы ложью.
      outcome: enrolled.kind,
      alreadyMember: enrolled.kind === "already",
    },
  });
}

/**
 * Запись членства.
 *
 * ПОЧЕМУ ЗДЕСЬ НЕТ ДОСТРОЙКИ СТРОКИ ПО ПОЧТЕ. Соседние пути так делают: у них
 * адрес НАЗВАЛА КЛИНИКА, а человек доказал контроль над ним токеном или
 * получил пароль из рук администратора. Здесь адрес выбрал сам заявитель при
 * регистрации, и никто его не подтверждал. Достройка по совпадению адреса
 * означала бы, что человек, которому когда-то диктовали код, регистрируется на
 * адрес заведённого руками директора и получает его строку: его задачи, его
 * авторство в журнале, его расписание. Ревью воспроизвело это по коду.
 *
 * Поэтому совпадение по почте — ОТКАЗ, а не привязка: такого человека клиника
 * зачисляет приглашением, которое как раз и доказывает, что почта его.
 */
async function attachMembership(
  supabase: SupabaseClient,
  workspaceId: string,
  request: { auth_user_id: string; email: string; full_name: string; phone: string; created_at: string },
  role: string,
): Promise<
  | { kind: "created" | "revived" | "already"; staffUserId: string }
  | { kind: "email_taken" }
  | { kind: "failed" }
> {
  const { data: byAccount, error: accountError } = await supabase
    .from("staff_users")
    .select("id, status")
    .eq("workspace_id", workspaceId)
    .eq("auth_user_id", request.auth_user_id)
    .maybeSingle();
  if (accountError) return { kind: "failed" };
  if (byAccount) {
    const existing = byAccount as { id: string; status?: string };
    // Вернувшийся сотрудник — обычное дело в салоне. Его строка на паузе, и
    // членства фильтруются по status = active: без включения он получил бы
    // «одобрено», а на входе — «аккаунт не привязан к клинике». Роль ставим
    // ту, что назвал одобряющий: он только что принял это решение.
    if (existing.status !== "active") {
      const { error: reviveError } = await supabase
        .from("staff_users")
        .update({ status: "active", role })
        .eq("id", existing.id);
      if (reviveError) return { kind: "failed" };
      return { kind: "revived", staffUserId: String(existing.id) };
    }
    // Уже активен: роль НЕ переписываем молча — админ мог не заметить, что
    // человек уже в команде, а тихое понижение или повышение хуже отказа.
    return { kind: "already", staffUserId: String(existing.id) };
  }

  if (request.email) {
    const { data: byEmail, error: emailError } = await supabase
      .from("staff_users")
      .select("id")
      .eq("workspace_id", workspaceId)
      .ilike("email", escapeLikePattern(request.email))
      .maybeSingle();
    if (emailError) return { kind: "failed" };
    if (byEmail) return { kind: "email_taken" };
  }

  const { data: created, error: createError } = await supabase
    .from("staff_users")
    .insert({
      workspace_id: workspaceId,
      email: request.email,
      full_name: request.full_name,
      phone: request.phone,
      role,
      status: "active",
      auth_user_id: request.auth_user_id,
      invited_at: request.created_at,
      // Пароль этому человеку никто не задавал — он свой, придуманный им.
      password_reset_required: false,
    })
    .select("id")
    .maybeSingle();
  if (createError || !created) return { kind: "failed" };
  return { kind: "created", staffUserId: String(created.id) };
}

// ── Код клиники ────────────────────────────────────────────────────────────

/** GET/POST /api/crm/join-code — показать живой код и перевыпустить. */
export async function handleJoinCode(req: VercelRequest, res: VercelResponse) {
  const context = readWorkspaceContext(req);
  if (!context) {
    return sendJson(res, 403, { success: false, error: "Access denied", code: "workspace_access_denied" });
  }
  const supabase = getSupabaseServerClient();
  if (!supabase) return serviceUnavailable(res);

  const method = (req.method || "GET").toUpperCase();
  if (method === "GET") {
    const { data, error } = await supabase
      .from("workspace_join_codes")
      .select("id, code, created_at")
      .eq("workspace_id", context.workspaceId)
      .is("revoked_at", null)
      .maybeSingle();
    if (error) return isMissingTable(error) ? notProvisioned(res) : serviceUnavailable(res);
    // Кода нет — так и говорим. Чтение, порождающее запись, здесь недопустимо:
    // код, который существует, но которого владелец не видел, — это живая
    // входная дверь, за которой никто не следит.
    return sendJson(res, 200, {
      success: true, mode: "supabase",
      data: data ? { code: String((data as { code: string }).code), createdAt: String((data as { created_at: string }).created_at) } : { code: null },
    });
  }

  if (method !== "POST") {
    return sendJson(res, 405, { success: false, error: "Method not allowed", code: "method_not_allowed" });
  }

  const { data: live, error: liveError } = await supabase
    .from("workspace_join_codes")
    .select("id")
    .eq("workspace_id", context.workspaceId)
    .is("revoked_at", null)
    .maybeSingle();
  if (liveError) return isMissingTable(liveError) ? notProvisioned(res) : serviceUnavailable(res);

  // ЗАМЕНА кода — только владелец: она мгновенно ломает код у всех, кому его
  // диктовали. Проверка идёт по ИСТОРИИ, а не по живой строке: если ротация
  // владельца отвалилась между гашением и вставкой, у клиники нет живого кода,
  // и по проверке «есть живой» новый код выпустил бы уже любой админ — то есть
  // сорванная ротация раздавала бы право владельца. Первый в жизни клиники код
  // выпускает любой, кто ведёт сотрудников. Реестр этого выразить не умеет
  // (roles там на весь маршрут, не на метод), поэтому проверка здесь и пинится.
  const { count: everIssued, error: historyError } = await supabase
    .from("workspace_join_codes")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", context.workspaceId);
  if (historyError) return isMissingTable(historyError) ? notProvisioned(res) : serviceUnavailable(res);
  if ((everIssued ?? 0) > 0) {
    try {
      requireWorkspaceRole(context, ["owner"]);
    } catch {
      return sendJson(res, 403, {
        success: false, error: "Permission denied", code: "join_code_owner_only",
        details: ["Сменить код клиники может только владелец."],
      });
    }
  }

  const { data: workspace } = await supabase.from("workspaces").select("name").eq("id", context.workspaceId).maybeSingle();
  const workspaceName = workspace ? String((workspace as { name?: string }).name ?? "") : "";

  // Гашение идёт ДО вставки, иначе живых кодов станет два и уникальный индекс
  // отвергнет новый.
  if (live) {
    const { error: revokeError } = await supabase
      .from("workspace_join_codes")
      .update({ revoked_at: new Date().toISOString(), revoked_by_staff_user_id: context.staffUserId })
      .eq("id", (live as { id: string }).id)
      .is("revoked_at", null);
    if (revokeError) return serviceUnavailable(res);
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateJoinCode(workspaceName);
    const { data: created, error: createError } = await supabase
      .from("workspace_join_codes")
      .insert({ workspace_id: context.workspaceId, code, created_by_staff_user_id: context.staffUserId })
      .select("id, code, created_at")
      .maybeSingle();
    if (!createError && created) {
      // Сам код в журнал не попадает — только факт выпуска.
      audit(live ? "code_rotated" : "code_issued", { workspace: context.workspaceId, by: context.staffUserId });
      return sendJson(res, 201, {
        success: true, mode: "supabase",
        data: { code: String((created as { code: string }).code), createdAt: String((created as { created_at: string }).created_at) },
      });
    }

    // Две разные причины отказа, и повтор помогает только одной. Столкновение
    // по глобально уникальному КОДУ лечится новой генерацией. А вот вторая
    // вкладка, успевшая вставить свой код, держит индекс «живой код на клинику
    // один» — новые попытки будут биться о него все пять раз, и владелец
    // увидел бы 503, хотя код на самом деле сменился, и продиктовал бы старый.
    const { data: liveNow } = await supabase
      .from("workspace_join_codes")
      .select("code, created_at")
      .eq("workspace_id", context.workspaceId)
      .is("revoked_at", null)
      .maybeSingle();
    if (liveNow) {
      return sendJson(res, 200, {
        success: true, mode: "supabase",
        data: {
          code: String((liveNow as { code: string }).code),
          createdAt: String((liveNow as { created_at: string }).created_at),
          // Экран покажет ДЕЙСТВУЮЩИЙ код, а не тот, что не вставился.
          concurrent: true,
        },
      });
    }
  }

  return serviceUnavailable(res);
}

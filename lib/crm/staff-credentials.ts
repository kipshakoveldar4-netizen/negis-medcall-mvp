import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseServerClient } from "../supabase/server";
import { canAssignRole, isStaffRole, type StaffRole } from "../auth/permissions";
import { platformOwnerIds } from "../auth/platform";
import { readWorkspaceContext } from "./server";
import { acceptUrl, createInvitationToken, escapeLikePattern, expiryFromNow, normalizeEmail } from "./staff-invitations";
import { validateOwnerPassword } from "./platform-onboarding-credentials";

// Заведение сотрудника с паролем — второй путь зачисления в команду.
//
// Приглашение доказывало ДВЕ вещи: клиника решает, кто входит и с какой ролью,
// и человек доказывает контроль над своей почтой. Письма Supabase до клиник
// Казахстана доходят плохо (владелец платформы, 2026-08-18: «приглашение по
// почте не работает»), и второе доказательство обходится дорого: ссылка
// теряется в мессенджере, семь дней истекают, сотрудник не может войти.
//
// Здесь второе доказательство заменяется РУЧНОЙ передачей: администратор
// задаёт пароль и отдаёт его сотруднику лично. Что при этом остаётся:
//
//   — первое доказательство целое: роль назначает клиника, и только строго
//     ниже своей (canAssignRole), owner не выдаётся никогда, себе — нельзя;
//   — арендатор берётся из проверенного контекста, а не из тела запроса;
//   — auth_user_id приходит от Admin API, а НЕ из браузера. Именно поэтому
//     этот маршрут не воскрешает дыру, ради которой отключили POST
//     /api/crm/staff: там идентификатор аккаунта присылал клиент и мог
//     назвать чужой;
//   — чужой аккаунт не захватывается: занятая почта — отказ, пароль
//     существующему аккаунту отсюда не задаётся ни при каких условиях;
//   — пароль не сохраняется в наши таблицы, не возвращается в ответе и не
//     логируется: он уходит одним аргументом в Supabase, где остаётся хэшем.
//
// Что этот маршрут ДОБАВИЛ к правам администратора клиники, вслух: создание
// аккаунта Supabase Auth на любой ещё не занятый адрес. Раньше так умел только
// владелец платформы (kind: "platform"), а приглашение аккаунтов не создавало —
// человек заводил его сам, доказывая почту. Значит администратор может «занять»
// чужой адрес: аккаунт будет существовать с паролем, который знает он.
// Компенсации ровно три, и других нет: роль строго ниже своей, каждый заход и
// каждый отказ попадают в журнал с actor, а существующий аккаунт не трогается
// вовсе. Если однажды понадобится жёстче — ограничивать надо здесь, а не в
// экране: экран проверок не заменяет.

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonRecord;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sendJson(res: VercelResponse, status: number, body: JsonRecord) {
  res.status(status).json(body);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * След отказа.
 *
 * Инвайт-путь пишет redemption_refused с причиной, и без такой же записи
 * жалоба «не могу завести сотрудника» не расследуется: по журналу видно, что
 * запрос был, но не видно, почему он не прошёл. В записи только код причины —
 * ни почты, ни пароля.
 */
function auditRefusal(code: string, workspaceId: string, actorStaffUserId: string) {
  console.log(`[staff-credentials] refused reason=${code} workspace=${workspaceId} by=${actorStaffUserId}`);
}

/**
 * Приглашение вместо тупика.
 *
 * Зовётся, когда пароль задать нельзя (аккаунт уже существует). Прежние живые
 * приглашения этой почты отзываются: два действующих токена на один адрес —
 * это два пути в клинику, и потерянный никто бы не закрыл. Ошибки здесь не
 * прерывают ответ: главное сообщение — «пароль задать нельзя», а ссылка лишь
 * помогает; её отсутствие честно означает пустой acceptUrl.
 */
async function issueInvitationFor(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  req: VercelRequest,
  context: { workspaceId: string; staffUserId: string },
  validated: StaffCredentialsRequest,
): Promise<{ acceptUrl: string }> {
  if (!supabase) return { acceptUrl: "" };
  try {
    await supabase
      .from("staff_invitations")
      .update({ revoked_at: new Date().toISOString() })
      .eq("workspace_id", context.workspaceId)
      .ilike("email", escapeLikePattern(validated.email))
      .is("accepted_at", null)
      .is("revoked_at", null);

    const { token, tokenHash } = createInvitationToken();
    const { error } = await supabase.from("staff_invitations").insert({
      workspace_id: context.workspaceId,
      email: validated.email,
      role: validated.role,
      token_hash: tokenHash,
      expires_at: expiryFromNow(),
      invited_by_staff_user_id: context.staffUserId,
    });
    if (error) return { acceptUrl: "" };
    return { acceptUrl: acceptUrl(req, token) };
  } catch {
    return { acceptUrl: "" };
  }
}

export type StaffCredentialsRejection = { status: number; error: string; code: string; details?: string[] };

export type StaffCredentialsRequest = {
  email: string;
  role: StaffRole;
  fullName: string;
};

/**
 * Всё, что решается без базы. Отдельной функцией — ради проверок без сети.
 *
 * Роль проверяется ОТНОСИТЕЛЬНО актора: администратор не заводит второго
 * администратора, никто не заводит владельца. Те же правила, что у
 * приглашения, — путь другой, границы прежние.
 */
export function validateStaffCredentialsRequest(
  body: JsonRecord,
  actorRole: string,
): StaffCredentialsRequest | StaffCredentialsRejection {
  const email = normalizeEmail(body.email);
  const role = readString(body.role);
  const fullName = readString(body.fullName ?? body.full_name ?? body.name);

  const details: string[] = [];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) details.push("Почта сотрудника не похожа на адрес.");
  if (!isStaffRole(role)) {
    details.push("Роль обязательна и должна быть из списка.");
  } else if (!isStaffRole(actorRole) || !canAssignRole(actorRole, role)) {
    // Отдельный код: это не «форма заполнена криво», а «вам нельзя такую роль».
    return {
      status: 403,
      error: "Такую роль назначить нельзя",
      code: "permission_denied",
      details: ["Назначать можно только роли ниже своей, и владельца не назначает никто."],
    };
  }
  details.push(...validateOwnerPassword(body.password));

  if (details.length > 0) {
    return { status: 400, error: "Форма заполнена не до конца", code: "invalid_staff_credentials", details };
  }

  return { email, role: role as StaffRole, fullName: fullName || email };
}

/**
 * PATCH /api/crm/staff-credentials — новый пароль сотруднику, который уже
 * в команде.
 *
 * Забытый пароль чинился только письмом «Забыли пароль?» — тем самым каналом,
 * из-за которого весь этот модуль и появился. Здесь администратор задаёт
 * пароль сам и передаёт лично, как при заведении.
 *
 * Почему это НЕ захват аккаунта, хотя пароль пишется существующему
 * пользователю — четыре условия, и все обязательны:
 *
 *   — цель называется идентификатором СТРОКИ СОТРУДНИКА, а auth_user_id
 *     читается из этой строки, отобранной по workspace_id из проверенного
 *     контекста. Из тела запроса идентификатор аккаунта не принимается: иначе
 *     это была бы ровно та эскалация, ради которой отключён POST /api/crm/staff;
 *   — цель обязана быть членом ЭТОЙ клиники: чужая строка не найдётся фильтром;
 *   — роль цели строго ниже роли актора (canAssignRole), владельца не трогает
 *     никто, себе — отказ (свой пароль меняют через «Забыли пароль?», и это
 *     единственный путь, где новый пароль знает только сам человек);
 *   — пароль не попадает ни в таблицы, ни в ответ, ни в журнал.
 */
export async function handleStaffPasswordReset(req: VercelRequest, res: VercelResponse) {
  const context = readWorkspaceContext(req);
  if (!context) {
    return sendJson(res, 403, { success: false, error: "Access denied", code: "workspace_access_denied" });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return sendJson(res, 503, { success: false, error: "Хранилище не настроено", code: "storage_not_configured" });
  }

  const body = asRecord(req.body);
  const staffUserId = readString(body.staffUserId ?? body.id);
  if (!UUID_PATTERN.test(staffUserId)) {
    return sendJson(res, 400, { success: false, error: "Нужен сотрудник", code: "staff_user_required" });
  }

  // Себе — нельзя. Смысл не в правах: свой пароль обязан знать только его
  // владелец, и путь для этого один — «Забыли пароль?» на входе.
  if (staffUserId === context.staffUserId) {
    auditRefusal("permission_denied", context.workspaceId, context.staffUserId);
    return sendJson(res, 403, {
      success: false,
      error: "Свой пароль отсюда не меняется",
      code: "permission_denied",
      details: ["Свой пароль задают через «Забыли пароль?» на странице входа — так его знаете только вы."],
    });
  }

  const ruleProblems = validateOwnerPassword(body.password);
  if (ruleProblems.length > 0) {
    auditRefusal("invalid_staff_credentials", context.workspaceId, context.staffUserId);
    return sendJson(res, 400, {
      success: false,
      error: "Пароль не принят",
      code: "invalid_staff_credentials",
      details: ruleProblems,
    });
  }
  const password = String(body.password);

  // Строка сотрудника — из СВОЕЙ клиники. Здесь же берётся auth_user_id: он
  // не приходит и не может прийти из запроса.
  const { data: targetRow, error: targetError } = await supabase
    .from("staff_users")
    .select("id, role, status, auth_user_id, full_name")
    .eq("id", staffUserId)
    .eq("workspace_id", context.workspaceId)
    .maybeSingle();
  if (targetError) {
    return sendJson(res, 503, { success: false, error: "Хранилище не ответило", code: "unavailable" });
  }
  const target = asRecord(targetRow);
  const targetRole = readString(target.role);
  const targetAuthUserId = readString(target.auth_user_id);
  if (!readString(target.id)) {
    // Чужая клиника и несуществующий сотрудник отвечают одинаково: перебором
    // идентификаторов не выясняется, кто есть в соседней клинике.
    auditRefusal("staff_not_found", context.workspaceId, context.staffUserId);
    return sendJson(res, 404, { success: false, error: "Сотрудник не найден", code: "staff_not_found" });
  }

  // Роль цели строго ниже своей. Владелец недоступен никому: его пароль —
  // последний ключ от клиники, и отдавать его администратору нельзя.
  if (!isStaffRole(context.role) || !isStaffRole(targetRole) || !canAssignRole(context.role, targetRole)) {
    auditRefusal("permission_denied", context.workspaceId, context.staffUserId);
    return sendJson(res, 403, {
      success: false,
      error: "Этому сотруднику пароль задать нельзя",
      code: "permission_denied",
      details: ["Менять пароль можно только тем, чья роль ниже вашей. Владельцу — никто."],
    });
  }

  if (!targetAuthUserId) {
    // Вход не привязан: менять нечего. Такому человеку аккаунт заводят
    // соседней вкладкой «Логин и пароль» — она достроит эту же строку.
    auditRefusal("staff_not_linked", context.workspaceId, context.staffUserId);
    return sendJson(res, 409, {
      success: false,
      error: "У сотрудника ещё нет входа",
      code: "staff_not_linked",
      details: ["Заведите ему вход на вкладке «Логин и пароль» — существующая строка достроится, второй профиль не появится."],
    });
  }

  // Сотрудник на паузе войти не сможет: членства отбираются по status
  // "active". Смена пароля ответила бы 200, экран показал бы логин и пароль,
  // а человек упёрся бы во «вход не связан с клиникой» — и заодно потерял бы
  // прежний пароль, который заработал бы после «Активировать».
  const targetStatus = readString(target.status).toLowerCase();
  if (targetStatus && targetStatus !== "active") {
    auditRefusal("staff_paused", context.workspaceId, context.staffUserId);
    return sendJson(res, 409, {
      success: false,
      error: "Сотрудник на паузе",
      code: "staff_paused",
      details: ["Сначала нажмите «Активировать» — иначе новый пароль не пустит его в кабинет."],
    });
  }

  // САМАЯ ВАЖНАЯ ГРАНИЦА ЭТОГО ПУТИ.
  //
  // Проверки выше закрывают СТРОКУ сотрудника, а пароль пишется в АККАУНТ,
  // общий на всю платформу: один аккаунт держит несколько членств (человек
  // работает в двух клиниках — обычное дело, и WorkspacePicker это прямо
  // предлагает). Без этой проверки клиника B, законно зачислившая владельца
  // клиники A рядовым мастером, задавала бы ему пароль и получала бы вход в
  // клинику A со всеми её пациентами: роль «владелец недоступен никому»
  // защищала бы только внутри своей клиники, а снаружи ключ отдавался целиком.
  //
  // Поэтому: аккаунт, работающий где-то ещё, отсюда не трогается вовсе.
  const { data: otherMemberships, error: otherError } = await supabase
    .from("staff_users")
    .select("id")
    .eq("auth_user_id", targetAuthUserId)
    .neq("workspace_id", context.workspaceId)
    .limit(1);
  if (otherError) {
    return sendJson(res, 503, { success: false, error: "Хранилище не ответило", code: "unavailable" });
  }
  if (Array.isArray(otherMemberships) && otherMemberships.length > 0) {
    auditRefusal("account_shared_with_other_clinic", context.workspaceId, context.staffUserId);
    return sendJson(res, 409, {
      success: false,
      error: "Этот аккаунт работает не только у вас",
      code: "account_shared_with_other_clinic",
      details: [
        "Тем же логином человек заходит и в другую клинику, поэтому его пароль отсюда не меняется: он открыл бы и её.",
        "Пусть он задаст пароль сам — «Забыли пароль?» на странице входа.",
      ],
    });
  }

  // Владелец платформы не получает новый пароль от клиники ни при каких
  // условиях: его аккаунт открывает панель, читающую поперёк всех арендаторов.
  if (platformOwnerIds().includes(targetAuthUserId)) {
    auditRefusal("account_shared_with_other_clinic", context.workspaceId, context.staffUserId);
    return sendJson(res, 409, {
      success: false,
      error: "Этому аккаунту пароль отсюда не меняется",
      code: "account_shared_with_other_clinic",
      details: ["Пусть владелец аккаунта задаст пароль сам — «Забыли пароль?» на странице входа."],
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) {
    return sendJson(res, 503, { success: false, error: "Хранилище не настроено", code: "storage_not_configured" });
  }

  type AdminUpdateResponse = { ok: boolean; status: number; json(): Promise<unknown> };
  let updated: AdminUpdateResponse;
  try {
    updated = (await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(targetAuthUserId)}`, {
      method: "PUT",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password }),
    })) as unknown as AdminUpdateResponse;
  } catch {
    return sendJson(res, 502, { success: false, error: "Не удалось задать пароль", code: "unavailable" });
  }

  if (!updated.ok) {
    if (updated.status === 422) {
      return sendJson(res, 400, {
        success: false,
        error: "Supabase отклонил такой пароль",
        code: "password_rejected",
        details: ["Задайте другой пароль — длиннее или с другими символами."],
      });
    }
    if (updated.status === 404) {
      // Строка сотрудника ссылается на удалённый аккаунт: чинится не здесь.
      auditRefusal("auth_account_missing", context.workspaceId, context.staffUserId);
      return sendJson(res, 409, {
        success: false,
        error: "Аккаунт входа не найден",
        code: "auth_account_missing",
        details: ["Аккаунт удалён из системы входа. Заведите сотруднику вход заново на вкладке «Логин и пароль»."],
      });
    }
    return sendJson(res, 502, { success: false, error: "Не удалось задать пароль", code: "unavailable" });
  }

  // Пароль задал не сотрудник — тот же честный флаг, что при заведении.
  await supabase
    .from("staff_users")
    .update({ password_reset_required: true, updated_at: new Date().toISOString() })
    .eq("id", staffUserId)
    .eq("workspace_id", context.workspaceId);

  // Кто кому менял пароль — в журнал; самого пароля в записи нет. Событие
  // называется «reset» без слова password намеренно: пины запрещают это слово
  // в логах целиком, потому что отличить имя события от значения нельзя, а
  // строгий запрет дешевле разбирательства, чей именно секрет утёк.
  console.log(
    `[staff-credentials] reset workspace=${context.workspaceId} staff=${staffUserId} by=${context.staffUserId}`,
  );

  return sendJson(res, 200, {
    success: true,
    mode: "supabase",
    data: { staffUserId, fullName: readString(target.full_name) },
  });
}

/** POST /api/crm/staff-credentials — за requireWorkspaceAccess + manage_staff. */
export async function handleStaffCredentials(req: VercelRequest, res: VercelResponse) {
  const context = readWorkspaceContext(req);
  if (!context) {
    return sendJson(res, 403, { success: false, error: "Access denied", code: "workspace_access_denied" });
  }
  const method = (req.method || "GET").toUpperCase();
  // Смена пароля живёт на том же ресурсе: та же тема, то же право, тот же
  // модуль — разные глаголы.
  if (method === "PATCH") {
    return handleStaffPasswordReset(req, res);
  }
  if (method !== "POST") {
    return sendJson(res, 405, { success: false, error: "Method not allowed", code: "method_not_allowed" });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return sendJson(res, 503, { success: false, error: "Хранилище не настроено", code: "storage_not_configured" });
  }

  const body = asRecord(req.body);
  // Себе — нельзя, и это сказано словами. Раньше заведение себя отбивалось
  // косвенно (already_member и «почта занята»), а косвенная гарантия исчезает
  // молча при первом же послаблении дедупа. У PATCH staff такая проверка
  // написана явно (staffPatchRejection) — здесь тоже.
  if (context.email && normalizeEmail(context.email) === normalizeEmail(body.email)) {
    return sendJson(res, 403, {
      success: false,
      error: "Себе завести доступ нельзя",
      code: "permission_denied",
      details: ["Это ваша собственная почта: роль себе не выдают, пароль себе меняют через «Забыли пароль?»."],
    });
  }
  const validated = validateStaffCredentialsRequest(body, context.role);
  if ("status" in validated) {
    auditRefusal(validated.code, context.workspaceId, context.staffUserId);
    return sendJson(res, validated.status, {
      success: false,
      error: validated.error,
      code: validated.code,
      ...(validated.details ? { details: validated.details } : {}),
    });
  }
  const password = String(body.password);

  // Уже в команде — второй строки быть не должно. Почта здесь значение, а не
  // LIKE-шаблон: «_» иначе совпал бы с адресом коллеги на один символ.
  const { data: existing, error: existingError } = await supabase
    .from("staff_users")
    .select("id, auth_user_id")
    .eq("workspace_id", context.workspaceId)
    .ilike("email", escapeLikePattern(validated.email))
    .maybeSingle();
  if (existingError) {
    return sendJson(res, 503, { success: false, error: "Хранилище не ответило", code: "unavailable" });
  }
  // Строка БЕЗ auth_user_id — это именно тот человек, который войти не может:
  // так выглядят сотрудники из seed и заведённые руками до приглашений. Отказ
  // «уже в команде» отправлял бы менять роль там, где роль ни при чём, а
  // другого пути привязать вход в продукте нет. Такой строке аккаунт
  // создаётся, и она достраивается ниже вместо вставки второй.
  const existingRow = asRecord(existing);
  const existingStaffId = readString(existingRow.id);
  const existingLinked = Boolean(readString(existingRow.auth_user_id));
  if (existingStaffId && existingLinked) {
    auditRefusal("already_member", context.workspaceId, context.staffUserId);
    return sendJson(res, 409, {
      success: false,
      error: "Этот человек уже в команде",
      code: "already_member",
      details: ["Роль меняется в таблице сотрудников, заводить второй профиль не нужно."],
    });
  }

  // Аккаунт — первым: самый частый отказ (почта занята) не оставляет за собой
  // ни строки сотрудника, ни отозванных приглашений.
  const supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) {
    return sendJson(res, 503, { success: false, error: "Хранилище не настроено", code: "storage_not_configured" });
  }

  // Прямой вызов Admin API: supabase-js 2.105 не возит auth.admin ни в типах,
  // ни в рантайме (сборка Vercel поймала это на платформенном пути).
  type AdminCreateResponse = { ok: boolean; status: number; json(): Promise<unknown> };
  let created: AdminCreateResponse;
  try {
    created = (await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: validated.email,
        password,
        // Письмо не отправляется вовсе — в этом смысл пути.
        email_confirm: true,
        user_metadata: { full_name: validated.fullName },
      }),
    })) as unknown as AdminCreateResponse;
  } catch {
    return sendJson(res, 502, { success: false, error: "Не удалось создать аккаунт сотрудника", code: "unavailable" });
  }

  if (!created.ok) {
    const errorBody = asRecord(await created.json().catch(() => null));
    const errorCode = readString(errorBody.error_code).toLowerCase();
    const message = readString(errorBody.msg) || readString(errorBody.message) || readString(errorBody.error_description);
    const emailTaken = errorCode === "email_exists" || /already (been )?registered/i.test(message);
    if (emailTaken) {
      auditRefusal("email_already_registered", context.workspaceId, context.staffUserId);
      // Отказ здесь — не тупик, а развилка, и вторая её ветка выписывается
      // сразу. Аккаунт может существовать по двум причинам: человек
      // регистрировался раньше, либо наш же предыдущий заход оборвался после
      // создания аккаунта. В обоих случаях путь один — приглашение: человек
      // входит своим паролем и САМ соглашается стать сотрудником. Ссылка
      // возвращается администратору готовой, потому что письма не доходят.
      const invitation = await issueInvitationFor(supabase, req, context, validated);
      return sendJson(res, 409, {
        success: false,
        error: "У этой почты уже есть аккаунт",
        code: "email_already_registered",
        details: [
          "Пароль существующему аккаунту отсюда не задаётся — это был бы захват чужого входа.",
          invitation.acceptUrl
            ? "Мы выписали приглашение: передайте ссылку ниже. Человек войдёт своим паролем (если аккаунт создали вы — тем, что вы задали) и станет сотрудником."
            : "Пригласите этого человека ссылкой на вкладке «Ссылка-приглашение».",
        ],
        ...(invitation.acceptUrl ? { data: { acceptUrl: invitation.acceptUrl, email: validated.email, role: validated.role } } : {}),
      });
    }
    if (created.status === 422) {
      return sendJson(res, 400, {
        success: false,
        error: "Supabase отклонил такой пароль",
        code: "password_rejected",
        details: ["Задайте другой пароль — длиннее или с другими символами."],
      });
    }
    return sendJson(res, 502, { success: false, error: "Не удалось создать аккаунт сотрудника", code: "unavailable" });
  }

  const authUserId = readString(asRecord(await created.json().catch(() => null)).id);
  if (!authUserId) {
    // Свой код, а не общий "unavailable": по нему экран отличает «аккаунт
    // создан» от «не создан», и в пачке это решает судьбу пароля — он
    // единственный способ этому человеку войти и принять приглашение.
    return sendJson(res, 502, {
      success: false,
      error: "Аккаунт создан, но ответ Supabase не прочитан",
      code: "staff_credentials_unreadable",
      details: ["Повторная попытка ответит «почта занята» — тогда пригласите сотрудника ссылкой."],
    });
  }

  // Висящие приглашения на эту почту гасятся: человек уже внутри, и живая
  // ссылка вела бы во вторую попытку зачисления. Отказ этого шага не молчит —
  // непогашенное приглашение это второй путь в ту же клинику, и знать о нём
  // администратор обязан.
  const { error: revokeError } = await supabase
    .from("staff_invitations")
    .update({ revoked_at: new Date().toISOString() })
    .eq("workspace_id", context.workspaceId)
    .ilike("email", escapeLikePattern(validated.email))
    .is("accepted_at", null)
    .is("revoked_at", null);
  if (revokeError) {
    return sendJson(res, 502, {
      success: false,
      error: "Аккаунт создан, но прежние приглашения не отозвались",
      code: "partial_staff_credentials",
      details: [
        `Аккаунт ${validated.email} существует, доступа к клинике у него пока нет.`,
        "Отзовите приглашение этой почты в списке ниже и повторите — иначе останутся два пути входа.",
      ],
    });
  }

  // Непривязанная строка достраивается, а не дублируется: на неё уже могут
  // ссылаться задачи и журнал, и второй профиль того же человека развалил бы
  // историю. Условие auth_user_id is null защищает от гонки — если параллельный
  // запрос успел привязать строку, обновление не тронет ничего.
  if (existingStaffId) {
    const { data: linkedRow, error: linkError } = await supabase
      .from("staff_users")
      .update({
        auth_user_id: authUserId,
        full_name: validated.fullName,
        role: validated.role,
        status: "active",
        password_reset_required: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingStaffId)
      .eq("workspace_id", context.workspaceId)
      .is("auth_user_id", null)
      .select("id, email, role, status")
      .maybeSingle();

    if (linkError || !linkedRow) {
      auditRefusal("partial_staff_credentials", context.workspaceId, context.staffUserId);
      return sendJson(res, 502, {
        success: false,
        error: "Аккаунт создан, но вход сотруднику не привязан",
        code: "partial_staff_credentials",
        details: [
          `Аккаунт ${validated.email} существует, а строка сотрудника осталась без входа.`,
          "Повторная отправка ответит «почта занята». Обратитесь в поддержку платформы: строку нужно привязать вручную.",
        ],
      });
    }

    console.log(
      `[staff-credentials] linked workspace=${context.workspaceId} staff=${existingStaffId} role=${validated.role} by=${context.staffUserId}`,
    );
    return sendJson(res, 200, {
      success: true,
      mode: "supabase",
      data: { staff: asRecord(linkedRow), email: validated.email, role: validated.role, linkedExisting: true },
    });
  }

  const { data: staffRow, error: staffError } = await supabase
    .from("staff_users")
    .insert({
      workspace_id: context.workspaceId,
      email: validated.email,
      full_name: validated.fullName,
      role: validated.role,
      status: "active",
      auth_user_id: authUserId,
      invited_at: new Date().toISOString(),
      // Пароль задал не сотрудник — флаг это фиксирует. Честная оговорка:
      // сегодня он ДЕКОРАТИВЕН. Его никто не читает (принуждения к смене в
      // продукте нет) и никто не снимает: пароль меняется целиком на стороне
      // Supabase, и сервер об этом не узнаёт. Прежде чем включать по нему
      // принуждение, нужен путь снятия — иначе ровно эти сотрудники попадут в
      // петлю «смени пароль» без выхода.
      password_reset_required: true,
    })
    .select("id, email, role, status")
    .single();

  if (staffError || !staffRow) {
    auditRefusal("partial_staff_credentials", context.workspaceId, context.staffUserId);
    return sendJson(res, 502, {
      success: false,
      error: "Аккаунт создан, но сотрудник не добавлен",
      code: "partial_staff_credentials",
      details: [
        `Аккаунт ${validated.email} уже существует, но доступа к клинике у него нет.`,
        "Повторная отправка ответит «почта занята» — пригласите этого человека ссылкой, он войдёт с заданным паролем.",
      ],
    });
  }

  // В журнал — кто кого и с какой ролью. Идентификатор заведённого нужен,
  // чтобы по следу можно было сказать КОГО завели; почты и пароля в записи
  // нет и быть не может (то же правило, что у auditInvitation).
  console.log(
    `[staff-credentials] created workspace=${context.workspaceId} staff=${readString(asRecord(staffRow).id)} role=${validated.role} by=${context.staffUserId}`,
  );

  // Пароль в ответе не возвращается: администратор задал его сам и знает.
  return sendJson(res, 201, {
    success: true,
    mode: "supabase",
    data: {
      staff: asRecord(staffRow),
      email: validated.email,
      role: validated.role,
    },
  });
}

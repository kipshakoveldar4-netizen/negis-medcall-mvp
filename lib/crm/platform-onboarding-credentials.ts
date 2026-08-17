import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseServerClient } from "../supabase/server";
import { VERTICAL_SETTINGS_KEY } from "../vertical/terms";
import { validateOnboardingRequest } from "./platform-onboarding";
import { escapeLikePattern } from "./staff-invitations";

// Подключение клиники с логином и паролем — упрощённый путь без письма.
//
// Живая передача салона показала, чего стоит цепочка «ссылка → мессенджер →
// /join → задай пароль»: WhatsApp портил фрагмент, ссылка терялась, владелец
// без пароля упирался в «Invalid login credentials». Владелец платформы
// попросил путь короче: он сам задаёт владельцу клиники логин (почту) и
// пароль и передаёт их из рук в руки.
//
// Этот модуль — ЕДИНСТВЕННОЕ место, где пароль проходит через платформенный
// код, и у прохода три правила:
//
//   — пароль нигде не сохраняется и никуда не возвращается: он уходит одним
//     аргументом в auth.admin.createUser (Supabase хранит только хэш) и не
//     попадает ни в таблицы, ни в ответы, ни в логи;
//   — email_confirm: true — подтверждающее письмо не отправляется вовсе,
//     вход работает сразу; это и есть «без письма»;
//   — аккаунт создаётся ПЕРВЫМ: самый частый отказ — занятая почта — не
//     оставляет после себя ни пространства, ни настроек. Занятая почта — не
//     тупик: такую клинику подключает соседний инвайт-путь, владелец входит
//     со своим паролем и принимает ссылку.
//
// Инвайт-путь (platform-onboarding.ts) остаётся как был и по-прежнему не
// видит паролей.

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

/**
 * Правила пароля решаются без базы, поэтому отдельной функцией — как
 * validateOnboardingRequest. 8 символов — наш минимум; 72 БАЙТА — предел
 * bcrypt, которым Supabase хэширует: более длинный молча обрезался бы, и
 * байт, а не символов — кириллическая буква занимает два.
 */
export function validateOwnerPassword(value: unknown): string[] {
  const password = typeof value === "string" ? value : "";
  const details: string[] = [];
  if (password.length < 8) details.push("Пароль — не короче 8 символов.");
  if (Buffer.byteLength(password, "utf8") > 72) details.push("Пароль слишком длинный: до 72 байт, кириллическая буква считается за две.");
  if (password.trim().length === 0 && password.length > 0) details.push("Пароль из одних пробелов не защищает.");
  // Хвостовой пробел от вставки из чата невидим на экране результата, а при
  // передаче голосом или с бумажки теряется гарантированно — владелец упрётся
  // в «Invalid login credentials», неотличимо от «пароль неверный».
  else if (password !== password.trim()) details.push("Пароль начинается или кончается пробелом — уберите его: при передаче он потеряется.");
  return details;
}

/** /login на том же хосте, что принял запрос, — как acceptUrl у инвайт-пути. */
function loginUrl(req: VercelRequest): string {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  if (!host) return "/login";
  return `${proto}://${host}/login`;
}

/** POST /api/crm/platform-onboarding-credentials — за requirePlatformOwner. */
export async function handlePlatformOnboardingCredentials(req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return sendJson(res, 503, { success: false, error: "Хранилище не настроено", code: "storage_not_configured" });
  }

  const body = asRecord(req.body);
  const validated = validateOnboardingRequest(body);
  const passwordDetails = validateOwnerPassword(body.password);
  if ("status" in validated || passwordDetails.length > 0) {
    const details = [...("status" in validated ? validated.details || [] : []), ...passwordDetails];
    return sendJson(res, 400, {
      success: false,
      error: "Форма заполнена не до конца",
      code: "invalid_onboarding",
      ...(details.length > 0 ? { details } : {}),
    });
  }
  const password = String(body.password);

  // То же правило, что у инвайт-пути: один клиент — одно подключение за раз.
  // Живое приглашение владельца на эту почту значит, что пространство уже
  // создано и ждёт — второе рядом почти наверняка двойная попытка.
  const { data: pendingRows, error: pendingError } = await supabase
    .from("staff_invitations")
    .select("workspace_id")
    .eq("role", "owner")
    .ilike("email", escapeLikePattern(validated.ownerEmail))
    .is("accepted_at", null)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString());
  if (pendingError) {
    return sendJson(res, 502, { success: false, error: "Не удалось проверить существующие приглашения", code: "unavailable" });
  }
  if (Array.isArray(pendingRows) && pendingRows.length > 0) {
    const existingWorkspaceId = readString(asRecord(pendingRows[0]).workspace_id);
    // Имя клиники — до кнопки перевыпуска: отзыв старой ссылки необратим, и
    // жать его вслепую, не зная, к какой клинике относится, нельзя.
    const { data: existingWorkspace } = await supabase
      .from("workspaces")
      .select("name")
      .eq("id", existingWorkspaceId)
      .maybeSingle();
    const existingName = readString(asRecord(existingWorkspace).name);
    return sendJson(res, 409, {
      success: false,
      error: "Эта почта уже подключается",
      code: "invitation_already_pending",
      details: [
        `Владельцу уже выписано живое приглашение${existingName ? ` в «${existingName}»` : ""}. Перевыпустите его кнопкой ниже — второе пространство для той же почты не создаётся.`,
      ],
      data: { existingWorkspaceId },
    });
  }

  // У почты уже есть клиника? Проверка стоит ДО createUser: без неё повтор
  // подключения после истёкшего приглашения, чьё письмо не ушло (Auth-аккаунта
  // нет), молча создавал вторую клинику — createUser проходил, и insert ниже
  // не спрашивал ничего. Парольному пути подтверждение «второй точки» не
  // положено: у владельца второй точки уже есть аккаунт, и такой заход честно
  // упрётся в email_exists с советом про инвайт-режим.
  {
    const { data: ownedRows, error: ownedError } = await supabase
      .from("workspaces")
      .select("id, name")
      .ilike("owner_email", escapeLikePattern(validated.ownerEmail));
    if (ownedError) {
      return sendJson(res, 502, { success: false, error: "Не удалось проверить существующие клиники", code: "unavailable" });
    }
    if (Array.isArray(ownedRows) && ownedRows.length > 0) {
      const ownedNames = ownedRows.map((row) => readString(asRecord(row).name)).filter(Boolean);
      return sendJson(res, 409, {
        success: false,
        error: "У этой почты уже есть клиника",
        code: "owner_already_has_workspace",
        details: [
          `За почтой уже числится: ${ownedNames.map((name) => `«${name}»`).join(", ")}.`,
          "Если владелец не может войти — перевыпустите приглашение кнопкой ниже: при выписке Supabase создаёт аккаунт и шлёт письмо, а ссылку можно передать и вручную.",
          "Если владельцу нужна вторая точка — подключите её через «Ссылку-приглашение».",
        ],
        data: { existingWorkspaceId: readString(asRecord(ownedRows[0]).id) },
      });
    }
  }

  // Аккаунт — первым: отказ «почта занята» не должен оставлять мусора.
  //
  // Прямым вызовом Admin API, а не через клиент: supabase-js 2.105 больше не
  // возит GoTrue-админку (auth.admin исчез и из типов, и из рантайма — сборка
  // Vercel это поймала, локальный инкрементальный tsc проглядел). Паттерн тот
  // же, что у sendSupabaseInviteEmail; ответ провайдера наружу не уходит —
  // из него читаются только id и код ошибки.
  type AdminCreateResponse = { ok: boolean; status: number; json(): Promise<unknown> };
  const supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) {
    return sendJson(res, 503, { success: false, error: "Хранилище не настроено", code: "storage_not_configured" });
  }
  let createdResponse: AdminCreateResponse;
  try {
    createdResponse = (await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: validated.ownerEmail,
        password,
        email_confirm: true,
        user_metadata: { full_name: validated.ownerName },
      }),
    })) as unknown as AdminCreateResponse;
  } catch {
    return sendJson(res, 502, { success: false, error: "Не удалось создать аккаунт владельца", code: "unavailable" });
  }
  if (!createdResponse.ok) {
    const errorBody = asRecord(await createdResponse.json().catch(() => null));
    const errorCode = readString(errorBody.error_code).toLowerCase();
    const errorMessage = readString(errorBody.msg) || readString(errorBody.message) || readString(errorBody.error_description);
    const emailTaken = errorCode === "email_exists" || /already (been )?registered/i.test(errorMessage);
    if (!emailTaken && createdResponse.status === 422) {
      // Наша проверка длиннее правил Supabase по умолчанию, но проект может
      // нести свою политику пароля — отказ называется своими словами, тело
      // провайдера наружу не пересказывается.
      return sendJson(res, 400, {
        success: false,
        error: "Supabase отклонил такой пароль",
        code: "password_rejected",
        details: ["Задайте другой пароль — длиннее или с другими символами."],
      });
    }
    if (emailTaken) {
      // Занятая почта бывает и следом НАШЕГО прерванного прохода: аккаунт
      // создан, пространство есть, а владелец к нему не привязан. Совет
      // «подключите через приглашение» в этом случае создал бы второе
      // пространство — вместо него отдаётся id недособранного, и форма
      // предлагает перевыпуск приглашения именно в него.
      const { data: candidateRows } = await supabase
        .from("workspaces")
        .select("id, name")
        .ilike("owner_email", escapeLikePattern(validated.ownerEmail));
      const assembledNames: string[] = [];
      for (const row of Array.isArray(candidateRows) ? candidateRows : []) {
        const candidateId = readString(asRecord(row).id);
        if (!candidateId) continue;
        const { data: ownerRow } = await supabase
          .from("staff_users")
          .select("id")
          .eq("workspace_id", candidateId)
          .eq("role", "owner")
          .maybeSingle();
        if (!ownerRow) {
          return sendJson(res, 409, {
            success: false,
            error: "У этой почты уже есть аккаунт и недособранное пространство",
            code: "email_already_registered",
            details: [
              "Похоже на прерванное подключение: пространство создано, а владелец к нему не привязан.",
              "Не создавайте второе. Выпишите приглашение кнопкой ниже — владелец войдёт со своим паролем и примет его.",
            ],
            data: { existingWorkspaceId: candidateId },
          });
        }
        assembledNames.push(readString(asRecord(row).name) || candidateId);
      }
      if (assembledNames.length > 0) {
        // Типовой случай — прошлое подключение состоялось, а оператор об этом
        // не знает (ответ потерялся). Отправить его «через приглашение» значило
        // бы молча создать вторую клинику.
        return sendJson(res, 409, {
          success: false,
          error: "Эта почта уже владеет клиникой",
          code: "email_already_registered",
          details: [
            `За почтой уже числится: ${assembledNames.map((name) => `«${name}»`).join(", ")}. Возможно, подключение уже состоялось — проверьте карточку клиники.`,
            "Если владельцу нужна вторая точка — подключите её через «Ссылку-приглашение»: форма попросит подтвердить создание второй клиники.",
          ],
        });
      }
      return sendJson(res, 409, {
        success: false,
        error: "У этой почты уже есть аккаунт",
        code: "email_already_registered",
        details: [
          "Пароль для существующего аккаунта отсюда не задаётся — это был бы захват чужого входа.",
          "Подключите эту почту через «Ссылку-приглашение»: владелец войдёт со своим паролем и примет её. Пароль он может восстановить через «Забыли пароль?» на странице входа.",
        ],
      });
    }
    return sendJson(res, 502, { success: false, error: "Не удалось создать аккаунт владельца", code: "unavailable" });
  }
  const createdUser = asRecord(await createdResponse.json().catch(() => null));
  const authUserId = readString(createdUser.id);
  if (!authUserId) {
    // 2xx без читаемого id: аккаунт создан, а привязать его не к чему.
    // Повтор формы честно откажет «почта занята» — оттуда путь через
    // приглашение, тупика нет.
    return sendJson(res, 502, {
      success: false,
      error: "Аккаунт создан, но ответ Supabase не прочитан",
      code: "unavailable",
    });
  }

  const { data: workspaceRow, error: workspaceError } = await supabase
    .from("workspaces")
    .insert({ name: validated.name, owner_email: validated.ownerEmail })
    .select("id")
    .single();
  if (workspaceError || !workspaceRow) {
    // Дальше каждый отказ называет, что УЖЕ создано: полусозданное состояние
    // владелец платформы должен видеть, а не угадывать.
    return sendJson(res, 502, {
      success: false,
      error: "Аккаунт владельца создан, а пространство — нет",
      code: "partial_credentials_onboarding",
      details: [
        `Аккаунт ${validated.ownerEmail} уже существует, вход по заданному паролю работает, но клиники за ним нет.`,
        "Повторная отправка этой формы откажет («почта занята») — подключите эту почту через «Ссылку-приглашение»: владелец войдёт с паролем и примет её.",
      ],
    });
  }
  const workspaceId = readString(asRecord(workspaceRow).id);

  const { error: settingsError } = await supabase.from("workspace_settings").insert([
    { workspace_id: workspaceId, key: VERTICAL_SETTINGS_KEY, value: { vertical: validated.vertical } },
    { workspace_id: workspaceId, key: "clinic_schedule", value: { timeZone: validated.timeZone } },
  ]);
  if (settingsError) {
    return sendJson(res, 502, {
      success: false,
      error: "Пространство создано, но настройки не записались",
      code: "partial_credentials_onboarding",
      details: [
        `Пространство ${workspaceId} и аккаунт владельца уже существуют — не создавайте второе.`,
        "Не записаны ниша и часовой пояс; membership владельца тоже не создан.",
        "Вход владельцу вернёт перевыпуск приглашения кнопкой ниже; ниша и часовой пояс останутся незаполненными.",
      ],
      data: { existingWorkspaceId: workspaceId },
    });
  }

  // Строка сотрудника — та же, что создаёт принятие приглашения на /join:
  // с auth_user_id сразу, вход привязан с первой секунды.
  // password_reset_required: true — пароль задал не владелец, а платформа;
  // сегодня CRM флаг не принуждает, но семантика честная, и включённое позже
  // принуждение поведёт ровно этих владельцев менять переданный пароль.
  const { error: staffError } = await supabase.from("staff_users").insert({
    workspace_id: workspaceId,
    email: validated.ownerEmail,
    full_name: validated.ownerName,
    role: "owner",
    status: "active",
    auth_user_id: authUserId,
    invited_at: new Date().toISOString(),
    password_reset_required: true,
  });
  if (staffError) {
    return sendJson(res, 502, {
      success: false,
      error: "Пространство создано, но владелец к нему не привязан",
      code: "partial_credentials_onboarding",
      details: [
        `Пространство ${workspaceId} с нишей и поясом уже существует — не создавайте второе.`,
        "Вход владельца сказал бы «аккаунт не связан с клиникой». Перевыпустите приглашение кнопкой ниже — владелец войдёт со своим паролем и примет его.",
      ],
      data: { existingWorkspaceId: workspaceId },
    });
  }

  // Пароля в ответе нет намеренно: владелец платформы задал его сам и он
  // существует теперь только в двух головах и в хэше Supabase.
  return sendJson(res, 201, {
    success: true,
    data: {
      workspaceId,
      name: validated.name,
      vertical: validated.vertical,
      ownerEmail: validated.ownerEmail,
      timeZone: validated.timeZone,
      loginUrl: loginUrl(req),
    },
  });
}

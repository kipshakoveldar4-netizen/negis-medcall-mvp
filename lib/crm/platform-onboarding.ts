import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseServerClient } from "../supabase/server";
import { VERTICAL_SETTINGS_KEY, isVertical, type Vertical } from "../vertical/terms";
import { acceptUrl, createInvitationToken, expiryFromNow, normalizeEmail, sendSupabaseInviteEmail } from "./staff-invitations";

// Подключение клиники с портала Medina Control.
//
// Портальная форма заменяет цепочку «Invite user в Supabase → provision-скрипт
// с ноутбука → тариф», но НЕ меняет её principles:
//
//   — ни одной выдуманной строки: пространство, две настройки и приглашение
//     владельца — ровно то, что создавал provision-workspace, и ничего сверх;
//   — пароль не проходит ни через этот код, ни через портал: владелец получает
//     ссылку-приглашение и задаёт пароль сам на странице /join. Письмо шлёт
//     Supabase и только как best effort — ссылка возвращается порталу, и её
//     можно передать любым каналом;
//   — ниша обязательна и умолчания у неё нет: она меняет правила проверки
//     рекламы, и выбрать её молча значило бы выбрать за клиента.
//
// Первый владелец нового пространства — единственный случай, когда роль owner
// назначается приглашением: правило «owner нельзя выдать через общий маршрут»
// охраняет существующие клиники от своих же админов, а здесь пространства ещё
// нет и выдаёт роль сама платформа.

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

export type OnboardingRejection = { status: number; error: string; code: string; details?: string[] };

export type OnboardingRequest = {
  name: string;
  vertical: Vertical;
  ownerEmail: string;
  ownerName: string;
  timeZone: string;
};

/** Всё, что решается без базы. Отдельной функцией — ради проверок без сети. */
export function validateOnboardingRequest(body: JsonRecord): OnboardingRequest | OnboardingRejection {
  const name = readString(body.name);
  const vertical = readString(body.vertical).toLowerCase();
  const ownerEmail = normalizeEmail(body.ownerEmail);
  const ownerName = readString(body.ownerName);
  const timeZone = readString(body.timeZone);

  const details: string[] = [];
  if (name.length < 2 || name.length > 120) details.push("Название — от 2 до 120 символов.");
  if (!isVertical(vertical)) details.push("Ниша обязательна: beauty (салон) или clinic (клиника). Умолчания нет намеренно.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) details.push("Почта владельца не похожа на адрес.");
  if (!timeZone) details.push("Часовой пояс обязателен: без него «сегодня» считается неверно часть суток.");
  else {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone });
    } catch {
      details.push(`Часовой пояс «${timeZone}» не распознан. Пример: Asia/Almaty.`);
    }
  }

  if (details.length > 0) {
    return { status: 400, error: "Форма заполнена не до конца", code: "invalid_onboarding", details };
  }

  return { name, vertical: vertical as Vertical, ownerEmail, ownerName: ownerName || ownerEmail, timeZone };
}

/**
 * POST /api/crm/platform-invitation-reissue — новое приглашение владельца
 * СУЩЕСТВУЮЩЕГО пространства. Ссылка теряется, мессенджер портит фрагмент,
 * семь дней истекают — без перевыпуска живое приглашение было тупиком:
 * с портала его было не заменить, а повторная форма создавала вторую клинику.
 *
 * Прежние непогашенные приглашения владельца отзываются в тот же ход: два
 * живых токена на одну почту — это два пути в одно пространство, и след
 * от потерянного никто бы не отозвал.
 */
export async function handlePlatformInvitationReissue(req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return sendJson(res, 503, { success: false, error: "Хранилище не настроено", code: "storage_not_configured" });
  }

  const body = asRecord(req.body);
  const workspaceId = readString(body.workspaceId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId)) {
    return sendJson(res, 400, { success: false, error: "Нужна клиника", code: "workspace_required" });
  }

  const { data: workspaceRow, error: workspaceError } = await supabase
    .from("workspaces")
    .select("id, name, owner_email")
    .eq("id", workspaceId)
    .maybeSingle();
  if (workspaceError) {
    return sendJson(res, 502, { success: false, error: "Не удалось прочитать клинику", code: "unavailable" });
  }
  if (!workspaceRow) {
    return sendJson(res, 404, { success: false, error: "Клиники нет", code: "not_found" });
  }
  const workspace = asRecord(workspaceRow);
  const ownerEmail = normalizeEmail(workspace.owner_email);
  if (!ownerEmail) {
    return sendJson(res, 409, {
      success: false,
      error: "У пространства не записана почта владельца",
      code: "owner_email_missing",
    });
  }

  // Владелец уже внутри? Тогда приглашение не нужно и только запутает.
  const { data: existingMember } = await supabase
    .from("staff_users")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("role", "owner")
    .maybeSingle();
  if (existingMember) {
    return sendJson(res, 409, {
      success: false,
      error: "Владелец уже принял приглашение",
      code: "owner_already_member",
      details: ["Пространство живое: приглашать владельца второй раз не нужно."],
    });
  }

  const now = new Date().toISOString();
  const { error: revokeError } = await supabase
    .from("staff_invitations")
    .update({ revoked_at: now })
    .eq("workspace_id", workspaceId)
    .eq("role", "owner")
    .is("accepted_at", null)
    .is("revoked_at", null);
  if (revokeError) {
    return sendJson(res, 502, {
      success: false,
      error: "Не удалось отозвать прежнее приглашение",
      code: "unavailable",
      details: ["Новое не выписано: старая ссылка осталась единственной действующей."],
    });
  }

  const { token, tokenHash } = createInvitationToken();
  const { data: invitationRow, error: invitationError } = await supabase
    .from("staff_invitations")
    .insert({
      workspace_id: workspaceId,
      email: ownerEmail,
      role: "owner",
      token_hash: tokenHash,
      expires_at: expiryFromNow(),
      invited_by_staff_user_id: null,
    })
    .select("id, expires_at")
    .single();
  if (invitationError || !invitationRow) {
    return sendJson(res, 502, {
      success: false,
      error: "Прежнее приглашение отозвано, а новое не выписалось",
      code: "unavailable",
      details: ["Действующих ссылок у владельца сейчас нет — повторите перевыпуск."],
    });
  }

  const link = acceptUrl(req, token);
  const email = await sendSupabaseInviteEmail(ownerEmail, link);

  return sendJson(res, 201, {
    success: true,
    data: {
      workspaceId,
      name: readString(workspace.name),
      ownerEmail,
      invitationExpiresAt: readString(asRecord(invitationRow).expires_at),
      acceptUrl: link,
      emailSent: email.sent,
      ...(email.reason ? { emailStatus: email.reason } : {}),
    },
  });
}

/** POST /api/crm/platform-onboarding — за requirePlatformOwner в маршрутизаторе. */
export async function handlePlatformOnboarding(req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return sendJson(res, 503, { success: false, error: "Хранилище не настроено", code: "storage_not_configured" });
  }

  const validated = validateOnboardingRequest(asRecord(req.body));
  if ("status" in validated) {
    return sendJson(res, validated.status, {
      success: false,
      error: validated.error,
      code: validated.code,
      ...(validated.details ? { details: validated.details } : {}),
    });
  }

  // Один клиент — одно подключение за раз. Живое приглашение владельца на эту
  // почту означает, что пространство уже создано и ждёт: второе рядом с ним —
  // почти наверняка двойной клик или забытая вчерашняя попытка.
  const { data: pendingRows, error: pendingError } = await supabase
    .from("staff_invitations")
    .select("workspace_id, expires_at, accepted_at, revoked_at")
    .eq("role", "owner")
    .ilike("email", validated.ownerEmail)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString());
  if (pendingError) {
    return sendJson(res, 502, { success: false, error: "Не удалось проверить существующие приглашения", code: "unavailable" });
  }
  if (Array.isArray(pendingRows) && pendingRows.length > 0) {
    const existingWorkspaceId = readString(asRecord(pendingRows[0]).workspace_id);
    const { data: existingWorkspace } = await supabase
      .from("workspaces")
      .select("name")
      .eq("id", existingWorkspaceId)
      .maybeSingle();
    return sendJson(res, 409, {
      success: false,
      error: "Эта почта уже подключается",
      code: "invitation_already_pending",
      details: [
        `Владельцу уже отправлено приглашение${existingWorkspace ? ` в «${readString(asRecord(existingWorkspace).name)}»` : ""}, и оно ещё действует.`,
        "Второе пространство для той же почты создаётся только после того, как первое приглашение принято или истекло.",
      ],
      // Форма предлагает перевыпуск: ссылка теряется, мессенджер её портит,
      // семь дней истекают — и без этого поля живое приглашение было тупиком.
      data: { existingWorkspaceId },
    });
  }

  const { data: workspaceRow, error: workspaceError } = await supabase
    .from("workspaces")
    .insert({ name: validated.name, owner_email: validated.ownerEmail })
    .select("id")
    .single();
  if (workspaceError || !workspaceRow) {
    return sendJson(res, 502, { success: false, error: "Не удалось создать пространство", code: "unavailable" });
  }
  const workspaceId = readString(asRecord(workspaceRow).id);

  // Дальше каждый отказ называет, что УЖЕ создано: полусозданная клиника —
  // это состояние, которое владелец платформы должен видеть, а не угадывать.
  const { error: settingsError } = await supabase.from("workspace_settings").insert([
    { workspace_id: workspaceId, key: VERTICAL_SETTINGS_KEY, value: { vertical: validated.vertical } },
    { workspace_id: workspaceId, key: "clinic_schedule", value: { timeZone: validated.timeZone } },
  ]);
  if (settingsError) {
    return sendJson(res, 502, {
      success: false,
      error: "Пространство создано, но настройки не записались",
      code: "partial_onboarding",
      details: [
        `Пространство ${workspaceId} уже существует — не создавайте второе.`,
        "Не записаны ниша и часовой пояс; приглашение владельцу не отправлялось.",
      ],
    });
  }

  const { token, tokenHash } = createInvitationToken();
  const { data: invitationRow, error: invitationError } = await supabase
    .from("staff_invitations")
    .insert({
      workspace_id: workspaceId,
      email: validated.ownerEmail,
      role: "owner",
      token_hash: tokenHash,
      expires_at: expiryFromNow(),
      // Приглашает платформа, а не сотрудник пространства — его ещё нет.
      invited_by_staff_user_id: null,
    })
    .select("id, expires_at")
    .single();
  if (invitationError || !invitationRow) {
    return sendJson(res, 502, {
      success: false,
      error: "Пространство создано, но приглашение не выписалось",
      code: "partial_onboarding",
      details: [
        `Пространство ${workspaceId} с нишей и поясом уже существует — не создавайте второе.`,
        "Отправьте приглашение повторно этой же формой: живого приглашения у почты нет, защита от дублей пропустит.",
      ],
    });
  }

  const link = acceptUrl(req, token);
  const email = await sendSupabaseInviteEmail(validated.ownerEmail, link);

  return sendJson(res, 201, {
    success: true,
    data: {
      workspaceId,
      name: validated.name,
      vertical: validated.vertical,
      ownerEmail: validated.ownerEmail,
      timeZone: validated.timeZone,
      invitationExpiresAt: readString(asRecord(invitationRow).expires_at),
      // Показывается один раз: в базе лежит только хэш. Если письмо не ушло —
      // ссылку передают руками, любым каналом.
      acceptUrl: link,
      emailSent: email.sent,
      ...(email.reason ? { emailStatus: email.reason } : {}),
    },
  });
}

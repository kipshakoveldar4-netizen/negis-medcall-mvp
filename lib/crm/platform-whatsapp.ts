import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseServerClient } from "../supabase/server";

// Привязка номера WhatsApp Cloud к клинике — с портала платформы.
//
// Вебхук Meta не верит полезной нагрузке ни в чём, что касается арендатора:
// единственный источник истины — строка whatsapp_cloud_numbers, где
// phone_number_id из metadata сопоставлен с клиникой (migrations/027).
// Заводилась она до сих пор руками в SQL Editor, и это оставляло подключение
// каждого следующего салона на владельце платформы с редактором наперевес.
//
// Что здесь можно, а что нельзя:
//
//   — phone_number_id НЕ секрет: это публичный идентификатор номера в Meta,
//     видимый в API Setup. Токены и App Secret живут в переменных окружения и
//     сюда не попадают ни в каком виде;
//   — маршрут платформенный (kind: "platform"), то есть за списком владельцев
//     платформы: клиника не привязывает себе чужие номера;
//   — колонка phone_number_id уникальна на всю базу. Занятый номер отвечает
//     отказом, а не переносом: увести чужой канал одним запросом нельзя.

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
 * phone_number_id у Meta — длинное десятичное число, а не телефон.
 *
 * Проверка отделяет его от номера, введённого по привычке: «+7 701…» здесь
 * означает, что оператор скопировал не то поле, и вебхук по такой строке не
 * найдёт никогда ничего.
 */
export function validatePhoneNumberId(value: unknown): { phoneNumberId: string } | { error: string; details: string[] } {
  const phoneNumberId = readString(value);
  if (!/^\d{6,32}$/.test(phoneNumberId)) {
    return {
      error: "Это не идентификатор номера",
      details: [
        "Нужен phone_number_id из Meta → WhatsApp → API Setup: длинное число, а не сам телефон.",
        "Если вы скопировали «+7 701…», возьмите значение из поля Phone number ID.",
      ],
    };
  }
  return { phoneNumberId };
}

/** POST /api/crm/platform-whatsapp-number — за requirePlatformOwner. */
export async function handlePlatformWhatsappNumber(req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return sendJson(res, 503, { success: false, error: "Хранилище не настроено", code: "storage_not_configured" });
  }

  const body = asRecord(req.body);
  const workspaceId = readString(body.workspaceId);
  if (!UUID_PATTERN.test(workspaceId)) {
    return sendJson(res, 400, { success: false, error: "Нужна клиника", code: "workspace_required" });
  }

  const validated = validatePhoneNumberId(body.phoneNumberId);
  if ("error" in validated) {
    return sendJson(res, 400, { success: false, error: validated.error, code: "invalid_phone_number_id", details: validated.details });
  }

  const { data: workspaceRow, error: workspaceError } = await supabase
    .from("workspaces")
    .select("id, name")
    .eq("id", workspaceId)
    .maybeSingle();
  if (workspaceError) {
    return sendJson(res, 502, { success: false, error: "Не удалось прочитать клинику", code: "unavailable" });
  }
  if (!workspaceRow) {
    return sendJson(res, 404, { success: false, error: "Клиники нет", code: "not_found" });
  }

  // Номер уже за кем-то? Уникальность phone_number_id — на всю базу, и это
  // правильно: один номер физически принимает сообщения в одну клинику.
  // Молча переносить его отсюда нельзя — заявки чужого салона начали бы
  // приходить не туда, и никто бы не понял почему.
  const { data: existing, error: existingError } = await supabase
    .from("whatsapp_cloud_numbers")
    .select("id, workspace_id, enabled")
    .eq("phone_number_id", validated.phoneNumberId)
    .maybeSingle();
  if (existingError) {
    // Таблицы нет — миграция 027 не применена. Это не «номер занят».
    return sendJson(res, 503, {
      success: false,
      error: "Прямое подключение WhatsApp ещё не активировано",
      code: "not_provisioned",
      details: ["Примените migrations/027_whatsapp_cloud_numbers.sql в SQL Editor — после этого номер привяжется."],
    });
  }

  if (existing) {
    const owner = readString(asRecord(existing).workspace_id);
    if (owner === workspaceId) {
      // Тот же номер и та же клиника — включаем приём, если он был выключен.
      const { error: enableError } = await supabase
        .from("whatsapp_cloud_numbers")
        .update({ enabled: true, updated_at: new Date().toISOString() })
        .eq("phone_number_id", validated.phoneNumberId)
        .eq("workspace_id", workspaceId);
      if (enableError) {
        return sendJson(res, 502, { success: false, error: "Не удалось включить приём", code: "unavailable" });
      }
      return sendJson(res, 200, {
        success: true,
        data: { workspaceId, phoneNumberId: validated.phoneNumberId, alreadyLinked: true },
      });
    }
    return sendJson(res, 409, {
      success: false,
      error: "Этот номер уже привязан к другой клинике",
      code: "phone_number_taken",
      details: ["Один номер принимает сообщения в одну клинику. Отвяжите его там, где он привязан сейчас."],
    });
  }

  const { error: insertError } = await supabase
    .from("whatsapp_cloud_numbers")
    .insert({ workspace_id: workspaceId, phone_number_id: validated.phoneNumberId, enabled: true });
  if (insertError) {
    return sendJson(res, 502, { success: false, error: "Не удалось привязать номер", code: "unavailable" });
  }

  console.log(`[platform-whatsapp] linked workspace=${workspaceId}`);

  return sendJson(res, 201, {
    success: true,
    data: {
      workspaceId,
      phoneNumberId: validated.phoneNumberId,
      clinicName: readString(asRecord(workspaceRow).name),
    },
  });
}

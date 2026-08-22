// Подписка устройства на уведомления и сама рассылка.
//
// Два разных предмета в одном файле намеренно: они делят одну таблицу и одно
// правило «строка есть устройство человека», и разносить их значило бы держать
// это правило в двух местах.
//
// Почему не обобщённый ресурс. У ресурса GET — это список по всему рабочему
// пространству, а строка подписки содержит адрес устройства и его ключи, то есть
// ПОЛНОМОЧИЕ отправить уведомление на чужой телефон. Регистратор получил бы
// список устройств всех мастеров. Здесь маршрут отдаёт человеку только его
// собственные устройства и никогда чужие.

import type { VercelRequest, VercelResponse } from "@vercel/node";

import { getSupabaseServerClient } from "../supabase/server";
import { readWorkspaceContext } from "./server";
import { readVapidKeys, sendWebPush } from "./web-push";
import {
  MAX_ENDPOINTS_PER_EVENT,
  notificationFor,
  resolveRecipient,
  type AppointmentSnapshot,
  type DoctorCard,
  type StaffNotificationEvent,
} from "./staff-notifications";

type CrmSupabaseClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sendJson(res: VercelResponse, status: number, payload: unknown) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json(payload);
}

/** Таблицы 044 может не быть: деплой доходит до продакшена раньше миграции. */
function isMissingPushSubscriptions(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = readString(error.code);
  return code === "PGRST205" || code === "42P01" || readString(error.message).includes("push_subscriptions");
}

/**
 * Подписка устройства.
 *
 * GET — мои устройства (без ключей: они полномочие, а не сведения).
 * POST — подписать это устройство. PATCH — отписать по адресу.
 */
export async function handlePushSubscriptions(req: VercelRequest, res: VercelResponse) {
  const context = readWorkspaceContext(req);
  const workspaceId = readString(context?.workspaceId);
  const staffUserId = readString(context?.staffUserId);

  // Устройство принадлежит СОТРУДНИКУ. Владелец, зашедший в кабинет клиники
  // через имперсонацию, не имеет своей строки staff_users — и подписать его
  // телефон именем сотрудника клиники нельзя.
  if (!context || !isUuid(staffUserId) || !isUuid(workspaceId)) {
    return sendJson(res, 403, { success: false, error: "Forbidden", code: "staff_session_required" });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return sendJson(res, 200, { success: true, mode: "demo", devices: [], vapidPublicKey: "" });
  }

  const keys = readVapidKeys();
  const vapidPublicKey = keys?.publicKey ?? "";

  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("push_subscriptions")
      .select("id, endpoint, device_label, last_success_at, revoked_at, gone_at, created_at")
      .eq("workspace_id", workspaceId)
      .eq("staff_user_id", staffUserId)
      .order("created_at", { ascending: false });

    if (error) {
      if (isMissingPushSubscriptions(error)) {
        return sendJson(res, 200, { success: true, devices: [], available: false, migration: "044", vapidPublicKey });
      }
      return sendJson(res, 502, { success: false, error: "Не удалось прочитать устройства", code: "read_failed" });
    }

    const devices = (Array.isArray(data) ? data : []).map((row) => {
      const record = row as Record<string, unknown>;
      return {
        id: readString(record.id),
        // Адрес устройства наружу не отдаётся: по нему шлют уведомления.
        // Хвоста хватает, чтобы человек отличил одно своё устройство от другого.
        endpointTail: readString(record.endpoint).slice(-12),
        label: readString(record.device_label),
        lastSuccessAt: readString(record.last_success_at),
        revoked: Boolean(record.revoked_at),
        gone: Boolean(record.gone_at),
      };
    });
    return sendJson(res, 200, { success: true, devices, vapidPublicKey, available: true });
  }

  if (req.method === "POST") {
    const body = (typeof req.body === "object" && req.body ? req.body : {}) as Record<string, unknown>;
    const endpoint = readString(body.endpoint).trim();
    const p256dh = readString(body.p256dh).trim();
    const auth = readString(body.auth).trim();
    const label = readString(body.label).trim().slice(0, 60);

    if (!endpoint.startsWith("https://") || endpoint.length > 1024 || !p256dh || !auth) {
      return sendJson(res, 400, { success: false, error: "Подписка неполная", code: "invalid_subscription" });
    }
    if (!keys) {
      // Ключей нет — подписывать бессмысленно: отправить всё равно не сможем.
      // Честный отказ лучше строки в базе, которая никогда не сработает.
      return sendJson(res, 503, { success: false, error: "Уведомления ещё не настроены", code: "vapid_missing" });
    }

    const { error } = await supabase.from("push_subscriptions").upsert(
      {
        workspace_id: workspaceId,
        staff_user_id: staffUserId,
        endpoint,
        // Ключи перезаписываются всегда: браузер выдаёт новые при переустановке
        // подписки, а старые сделали бы сообщение недешифруемым — то есть
        // невидимым, без единой ошибки.
        p256dh,
        auth,
        device_label: label || null,
        revoked_at: null,
        gone_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,endpoint" },
    );

    if (error) {
      if (isMissingPushSubscriptions(error)) {
        return sendJson(res, 503, { success: false, error: "Уведомления ещё не включены", code: "migration_missing", migration: "044" });
      }
      return sendJson(res, 502, { success: false, error: "Не удалось сохранить устройство", code: "write_failed" });
    }
    return sendJson(res, 200, { success: true });
  }

  if (req.method === "PATCH") {
    const body = (typeof req.body === "object" && req.body ? req.body : {}) as Record<string, unknown>;
    const endpoint = readString(body.endpoint).trim();
    if (!endpoint) return sendJson(res, 400, { success: false, error: "Не указано устройство" });

    // Отписка — метка времени, а не удаление: видно, что устройство было и
    // когда его отключили. И отписать можно только СВОЁ устройство.
    const { error } = await supabase
      .from("push_subscriptions")
      .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId)
      .eq("staff_user_id", staffUserId)
      .eq("endpoint", endpoint);

    if (error) {
      if (isMissingPushSubscriptions(error)) return sendJson(res, 200, { success: true });
      return sendJson(res, 502, { success: false, error: "Не удалось отключить устройство", code: "write_failed" });
    }
    return sendJson(res, 200, { success: true });
  }

  return sendJson(res, 405, { success: false, error: "Method not allowed" });
}

/**
 * Уведомить мастера о событии с его записью.
 *
 * Контракт тот же, что у журнала изменений: НИКОГДА не бросает и НИКОГДА не
 * меняет ответ. Уведомление — побочное действие; запись, которая сохранилась,
 * обязана считаться сохранённой, даже если push-сервис лежит.
 */
export async function notifyAppointmentEvent(input: {
  supabase: CrmSupabaseClient;
  workspaceId: string;
  event: StaffNotificationEvent;
  appointment: AppointmentSnapshot;
  actorStaffUserId: string;
  timeZone: string;
}): Promise<void> {
  try {
    const keys = readVapidKeys();
    if (!keys) return;

    const doctors = await readDoctorCards(input.supabase, input.workspaceId);
    if (!doctors) return;

    const decision = resolveRecipient({
      appointment: input.appointment,
      doctors,
      actorStaffUserId: input.actorStaffUserId,
      nowMs: Date.now(),
    });
    if (!("staffUserId" in decision)) {
      // Причина отказа в логе оператора — без имён и без номеров.
      console.warn(`push: не отправляем (${decision.skipped})`);
      return;
    }

    const notification = notificationFor({
      event: input.event,
      appointment: input.appointment,
      timeZone: input.timeZone,
    });
    if (!notification) return;

    const { data, error } = await input.supabase
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth")
      .eq("workspace_id", input.workspaceId)
      .eq("staff_user_id", decision.staffUserId)
      .is("revoked_at", null)
      .is("gone_at", null)
      .limit(MAX_ENDPOINTS_PER_EVENT);

    if (error) {
      if (isMissingPushSubscriptions(error)) {
        console.warn("push: таблица устройств ещё не создана (миграция 044)");
        return;
      }
      console.warn("push: не удалось прочитать устройства");
      return;
    }

    const devices = (Array.isArray(data) ? data : []).map((row) => {
      const record = row as Record<string, unknown>;
      return {
        endpoint: readString(record.endpoint),
        p256dh: readString(record.p256dh),
        auth: readString(record.auth),
      };
    });
    if (devices.length === 0) return;

    const payload = JSON.stringify(notification);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const results = await Promise.allSettled(
      devices.map((device) => sendWebPush(device, payload, keys, nowSeconds)),
    );

    const gone: string[] = [];
    const delivered: string[] = [];
    results.forEach((result, index) => {
      if (result.status !== "fulfilled") return;
      if (result.value.outcome === "gone") gone.push(devices[index].endpoint);
      if (result.value.outcome === "delivered") delivered.push(devices[index].endpoint);
    });

    // Мёртвые устройства помечаем, живым обновляем отметку успеха: только она и
    // отличает «уведомления доходят» от «человек отключил их в настройках
    // телефона, а приложение об этом не знает».
    const stamp = new Date().toISOString();
    if (gone.length > 0) {
      await input.supabase
        .from("push_subscriptions")
        .update({ gone_at: stamp, updated_at: stamp })
        .eq("workspace_id", input.workspaceId)
        .in("endpoint", gone);
    }
    if (delivered.length > 0) {
      await input.supabase
        .from("push_subscriptions")
        .update({ last_success_at: stamp, updated_at: stamp })
        .eq("workspace_id", input.workspaceId)
        .in("endpoint", delivered);
    }
  } catch {
    // Ни одна ошибка отсюда не должна повлиять на сохранение записи.
    console.warn("push: отправка не удалась");
  }
}

async function readDoctorCards(
  supabase: CrmSupabaseClient,
  workspaceId: string,
): Promise<DoctorCard[] | null> {
  const { data, error } = await supabase
    .from("clinic_doctors")
    .select("id, full_name, staff_user_id")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);
  if (error) return null;
  return (Array.isArray(data) ? data : []).map((row) => {
    const record = row as Record<string, unknown>;
    return {
      id: readString(record.id),
      fullName: readString(record.full_name),
      staffUserId: readString(record.staff_user_id),
    };
  });
}

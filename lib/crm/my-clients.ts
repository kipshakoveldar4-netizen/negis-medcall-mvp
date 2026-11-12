// База клиентов по мастерам: «чей это клиент».
//
// Владелец салона сформулировал правило так: «каждый мастер свою базу видит без
// номеров, а админы — базу всех мастеров с номерами».
//
// Почему это отдельный маршрут, а не право view_clients для мастера. Право
// view_clients открывает ресурс clients целиком: список всех клиентов клиники,
// обратный поиск «номер → карточка» и сделки — они посажены на то же право. Дать
// его мастеру значило бы отдать ему всю базу салона, а не его собственную часть.
// Здесь наоборот: выборка сужена связями client_masters (миграция 042), и шире
// этих связей маршрут не отдаёт ничего.
//
// Почему контакты режутся всегда, без исключения «своя запись». В записях такое
// исключение есть: телефон, который мастер вписал сам, прятать от него
// бессмысленно. Здесь предмет другой — это СПИСОК, выгрузка базы. Список с
// номерами уходит из салона одним снимком экрана, и владелец просил ровно этого
// не допустить.

import type { VercelRequest, VercelResponse } from "@vercel/node";

import { getSupabaseServerClient } from "../supabase/server";
import { readOwnWorkIdentity, readWorkspaceContext } from "./server";
import { hidesClientContacts, redactContactsList } from "./contact-privacy";

// Мелкие помощники повторены локально ровно так же, как в lib/crm/change-log.ts:
// server.ts их наружу не отдаёт, а тянуть туда экспорт ради трёх строк значило бы
// расширять и без того самый большой модуль проекта.
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

/**
 * Потолок выдачи. Не «сколько влезет»: у салона «меди» 2 532 клиента, и отдавать
 * их одним ответом на телефон мастера незачем.
 *
 * Обрезка НИКОГДА не молчит: в ответе стоит truncated, и экран обязан сказать об
 * этом человеку. Молчаливый предел читается как «это вся база» — и тогда клиент,
 * не попавший в выдачу, считается несуществующим.
 */
export const MY_CLIENTS_LIMIT = 500;

interface ClientRow {
  id: string;
  full_name: unknown;
  phone: unknown;
  whatsapp: unknown;
  status: unknown;
  notes: unknown;
}

/** Отсутствие таблицы связей (042) — это выключенная возможность, а не поломка. */
function isMissingClientMasters(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = readString(error.code);
  const message = readString(error.message).toLowerCase();
  return code === "PGRST205" || code === "42P01" || message.includes("client_masters");
}

export async function handleMyClients(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { success: false, error: "Method not allowed" });
  }

  const context = readWorkspaceContext(req);
  const workspaceId = readString(context?.workspaceId);
  const role = readString(context?.role);
  const staffUserId = readString(context?.staffUserId);
  const permissions = context?.permissions ?? [];

  // Кто спрашивает. Мастер — только про себя; тот, кому доверена база клиники,
  // может спросить про любого и получить номера.
  const seesEveryone = permissions.includes("view_clients");
  const seesOwnOnly = permissions.includes("view_appointments");
  if (!context || (!seesEveryone && !seesOwnOnly)) {
    return sendJson(res, 403, { success: false, error: "Forbidden", code: "insufficient_permission" });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase || !isUuid(workspaceId)) {
    return sendJson(res, 200, { success: true, mode: "demo", items: [], doctors: [], truncated: false });
  }

  const requestedDoctorId = readString(
    Array.isArray(req.query.doctorId) ? req.query.doctorId[0] : req.query.doctorId,
  );

  let doctorFilter = "";
  if (seesEveryone) {
    // Админ смотрит либо всех, либо одного — по своему выбору.
    if (requestedDoctorId && !isUuid(requestedDoctorId)) {
      return sendJson(res, 400, { success: false, error: "doctorId must be a valid id" });
    }
    doctorFilter = requestedDoctorId;
  } else {
    const identity = await readOwnWorkIdentity(supabase, workspaceId, staffUserId);
    if (identity.readFailed) {
      // Не смогли выяснить, кто спрашивает, — отказываем честно. Пустой список
      // здесь читался бы как «у вас нет клиентов».
      return sendJson(res, 503, {
        success: false,
        error: "Не удалось определить вашу карточку. Это сбой связи, а не пустая база.",
        code: "identity_unavailable",
      });
    }
    if (!identity.doctorId) {
      // Карточка не связана с учётной записью. Состояние объяснимое и
      // исправимое администратором — говорим прямо, а не пустым списком.
      return sendJson(res, 200, {
        success: true,
        items: [],
        doctors: [],
        truncated: false,
        reason: "unlinked",
      });
    }
    doctorFilter = identity.doctorId;
  }

  const links = await readLinks(supabase, workspaceId, doctorFilter);
  if (links.unavailable) {
    return sendJson(res, 200, {
      success: true,
      items: [],
      doctors: [],
      truncated: false,
      available: false,
      migration: "042",
    });
  }
  if (links.error) {
    return sendJson(res, 502, { success: false, error: "Не удалось прочитать базу клиентов", code: "read_failed" });
  }

  const clientIds = [...new Set(links.rows.map((row) => row.clientId))].slice(0, MY_CLIENTS_LIMIT);
  const truncated = new Set(links.rows.map((row) => row.clientId)).size > clientIds.length;

  const clientsById = await readClients(supabase, workspaceId, clientIds);
  const doctorsById = seesEveryone ? await readDoctorNames(supabase, workspaceId) : new Map<string, string>();

  const items = links.rows
    .filter((row) => clientsById.has(row.clientId))
    .map((row) => {
      const client = clientsById.get(row.clientId) as ClientRow;
      return {
        id: client.id,
        clientId: client.id,
        fullName: readString(client.full_name) || "Без имени",
        phone: readString(client.phone),
        whatsapp: readString(client.whatsapp),
        status: readString(client.status),
        visits: row.visits,
        lastVisitAt: row.lastVisitAt,
        doctorId: row.doctorId,
        doctorName: doctorsById.get(row.doctorId) ?? "",
      };
    })
    .sort((left, right) => (right.lastVisitAt || "").localeCompare(left.lastVisitAt || ""));

  // Срез контактов — тот же слой, что и везде. Для мастера он снимает телефон и
  // WhatsApp; администратору отдаёт как есть.
  const safeItems = redactContactsList(items as unknown as Record<string, unknown>[], role);

  return sendJson(res, 200, {
    success: true,
    items: safeItems,
    truncated,
    limit: MY_CLIENTS_LIMIT,
    contactsHidden: hidesClientContacts(role),
    scope: seesEveryone ? (doctorFilter ? "doctor" : "clinic") : "own",
  });
}

async function readLinks(
  supabase: CrmSupabaseClient,
  workspaceId: string,
  doctorId: string,
): Promise<{
  rows: Array<{ clientId: string; doctorId: string; visits: number; lastVisitAt: string }>;
  unavailable: boolean;
  error: boolean;
}> {
  let query = supabase
    .from("client_masters")
    .select("client_id, doctor_id, visits_count, last_visit_at")
    .eq("workspace_id", workspaceId)
    .order("last_visit_at", { ascending: false })
    .limit(MY_CLIENTS_LIMIT * 2);
  if (doctorId) query = query.eq("doctor_id", doctorId);

  const { data, error } = await query;
  if (error) {
    if (isMissingClientMasters(error)) return { rows: [], unavailable: true, error: false };
    console.warn("my-clients: не удалось прочитать связи клиент — мастер");
    return { rows: [], unavailable: false, error: true };
  }

  const rows = (Array.isArray(data) ? data : []).map((row) => {
    const record = row as Record<string, unknown>;
    return {
      clientId: readString(record.client_id),
      doctorId: readString(record.doctor_id),
      visits: Number(record.visits_count) || 0,
      lastVisitAt: readString(record.last_visit_at),
    };
  });
  return { rows: rows.filter((row) => row.clientId), unavailable: false, error: false };
}

async function readClients(
  supabase: CrmSupabaseClient,
  workspaceId: string,
  ids: string[],
): Promise<Map<string, ClientRow>> {
  const result = new Map<string, ClientRow>();
  if (ids.length === 0) return result;

  // Читаем пачками: длина URL у PostgREST не бесконечна, а список может быть в
  // сотни идентификаторов.
  const CHUNK = 100;
  for (let index = 0; index < ids.length; index += CHUNK) {
    const chunk = ids.slice(index, index + CHUNK);
    const { data, error } = await supabase
      .from("clients")
      .select("id, full_name, phone, whatsapp, status, notes")
      .eq("workspace_id", workspaceId)
      .in("id", chunk);
    if (error) {
      console.warn("my-clients: не удалось прочитать карточки клиентов");
      continue;
    }
    for (const row of Array.isArray(data) ? data : []) {
      const record = row as unknown as ClientRow;
      const id = readString(record.id);
      if (id) result.set(id, { ...record, id });
    }
  }
  return result;
}

async function readDoctorNames(supabase: CrmSupabaseClient, workspaceId: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const { data, error } = await supabase
    .from("clinic_doctors")
    .select("id, full_name")
    .eq("workspace_id", workspaceId);
  if (error) return names;
  for (const row of Array.isArray(data) ? data : []) {
    const record = row as Record<string, unknown>;
    const id = readString(record.id);
    if (id) names.set(id, readString(record.full_name));
  }
  return names;
}

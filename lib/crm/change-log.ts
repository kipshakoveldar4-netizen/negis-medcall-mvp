import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseServerClient } from "../supabase/server";
import { readOwnWorkIdentity, readWorkspaceContext } from "./server";
import { isEmptyIdentity, rowBelongsTo, seesOnlyOwnWork } from "./own-work";
import { CHANGE_JOURNAL_INTERNALS, type ChangeEntry, type ChangeEntityType } from "./change-journal";
import { hidesClientContacts } from "./contact-privacy";

// The change journal, HTTP half: one record's history, newest first.
//
// The permission it enforces is the one that reading the record itself
// requires. The router holds a single permission per method and cannot express
// "view_leads for a lead, view_clients for a client", so the second half of the
// gate lives here — and it is the half that matters, because a journal that
// answered more broadly than the record would be a way around the record.

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonRecord;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function sendJson(res: VercelResponse, status: number, payload: unknown) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json(payload);
}

const ENTITY_POLICY = CHANGE_JOURNAL_INTERNALS.ENTITY_POLICY;

type JournalEvent = {
  id: string;
  action: string;
  actorName: string | null;
  actorRole: string | null;
  actorKind: string | null;
  createdAt: string | null;
  changes: ChangeEntry[];
};

const HISTORY_LIMIT = 100;

/**
 * GET /api/crm/change-log?entityType=lead&entityId=<uuid>
 *
 * One record's history, newest first. The permission checked is the one that
 * reading the record itself requires, resolved from the entity kind — the
 * router cannot express that, because it holds a single permission per method,
 * so the second half of the gate lives here.
 */
/** Поля журнала, которые являются контактом клиента. */
const CONTACT_FIELD_NAMES = new Set(["client_phone", "phone", "whatsapp", "email", "client_whatsapp"]);

/**
 * Своя ли это запись. Отдельным чтением, потому что журнал живёт в своей
 * таблице и о самой записи не знает ничего.
 *
 * Отказ чтения означает «не подтверждено», а не «разрешено»: расширять доступ
 * из-за сбоя базы — ровно тот способ, которым тихо открываются двери.
 */
async function appointmentBelongsToActor(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  workspaceId: string,
  staffUserId: string,
  appointmentId: string,
): Promise<boolean> {
  try {
    const identity = await readOwnWorkIdentity(supabase, workspaceId, staffUserId);
    if (isEmptyIdentity(identity)) return false;
    const { data, error } = await supabase
      .from("appointments")
      .select("doctor_id, doctor_name")
      .eq("workspace_id", workspaceId)
      .eq("id", appointmentId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return false;
    return rowBelongsTo(data as Record<string, unknown>, identity);
  } catch (error) {
    console.warn("change-log: ownership check failed", error instanceof Error ? error.message : error);
    return false;
  }
}

export async function handleCrmChangeLog(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { success: false, error: "Method not allowed" });
  }

  const context = readWorkspaceContext(req);
  const workspaceId = readString(context?.workspaceId);

  const entityType = readString(Array.isArray(req.query.entityType) ? req.query.entityType[0] : req.query.entityType);
  const entityId = readString(Array.isArray(req.query.entityId) ? req.query.entityId[0] : req.query.entityId);

  if (!(entityType in ENTITY_POLICY)) {
    return sendJson(res, 400, { success: false, error: "Unknown entityType" });
  }
  if (!isUuid(entityId)) {
    return sendJson(res, 400, { success: false, error: "entityId must be a valid id" });
  }

  const policy = ENTITY_POLICY[entityType as ChangeEntityType];

  // The journal is never a wider door than the record. A marketer who may not
  // read clients may not read a client's history either, even though the same
  // route served their leads a moment ago.
  if (!context || !context.permissions.includes(policy.permission)) {
    return sendJson(res, 403, { success: false, error: "Forbidden", code: "insufficient_permission" });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase || !isUuid(workspaceId)) {
    return sendJson(res, 200, { success: true, mode: "demo", events: [] });
  }

  // Журнал не шире самой записи.
  //
  // Список записей мастеру сужен, но история открывается ПО ИДЕНТИФИКАТОРУ, а
  // идентификатор чужой записи достать нетрудно — из задачи со связью, из
  // старой вкладки, из прежнего экспорта. Без этой проверки журнал остаётся
  // полноценным чтением чужой работы: услуга, время, статус и мастер лежат в
  // нём значениями, как есть.
  //
  // Ответ — пустая история, а не отказ: отказ подтвердил бы, что запись
  // существует, и это уже сведение о чужом клиенте.
  if (entityType === "appointment" && seesOnlyOwnWork(context.role)) {
    const mine = await appointmentBelongsToActor(supabase, workspaceId, readString(context.staffUserId), entityId);
    if (!mine) {
      console.warn("change-log: appointment history outside the acting specialist's own work; answering empty");
      return sendJson(res, 200, { success: true, mode: "supabase", events: [] });
    }
  }

  try {
    const { data, error } = await supabase
      .from("audit_logs")
      .select("id, action, actor_name, actor_role, actor_kind, actor_staff_user_id, created_at, metadata")
      .eq("workspace_id", workspaceId)
      .eq("entity_type", entityType)
      .eq("entity_id", entityId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);

    if (error) throw new Error(error.message);

    const events: JournalEvent[] = (Array.isArray(data) ? data : []).map((raw) => {
      const row = asRecord(raw);
      const metadata = asRecord(row.metadata);
      const allChanges = Array.isArray(metadata.changes) ? (metadata.changes as ChangeEntry[]) : [];
      // Журнал — шестой путь к контакту, и самый незаметный: телефон лежит там
      // «маской», то есть последними четырьмя цифрами, а перебрать записи
      // своего же расписания мастер может по их id. Четыре цифры — это всё
      // ещё контакт, поэтому роли без контактов такие строки не отдаются
      // вовсе, а не в урезанном виде.
      const changes = hidesClientContacts(context.role)
        ? allChanges.filter((change) => !CONTACT_FIELD_NAMES.has(String(asRecord(change).field)))
        : allChanges;
      return {
        id: readString(row.id),
        action: readString(row.action),
        actorName: readString(row.actor_name) || null,
        actorRole: readString(row.actor_role) || null,
        actorKind: readString(row.actor_kind) || null,
        createdAt: readString(row.created_at) || null,
        changes,
      };
    });

    return sendJson(res, 200, { success: true, mode: "supabase", events });
  } catch (error) {
    console.warn("audit_logs: change journal read failed", error instanceof Error ? error.message : error);
    // Security-2F: a read the database refused is a refusal, not an empty
    // history. An empty timeline for a lead three people worked on is a lie
    // the operator cannot tell from the truth.
    return sendJson(res, 502, { success: false, error: "Не удалось загрузить историю" });
  }
}


import { getSupabaseServerClient } from "../supabase/server";
import type { CrmPermission } from "../auth/permissions";
import { normalizePhone } from "./phone";

// The change journal, pure half: policy, diffing and the writer.
//
// Split from the HTTP handler for one mechanical reason — lib/crm/server.ts
// has to call the writer, and the handler has to read the workspace context
// out of server.ts. Keeping both in one file would make that a cycle.
//
// The change journal: who changed what, when, and from what to what.
//
// Every CRM the clinic is compared against has this, and Negis had the table
// for it since migration 010 and nothing else — no writer, no reader, no
// screen. This module is both halves.
//
// Three rules shape it, and all three are about a medical clinic rather than
// about journals in general:
//
//   1. The journal is a second copy of personal data. It is therefore read
//      under the same permission as the record it describes — asking for a
//      lead's history requires `view_leads`, exactly what reading the lead
//      requires — so it can never become a wider channel than the record.
//   2. Free text is not journaled by value. A lead's «Заметки» is where a
//      clinical hint ends up in practice ("хочет диагностику кожи"); the entry
//      says the note changed and nothing more. Name and phone are recorded
//      masked, because "which lead" has to stay recognisable while the value
//      does not need to be duplicated.
//   3. Only dictionary fields — stage, source, campaign, assignee — carry full
//      before/after values, because those are what the history is actually for
//      and none of them is patient data.
//
// What it does NOT do, deliberately: it does not journal reads. Access logging
// for patient data is a separate technical log with its own retention, and
// mixing it in would bury the operator's timeline under "opened the card".

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

type SupabaseServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>;

/** Where the change came from. Without this an operator's edit and a webhook's look alike. */
export type ChangeActorKind = "manual" | "integration" | "automation" | "system";

/** The entity kinds a clinic looks up history for. Adding one is a three-line change here. */
export type ChangeEntityType = "lead" | "client" | "deal" | "appointment";

/**
 * How each column is allowed to appear in the journal.
 *
 * `value`  — recorded in full. Dictionary and reference fields only.
 * `masked` — recorded as a recognisable stub, never in full.
 * `fact`   — recorded as "this changed", with no value at all.
 *
 * A column absent from a table is not journaled. That is the default on
 * purpose: a new column has to be classified before it can reach the journal,
 * rather than leaking into it because nobody thought about it.
 */
type FieldSensitivity = "value" | "masked" | "fact";

type FieldPolicy = { label: string; sensitivity: FieldSensitivity };

const LEAD_FIELDS: Record<string, FieldPolicy> = {
  status: { label: "Этап", sensitivity: "value" },
  source: { label: "Источник", sensitivity: "value" },
  campaign: { label: "Кампания", sensitivity: "value" },
  responsible_user_id: { label: "Ответственный", sensitivity: "value" },
  meta_campaign_launch_id: { label: "Рекламная кампания", sensitivity: "value" },
  client_id: { label: "Клиент", sensitivity: "value" },
  full_name: { label: "Имя", sensitivity: "masked" },
  phone: { label: "Телефон", sensitivity: "masked" },
  notes: { label: "Заметка", sensitivity: "fact" },
};

// Keys are the COLUMN names buildPatchRow writes, never the browser's field
// names: the diff runs against the written row. The first version listed
// `comment` and `last_visit` here — the browser's spelling — and both were
// dead: a diff key that matches no column journals nothing, silently.
const CLIENT_FIELDS: Record<string, FieldPolicy> = {
  status: { label: "Статус", sensitivity: "value" },
  source: { label: "Источник", sensitivity: "value" },
  last_visit_at: { label: "Последний визит", sensitivity: "value" },
  full_name: { label: "Имя", sensitivity: "masked" },
  phone: { label: "Телефон", sensitivity: "masked" },
  whatsapp: { label: "WhatsApp", sensitivity: "masked" },
  notes: { label: "Заметка", sensitivity: "fact" },
};

const DEAL_FIELDS: Record<string, FieldPolicy> = {
  status: { label: "Статус", sensitivity: "value" },
  title: { label: "Название", sensitivity: "value" },
  amount_minor: { label: "Сумма", sensitivity: "value" },
  currency: { label: "Валюта", sensitivity: "value" },
  client_id: { label: "Клиент", sensitivity: "value" },
  lead_id: { label: "Заявка", sensitivity: "value" },
  meta_campaign_launch_id: { label: "Рекламная кампания", sensitivity: "value" },
};

const APPOINTMENT_FIELDS: Record<string, FieldPolicy> = {
  client_id: { label: "Клиент", sensitivity: "value" },
  status: { label: "Статус", sensitivity: "value" },
  service: { label: "Услуга", sensitivity: "value" },
  starts_at: { label: "Время", sensitivity: "value" },
  doctor_name: { label: "Врач", sensitivity: "value" },
  client_name: { label: "Пациент", sensitivity: "masked" },
  client_phone: { label: "Телефон", sensitivity: "masked" },
  notes: { label: "Заметка", sensitivity: "fact" },
};

const ENTITY_POLICY: Record<ChangeEntityType, {
  table: string;
  permission: CrmPermission;
  fields: Record<string, FieldPolicy>;
}> = {
  lead: { table: "leads", permission: "view_leads", fields: LEAD_FIELDS },
  client: { table: "clients", permission: "view_clients", fields: CLIENT_FIELDS },
  deal: { table: "deals", permission: "view_clients", fields: DEAL_FIELDS },
  appointment: { table: "appointments", permission: "view_appointments", fields: APPOINTMENT_FIELDS },
};

/** Resource name as the CRM router knows it → the entity kind the journal knows. */
const RESOURCE_ENTITY: Record<string, ChangeEntityType> = {
  leads: "lead",
  clients: "client",
  deals: "deal",
  appointments: "appointment",
};

export function journaledEntityFor(resource: string): ChangeEntityType | null {
  return RESOURCE_ENTITY[resource] ?? null;
}

/**
 * Last digits of a number, for a stub that stays recognisable.
 *
 * Comparison does NOT go through this. The first version of this file compared
 * phones by their digits and called «+7 700 801 77 21» and «87008017721» two
 * different numbers — they are the same subscriber, written with the country
 * code and with the national trunk prefix, and this project already has one
 * canonicalizer that knows it. Its own test caught the duplicate.
 */
function phoneDigitsOnly(value: string): string {
  return value.replace(/\D+/g, "");
}

function maskValue(field: string, raw: string): string {
  if (!raw) return "";
  const digits = phoneDigitsOnly(raw);
  // A phone is recognised by its last four digits everywhere else in this
  // product; a name by its first letter is enough to tell two leads apart.
  if (digits.length >= 7) return `…${digits.slice(-4)}`;
  if (field.includes("phone") || field.includes("whatsapp")) return "…";
  return `${raw.slice(0, 1)}…`;
}

/**
 * Values are compared normalized, never raw.
 *
 * A lead's stage exists in two spellings in this database — the canonical
 * English key and the legacy Russian label — and both are readable. Comparing
 * raw strings would fill the timeline with stage changes that never happened,
 * every time a row is touched by a newer code path than the one that wrote it.
 */
function normalizeForCompare(field: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = readString(value);
  if (!text) return "";
  if (field.includes("phone") || field.includes("whatsapp")) return normalizePhone(text);
  return text.toLowerCase();
}

export type ChangeEntry = { field: string; label: string; from: string | null; to: string | null };

/**
 * One save becomes one journal row carrying the list of fields that actually
 * moved — not one row per field. The distinction is the whole difference
 * between a timeline an operator reads and a wall they scroll past.
 */
export function diffForJournal(
  entity: ChangeEntityType,
  before: JsonRecord,
  after: JsonRecord,
): ChangeEntry[] {
  const policy = ENTITY_POLICY[entity];
  const entries: ChangeEntry[] = [];

  for (const [field, rule] of Object.entries(policy.fields)) {
    // A field the patch did not carry is not a change, even to empty.
    if (!(field in after)) continue;

    const from = normalizeForCompare(field, before[field]);
    const to = normalizeForCompare(field, after[field]);
    if (from === to) continue;

    if (rule.sensitivity === "fact") {
      entries.push({ field, label: rule.label, from: null, to: null });
      continue;
    }
    if (rule.sensitivity === "masked") {
      entries.push({
        field,
        label: rule.label,
        from: maskValue(field, readString(before[field])) || null,
        to: maskValue(field, readString(after[field])) || null,
      });
      continue;
    }
    entries.push({
      field,
      label: rule.label,
      from: readString(before[field]) || (before[field] == null ? null : String(before[field])),
      to: readString(after[field]) || (after[field] == null ? null : String(after[field])),
    });
  }

  return entries;
}

/**
 * Read the row as it stands, so the journal can say what it was.
 *
 * There is no transaction here and there cannot be one: every Supabase call in
 * this project is an independent PostgREST request. That is acceptable for a
 * journal — a concurrent edit between this read and the update would attribute
 * one field to the wrong previous value, and the alternative (a database
 * trigger) would move the journal out of reach of the handler-level tests that
 * are this project's actual safety net. The trade is stated rather than hidden.
 */
export async function readRowBeforeChange(
  supabase: SupabaseServerClient,
  table: string,
  workspaceId: string,
  id: string,
): Promise<JsonRecord> {
  const { data, error } = await supabase
    .from(table)
    .select("*")
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) return {};
  return asRecord(data);
}

type RecordChangeInput = {
  supabase: SupabaseServerClient;
  workspaceId: string;
  entity: ChangeEntityType;
  entityId: string;
  action: "created" | "updated" | "overbooked";
  changes: ChangeEntry[];
  actorName: string;
  actorRole: string;
  actorStaffUserId: string;
  actorKind: ChangeActorKind;
};

/**
 * Write one journal row.
 *
 * Never throws. A journal that can fail a save is worse than no journal: the
 * operator would lose real work because a secondary write hiccuped. This
 * follows the precedent already in this file's neighbour — insertMetaAuditLog
 * warns and returns — and it is what keeps test:failure-honesty meaningful,
 * because a 502 then still means the record itself was refused.
 */
export async function recordCrmChange(input: RecordChangeInput): Promise<void> {
  // Nothing moved: a save that changed nothing is not an event.
  if (input.action === "updated" && input.changes.length === 0) return;

  try {
    const { error } = await input.supabase.from("audit_logs").insert({
      workspace_id: input.workspaceId,
      actor_name: input.actorName || null,
      actor_role: input.actorRole || null,
      actor_staff_user_id: isUuid(input.actorStaffUserId) ? input.actorStaffUserId : null,
      actor_kind: input.actorKind,
      action: input.action,
      entity_type: input.entity,
      entity_id: input.entityId,
      metadata: { changes: input.changes },
    });
    if (error) throw new Error(error.message);
  } catch (error) {
    // The message can name a table or a constraint, so it goes to the operator
    // log and never into a response.
    console.warn("audit_logs: change journal write failed", error instanceof Error ? error.message : error);
  }
}


export const CHANGE_JOURNAL_INTERNALS = { ENTITY_POLICY, maskValue, normalizeForCompare } as const;

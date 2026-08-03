import type { getSupabaseServerClient } from "../supabase/server";
import { normalizePhone } from "./phone";

// The provider-independent half of "an inbound WhatsApp message becomes a
// lead": ledger → tenant lookup → phone dedup → funnel taxonomy → lead →
// ledger write. Extracted verbatim from the Wazzup handler when the Cloud API
// adapter arrived (§14: адаптер, не форк) — the adapters own transport,
// authentication and payload parsing; everything after "here is an inbound
// message on channel X" lives here, once.
//
// Tenancy: the payload never says which workspace anything belongs to and is
// never trusted to. The provider's channel row is the only authority; an
// unknown or disabled channel is counted as ignored so the adapter can answer
// 200 without disclosure.
//
// Ordering is load-bearing and pinned by the adapter suites:
//   1. Ledger replay check first — a message already in the ledger already
//      produced whatever it was going to; providers retry until they see 200.
//   2. Ledger write LAST — any failure before it answers 503 and the provider
//      retries into a clean slate. A unique violation on the write itself is
//      a concurrent duplicate delivery: the phone dedup already kept the lead
//      single, so the loss is only a double count, never a double lead.
//
// Personal data: phones, names and message texts are patient data. They go to
// the database and nowhere else — thrown errors carry scope only, and the
// adapters keep them out of their logs.

type JsonRecord = Record<string, unknown>;

const NOTES_LIMIT = 1000;

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonRecord;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type SupabaseServerClient = NonNullable<ReturnType<typeof getSupabaseServerClient>>;

/**
 * Where a provider keeps its tenancy and its idempotency. Both ledgers share
 * one shape (message_id unique, channel_id = the provider's channel key,
 * workspace_id, lead_id, kind), so the core never branches on the provider.
 */
export type InboundProviderTables = {
  /** Tenant authority: rows mapping a provider channel key to a workspace. */
  channelTable: "wazzup_channels" | "whatsapp_cloud_numbers";
  /** The column in channelTable holding the provider's channel key. */
  channelKeyColumn: "channel_id" | "phone_number_id";
  /** Idempotency ledger keyed by the provider's message id. */
  ledgerTable: "wazzup_inbound_messages" | "whatsapp_cloud_inbound_messages";
};

/** One inbound message, already parsed and authenticated by the adapter. */
export type InboundWhatsAppMessage = {
  /** The provider's channel key: Wazzup channelId or Cloud API phone_number_id. */
  channelKey: string;
  /** The provider's globally unique message id. */
  messageId: string;
  /** Sender phone in canonical form (normalizePhone already applied). */
  phone: string;
  contactName: string;
  text: string;
};

export type InboundProcessingCounts = { created: number; repeats: number; ignored: number };

type LeadTaxonomy = { stageId: string | null; sourceId: string | null };

/**
 * The funnel taxonomy introduced in 019: besides the legacy `source` text a
 * lead carries `stage_id` and `source_id`. A lead created in the interface
 * gets both because the form sends them — a lead filed by this pipeline got
 * neither at first, so it sat outside every stage-keyed view and outside
 * source analytics, while the `whatsapp` row seeded in `lead_sources` went
 * unused.
 *
 * Resolution mirrors the backfill 019 already performs for existing rows: the
 * first stage of the `new` semantic group, and the source keyed `whatsapp`.
 * Both are workspace-scoped, and both are optional — a clinic that reshaped
 * its funnel simply gets a lead without them. A failed lookup is treated as
 * "not found" rather than thrown for the same reason: losing a classification
 * field must not turn a working pipeline into a retry loop, and the message
 * itself is the thing worth keeping.
 */
async function resolveLeadTaxonomy(
  supabase: SupabaseServerClient,
  workspaceId: string,
): Promise<LeadTaxonomy> {
  const stage = await supabase
    .from("lead_stages")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("semantic_group", "new")
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle();

  const source = await supabase
    .from("lead_sources")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("source_key", "whatsapp")
    .maybeSingle();

  return {
    stageId: stage.error ? null : readString(asRecord(stage.data).id) || null,
    sourceId: source.error ? null : readString(asRecord(source.data).id) || null,
  };
}

/** Postgres "column does not exist" — the one error the fallback answers to. */
const UNDEFINED_COLUMN = "42703";

function isMissingColumn(error: { code?: unknown; message?: unknown } | null): boolean {
  if (!error) return false;
  if (readString(error.code) === UNDEFINED_COLUMN) return true;
  const message = readString(error.message).toLowerCase();
  return message.includes("phone_normalized") && message.includes("does not exist");
}

/**
 * The open lead this phone already has in this workspace, or nothing.
 *
 * Preferred path: an equality match on `leads.phone_normalized`, the stored
 * generated column migration 028 adds, backed by a partial index. Exact, and
 * it does not care how many leads the clinic has.
 *
 * Fallback path: read up to 1000 open leads and compare canonical forms in
 * code. That was the only implementation until 028, and it is a dedup rule
 * only while a workspace stays under a thousand open leads — past that,
 * PostgREST returns an arbitrary window, the existing lead can fall outside
 * it, and a duplicate is filed. It survives here for exactly one reason: a
 * deployment reaches production before its migration is applied by hand, and
 * a hard dependency would answer 503 to every inbound message in that gap —
 * on a live channel that means a retry loop and lost patients. The fallback
 * is entered only on "column does not exist", never on a real database
 * failure, and it disappears from use the moment 028 lands.
 */
async function findOpenLeadByPhone(
  supabase: SupabaseServerClient,
  workspaceId: string,
  phone: string,
): Promise<JsonRecord | undefined> {
  const indexed = await supabase
    .from("leads")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("phone_normalized", phone)
    .neq("status", "lost")
    .limit(1);

  if (!indexed.error) {
    const rows = Array.isArray(indexed.data) ? indexed.data : [];
    return rows.length > 0 ? asRecord(rows[0]) : undefined;
  }

  if (!isMissingColumn(indexed.error)) {
    throw new Error(`lead lookup: ${indexed.error.message}`);
  }

  const { data: candidates, error: candidatesError } = await supabase
    .from("leads")
    .select("id, phone")
    .eq("workspace_id", workspaceId)
    .neq("status", "lost")
    .not("phone", "is", null)
    .limit(1000);
  if (candidatesError) throw new Error(`lead lookup: ${candidatesError.message}`);

  return (Array.isArray(candidates) ? candidates : [])
    .map((row) => asRecord(row))
    .find((row) => normalizePhone(readString(row.phone)) === phone);
}

/**
 * Files each authenticated inbound message: a lead in the channel's workspace,
 * or a recorded repeat, or a counted ignore. Throws on database failure — the
 * adapter answers 503 and the provider retries.
 */
export async function processInboundWhatsAppMessages(
  supabase: SupabaseServerClient,
  tables: InboundProviderTables,
  inbound: InboundWhatsAppMessage[],
): Promise<InboundProcessingCounts> {
  let created = 0;
  let repeats = 0;
  let ignored = 0;
  // One resolution per workspace per batch, not per message.
  const taxonomyByWorkspace = new Map<string, LeadTaxonomy>();

  for (const message of inbound) {
    // Replays first: the provider retries until it sees 200, and a message
    // that is already in the ledger has already produced whatever it was
    // going to.
    const { data: seen, error: seenError } = await supabase
      .from(tables.ledgerTable)
      .select("id")
      .eq("message_id", message.messageId)
      .maybeSingle();
    if (seenError) throw new Error(`ledger lookup: ${seenError.message}`);
    if (seen) {
      ignored += 1;
      continue;
    }

    // The channel row is the tenant authority. Unknown or disabled channels
    // are acknowledged and ignored — not an error, and not information.
    const { data: channel, error: channelError } = await supabase
      .from(tables.channelTable)
      .select("workspace_id, enabled")
      .eq(tables.channelKeyColumn, message.channelKey)
      .maybeSingle();
    if (channelError) throw new Error(`channel lookup: ${channelError.message}`);
    const workspaceId = readString(asRecord(channel).workspace_id);
    if (!workspaceId || asRecord(channel).enabled !== true) {
      ignored += 1;
      continue;
    }

    // W3 default: an open lead (anything but 'lost') with the same phone in
    // the same workspace is a repeat contact, not a new lead.
    const existing = await findOpenLeadByPhone(supabase, workspaceId, message.phone);

    let leadId = readString(asRecord(existing).id);
    let kind: "created" | "repeat" = "repeat";

    if (!existing) {
      let taxonomy = taxonomyByWorkspace.get(workspaceId);
      if (!taxonomy) {
        taxonomy = await resolveLeadTaxonomy(supabase, workspaceId);
        taxonomyByWorkspace.set(workspaceId, taxonomy);
      }

      const { data: lead, error: leadError } = await supabase
        .from("leads")
        .insert({
          workspace_id: workspaceId,
          full_name: message.contactName || message.phone,
          phone: message.phone,
          source: "whatsapp",
          status: "new",
          ...(taxonomy.stageId ? { stage_id: taxonomy.stageId } : {}),
          ...(taxonomy.sourceId ? { source_id: taxonomy.sourceId } : {}),
          notes: message.text ? `WhatsApp: ${message.text.slice(0, NOTES_LIMIT)}` : null,
        })
        .select("id")
        .single();
      if (leadError) throw new Error(`lead insert: ${leadError.message}`);
      leadId = readString(asRecord(lead).id);
      kind = "created";
    }

    // Ledger last: if anything above failed we answered 503 and the provider
    // will retry into a clean slate. A unique violation here means a
    // concurrent duplicate delivery — the phone dedup above already kept the
    // lead single, so the loss is only a double count, never a double lead.
    const { error: ledgerError } = await supabase.from(tables.ledgerTable).insert({
      message_id: message.messageId,
      channel_id: message.channelKey,
      workspace_id: workspaceId,
      lead_id: leadId || null,
      kind,
    });
    if (ledgerError) {
      const text = ledgerError.message || "";
      if (!text.includes("duplicate") && !text.includes("23505")) {
        throw new Error(`ledger insert: ${ledgerError.message}`);
      }
    }

    if (kind === "created") created += 1;
    else repeats += 1;
  }

  return { created, repeats, ignored };
}

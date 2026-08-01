import { createHash, timingSafeEqual } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseServerClient } from "../supabase/server";
import { normalizePhone } from "../crm/phone";

// Wazzup inbound webhook, phase 1: an inbound WhatsApp message becomes a lead
// in the workspace that owns the channel.
//
// Contract, taken from the official docs (wazzup24.com/help/api-en/webhooks/),
// not from memory:
//   - Wazzup POSTs JSON to the configured webhooksUri; the URI may carry a
//     query string. An Authorization: Bearer header is only sent when Wazzup
//     has a crmKey, so the shared secret in the URI is the reliable channel.
//   - On subscription it sends { "test": true } and requires 200.
//   - Messages arrive as { messages: [...] } with messageId, channelId,
//     chatType ("whatsapp"), chatId (digits, the phone), status ("inbound"),
//     isEcho (true for outgoing), text, contact { name }.
//   - Anything but 200 is retried, so a replay must be a no-op and a database
//     outage must answer 503, not 200.
//
// Tenancy: the payload says nothing about workspaces and is never trusted to.
// The wazzup_channels row for channelId is the only authority; an unknown or
// disabled channel is acknowledged with 200 and ignored, so a caller probing
// the endpoint learns nothing about which channels exist.
//
// Personal data: phones, names and message texts are patient data. They go to
// the database and nowhere else — log lines carry scopes and counts only.

type JsonRecord = Record<string, unknown>;

const NOTES_LIMIT = 1000;

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonRecord;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sendJson(res: VercelResponse, status: number, payload: unknown) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json(payload);
}

/**
 * Constant-time comparison that cannot throw on length mismatch: both sides
 * are hashed to a fixed width first. An empty side never matches.
 */
export function wazzupSecretMatches(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * The secret may arrive as `Authorization: Bearer <secret>` (Wazzup adds the
 * header when it has a crmKey) or as the `secret` query parameter (the docs
 * explicitly allow a query string in webhooksUri, and it is the only channel
 * the plain webhook subscription can carry). A path segment would have needed
 * a dynamic route entry in vercel.json, which is a protected file.
 *
 * Both are returned, and the caller accepts a match on either. Preferring the
 * header and stopping there was a trap: Wazzup sends `Authorization: Bearer
 * <crmKey>` whenever the account has a crmKey at all, and that value is not
 * our secret. A request whose URL secret was perfectly correct would then be
 * answered 401 — forever, because Wazzup retries a non-200 and every retry
 * carries the same header. The endpoint would look configured and file no
 * leads. Checking both weakens nothing: each candidate is still compared in
 * constant time against the one expected value.
 */
function readProvidedSecrets(req: VercelRequest): string[] {
  const header = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";

  const fromQuery = req.query?.secret;
  const query = readString(Array.isArray(fromQuery) ? fromQuery[0] : fromQuery);

  return [bearer, query].filter((candidate) => candidate.length > 0);
}

type InboundMessage = {
  messageId: string;
  channelId: string;
  phone: string;
  contactName: string;
  text: string;
};

/** Inbound WhatsApp messages only; everything else in the batch is ignored. */
function readInboundMessages(body: JsonRecord): InboundMessage[] {
  const raw = Array.isArray(body.messages) ? body.messages : [];
  const inbound: InboundMessage[] = [];

  for (const entry of raw) {
    const message = asRecord(entry);
    if (readString(message.chatType) !== "whatsapp") continue;
    if (readString(message.status) !== "inbound") continue;
    if (message.isEcho === true || message.isDeleted === true) continue;

    const messageId = readString(message.messageId);
    const channelId = readString(message.channelId);
    const phone = normalizePhone(readString(message.chatId));
    if (!messageId || !channelId || !phone) continue;

    inbound.push({
      messageId,
      channelId,
      phone,
      contactName: readString(asRecord(message.contact).name),
      text: readString(message.text),
    });
  }

  return inbound;
}

export async function handleWazzupWebhook(req: VercelRequest, res: VercelResponse) {
  if ((req.method || "GET").toUpperCase() !== "POST") {
    return sendJson(res, 405, { success: false, error: "Method not allowed" });
  }

  const expected = readString(process.env.WAZZUP_WEBHOOK_SECRET);
  if (!expected) {
    // Not configured is fail-closed, and 503 keeps Wazzup retrying instead of
    // dropping the message on the floor while the operator fixes the env.
    return sendJson(res, 503, { success: false, error: "Webhook is not configured" });
  }

  const provided = readProvidedSecrets(req);
  if (!provided.some((candidate) => wazzupSecretMatches(candidate, expected))) {
    return sendJson(res, 401, { success: false, error: "Unauthorized" });
  }

  const body = asRecord(req.body);

  // Subscription validation: Wazzup sends { test: true } and requires 200.
  if (body.test === true) {
    return sendJson(res, 200, { success: true });
  }

  const inbound = readInboundMessages(body);
  if (inbound.length === 0) {
    return sendJson(res, 200, { success: true, created: 0, repeats: 0, ignored: 0 });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return sendJson(res, 503, { success: false, error: "Service unavailable" });
  }

  let created = 0;
  let repeats = 0;
  let ignored = 0;

  try {
    for (const message of inbound) {
      // Replays first: Wazzup retries until it sees 200, and a message that is
      // already in the ledger has already produced whatever it was going to.
      const { data: seen, error: seenError } = await supabase
        .from("wazzup_inbound_messages")
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
        .from("wazzup_channels")
        .select("workspace_id, enabled")
        .eq("channel_id", message.channelId)
        .maybeSingle();
      if (channelError) throw new Error(`channel lookup: ${channelError.message}`);
      const workspaceId = readString(asRecord(channel).workspace_id);
      if (!workspaceId || asRecord(channel).enabled !== true) {
        ignored += 1;
        continue;
      }

      // W3 default: an open lead (anything but 'lost') with the same phone in
      // the same workspace is a repeat contact, not a new lead. Stored phones
      // arrive in every spelling operators type, so the comparison happens on
      // the canonical form in code rather than on raw strings in SQL.
      const { data: candidates, error: candidatesError } = await supabase
        .from("leads")
        .select("id, phone")
        .eq("workspace_id", workspaceId)
        .neq("status", "lost")
        .not("phone", "is", null)
        .limit(1000);
      if (candidatesError) throw new Error(`lead lookup: ${candidatesError.message}`);

      const existing = (Array.isArray(candidates) ? candidates : [])
        .map((row) => asRecord(row))
        .find((row) => normalizePhone(readString(row.phone)) === message.phone);

      let leadId = readString(asRecord(existing).id);
      let kind: "created" | "repeat" = "repeat";

      if (!existing) {
        const { data: lead, error: leadError } = await supabase
          .from("leads")
          .insert({
            workspace_id: workspaceId,
            full_name: message.contactName || message.phone,
            phone: message.phone,
            source: "whatsapp",
            status: "new",
            notes: message.text ? `WhatsApp: ${message.text.slice(0, NOTES_LIMIT)}` : null,
          })
          .select("id")
          .single();
        if (leadError) throw new Error(`lead insert: ${leadError.message}`);
        leadId = readString(asRecord(lead).id);
        kind = "created";
      }

      // Ledger last: if anything above failed we answered 503 and Wazzup will
      // retry into a clean slate. A unique violation here means a concurrent
      // duplicate delivery — the phone dedup above already kept the lead
      // single, so the loss is only a double count, never a double lead.
      const { error: ledgerError } = await supabase.from("wazzup_inbound_messages").insert({
        message_id: message.messageId,
        channel_id: message.channelId,
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
  } catch (error) {
    // Scope only — never the payload: phones, names and texts are patient
    // data and must not reach the logs.
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[wazzup] webhook processing failed: ${detail}`);
    return sendJson(res, 503, { success: false, error: "Service unavailable" });
  }

  return sendJson(res, 200, { success: true, created, repeats, ignored });
}

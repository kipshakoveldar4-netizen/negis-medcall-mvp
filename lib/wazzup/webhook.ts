import { createHash, timingSafeEqual } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseServerClient } from "../supabase/server";
import { normalizePhone } from "../crm/phone";
import {
  processInboundWhatsAppMessages,
  type InboundProviderTables,
  type InboundWhatsAppMessage,
} from "../crm/inbound-whatsapp";

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
// This file is the Wazzup adapter only: transport, secret, payload parsing.
// Everything after "here is an inbound message on channel X" — tenancy from
// wazzup_channels, the idempotency ledger, phone dedup, funnel taxonomy, the
// lead itself — lives in lib/crm/inbound-whatsapp.ts, shared verbatim with
// the WhatsApp Cloud API adapter (§14: адаптер, не форк).
//
// Personal data: phones, names and message texts are patient data. They go to
// the database and nowhere else — log lines carry scopes and counts only.

type JsonRecord = Record<string, unknown>;

const WAZZUP_TABLES: InboundProviderTables = {
  channelTable: "wazzup_channels",
  channelKeyColumn: "channel_id",
  ledgerTable: "wazzup_inbound_messages",
};

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

/** Inbound WhatsApp messages only; everything else in the batch is ignored. */
function readInboundMessages(body: JsonRecord): InboundWhatsAppMessage[] {
  const raw = Array.isArray(body.messages) ? body.messages : [];
  const inbound: InboundWhatsAppMessage[] = [];

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
      channelKey: channelId,
      messageId,
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

  try {
    const counts = await processInboundWhatsAppMessages(supabase, WAZZUP_TABLES, inbound);
    return sendJson(res, 200, { success: true, ...counts });
  } catch (error) {
    // Scope only — never the payload: phones, names and texts are patient
    // data and must not reach the logs.
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[wazzup] webhook processing failed: ${detail}`);
    return sendJson(res, 503, { success: false, error: "Service unavailable" });
  }
}

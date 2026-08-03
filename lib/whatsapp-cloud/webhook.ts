import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseServerClient } from "../supabase/server";
import { normalizePhone } from "../crm/phone";
import {
  processInboundWhatsAppMessages,
  type InboundProviderTables,
  type InboundWhatsAppMessage,
} from "../crm/inbound-whatsapp";

// WhatsApp Cloud API inbound webhook, phase 2 (§14): the same pipeline as the
// Wazzup adapter — an inbound message becomes a lead in the workspace that
// owns the number — fed by Meta's official Cloud API, no intermediary.
//
// Contract, taken from the Meta webhooks documentation
// (developers.facebook.com/docs/graph-api/webhooks/getting-started and
// /docs/whatsapp/cloud-api/webhooks/payload-examples), not from memory:
//   - Subscription is verified by a GET carrying hub.mode="subscribe",
//     hub.verify_token and hub.challenge; the server must echo hub.challenge
//     back — and only when the verify token matches.
//   - Every event POST is signed: X-Hub-Signature-256 = "sha256=" + hex
//     HMAC-SHA256 of the RAW request body keyed with the App Secret. The
//     signature is over the exact bytes, so verification happens before any
//     JSON parsing, on the raw buffer the entry point captured.
//   - Payload: { object: "whatsapp_business_account", entry: [ { changes: [
//     { field: "messages", value: { messaging_product: "whatsapp",
//     metadata: { phone_number_id }, contacts: [ { wa_id, profile: { name } } ],
//     messages: [ { from, id, timestamp, type, text: { body } } ] } } ] } ] }.
//     Delivery/read receipts arrive in the same shape with a statuses array
//     instead of messages — acknowledged and ignored.
//   - Anything but 200 is retried with backoff, so a replay must be a no-op
//     and a database outage must answer 503, not 200.
//
// This file is the Cloud API adapter only: transport, verify handshake,
// signature, payload parsing. Everything after "here is an inbound message on
// number X" — tenancy from whatsapp_cloud_numbers, the idempotency ledger,
// phone dedup, funnel taxonomy, the lead itself — lives in
// lib/crm/inbound-whatsapp.ts, shared verbatim with the Wazzup adapter.
//
// Tenancy: metadata.phone_number_id is matched against whatsapp_cloud_numbers
// (migration 027); the payload is never trusted about workspaces, and an
// unknown or disabled number is acknowledged with 200 and ignored, so a
// caller probing the endpoint learns nothing about which numbers exist.
//
// Personal data: phones, names and message texts are patient data. They go to
// the database and nowhere else — log lines carry scopes and counts only.

type JsonRecord = Record<string, unknown>;

const CLOUD_TABLES: InboundProviderTables = {
  channelTable: "whatsapp_cloud_numbers",
  channelKeyColumn: "phone_number_id",
  ledgerTable: "whatsapp_cloud_inbound_messages",
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

function firstQueryValue(value: string | string[] | undefined): string {
  return readString(Array.isArray(value) ? value[0] : value);
}

/**
 * Constant-time comparison that cannot throw on length mismatch: both sides
 * are hashed to a fixed width first. An empty side never matches.
 */
function secretMatches(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * X-Hub-Signature-256 over the raw body. The expected value is computed from
 * the exact bytes received — never from re-serialized JSON — and compared in
 * constant time. A missing header, a malformed header and a wrong signature
 * are all the same generic 401 to the caller.
 */
export function cloudSignatureMatches(rawBody: Buffer, header: string, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  return secretMatches(header.trim(), expected);
}

/**
 * Inbound messages only. Statuses (delivery/read receipts), non-message
 * fields and anything not addressed to a known messaging product are left in
 * place — the caller acknowledges them without processing.
 */
function readInboundMessages(body: JsonRecord): InboundWhatsAppMessage[] {
  const inbound: InboundWhatsAppMessage[] = [];
  const entries = Array.isArray(body.entry) ? body.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(asRecord(entry).changes) ? (asRecord(entry).changes as unknown[]) : [];
    for (const change of changes) {
      const changeRecord = asRecord(change);
      if (readString(changeRecord.field) !== "messages") continue;

      const value = asRecord(changeRecord.value);
      if (readString(value.messaging_product) !== "whatsapp") continue;

      const phoneNumberId = readString(asRecord(value.metadata).phone_number_id);
      if (!phoneNumberId) continue;

      const contacts = (Array.isArray(value.contacts) ? value.contacts : []).map(asRecord);
      const nameByWaId = new Map<string, string>();
      for (const contact of contacts) {
        const waId = readString(contact.wa_id);
        const name = readString(asRecord(contact.profile).name);
        if (waId && name) nameByWaId.set(waId, name);
      }

      const messages = Array.isArray(value.messages) ? value.messages : [];
      for (const rawMessage of messages) {
        const message = asRecord(rawMessage);
        const messageId = readString(message.id);
        const from = readString(message.from);
        const phone = normalizePhone(from);
        if (!messageId || !phone) continue;

        // Only text bodies become notes; a voice note or an image still files
        // the lead — the contact and the intent are the value, not the media.
        const text = readString(message.type) === "text" ? readString(asRecord(message.text).body) : "";

        inbound.push({
          channelKey: phoneNumberId,
          messageId,
          phone,
          contactName: nameByWaId.get(from) || "",
          text,
        });
      }
    }
  }

  return inbound;
}

/**
 * GET half of the contract: Meta's subscription handshake. The challenge is
 * echoed only for hub.mode="subscribe" with the exact configured token; an
 * unconfigured endpoint fails closed with 503 so a mis-deploy is visible in
 * the App Dashboard instead of silently confirming subscriptions.
 */
function handleVerification(req: VercelRequest, res: VercelResponse) {
  const expected = readString(process.env.WHATSAPP_VERIFY_TOKEN);
  if (!expected) {
    return sendJson(res, 503, { success: false, error: "Webhook is not configured" });
  }

  const mode = firstQueryValue(req.query?.["hub.mode"] as string | string[] | undefined);
  const token = firstQueryValue(req.query?.["hub.verify_token"] as string | string[] | undefined);
  const challenge = firstQueryValue(req.query?.["hub.challenge"] as string | string[] | undefined);

  if (mode !== "subscribe" || !secretMatches(token, expected) || !challenge) {
    return sendJson(res, 403, { success: false, error: "Forbidden" });
  }

  res.status(200).setHeader("Content-Type", "text/plain; charset=utf-8");
  return res.send(challenge);
}

export async function handleWhatsAppCloudWebhook(
  req: VercelRequest,
  res: VercelResponse,
  rawBody: Buffer,
) {
  const method = (req.method || "GET").toUpperCase();

  if (method === "GET") {
    return handleVerification(req, res);
  }

  if (method !== "POST") {
    return sendJson(res, 405, { success: false, error: "Method not allowed" });
  }

  const appSecret = readString(process.env.WHATSAPP_APP_SECRET);
  if (!appSecret) {
    // Fail-closed, and 503 keeps Meta retrying instead of dropping the
    // message on the floor while the operator fixes the env.
    return sendJson(res, 503, { success: false, error: "Webhook is not configured" });
  }

  const signatureHeader = readString(
    Array.isArray(req.headers["x-hub-signature-256"])
      ? req.headers["x-hub-signature-256"][0]
      : req.headers["x-hub-signature-256"],
  );
  if (!cloudSignatureMatches(rawBody, signatureHeader, appSecret)) {
    return sendJson(res, 401, { success: false, error: "Unauthorized" });
  }

  // Parse only after the signature proved the bytes are Meta's.
  let body: JsonRecord;
  try {
    body = asRecord(JSON.parse(rawBody.toString("utf8")));
  } catch {
    return sendJson(res, 400, { success: false, error: "Invalid payload" });
  }

  const inbound = readInboundMessages(body);
  if (inbound.length === 0) {
    // Statuses, unknown fields, empty batches: acknowledged so Meta stops
    // retrying — there is nothing to do and nothing to disclose.
    return sendJson(res, 200, { success: true, created: 0, repeats: 0, ignored: 0 });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return sendJson(res, 503, { success: false, error: "Service unavailable" });
  }

  try {
    const counts = await processInboundWhatsAppMessages(supabase, CLOUD_TABLES, inbound);
    return sendJson(res, 200, { success: true, ...counts });
  } catch (error) {
    // Scope only — never the payload: phones, names and texts are patient
    // data and must not reach the logs.
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[whatsapp-cloud] webhook processing failed: ${detail}`);
    return sendJson(res, 503, { success: false, error: "Service unavailable" });
  }
}

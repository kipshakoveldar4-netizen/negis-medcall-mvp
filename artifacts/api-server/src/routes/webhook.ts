import { Router, type Request } from "express";
import { supabaseAdmin } from "../lib/supabase-admin.js";

type Pipeline = "sales" | "booking";
type AnyRecord = Record<string, unknown>;

interface IncomingLead {
  fullName: string | null;
  phone: string;
  source: string;
  comment: string | null;
  pipeline: Pipeline;
  externalId?: string | null;
}

const router = Router();

const PHONE_KEYS = new Set([
  "phone",
  "phone_number",
  "phoneNumber",
  "mobile",
  "whatsapp",
  "contact_phone",
  "customer_phone",
  "client_phone",
  "lead_phone",
]);

const NAME_KEYS = new Set([
  "full_name",
  "fullName",
  "name",
  "contact_name",
  "customer_name",
  "client_name",
  "lead_name",
]);

const SOURCE_KEYS = new Set(["source", "platform", "utm_source", "channel", "channelType"]);
const COMMENT_KEYS = new Set(["comment", "comments", "message", "text", "body", "note", "notes"]);

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const text = textValue(value);
    if (text) return text;
  }
  return null;
}

function normalizePhone(value: unknown): string | null {
  const text = textValue(value);
  if (!text) return null;
  const digits = text.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function findByKeys(value: unknown, keys: Set<string>, depth = 0): string | null {
  if (depth > 5 || value == null) return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findByKeys(item, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (!isRecord(value)) return null;

  for (const [key, nested] of Object.entries(value)) {
    if (keys.has(key)) {
      const found = textValue(nested);
      if (found) return found;
    }
  }

  for (const nested of Object.values(value)) {
    const found = findByKeys(nested, keys, depth + 1);
    if (found) return found;
  }

  return null;
}

function getAuthSecret(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();

  const headerSecret = req.headers["x-webhook-secret"];
  if (typeof headerSecret === "string") return headerSecret;
  if (Array.isArray(headerSecret)) return headerSecret[0] ?? null;

  return firstText(req.query.secret, req.query.webhook_secret, req.query.crmKey);
}

function getPipeline(req: Request): Pipeline {
  return req.query.pipeline === "booking" ? "booking" : "sales";
}

function formatSource(value: string | null): string {
  if (!value) return "Webhook";
  const lower = value.toLowerCase();
  if (lower.includes("instagram") || lower === "ig") return "Instagram";
  if (lower.includes("tiktok") || lower === "tt") return "TikTok";
  if (lower.includes("whatsapp") || lower.includes("wazzup")) return "WhatsApp";
  if (lower.includes("pancake")) return "Pancake";
  return value.slice(0, 80);
}

function extractWazzupLeads(body: unknown, req: Request): IncomingLead[] {
  if (!isRecord(body) || !Array.isArray(body.messages)) return [];

  const pipeline = getPipeline(req);
  const querySource = textValue(req.query.source);

  return body.messages
    .filter(isRecord)
    .filter((message) => {
      const status = textValue(message.status);
      const isEcho = message.isEcho === true;
      const isDeleted = message.isDeleted === true;
      return !isEcho && !isDeleted && (!status || status === "inbound");
    })
    .map((message): IncomingLead | null => {
      const contact = isRecord(message.contact) ? message.contact : {};
      const chatType = textValue(message.chatType);
      const phone = normalizePhone(contact.phone) ?? normalizePhone(message.chatId);
      if (!phone) return null;

      const fullName = firstText(contact.name, contact.username, message.authorName);
      const source = formatSource(querySource ?? chatType ?? "Wazzup24");
      const messageText = firstText(message.text, message.contentUri);
      const comment = messageText ? `Wazzup24: ${messageText}` : "Wazzup24 inbound message";

      return {
        fullName: fullName && normalizePhone(fullName) === phone ? null : fullName,
        phone,
        source,
        comment,
        pipeline,
        externalId: textValue(message.messageId),
      };
    })
    .filter((lead): lead is IncomingLead => lead !== null);
}

function extractGenericLeads(body: unknown, req: Request): IncomingLead[] {
  const items = Array.isArray(body) ? body : [body];
  const pipeline = getPipeline(req);
  const querySource = textValue(req.query.source);

  return items
    .map((item): IncomingLead | null => {
      if (!isRecord(item)) return null;

      const phone = normalizePhone(findByKeys(item, PHONE_KEYS));
      if (!phone) return null;

      const firstName = findByKeys(item, new Set(["first_name", "firstName"]));
      const lastName = findByKeys(item, new Set(["last_name", "lastName"]));
      const fullName = firstText(
        findByKeys(item, NAME_KEYS),
        [firstName, lastName].filter(Boolean).join(" "),
      );
      const source = formatSource(querySource ?? findByKeys(item, SOURCE_KEYS) ?? "Webhook");
      const comment = firstText(findByKeys(item, COMMENT_KEYS), "Incoming webhook lead");
      const externalId = firstText(
        findByKeys(item, new Set(["id", "lead_id", "leadId", "messageId", "message_id"])),
      );

      return { fullName, phone, source, comment, pipeline, externalId };
    })
    .filter((lead): lead is IncomingLead => lead !== null);
}

function extractIncomingLeads(body: unknown, req: Request): IncomingLead[] {
  const wazzupLeads = extractWazzupLeads(body, req);
  if (wazzupLeads.length > 0) return wazzupLeads;
  return extractGenericLeads(body, req);
}

function appendComment(existing: string | null, incoming: string | null, externalId?: string | null): string | null {
  if (!incoming) return existing;
  const marker = externalId ? `[${externalId}]` : null;
  const line = marker ? `${marker} ${incoming}` : incoming;
  if (existing?.includes(line)) return existing;
  return [existing, line].filter(Boolean).join("\n\n").slice(-4000);
}

async function getDefaultStatusId(clinicId: string, pipeline: Pipeline): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("lead_statuses")
    .select("id")
    .eq("clinic_id", clinicId)
    .eq("pipeline", pipeline)
    .order("sort_order")
    .limit(1)
    .maybeSingle();

  return data?.id ?? null;
}

async function upsertLead(clinicId: string, lead: IncomingLead, statusId: string | null) {
  const phoneVariants = Array.from(new Set([lead.phone, `+${lead.phone}`]));
  const { data: existingRows } = await supabaseAdmin
    .from("leads")
    .select("id, comment, source")
    .eq("clinic_id", clinicId)
    .eq("pipeline", lead.pipeline)
    .in("phone", phoneVariants)
    .order("created_at", { ascending: false })
    .limit(1);

  const existing = existingRows?.[0];
  if (existing) {
    const { error } = await supabaseAdmin
      .from("leads")
      .update({
        comment: appendComment(existing.comment as string | null, lead.comment, lead.externalId),
        source: (existing.source as string | null) || lead.source,
      })
      .eq("id", existing.id);

    if (error) throw error;
    return { id: existing.id as string, created: false };
  }

  const { data, error } = await supabaseAdmin
    .from("leads")
    .insert({
      clinic_id: clinicId,
      pipeline: lead.pipeline,
      full_name: lead.fullName || `Клиент ${lead.phone}`,
      phone: lead.phone,
      source: lead.source,
      comment: lead.comment,
      status_id: statusId,
    })
    .select("id")
    .single();

  if (error) throw error;
  return { id: data.id as string, created: true };
}

async function notifyTelegram(clinic: { telegram_chat_id: string | null }, lead: IncomingLead) {
  if (!clinic.telegram_chat_id) return;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;

  const text = [
    "Новый лид",
    `Имя: ${lead.fullName || `Клиент ${lead.phone}`}`,
    `Телефон: ${lead.phone}`,
    `Источник: ${lead.source}`,
  ].join("\n");

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: clinic.telegram_chat_id, text }),
  }).catch(() => {});
}

router.post("/leads/webhook/:clinic_id", async (req, res) => {
  const { clinic_id } = req.params;

  const body = req.body as AnyRecord;
  if (isRecord(body) && body.test === true) {
    res.status(200).json({ ok: true });
    return;
  }

  const { data: clinic, error: clinicErr } = await supabaseAdmin
    .from("clinics")
    .select("id, webhook_secret, telegram_chat_id")
    .eq("id", clinic_id)
    .single();

  if (clinicErr || !clinic) {
    res.status(404).json({ error: "Clinic not found" });
    return;
  }

  const configuredSecret = textValue(clinic.webhook_secret);
  const requestSecret = getAuthSecret(req);
  if (!configuredSecret) {
    res.status(401).json({ error: "Webhook secret is not configured" });
    return;
  }
  if (requestSecret !== configuredSecret) {
    res.status(401).json({ error: "Invalid webhook secret" });
    return;
  }

  const leads = extractIncomingLeads(req.body, req);
  if (leads.length === 0) {
    res.status(200).json({ ok: true, created: 0, updated: 0, skipped: true });
    return;
  }

  try {
    const statusIds = new Map<Pipeline, string | null>();
    let created = 0;
    let updated = 0;
    const ids: string[] = [];

    for (const lead of leads) {
      if (!statusIds.has(lead.pipeline)) {
        statusIds.set(lead.pipeline, await getDefaultStatusId(clinic_id, lead.pipeline));
      }
      const result = await upsertLead(clinic_id, lead, statusIds.get(lead.pipeline) ?? null);
      ids.push(result.id);
      if (result.created) {
        created += 1;
        await notifyTelegram(clinic, lead);
      } else {
        updated += 1;
      }
    }

    res.status(200).json({ ok: true, created, updated, ids });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to process webhook";
    res.status(500).json({ error: message });
  }
});

export default router;

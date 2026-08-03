import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleWhatsAppCloudWebhook } from "../../lib/whatsapp-cloud/webhook";

// Signed inbound webhook: WhatsApp Cloud API message events become CRM leads.
// All logic lives in lib/whatsapp-cloud/webhook.ts where the tests can drive
// it; this file is only the Vercel entry point. Routed by the filesystem
// handler — plain api files are served without a vercel.json entry (verified
// against production: api/webhooks/wazzup.ts answers the same way).
//
// The body parser is off because X-Hub-Signature-256 is an HMAC over the RAW
// request bytes: a parsed-and-reserialized body is not the thing Meta signed.
export const config = {
  api: {
    bodyParser: false,
  },
};

// A message batch is a few kilobytes; anything approaching this limit is not
// a webhook.
const RAW_BODY_LIMIT = 1024 * 1024;

/**
 * The raw bytes the signature was computed over. On Vercel (bodyParser off)
 * they are read from the stream. The dev middleware in vite.config.ts has
 * already consumed the stream and parsed the body — there the JSON is
 * re-serialized, which is fine for the only thing dev exercises: the
 * unauthenticated boundary (503/401), where the exact bytes never matter
 * because no valid signature exists for them anyway.
 */
async function readRawBody(req: VercelRequest): Promise<Buffer> {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body, "utf8");
  if (req.body && typeof req.body === "object") return Buffer.from(JSON.stringify(req.body), "utf8");

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += piece.length;
    if (total > RAW_BODY_LIMIT) {
      throw new Error("payload too large");
    }
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch {
    res.status(413).setHeader("Content-Type", "application/json; charset=utf-8");
    return res.json({ success: false, error: "Payload too large" });
  }
  return handleWhatsAppCloudWebhook(req, res, rawBody);
}

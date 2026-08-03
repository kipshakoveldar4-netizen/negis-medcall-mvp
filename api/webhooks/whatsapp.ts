import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleWhatsAppCloudWebhook } from "../../lib/whatsapp-cloud/webhook";

// Signed inbound webhook: WhatsApp Cloud API message events become CRM leads.
// All logic lives in lib/whatsapp-cloud/webhook.ts where the tests can drive
// it; this file is only the Vercel entry point. Routed by the filesystem
// handler — plain api files are served without a vercel.json entry (verified
// against production: api/webhooks/wazzup.ts answers the same way).
//
// Raw bytes are the whole game here: X-Hub-Signature-256 is an HMAC over the
// exact bytes Meta sent, and a parsed-and-reserialized body is NOT the thing
// Meta signed — JSON.stringify(JSON.parse(x)) re-emits \uXXXX escapes and
// escaped slashes differently, so any Cyrillic payload would fail the check.
// A first version tried `config.api.bodyParser = false`, which is a Next.js
// convention @vercel/node ignores (verified in the pinned runtime: the string
// "bodyParser" does not occur in @vercel/node 5.8.17; helpers are toggled
// only by builder config or NODEJS_HELPERS). The adversarial review caught
// it before it shipped.
//
// What the runtime actually does (dist/dev-server.mjs, addHelpers →
// readBody → restoreBody): it buffers the raw body and then REPLAYS the
// exact bytes through a PassThrough, redirecting req.on("data"/"end") to it,
// and installs req.body as a LAZY getter that parses on first access. So the
// contract of this entry point is:
//   - read the raw bytes with the event API ("data"/"end"), which yields the
//     exact bytes both with helpers (replayed) and without (the live stream);
//   - never touch req.body in production — the lazy parse is not needed, can
//     throw its own ApiError on garbage, and its result is not what was
//     signed anyway.
// The one environment that pre-consumes the stream WITHOUT restoring it is
// our own vite dev middleware, and it assigns req.body as a plain VALUE
// property. A value property (not a getter) is therefore the marker of the
// dev fallback, where re-serialized bytes are acceptable because dev only
// exercises the unauthenticated boundary.

// Meta batches up to 1000 notifications per delivery; with escaped Cyrillic
// that is a few megabytes. 4MB sits above any real batch and below the
// platform's own request cap, so a legitimate signed delivery is never
// answered 413.
const RAW_BODY_LIMIT = 4 * 1024 * 1024;

class PayloadTooLarge extends Error {}

function readRawBodyFromStream(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    req.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += piece.length;
      if (total > RAW_BODY_LIMIT) {
        fail(new PayloadTooLarge());
        return;
      }
      chunks.push(piece);
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", (error: Error) => fail(error));
  });
}

async function readRawBody(req: VercelRequest): Promise<Buffer> {
  // The dev middleware marker: a plain own VALUE property named body. The
  // Vercel helpers define a getter instead, and reading a getter would both
  // trigger the lazy parse and hand back the wrong bytes — so anything that
  // is not a value property goes to the stream.
  const descriptor = Object.getOwnPropertyDescriptor(req, "body");
  if (descriptor && !descriptor.get && descriptor.value !== undefined) {
    const value = descriptor.value as unknown;
    if (Buffer.isBuffer(value)) return value;
    if (typeof value === "string") return Buffer.from(value, "utf8");
    return Buffer.from(JSON.stringify(value), "utf8");
  }

  return readRawBodyFromStream(req);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (error instanceof PayloadTooLarge) {
      res.statusCode = 413;
      return res.end(JSON.stringify({ success: false, error: "Payload too large" }));
    }
    // A broken stream is not Meta's fault and not proof of anything: 503 so
    // the delivery is retried rather than dropped.
    res.statusCode = 503;
    return res.end(JSON.stringify({ success: false, error: "Service unavailable" }));
  }
  return handleWhatsAppCloudWebhook(req, res, rawBody);
}

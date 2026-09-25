import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseServerClient } from "../supabase/server";
import { validateSiteInquiry, type SiteInquiry } from "./site-intake";

type Config = { origin: string; hostname: string; siteKey: string; secret: string };
type VerificationFetch = (url: string, init: {
  method: string; headers: Record<string, string>; body: string; signal: AbortSignal;
}) => Promise<{ ok: boolean; text(): Promise<string> }>;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function readSiteIntakeConfig(env: NodeJS.ProcessEnv): Config | null {
  if (env.MEDINA_SITE_INTAKE_ENABLED !== "true") return null;
  const origin = env.MEDINA_SITE_ORIGIN?.trim() || "";
  const siteKey = env.MEDINA_SITE_INTAKE_KEY?.trim() || "";
  const secret = env.MEDINA_SITE_TURNSTILE_SECRET?.trim() || "";
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin || !secret
      || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(siteKey)) return null;
    return { origin, hostname: url.hostname, siteKey, secret };
  } catch { return null; }
}

export async function verifySiteChallenge(config: Config, token: string,
  request: VerificationFetch = fetch as unknown as VerificationFetch): Promise<boolean> {
  try {
    const response = await request("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: config.secret, response: token }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return false;
    const result = record(JSON.parse(await response.text()));
    return result?.success === true && result.hostname === config.hostname && result.action === "site_inquiry";
  } catch { return false; }
}

async function persist(siteKey: string, requestKey: string, inquiry: SiteInquiry): Promise<string | null> {
  const client = getSupabaseServerClient();
  if (!client) return "unavailable";
  const { data, error } = await client.rpc("accept_crm_site_inquiry", {
    p_site_key: siteKey, p_request_key: requestKey, p_inquiry: inquiry,
  });
  if (error) return error.message === "intake_rate_limited" ? "rate_limited"
    : error.message === "request_conflict" ? "request_conflict" : "unavailable";
  return record(data)?.accepted === true ? null : "unavailable";
}

async function boundedBody(req: VercelRequest): Promise<unknown> {
  const declared = req.headers["content-length"];
  if (typeof declared === "string" && (!/^\d+$/.test(declared) || Number(declared) > 8192)) throw new Error("invalid_body");
  if (req.body !== undefined) {
    const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(raw) > 8192) throw new Error("invalid_body");
    return JSON.parse(raw);
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 8192) throw new Error("invalid_body");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createSiteIntakeHandler(deps: {
  env?: () => NodeJS.ProcessEnv;
  verify?: typeof verifySiteChallenge;
  save?: typeof persist;
  now?: () => number;
} = {}) {
  let windowStart = 0;
  let attempts = 0;
  return async (req: VercelRequest, res: VercelResponse) => {
    res.setHeader("Cache-Control", "no-store");
    const reply = (status: number, code?: string) => res.status(status).json(
      code ? { success: false, code } : { success: true },
    );
    const config = readSiteIntakeConfig((deps.env || (() => process.env))());
    if (!config) return reply(503, "intake_unavailable");
    // Origin is a browser boundary, NOT bot authentication. Turnstile is mandatory below.
    if (req.headers.origin !== config.origin) return reply(403, "origin_denied");
    res.setHeader("Access-Control-Allow-Origin", config.origin);
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      return res.status(204).end();
    }
    if (req.method !== "POST") return reply(405, "method_not_allowed");
    if (typeof req.headers["content-type"] !== "string"
      || !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"])) return reply(415, "invalid_content_type");
    const now = (deps.now || Date.now)();
    if (now - windowStart >= 60000) { windowStart = now; attempts = 0; }
    // Local circuit breaker only; deployment must also configure edge/WAF limits.
    if (++attempts > 60) return reply(429, "rate_limited");
    let body: Record<string, unknown> | null;
    try { body = record(await boundedBody(req)); } catch { return reply(400, "invalid_request"); }
    if (!body || Object.keys(body).some(key => !["requestKey", "inquiry", "challengeToken"].includes(key))) return reply(400, "invalid_request");
    const { requestKey, challengeToken } = body;
    if (typeof requestKey !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey)
      || typeof challengeToken !== "string" || challengeToken.length < 1 || challengeToken.length > 2048) return reply(400, "invalid_request");
    const inquiry = validateSiteInquiry(body.inquiry);
    if (!inquiry.ok) return reply(400, inquiry.code);
    try {
      if (!await (deps.verify || verifySiteChallenge)(config, challengeToken)) return reply(403, "challenge_failed");
      const error = await (deps.save || persist)(config.siteKey, requestKey, inquiry.data);
      if (error === "rate_limited") return reply(429, error);
      if (error === "request_conflict") return reply(409, error);
      if (error) return reply(503, "intake_unavailable");
      return reply(200);
    } catch { return reply(503, "intake_unavailable"); }
  };
}

export const handleSiteIntake = createSiteIntakeHandler();

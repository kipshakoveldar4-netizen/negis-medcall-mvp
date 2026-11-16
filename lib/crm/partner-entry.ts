import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isUuidValue, requireAuthenticatedUser } from "../auth/server";
import { readApplicationOrigin } from "../auth/application-origin";
import { getSupabaseServerClient } from "../supabase/server";
import { resolveSiteConsent, type SiteConsentResolver } from "../site/consent-registry.cjs";
import { resolveSiteConsentReceipt } from "./site-intake-handler";
import { canonicalPartnerCode, newPartnerEntryFrame, partnerCapabilityHash, partnerEntrySetCookie,
  readPartnerEntryCookie, PARTNER_WINDOW_MS, PARTNER_POLICY_VERSION } from "./partner-entry-cookie";

type Row = Record<string, unknown>;
type Config = { origin: string; hostname: string; key: Buffer; secret: string; siteKey: string; consentVersion: string };
type ChallengeReadResult = { done: true; value?: Uint8Array } | { done: false; value: Uint8Array };
type ChallengeReader = {
  read(): Promise<ChallengeReadResult>;
  cancel(): Promise<void> | void;
  releaseLock(): void;
};
type ChallengeBody = { getReader(): ChallengeReader; cancel(): Promise<void> | void };
type ChallengeFetch = (url: string, init: {
  method: string; redirect: string; headers: Record<string, string>; body: string; signal: AbortSignal;
}) => Promise<{ ok: boolean; body: ChallengeBody | null }>;
const record = (v: unknown): Row | null => v && typeof v === "object" && !Array.isArray(v) ? v as Row : null;
const keys = (v: Row, expected: string[]) => Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v, k));
export function partnerEntryConfig(env: NodeJS.ProcessEnv): Config | null {
  if (env.MEDINA_PARTNER_ENTRY_ENABLED !== "true") return null;
  const origin = readApplicationOrigin(env), cookieKey = env.MEDINA_PARTNER_ENTRY_COOKIE_KEY || "";
  const secret = env.MEDINA_PARTNER_ENTRY_TURNSTILE_SECRET || "", siteKey = env.MEDINA_PARTNER_ENTRY_TURNSTILE_SITE_KEY || "";
  const consentVersion = env.MEDINA_PARTNER_ENTRY_CONSENT_VERSION || "";
  if (!origin || !/^[a-f0-9]{64}$/i.test(cookieKey) || !secret.trim() || !/^[A-Za-z0-9_-]{1,100}$/.test(siteKey)
    || !/^[A-Za-z0-9._-]{1,40}$/.test(consentVersion)) return null;
  return { origin, hostname: new URL(origin).hostname, key: Buffer.from(cookieKey, "hex"), secret, siteKey, consentVersion };
}
class BodyLimitError extends Error {}
function rawJson(value: string | Buffer): Row | null {
  if (Buffer.byteLength(value)>8192) throw new BodyLimitError();
  return record(JSON.parse(typeof value === "string" ? value : value.toString("utf8")));
}
async function body(req: VercelRequest): Promise<Row | null> {
  if (typeof req.headers["content-type"] !== "string" || !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"])) throw Error("invalid_content_type");
  const length = req.headers["content-length"];
  if (length !== undefined) {
    if (typeof length !== "string" || !/^\d+$/.test(length)) throw Error("invalid_body");
    if (Number(length) > 8192) throw new BodyLimitError();
  }
  const rawBody = (req as VercelRequest & { rawBody?: unknown }).rawBody;
  if (typeof rawBody === "string" || Buffer.isBuffer(rawBody)) return rawJson(rawBody);
  if (ArrayBuffer.isView(rawBody)) {
    if (rawBody.byteLength>8192) throw new BodyLimitError();
    return rawJson(Buffer.from(rawBody.buffer,rawBody.byteOffset,rawBody.byteLength));
  }
  if (req.body !== undefined) {
    const raw = Buffer.isBuffer(req.body) || typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    if (raw===undefined) throw Error("invalid_body"); return rawJson(raw);
  }
  let bytes = 0; const chunks: Buffer[] = [];
  const input = typeof req.iterator === "function" ? req.iterator({ destroyOnReturn: false }) : req as AsyncIterable<Buffer | string>;
  for await (const chunk of input) { const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk); bytes += size;
    if (bytes > 8192) throw new BodyLimitError(); chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); }
  return record(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
}
export { body as readPartnerEntryBody, BodyLimitError as PartnerEntryBodyLimitError };
export async function verifyPartnerEntryChallenge(config: Config, token: string,
  request: ChallengeFetch = fetch as unknown as ChallengeFetch): Promise<boolean> {
  try {
    const response = await request("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", redirect: "error", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: config.secret, response: token }), signal: AbortSignal.timeout(8000),
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); return false; }
    const reader = response.body.getReader(), chunks: Buffer[] = []; let bytes = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength;
      if (bytes > 8192) { await reader.cancel(); return false; } chunks.push(Buffer.from(part.value)); } }
    finally { reader.releaseLock(); }
    const result = record(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
    return result?.success === true && result.hostname === config.hostname && result.action === "partner_entry";
  } catch { return false; }
}
async function rpc(name: string, args: Row): Promise<{ data: unknown; error: { code?: string } | null }> {
  const client = getSupabaseServerClient(); if (!client) throw Error("unavailable"); return client.rpc(name, args);
}
function normalizedInstant(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:000)?Z$/.test(value)) return null;
  const normalized = value.replace(/(\.\d{3})000Z$/, "$1Z");
  return Number.isFinite(Date.parse(normalized)) && new Date(normalized).toISOString() === normalized ? normalized : null;
}
function parseResult(value: unknown, id: string, startedAt: string, source: string, full: boolean, allowUnconfirmed: boolean): Row | null {
  const v = record(value); if (!v) return null;
  if (allowUnconfirmed && keys(v, ["state"]) && v.state === "unconfirmed") return v;
  const expected = ["id", "capturedAt", "expiresAt", "policyVersion", ...(full ? ["state", "source", "workspaceId"] : [])];
  if (!keys(v, expected) || v.id !== id || normalizedInstant(v.capturedAt) !== startedAt || v.policyVersion !== PARTNER_POLICY_VERSION
    || normalizedInstant(v.expiresAt) !== new Date(Date.parse(startedAt)+PARTNER_WINDOW_MS).toISOString()) return null;
  if (full && (typeof v.state !== "string" || !["captured", "expired", "pending_payment", "bound"].includes(v.state) || v.source !== source
    || (["bound", "pending_payment"].includes(v.state) ? !isUuidValue(v.workspaceId)
      : v.state === "expired" ? v.workspaceId !== null && !isUuidValue(v.workspaceId) : v.workspaceId !== null))) return null;
  return v;
}
export function createPartnerEntryHandler(deps: { env?: () => NodeJS.ProcessEnv; now?: () => number;
  resolveConsent?: SiteConsentResolver; verify?: typeof verifyPartnerEntryChallenge; save?: typeof rpc } = {}) {
  let windowStart = 0, attempts = 0;
  return async (req: VercelRequest, res: VercelResponse) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Robots-Tag", "noindex, nofollow"); res.setHeader("X-Content-Type-Options", "nosniff");
    const reply = (status: number, code: string) => res.status(status).json({ success: false, code });
    const config = partnerEntryConfig((deps.env || (() => process.env))()); if (!config) return reply(503, "partner_entry_unavailable");
    if (req.headers.origin !== config.origin) return reply(403, "origin_denied");
    if (req.method !== "POST") return reply(405, "method_not_allowed");
    const op = req.query.op;
    if (Object.keys(req.query).some(k => !["path", "op"].includes(k)) || typeof op !== "string"
      || !["notice", "prepare", "capture", "claim", "read"].includes(op)) return reply(400, "invalid_partner_query");
    const now = (deps.now || Date.now)(); if (now-windowStart>=60000 || now<windowStart) { windowStart=now; attempts=0; }
    // A local circuit breaker, not a substitute for distributed edge limits.
    if (++attempts>60) return reply(429, "rate_limited");
    const user = op === "claim" || op === "read" ? await requireAuthenticatedUser(req) : null;
    const receipt = resolveSiteConsentReceipt(config.consentVersion, deps.resolveConsent || resolveSiteConsent);
    if (!receipt || receipt.purpose !== "partner_attribution") return reply(503, "partner_entry_unavailable");
    let value: Row | null;
    try { value=await body(req); } catch (error) { return reply(error instanceof BodyLimitError ? 413 : 400, error instanceof BodyLimitError ? "request_body_too_large" : "invalid_request"); }
    if (!value || !keys(value, op === "prepare" ? ["code", "source", "consent", "consentVersion", "challengeToken"] : [])) return reply(400, "invalid_request");
    if (op === "notice") return res.status(200).json({ success: true, data: { siteKey: config.siteKey, notice: receipt } });
    const cookie = readPartnerEntryCookie(req.headers.cookie, config.origin, config.key, now);
    if (cookie.state === "invalid") return reply(400, "invalid_partner_cookie");
    if (cookie.state === "expired") return reply(410, "partner_entry_expired");
    if (op === "prepare") {
      const code = canonicalPartnerCode(value.code);
      if (!code || typeof value.source !== "string" || !["link", "promo_code"].includes(value.source) || value.consent !== true || value.consentVersion !== receipt.version
        || typeof value.challengeToken !== "string" || value.challengeToken.length<1 || value.challengeToken.length>2048) return reply(400, "invalid_request");
      if (cookie.state === "valid") {
        if (cookie.frame.consentVersion !== receipt.version || cookie.frame.consentHash !== receipt.sha256) return reply(409, "partner_notice_changed");
        return res.status(200).json({ success: true, data: { prepared: true, expiresAt: new Date(Date.parse(cookie.frame.startedAt)+PARTNER_WINDOW_MS).toISOString() } });
      }
      if (!await (deps.verify || verifyPartnerEntryChallenge)(config, value.challengeToken)) return reply(403, "challenge_failed");
      const frame = newPartnerEntryFrame(code, value.source as "link" | "promo_code", receipt.version, receipt.sha256, (deps.now || Date.now)());
      res.setHeader("Set-Cookie", partnerEntrySetCookie(frame, config.origin, config.key, (deps.now || Date.now)()));
      return res.status(200).json({ success: true, data: { prepared: true, expiresAt: new Date(Date.parse(frame.startedAt)+PARTNER_WINDOW_MS).toISOString() } });
    }
    if (cookie.state !== "valid") return reply(409, "partner_entry_not_prepared");
    const frame = cookie.frame;
    if (frame.consentVersion !== receipt.version || frame.consentHash !== receipt.sha256) return reply(409, "partner_notice_changed");
    try {
      const args = op === "capture" ? { p_intent: frame.id, p_capability_hash: partnerCapabilityHash(frame), p_code: frame.code,
        p_source: frame.source, p_started_at: frame.startedAt } : { p_actor: user!.id, p_intent: frame.id, ...(op === "claim" ? { p_capability_hash: partnerCapabilityHash(frame) } : {}) };
      const result = await (deps.save || rpc)(op === "capture" ? "capture_growth_partner_source_v2" : op === "claim" ? "claim_growth_partner_source" : "read_growth_partner_source", args);
      if (result.error) return reply(result.error.code === "P1121" ? 403 : result.error.code === "P1133" ? 410 : 503,
        result.error.code === "P1121" ? "partner_source_unavailable" : result.error.code === "P1133" ? "partner_entry_expired" : "partner_source_unconfirmed");
      const parsed = parseResult(result.data, frame.id, frame.startedAt, frame.source, op !== "capture", op === "read");
      return parsed ? res.status(200).json({ success: true, data: parsed }) : reply(503, "partner_source_unconfirmed");
    } catch { return reply(503, "partner_source_unconfirmed"); }
  };
}
export const handlePartnerEntry = createPartnerEntryHandler();

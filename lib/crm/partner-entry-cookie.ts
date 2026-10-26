import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const PARTNER_ENTRY_COOKIE = "__Secure-medina_partner_entry";
export const PARTNER_ENTRY_PATH = "/api/crm/partner-entry";
export const PARTNER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const PARTNER_POLICY_VERSION = "2026-10-27-7d-self-v1";
export type PartnerEntryFrame = Readonly<{ id: string; token: string; code: string; source: "link" | "promo_code";
  startedAt: string; consentVersion: string; consentHash: string; policyVersion: typeof PARTNER_POLICY_VERSION }>;
type CookieResult = { state: "missing" | "invalid" | "expired" } | { state: "valid"; frame: PartnerEntryFrame };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hex = /^[0-9a-f]{64}$/;
const fields = ["id", "token", "code", "source", "startedAt", "consentVersion", "consentHash", "policyVersion"];
export function canonicalPartnerCode(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 48 || !/^[A-Za-z0-9_ -]+$/.test(value)) return null;
  const code = value.trim().toUpperCase(); return /^[A-Z0-9_-]{4,40}$/.test(code) ? code : null;
}
function validFrame(value: unknown): value is PartnerEntryFrame {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k))
    && typeof v.id === "string" && uuid.test(v.id) && typeof v.token === "string" && hex.test(v.token)
    && canonicalPartnerCode(v.code) === v.code && typeof v.source === "string" && ["link", "promo_code"].includes(v.source)
    && typeof v.startedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.startedAt)
    && Number.isFinite(Date.parse(v.startedAt)) && new Date(v.startedAt).toISOString() === v.startedAt
    && typeof v.consentVersion === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(v.consentVersion)
    && typeof v.consentHash === "string" && hex.test(v.consentHash) && v.policyVersion === PARTNER_POLICY_VERSION;
}
function mac(payload: string, origin: string, key: Buffer) {
  return createHmac("sha256", key).update("medina-partner-entry-v1\n" + origin + "\n" + payload).digest();
}
export function newPartnerEntryFrame(code: string, source: "link" | "promo_code", consentVersion: string, consentHash: string, now: number): PartnerEntryFrame {
  const frame = { id: randomUUID(), token: randomBytes(32).toString("hex"), code, source, startedAt: new Date(now).toISOString(), consentVersion, consentHash, policyVersion: PARTNER_POLICY_VERSION };
  if (!validFrame(frame)) throw Error("invalid_partner_frame"); return Object.freeze(frame);
}
export function partnerCapabilityHash(frame: PartnerEntryFrame) { return createHash("sha256").update(Buffer.from(frame.token, "hex")).digest("hex"); }
export function sealPartnerEntry(frame: PartnerEntryFrame, origin: string, key: Buffer): string {
  if (key.length !== 32 || !validFrame(frame)) throw Error("invalid_partner_frame");
  const payload = Buffer.from(JSON.stringify(frame)).toString("base64url"); return payload + "." + mac(payload, origin, key).toString("hex");
}
export function readPartnerEntryCookie(header: unknown, origin: string, key: Buffer, now: number): CookieResult {
  if (header === undefined) return { state: "missing" };
  if (typeof header !== "string" || Buffer.byteLength(header) > 8192 || key.length !== 32) return { state: "invalid" };
  const matches = header.split(";").map(p => p.trim()).filter(p => p.split("=", 1)[0] === PARTNER_ENTRY_COOKIE);
  if (!matches.length) return { state: "missing" };
  if (matches.length !== 1) return { state: "invalid" };
  const value = matches[0].slice(PARTNER_ENTRY_COOKIE.length + 1);
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(value)) return { state: "invalid" };
  const [payload, signature] = value.split(".");
  try {
    if (!timingSafeEqual(mac(payload, origin, key), Buffer.from(signature, "hex"))) return { state: "invalid" };
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.toString("base64url") !== payload) return { state: "invalid" };
    const frame: unknown = JSON.parse(bytes.toString("utf8"));
    if (!validFrame(frame) || Date.parse(frame.startedAt) > now + 30000) return { state: "invalid" };
    if (Date.parse(frame.startedAt) + PARTNER_WINDOW_MS <= now) return { state: "expired" };
    return { state: "valid", frame: Object.freeze(frame) };
  } catch { return { state: "invalid" }; }
}
export function partnerEntrySetCookie(frame: PartnerEntryFrame, origin: string, key: Buffer, now: number): string {
  const expires = Date.parse(frame.startedAt) + PARTNER_WINDOW_MS;
  if (expires <= now) throw Error("expired_partner_frame");
  return `${PARTNER_ENTRY_COOKIE}=${sealPartnerEntry(frame, origin, key)}; Path=${PARTNER_ENTRY_PATH}; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((expires-now)/1000)}; Expires=${new Date(expires).toUTCString()}`;
}

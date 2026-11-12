export const PARTNER_LINK_POLICY = "2026-10-27-7d-self-v1";
export type PartnerLink = Readonly<{ profileId: string; profileRevision: string; agreementRevision: string;
  referralCode: string; url: string; policyVersion: typeof PARTNER_LINK_POLICY }>;

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const uuid = (value: unknown): value is string => typeof value === "string"
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

/** A copied URL is server-confirmed, never assembled from a cached profile code. */
export function parsePartnerLink(value: unknown): PartnerLink | null {
  const v = object(value), fields = ["profileId", "profileRevision", "agreementRevision", "referralCode", "url", "policyVersion"];
  if (!v || Object.keys(v).length !== fields.length || !fields.every(k => Object.hasOwn(v, k))
    || !uuid(v.profileId) || !uuid(v.profileRevision) || !uuid(v.agreementRevision)
    || typeof v.referralCode !== "string" || !/^[A-F0-9]{32}$/.test(v.referralCode)
    || typeof v.url !== "string" || v.url.length > 2048 || /[\s\\]/.test(v.url) || v.policyVersion !== PARTNER_LINK_POLICY) return null;
  try {
    const url = new URL(v.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || v.url !== `${url.origin}/r/${v.referralCode}`) return null;
  } catch { return null; }
  return Object.freeze({ profileId: v.profileId, profileRevision: v.profileRevision, agreementRevision: v.agreementRevision,
    referralCode: v.referralCode, url: v.url, policyVersion: PARTNER_LINK_POLICY });
}

export type PartnerEntryNotice = Readonly<{ siteKey: string; notice: Readonly<{ version: string; text: string;
  purpose: "partner_attribution"; policyRevision: string; policyUrl: string; sha256: string }> }>;
export function parsePartnerEntryNotice(value: unknown): PartnerEntryNotice | null {
  const v = object(value), n = object(v?.notice);
  if (!v || Object.keys(v).length !== 2 || !Object.hasOwn(v, "siteKey") || !Object.hasOwn(v, "notice")
    || typeof v.siteKey !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(v.siteKey) || !n
    || Object.keys(n).length !== 6 || !["version", "text", "purpose", "policyRevision", "policyUrl", "sha256"].every(k => Object.hasOwn(n, k))
    || typeof n.version !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(n.version) || n.purpose !== "partner_attribution"
    || typeof n.text !== "string" || !n.text.trim() || n.text.length > 20000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(n.text)
    || typeof n.policyRevision !== "string" || !n.policyRevision.trim() || n.policyRevision.length > 120
    || typeof n.policyUrl !== "string" || n.policyUrl.length > 2048 || /[\s\\]/.test(n.policyUrl)
    || typeof n.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(n.sha256)) return null;
  try { const url = new URL(n.policyUrl); if (url.protocol !== "https:" || url.username || url.password || url.hash) return null; }
  catch { return null; }
  return Object.freeze({ siteKey: v.siteKey, notice: Object.freeze({ version: n.version, text: n.text,
    purpose: "partner_attribution", policyRevision: n.policyRevision, policyUrl: n.policyUrl, sha256: n.sha256 }) });
}

export function parsePartnerEntryPrepared(value: unknown): Readonly<{ prepared: true; expiresAt: string }> | null {
  const v = object(value);
  if (!v || Object.keys(v).length !== 2 || !Object.hasOwn(v, "prepared") || v.prepared !== true || !Object.hasOwn(v, "expiresAt")
    || typeof v.expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.expiresAt)
    || !Number.isFinite(Date.parse(v.expiresAt)) || new Date(v.expiresAt).toISOString() !== v.expiresAt) return null;
  return Object.freeze({ prepared: true, expiresAt: v.expiresAt });
}

export function parsePartnerEntryCaptured(value: unknown): Readonly<{ id: string; capturedAt: string; expiresAt: string;
  policyVersion: typeof PARTNER_LINK_POLICY }> | null {
  const v = object(value);
  if (!v || Object.keys(v).length !== 4 || !["id", "capturedAt", "expiresAt", "policyVersion"].every(k => Object.hasOwn(v, k))
    || !uuid(v.id) || v.policyVersion !== PARTNER_LINK_POLICY || typeof v.capturedAt !== "string" || typeof v.expiresAt !== "string") return null;
  const normalize = (s: string) => s.replace(/(\.\d{3})000Z$/, "$1Z");
  const capturedAt = normalize(v.capturedAt), expiresAt = normalize(v.expiresAt);
  if (![capturedAt, expiresAt].every(s => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)
    && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s)
    || Date.parse(expiresAt) - Date.parse(capturedAt) !== 7 * 24 * 60 * 60 * 1000) return null;
  return Object.freeze({ id: v.id, capturedAt, expiresAt, policyVersion: PARTNER_LINK_POLICY });
}

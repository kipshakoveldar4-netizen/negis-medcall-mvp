import { normalizePhone } from "./phone";

// Shared by the future server adapter; never accepts a workspace from a visitor.
export const SITE_SERVICE_KEYS = [
  "targeted-advertising", "lead-generation", "call-center", "advertising-and-operations",
] as const;

export type SiteInquiry = {
  name: string;
  phone: string;
  business: string;
  service: string;
  pagePath: string;
  consentVersion: string;
  consent: true;
};

export type SiteInquiryValidation =
  | { ok: true; data: SiteInquiry }
  | { ok: false; code: "invalid_inquiry" | "consent_required" | "invalid_phone" };

const allowedKeys = new Set(["name", "phone", "business", "service", "pagePath", "consentVersion", "consent"]);
const cleanText = (value: unknown, max: number) =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= max
    && !/[\u0000-\u001f\u007f<>]/.test(value) ? value.trim() : null;

export function validateSiteInquiry(value: unknown): SiteInquiryValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "invalid_inquiry" };
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !allowedKeys.has(key))) return { ok: false, code: "invalid_inquiry" };
  if (body.consent !== true) return { ok: false, code: "consent_required" };
  const name = cleanText(body.name, 100);
  const business = cleanText(body.business, 160);
  const service = cleanText(body.service, 64);
  const consentVersion = cleanText(body.consentVersion, 40);
  const pagePath = cleanText(body.pagePath, 240);
  if (!name || !business || !service || !SITE_SERVICE_KEYS.some(key => key === service)
    || !consentVersion || !/^[a-zA-Z0-9._-]+$/.test(consentVersion)
    || !pagePath || !/^\/ru\/(?:[a-z0-9-]+\/)*$/.test(pagePath)) {
    return { ok: false, code: "invalid_inquiry" };
  }
  // Canonicalization alone accepts arbitrary digit strings; validate first.
  if (typeof body.phone !== "string" || body.phone.length > 40 || !/^[+\d ()-]+$/.test(body.phone)) {
    return { ok: false, code: "invalid_phone" };
  }
  const phone = normalizePhone(body.phone);
  if (!/^\+[1-9]\d{9,14}$/.test(phone)) return { ok: false, code: "invalid_phone" };
  return { ok: true, data: { name, phone, business, service, pagePath, consentVersion, consent: true } };
}

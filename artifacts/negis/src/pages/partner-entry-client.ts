export type PartnerEntryOperation = "notice" | "prepare" | "capture";
export type PartnerEntryRequest = (op: PartnerEntryOperation, body: unknown, signal: AbortSignal) => Promise<unknown>;

export class PartnerEntryRequestError extends Error {
  constructor(readonly code: string) {
    super("Partner entry request was not confirmed");
    this.name = "PartnerEntryRequestError";
  }
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const isPartnerEntryCode = (code: string) => /^[A-F0-9]{32}$/.test(code);

// Anonymous by design: do not use the authenticated CRM transport here.
export const requestPartnerEntry: PartnerEntryRequest = async (op, body, signal) => {
  const response = await fetch(`/api/crm/partner-entry?op=${op}`, {
    method: "POST",
    credentials: "same-origin",
    mode: "same-origin",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const envelope = record(await response.json().catch(() => null));
  if (!response.ok || envelope?.success !== true || !Object.hasOwn(envelope, "data")) {
    const known = ["partner_notice_changed", "challenge_failed", "partner_entry_expired", "invalid_partner_cookie",
      "partner_entry_not_prepared", "partner_source_unavailable", "partner_entry_unavailable", "rate_limited"];
    throw new PartnerEntryRequestError(typeof envelope?.code === "string" && known.includes(envelope.code)
      ? envelope.code : "unconfirmed");
  }
  return envelope.data;
};

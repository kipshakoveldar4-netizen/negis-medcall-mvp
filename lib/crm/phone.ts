/**
 * Canonical form of a phone number for storage and comparison.
 *
 * This is a canonicalizer, not a validator: it maps the spellings that occur
 * in this system onto one string so that "8 707 123 45 67", "+7 707 123-45-67"
 * and the "77071234567" that Wazzup sends as a WhatsApp chatId all compare
 * equal. Kazakhstan and Russia share +7, and the national trunk prefix 8
 * followed by ten digits addresses the same subscriber as +7 with those ten
 * digits — that mapping is the one this project actually needs.
 *
 * Anything already carrying a country code (which is what WhatsApp chatIds
 * are) is returned as +<digits>. Unrecognisable input degrades to the same
 * +<digits> form rather than being rejected, because the callers use this for
 * matching, and a miss only means "treated as a different number".
 */
export function normalizePhone(raw: unknown): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return "";

  const digits = trimmed.replace(/\D+/g, "");
  if (!digits) return "";

  // 00 is the international call prefix in most of the world: 0077... = +77...
  if (digits.length > 11 && digits.startsWith("00")) {
    return `+${digits.slice(2)}`;
  }

  // National trunk form: 8XXXXXXXXXX → +7XXXXXXXXXX.
  if (digits.length === 11 && digits.startsWith("8")) {
    return `+7${digits.slice(1)}`;
  }

  return `+${digits}`;
}

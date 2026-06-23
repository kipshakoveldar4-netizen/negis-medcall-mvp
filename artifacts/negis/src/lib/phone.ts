export function formatPhone(phone: string | null | undefined): string {
  return (phone || "").replace(/\s+/g, " ").trim();
}

export function phoneDigits(phone: string | null | undefined): string {
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

export function toTelHref(phone: string | null | undefined): string {
  const digits = phoneDigits(phone);
  return digits ? `tel:+${digits}` : "#";
}

export function toWhatsappHref(phone: string | null | undefined, text?: string): string {
  const digits = phoneDigits(phone);
  const message = text ? `?text=${encodeURIComponent(text)}` : "";
  return digits ? `https://wa.me/${digits}${message}` : "#";
}

export type OperatorProfile = {
  id: string;
  displayName: string;
  status: "pending" | "approved" | "suspended";
  acceptingRequests: boolean;
};

export type OperatorRequest = {
  id: string;
  displayName: string;
  clinicBrief: string;
  status: "requested" | "accepted" | "declined" | "ended";
  pricePerArrivalMinor: string | null;
  currency: string;
};

export type OperatorList<T> = { items: T[]; hasMore: boolean };
export const OPERATOR_PAGE_SIZE = 20;
export const operatorStatusLabels = {
  pending: "На проверке платформы",
  approved: "Одобрен",
  suspended: "Приостановлен",
  requested: "Ожидает ответа",
  accepted: "Сотрудничество подтверждено",
  declined: "Отклонено",
  ended: "Завершено",
} as const;

// Decimal input and formatting never round an agreed price through floating point.
export function arrivalPriceToMinor(value: string): string | null {
  const normalized = value.trim().replace(",", ".");
  if (!/^\d{1,14}(\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? minor.toString() : null;
}

export function formatArrivalPrice(
  minor: string | null,
  currency: string,
): string {
  if (minor === null || !/^\d+$/.test(minor)) return "Цена не согласована";
  const value = BigInt(minor);
  const fraction = (value % 100n).toString().padStart(2, "0");
  return `${(value / 100n).toLocaleString("ru-RU")}${fraction === "00" ? "" : `,${fraction}`} ${currency === "KZT" ? "₸" : currency}`;
}

export const PARTNER_HISTORY_PAGE_SIZE = 20;
export type PartnerHistoryItem = {
  id: string;
  kind: "first_payment" | "renewal" | "payout";
  occurredAt: string;
  amountMinor: string;
  currency: string;
};
export type PartnerHistoryPage = { state: "not_activated" | "suspended" } | {
  state: "ready";
  generatedAt: string;
  offset: number;
  month: string | null;
  items: PartnerHistoryItem[];
  hasMore: boolean;
};
type Row = Record<string, unknown>;
const object = (value: unknown): Row | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
const keys = (value: Row, expected: string[]) => Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function partnerHistoryMonth(value: unknown): value is string | null {
  return value === null || typeof value === "string" && /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(value);
}
const offsetValid = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000;
function instant(value: unknown): value is string {
  return typeof value === "string" && /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}
// Date.parse discards microseconds; normalize the fraction before ordering.
const micros = (value: string) => value.slice(0, 19) + "." + (value.slice(19, -1).replace(/^\./, "")).padEnd(6, "0");
const textOrder = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function order(a: PartnerHistoryItem, b: PartnerHistoryItem) {
  return textOrder(micros(b.occurredAt), micros(a.occurredAt)) || textOrder(a.kind, b.kind) || textOrder(a.id, b.id);
}
export function parsePartnerHistory(value: unknown, expected: { offset: number; month: string | null }): PartnerHistoryPage | null {
  if (!offsetValid(expected.offset) || !partnerHistoryMonth(expected.month)) return null;
  const row = object(value);
  if (!row) return null;
  if (row.state === "not_activated" || row.state === "suspended") return keys(row, ["state"]) ? { state: row.state } : null;
  if (!keys(row, ["state", "generatedAt", "offset", "month", "items", "hasMore"]) || row.state !== "ready"
    || !instant(row.generatedAt) || row.offset !== expected.offset || row.month !== expected.month
    || typeof row.hasMore !== "boolean" || !Array.isArray(row.items) || row.items.length > PARTNER_HISTORY_PAGE_SIZE
    || row.hasMore && row.items.length !== PARTNER_HISTORY_PAGE_SIZE) return null;
  const items: PartnerHistoryItem[] = [], seen = new Set<string>();
  for (const entry of row.items) {
    const item = object(entry);
    if (!item || !keys(item, ["id", "kind", "occurredAt", "amountMinor", "currency"])
      || typeof item.id !== "string" || !uuid.test(item.id)
      || typeof item.kind !== "string" || !["first_payment", "renewal", "payout"].includes(item.kind)
      || !instant(item.occurredAt) || expected.month !== null && !item.occurredAt.startsWith(expected.month + "-")
      || typeof item.amountMinor !== "string" || !/^(?:0|[1-9]\d{0,63})$/.test(item.amountMinor)
      || typeof item.currency !== "string" || !/^[A-Z]{3}$/.test(item.currency)) return null;
    const key = item.kind + ":" + item.id.toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    const parsed: PartnerHistoryItem = { id: item.id.toLowerCase(), kind: item.kind as PartnerHistoryItem["kind"],
      occurredAt: item.occurredAt, amountMinor: item.amountMinor, currency: item.currency };
    if (items.length && order(items[items.length - 1], parsed) > 0) return null;
    items.push(parsed);
  }
  return { state: "ready", generatedAt: row.generatedAt, offset: expected.offset, month: expected.month, items, hasMore: row.hasMore };
}

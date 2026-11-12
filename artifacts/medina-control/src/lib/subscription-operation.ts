import type { PlanKey } from "../../../../lib/billing/plans";

export type SubscriptionOperationKind = "replace" | "status";

export type PendingSubscriptionOperation = Readonly<{
  requestKey: string;
  workspaceId: string;
  kind: SubscriptionOperationKind;
}>;

export type SubscriptionReplacePayload = Readonly<{
  workspaceId: string;
  requestKey: string;
  expectedActiveId: string | null;
  plan: PlanKey;
  priceMinor: number;
  billingPeriod: "monthly" | "yearly";
  currency: string;
  note?: string;
}>;

export type SubscriptionStatus = "active" | "paused" | "cancelled";
export type SubscriptionStatusPayload = Readonly<{
  workspaceId: string;
  requestKey: string;
  subscriptionId: string;
  expectedUpdatedAt: string;
  expectedStatus: SubscriptionStatus;
  status: SubscriptionStatus;
}>;
export type SubscriptionPayload = SubscriptionReplacePayload | SubscriptionStatusPayload;

export type SubscriptionHistoryItem = {
  id: string;
  workspace_id: string;
  plan: PlanKey;
  status: SubscriptionStatus;
  price_minor: number;
  currency: string;
  billing_period: "monthly" | "yearly";
  updated_at: string;
};

type Access = { actorId: string; isCurrent(): boolean };
export type SubscriptionOutcome = "committed" | "abandoned" | "unconfirmed";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

export function formatSubscriptionPriceInput(priceMinor: number): string {
  if (!Number.isSafeInteger(priceMinor) || priceMinor < 0) return "";
  const minor = BigInt(priceMinor);
  const whole = minor / 100n;
  const fraction = minor % 100n;
  return fraction === 0n ? String(whole) : `${whole}.${String(fraction).padStart(2, "0")}`;
}

export function formatSubscriptionAmount(priceMinor: number, currency = "KZT"): string {
  const input = formatSubscriptionPriceInput(priceMinor);
  if (!input || !/^[A-Z]{3}$/.test(currency)) return "—";
  const [whole, fraction] = input.split(".");
  const grouped = new Intl.NumberFormat("ru-RU").format(BigInt(whole));
  return `${grouped}${fraction ? `,${fraction}` : ""}\u00a0${currency === "KZT" ? "₸" : currency}`;
}

export function parseSubscriptionPriceInput(value: string): number | null {
  const match = /^([0-9]+)(?:[.,]([0-9]{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const whole = match[1].replace(/^0+/, "") || "0";
  // More whole-unit digits cannot fit in a safe integer of minor units.
  if (whole.length > 14) return null;
  const minor = BigInt(whole) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
  return minor <= MAX_SAFE_MINOR ? Number(minor) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isSubscriptionItem(value: unknown, workspaceId: string): value is SubscriptionHistoryItem {
  const item = record(value);
  return !!item && typeof item.id === "string" && UUID.test(item.id) && item.workspace_id === workspaceId
    && typeof item.plan === "string" && ["basic", "standard", "pro"].includes(item.plan)
    && typeof item.price_minor === "number" && Number.isSafeInteger(item.price_minor) && item.price_minor >= 0
    && (item.billing_period === "monthly" || item.billing_period === "yearly")
    && typeof item.currency === "string" && /^[A-Z]{3}$/.test(item.currency)
    && typeof item.status === "string" && ["active", "paused", "cancelled"].includes(item.status)
    && typeof item.updated_at === "string" && Number.isFinite(Date.parse(item.updated_at));
}

export function parseSubscriptionHistory(body: unknown, workspaceId: string): SubscriptionHistoryItem[] | null {
  const envelope = record(body);
  const data = record(envelope?.data);
  if (envelope?.success !== true || !Array.isArray(data?.items) || data.items.length > 1000) return null;
  const items: SubscriptionHistoryItem[] = [];
  const seen = new Set<string>();
  for (const value of data.items) {
    if (!isSubscriptionItem(value, workspaceId) || seen.has(value.id)) return null;
    seen.add(value.id);
    items.push(value);
  }
  return items;
}

function storageKey(actorId: string): string {
  return `medina-control:subscription-operation:${encodeURIComponent(actorId)}`;
}

// Call storage helpers only after a validated owner overview, never on login.
export function readPendingSubscription(access: Access): PendingSubscriptionOperation | null {
  if (!access.actorId || !access.isCurrent()) return null;
  try {
    const raw = sessionStorage.getItem(storageKey(access.actorId));
    if (!access.isCurrent() || raw === null) return null;
    const value = record(JSON.parse(raw));
    if (!access.isCurrent()) return null;
    if (!value || Object.keys(value).length !== 3
      || typeof value.requestKey !== "string" || !UUID.test(value.requestKey)
      || typeof value.workspaceId !== "string" || !UUID.test(value.workspaceId)
      || (value.kind !== "replace" && value.kind !== "status")) throw new Error("Invalid pending subscription");
    return { requestKey: value.requestKey, workspaceId: value.workspaceId, kind: value.kind };
  } catch {
    if (!access.isCurrent()) return null;
    throw new Error("Не удалось прочитать ключ восстановления подписки");
  }
}

export function persistPendingSubscription(access: Access, pending: PendingSubscriptionOperation): boolean {
  if (!access.actorId || !access.isCurrent()) return false;
  try {
    const storedBeforeWrite = readPendingSubscription(access);
    if (storedBeforeWrite && (storedBeforeWrite.requestKey !== pending.requestKey
      || storedBeforeWrite.workspaceId !== pending.workspaceId || storedBeforeWrite.kind !== pending.kind)) return false;
    if (!access.isCurrent()) return false;
    sessionStorage.setItem(storageKey(access.actorId), JSON.stringify({
      requestKey: pending.requestKey, workspaceId: pending.workspaceId, kind: pending.kind,
    }));
    const stored = readPendingSubscription(access);
    return stored?.requestKey === pending.requestKey && stored.workspaceId === pending.workspaceId
      && stored.kind === pending.kind && access.isCurrent();
  } catch {
    return false;
  }
}

export function clearPendingSubscription(access: Access, pending: PendingSubscriptionOperation): boolean {
  if (!access.actorId || !access.isCurrent()) return false;
  try {
    const stored = readPendingSubscription(access);
    if (stored && (stored.requestKey !== pending.requestKey || stored.workspaceId !== pending.workspaceId
      || stored.kind !== pending.kind)) return false;
    sessionStorage.removeItem(storageKey(access.actorId));
    return access.isCurrent() && sessionStorage.getItem(storageKey(access.actorId)) === null;
  } catch {
    return false;
  }
}

/** A receipt proves a past operation, not the clinic's current subscription. */
export function validateSubscriptionReceipt(
  body: unknown,
  actorId: string,
  pending: PendingSubscriptionOperation,
  originalPayload?: SubscriptionPayload,
  requireActive = true,
): SubscriptionOutcome {
  const envelope = record(body);
  const data = record(envelope?.data);
  const operation = record(data?.operation);
  if (!actorId || envelope?.success !== true || !data || !operation
    || operation.actorId !== actorId || operation.requestKey !== pending.requestKey
    || operation.workspaceId !== pending.workspaceId || typeof operation.replayed !== "boolean") return "unconfirmed";

  if (operation.state === "abandoned") {
    return data.item === null && operation.kind === null
      ? "abandoned" : "unconfirmed";
  }
  if (operation.state !== "committed" || operation.kind !== pending.kind) return "unconfirmed";
  if (!isSubscriptionItem(data.item, pending.workspaceId)) return "unconfirmed";
  const item = data.item;
  if (originalPayload) {
    if (originalPayload.requestKey !== pending.requestKey || originalPayload.workspaceId !== pending.workspaceId) return "unconfirmed";
    if ("subscriptionId" in originalPayload) {
      if (pending.kind !== "status" || item.id !== originalPayload.subscriptionId || item.status !== originalPayload.status) return "unconfirmed";
    } else if (pending.kind !== "replace" || item.id === originalPayload.expectedActiveId
      || (requireActive && item.status !== "active") || item.plan !== originalPayload.plan
      || item.price_minor !== originalPayload.priceMinor || item.billing_period !== originalPayload.billingPeriod
      || item.currency !== originalPayload.currency
      || (record(item)?.note ?? null) !== (originalPayload.note || null)) return "unconfirmed";
  }
  return "committed";
}

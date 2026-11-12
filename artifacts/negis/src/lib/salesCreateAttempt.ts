export type SalesCreateAttempt = {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly requestKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  uncertain: boolean;
};

type AttemptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const SESSION_KEY = "medina_sale_create_attempt_v1";
const MAX_LENGTH = 256_000;
const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class SalesAttemptRestoreError extends Error {
  constructor(readonly reason: "unreadable" | "invalid") {
    super(reason === "unreadable"
      ? "Не удалось прочитать хранилище повтора продажи. Новые продажи заблокированы. Разрешите доступ и повторите чтение."
      : "Данные повтора продажи повреждены. Новые продажи заблокированы; сохранённые данные не изменены. Повторите чтение после восстановления хранилища.");
    this.name = "SalesAttemptRestoreError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function snapshot(payload: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  };
  const copy = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  freeze(copy);
  return copy;
}

function storageKey(workspaceId: string, actorId: string): string {
  // Switching accounts must not overwrite another scope's unresolved receipt.
  return `${SESSION_KEY}::${workspaceId}:${actorId}`;
}

export function sameSalesCreateIntent(a: SalesCreateAttempt, b: SalesCreateAttempt): boolean {
  return a.workspaceId === b.workspaceId && a.actorId === b.actorId && a.requestKey === b.requestKey
    && JSON.stringify(a.payload) === JSON.stringify(b.payload);
}

function validPayload(payload: Readonly<Record<string, unknown>>): boolean {
  const strings = ["paymentMethod", "clientId", "leadId", "appointmentId", "serviceId", "metaCampaignLaunchId", "responsibleUserId", "notes"];
  const dates = ["paidAt", "closedAt"];
  const fields = ["title", "amountMinor", "currency", "status", ...strings, ...dates];
  if (Object.keys(payload).some(field => !fields.includes(field))
    || typeof payload.title !== "string" || !payload.title.trim()
    || typeof payload.amountMinor !== "number" || !Number.isSafeInteger(payload.amountMinor) || payload.amountMinor < 0 || payload.currency !== "KZT"
    || typeof payload.status !== "string" || !["pending", "paid", "cancelled", "refunded"].includes(payload.status)) return false;
  if (strings.some(field => field in payload && typeof payload[field] !== "string")) return false;
  if (!dates.every(field => !(field in payload)
    || (typeof payload[field] === "string" && Number.isFinite(Date.parse(payload[field]))))) return false;
  return JSON.stringify(payload).length <= MAX_LENGTH;
}

export function newSalesCreateAttempt(
  workspaceId: string, actorId: string, payload: Record<string, unknown>,
  makeKey: () => string = () => crypto.randomUUID(),
): SalesCreateAttempt {
  if (!workspaceId || !actorId) throw new Error("Не удалось определить аккаунт продажи. Войдите снова.");
  const { id: _id, requestKey: _key, ...fields } = payload;
  if (!validPayload(fields)) throw new Error("Проверьте данные продажи: сумма должна быть безопасным целым числом тиынов, не меньше нуля.");
  const requestKey = makeKey();
  if (!uuid4.test(requestKey)) throw new Error("Не удалось создать безопасный ключ продажи.");
  return { workspaceId, actorId, requestKey, payload: snapshot(fields), uncertain: false };
}

export function persistSalesCreateAttempt(storage: AttemptStorage, attempt: SalesCreateAttempt): boolean {
  try {
    if (!validPayload(attempt.payload)) return false;
    const existing = restoreSalesCreateAttempt(storage, attempt.workspaceId, attempt.actorId);
    if (existing && !sameSalesCreateIntent(existing, attempt)) return false;
    const serialized = JSON.stringify({ version: 1, ...attempt });
    if (serialized.length > MAX_LENGTH) return false;
    const key = storageKey(attempt.workspaceId, attempt.actorId);
    storage.setItem(key, serialized);
    return storage.getItem(key) === serialized;
  } catch {
    return false;
  }
}

export function clearPersistedSalesCreateAttempt(storage: AttemptStorage, attempt: SalesCreateAttempt): void {
  try {
    const existing = restoreSalesCreateAttempt(storage, attempt.workspaceId, attempt.actorId);
    if (!existing || !sameSalesCreateIntent(existing, attempt)) return;
    storage.removeItem(storageKey(attempt.workspaceId, attempt.actorId));
  } catch {
    // A blocked tab store must never trigger a second, unkeyed create.
  }
}

export function restoreSalesCreateAttempt(storage: AttemptStorage, workspaceId: string, actorId: string): SalesCreateAttempt | null {
  let raw: string | null;
  try {
    raw = storage.getItem(storageKey(workspaceId, actorId));
  } catch {
    throw new SalesAttemptRestoreError("unreadable");
  }
  if (raw === null) return null;
  try {
    if (!raw || raw.length > MAX_LENGTH) throw new Error("invalid_attempt_length");
    const saved = record(JSON.parse(raw));
    const payload = record(saved?.payload);
    if (saved?.version !== 1 || saved.workspaceId !== workspaceId || saved.actorId !== actorId
      || typeof saved.requestKey !== "string" || !uuid4.test(saved.requestKey)
      || typeof saved.uncertain !== "boolean" || !payload || !validPayload(payload)) throw new Error("invalid_attempt");
    // Reload may have interrupted a committed request before its catch ran.
    return { workspaceId, actorId, requestKey: saved.requestKey, payload: snapshot(payload), uncertain: true };
  } catch {
    throw new SalesAttemptRestoreError("invalid");
  }
}

export function isCurrentSalesAttempt(attempt: SalesCreateAttempt, workspaceId: string, actorId: string): boolean {
  return attempt.workspaceId === workspaceId && attempt.actorId === actorId;
}

export function canReleaseSalesAttempt(attempt: SalesCreateAttempt, status: number, body: unknown): boolean {
  const result = record(body);
  // A later refusal cannot disprove an earlier uncertain commit.
  if (attempt.uncertain || result?.success !== false) return false;
  if ([400, 401, 403, 422].includes(status)) return true;
  if (status === 409 && result.code === "arrival_payment") return true;
  return status === 503 && result.code === "sale_create_unavailable";
}

export function confirmedSalesCreate(body: unknown): Record<string, unknown> | null {
  const result = record(body);
  const data = record(result?.data);
  const item = record(data?.item);
  const amount = item?.amountMinor ?? item?.amount_minor;
  if (result?.success !== true || result.mode !== "supabase" || typeof data?.replayed !== "boolean"
    || typeof item?.id !== "string" || !uuid.test(item.id)
    || typeof item.title !== "string" || !item.title.trim()
    || typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0
    || item.currency !== "KZT" || !["pending", "paid", "cancelled", "refunded"].includes(String(item.status))) return null;
  return item;
}

export function mergeCreatedSale<T extends { id: string }>(items: T[], saved: T): T[] {
  const index = items.findIndex(item => item.id === saved.id);
  if (index < 0) return [saved, ...items];
  return items.flatMap((item, current) => item.id !== saved.id ? [item] : current === index ? [saved] : []);
}

export type AppointmentCreateAttempt = {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly requestKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  uncertain: boolean;
  readonly leadId?: string;
  readonly originRole?: string;
};

type AppointmentAttemptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const APPOINTMENT_ATTEMPT_SESSION_KEY = "medina_appointment_create_attempt_v1";
const SCOPED_SESSION_KEY = "medina_appointment_create_attempt_v2";
const MAX_STORED_ATTEMPT_LENGTH = 256_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const entityUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const roles = ["owner", "admin", "manager", "receptionist", "doctor", "marketer", "lead_manager"];

export class AppointmentAttemptRestoreError extends Error {
  constructor(readonly reason: "unreadable" | "invalid" | "conflict") {
    super(reason === "unreadable"
      ? "Не удалось прочитать хранилище повтора записи. Новая запись не отправлена. Разрешите доступ к хранилищу и повторите чтение."
      : reason === "conflict"
        ? "Найдены разные незавершённые записи. Новые записи заблокированы; сохранённые данные не изменены."
        : "Данные повтора записи повреждены. Новые записи заблокированы; сохранённые данные не изменены.");
    this.name = "AppointmentAttemptRestoreError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function storageKey(workspaceId: string, actorId: string): string {
  return `${SCOPED_SESSION_KEY}::${encodeURIComponent(workspaceId)}:${encodeURIComponent(actorId)}`;
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

function decode(raw: string, version: number, workspaceId: string, actorId: string): AppointmentCreateAttempt {
  try {
    if (!raw || raw.length > MAX_STORED_ATTEMPT_LENGTH) throw new Error("invalid_length");
    const saved = record(JSON.parse(raw));
    const payload = record(saved?.payload);
    if (!workspaceId || !actorId || saved?.version !== version || saved.workspaceId !== workspaceId || saved.actorId !== actorId
      || typeof saved.requestKey !== "string" || !uuid.test(saved.requestKey)
      || typeof saved.uncertain !== "boolean" || !payload || "id" in payload || "requestKey" in payload
      || ("workspaceId" in payload && payload.workspaceId !== workspaceId)
      || ("workspace_id" in payload && payload.workspace_id !== workspaceId)
      || (saved.leadId !== undefined && (typeof saved.leadId !== "string" || !entityUuid.test(saved.leadId)))
      || (saved.originRole !== undefined && (typeof saved.originRole !== "string" || !roles.includes(saved.originRole)))) {
      throw new Error("invalid_attempt");
    }
    return { workspaceId, actorId, requestKey: saved.requestKey, payload: snapshot(payload), uncertain: true,
      ...(saved.leadId ? { leadId: saved.leadId as string } : {}),
      ...(saved.originRole ? { originRole: saved.originRole as string } : {}) };
  } catch {
    throw new AppointmentAttemptRestoreError("invalid");
  }
}

export function sameAppointmentCreateIntent(a: AppointmentCreateAttempt, b: AppointmentCreateAttempt): boolean {
  return a.workspaceId === b.workspaceId && a.actorId === b.actorId && a.requestKey === b.requestKey
    && a.leadId === b.leadId && a.originRole === b.originRole && JSON.stringify(a.payload) === JSON.stringify(b.payload);
}

export function restoreAppointmentCreateAttempt(
  storage: AppointmentAttemptStorage,
  workspaceId: string,
  actorId: string,
): AppointmentCreateAttempt | null {
  let raw: string | null;
  let legacyRaw: string | null;
  try {
    raw = storage.getItem(storageKey(workspaceId, actorId));
    legacyRaw = storage.getItem(APPOINTMENT_ATTEMPT_SESSION_KEY);
  } catch {
    throw new AppointmentAttemptRestoreError("unreadable");
  }
  const scoped = raw === null ? null : decode(raw, 2, workspaceId, actorId);
  if (legacyRaw === null) return scoped;

  let legacy: Record<string, unknown> | null;
  try {
    if (!legacyRaw || legacyRaw.length > MAX_STORED_ATTEMPT_LENGTH) throw new Error("invalid_length");
    legacy = record(JSON.parse(legacyRaw));
    if (legacy?.version !== 1 || typeof legacy.workspaceId !== "string" || !legacy.workspaceId
      || typeof legacy.actorId !== "string" || !legacy.actorId) throw new Error("invalid_legacy_scope");
  } catch {
    throw new AppointmentAttemptRestoreError("invalid");
  }
  // Another account's recovery is neither shown nor erased during a switch.
  if (legacy.workspaceId !== workspaceId || legacy.actorId !== actorId) return scoped;
  const pending = decode(legacyRaw, 1, workspaceId, actorId);
  if (scoped && !sameAppointmentCreateIntent(scoped, pending)) throw new AppointmentAttemptRestoreError("conflict");
  const restored = scoped ?? pending;
  const serialized = JSON.stringify({ version: 2, ...restored });
  try {
    const key = storageKey(workspaceId, actorId);
    storage.setItem(key, serialized);
    if (storage.getItem(key) !== serialized) throw new Error("migration_not_retained");
    if (storage.getItem(APPOINTMENT_ATTEMPT_SESSION_KEY) !== legacyRaw) throw new AppointmentAttemptRestoreError("conflict");
    storage.removeItem(APPOINTMENT_ATTEMPT_SESSION_KEY);
    if (storage.getItem(APPOINTMENT_ATTEMPT_SESSION_KEY) !== null) throw new Error("legacy_not_removed");
  } catch (error) {
    if (error instanceof AppointmentAttemptRestoreError) throw error;
    throw new AppointmentAttemptRestoreError("unreadable");
  }
  return restored;
}

export function persistAppointmentCreateAttempt(storage: AppointmentAttemptStorage, attempt: AppointmentCreateAttempt): boolean {
  try {
    let serialized = JSON.stringify({ version: 2, ...attempt });
    decode(serialized, 2, attempt.workspaceId, attempt.actorId);
    const existing = restoreAppointmentCreateAttempt(storage, attempt.workspaceId, attempt.actorId);
    if (existing && !sameAppointmentCreateIntent(existing, attempt)) return false;
    if (existing?.uncertain) serialized = JSON.stringify({ version: 2, ...attempt, uncertain: true });
    const key = storageKey(attempt.workspaceId, attempt.actorId);
    storage.setItem(key, serialized);
    return storage.getItem(key) === serialized;
  } catch {
    return false;
  }
}

export function clearPersistedAppointmentCreateAttempt(storage: AppointmentAttemptStorage, attempt: AppointmentCreateAttempt): boolean {
  try {
    const existing = restoreAppointmentCreateAttempt(storage, attempt.workspaceId, attempt.actorId);
    if (!existing) return true;
    if (!sameAppointmentCreateIntent(existing, attempt)) return false;
    const key = storageKey(attempt.workspaceId, attempt.actorId);
    storage.removeItem(key);
    return storage.getItem(key) === null;
  } catch {
    return false;
  }
}

export function newAppointmentCreateAttempt(
  workspaceId: string, actorId: string, payload: Record<string, unknown>,
  makeKey: () => string = () => crypto.randomUUID(),
  context: { originRole?: string; leadId?: string } = {},
): AppointmentCreateAttempt {
  if (!workspaceId || !actorId) throw new Error("Не удалось определить аккаунт записи. Войдите снова.");
  const { id: _localId, requestKey: _suppliedKey, ...fields } = payload;
  const requestKey = makeKey();
  if (!uuid.test(requestKey)) throw new Error("Не удалось создать безопасный ключ записи.");
  const attempt = { workspaceId, actorId, requestKey, uncertain: false, payload: snapshot(fields),
    ...(context.originRole !== undefined ? { originRole: context.originRole } : {}),
    ...(context.leadId !== undefined ? { leadId: context.leadId } : {}) };
  decode(JSON.stringify({ version: 2, ...attempt }), 2, workspaceId, actorId);
  return attempt;
}

export function isCurrentAppointmentAttempt(attempt: AppointmentCreateAttempt, workspaceId: string, actorId: string): boolean {
  return attempt.workspaceId === workspaceId && attempt.actorId === actorId;
}

export function canReleaseAppointmentAttempt(attempt: AppointmentCreateAttempt, status: number, body: unknown): boolean {
  // A later refusal cannot disprove an earlier uncertain commit.
  if (attempt.uncertain || !body || typeof body !== "object") return false;
  const result = body as Record<string, unknown>;
  if (result.success !== false) return false;
  if ([400, 401, 403, 422].includes(status)) return true;
  if (status === 409 && ["appointment_conflict", "outside_doctor_schedule", "arrival_payment"].includes(String(result.code))) return true;
  return status === 503 && result.code === "appointment_create_unavailable";
}

export function confirmedAppointmentCreate(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const result = body as Record<string, unknown>;
  const data = result.data as Record<string, unknown> | undefined;
  const item = data?.item as Record<string, unknown> | undefined;
  if (result.success !== true || result.mode !== "supabase" || typeof data?.replayed !== "boolean"
    || typeof item?.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.id)) return null;
  return item;
}

export function mergeCreatedAppointment<T extends { id: string }>(items: T[], saved: T): T[] {
  const index = items.findIndex(item => item.id === saved.id);
  if (index < 0) return [saved, ...items];
  return items.flatMap((item, current) => item.id !== saved.id ? [item] : current === index ? [saved] : []);
}

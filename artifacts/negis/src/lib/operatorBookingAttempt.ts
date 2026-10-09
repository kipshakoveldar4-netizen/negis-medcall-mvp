export type OperatorBookingAttemptPayload = {
  leadId: string;
  doctorId: string;
  serviceIds: string[];
  startsLocal: string;
  timeZone: string;
};

export type OperatorBookingAttempt = {
  actorId: string;
  requestId: string;
  requestKey: string;
  payload: OperatorBookingAttemptPayload;
  uncertain: boolean;
};

type AttemptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const STORAGE_PREFIX = "medina_operator_booking_attempt_v1";
const MAX_STORED_ATTEMPT_BYTES = 16_384;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isValidPayload(value: unknown): value is OperatorBookingAttemptPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (
    !hasExactKeys(payload, [
      "doctorId",
      "leadId",
      "serviceIds",
      "startsLocal",
      "timeZone",
    ]) ||
    !isUuid(payload.leadId) ||
    !isUuid(payload.doctorId) ||
    !Array.isArray(payload.serviceIds) ||
    payload.serviceIds.length < 1 ||
    payload.serviceIds.length > 20 ||
    !payload.serviceIds.every(isUuid) ||
    new Set(payload.serviceIds).size !== payload.serviceIds.length ||
    typeof payload.startsLocal !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(payload.startsLocal) ||
    typeof payload.timeZone !== "string" ||
    payload.timeZone.length < 1 ||
    payload.timeZone.length > 120 ||
    !/^[A-Za-z0-9_+\-/]+$/.test(payload.timeZone)
  ) {
    return false;
  }
  return true;
}

function isValidAttempt(value: unknown): value is OperatorBookingAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attempt = value as Record<string, unknown>;
  return (
    hasExactKeys(attempt, [
      "actorId",
      "payload",
      "requestId",
      "requestKey",
      "uncertain",
    ]) &&
    isUuid(attempt.actorId) &&
    isUuid(attempt.requestId) &&
    isUuid(attempt.requestKey) &&
    typeof attempt.uncertain === "boolean" &&
    isValidPayload(attempt.payload)
  );
}

function storageKey(actorId: string, requestId: string, leadId: string): string {
  return `${STORAGE_PREFIX}:${actorId}:${requestId}:${leadId}`;
}

export function newOperatorBookingAttempt(
  actorId: string,
  requestId: string,
  payload: OperatorBookingAttemptPayload,
  makeKey: () => string = () => crypto.randomUUID(),
): OperatorBookingAttempt {
  return {
    actorId,
    requestId,
    requestKey: makeKey(),
    payload: { ...payload, serviceIds: [...payload.serviceIds] },
    uncertain: false,
  };
}

export function isCurrentOperatorBookingAttempt(
  attempt: OperatorBookingAttempt,
  actorId: string,
  requestId: string,
  leadId: string,
): boolean {
  return (
    attempt.actorId === actorId &&
    attempt.requestId === requestId &&
    attempt.payload.leadId === leadId
  );
}

export function persistOperatorBookingAttempt(
  storage: AttemptStorage | null,
  attempt: OperatorBookingAttempt,
): boolean {
  if (!storage || !isValidAttempt(attempt)) return false;
  try {
    const serialized = JSON.stringify(attempt);
    if (serialized.length > MAX_STORED_ATTEMPT_BYTES) return false;
    const key = storageKey(
      attempt.actorId,
      attempt.requestId,
      attempt.payload.leadId,
    );
    storage.setItem(key, serialized);
    return storage.getItem(key) === serialized;
  } catch {
    return false;
  }
}

export function restoreOperatorBookingAttempt(
  storage: AttemptStorage | null,
  actorId: string,
  requestId: string,
  leadId: string,
): OperatorBookingAttempt | null {
  if (!storage || !isUuid(actorId) || !isUuid(requestId) || !isUuid(leadId)) {
    return null;
  }
  const key = storageKey(actorId, requestId, leadId);
  try {
    const serialized = storage.getItem(key);
    if (!serialized || serialized.length > MAX_STORED_ATTEMPT_BYTES) {
      if (serialized) storage.removeItem(key);
      return null;
    }
    const attempt: unknown = JSON.parse(serialized);
    if (
      !isValidAttempt(attempt) ||
      !isCurrentOperatorBookingAttempt(attempt, actorId, requestId, leadId)
    ) {
      storage.removeItem(key);
      return null;
    }
    return {
      ...attempt,
      payload: { ...attempt.payload, serviceIds: [...attempt.payload.serviceIds] },
      uncertain: true,
    };
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // A denied storage implementation is treated as unavailable.
    }
    return null;
  }
}

export function clearOperatorBookingAttempt(
  storage: AttemptStorage | null,
  actorId: string,
  requestId: string,
  leadId: string,
): void {
  if (!storage) return;
  try {
    storage.removeItem(storageKey(actorId, requestId, leadId));
  } catch {
    // The server receipt still prevents duplication if storage cleanup is denied.
  }
}

export function canReleaseOperatorBookingAttempt(status: number): boolean {
  // Validation, access and business conflicts are definite refusals. Network
  // failures and 5xx responses may have lost a successful provider response.
  return [400, 401, 403, 409, 422].includes(status);
}

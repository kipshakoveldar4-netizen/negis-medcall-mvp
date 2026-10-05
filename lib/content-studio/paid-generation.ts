export type PaidGenerationKind = "photo" | "video";

export type PaidGenerationAttempt = {
  requestKey: string;
  fingerprint: string;
};

export type PaidGenerationAttemptInput = {
  kind: PaidGenerationKind;
  prompt: string;
  format: string;
};

export type PaidGenerationAttemptStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAID_GENERATION_ATTEMPT_VERSION = 1;
const PAID_GENERATION_STORAGE_ERROR =
  "Не удалось сохранить защитный ключ платной генерации. Проверьте настройки браузера и повторите попытку.";

function fingerprint(input: PaidGenerationAttemptInput): string {
  return JSON.stringify([input.kind, input.prompt.trim(), input.format.trim()]);
}

function isCanonicalFingerprint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3) return false;
    const [kind, prompt, format] = parsed;
    if ((kind !== "photo" && kind !== "video") || typeof prompt !== "string" || typeof format !== "string") {
      return false;
    }
    return value === fingerprint({ kind, prompt, format });
  } catch {
    return false;
  }
}

function parseStoredAttempt(raw: string): PaidGenerationAttempt | null {
  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      requestKey?: unknown;
      fingerprint?: unknown;
    };
    if (
      parsed?.version !== PAID_GENERATION_ATTEMPT_VERSION ||
      typeof parsed.requestKey !== "string" ||
      !UUID_V4_PATTERN.test(parsed.requestKey) ||
      !isCanonicalFingerprint(parsed.fingerprint)
    ) {
      return null;
    }
    return { requestKey: parsed.requestKey, fingerprint: parsed.fingerprint };
  } catch {
    return null;
  }
}

/**
 * The browser receipt is the source of truth across a full page reload. If the
 * storage itself cannot be read, media generation stops before a paid call.
 */
export function readStoredPaidGenerationAttempt(
  storage: PaidGenerationAttemptStorage,
  key: string,
): PaidGenerationAttempt | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const attempt = parseStoredAttempt(raw);
    if (!attempt) storage.removeItem(key);
    return attempt;
  } catch {
    throw new Error(PAID_GENERATION_STORAGE_ERROR);
  }
}

/** Persist and verify the receipt before the network request can start. */
export function writeStoredPaidGenerationAttempt(
  storage: PaidGenerationAttemptStorage,
  key: string,
  attempt: PaidGenerationAttempt,
): void {
  try {
    storage.setItem(
      key,
      JSON.stringify({
        version: PAID_GENERATION_ATTEMPT_VERSION,
        requestKey: attempt.requestKey,
        fingerprint: attempt.fingerprint,
      }),
    );
    const restored = parseStoredAttempt(storage.getItem(key) || "");
    if (restored?.requestKey !== attempt.requestKey || restored.fingerprint !== attempt.fingerprint) {
      throw new Error("receipt_not_persisted");
    }
  } catch {
    throw new Error(PAID_GENERATION_STORAGE_ERROR);
  }
}

/** Cleanup is best-effort after a confirmed result; a stale key fails safely. */
export function clearStoredPaidGenerationAttempt(storage: PaidGenerationAttemptStorage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Reusing a stale key can only return the existing receipt; it cannot spend twice.
  }
}

/**
 * An ambiguous browser retry must reuse the first key for the exact same paid
 * request. A changed prompt, format or media kind is a deliberate new request.
 */
export function resolvePaidGenerationAttempt(
  current: PaidGenerationAttempt | null,
  input: PaidGenerationAttemptInput,
  createRequestKey: () => string,
): PaidGenerationAttempt {
  const nextFingerprint = fingerprint(input);
  if (current?.fingerprint === nextFingerprint) return current;

  const requestKey = createRequestKey().trim();
  if (!UUID_V4_PATTERN.test(requestKey)) {
    throw new Error("Не удалось создать безопасный ключ платной генерации. Обновите браузер и повторите попытку.");
  }
  return { requestKey, fingerprint: nextFingerprint };
}

/**
 * Keep the key whenever the provider result may already exist. Explicit 4xx
 * refusals are safe to release, except the duplicate receipt itself.
 */
export function shouldKeepPaidGenerationAttempt(input: {
  responseReceived: boolean;
  status?: number;
  success?: boolean;
  code?: string;
}): boolean {
  if (!input.responseReceived) return true;
  if (input.code === "generation_request_duplicate") return true;
  if (input.success === true) return false;
  const status = input.status ?? 0;
  return !(status >= 400 && status < 500);
}

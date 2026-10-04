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

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fingerprint(input: PaidGenerationAttemptInput): string {
  return JSON.stringify([input.kind, input.prompt.trim(), input.format.trim()]);
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

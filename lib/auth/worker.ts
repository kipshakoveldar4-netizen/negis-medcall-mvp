import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// CRM11e.2 server-to-server worker authentication.
//
// The background Meta Insights cycle is invoked by a short-lived Railway Cron
// worker, not by a signed-in user. It is authenticated with an HMAC-SHA256
// signature over a canonical request description. The worker secret and the
// signature are never returned in a response and never logged. A workspaceId
// alone is never accepted as proof — the signature is the only credential and
// the server keeps its own workspace allowlist.

export const WORKER_TIMESTAMP_HEADER = "x-negis-worker-timestamp";
export const WORKER_NONCE_HEADER = "x-negis-worker-nonce";
export const WORKER_SIGNATURE_HEADER = "x-negis-worker-signature";
export const WORKER_REQUEST_ID_HEADER = "x-negis-worker-request-id";

// The canonical PATH is a fixed constant shared by the worker and the server so
// the signature does not depend on how the platform normalizes req.url.
export const META_INSIGHTS_BACKGROUND_CYCLE_PATH = "/api/crm/meta-insights-background-cycle";

const DEFAULT_MAX_CLOCK_SKEW_SECONDS = 300;
const MIN_MAX_CLOCK_SKEW_SECONDS = 30;
const MAX_MAX_CLOCK_SKEW_SECONDS = 3600;
const MAX_NONCE_LENGTH = 200;
const MAX_REQUEST_ID_LENGTH = 200;
const SIGNATURE_HEX_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type WorkerAuthStatus = 401 | 403 | 503;

export type WorkerAuthReason =
  | "not_configured"
  | "missing_headers"
  | "malformed_headers"
  | "timestamp_out_of_skew"
  | "invalid_signature";

export class WorkerAuthError extends Error {
  readonly statusCode: WorkerAuthStatus;
  readonly reason: WorkerAuthReason;

  constructor(statusCode: WorkerAuthStatus, reason: WorkerAuthReason, message: string) {
    super(message);
    this.name = "WorkerAuthError";
    this.statusCode = statusCode;
    this.reason = reason;
  }
}

export type WorkerAuthConfig = {
  secret: string;
  workspaceAllowlist: string[];
  maxClockSkewSeconds: number;
};

export type VerifiedWorkerRequest = {
  requestId: string;
  timestamp: number;
  nonce: string;
};

type HeaderBag = Record<string, string | string[] | undefined>;

function readHeader(headers: HeaderBag, name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0].trim() : "";
  return typeof value === "string" ? value.trim() : "";
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export function parseWorkerWorkspaceAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const token of raw.split(/[\s,]+/)) {
    const candidate = token.trim().toLowerCase();
    if (candidate && UUID_PATTERN.test(candidate)) {
      seen.add(candidate);
    }
  }
  return Array.from(seen);
}

// Reads the worker auth configuration from the environment. Throws a 503
// WorkerAuthError when the secret is not configured so the endpoint can reject
// requests instead of running unauthenticated. Never logs or returns the secret.
export function getWorkerAuthConfig(env: NodeJS.ProcessEnv = process.env): WorkerAuthConfig {
  const secret = env.META_INSIGHTS_WORKER_SECRET?.trim() || "";
  if (!secret) {
    throw new WorkerAuthError(503, "not_configured", "Worker authentication is not configured.");
  }

  const skewRaw = Number(env.META_INSIGHTS_WORKER_MAX_CLOCK_SKEW_SECONDS?.trim() ?? "");
  const maxClockSkewSeconds = Number.isFinite(skewRaw) && skewRaw > 0
    ? clampInteger(skewRaw, MIN_MAX_CLOCK_SKEW_SECONDS, MAX_MAX_CLOCK_SKEW_SECONDS)
    : DEFAULT_MAX_CLOCK_SKEW_SECONDS;

  return {
    secret,
    workspaceAllowlist: parseWorkerWorkspaceAllowlist(env.META_INSIGHTS_WORKSPACE_ALLOWLIST),
    maxClockSkewSeconds,
  };
}

export function getWorkerWorkspaceAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseWorkerWorkspaceAllowlist(env.META_INSIGHTS_WORKSPACE_ALLOWLIST);
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

// Canonical payload = METHOD \n PATH \n TIMESTAMP \n NONCE \n SHA256(body).
// Both the worker and the server build this identically before signing.
export function buildWorkerCanonicalPayload(input: {
  method: string;
  path: string;
  timestamp: string | number;
  nonce: string;
  bodySha256: string;
}): string {
  return [
    input.method.toUpperCase(),
    input.path,
    String(input.timestamp),
    input.nonce,
    input.bodySha256,
  ].join("\n");
}

export function signWorkerCanonicalPayload(secret: string, canonicalPayload: string): string {
  return createHmac("sha256", secret).update(canonicalPayload).digest("hex");
}

// Constant-time comparison of two hex signatures. Returns false for any
// malformed input instead of throwing, so timing does not leak validity.
export function verifyWorkerSignatureHex(expectedHex: string, providedHex: string): boolean {
  if (!SIGNATURE_HEX_PATTERN.test(expectedHex) || !SIGNATURE_HEX_PATTERN.test(providedHex)) {
    return false;
  }
  const expected = Buffer.from(expectedHex, "hex");
  const provided = Buffer.from(providedHex, "hex");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export type VerifyWorkerRequestInput = {
  method: string;
  path: string;
  headers: HeaderBag;
  rawBody: Buffer | string;
  nowSeconds?: number;
  config?: WorkerAuthConfig;
};

// Verifies a signed worker request. Throws WorkerAuthError on any failure and
// never includes the secret, the signature, or Meta/Supabase credentials in the
// error. A valid signature is the only accepted proof of authorization.
export function verifyWorkerRequest(input: VerifyWorkerRequestInput): VerifiedWorkerRequest {
  const config = input.config ?? getWorkerAuthConfig();

  const timestampRaw = readHeader(input.headers, WORKER_TIMESTAMP_HEADER);
  const nonce = readHeader(input.headers, WORKER_NONCE_HEADER);
  const signature = readHeader(input.headers, WORKER_SIGNATURE_HEADER);
  const requestId = readHeader(input.headers, WORKER_REQUEST_ID_HEADER);

  if (!timestampRaw || !nonce || !signature || !requestId) {
    throw new WorkerAuthError(401, "missing_headers", "Worker request is missing required signed headers.");
  }
  if (nonce.length > MAX_NONCE_LENGTH || requestId.length > MAX_REQUEST_ID_LENGTH) {
    throw new WorkerAuthError(401, "malformed_headers", "Worker request headers are malformed.");
  }
  if (!/^\d{1,15}$/.test(timestampRaw)) {
    throw new WorkerAuthError(401, "malformed_headers", "Worker request timestamp is malformed.");
  }
  if (!SIGNATURE_HEX_PATTERN.test(signature)) {
    throw new WorkerAuthError(401, "malformed_headers", "Worker request signature is malformed.");
  }

  const timestamp = Number.parseInt(timestampRaw, 10);
  const now = Number.isFinite(input.nowSeconds) ? Math.trunc(input.nowSeconds as number) : Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > config.maxClockSkewSeconds) {
    throw new WorkerAuthError(401, "timestamp_out_of_skew", "Worker request timestamp is outside the allowed window.");
  }

  const bodySha256 = sha256Hex(input.rawBody);
  const canonicalPayload = buildWorkerCanonicalPayload({
    method: input.method,
    path: input.path,
    timestamp: timestampRaw,
    nonce,
    bodySha256,
  });
  const expectedSignature = signWorkerCanonicalPayload(config.secret, canonicalPayload);
  if (!verifyWorkerSignatureHex(expectedSignature, signature)) {
    throw new WorkerAuthError(401, "invalid_signature", "Worker request signature could not be verified.");
  }

  return { requestId, timestamp, nonce };
}

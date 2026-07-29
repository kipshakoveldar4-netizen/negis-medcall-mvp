// Security-2D — the rule that would have stopped the probe.
//
// During Security-2 production verification a POST to /api/crm/leads was sent to
// prove that a workspaceId in the request body is ignored. The proof worked and
// the row stayed: id cc290928-8ad3-4581-bc6b-7ffbe4ddcef0, name
// __probe_never_committed__. A verification pass must be able to demonstrate a
// denial without leaving anything behind, and nothing in the tooling said so.
//
// This module is that rule, in code. Any script that talks to production routes
// its requests through assertVerificationRequestAllowed first. Reads and denial
// probes pass; anything that could change state is refused unless the owner has
// approved a specific operation and it has been added to the allowlist below.

export type VerificationTarget = "local" | "preview" | "production";

export type VerificationRequest = {
  target: VerificationTarget;
  method: string;
  path: string;
  body?: unknown;
  /**
   * The identifier of an owner-approved mutation. Approval is per operation and
   * per phase; it is not a mode the whole run can be switched into.
   */
  operationId?: string;
};

/**
 * Owner-approved production mutations, by operation id.
 *
 * Empty is the correct steady state. An entry here means a specific human
 * approved a specific change, and it should be removed once that change has
 * been made. Adding one to make a test pass defeats the purpose.
 */
export const PRODUCTION_MUTATION_ALLOWLIST: readonly string[] = [];

const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Routes that reach the live Meta account. A verification pass never calls
 * these, at any target, regardless of method: a dry run still constructs a
 * payload against the real ad account, and there is no reason to find out
 * during a check.
 */
const META_LAUNCH_PATHS = [
  "/api/crm/meta-launch",
  "/api/crm/meta-validate",
  "/api/crm/ad-creative-meta-upload",
  "/api/crm/meta-insights-sync",
];

/** Names a probe record would carry. Nothing may create one, anywhere. */
const PROBE_MARKER = /__probe_/i;

export class VerificationBlocked extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "VerificationBlocked";
    this.reason = reason;
  }
}

function containsProbeMarker(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (typeof value === "string") return PROBE_MARKER.test(value);
  if (Array.isArray(value)) return value.some((entry) => containsProbeMarker(entry, depth + 1));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, entry]) => PROBE_MARKER.test(key) || containsProbeMarker(entry, depth + 1),
    );
  }
  return false;
}

/**
 * Throws unless the request is safe to send. Call it before every request a
 * verification script makes — the point is that the refusal happens here, not
 * in a reviewer's memory.
 */
export function assertVerificationRequestAllowed(request: VerificationRequest): void {
  const method = (request.method || "GET").toUpperCase();

  if (containsProbeMarker(request.body) || PROBE_MARKER.test(request.path)) {
    throw new VerificationBlocked(
      "probe_record",
      "Verification must not create probe records; assert the denial instead of writing a row.",
    );
  }

  if (META_LAUNCH_PATHS.some((path) => request.path.startsWith(path))) {
    throw new VerificationBlocked(
      "meta_endpoint",
      `Verification must not call ${request.path}: it reaches the live Meta account.`,
    );
  }

  if (request.target !== "production") return;
  if (READ_ONLY_METHODS.has(method)) return;

  // A mutation against production needs an approved operation id. A denial
  // probe does not: it is expected to be refused before anything is written,
  // and it is sent without the credentials that would let it succeed.
  if (!request.operationId) {
    throw new VerificationBlocked(
      "mutation_without_approval",
      `${method} ${request.path} would change production state. ` +
        "Production verification is read-only unless the owner approves a specific operation id.",
    );
  }

  if (!PRODUCTION_MUTATION_ALLOWLIST.includes(request.operationId)) {
    throw new VerificationBlocked(
      "operation_not_allowlisted",
      `Operation "${request.operationId}" is not in PRODUCTION_MUTATION_ALLOWLIST.`,
    );
  }
}

/** Strips credentials from headers before anything is written to a log. */
export function redactAuthorization(headers: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = /^(authorization|cookie|x-.*-signature|x-.*-secret)$/i.test(key) ? "[redacted]" : value;
  }
  return redacted;
}

/**
 * The only shape a verification run may record for a business endpoint: what
 * the server decided, and how many rows it would have returned. Row contents
 * never leave the response.
 */
export function summarizeVerificationResponse(input: {
  status: number;
  code?: unknown;
  rows?: unknown;
}): { status: number; code: string; rowCount: number | null } {
  return {
    status: input.status,
    code: typeof input.code === "string" ? input.code : "-",
    rowCount: Array.isArray(input.rows) ? input.rows.length : null,
  };
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const workerAuthPath = path.join(repoRoot, "lib", "auth", "worker.ts");
const workerAuth = (await import(`${pathToFileURL(workerAuthPath).href}?test=${Date.now()}`)) as {
  WORKER_TIMESTAMP_HEADER: string;
  WORKER_NONCE_HEADER: string;
  WORKER_SIGNATURE_HEADER: string;
  WORKER_REQUEST_ID_HEADER: string;
  META_INSIGHTS_BACKGROUND_CYCLE_PATH: string;
  WorkerAuthError: new (...args: unknown[]) => Error & { statusCode: number; reason: string };
  sha256Hex(input: string | Buffer): string;
  buildWorkerCanonicalPayload(input: {
    method: string;
    path: string;
    timestamp: string | number;
    nonce: string;
    bodySha256: string;
  }): string;
  signWorkerCanonicalPayload(secret: string, canonicalPayload: string): string;
  verifyWorkerSignatureHex(expectedHex: string, providedHex: string): boolean;
  parseWorkerWorkspaceAllowlist(raw: string | undefined): string[];
  getWorkerAuthConfig(env?: Record<string, string | undefined>): {
    secret: string;
    workspaceAllowlist: string[];
    maxClockSkewSeconds: number;
  };
  verifyWorkerRequest(input: {
    method: string;
    path: string;
    headers: Record<string, string | string[] | undefined>;
    rawBody: Buffer | string;
    nowSeconds?: number;
    config?: { secret: string; workspaceAllowlist: string[]; maxClockSkewSeconds: number };
  }): { requestId: string; timestamp: number; nonce: string };
};

const TEST_SECRET = "unit-test-worker-secret-value";
const CYCLE_PATH = workerAuth.META_INSIGHTS_BACKGROUND_CYCLE_PATH;

function signedHeaders(input: {
  secret: string;
  body: string;
  timestamp: string;
  nonce: string;
  requestId: string;
  path?: string;
}): Record<string, string> {
  const bodySha256 = workerAuth.sha256Hex(input.body);
  const canonical = workerAuth.buildWorkerCanonicalPayload({
    method: "POST",
    path: input.path ?? CYCLE_PATH,
    timestamp: input.timestamp,
    nonce: input.nonce,
    bodySha256,
  });
  const signature = workerAuth.signWorkerCanonicalPayload(input.secret, canonical);
  return {
    [workerAuth.WORKER_TIMESTAMP_HEADER]: input.timestamp,
    [workerAuth.WORKER_NONCE_HEADER]: input.nonce,
    [workerAuth.WORKER_SIGNATURE_HEADER]: signature,
    [workerAuth.WORKER_REQUEST_ID_HEADER]: input.requestId,
  };
}

// ---------------------------------------------------------------------------
// HMAC worker authentication (tests 1–10)
// ---------------------------------------------------------------------------

test("01 sha256Hex matches the known empty-string digest", () => {
  assert.equal(
    workerAuth.sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(workerAuth.sha256Hex(Buffer.from("abc")), workerAuth.sha256Hex("abc"));
});

test("02 canonical payload joins fields with newlines and uppercases the method", () => {
  const canonical = workerAuth.buildWorkerCanonicalPayload({
    method: "post",
    path: CYCLE_PATH,
    timestamp: "1700000000",
    nonce: "nonce-1",
    bodySha256: "deadbeef",
  });
  assert.equal(canonical, `POST\n${CYCLE_PATH}\n1700000000\nnonce-1\ndeadbeef`);
});

test("03 signatures are deterministic and depend on the secret", () => {
  const canonical = "POST\n/x\n1\nn\nsha";
  assert.equal(
    workerAuth.signWorkerCanonicalPayload(TEST_SECRET, canonical),
    workerAuth.signWorkerCanonicalPayload(TEST_SECRET, canonical),
  );
  assert.notEqual(
    workerAuth.signWorkerCanonicalPayload(TEST_SECRET, canonical),
    workerAuth.signWorkerCanonicalPayload("other-secret", canonical),
  );
});

test("04 verifyWorkerSignatureHex is true only for exact hex matches", () => {
  const a = workerAuth.signWorkerCanonicalPayload(TEST_SECRET, "a");
  const b = workerAuth.signWorkerCanonicalPayload(TEST_SECRET, "b");
  assert.equal(workerAuth.verifyWorkerSignatureHex(a, a), true);
  assert.equal(workerAuth.verifyWorkerSignatureHex(a, b), false);
  assert.equal(workerAuth.verifyWorkerSignatureHex(a, "not-hex"), false);
  assert.equal(workerAuth.verifyWorkerSignatureHex(a, `${a}00`), false);
});

test("05 parseWorkerWorkspaceAllowlist validates, lowercases, and dedupes UUIDs", () => {
  const parsed = workerAuth.parseWorkerWorkspaceAllowlist(
    "9EB6F100-BB6A-4F99-9719-E85C34513A03, 9eb6f100-bb6a-4f99-9719-e85c34513a03 not-a-uuid",
  );
  assert.deepEqual(parsed, ["9eb6f100-bb6a-4f99-9719-e85c34513a03"]);
  assert.deepEqual(workerAuth.parseWorkerWorkspaceAllowlist(undefined), []);
});

test("06 getWorkerAuthConfig throws a 503 when the secret is not configured", () => {
  assert.throws(
    () => workerAuth.getWorkerAuthConfig({}),
    (error: unknown) => error instanceof workerAuth.WorkerAuthError && error.statusCode === 503,
  );
});

test("07 getWorkerAuthConfig reads secret, allowlist, and clamps the skew", () => {
  const config = workerAuth.getWorkerAuthConfig({
    META_INSIGHTS_WORKER_SECRET: TEST_SECRET,
    META_INSIGHTS_WORKSPACE_ALLOWLIST: "9eb6f100-bb6a-4f99-9719-e85c34513a03",
  });
  assert.equal(config.secret, TEST_SECRET);
  assert.deepEqual(config.workspaceAllowlist, ["9eb6f100-bb6a-4f99-9719-e85c34513a03"]);
  assert.equal(config.maxClockSkewSeconds, 300);

  const clamped = workerAuth.getWorkerAuthConfig({
    META_INSIGHTS_WORKER_SECRET: TEST_SECRET,
    META_INSIGHTS_WORKER_MAX_CLOCK_SKEW_SECONDS: "999999",
  });
  assert.equal(clamped.maxClockSkewSeconds, 3600);
});

test("08 verifyWorkerRequest accepts a correctly signed request", () => {
  const body = JSON.stringify({ workerId: "crm11e-canary", maxLaunches: 2 });
  const timestamp = "1700000000";
  const headers = signedHeaders({
    secret: TEST_SECRET,
    body,
    timestamp,
    nonce: "nonce-08",
    requestId: "req-08",
  });
  const verified = workerAuth.verifyWorkerRequest({
    method: "POST",
    path: CYCLE_PATH,
    headers,
    rawBody: Buffer.from(body),
    nowSeconds: Number(timestamp),
    config: { secret: TEST_SECRET, workspaceAllowlist: [], maxClockSkewSeconds: 300 },
  });
  assert.equal(verified.requestId, "req-08");
  assert.equal(verified.nonce, "nonce-08");
  assert.equal(verified.timestamp, 1700000000);
});

test("09 verifyWorkerRequest rejects missing signed headers", () => {
  assert.throws(
    () =>
      workerAuth.verifyWorkerRequest({
        method: "POST",
        path: CYCLE_PATH,
        headers: {},
        rawBody: Buffer.from("{}"),
        nowSeconds: 1700000000,
        config: { secret: TEST_SECRET, workspaceAllowlist: [], maxClockSkewSeconds: 300 },
      }),
    (error: unknown) =>
      error instanceof workerAuth.WorkerAuthError &&
      error.statusCode === 401 &&
      error.reason === "missing_headers",
  );
});

test("10 verifyWorkerRequest rejects tampering, skew, and malformed headers", () => {
  const config = { secret: TEST_SECRET, workspaceAllowlist: [], maxClockSkewSeconds: 300 };
  const body = JSON.stringify({ workerId: "crm11e-canary", maxLaunches: 2 });
  const timestamp = "1700000000";
  const base = signedHeaders({ secret: TEST_SECRET, body, timestamp, nonce: "nonce-10", requestId: "req-10" });

  // Tampered body → signature mismatch.
  assert.throws(
    () =>
      workerAuth.verifyWorkerRequest({
        method: "POST",
        path: CYCLE_PATH,
        headers: base,
        rawBody: Buffer.from(`${body} `),
        nowSeconds: Number(timestamp),
        config,
      }),
    (error: unknown) => error instanceof workerAuth.WorkerAuthError && error.reason === "invalid_signature",
  );

  // Timestamp outside skew window.
  assert.throws(
    () =>
      workerAuth.verifyWorkerRequest({
        method: "POST",
        path: CYCLE_PATH,
        headers: base,
        rawBody: Buffer.from(body),
        nowSeconds: Number(timestamp) + 5000,
        config,
      }),
    (error: unknown) => error instanceof workerAuth.WorkerAuthError && error.reason === "timestamp_out_of_skew",
  );

  // Malformed timestamp header.
  assert.throws(
    () =>
      workerAuth.verifyWorkerRequest({
        method: "POST",
        path: CYCLE_PATH,
        headers: { ...base, [workerAuth.WORKER_TIMESTAMP_HEADER]: "not-a-number" },
        rawBody: Buffer.from(body),
        nowSeconds: Number(timestamp),
        config,
      }),
    (error: unknown) => error instanceof workerAuth.WorkerAuthError && error.reason === "malformed_headers",
  );
});

// ---------------------------------------------------------------------------
// Source-marker checks for replay/dedup, the cycle endpoint, and the worker.
// These assert the security-critical wiring without touching production data.
// ---------------------------------------------------------------------------

const crmServerSource = await readFile(path.join(repoRoot, "lib", "crm", "server.ts"), "utf8");
const apiSource = await readFile(path.join(repoRoot, "api", "crm", "[...path].ts"), "utf8");
const workerSource = await readFile(
  path.join(repoRoot, "artifacts", "meta-insights-worker", "src", "index.ts"),
  "utf8",
);
const workerPackage = await readFile(
  path.join(repoRoot, "artifacts", "meta-insights-worker", "package.json"),
  "utf8",
);

function sliceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing anchor: ${start}`);
  assert.notEqual(to, -1, `missing anchor: ${end}`);
  return source.slice(from, to);
}

const coreSlice = sliceBetween(
  crmServerSource,
  "async function syncMetaInsightsForLaunch",
  "type ClaimedInsightsState",
);
const cycleSlice = sliceBetween(
  crmServerSource,
  "export async function handleMetaInsightsBackgroundCycle",
  "export async function handleMetaInsightsSync(",
);
const finalizeSlice = sliceBetween(
  crmServerSource,
  "async function finalizeBackgroundSchedulerState",
  "function readWorkerRawBody",
);

// Replay / dedup (tests 11–12)
test("11 background sync keys runs by request_key and returns already_processed", () => {
  assert.ok(coreSlice.includes('.eq("request_key", requestKey)'));
  assert.ok(coreSlice.includes('status: "already_processed"'));
  assert.ok(coreSlice.includes("bg:") === false, "request key prefix belongs to the handler, not the core");
});

test("12 duplicate insert on a request_key is treated as already_processed, not a duplicate run", () => {
  assert.ok(crmServerSource.includes("function isUniqueViolationError"));
  assert.ok(crmServerSource.includes('=== "23505"'));
  assert.ok(coreSlice.includes("isUniqueViolationError(pendingRunError)"));
  assert.ok(cycleSlice.includes("requestKey: `bg:${verified.requestId}:${state.metaCampaignLaunchId}`"));
});

// Background cycle endpoint (tests 13–26)
test("13 the cycle endpoint is registered in the existing catch-all and adds no new api file", () => {
  assert.ok(apiSource.includes('resource === "meta-insights-background-cycle"'));
  assert.ok(apiSource.includes("handleMetaInsightsBackgroundCycle(req, res)"));
  assert.ok(apiSource.includes("rawBody = rawBody"), "raw body must be preserved for HMAC");
});

test("14 the cycle endpoint requires HMAC and never requires a user Bearer", () => {
  assert.ok(cycleSlice.includes("getWorkerAuthConfig()"));
  assert.ok(cycleSlice.includes("verifyWorkerRequest("));
  assert.ok(!cycleSlice.includes("requireWorkspaceAdmin"), "background cycle must not use user admin auth");
});

test("15 the cycle intersects requested workspaceIds with the server allowlist", () => {
  assert.ok(cycleSlice.includes("authConfig.workspaceAllowlist"));
  assert.ok(cycleSlice.includes("allowlist.includes(id)"));
  assert.ok(cycleSlice.includes("effectiveWorkspaceIds"));
});

test("16 maxLaunches defaults to 2 with an absolute maximum of 10", () => {
  assert.ok(crmServerSource.includes("META_INSIGHTS_BACKGROUND_MAX_LAUNCHES_DEFAULT = 2"));
  assert.ok(crmServerSource.includes("META_INSIGHTS_BACKGROUND_MAX_LAUNCHES_ABSOLUTE = 10"));
  assert.ok(cycleSlice.includes("META_INSIGHTS_BACKGROUND_MAX_LAUNCHES_ABSOLUTE"));
});

test("17 the cycle uses a 120s lease", () => {
  assert.ok(crmServerSource.includes("META_INSIGHTS_BACKGROUND_LEASE_SECONDS = 120"));
  assert.ok(cycleSlice.includes("p_lease_seconds: META_INSIGHTS_BACKGROUND_LEASE_SECONDS"));
});

test("18 the cycle claims work through the atomic claim RPC", () => {
  assert.ok(cycleSlice.includes('supabase.rpc("claim_due_meta_insights_sync_states"'));
  assert.ok(cycleSlice.includes("p_worker_id: workerId"));
  assert.ok(cycleSlice.includes("p_workspace_ids: effectiveWorkspaceIds"));
});

test("19 claimed launches are processed sequentially (concurrency 1)", () => {
  assert.ok(cycleSlice.includes("for (const row of claimedRows)"));
  assert.ok(!cycleSlice.includes("Promise.all"), "canary concurrency must stay sequential");
});

test("20 the cycle returns only a safe summary shape", () => {
  for (const key of ["requestId", "claimed", "succeeded", "failed", "skipped", "results"]) {
    assert.ok(cycleSlice.includes(`${key}:`) || cycleSlice.includes(`${key} `), `summary missing ${key}`);
  }
});

test("21 each result exposes only safe fields", () => {
  assert.ok(cycleSlice.includes("metaCampaignLaunchId: state.metaCampaignLaunchId"));
  assert.ok(cycleSlice.includes("runId: outcome.runId"));
  assert.ok(cycleSlice.includes("status: outcome.status"));
  assert.ok(cycleSlice.includes("rowsUpserted: outcome.rowsUpserted"));
  assert.ok(cycleSlice.includes("safeErrorCode: outcome.error?.code ?? null"));
});

test("22 failure backoff follows 15min / 1h / 6h", () => {
  assert.ok(crmServerSource.includes("function backoffSecondsForFailureCount"));
  assert.ok(crmServerSource.includes("return 15 * 60"));
  assert.ok(crmServerSource.includes("return 60 * 60"));
  assert.ok(crmServerSource.includes("return 6 * 60 * 60"));
});

test("23 repeated meta_auth/meta_permission failures pause with a safe reason", () => {
  assert.ok(finalizeSlice.includes('errorCode === "meta_auth"'));
  assert.ok(finalizeSlice.includes('errorCode === "meta_permission"'));
  assert.ok(finalizeSlice.includes("failureCount >= 2"));
  assert.ok(finalizeSlice.includes("paused_until"));
  assert.ok(finalizeSlice.includes("pause_reason: `${errorCode}_repeated`"));
});

test("24 success clears the lease, resets failures, and re-arms the PAUSED cadence", () => {
  assert.ok(crmServerSource.includes("META_INSIGHTS_BACKGROUND_PAUSED_NEXT_SYNC_HOURS = 24"));
  assert.ok(finalizeSlice.includes("consecutive_failure_count: 0"));
  assert.ok(finalizeSlice.includes("last_error_code: null"));
  assert.ok(finalizeSlice.includes("lease_owner: null"));
  assert.ok(finalizeSlice.includes("lease_expires_at: null"));
});

test("25 completeness is evaluated with an explicit 36h freshness SLA and tz fallback", () => {
  assert.ok(crmServerSource.includes("META_INSIGHTS_BACKGROUND_FRESHNESS_SLA_HOURS = 36"));
  assert.ok(finalizeSlice.includes("evaluateMetaInsightsCompleteness("));
  assert.ok(finalizeSlice.includes("outcome.timezoneFallback ? \"partial\""));
});

test("26 the cycle handler and core never expose raw secrets", () => {
  for (const forbidden of [
    "SERVICE_ROLE",
    "accessToken",
    "app_secret",
    "appSecret",
    "META_ACCESS_TOKEN",
    "paging",
  ]) {
    assert.ok(!cycleSlice.includes(forbidden), `cycle handler must not reference ${forbidden}`);
    assert.ok(!coreSlice.includes(forbidden), `sync core must not reference ${forbidden}`);
  }
  const authError = sliceBetween(crmServerSource, "function sendWorkerAuthError", "// POST /api/crm");
  assert.ok(!authError.includes("error.reason"), "auth error must not echo the failure detail");
});

// Separate Railway Cron worker (tests 27–30)
test("27 the worker runs a single cycle with no polling loop", () => {
  assert.ok(workerSource.includes("async function runCycle"));
  assert.ok(!workerSource.includes("while ("), "worker must not poll in a loop");
  assert.ok(workerSource.includes("process.exit(0)"));
  assert.ok(workerSource.includes("process.exit(1)"));
});

test("28 the worker never holds Meta or Supabase service secrets", () => {
  for (const forbidden of ["META_ACCESS_TOKEN", "META_APP_SECRET", "SUPABASE_SERVICE_ROLE_KEY"]) {
    assert.ok(!workerSource.includes(forbidden), `worker must not reference ${forbidden}`);
  }
});

test("29 the worker signs the same canonical payload the server verifies", () => {
  assert.ok(workerSource.includes('"/api/crm/meta-insights-background-cycle"'));
  assert.ok(workerSource.includes('"x-negis-worker-signature"'));
  assert.ok(workerSource.includes("createHmac(\"sha256\", secret)"));
  assert.ok(workerSource.includes("NEGIS_API_BASE_URL"));
  assert.ok(workerSource.includes("META_INSIGHTS_WORKER_SECRET"));
  assert.ok(workerSource.includes('readPositiveInteger("META_INSIGHTS_MAX_LAUNCHES", 2)'));
});

test("30 the worker is a separate package from the video worker", () => {
  const pkg = JSON.parse(workerPackage) as { name?: string; dependencies?: Record<string, string> };
  assert.equal(pkg.name, "@workspace/meta-insights-worker");
  assert.notEqual(pkg.name, "@workspace/video-worker");
  // Self-contained: no workspace dependencies to keep the Dockerfile npm-only.
  assert.equal(pkg.dependencies, undefined);
});

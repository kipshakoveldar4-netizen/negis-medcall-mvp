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
  resolveSignedRawBody(source: { rawBody?: unknown; body?: unknown }): Buffer;
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
  // The reason may be used for a server-side log, but must never reach the HTTP
  // response. Check the response payload (from `return sendJson`) specifically.
  const authError = sliceBetween(crmServerSource, "function sendWorkerAuthError", "// POST /api/crm");
  const authResponse = authError.slice(authError.indexOf("return sendJson"));
  assert.ok(!authResponse.includes("reason"), "auth error response must not echo the failure reason");
  assert.ok(authResponse.includes('code: "worker_unauthorized"'));
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

// ---------------------------------------------------------------------------
// CRM11e.2 hotfix — runtime-independent body verification (tests 31–50).
// These use the REAL lib/auth/worker helpers (signer + verifier + resolver) and
// never re-implement canonicalization inside the test.
// ---------------------------------------------------------------------------

// A real 64-character base64url secret (dummy — never a production value).
const B64URL_SECRET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";
const baseConfig = { secret: B64URL_SECRET, workspaceAllowlist: [] as string[], maxClockSkewSeconds: 300 };
const PROD_TS = "1700000000";
// The exact production-shape body: POST /api/crm/meta-insights-background-cycle.
const PROD_BODY = JSON.stringify({
  workerId: "crm11e-canary",
  maxLaunches: 2,
  workspaceIds: ["9eb6f100-bb6a-4f99-9719-e85c34513a03"],
});

function prodHeaders(input?: { secret?: string; body?: string; path?: string; nonce?: string }) {
  return signedHeaders({
    secret: input?.secret ?? B64URL_SECRET,
    body: input?.body ?? PROD_BODY,
    timestamp: PROD_TS,
    nonce: input?.nonce ?? "nonce-hotfix",
    requestId: "req-hotfix",
    path: input?.path ?? CYCLE_PATH,
  });
}

// Resolve the raw body exactly as the server does, then run the real verifier.
function verifyResolved(
  source: { rawBody?: unknown; body?: unknown },
  opts?: {
    headers?: Record<string, string | string[] | undefined>;
    method?: string;
    path?: string;
    config?: { secret: string; workspaceAllowlist: string[]; maxClockSkewSeconds: number };
  },
) {
  const rawBody = workerAuth.resolveSignedRawBody(source);
  return workerAuth.verifyWorkerRequest({
    method: opts?.method ?? "POST",
    path: opts?.path ?? CYCLE_PATH,
    headers: opts?.headers ?? prodHeaders(),
    rawBody,
    nowSeconds: Number(PROD_TS),
    config: opts?.config ?? baseConfig,
  });
}

test("31 exact rawBody Buffer round-trip passes", () => {
  const v = verifyResolved({ rawBody: Buffer.from(PROD_BODY, "utf8") });
  assert.equal(v.requestId, "req-hotfix");
});

test("32 rawBody string round-trip passes", () => {
  const v = verifyResolved({ rawBody: PROD_BODY });
  assert.equal(v.nonce, "nonce-hotfix");
});

test("33 Uint8Array rawBody round-trip passes", () => {
  const v = verifyResolved({ rawBody: new Uint8Array(Buffer.from(PROD_BODY, "utf8")) });
  assert.equal(v.requestId, "req-hotfix");
});

test("34 parsed object only (no rawBody) passes — the production runtime case", () => {
  const v = verifyResolved({ body: JSON.parse(PROD_BODY) });
  assert.equal(v.requestId, "req-hotfix");
});

test("35 parsed string body only passes", () => {
  const v = verifyResolved({ body: PROD_BODY });
  assert.equal(v.requestId, "req-hotfix");
});

test("36 tampered parsed body fails", () => {
  const tampered = { ...JSON.parse(PROD_BODY), maxLaunches: 9 };
  assert.throws(
    () => verifyResolved({ body: tampered }),
    (e: unknown) => e instanceof workerAuth.WorkerAuthError && e.reason === "invalid_signature",
  );
});

test("37 missing rawBody and missing body fails authentication safely", () => {
  assert.throws(
    () => verifyResolved({}),
    (e: unknown) => e instanceof workerAuth.WorkerAuthError && e.reason === "invalid_signature",
  );
});

test("38 trailing-slash path fails", () => {
  assert.throws(
    () => verifyResolved({ rawBody: PROD_BODY }, { path: `${CYCLE_PATH}/` }),
    (e: unknown) => e instanceof workerAuth.WorkerAuthError && e.reason === "invalid_signature",
  );
});

test("39 different method fails", () => {
  assert.throws(
    () => verifyResolved({ rawBody: PROD_BODY }, { method: "PUT" }),
    (e: unknown) => e instanceof workerAuth.WorkerAuthError && e.reason === "invalid_signature",
  );
});

test("40 different body key order fails unless the signer signed that exact order", () => {
  const reordered = JSON.stringify({
    maxLaunches: 2,
    workerId: "crm11e-canary",
    workspaceIds: ["9eb6f100-bb6a-4f99-9719-e85c34513a03"],
  });
  // Signature was for PROD_BODY (workerId first); a reordered body must not verify.
  assert.throws(
    () => verifyResolved({ rawBody: reordered }),
    (e: unknown) => e instanceof workerAuth.WorkerAuthError && e.reason === "invalid_signature",
  );
  // But signing the reordered order explicitly and sending it does verify.
  const v = verifyResolved({ rawBody: reordered }, { headers: prodHeaders({ body: reordered }) });
  assert.equal(v.requestId, "req-hotfix");
});

test("41 whitespace-modified raw JSON fails when the signature was for compact JSON", () => {
  const pretty = JSON.stringify(JSON.parse(PROD_BODY), null, 2);
  assert.notEqual(pretty, PROD_BODY);
  assert.throws(
    () => verifyResolved({ rawBody: pretty }),
    (e: unknown) => e instanceof workerAuth.WorkerAuthError && e.reason === "invalid_signature",
  );
});

test("42 CRLF inside a JSON string value round-trips correctly", () => {
  const crlfBody = JSON.stringify({
    workerId: "crm11e\r\ncanary",
    maxLaunches: 2,
    workspaceIds: ["9eb6f100-bb6a-4f99-9719-e85c34513a03"],
  });
  const headers = prodHeaders({ body: crlfBody });
  // Both the exact bytes and the parsed-body fallback reproduce the escaped \r\n.
  assert.equal(verifyResolved({ rawBody: crlfBody }, { headers }).requestId, "req-hotfix");
  assert.equal(verifyResolved({ body: JSON.parse(crlfBody) }, { headers }).requestId, "req-hotfix");
});

test("43 a 64-character base64url secret passes", () => {
  assert.equal(B64URL_SECRET.length, 64);
  assert.match(B64URL_SECRET, /^[A-Za-z0-9_-]{64}$/);
  assert.equal(verifyResolved({ rawBody: PROD_BODY }).requestId, "req-hotfix");
});

test("44 a secret with different bytes fails", () => {
  const otherSecret = `${B64URL_SECRET.slice(0, 63)}X`;
  assert.throws(
    () => verifyResolved({ rawBody: PROD_BODY }, { config: { ...baseConfig, secret: otherSecret } }),
    (e: unknown) => e instanceof workerAuth.WorkerAuthError && e.reason === "invalid_signature",
  );
});

test("45 query-string path does not match the bare endpoint pathname contract", () => {
  // The signed path is the exact constant; a path carrying a query must not verify.
  assert.throws(
    () => verifyResolved({ rawBody: PROD_BODY }, { path: `${CYCLE_PATH}?workspaceId=x` }),
    (e: unknown) => e instanceof workerAuth.WorkerAuthError && e.reason === "invalid_signature",
  );
  assert.equal(verifyResolved({ rawBody: PROD_BODY }, { path: CYCLE_PATH }).requestId, "req-hotfix");
});

test("46 the HTTP auth response stays generic and does not expose WorkerAuthError.reason", () => {
  const authError = sliceBetween(crmServerSource, "function sendWorkerAuthError", "// POST /api/crm");
  const authResponse = authError.slice(authError.indexOf("return sendJson"));
  assert.ok(!authResponse.includes("reason"), "response payload must not include the reason");
  assert.ok(authResponse.includes('code: "worker_unauthorized"'));
});

test("47 the safe auth log statement contains no secret, signature, or body", () => {
  const authError = sliceBetween(crmServerSource, "function sendWorkerAuthError", "// POST /api/crm");
  const logStart = authError.indexOf("console.warn(");
  assert.notEqual(logStart, -1, "a safe server-side log must exist");
  const logStmt = authError.slice(logStart, authError.indexOf(");", logStart) + 2);
  assert.ok(logStmt.includes("reason="), "the log must carry the safe reason code");
  for (const forbidden of ["secret", "signature", "canonical", "bodySha", "Authorization", "accessToken", "nonce"]) {
    assert.ok(!logStmt.includes(forbidden), `auth log statement must not reference ${forbidden}`);
  }
});

test("48 the worker hashes and sends the exact same body variable", () => {
  assert.ok(workerSource.includes("const bodyString = JSON.stringify("));
  assert.ok(workerSource.includes("sha256Hex(bodyString)"));
  assert.ok(workerSource.includes("body: bodyString"));
  // Exactly one body serialization — never stringified twice.
  assert.equal(workerSource.split("const bodyString = JSON.stringify(").length - 1, 1);
});

test("49 replay/dedup wiring remains intact", () => {
  assert.ok(coreSlice.includes('.eq("request_key", requestKey)'));
  assert.ok(coreSlice.includes('status: "already_processed"'));
  assert.ok(cycleSlice.includes("requestKey: `bg:${verified.requestId}:${state.metaCampaignLaunchId}`"));
});

test("50 manual owner/admin sync auth is unchanged", () => {
  const manual = sliceBetween(
    crmServerSource,
    "export async function handleMetaInsightsSync(",
    "export async function handleMetaCampaignInsights",
  );
  assert.ok(manual.includes("requireWorkspaceAdmin(req, workspaceId)"));
  assert.ok(!manual.includes('success("demo"'));
});

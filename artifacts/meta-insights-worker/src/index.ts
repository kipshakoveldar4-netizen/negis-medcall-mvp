import { createHash, createHmac, randomUUID } from "node:crypto";
import os from "node:os";

// CRM11e.2 Meta Insights background worker.
//
// This is a short-lived Railway Cron worker. It runs exactly one cycle: it signs
// an HMAC-SHA256 request and POSTs it to the production CRM catch-all endpoint
// `/api/crm/meta-insights-background-cycle`, prints a safe summary, and exits.
// It performs no polling loop and holds no long-lived state.
//
// This worker intentionally does NOT contain and must never read the Meta access
// token, the Meta app secret, or the Supabase service-role key. Those secrets
// live only on the Vercel deployment behind the authenticated endpoint. The only
// secret this worker holds is the shared worker HMAC secret.

// Canonical request description shared with lib/auth/worker.ts. Keep in sync.
const BACKGROUND_CYCLE_PATH = "/api/crm/meta-insights-background-cycle";
const TIMESTAMP_HEADER = "x-negis-worker-timestamp";
const NONCE_HEADER = "x-negis-worker-nonce";
const SIGNATURE_HEADER = "x-negis-worker-signature";
const REQUEST_ID_HEADER = "x-negis-worker-request-id";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type WorkerConfig = {
  apiBaseUrl: string;
  workerSecret: string;
  workspaceIds: string[];
  workerId: string;
  maxLaunches: number;
  requestTimeoutMs: number;
};

function readString(key: string, fallback = ""): string {
  return process.env[key]?.trim() || fallback;
}

function readPositiveInteger(key: string, fallback: number): number {
  const value = Number(process.env[key]?.trim() ?? "");
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function parseWorkspaceIds(raw: string): string[] {
  const seen = new Set<string>();
  for (const token of raw.split(/[\s,]+/)) {
    const candidate = token.trim().toLowerCase();
    if (candidate && UUID_PATTERN.test(candidate)) seen.add(candidate);
  }
  return Array.from(seen);
}

function loadConfig(): WorkerConfig {
  const apiBaseUrl = readString("NEGIS_API_BASE_URL").replace(/\/+$/, "");
  const workerSecret = readString("META_INSIGHTS_WORKER_SECRET");
  if (!apiBaseUrl || !workerSecret) {
    throw new Error("NEGIS_API_BASE_URL and META_INSIGHTS_WORKER_SECRET are required");
  }
  if (!/^https?:\/\//i.test(apiBaseUrl)) {
    throw new Error("NEGIS_API_BASE_URL must be an absolute http(s) URL");
  }

  return {
    apiBaseUrl,
    workerSecret,
    workspaceIds: parseWorkspaceIds(readString("META_INSIGHTS_WORKSPACE_IDS")),
    workerId: readString("META_INSIGHTS_WORKER_ID", `meta-insights-worker-${os.hostname()}-${process.pid}`),
    maxLaunches: readPositiveInteger("META_INSIGHTS_MAX_LAUNCHES", 2),
    requestTimeoutMs: readPositiveInteger("META_INSIGHTS_REQUEST_TIMEOUT_MS", 60_000),
  };
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function signCanonicalPayload(secret: string, canonicalPayload: string): string {
  return createHmac("sha256", secret).update(canonicalPayload).digest("hex");
}

type SafeCycleResult = {
  metaCampaignLaunchId?: unknown;
  runId?: unknown;
  status?: unknown;
  rowsUpserted?: unknown;
  safeErrorCode?: unknown;
};

type SafeCycleSummary = {
  success?: unknown;
  requestId?: unknown;
  claimed?: unknown;
  succeeded?: unknown;
  failed?: unknown;
  skipped?: unknown;
  results?: SafeCycleResult[];
};

async function runCycle(config: WorkerConfig): Promise<void> {
  const requestId = randomUUID();
  const nonce = randomUUID();
  const timestamp = Math.floor(Date.now() / 1000).toString();

  // Serialize the body ONCE and use this exact string for both the HMAC hash and
  // the fetch body — never stringify twice. Property order ({ workerId,
  // maxLaunches, workspaceIds? }) is part of the signed-body contract: the server
  // verifier reproduces these same bytes from a parsed body via JSON.stringify, so
  // reordering or reshaping the payload would break signature verification.
  const bodyString = JSON.stringify({
    workerId: config.workerId,
    maxLaunches: config.maxLaunches,
    ...(config.workspaceIds.length > 0 ? { workspaceIds: config.workspaceIds } : {}),
  });

  const canonicalPayload = [
    "POST",
    BACKGROUND_CYCLE_PATH,
    timestamp,
    nonce,
    sha256Hex(bodyString),
  ].join("\n");
  const signature = signCanonicalPayload(config.workerSecret, canonicalPayload);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  let response: Response;
  try {
    response = await fetch(`${config.apiBaseUrl}${BACKGROUND_CYCLE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TIMESTAMP_HEADER]: timestamp,
        [NONCE_HEADER]: nonce,
        [SIGNATURE_HEADER]: signature,
        [REQUEST_ID_HEADER]: requestId,
      },
      body: bodyString,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const rawText = await response.text();
  let summary: SafeCycleSummary | null = null;
  try {
    summary = rawText.trim() ? (JSON.parse(rawText) as SafeCycleSummary) : null;
  } catch {
    summary = null;
  }

  if (!response.ok || !summary || summary.success !== true) {
    // Print status and safe error code only — never the response body verbatim,
    // which could carry unexpected content.
    const code = summary && typeof (summary as { code?: unknown }).code === "string"
      ? (summary as { code: string }).code
      : "unknown";
    console.error(
      `[meta-insights-worker] cycle failed: http ${response.status} code ${code} requestId ${requestId}`,
    );
    throw new Error(`Background cycle returned a non-success response (http ${response.status})`);
  }

  const results = Array.isArray(summary.results) ? summary.results : [];
  console.log(
    `[meta-insights-worker] cycle ok requestId ${String(summary.requestId ?? requestId)} ` +
      `claimed ${Number(summary.claimed ?? 0)} succeeded ${Number(summary.succeeded ?? 0)} ` +
      `failed ${Number(summary.failed ?? 0)} skipped ${Number(summary.skipped ?? 0)}`,
  );
  for (const result of results) {
    console.log(
      `[meta-insights-worker]   launch ${String(result.metaCampaignLaunchId ?? "unknown")} ` +
        `run ${String(result.runId ?? "none")} status ${String(result.status ?? "unknown")} ` +
        `rows ${Number(result.rowsUpserted ?? 0)} code ${String(result.safeErrorCode ?? "none")}`,
    );
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(
    `[meta-insights-worker] starting single cycle as ${config.workerId} ` +
      `(maxLaunches ${config.maxLaunches}, workspaces ${config.workspaceIds.length || "server-allowlist"})`,
  );
  await runCycle(config);
  console.log("[meta-insights-worker] cycle complete, exiting");
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(`[meta-insights-worker] fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const completenessPath = path.join(
  repoRoot,
  "lib",
  "meta",
  "insightsCompleteness.ts",
);
const importedCompleteness = await import(
  `${pathToFileURL(completenessPath).href}?test=${Date.now()}`
);

type DateRange = { dateStart: string; dateStop: string };
type EvaluateMetaInsightsCompletenessInput = {
  launchEligible: boolean;
  configurationAvailable: boolean;
  now: string;
  accountTimeZone: string;
  requiredRange: DateRange;
  freshnessDeadline: string;
  latestRun?: { status: string; coverageComplete?: boolean } | null;
  lease?: { leaseExpiresAt: string | null } | null;
  successfulRuns: Array<
    DateRange & { coverageComplete: boolean; completedAt: string | null }
  >;
  insightRowCountInRequiredRange: number;
};
type CompletenessResult = {
  status: string;
  reasonCode: string;
  coveredDateRanges: DateRange[];
  unknownGaps: DateRange[];
  lastCompleteDate: string | null;
};
type CompletenessModule = {
  evaluateMetaInsightsCompleteness(
    input: EvaluateMetaInsightsCompletenessInput,
  ): CompletenessResult;
  findMetaInsightsUnknownGaps(
    requiredRange: DateRange,
    coveredRanges: DateRange[],
  ): DateRange[];
  isMetaInsightsLeaseActive(
    lease: { leaseExpiresAt: string | null } | null | undefined,
    now: string,
  ): boolean;
  mergeMetaInsightsDateRanges(ranges: DateRange[]): DateRange[];
};
const completeness = ((importedCompleteness as { default?: unknown }).default ??
  importedCompleteness) as CompletenessModule;
const {
  evaluateMetaInsightsCompleteness,
  findMetaInsightsUnknownGaps,
  isMetaInsightsLeaseActive,
  mergeMetaInsightsDateRanges,
} = completeness;

const baseInput: EvaluateMetaInsightsCompletenessInput = {
  launchEligible: true,
  configurationAvailable: true,
  now: "2026-07-14T12:00:00.000Z",
  accountTimeZone: "Asia/Almaty",
  requiredRange: { dateStart: "2026-07-10", dateStop: "2026-07-12" },
  freshnessDeadline: "2026-07-14T00:00:00.000Z",
  latestRun: null,
  lease: null,
  successfulRuns: [],
  insightRowCountInRequiredRange: 0,
};

function evaluate(
  overrides: Partial<EvaluateMetaInsightsCompletenessInput> = {},
) {
  return evaluateMetaInsightsCompleteness({ ...baseInput, ...overrides });
}

function completeRun(
  dateStart: string,
  dateStop: string,
  completedAt = "2026-07-14T10:00:00.000Z",
) {
  return { dateStart, dateStop, coverageComplete: true, completedAt };
}

test("eligible launch without complete sync is never_synced", () => {
  const result = evaluate();
  assert.equal(result.status, "never_synced");
  assert.deepEqual(result.unknownGaps, [baseInput.requiredRange]);
});

test("active non-expired lease is syncing", () => {
  const result = evaluate({
    lease: { leaseExpiresAt: "2026-07-14T12:05:00.000Z" },
    successfulRuns: [completeRun("2026-07-10", "2026-07-10")],
  });
  assert.equal(result.status, "syncing");
  assert.equal(result.reasonCode, "active_lease");
  assert.deepEqual(result.coveredDateRanges, [
    { dateStart: "2026-07-10", dateStop: "2026-07-10" },
  ]);
});

test("expired lease can be reclaimed and does not force syncing", () => {
  const lease = { leaseExpiresAt: "2026-07-14T11:59:59.000Z" };
  assert.equal(isMetaInsightsLeaseActive(lease, baseInput.now), false);
  const result = evaluate({ lease, latestRun: { status: "running" } });
  assert.equal(result.status, "never_synced");
});

test("fully covered successful zero-row range is zero_delivery", () => {
  const result = evaluate({
    successfulRuns: [completeRun("2026-07-10", "2026-07-12")],
    insightRowCountInRequiredRange: 0,
  });
  assert.equal(result.status, "zero_delivery");
  assert.equal(result.reasonCode, "full_range_zero_rows");
  assert.deepEqual(result.unknownGaps, []);
  assert.equal(result.lastCompleteDate, "2026-07-12");
  assert.equal(
    "rows" in result,
    false,
    "evaluator must not create synthetic zero rows",
  );
});

test("fully covered fresh range with rows is current", () => {
  const result = evaluate({
    successfulRuns: [completeRun("2026-07-10", "2026-07-12")],
    insightRowCountInRequiredRange: 3,
  });
  assert.equal(result.status, "current");
  assert.equal(result.reasonCode, "full_range_fresh");
});

test("partially covered range is partial", () => {
  const result = evaluate({
    successfulRuns: [completeRun("2026-07-10", "2026-07-10")],
  });
  assert.equal(result.status, "partial");
  assert.deepEqual(result.unknownGaps, [
    { dateStart: "2026-07-11", dateStop: "2026-07-12" },
  ]);
  assert.equal(result.lastCompleteDate, "2026-07-10");
});

test("internal uncovered day is reported as an unknown gap", () => {
  const result = evaluate({
    successfulRuns: [
      completeRun("2026-07-10", "2026-07-10"),
      completeRun("2026-07-12", "2026-07-12"),
    ],
    insightRowCountInRequiredRange: 2,
  });
  assert.equal(result.status, "partial");
  assert.deepEqual(result.unknownGaps, [
    { dateStart: "2026-07-11", dateStop: "2026-07-11" },
  ]);
});

test("old complete coverage is stale", () => {
  const result = evaluate({
    successfulRuns: [
      completeRun("2026-07-10", "2026-07-12", "2026-07-13T23:59:59.000Z"),
    ],
    insightRowCountInRequiredRange: 3,
  });
  assert.equal(result.status, "stale");
  assert.equal(result.reasonCode, "coverage_older_than_sla");
});

test("failed latest attempt without fresh complete coverage is failed", () => {
  const result = evaluate({ latestRun: { status: "failed" } });
  assert.equal(result.status, "failed");
  assert.equal(result.reasonCode, "latest_attempt_failed");
});

test("failed attempt does not erase fresh complete coverage", () => {
  const result = evaluate({
    latestRun: { status: "failed" },
    successfulRuns: [completeRun("2026-07-10", "2026-07-12")],
    insightRowCountInRequiredRange: 2,
  });
  assert.equal(result.status, "current");
});

test("ineligible or unconfigured launches are unavailable", () => {
  assert.equal(evaluate({ launchEligible: false }).status, "unavailable");
  assert.equal(
    evaluate({ configurationAvailable: false }).status,
    "unavailable",
  );
});

test("overlapping successful ranges merge deterministically", () => {
  assert.deepEqual(
    mergeMetaInsightsDateRanges([
      { dateStart: "2026-07-10", dateStop: "2026-07-11" },
      { dateStart: "2026-07-11", dateStop: "2026-07-13" },
    ]),
    [{ dateStart: "2026-07-10", dateStop: "2026-07-13" }],
  );
});

test("adjacent successful ranges merge deterministically", () => {
  assert.deepEqual(
    mergeMetaInsightsDateRanges([
      { dateStart: "2026-07-10", dateStop: "2026-07-10" },
      { dateStart: "2026-07-11", dateStop: "2026-07-12" },
    ]),
    [{ dateStart: "2026-07-10", dateStop: "2026-07-12" }],
  );
});

test("timezone and account-local date boundaries stay explicit", () => {
  const result = evaluate({ accountTimeZone: "Pacific/Kiritimati" });
  assert.deepEqual(result.unknownGaps, [
    { dateStart: "2026-07-10", dateStop: "2026-07-12" },
  ]);
  assert.throws(
    () => evaluate({ accountTimeZone: " " }),
    /accountTimeZone must be explicit/,
  );
  assert.throws(
    () => evaluate({ now: "2026-07-14T12:00:00" }),
    /now must include an explicit timezone offset/,
  );
  assert.deepEqual(
    findMetaInsightsUnknownGaps(
      { dateStart: "2026-07-10", dateStop: "2026-07-12" },
      [{ dateStart: "2026-07-10", dateStop: "2026-07-11" }],
    ),
    [{ dateStart: "2026-07-12", dateStop: "2026-07-12" }],
  );
});

test("incomplete successful pagination remains partial", () => {
  const result = evaluate({
    latestRun: { status: "succeeded", coverageComplete: false },
  });
  assert.equal(result.status, "partial");
  assert.equal(result.reasonCode, "incomplete_sync");
});

test("migration claim contract prevents duplicate concurrent claims", async () => {
  const migration = await readFile(
    path.join(
      repoRoot,
      "migrations",
      "022_meta_insights_scheduler_foundation.sql",
    ),
    "utf8",
  );
  assert.match(migration, /unique \(workspace_id, meta_campaign_launch_id\)/i);
  assert.match(migration, /for update skip locked/i);
  assert.match(
    migration,
    /state\.lease_expires_at is null or state\.lease_expires_at <= now\(\)/i,
  );
});

test("migration claim contract honors workspace allowlist and expired lease reclaim", async () => {
  const migration = await readFile(
    path.join(
      repoRoot,
      "migrations",
      "022_meta_insights_scheduler_foundation.sql",
    ),
    "utf8",
  );
  assert.match(
    migration,
    /p_workspace_ids is null or state\.workspace_id = any\(p_workspace_ids\)/i,
  );
  assert.match(
    migration,
    /state\.lease_expires_at is null or state\.lease_expires_at <= now\(\)/i,
  );
  assert.match(
    migration,
    /least\(greatest\(coalesce\(p_limit, 1\), 1\), 50\)/i,
  );
});

test("request key uniqueness prevents duplicate scheduler execution", async () => {
  const migration = await readFile(
    path.join(
      repoRoot,
      "migrations",
      "022_meta_insights_scheduler_foundation.sql",
    ),
    "utf8",
  );
  assert.match(
    migration,
    /unique index[\s\S]+workspace_id, request_key[\s\S]+where request_key is not null/i,
  );
});

test("existing manual sync runs remain compatible", async () => {
  const migration = await readFile(
    path.join(
      repoRoot,
      "migrations",
      "022_meta_insights_scheduler_foundation.sql",
    ),
    "utf8",
  );
  for (const marker of [
    `"trigger" text not null default 'manual'`,
    "attempt integer not null default 1",
    "pages_fetched integer not null default 0",
    "coverage_complete boolean not null default false",
    `where "trigger" = 'manual'`,
    `and status = 'succeeded'`,
    "mark_manual_meta_insights_coverage_complete",
  ]) {
    assert.ok(
      migration.includes(marker),
      `migration is missing manual compatibility marker: ${marker}`,
    );
  }
});

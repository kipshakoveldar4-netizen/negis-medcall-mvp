export const META_INSIGHTS_COMPLETENESS_STATUSES = [
  "never_synced",
  "syncing",
  "zero_delivery",
  "partial",
  "current",
  "stale",
  "failed",
  "unavailable",
] as const;

export type MetaInsightsCompletenessStatus =
  (typeof META_INSIGHTS_COMPLETENESS_STATUSES)[number];

export type MetaInsightsDateRange = {
  dateStart: string;
  dateStop: string;
};

export type MetaInsightsSuccessfulRunRange = MetaInsightsDateRange & {
  coverageComplete: boolean;
  completedAt: string | null;
};

export type MetaInsightsLatestRun = {
  status: string;
  coverageComplete?: boolean;
};

export type MetaInsightsLease = {
  leaseExpiresAt: string | null;
};

export type MetaInsightsCompletenessReasonCode =
  | "launch_ineligible"
  | "configuration_unavailable"
  | "active_lease"
  | "run_in_progress"
  | "no_completed_sync"
  | "rows_without_complete_coverage"
  | "incomplete_sync"
  | "coverage_gaps"
  | "full_range_zero_rows"
  | "full_range_fresh"
  | "coverage_older_than_sla"
  | "latest_attempt_failed";

export type EvaluateMetaInsightsCompletenessInput = {
  launchEligible: boolean;
  configurationAvailable: boolean;
  now: string;
  accountTimeZone: string;
  requiredRange: MetaInsightsDateRange;
  freshnessDeadline: string;
  latestRun?: MetaInsightsLatestRun | null;
  lease?: MetaInsightsLease | null;
  successfulRuns: MetaInsightsSuccessfulRunRange[];
  insightRowCountInRequiredRange: number;
};

export type MetaInsightsCompletenessResult = {
  status: MetaInsightsCompletenessStatus;
  reasonCode: MetaInsightsCompletenessReasonCode;
  coveredDateRanges: MetaInsightsDateRange[];
  unknownGaps: MetaInsightsDateRange[];
  lastCompleteDate: string | null;
};

const DAY_MS = 86_400_000;

type NumericDateRange = {
  start: number;
  stop: number;
};

function parseCalendarDate(value: string, fieldName: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${fieldName} must use YYYY-MM-DD`);
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${fieldName} must be a valid calendar date`);
  }
  return Math.floor(timestamp / DAY_MS);
}

function parseTimestamp(value: string, fieldName: string): number {
  if (!/(?:z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error(`${fieldName} must include an explicit timezone offset`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp))
    throw new Error(`${fieldName} must be a valid timestamp`);
  return timestamp;
}

function toDateKey(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function toNumericRange(
  range: MetaInsightsDateRange,
  fieldName: string,
): NumericDateRange {
  const start = parseCalendarDate(range.dateStart, `${fieldName}.dateStart`);
  const stop = parseCalendarDate(range.dateStop, `${fieldName}.dateStop`);
  if (start > stop)
    throw new Error(`${fieldName}.dateStart must not be after dateStop`);
  return { start, stop };
}

function fromNumericRange(range: NumericDateRange): MetaInsightsDateRange {
  return { dateStart: toDateKey(range.start), dateStop: toDateKey(range.stop) };
}

function mergeNumericRanges(ranges: NumericDateRange[]): NumericDateRange[] {
  const sorted = ranges
    .map((range) => ({ ...range }))
    .sort((left, right) => left.start - right.start || left.stop - right.stop);
  const merged: NumericDateRange[] = [];

  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || range.start > previous.stop + 1) {
      merged.push(range);
      continue;
    }
    previous.stop = Math.max(previous.stop, range.stop);
  }

  return merged;
}

function clipRanges(
  ranges: NumericDateRange[],
  required: NumericDateRange,
): NumericDateRange[] {
  return mergeNumericRanges(
    ranges
      .map((range) => ({
        start: Math.max(range.start, required.start),
        stop: Math.min(range.stop, required.stop),
      }))
      .filter((range) => range.start <= range.stop),
  );
}

function findNumericGaps(
  required: NumericDateRange,
  covered: NumericDateRange[],
): NumericDateRange[] {
  const gaps: NumericDateRange[] = [];
  let cursor = required.start;

  for (const range of clipRanges(covered, required)) {
    if (range.start > cursor)
      gaps.push({ start: cursor, stop: range.start - 1 });
    cursor = Math.max(cursor, range.stop + 1);
    if (cursor > required.stop) break;
  }

  if (cursor <= required.stop)
    gaps.push({ start: cursor, stop: required.stop });
  return gaps;
}

function lastContiguousCoveredDate(
  required: NumericDateRange,
  covered: NumericDateRange[],
): string | null {
  const clipped = clipRanges(covered, required);
  const first = clipped[0];
  if (!first || first.start > required.start) return null;
  return toDateKey(Math.min(first.stop, required.stop));
}

function baseResult(input: {
  status: MetaInsightsCompletenessStatus;
  reasonCode: MetaInsightsCompletenessReasonCode;
  covered: NumericDateRange[];
  gaps: NumericDateRange[];
  required: NumericDateRange;
}): MetaInsightsCompletenessResult {
  return {
    status: input.status,
    reasonCode: input.reasonCode,
    coveredDateRanges: input.covered.map(fromNumericRange),
    unknownGaps: input.gaps.map(fromNumericRange),
    lastCompleteDate: lastContiguousCoveredDate(input.required, input.covered),
  };
}

export function mergeMetaInsightsDateRanges(
  ranges: MetaInsightsDateRange[],
): MetaInsightsDateRange[] {
  return mergeNumericRanges(
    ranges.map((range, index) => toNumericRange(range, `ranges[${index}]`)),
  ).map(fromNumericRange);
}

export function findMetaInsightsUnknownGaps(
  requiredRange: MetaInsightsDateRange,
  coveredRanges: MetaInsightsDateRange[],
): MetaInsightsDateRange[] {
  const required = toNumericRange(requiredRange, "requiredRange");
  const covered = coveredRanges.map((range, index) =>
    toNumericRange(range, `coveredRanges[${index}]`),
  );
  return findNumericGaps(required, covered).map(fromNumericRange);
}

export function isMetaInsightsLeaseActive(
  lease: MetaInsightsLease | null | undefined,
  now: string,
): boolean {
  const nowTimestamp = parseTimestamp(now, "now");
  if (!lease?.leaseExpiresAt) return false;
  return (
    parseTimestamp(lease.leaseExpiresAt, "lease.leaseExpiresAt") > nowTimestamp
  );
}

export function evaluateMetaInsightsCompleteness(
  input: EvaluateMetaInsightsCompletenessInput,
): MetaInsightsCompletenessResult {
  if (!input.accountTimeZone.trim())
    throw new Error("accountTimeZone must be explicit");
  const required = toNumericRange(input.requiredRange, "requiredRange");
  const nowTimestamp = parseTimestamp(input.now, "now");
  const freshnessDeadline = parseTimestamp(
    input.freshnessDeadline,
    "freshnessDeadline",
  );
  if (freshnessDeadline > nowTimestamp)
    throw new Error("freshnessDeadline must not be in the future");
  if (
    !Number.isSafeInteger(input.insightRowCountInRequiredRange) ||
    input.insightRowCountInRequiredRange < 0
  ) {
    throw new Error(
      "insightRowCountInRequiredRange must be a non-negative safe integer",
    );
  }

  const emptyCoverage: NumericDateRange[] = [];
  const fullRequiredGap = [required];
  if (!input.launchEligible) {
    return baseResult({
      status: "unavailable",
      reasonCode: "launch_ineligible",
      covered: emptyCoverage,
      gaps: fullRequiredGap,
      required,
    });
  }
  if (!input.configurationAvailable) {
    return baseResult({
      status: "unavailable",
      reasonCode: "configuration_unavailable",
      covered: emptyCoverage,
      gaps: fullRequiredGap,
      required,
    });
  }

  const completeRuns = input.successfulRuns.filter(
    (run) => run.coverageComplete,
  );
  const completeRanges = completeRuns.map((run, index) =>
    toNumericRange(run, `successfulRuns[${index}]`),
  );
  const covered = clipRanges(completeRanges, required);
  const gaps = findNumericGaps(required, covered);
  const fullyCovered = gaps.length === 0;

  const leaseActive = isMetaInsightsLeaseActive(input.lease, input.now);
  if (leaseActive) {
    return baseResult({
      status: "syncing",
      reasonCode: "active_lease",
      covered,
      gaps,
      required,
    });
  }

  const latestStatus = input.latestRun?.status.trim().toLowerCase() || "";
  const hasLeaseRecord = Boolean(input.lease?.leaseExpiresAt);
  if (
    ["pending", "running"].includes(latestStatus) &&
    (!hasLeaseRecord || leaseActive)
  ) {
    return baseResult({
      status: "syncing",
      reasonCode: "run_in_progress",
      covered,
      gaps,
      required,
    });
  }

  const freshRanges = completeRuns
    .filter(
      (run) =>
        Boolean(run.completedAt) &&
        parseTimestamp(
          run.completedAt as string,
          "successfulRuns.completedAt",
        ) >= freshnessDeadline,
    )
    .map((run, index) => toNumericRange(run, `freshSuccessfulRuns[${index}]`));
  const freshGaps = findNumericGaps(required, freshRanges);
  const fullyFresh = freshGaps.length === 0;
  const latestFailed = latestStatus === "failed";

  if (fullyCovered && fullyFresh) {
    return baseResult({
      status:
        input.insightRowCountInRequiredRange === 0
          ? "zero_delivery"
          : "current",
      reasonCode:
        input.insightRowCountInRequiredRange === 0
          ? "full_range_zero_rows"
          : "full_range_fresh",
      covered,
      gaps,
      required,
    });
  }

  if (latestFailed) {
    return baseResult({
      status: "failed",
      reasonCode: "latest_attempt_failed",
      covered,
      gaps,
      required,
    });
  }

  if (fullyCovered) {
    return baseResult({
      status: "stale",
      reasonCode: "coverage_older_than_sla",
      covered,
      gaps,
      required,
    });
  }

  if (covered.length > 0) {
    return baseResult({
      status: "partial",
      reasonCode: "coverage_gaps",
      covered,
      gaps,
      required,
    });
  }

  if (
    input.latestRun?.coverageComplete === false &&
    latestStatus === "succeeded"
  ) {
    return baseResult({
      status: "partial",
      reasonCode: "incomplete_sync",
      covered,
      gaps,
      required,
    });
  }

  if (input.insightRowCountInRequiredRange > 0) {
    return baseResult({
      status: "partial",
      reasonCode: "rows_without_complete_coverage",
      covered,
      gaps,
      required,
    });
  }

  return baseResult({
    status: "never_synced",
    reasonCode: "no_completed_sync",
    covered,
    gaps,
    required,
  });
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

type MetaInsightsHistorySummary = {
  metaCampaignLaunchId: string;
  availability: "available" | "not_synced" | "empty" | "running" | "failed" | "unavailable";
  freshness: "fresh" | "stale" | "unknown";
  coveredDateStart: string | null; coveredDateStop: string | null; latestFetchedAt: string | null;
  rowCount: number;
  spendByCurrency: Array<{ currency: string; currencyExponent: number; spendMinor: string }>;
  impressions: string; clicks: string; inlineLinkClicks: string; metaLeads: string | null;
  lastRun?: {
    status: string; dateStart: string | null; dateStop: string | null; rowsUpserted: number;
    startedAt: string | null; finishedAt: string | null; safeErrorMessage: string | null;
  } | null;
};

// Read the real helper as source so scripts/rootDir never imports frontend code.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
const helperPath = "artifacts/negis/src/lib/metaInsightsHistory.ts";
const compiled = ts.transpileModule(await readFile(path.join(root, helperPath), "utf8"), {
  fileName: helperPath, reportDiagnostics: true,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
assert.equal(compiled.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
const payloadModule = {} as { parseMetaInsightsHistorySummaries(value: unknown): MetaInsightsHistorySummary[] };
const evaluate = new Script(`(function(exports, require) {\n${compiled.outputText}\n})`, {
  filename: "metaInsightsHistory.payload.cjs",
}).runInThisContext() as (exports: typeof payloadModule, requireModule: (name: string) => never) => void;
evaluate(payloadModule, (name) => assert.fail(`Unexpected payload dependency: ${name}`));
const parse = payloadModule.parseMetaInsightsHistorySummaries;

const launchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherId = "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb";
const invalidMessage = "\u041e\u0442\u0432\u0435\u0442 Meta Insights \u043f\u043e\u0432\u0440\u0435\u0436\u0434\u0451\u043d. \u041e\u0431\u043d\u043e\u0432\u0438\u0442\u0435 \u043e\u0442\u0447\u0451\u0442 \u0438\u043b\u0438 \u043f\u043e\u043f\u0440\u043e\u0431\u0443\u0439\u0442\u0435 \u043f\u043e\u0437\u0436\u0435.";
const huge = "9007199254740993123456789012345678901234567890";

function summary(): MetaInsightsHistorySummary {
  return {
    metaCampaignLaunchId: launchId, availability: "available", freshness: "fresh",
    coveredDateStart: "2026-10-20", coveredDateStop: "2026-10-21",
    latestFetchedAt: "2026-10-22T08:00:00.000Z", rowCount: 2,
    spendByCurrency: [{ currency: "USD", currencyExponent: 2, spendMinor: "1234" }],
    impressions: "200", clicks: "15", inlineLinkClicks: "11", metaLeads: "3",
  };
}

function lastRun(): NonNullable<MetaInsightsHistorySummary["lastRun"]> {
  return {
    status: "succeeded", dateStart: "2026-10-20", dateStop: "2026-10-21", rowsUpserted: 2,
    startedAt: "2026-10-22T07:59:00.000Z", finishedAt: "2026-10-22T08:00:00.000Z",
    safeErrorMessage: null,
  };
}

function rejects(value: unknown, label: string) {
  assert.throws(() => parse(value), (error: unknown) => {
    assert.ok(error instanceof Error, label);
    assert.equal(error.message, invalidMessage, label);
    return true;
  }, label);
}

test("I1 only an actual empty array represents an empty Insights payload", () => {
  const empty: unknown[] = [];
  assert.deepEqual(parse(empty), []);
  assert.notEqual(parse(empty), empty);
  for (const [index, value] of [undefined, null, {}, { summaries: [] }, "[]", 0, false, [null], [[]]].entries()) {
    rejects(value, `invalid container ${index}`);
  }
});

test("I2 every availability/freshness state permits typed zero and nullable fields", () => {
  const availability: MetaInsightsHistorySummary["availability"][] = ["available", "not_synced", "empty", "running", "failed", "unavailable"];
  const freshness: MetaInsightsHistorySummary["freshness"][] = ["fresh", "stale", "unknown"];
  for (const state of availability) for (const age of freshness) {
    const row = { ...summary(), availability: state, freshness: age, rowCount: 0,
      coveredDateStart: null, coveredDateStop: null, latestFetchedAt: null, spendByCurrency: [],
      impressions: "0", clicks: "0", inlineLinkClicks: "0", metaLeads: null, lastRun: null };
    assert.deepEqual(parse([row]), [row]);
  }
  for (const range of [{ coveredDateStart: null }, { coveredDateStop: null }]) {
    const row = { ...summary(), ...range };
    assert.deepEqual(parse([row]), [row], "Nullable range endpoints are independent");
  }
});

test("I3 UUID versions 1-5 and variants 8-b are valid and IDs are canonicalized", () => {
  for (const version of [1, 2, 3, 4, 5]) for (const variant of ["8", "9", "a", "b"]) {
    const id = `aaaaaaaa-aaaa-${version}aaa-${variant}aaa-aaaaaaaaaaaa`;
    assert.equal(parse([{ ...summary(), metaCampaignLaunchId: id.toUpperCase() }])[0].metaCampaignLaunchId, id);
  }
  for (const id of ["", "dryrun_1", "aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-6aaa-8aaa-aaaaaaaaaaaa",
    "aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-4aaa-caaa-aaaaaaaaaaaa", ` ${launchId}`, 1, null]) {
    rejects([{ ...summary(), metaCampaignLaunchId: id }], `invalid UUID ${String(id)}`);
  }
});

test("I4 duplicate launch IDs reject the whole payload, including case-only duplicates", () => {
  rejects([summary(), summary()], "duplicate ID");
  rejects([summary(), { ...summary(), metaCampaignLaunchId: launchId.toUpperCase() }], "case-only duplicate ID");
  assert.equal(parse([summary(), { ...summary(), metaCampaignLaunchId: otherId }]).length, 2);
});

test("I5 mixed currencies, exponent boundaries, zeros and huge digit strings are lossless", () => {
  const row = { ...summary(), impressions: huge, clicks: "0", inlineLinkClicks: "0001", metaLeads: huge,
    rowCount: Number.MAX_SAFE_INTEGER,
    spendByCurrency: [
      { currency: "USD", currencyExponent: 2, spendMinor: huge },
      { currency: "EUR", currencyExponent: 2, spendMinor: "0" },
      { currency: "JPY", currencyExponent: 0, spendMinor: "0000" },
      { currency: "KZT", currencyExponent: 6, spendMinor: "1" },
      { currency: "USD", currencyExponent: 0, spendMinor: "0" },
    ] };
  assert.deepEqual(parse([row]), [row]);
});

test("I6 missing or malformed defined summary fields never become a partial or empty result", () => {
  const fields: Record<string, unknown[]> = {
    availability: [undefined, null, "AVAILABLE", "other", 1],
    freshness: [undefined, null, "FRESH", "other", false],
    rowCount: [undefined, null, "1", -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity],
    spendByCurrency: [undefined, null, {}, "USD", [null], [[]]],
  };
  for (const [field, values] of Object.entries(fields)) for (const [index, value] of values.entries()) {
    const bad = { ...summary(), [field]: value };
    rejects([bad], `${field} invalid ${index}`);
    rejects([summary(), { ...bad, metaCampaignLaunchId: otherId }], `${field} mixed payload ${index}`);
  }
  for (const field of ["impressions", "clicks", "inlineLinkClicks", "metaLeads"]) {
    for (const [index, value] of [undefined, "", "-1", "+1", "1.2", "1e3", " 1", "1 ", "NaN", 0, Number.MAX_SAFE_INTEGER + 1, 1n, {}].entries()) {
      rejects([{ ...summary(), [field]: value }], `${field} invalid digits ${index}`);
    }
    if (field !== "metaLeads") rejects([{ ...summary(), [field]: null }], `${field} cannot be null`);
  }
});

test("I7 malformed spend rows and duplicate currency/exponent keys reject the whole payload", () => {
  const fields: Record<string, unknown[]> = {
    currency: [undefined, null, "usd", "US", "USDD", "U1D", " USD", {}],
    currencyExponent: [undefined, null, "2", -1, 0.5, 7, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity],
    spendMinor: [undefined, null, "", "-1", "+1", "0.1", "1e3", " 1", 0, Number.MAX_SAFE_INTEGER + 1, 1n, {}],
  };
  for (const [field, values] of Object.entries(fields)) for (const [index, value] of values.entries()) {
    const spend = { currency: "USD", currencyExponent: 2, spendMinor: "100", [field]: value };
    rejects([{ ...summary(), spendByCurrency: [spend] }], `${field} invalid spend ${index}`);
  }
  const spend = summary().spendByCurrency[0];
  rejects([{ ...summary(), spendByCurrency: [spend, { ...spend, spendMinor: "999" }] }], "duplicate spend key");
});

test("I8 covered dates use actual ISO calendar days and ordered non-null endpoints", () => {
  const row = { ...summary(), coveredDateStart: "2024-02-29", coveredDateStop: "2024-02-29" };
  assert.deepEqual(parse([row]), [row]);
  for (const field of ["coveredDateStart", "coveredDateStop"]) {
    for (const value of [undefined, "", "2026-02-29", "2024-02-30", "2026-04-31", "2026-00-01", "2026-13-01", "2026-10-00",
      "2026-10-32", "2026-1-01", "2026-10-21T00:00:00Z", 0, {}]) {
      rejects([{ ...summary(), [field]: value }], `${field} invalid calendar ${String(value)}`);
    }
  }
  rejects([{ ...summary(), coveredDateStart: "2026-10-22", coveredDateStop: "2026-10-21" }], "reversed covered range");
});

test("I9 fetched timestamps must be parseable strings or explicit null", () => {
  for (const value of [null, "2026-10-22T08:00:00.000Z", "2026-10-22T13:00:00+05:00"]) {
    assert.equal(parse([{ ...summary(), latestFetchedAt: value }])[0].latestFetchedAt, value);
  }
  for (const [index, value] of [undefined, "", "not-a-date", "2026-99-99T00:00:00Z", 0, {}, []].entries()) {
    rejects([{ ...summary(), latestFetchedAt: value }], `invalid fetched timestamp ${index}`);
  }
});

test("I10 optional legacy lastRun, null and typed run records remain valid", () => {
  const row = summary();
  assert.deepEqual(parse([row]), [row]);
  assert.equal(Object.hasOwn(parse([row])[0], "lastRun"), false);
  for (const run of [null, lastRun(), { ...lastRun(), status: "future_status", safeErrorMessage: "Safe fixture warning" },
    { ...lastRun(), dateStart: null, dateStop: null, startedAt: null, finishedAt: null, rowsUpserted: 0 }]) {
    assert.deepEqual(parse([{ ...row, lastRun: run }]), [{ ...row, lastRun: run }]);
  }
});

test("I11 malformed lastRun fields reject the whole payload with the same safe error", () => {
  for (const run of [false, "failed", [], {}]) rejects([{ ...summary(), lastRun: run }], "invalid lastRun container");
  const fields: Record<string, unknown[]> = {
    status: [undefined, null, 1, {}],
    dateStart: [undefined, "2026-02-30", "not-a-date", 1],
    dateStop: [undefined, "2026-04-31", "not-a-date", {}],
    rowsUpserted: [undefined, null, "1", -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity],
    startedAt: [undefined, "", "not-a-date", 1],
    finishedAt: [undefined, "", "not-a-date", {}],
    safeErrorMessage: [undefined, 1, {}, []],
  };
  for (const [field, values] of Object.entries(fields)) for (const [index, value] of values.entries()) {
    rejects([{ ...summary(), lastRun: { ...lastRun(), [field]: value } }], `lastRun.${field} invalid ${index}`);
  }
  rejects([{ ...summary(), lastRun: { ...lastRun(), dateStart: "2026-10-22", dateStop: "2026-10-21" } }], "reversed lastRun range");
});

test("I12 parser clones an allowlist at every level and does not mutate input", () => {
  const spend = Object.freeze({ ...summary().spendByCurrency[0], privateExtra: "discard-spend" });
  const run = Object.freeze({ ...lastRun(), privateExtra: "discard-run" });
  const row = Object.freeze({ ...summary(), spendByCurrency: Object.freeze([spend]), lastRun: run, privateExtra: "discard-summary" });
  const input = Object.freeze([row]);
  const result = parse(input);
  assert.deepEqual(result, [{ ...summary(), lastRun: lastRun() }]);
  assert.notEqual(result, input);
  assert.notEqual(result[0], row);
  assert.notEqual(result[0].spendByCurrency, row.spendByCurrency);
  assert.notEqual(result[0].spendByCurrency[0], spend);
  assert.notEqual(result[0].lastRun, run);
  assert.equal(row.privateExtra, "discard-summary");
  assert.equal(spend.privateExtra, "discard-spend");
  assert.equal(run.privateExtra, "discard-run");
  rejects([row, { ...summary(), metaCampaignLaunchId: otherId, spendByCurrency: null }], "valid row cannot hide a later malformed row");
  rejects([{ ...summary(), spendByCurrency: null }, { ...summary(), metaCampaignLaunchId: otherId }], "malformed first row cannot be filtered away");
});

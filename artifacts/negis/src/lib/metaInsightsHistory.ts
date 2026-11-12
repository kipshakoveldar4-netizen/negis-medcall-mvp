export type MetaInsightsHistorySummary = {
  metaCampaignLaunchId: string;
  availability: "available" | "not_synced" | "empty" | "running" | "failed" | "unavailable";
  freshness: "fresh" | "stale" | "unknown";
  coveredDateStart: string | null;
  coveredDateStop: string | null;
  latestFetchedAt: string | null;
  rowCount: number;
  spendByCurrency: Array<{ currency: string; currencyExponent: number; spendMinor: string }>;
  impressions: string;
  clicks: string;
  inlineLinkClicks: string;
  metaLeads: string | null;
  lastRun?: {
    status: string; dateStart: string | null; dateStop: string | null; rowsUpserted: number;
    startedAt: string | null; finishedAt: string | null; safeErrorMessage: string | null;
  } | null;
};

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const count = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): value is string | null => value === null || typeof value === "string" && Number.isFinite(Date.parse(value));
function day(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
const range = (start: unknown, stop: unknown) => day(start) && day(stop) && !(start && stop && start > stop);
function invalid(): never { throw new Error("Ответ Meta Insights повреждён. Обновите отчёт или попробуйте позже."); }

// Reject the whole response: silently dropping a bad row would certify partial totals.
export function parseMetaInsightsHistorySummaries(value: unknown): MetaInsightsHistorySummary[] {
  if (!Array.isArray(value)) return invalid();
  const ids = new Set<string>();
  return value.map((row): MetaInsightsHistorySummary => {
    if (!record(row) || typeof row.metaCampaignLaunchId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.metaCampaignLaunchId)
      || !["available", "not_synced", "empty", "running", "failed", "unavailable"].includes(row.availability as string)
      || !["fresh", "stale", "unknown"].includes(row.freshness as string)
      || !range(row.coveredDateStart, row.coveredDateStop) || !timestamp(row.latestFetchedAt)
      || !integer(row.rowCount) || !Array.isArray(row.spendByCurrency)
      || !count(row.impressions) || !count(row.clicks) || !count(row.inlineLinkClicks)
      || !(row.metaLeads === null || count(row.metaLeads))) return invalid();
    const id = row.metaCampaignLaunchId.toLowerCase();
    if (ids.has(id)) return invalid();
    ids.add(id);
    const currencies = new Set<string>();
    const spendByCurrency = row.spendByCurrency.map(item => {
      if (!record(item) || typeof item.currency !== "string" || !/^[A-Z]{3}$/.test(item.currency)
        || !integer(item.currencyExponent) || item.currencyExponent > 6 || !count(item.spendMinor)) return invalid();
      const key = `${item.currency}:${item.currencyExponent}`;
      if (currencies.has(key)) return invalid();
      currencies.add(key);
      return { currency: item.currency, currencyExponent: item.currencyExponent, spendMinor: item.spendMinor };
    });
    let lastRun: MetaInsightsHistorySummary["lastRun"];
    if (row.lastRun === null) lastRun = null;
    else if (row.lastRun !== undefined) {
      const run = row.lastRun;
      if (!record(run) || typeof run.status !== "string" || !range(run.dateStart, run.dateStop)
        || !integer(run.rowsUpserted) || !timestamp(run.startedAt) || !timestamp(run.finishedAt)
        || !(run.safeErrorMessage === null || typeof run.safeErrorMessage === "string")) return invalid();
      lastRun = { status: run.status, dateStart: run.dateStart as string | null, dateStop: run.dateStop as string | null,
        rowsUpserted: run.rowsUpserted, startedAt: run.startedAt, finishedAt: run.finishedAt, safeErrorMessage: run.safeErrorMessage };
    }
    return { metaCampaignLaunchId: id, availability: row.availability as MetaInsightsHistorySummary["availability"],
      freshness: row.freshness as MetaInsightsHistorySummary["freshness"], coveredDateStart: row.coveredDateStart as string | null,
      coveredDateStop: row.coveredDateStop as string | null, latestFetchedAt: row.latestFetchedAt, rowCount: row.rowCount,
      spendByCurrency, impressions: row.impressions, clicks: row.clicks, inlineLinkClicks: row.inlineLinkClicks, metaLeads: row.metaLeads,
      ...(lastRun !== undefined ? { lastRun } : {}) };
  });
}

import { getMetaConfig } from "./marketing";

type JsonRecord = Record<string, unknown>;

type MetaInsightsFetchResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

type MetaInsightsFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: unknown;
  },
) => Promise<MetaInsightsFetchResponse>;

export const META_INSIGHTS_SAFE_ERROR_CODES = [
  "meta_auth",
  "meta_permission",
  "meta_rate_limited",
  "invalid_range",
  "launch_not_eligible",
  "normalization_failed",
  "persistence_failed",
  "sync_timeout",
] as const;

export type MetaInsightsSafeErrorCode = (typeof META_INSIGHTS_SAFE_ERROR_CODES)[number];

export class MetaInsightsError extends Error {
  readonly code: MetaInsightsSafeErrorCode;
  readonly status?: number;

  constructor(code: MetaInsightsSafeErrorCode, message: string, status?: number) {
    super(message);
    this.name = "MetaInsightsError";
    this.code = code;
    this.status = status;
  }
}

export type MetaInsightsContext = {
  workspaceId: string;
  metaCampaignLaunchId: string;
  metaCampaignId: string;
  adAccountId?: string;
  expectedCurrency?: string;
  accountTimezone?: string;
  attributionSetting?: string;
  fetchedAt?: string;
};

export type NormalizedMetaInsightRow = {
  workspaceId: string;
  metaCampaignLaunchId: string;
  metaCampaignId: string;
  adAccountId: string | null;
  dateStart: string;
  dateStop: string;
  spendMinor: string;
  currency: string;
  currencyExponent: number;
  impressions: string;
  reach: string;
  clicks: string;
  inlineLinkClicks: string;
  metaLeads: string | null;
  actionCounts: Record<string, string>;
  apiVersion: string;
  accountTimezone: string | null;
  attributionSetting: string | null;
  fetchedAt: string;
};

export type FetchCampaignInsightsDailyParams = MetaInsightsContext & {
  dateStart: string;
  dateStop: string;
  pageLimit?: number;
  requestTimeoutMs?: number;
};

export type FetchCampaignInsightsDailyResult = {
  rows: NormalizedMetaInsightRow[];
  apiVersion: string;
  pagesFetched: number;
};

const insightFields = [
  "date_start",
  "date_stop",
  "campaign_id",
  "account_id",
  "account_currency",
  "spend",
  "impressions",
  "reach",
  "clicks",
  "inline_link_clicks",
  "actions",
].join(",");

const currencyExponents: Record<string, number> = {
  KZT: 2,
  USD: 2,
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedAdAccountId(value: unknown): string {
  return readString(value).toLowerCase().replace(/^act_/, "");
}

function safeIntegerString(value: unknown, field: string, fallback = "0"): string {
  if (value === undefined || value === null || value === "") return fallback;

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new MetaInsightsError("normalization_failed", `Meta metric ${field} is not a non-negative integer.`);
    }
    return String(value);
  }

  const text = readString(value);
  if (!/^\d+$/.test(text)) {
    throw new MetaInsightsError("normalization_failed", `Meta metric ${field} is not a non-negative integer.`);
  }

  return BigInt(text).toString();
}

function readMetaErrorCode(payload: unknown): number | null {
  const value = asRecord(asRecord(payload).error).code;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function mapMetaRequestError(status: number, payload: unknown): MetaInsightsError {
  const metaCode = readMetaErrorCode(payload);

  if (status === 401 || metaCode === 190) {
    return new MetaInsightsError("meta_auth", "Meta access token недействителен или истёк.", status);
  }
  if (status === 429 || metaCode === 4 || metaCode === 17 || metaCode === 32 || metaCode === 613) {
    return new MetaInsightsError("meta_rate_limited", "Meta временно ограничила частоту запросов Insights.", status);
  }
  if (status === 403 || metaCode === 10 || metaCode === 200) {
    return new MetaInsightsError("meta_permission", "У Meta token нет доступа к Insights этой кампании.", status);
  }

  return new MetaInsightsError(
    status >= 500 ? "sync_timeout" : "meta_permission",
    status >= 500
      ? "Meta Insights временно недоступен. Повторите синхронизацию позже."
      : "Meta отклонила безопасный запрос Insights для этой кампании.",
    status,
  );
}

function parsePayload(rawText: string): unknown {
  if (!rawText.trim()) return {};
  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    throw new MetaInsightsError("normalization_failed", "Meta Insights вернул некорректный ответ.");
  }
}

function isDailyDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function currencyExponent(currency: string): number {
  const normalized = currency.trim().toUpperCase();
  const exponent = currencyExponents[normalized];
  if (exponent === undefined) {
    throw new MetaInsightsError("normalization_failed", `Валюта ${normalized || "Meta account"} пока не поддерживается.`);
  }
  return exponent;
}

export function decimalToMinor(spend: string, exponent: number): string {
  const value = spend.trim();
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6 || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new MetaInsightsError("normalization_failed", "Meta spend нельзя безопасно преобразовать в минорные единицы.");
  }

  const [majorPart, rawFraction = ""] = value.split(".");
  const retainedFraction = rawFraction.slice(0, exponent);
  const discardedFraction = rawFraction.slice(exponent);
  if (discardedFraction && /[1-9]/.test(discardedFraction)) {
    throw new MetaInsightsError("normalization_failed", "Точность Meta spend превышает точность валюты аккаунта.");
  }

  const paddedFraction = retainedFraction.padEnd(exponent, "0");
  const combined = `${majorPart}${paddedFraction}`.replace(/^0+(?=\d)/, "") || "0";
  return BigInt(combined).toString();
}

export function normalizeActionCounts(actions: unknown): Record<string, string> {
  if (!Array.isArray(actions)) return {};

  let leadCount = 0n;
  let hasLeadAction = false;

  for (const item of actions) {
    const action = asRecord(item);
    if (readString(action.action_type) !== "lead") continue;
    const count = safeIntegerString(action.value, "actions.lead");
    leadCount += BigInt(count);
    hasLeadAction = true;
  }

  return hasLeadAction ? { lead: leadCount.toString() } : {};
}

export function normalizeInsightRow(
  value: unknown,
  context: MetaInsightsContext & { apiVersion: string },
): NormalizedMetaInsightRow {
  const row = asRecord(value);
  const dateStart = readString(row.date_start);
  const dateStop = readString(row.date_stop);
  if (!isDailyDate(dateStart) || !isDailyDate(dateStop) || dateStart !== dateStop) {
    throw new MetaInsightsError("normalization_failed", "Meta Insights должен содержать отдельную строку на каждый день.");
  }

  const rowCampaignId = readString(row.campaign_id);
  if (rowCampaignId && rowCampaignId !== context.metaCampaignId) {
    throw new MetaInsightsError("normalization_failed", "Meta Insights вернул данные другой кампании.");
  }

  const rowAccountId = readString(row.account_id);
  const expectedAccountId = normalizedAdAccountId(context.adAccountId);
  if (rowAccountId && expectedAccountId && normalizedAdAccountId(rowAccountId) !== expectedAccountId) {
    throw new MetaInsightsError("normalization_failed", "Meta Insights вернул данные другого рекламного аккаунта.");
  }

  const currency = (readString(row.account_currency) || readString(context.expectedCurrency)).toUpperCase();
  const exponent = currencyExponent(currency);
  const actionCounts = normalizeActionCounts(row.actions);

  return {
    workspaceId: context.workspaceId,
    metaCampaignLaunchId: context.metaCampaignLaunchId,
    metaCampaignId: context.metaCampaignId,
    adAccountId: rowAccountId || readString(context.adAccountId) || null,
    dateStart,
    dateStop,
    spendMinor: decimalToMinor(readString(row.spend) || "0", exponent),
    currency,
    currencyExponent: exponent,
    impressions: safeIntegerString(row.impressions, "impressions"),
    reach: safeIntegerString(row.reach, "reach"),
    clicks: safeIntegerString(row.clicks, "clicks"),
    inlineLinkClicks: safeIntegerString(row.inline_link_clicks, "inline_link_clicks"),
    metaLeads: actionCounts.lead ?? null,
    actionCounts,
    apiVersion: context.apiVersion,
    accountTimezone: readString(context.accountTimezone) || null,
    attributionSetting: readString(context.attributionSetting) || null,
    fetchedAt: context.fetchedAt || new Date().toISOString(),
  };
}

export async function fetchCampaignInsightsDaily(
  params: FetchCampaignInsightsDailyParams,
): Promise<FetchCampaignInsightsDailyResult> {
  const config = getMetaConfig();
  if (!config.accessToken) {
    throw new MetaInsightsError("meta_auth", "Meta access token не настроен.");
  }
  if (!params.metaCampaignId.trim()) {
    throw new MetaInsightsError("launch_not_eligible", "У запуска нет реального Meta campaign ID.");
  }

  const pageLimit = Math.min(Math.max(params.pageLimit ?? 10, 1), 10);
  const timeoutMs = Math.min(Math.max(params.requestTimeoutMs ?? 45_000, 1_000), 50_000);
  const deadline = Date.now() + timeoutMs;
  const safeFetch = fetch as unknown as MetaInsightsFetch;
  const seenCursors = new Set<string>();
  const rawRows: unknown[] = [];
  let after = "";
  let pagesFetched = 0;

  const baseParams = new URLSearchParams({
    fields: insightFields,
    time_range: JSON.stringify({ since: params.dateStart, until: params.dateStop }),
    time_increment: "1",
    action_report_time: "conversion",
    limit: "100",
  });

  for (let page = 0; page < pageLimit; page += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new MetaInsightsError("sync_timeout", "Синхронизация Meta Insights превысила безопасный лимит времени.");
    }
    const query = new URLSearchParams(baseParams);
    if (after) query.set("after", after);
    const requestUrl = `${config.baseUrl}/${encodeURIComponent(params.metaCampaignId)}/insights?${query.toString()}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remainingMs);

    let response: MetaInsightsFetchResponse;
    try {
      response = await safeFetch(requestUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${config.accessToken}` },
        signal: controller.signal,
      });
    } catch {
      throw new MetaInsightsError("sync_timeout", "Не удалось получить Meta Insights в отведённое время.");
    } finally {
      clearTimeout(timeout);
    }

    let payload: unknown;
    try {
      payload = parsePayload(await response.text());
    } catch (error) {
      if (error instanceof MetaInsightsError) throw error;
      throw new MetaInsightsError("normalization_failed", "Meta Insights вернул некорректный ответ.");
    }

    if (!response.ok) throw mapMetaRequestError(response.status, payload);

    const payloadRecord = asRecord(payload);
    const data = payloadRecord.data;
    if (!Array.isArray(data)) {
      throw new MetaInsightsError("normalization_failed", "Meta Insights не вернул ожидаемый список дневных строк.");
    }
    rawRows.push(...data);
    pagesFetched += 1;

    const cursor = readString(asRecord(asRecord(payloadRecord.paging).cursors).after);
    if (!cursor) break;
    if (seenCursors.has(cursor)) {
      throw new MetaInsightsError("sync_timeout", "Meta Insights вернул повторяющийся курсор страницы.");
    }
    if (page === pageLimit - 1) {
      throw new MetaInsightsError("sync_timeout", "Meta Insights превысил безопасный лимит страниц.");
    }
    seenCursors.add(cursor);
    after = cursor;
  }

  const fetchedAt = new Date().toISOString();
  return {
    rows: rawRows.map((row) =>
      normalizeInsightRow(row, {
        ...params,
        apiVersion: config.graphVersion,
        fetchedAt,
      }),
    ),
    apiVersion: config.graphVersion,
    pagesFetched,
  };
}

import { URL } from "node:url";

const TIKTOK_API_BASE_URL = "https://business-api.tiktok.com";
export const TIKTOK_ADS_DIAGNOSTIC_ENDPOINT = "/open_api/v1.3/advertiser/info/";
export const TIKTOK_ADS_DIAGNOSTIC_FIELDS = [
  "advertiser_id",
  "name",
  "currency",
  "timezone",
  "display_timezone",
  "status",
  "advertiser_account_type",
] as const;

type TikTokFetchResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

export type TikTokFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: unknown;
    redirect?: "error";
  },
) => Promise<TikTokFetchResponse>;

export type TikTokAdsConfig = {
  accessToken: string;
  advertiserId: string;
  appId: string;
  appSecret: string;
  advertiserIdValid: boolean;
  configured: boolean;
  oauthReady: boolean;
};

export type TikTokDiagnosticErrorCode =
  | "not_configured"
  | "invalid_config"
  | "unauthorized"
  | "permission_denied"
  | "rate_limited"
  | "advertiser_not_found"
  | "upstream_unavailable"
  | "invalid_response"
  | "timeout";

export type TikTokAdvertiserSummary = {
  maskedId: string;
  name: string;
  currency: string;
  timezone: string;
  status: string;
  accountType: string;
};

export type TikTokAdsConnectionDiagnostic = {
  configured: boolean;
  connected: boolean;
  readOnly: true;
  launchEnabled: false;
  advertiserIdConfigured: boolean;
  hasAccessToken: boolean;
  hasAppId: boolean;
  hasAppSecret: boolean;
  oauthReady: boolean;
  checkedAt: string;
  advertiser?: TikTokAdvertiserSummary;
  errorCode?: TikTokDiagnosticErrorCode;
  message?: string;
  hint?: string;
};

type TikTokDiagnosticOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: TikTokFetch;
  timeoutMs?: number;
  now?: () => Date;
};

function envValue(env: Readonly<Record<string, string | undefined>>, key: string): string {
  return env[key]?.trim() || "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, maxLength = 160): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function readApiCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value);
  return null;
}

function maskAdvertiserId(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "***";
  return `${"*".repeat(Math.min(8, value.length - 4))}${value.slice(-4)}`;
}

export function getTikTokAdsConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): TikTokAdsConfig {
  const accessToken = envValue(env, "TIKTOK_ACCESS_TOKEN");
  const advertiserId = envValue(env, "TIKTOK_ADVERTISER_ID");
  const appId = envValue(env, "TIKTOK_APP_ID");
  const appSecret = envValue(env, "TIKTOK_APP_SECRET");
  const advertiserIdValid = /^\d{5,32}$/.test(advertiserId);

  return {
    accessToken,
    advertiserId,
    appId,
    appSecret,
    advertiserIdValid,
    configured: Boolean(accessToken && advertiserId && advertiserIdValid),
    oauthReady: Boolean(appId && appSecret),
  };
}

function safeFailure(
  config: TikTokAdsConfig,
  checkedAt: string,
  errorCode: TikTokDiagnosticErrorCode,
): TikTokAdsConnectionDiagnostic {
  const copy: Record<TikTokDiagnosticErrorCode, { message: string; hint: string }> = {
    not_configured: {
      message: "TikTok Ads пока не подключён.",
      hint: "Добавьте TikTok access token и advertiser ID в серверные переменные окружения.",
    },
    invalid_config: {
      message: "Advertiser ID TikTok имеет неверный формат.",
      hint: "Укажите числовой advertiser ID из TikTok Ads Manager.",
    },
    unauthorized: {
      message: "TikTok отклонил токен доступа.",
      hint: "Обновите access token и проверьте авторизацию приложения в TikTok for Business.",
    },
    permission_denied: {
      message: "У токена нет доступа к рекламному аккаунту TikTok.",
      hint: "Выдайте приложению право чтения данных рекламного аккаунта.",
    },
    rate_limited: {
      message: "TikTok временно ограничил частоту проверок.",
      hint: "Повторите проверку через несколько минут.",
    },
    advertiser_not_found: {
      message: "TikTok не подтвердил указанный рекламный аккаунт.",
      hint: "Проверьте advertiser ID и доступ этого токена к аккаунту.",
    },
    upstream_unavailable: {
      message: "TikTok API временно недоступен.",
      hint: "Повторите проверку позже.",
    },
    invalid_response: {
      message: "TikTok вернул некорректный ответ.",
      hint: "Повторите проверку. Если ошибка сохранится, проверьте состояние TikTok API.",
    },
    timeout: {
      message: "TikTok не ответил вовремя.",
      hint: "Повторите проверку через несколько минут.",
    },
  };

  return {
    configured: config.configured,
    connected: false,
    readOnly: true,
    launchEnabled: false,
    advertiserIdConfigured: Boolean(config.advertiserId),
    hasAccessToken: Boolean(config.accessToken),
    hasAppId: Boolean(config.appId),
    hasAppSecret: Boolean(config.appSecret),
    oauthReady: config.oauthReady,
    checkedAt,
    errorCode,
    ...copy[errorCode],
  };
}

function classifyTikTokFailure(status: number, apiMessage: string): TikTokDiagnosticErrorCode {
  const message = apiMessage.toLowerCase();
  if (status === 401 || /unauthor|access token|invalid token|token.*expir/.test(message)) return "unauthorized";
  if (status === 403 || /permission|access denied|not authorized|scope/.test(message)) return "permission_denied";
  if (status === 429 || /rate limit|too many request/.test(message)) return "rate_limited";
  if (/advertiser.*not (?:exist|found)|invalid advertiser|advertiser id/.test(message)) return "advertiser_not_found";
  return "upstream_unavailable";
}

function resolveFetch(fetchImpl?: TikTokFetch): TikTokFetch | null {
  if (fetchImpl) return fetchImpl;
  const runtimeFetch = (globalThis as unknown as { fetch?: TikTokFetch }).fetch;
  return typeof runtimeFetch === "function" ? runtimeFetch : null;
}

export async function validateTikTokAdsConnection(
  options: TikTokDiagnosticOptions = {},
): Promise<TikTokAdsConnectionDiagnostic> {
  const env = options.env ?? process.env;
  const config = getTikTokAdsConfig(env);
  const checkedAt = (options.now?.() ?? new Date()).toISOString();

  if (!config.accessToken || !config.advertiserId) {
    return safeFailure(config, checkedAt, "not_configured");
  }
  if (!config.advertiserIdValid) {
    return safeFailure(config, checkedAt, "invalid_config");
  }

  const safeFetch = resolveFetch(options.fetchImpl);
  if (!safeFetch) return safeFailure(config, checkedAt, "upstream_unavailable");

  const url = new URL(TIKTOK_ADS_DIAGNOSTIC_ENDPOINT, TIKTOK_API_BASE_URL);
  url.searchParams.set("advertiser_ids", JSON.stringify([config.advertiserId]));
  url.searchParams.set("fields", JSON.stringify(TIKTOK_ADS_DIAGNOSTIC_FIELDS));

  const timeoutMs = Math.min(15_000, Math.max(1_000, options.timeoutMs ?? 8_000));
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response: TikTokFetchResponse;
  let rawText: string;
  try {
    response = await safeFetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Access-Token": config.accessToken,
      },
      signal: controller.signal,
      redirect: "error",
    });
    rawText = await response.text();
  } catch {
    return safeFailure(config, checkedAt, timedOut ? "timeout" : "upstream_unavailable");
  } finally {
    clearTimeout(timeout);
  }

  if (!rawText.trim()) {
    return safeFailure(config, checkedAt, response.ok ? "invalid_response" : classifyTikTokFailure(response.status, ""));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return safeFailure(config, checkedAt, response.ok ? "invalid_response" : classifyTikTokFailure(response.status, ""));
  }

  const payload = isRecord(parsed) ? parsed : null;
  if (!payload) return safeFailure(config, checkedAt, "invalid_response");

  const apiCode = readApiCode(payload.code);
  const apiMessage = readString(payload.message);
  if (apiCode === null) {
    return safeFailure(config, checkedAt, "invalid_response");
  }
  if (!response.ok || apiCode !== 0) {
    return safeFailure(config, checkedAt, classifyTikTokFailure(response.status, apiMessage));
  }

  const data = isRecord(payload.data) ? payload.data : null;
  const list = data && Array.isArray(data.list) ? data.list.filter(isRecord) : [];
  const account = list.find((item) => readString(item.advertiser_id, 64) === config.advertiserId);
  if (!account) return safeFailure(config, checkedAt, "advertiser_not_found");

  return {
    configured: true,
    connected: true,
    readOnly: true,
    launchEnabled: false,
    advertiserIdConfigured: true,
    hasAccessToken: true,
    hasAppId: Boolean(config.appId),
    hasAppSecret: Boolean(config.appSecret),
    oauthReady: config.oauthReady,
    checkedAt,
    advertiser: {
      maskedId: maskAdvertiserId(config.advertiserId),
      name: readString(account.name, 120) || "TikTok Ads account",
      currency: readString(account.currency, 12).toUpperCase(),
      timezone: readString(account.display_timezone, 80) || readString(account.timezone, 80),
      status: readString(account.status, 48),
      accountType: readString(account.advertiser_account_type, 48),
    },
  };
}

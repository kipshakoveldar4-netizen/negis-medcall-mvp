import { createHash } from "node:crypto";
import { URL } from "node:url";
import { getTikTokAdsConfig } from "./diagnostics";

export const TIKTOK_LOCATION_SEARCH_ENDPOINT = "/open_api/v1.3/tool/targeting/search/";
export const TIKTOK_IDENTITY_GET_ENDPOINT = "/open_api/v1.3/identity/get/";
export type TikTokIdentityType = "CUSTOMIZED_USER" | "TT_USER" | "BC_AUTH_TT";
type SetupStatus = "verified" | "not_found" | "ambiguous" | "unavailable";
type SetupError = "not_configured" | "invalid_config" | "unauthorized" | "permission_denied" | "rate_limited" | "invalid_response" | "upstream_unavailable" | "timeout" | "page_limit";

export type TikTokSetupSummary = {
  readOnly: true;
  launchEnabled: false;
  checkedAt: string;
  expiresAt: string;
  source: "provider" | "cache" | "configuration";
  city: { status: SetupStatus; name: string; countryCode: "KZ"; message: string };
  identity: { status: SetupStatus; type: TikTokIdentityType | null; message: string };
};

export type TikTokSetupFetch = (url: string, init: {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal: unknown;
  redirect: "error";
}) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

type Options = {
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: TikTokSetupFetch;
  now?: () => number;
  timeoutMs?: number;
};
type VerifiedContext = { locationIds: string[]; identityConfigured: boolean; identityType?: TikTokIdentityType };
type Entry = { summary: TikTokSetupSummary; context: VerifiedContext; expiresAt: number };
const EMPTY_CONTEXT: VerifiedContext = { locationIds: [], identityConfigured: false };

// Names are aliases only. TikTok IDs must come from this advertiser's search.
const CITY_ALIASES = [
  ["Astana", "Астана", "Nur-Sultan", "Nursultan", "Нур-Султан"],
  ["Almaty", "Алматы"], ["Shymkent", "Шымкент", "Shymkent city"],
  ["Aktobe", "Актобе", "Aqtobe", "Aktoebe", "Ақтөбе"],
  ["Karaganda", "Караганда", "Қарағанды", "Karagandy"],
  ["Atyrau", "Атырау"], ["Aktau", "Актау", "Ақтау"],
  ["Pavlodar", "Павлодар"], ["Kostanay", "Костанай", "Қостанай"],
  ["Taraz", "Тараз"], ["Oral", "Уральск", "Uralsk", "Орал"],
  ["Oskemen", "Усть-Каменогорск", "Ust-Kamenogorsk", "Өскемен"],
  ["Kyzylorda", "Кызылорда", "Қызылорда"],
] as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function str(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function normalized(value: string): string { return value.normalize("NFKC").toLowerCase().replace(/[\s-]+/g, " ").trim(); }
function cityAliases(city: string): readonly string[] {
  return CITY_ALIASES.find((aliases) => aliases.some((alias) => normalized(alias) === normalized(city))) ?? [city];
}

export function selectTikTokCity(data: unknown, city: string): { status: SetupStatus; locationId?: string } {
  const tags = record(data).targeting_tag_list;
  if (!Array.isArray(tags) || tags.length > 100) return { status: "unavailable" };
  const aliases = new Set(cityAliases(city).map(normalized));
  const matches = new Set<string>();
  for (const value of tags) {
    const tag = record(value);
    const geo = record(tag.geo);
    if (tag.targeting_type === "GEO" && geo.geo_type === "CITY" && geo.region_code === "KZ"
      && record(tag.status_info).status === "ENABLED" && aliases.has(normalized(str(tag.name)))
      && /^\d{1,32}$/.test(str(geo.geo_id))) matches.add(str(geo.geo_id));
  }
  if (matches.size > 1) return { status: "ambiguous" };
  const locationId = [...matches][0];
  return locationId ? { status: "verified", locationId } : { status: "not_found" };
}

class SetupFailure extends Error {
  constructor(readonly code: SetupError) { super(code); }
}
const ERROR_COPY: Record<SetupError, string> = {
  not_configured: "Подключите рекламный аккаунт TikTok в настройках сервера.",
  invalid_config: "Проверьте настройки рекламного аккаунта и тип профиля TikTok.",
  unauthorized: "TikTok отклонил доступ. Обновите подключение аккаунта.",
  permission_denied: "TikTok не разрешил проверку. Проверьте права рекламного аккаунта.",
  rate_limited: "TikTok ограничил частоту проверок. Повторите позже.",
  invalid_response: "Не удалось прочитать результат TikTok. Повторите проверку позже.",
  upstream_unavailable: "TikTok временно недоступен. Повторите проверку позже.",
  timeout: "TikTok не ответил вовремя. Повторите проверку позже.",
  page_limit: "Список профилей слишком большой. Доступ к выбранному профилю пока не подтверждён.",
};

async function readData(
  endpoint: typeof TIKTOK_LOCATION_SEARCH_ENDPOINT | typeof TIKTOK_IDENTITY_GET_ENDPOINT,
  params: Record<string, unknown>, token: string, fetchImpl: TikTokSetupFetch, signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const url = new URL(endpoint, "https://business-api.tiktok.com");
  const method = endpoint === TIKTOK_LOCATION_SEARCH_ENDPOINT ? "POST" : "GET";
  if (method === "GET") for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetchImpl(url.toString(), {
    method, headers: { Accept: "application/json", "Content-Type": "application/json", "Access-Token": token },
    ...(method === "POST" ? { body: JSON.stringify(params) } : {}), signal, redirect: "error",
  });
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try { payload = record(JSON.parse(text)); } catch { /* Classify HTTP errors without exposing their body. */ }
  if (!response.ok || payload.code !== 0) {
    const message = str(payload.message).toLowerCase();
    if (response.status === 429 || /rate limit|too many request/.test(message)) throw new SetupFailure("rate_limited");
    if (response.status === 401 || /access token|unauthor|token.*expir/.test(message)) throw new SetupFailure("unauthorized");
    if (response.status === 403 || /permission|access denied|scope/.test(message)) throw new SetupFailure("permission_denied");
    throw new SetupFailure(response.ok ? "invalid_response" : "upstream_unavailable");
  }
  if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) throw new SetupFailure("invalid_response");
  return record(payload.data);
}

async function verifyIdentity(
  config: ReturnType<typeof getTikTokAdsConfig>, env: Readonly<Record<string, string | undefined>>,
  fetchImpl: TikTokSetupFetch, signal: AbortSignal,
): Promise<{ status: SetupStatus; type: TikTokIdentityType | null; message: string }> {
  const id = str(env.TIKTOK_IDENTITY_ID);
  const type = str(env.TIKTOK_IDENTITY_TYPE) || "CUSTOMIZED_USER";
  const bcId = str(env.TIKTOK_IDENTITY_AUTHORIZED_BC_ID);
  if (!id) return { status: "unavailable", type: null, message: "Подключите рекламный профиль TikTok в настройках сервера." };
  if (!["CUSTOMIZED_USER", "TT_USER", "BC_AUTH_TT"].includes(type)
    || !/^[\w-]{1,128}$/.test(id) || (type === "BC_AUTH_TT" && !/^\d{5,32}$/.test(bcId))) throw new SetupFailure("invalid_config");
  const identityType = type as TikTokIdentityType;
  const seen = new Set<string>();
  for (let page = 1; page <= 5; page += 1) {
    const data = await readData(TIKTOK_IDENTITY_GET_ENDPOINT, {
      advertiser_id: config.advertiserId, identity_type: type, page, page_size: 100,
      ...(type === "BC_AUTH_TT" ? { identity_authorized_bc_id: bcId } : {}),
    }, config.accessToken, fetchImpl, signal);
    if (!Array.isArray(data.identity_list) || data.identity_list.length > 100) throw new SetupFailure("invalid_response");
    const info = record(data.page_info);
    if (info.page !== page || !Number.isSafeInteger(info.total_page) || Number(info.total_page) < 0) throw new SetupFailure("invalid_response");
    for (const item of data.identity_list) {
      const row = record(item);
      const rowId = str(row.identity_id);
      if (!rowId || seen.has(rowId)) throw new SetupFailure("invalid_response");
      seen.add(rowId);
      if (rowId !== id || row.identity_type !== type) continue;
      const usable = type === "CUSTOMIZED_USER" || (row.available_status === "AVAILABLE"
        && row.can_push_video === true && row.is_gpppa === false
        && (type !== "BC_AUTH_TT" || row.identity_authorized_bc_id === bcId));
      return {
        status: usable ? "verified" : "unavailable", type: identityType,
        message: usable ? "Рекламный профиль подтверждён TikTok." : "Профиль найден, но TikTok не подтвердил права на рекламное видео.",
      };
    }
    if (page >= Number(info.total_page)) return { status: "not_found", type: identityType, message: "Настроенный профиль не найден в этом рекламном аккаунте." };
  }
  throw new SetupFailure("page_limit");
}

/** Short-lived, server-only evidence. No client can submit IDs or readiness flags. */
export function createTikTokSetupVerifier(options: Options = {}) {
  const cache = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<TikTokSetupSummary>>();
  const now = options.now ?? Date.now;
  const getEnv = () => options.env ?? process.env;
  function key(workspaceId: string, city: string): string {
    const env = getEnv();
    return createHash("sha256").update(JSON.stringify([
      workspaceId, cityAliases(city)[0], env.TIKTOK_ACCESS_TOKEN, env.TIKTOK_ADVERTISER_ID,
      env.TIKTOK_IDENTITY_ID, env.TIKTOK_IDENTITY_TYPE, env.TIKTOK_IDENTITY_AUTHORIZED_BC_ID,
    ])).digest("hex");
  }
  function read(workspaceId: string, city: string): VerifiedContext {
    const entry = cache.get(key(workspaceId, city));
    return entry && entry.expiresAt > now() ? structuredClone(entry.context) : structuredClone(EMPTY_CONTEXT);
  }
  async function verify(workspaceId: string, city: string): Promise<TikTokSetupSummary> {
    if (!/^[0-9a-f-]{36}$/i.test(workspaceId) || !/^[\p{L}\p{M} .'-]{2,100}$/u.test(city.trim())) throw new SetupFailure("invalid_config");
    const cacheKey = key(workspaceId, city);
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now()) return { ...structuredClone(cached.summary), source: "cache" };
    const pending = inFlight.get(cacheKey);
    if (pending) return structuredClone(await pending);
    if (inFlight.size >= 100) throw new SetupFailure("rate_limited");
    const task = run(cacheKey, city);
    inFlight.set(cacheKey, task);
    try { return structuredClone(await task); } finally { inFlight.delete(cacheKey); }
  }
  async function run(cacheKey: string, city: string): Promise<TikTokSetupSummary> {
    const env = getEnv();
    const config = getTikTokAdsConfig(env);
    const timestamp = now();
    const summary: TikTokSetupSummary = {
      readOnly: true, launchEnabled: false, checkedAt: new Date(timestamp).toISOString(), expiresAt: "", source: "configuration",
      city: { status: "unavailable", name: cityAliases(city)[1] ?? city.trim(), countryCode: "KZ", message: ERROR_COPY.not_configured },
      identity: { status: "unavailable", type: null, message: ERROR_COPY.not_configured },
    };
    const context = structuredClone(EMPTY_CONTEXT);
    if (config.configured) {
      const fetchImpl = options.fetchImpl ?? (globalThis as unknown as { fetch: TikTokSetupFetch }).fetch;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.min(12_000, Math.max(1, options.timeoutMs ?? 10_000)));
      const failureMessage = (error: unknown) => ERROR_COPY[controller.signal.aborted ? "timeout" : error instanceof SetupFailure ? error.code : "upstream_unavailable"];
      summary.source = "provider";
      try {
        const [locationResult, identityResult] = await Promise.allSettled([
          readData(TIKTOK_LOCATION_SEARCH_ENDPOINT, {
            advertiser_id: config.advertiserId, objective_type: "TRAFFIC", promotion_type: "WEBSITE",
            placements: ["PLACEMENT_TIKTOK"], search_type: "FUZZY_SEARCH", geo_types: ["CITY"],
            region_codes: ["KZ"], keywords: [cityAliases(city)[0]],
          }, config.accessToken, fetchImpl, controller.signal),
          verifyIdentity(config, env, fetchImpl, controller.signal),
        ]);
        if (locationResult.status === "fulfilled") {
          const result = selectTikTokCity(locationResult.value, city);
          summary.city.status = result.status;
          summary.city.message = result.status === "verified" ? "Город подтверждён TikTok."
            : result.status === "ambiguous" ? "TikTok вернул несколько городов с одинаковым названием. Требуется уточнение."
            : result.status === "not_found" ? "TikTok не подтвердил этот город для аккаунта. Показ на всю страну не подставляется."
            : ERROR_COPY.invalid_response;
          if (result.locationId) context.locationIds = [result.locationId];
        } else summary.city.message = failureMessage(locationResult.reason);
        if (identityResult.status === "fulfilled") {
          summary.identity = identityResult.value;
          context.identityConfigured = summary.identity.status === "verified";
          if (context.identityConfigured && summary.identity.type) context.identityType = summary.identity.type;
        } else summary.identity.message = failureMessage(identityResult.reason);
      } finally { clearTimeout(timeout); }
    } else if (config.accessToken && config.advertiserId) {
      summary.city.message = summary.identity.message = ERROR_COPY.invalid_config;
    }
    const expiresAt = now() + (context.identityConfigured && context.locationIds.length ? 300_000 : 30_000);
    summary.expiresAt = new Date(expiresAt).toISOString();
    for (const [entryKey, entry] of cache) if (entry.expiresAt <= now()) cache.delete(entryKey);
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(cacheKey, { summary, context, expiresAt });
    return summary;
  }
  return { verify, read };
}

const verifier = createTikTokSetupVerifier();
export const verifyTikTokSetup = verifier.verify;
export const readTikTokVerifiedSetup = verifier.read;

import {
  cityOptionMatchesCandidate,
  findKzMetaCityOption,
  getKzMetaCityOption,
  normalizeMetaCityToken,
  type MetaCityOption,
  type MetaCitySearchCandidate,
} from "./cities";

type MetaFetchResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

type MetaFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<MetaFetchResponse>;

type MetaJson = Record<string, unknown>;
type MetaImageUploadMode = "adimages" | "picture_url";
type MetaGeoMode = "city" | "country";
type MetaCityKeySource = "static" | "env" | "targeting_search" | "cache" | "fallback";
type MetaTargetingSource = MetaCityKeySource | "input" | "api";

export type MetaCityTarget = {
  key: string | null;
  name?: string;
  countryCode?: string;
  region?: string;
  source: MetaCityKeySource;
  warning?: string;
  cityInput?: string;
  cityId?: string;
  labelRu?: string;
  canonicalName?: string;
  normalizedCity?: string;
  selected?: MetaCitySearchCandidate | null;
  candidates?: MetaCitySearchCandidate[];
  rejectedCandidates?: MetaCitySearchCandidate[];
};

export type MetaTargetingResolution = {
  cityInput?: string;
  cityId?: string;
  labelRu?: string;
  canonicalName?: string;
  city: string;
  cityKey?: string;
  cityKeySource?: MetaTargetingSource;
  countryCode?: string;
  region?: string;
  geoMode: MetaGeoMode;
  radiusKm: number;
  fallbackCountry: boolean;
  warning?: string;
  source: MetaTargetingSource;
  selected?: MetaCitySearchCandidate | null;
  candidates?: MetaCitySearchCandidate[];
  rejectedCandidates?: MetaCitySearchCandidate[];
};

export type MetaApiErrorDetails = {
  step?: string;
  status?: number;
  message: string;
  code?: string;
  errorSubcode?: string;
  errorUserMsg?: string;
  blameFieldSpecs?: unknown;
  fbtraceId?: string;
  debug?: unknown;
};

export class MetaApiError extends Error {
  details: MetaApiErrorDetails;

  constructor(details: MetaApiErrorDetails) {
    super(details.message);
    this.name = "MetaApiError";
    this.details = details;
  }
}

export type MetaConfig = {
  graphVersion: string;
  baseUrl: string;
  accessToken: string;
  adAccountId: string;
  pageId: string;
  instagramActorId: string;
  businessId: string;
  configured: boolean;
};

export type MetaLaunchInput = {
  campaignName: string;
  objective: string;
  status: "PAUSED" | "ACTIVE";
  dailyBudgetMinor: number;
  lifetimeBudgetMinor?: number;
  currency: string;
  primaryText: string;
  headline: string;
  description: string;
  cta: string;
  landingUrl: string;
  imageUrl?: string;
  creativeType?: "image" | "video";
  videoUrl?: string;
  videoId?: string;
  thumbnailUrl?: string;
  startTime?: string;
  endTime?: string;
  targeting?: MetaJson;
  instagramActorId?: string;
  omitInstagramActor?: boolean;
  city?: string;
  audienceLabel?: string;
  launchTimestamp?: string;
  adSetName?: string;
  creativeName?: string;
  adName?: string;
  metaCityKey?: string;
  astanaCityKey?: string;
  selectedCityId?: string;
  selectedCityLabelRu?: string;
  selectedCityCanonicalName?: string;
  targetingResolution?: MetaTargetingResolution;
  omitInstagramPositions?: boolean;
};

export type MetaLaunchResult = {
  campaign: MetaJson;
  adSet: MetaJson;
  creative: MetaJson;
  ad: MetaJson;
  metaCampaignId: string;
  metaAdSetId: string;
  metaCreativeId: string;
  metaAdId: string;
  warning?: string;
  warnings?: string[];
  creativeUsesInstagramActor?: boolean;
  instagramActorFallback?: boolean;
  creativeObjectStorySpecType?: "link_data" | "video_data";
  creativeUsesLinkData?: boolean;
  creativeUsesVideoData?: boolean;
  imageHashReceived?: boolean;
  imageUploadMode?: MetaImageUploadMode;
  imageUploadCapabilityFallback?: boolean;
  pictureUrlUsed?: boolean;
  instagramPositionsFallback?: boolean;
};

type MetaAdSetPayloadInput = MetaLaunchInput & {
  campaignId: string;
  adSetName?: string;
  dailyBudgetUsd?: unknown;
  budgetDailyUsd?: unknown;
  dailyBudget?: unknown;
};

type MetaCreativeCreateResult = {
  data: MetaJson;
  objectStorySpecType: "link_data" | "video_data";
  usesLinkData: boolean;
  usesVideoData: boolean;
  imageHashReceived: boolean;
  imageUploadMode?: MetaImageUploadMode;
  imageUploadCapabilityFallback?: boolean;
  pictureUrlUsed?: boolean;
  warning?: string;
};

const INSTAGRAM_ACTOR_FALLBACK_WARNING =
  "Instagram actor ID отклонён Meta. Кампания создана через Facebook Page. Для запуска в Instagram нужно переподключить Instagram account.";
const IMAGE_UPLOAD_CAPABILITY_FALLBACK_WARNING =
  "Meta не разрешила /adimages. Креатив создан через public picture URL.";

const INSTAGRAM_POSITIONS = ["stream", "story", "explore", "reels"];
const INSTAGRAM_PLACEMENT_FALLBACK_WARNING =
  "Meta rejected detailed Instagram positions. Retried ad set with publisher_platforms: [\"instagram\"].";
const KZ_CITY_FALLBACK_WARNING =
  "Meta city key was not found, Kazakhstan country targeting was used.";
export const META_VIDEO_LAUNCH_DISABLED_MESSAGE =
  "Видео загружено в Negis, но автозапуск видео-рекламы через Meta API ещё находится в подготовке. Сейчас можно запускать фото-рекламу. Для видео используйте Ads Manager вручную или загрузите MP4 после включения video_id flow.";
const metaCityTargetCache = new Map<string, MetaCityTarget>();

function readEnv(key: string): string {
  return process.env[key]?.trim() || "";
}

export function isMetaVideoLaunchEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(readEnv("META_VIDEO_LAUNCH_ENABLED").toLowerCase());
}

export function formatKazakhstanTimestamp(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Almaty",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value || "00";

  return `${part("year")}-${part("month")}-${part("day")}_${part("hour")}-${part("minute")}`;
}

function normalizeGraphVersion(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "v25.0";
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function appendParams(url: string, params: Record<string, unknown>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return query.size > 0 ? `${url}${url.includes("?") ? "&" : "?"}${query.toString()}` : url;
}

export function serializeMetaFormPayload(payload: MetaJson): string {
  return new URLSearchParams(
    Object.fromEntries(
      Object.entries(payload)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([key, value]) => [key, typeof value === "object" ? JSON.stringify(value) : String(value)]),
    ),
  ).toString();
}

function parseMetaId(value: MetaJson): string {
  const id = value.id;
  return typeof id === "string" ? id : "";
}

function sanitizeMetaError(data: unknown): string {
  const error = data && typeof data === "object" && "error" in data ? (data as { error?: unknown }).error : data;
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message?: unknown }).message || "");
    return message.replace(/access_token=[^&\s]+/gi, "access_token=***");
  }
  return "Meta API request failed";
}

function readMetaErrorDetails(data: unknown, status: number, step?: string): MetaApiErrorDetails {
  const error = data && typeof data === "object" && "error" in data ? (data as { error?: unknown }).error : data;
  const record = error && typeof error === "object" && !Array.isArray(error) ? (error as MetaJson) : {};
  const message = String(record.message || sanitizeMetaError(data) || "Meta API request failed").replace(/access_token=[^&\s]+/gi, "access_token=***");

  return {
    step,
    status,
    message,
    code: record.code === undefined ? undefined : String(record.code),
    errorSubcode: record.error_subcode === undefined ? undefined : String(record.error_subcode),
    errorUserMsg: record.error_user_msg === undefined ? undefined : String(record.error_user_msg),
    blameFieldSpecs: record.blame_field_specs,
    fbtraceId: record.fbtrace_id === undefined ? undefined : String(record.fbtrace_id),
    debug: record.debug,
  };
}

function shouldRetryWithoutInstagramActor(error: unknown): boolean {
  const details = error instanceof MetaApiError ? error.details : undefined;
  const text = [
    details?.step,
    details?.message,
    details?.errorUserMsg,
    error instanceof Error ? error.message : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return text.includes("creative") && text.includes("instagram_actor_id") && (text.includes("valid") || text.includes("invalid"));
}

function shouldFallbackImageUploadToPictureUrl(error: unknown): boolean {
  const details = error instanceof MetaApiError ? error.details : undefined;
  const text = [
    details?.step,
    details?.message,
    details?.errorUserMsg,
    error instanceof Error ? error.message : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    details?.step === "image_upload" &&
    (details.code === "3" ||
      text.includes("application does not have the capability to make this api call") ||
      text.includes("does not have the capability"))
  );
}

function shouldRetryWithoutInstagramPositions(error: unknown): boolean {
  const details = error instanceof MetaApiError ? error.details : undefined;
  const text = [
    details?.step,
    details?.message,
    details?.errorUserMsg,
    error instanceof Error ? error.message : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    details?.step === "adset" &&
    (text.includes("instagram_positions") ||
      text.includes("instagram position") ||
      text.includes("placement") ||
      text.includes("publisher_platforms"))
  );
}

function addWarning(warnings: string[], warning?: string) {
  const text = warning?.trim();
  if (text && !warnings.includes(text)) warnings.push(text);
}

async function parseMetaResponse(response: MetaFetchResponse): Promise<MetaJson> {
  const rawText = await response.text();
  if (!rawText.trim()) return {};

  try {
    const parsed = JSON.parse(rawText) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as MetaJson) : { raw: parsed };
  } catch {
    return { raw: rawText.slice(0, 500) };
  }
}

function resolveInstagramActorId(input: MetaLaunchInput, fallbackActorId: string): string {
  if (input.omitInstagramActor) return "";
  return (input.instagramActorId || fallbackActorId || "").trim();
}

function normalizeCityToken(value: string): string {
  return normalizeMetaCityToken(value);
}

function cacheMetaCityTarget(cacheKey: string, target: MetaCityTarget): MetaCityTarget {
  if (target.key) {
    metaCityTargetCache.set(cacheKey, { ...target, source: "cache" });
  }
  return target;
}

function readExactMetaCityFromSearch(data: MetaJson, option: MetaCityOption): {
  selected: MetaCitySearchCandidate | null;
  candidates: MetaCitySearchCandidate[];
  rejectedCandidates: MetaCitySearchCandidate[];
} {
  const items = Array.isArray(data.data) ? data.data : [];
  const candidates: MetaCitySearchCandidate[] = [];
  const rejectedCandidates: MetaCitySearchCandidate[] = [];

  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as MetaJson;
    const key = typeof record.key === "string" ? record.key.trim() : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const region = typeof record.region === "string" ? record.region.trim() : "";
    const countryCode = typeof record.country_code === "string" ? record.country_code.toUpperCase() : "";
    const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
    const supportsCity = Object.prototype.hasOwnProperty.call(record, "supports_city") ? record.supports_city === true : undefined;
    const base: Omit<MetaCitySearchCandidate, "accepted" | "matchConfidence" | "reason"> = {
      key,
      name,
      type,
      country_code: countryCode,
      region,
      supports_city: supportsCity,
    };

    if (!key || type !== "city") {
      rejectedCandidates.push({ ...base, accepted: false, matchConfidence: "rejected", reason: "not a city result" });
      continue;
    }

    if (countryCode !== option.countryCode) {
      rejectedCandidates.push({ ...base, accepted: false, matchConfidence: "rejected", reason: "not Kazakhstan" });
      continue;
    }

    if (supportsCity === false) {
      rejectedCandidates.push({ ...base, accepted: false, matchConfidence: "rejected", reason: "supports_city is false" });
      continue;
    }

    if (!cityOptionMatchesCandidate(option, name)) {
      rejectedCandidates.push({ ...base, accepted: false, matchConfidence: "rejected", reason: "not exact selected city" });
      continue;
    }

    candidates.push({ ...base, accepted: true, matchConfidence: "exact" });
  }

  return {
    selected: candidates[0] || null,
    candidates,
    rejectedCandidates,
  };
}

export async function resolveMetaCityTarget(city: string | MetaCityOption, explicitCityKey = ""): Promise<MetaCityTarget> {
  const requestedOption = typeof city === "string" ? findKzMetaCityOption(city) : city;
  const rawCityInput = typeof city === "string" ? city.trim() : city.labelRu;
  if (!requestedOption && rawCityInput) {
    return {
      key: null,
      name: rawCityInput,
      countryCode: "KZ",
      source: "fallback",
      warning: `${KZ_CITY_FALLBACK_WARNING} City: ${rawCityInput}.`,
      cityInput: rawCityInput,
      normalizedCity: normalizeCityToken(rawCityInput),
      selected: null,
      candidates: [],
      rejectedCandidates: [],
    };
  }

  const option = requestedOption || getKzMetaCityOption(typeof city === "string" ? city : city.id);
  const cityInput = typeof city === "string" ? city.trim() || option.labelRu : option.labelRu;
  const cacheKey = option.id;
  const explicitKey = explicitCityKey.trim();
  const legacyAstanaEnvKey = option.id === "astana" ? readEnv("META_ASTANA_CITY_KEY") : "";

  if (option.metaKey) {
    return cacheMetaCityTarget(cacheKey, {
      key: option.metaKey,
      name: option.canonicalName,
      countryCode: option.countryCode,
      source: "static",
      cityInput,
      cityId: option.id,
      labelRu: option.labelRu,
      canonicalName: option.canonicalName,
      normalizedCity: cacheKey,
      selected: {
        key: option.metaKey,
        name: option.canonicalName,
        type: "city",
        country_code: option.countryCode,
        accepted: true,
        matchConfidence: "exact",
      },
      candidates: [],
      rejectedCandidates: [],
    });
  }

  if (legacyAstanaEnvKey) {
    return cacheMetaCityTarget(cacheKey, {
      key: legacyAstanaEnvKey,
      name: option.canonicalName,
      countryCode: option.countryCode,
      source: "env",
      cityInput,
      cityId: option.id,
      labelRu: option.labelRu,
      canonicalName: option.canonicalName,
      normalizedCity: cacheKey,
    });
  }

  if (explicitKey) {
    return cacheMetaCityTarget(cacheKey, {
      key: explicitKey,
      name: option.canonicalName,
      countryCode: option.countryCode,
      source: "env",
      cityInput,
      cityId: option.id,
      labelRu: option.labelRu,
      canonicalName: option.canonicalName,
      normalizedCity: cacheKey,
    });
  }

  const cached = metaCityTargetCache.get(cacheKey);
  if (cached?.key) {
    return {
      ...cached,
      source: "cache",
      cityInput,
      cityId: option.id,
      labelRu: option.labelRu,
      canonicalName: option.canonicalName,
      normalizedCity: cacheKey,
    };
  }

  if (getMetaConfig().configured) {
    try {
      const search = await metaRequest(
        "/search",
        "GET",
        {
          type: "adgeolocation",
          location_types: ["city"],
          q: option.canonicalName,
          country_code: option.countryCode,
        },
        "targeting_search",
      );
      const found = readExactMetaCityFromSearch(search, option);
      if (found.selected?.key) {
        return cacheMetaCityTarget(cacheKey, {
          key: found.selected.key,
          name: found.selected.name || option.canonicalName,
          countryCode: found.selected.country_code || option.countryCode,
          region: found.selected.region,
          source: "targeting_search",
          cityInput,
          cityId: option.id,
          labelRu: option.labelRu,
          canonicalName: option.canonicalName,
          normalizedCity: cacheKey,
          selected: found.selected,
          candidates: found.candidates,
          rejectedCandidates: found.rejectedCandidates,
        });
      }
      return {
        key: null,
        name: option.canonicalName,
        countryCode: option.countryCode,
        source: "fallback",
        warning: `${KZ_CITY_FALLBACK_WARNING} City: ${option.labelRu}.`,
        cityInput,
        cityId: option.id,
        labelRu: option.labelRu,
        canonicalName: option.canonicalName,
        normalizedCity: cacheKey,
        selected: null,
        candidates: found.candidates,
        rejectedCandidates: found.rejectedCandidates,
      };
    } catch {
      // Fall through to a controlled country fallback with an explicit warning.
    }
  }

  return {
    key: null,
    name: option.canonicalName,
    countryCode: option.countryCode,
    source: "fallback",
    warning: `${KZ_CITY_FALLBACK_WARNING} City: ${option.labelRu}.`,
    cityInput,
    cityId: option.id,
    labelRu: option.labelRu,
    canonicalName: option.canonicalName,
    normalizedCity: cacheKey,
    selected: null,
    candidates: [],
    rejectedCandidates: [],
  };
}

export function buildGeoLocations(city: string, cityKey?: string): MetaJson {
  const key = cityKey?.trim();
  if (key) {
    return {
      cities: [
        {
          // If radius around a point is needed later, use custom_locations with
          // latitude/longitude instead of geo_locations.cities.
          key,
        },
      ],
    };
  }

  const normalizedCity = city.trim();
  if (!normalizedCity) return { countries: ["KZ"] };

  return { countries: ["KZ"] };
}

export function buildMetaTargetingDebug(input: {
  resolution?: MetaTargetingResolution;
  omitInstagramPositions?: boolean;
}): MetaJson {
  const cityInput = input.resolution?.cityInput || input.resolution?.city || "Kazakhstan";
  const resolution = input.resolution || {
    cityInput,
    city: "Kazakhstan",
    geoMode: "country" as const,
    radiusKm: 0,
    fallbackCountry: true,
    cityKeySource: "fallback" as const,
    source: "fallback" as const,
  };

  return {
    selectedCity: {
      id: resolution.cityId || "",
      labelRu: resolution.labelRu || "",
      canonicalName: resolution.canonicalName || resolution.city || "",
    },
    cityInput: resolution.cityInput,
    cityId: resolution.cityId || "",
    labelRu: resolution.labelRu || "",
    canonicalName: resolution.canonicalName || resolution.city || "",
    cityKey: resolution.cityKey || "",
    cityKeySource: resolution.cityKeySource,
    candidates: input.resolution?.candidates || [],
    rejectedCandidates: input.resolution?.rejectedCandidates || [],
    geoMode: resolution.geoMode,
    city: resolution.geoMode === "city" ? resolution.city : "",
    cityRadiusKm: "-",
    radiusKm: 0,
    usesRadius: false,
    fallbackCountry: resolution.fallbackCountry,
    cityWarning: resolution.warning || "",
    warning: resolution.warning || "",
    publisher_platforms: ["instagram"],
    instagram_positions: input.omitInstagramPositions ? [] : INSTAGRAM_POSITIONS,
    placementsMode: "instagram_only",
  };
}

export async function resolveMetaTargetingForCity(city: string | MetaCityOption, explicitCityKey = ""): Promise<MetaTargetingResolution> {
  const target = await resolveMetaCityTarget(city, explicitCityKey);
  const cityInput = target.cityInput || (typeof city === "string" ? city.trim() : city.labelRu) || "Astana";
  const cityName = target.name || cityInput;

  if (target.key) {
    return {
      cityInput,
      cityId: target.cityId,
      labelRu: target.labelRu,
      canonicalName: target.canonicalName,
      city: cityName,
      cityKey: target.key,
      cityKeySource: target.source,
      countryCode: target.countryCode,
      region: target.region,
      geoMode: "city",
      radiusKm: 0,
      fallbackCountry: false,
      warning: target.warning,
      source: target.source,
      selected: target.selected,
      candidates: target.candidates || [],
      rejectedCandidates: target.rejectedCandidates || [],
    };
  }

  return {
    cityInput,
    cityId: target.cityId,
    labelRu: target.labelRu,
    canonicalName: target.canonicalName,
    city: cityName,
    cityKeySource: target.source,
    countryCode: target.countryCode,
    region: target.region,
    geoMode: "country",
    radiusKm: 0,
    fallbackCountry: true,
    warning: target.warning || KZ_CITY_FALLBACK_WARNING,
    source: target.source,
    selected: target.selected,
    candidates: target.candidates || [],
    rejectedCandidates: target.rejectedCandidates || [],
  };

}

export function getMetaConfig(): MetaConfig {
  const graphVersion = normalizeGraphVersion(readEnv("META_GRAPH_VERSION"));
  const accessToken = readEnv("META_ACCESS_TOKEN");
  const adAccountId = readEnv("META_AD_ACCOUNT_ID");
  const pageId = readEnv("META_PAGE_ID");
  const instagramActorId = readEnv("META_INSTAGRAM_ACTOR_ID");
  const businessId = readEnv("META_BUSINESS_ID");

  return {
    graphVersion,
    baseUrl: `https://graph.facebook.com/${graphVersion}`,
    accessToken,
    adAccountId,
    pageId,
    instagramActorId,
    businessId,
    configured: Boolean(accessToken && adAccountId && pageId),
  };
}

export function assertMetaConfigured(): MetaConfig {
  const config = getMetaConfig();
  const missing = [
    ["META_ACCESS_TOKEN", config.accessToken],
    ["META_AD_ACCOUNT_ID", config.adAccountId],
    ["META_PAGE_ID", config.pageId],
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Meta env is not configured: ${missing.join(", ")}`);
  }

  return config;
}

export async function metaRequest(path: string, method: "GET" | "POST", body: MetaJson = {}, step?: string): Promise<MetaJson> {
  const config = assertMetaConfigured();
  const url = `${config.baseUrl}/${path.replace(/^\//, "")}`;
  const safeFetch = fetch as unknown as MetaFetch;
  const payload = { ...body, access_token: config.accessToken };
  const response =
    method === "GET"
      ? await safeFetch(appendParams(url, payload), { method: "GET" })
      : await safeFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: serializeMetaFormPayload(payload),
        });

  const data = await parseMetaResponse(response);
  if (!response.ok) {
    throw new MetaApiError(readMetaErrorDetails(data, response.status, step));
  }

  return data;
}

export function buildMetaCampaignPayload(input: MetaLaunchInput): MetaJson {
  return {
    name: input.campaignName,
    objective: input.objective || "OUTCOME_LEADS",
    buying_type: "AUCTION",
    special_ad_categories: [],
    is_adset_budget_sharing_enabled: false,
    status: input.status,
  };
}

function resolveDailyBudgetMinorUnits(input: MetaAdSetPayloadInput): number {
  const directMinorUnits = Number(input.dailyBudgetMinor);
  if (Number.isFinite(directMinorUnits) && directMinorUnits > 0) {
    return Math.round(directMinorUnits);
  }

  const dailyBudgetUsd = Number(input.dailyBudgetUsd ?? input.budgetDailyUsd ?? input.dailyBudget);
  if (!Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd <= 0) {
    throw new Error("Некорректный дневной бюджет рекламы.");
  }

  return Math.round(dailyBudgetUsd * 100);
}

function buildMetaTargeting(input: MetaAdSetPayloadInput): MetaJson {
  const targeting = input.targeting;
  const hasCustomTargeting = targeting && Object.keys(targeting).length > 0;
  const baseTargeting: MetaJson = hasCustomTargeting ? { ...targeting } : {};
  const ageMin = Number(baseTargeting.age_min);
  const ageMax = Number(baseTargeting.age_max);
  const currentAutomation =
    baseTargeting.targeting_automation && typeof baseTargeting.targeting_automation === "object" && !Array.isArray(baseTargeting.targeting_automation)
      ? (baseTargeting.targeting_automation as MetaJson)
      : {};

  return {
    geo_locations: buildGeoLocations(input.city || "", input.targetingResolution?.cityKey || input.metaCityKey || input.astanaCityKey),
    age_min: Number.isFinite(ageMin) && ageMin > 0 ? ageMin : 25,
    age_max: Number.isFinite(ageMax) && ageMax > 0 ? ageMax : 55,
    targeting_automation: {
      ...currentAutomation,
      advantage_audience: 0,
    },
    publisher_platforms: ["instagram"],
    ...(input.omitInstagramPositions ? {} : { instagram_positions: INSTAGRAM_POSITIONS }),
  };
}

export function buildMetaAdSetPayload(input: MetaAdSetPayloadInput): MetaJson {
  const dailyBudgetMinorUnits = resolveDailyBudgetMinorUnits(input);
  if (dailyBudgetMinorUnits < 100) {
    throw new Error("Дневной бюджет слишком маленький для Meta.");
  }

  return {
    name: input.adSetName || `${input.campaignName} - Ad Set`,
    campaign_id: input.campaignId,
    daily_budget: String(dailyBudgetMinorUnits),
    billing_event: "IMPRESSIONS",
    optimization_goal: "LINK_CLICKS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    targeting: buildMetaTargeting(input),
    start_time: input.startTime,
    status: input.status,
  };
}

export async function createMetaCampaign(input: MetaLaunchInput): Promise<MetaJson> {
  const { adAccountId } = assertMetaConfigured();
  return metaRequest(`/${adAccountId}/campaigns`, "POST", buildMetaCampaignPayload(input), "campaign");
}

export async function createMetaAdSet(input: MetaLaunchInput & { campaignId: string }): Promise<MetaJson> {
  const { adAccountId } = assertMetaConfigured();
  const adsetPayload = buildMetaAdSetPayload(input);
  if (!adsetPayload.daily_budget && !adsetPayload.lifetime_budget) {
    throw new Error("Meta ad set payload missing daily_budget/lifetime_budget");
  }
  return metaRequest(`/${adAccountId}/adsets`, "POST", adsetPayload, "adset");
}

export async function uploadMetaVideo(input: { videoUrl: string; title?: string }): Promise<MetaJson> {
  const { adAccountId } = assertMetaConfigured();
  const videoUrl = input.videoUrl.trim();

  if (!videoUrl) {
    throw new Error("Video URL is required for Meta video upload");
  }

  return metaRequest(`/${adAccountId}/advideos`, "POST", {
    file_url: videoUrl,
    title: input.title || "Negis video creative",
  }, "video_upload");
}

export async function uploadMetaVideoAndGetId(input: { videoUrl: string; title?: string; mimeType?: string }): Promise<string> {
  // TODO:
  // 1. validate MP4
  // 2. upload to Meta advideos/video_ads
  // 3. poll processing status if needed
  // 4. return video_id
  if (!isMetaVideoLaunchEnabled()) {
    throw new Error(META_VIDEO_LAUNCH_DISABLED_MESSAGE);
  }

  const data = await uploadMetaVideo(input);
  const directId = data.id;
  const videoId = data.video_id;
  if (typeof directId === "string" && directId) return directId;
  if (typeof videoId === "string" && videoId) return videoId;
  throw new Error("Meta returned video upload response without video_id");
}

function parseMetaImageHash(data: MetaJson): string {
  const directHash = data.hash;
  if (typeof directHash === "string") return directHash;

  const images = data.images;
  if (images && typeof images === "object" && !Array.isArray(images)) {
    for (const value of Object.values(images as Record<string, unknown>)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const hash = (value as MetaJson).hash;
        if (typeof hash === "string" && hash) return hash;
      }
    }
  }

  return "";
}

function assertMetaImageHash(imageHash: string, debug?: unknown): string {
  const normalized = imageHash.trim();
  if (!normalized) {
    throw new MetaApiError({
      step: "image_upload",
      message: "Meta image_hash не получен. Проверьте загрузку изображения в Meta.",
      debug,
    });
  }

  return normalized;
}

export async function uploadMetaImageFromUrl(input: { imageUrl: string; name?: string }): Promise<MetaJson> {
  const { adAccountId } = assertMetaConfigured();
  const imageUrl = input.imageUrl.trim();

  if (!imageUrl) {
    throw new Error("Image URL is required for Meta image upload");
  }

  return metaRequest(`/${adAccountId}/adimages`, "POST", {
    url: imageUrl,
    name: input.name || "Negis image creative",
  }, "image_upload");
}

export function buildImageLinkCreativePayload(input: MetaLaunchInput & { pageId: string; imageHash: string; instagramActorId?: string }): MetaJson {
  const imageHash = assertMetaImageHash(input.imageHash);
  const objectStorySpec: MetaJson = {
    page_id: input.pageId,
    ...(input.instagramActorId ? { instagram_actor_id: input.instagramActorId } : {}),
    link_data: {
      message: input.primaryText,
      link: input.landingUrl,
      name: input.headline,
      description: input.description,
      image_hash: imageHash,
      call_to_action: {
        type: input.cta || "LEARN_MORE",
        value: {
          link: input.landingUrl,
        },
      },
    },
  };

  return {
    name: input.creativeName || `${input.campaignName} - Creative`,
    object_story_spec: objectStorySpec,
  };
}

export function buildImagePictureCreativePayload(input: MetaLaunchInput & { pageId: string; pictureUrl: string; instagramActorId?: string }): MetaJson {
  const pictureUrl = input.pictureUrl.trim();
  if (!pictureUrl) {
    throw new MetaApiError({
      step: "creative",
      message: "Meta picture URL не получен. Проверьте публичную ссылку Supabase.",
    });
  }

  const objectStorySpec: MetaJson = {
    page_id: input.pageId,
    ...(input.instagramActorId ? { instagram_actor_id: input.instagramActorId } : {}),
    link_data: {
      message: input.primaryText,
      link: input.landingUrl,
      name: input.headline,
      description: input.description,
      picture: pictureUrl,
      call_to_action: {
        type: input.cta || "LEARN_MORE",
        value: {
          link: input.landingUrl,
        },
      },
    },
  };

  return {
    name: input.creativeName || `${input.campaignName} - Creative`,
    object_story_spec: objectStorySpec,
  };
}

export function buildVideoCreativePayload(input: MetaLaunchInput & { pageId: string; videoId: string; instagramActorId?: string }): MetaJson {
  const objectStorySpec: MetaJson = {
    page_id: input.pageId,
    ...(input.instagramActorId ? { instagram_actor_id: input.instagramActorId } : {}),
    video_data: {
      video_id: input.videoId,
      title: input.headline,
      message: input.primaryText,
      link_description: input.description,
      ...(input.thumbnailUrl ? { image_url: input.thumbnailUrl } : {}),
      call_to_action: {
        type: input.cta || "LEARN_MORE",
        value: {
          link: input.landingUrl,
        },
      },
    },
  };

  return {
    name: input.creativeName || `${input.campaignName} - Video Creative`,
    object_story_spec: objectStorySpec,
  };
}

export async function createImageCreative(input: MetaLaunchInput): Promise<MetaCreativeCreateResult> {
  const { adAccountId, pageId, instagramActorId: configuredInstagramActorId } = assertMetaConfigured();
  const instagramActorId = resolveInstagramActorId(input, configuredInstagramActorId);

  if (!input.imageUrl) {
    throw new MetaApiError({
      step: "image_upload",
      message: "Meta image_hash не получен. Проверьте загрузку изображения в Meta.",
    });
  }

  try {
    const image = await uploadMetaImageFromUrl({
      imageUrl: input.imageUrl,
      name: input.creativeName || `${input.campaignName} - Image`,
    });
    const imageHash = assertMetaImageHash(parseMetaImageHash(image), {
      responseKeys: Object.keys(image),
      imageKeys:
        image.images && typeof image.images === "object" && !Array.isArray(image.images)
          ? Object.keys(image.images as Record<string, unknown>)
          : [],
    });

    const data = await metaRequest(`/${adAccountId}/adcreatives`, "POST", {
      ...buildImageLinkCreativePayload({
        ...input,
        pageId,
        imageHash,
        instagramActorId,
      }),
    }, "creative");

    return {
      data,
      objectStorySpecType: "link_data",
      usesLinkData: true,
      usesVideoData: false,
      imageHashReceived: true,
      imageUploadMode: "adimages",
      imageUploadCapabilityFallback: false,
      pictureUrlUsed: false,
    };
  } catch (error) {
    if (!shouldFallbackImageUploadToPictureUrl(error)) {
      throw error;
    }
  }

  const data = await metaRequest(`/${adAccountId}/adcreatives`, "POST", {
    ...buildImagePictureCreativePayload({
      ...input,
      pageId,
      pictureUrl: input.imageUrl,
      instagramActorId,
    }),
  }, "creative");

  return {
    data,
    objectStorySpecType: "link_data",
    usesLinkData: true,
    usesVideoData: false,
    imageHashReceived: false,
    imageUploadMode: "picture_url",
    imageUploadCapabilityFallback: true,
    pictureUrlUsed: true,
    warning: IMAGE_UPLOAD_CAPABILITY_FALLBACK_WARNING,
  };
}

export async function createVideoCreative(input: MetaLaunchInput & { videoId: string }): Promise<MetaCreativeCreateResult> {
  const { adAccountId, pageId, instagramActorId: configuredInstagramActorId } = assertMetaConfigured();
  const instagramActorId = resolveInstagramActorId(input, configuredInstagramActorId);

  const data = await metaRequest(`/${adAccountId}/adcreatives`, "POST", {
    ...buildVideoCreativePayload({
      ...input,
      pageId,
      instagramActorId,
    }),
  }, "creative");

  return {
    data,
    objectStorySpecType: "video_data",
    usesLinkData: false,
    usesVideoData: true,
    imageHashReceived: false,
  };
}

export async function createMetaCreative(input: MetaLaunchInput): Promise<MetaCreativeCreateResult> {
  if (input.creativeType === "video") {
    if (!input.videoId) {
      throw new Error("Видео-реклама через Meta API требует video_id. Сначала протестируйте запуск фото.");
    }
    return createVideoCreative({ ...input, videoId: input.videoId });
  }

  return createImageCreative(input);
}

export async function createMetaAd(input: MetaLaunchInput & { adSetId: string; creativeId: string }): Promise<MetaJson> {
  const { adAccountId } = assertMetaConfigured();
  return metaRequest(`/${adAccountId}/ads`, "POST", {
    name: input.adName || `${input.campaignName} - Ad`,
    adset_id: input.adSetId,
    creative: { creative_id: input.creativeId },
    status: input.status,
  }, "ad");
}

export async function launchMetaCampaign(input: MetaLaunchInput): Promise<MetaLaunchResult> {
  if (input.creativeType === "video" && !isMetaVideoLaunchEnabled()) {
    throw new Error(META_VIDEO_LAUNCH_DISABLED_MESSAGE);
  }
  const preparedInput =
    input.creativeType === "video"
      ? { ...input, creativeType: "video" as const, imageUrl: undefined }
      : { ...input, creativeType: "image" as const, videoUrl: undefined, videoId: undefined };
  const warnings: string[] = [];
  addWarning(warnings, input.targetingResolution?.warning);

  const campaign = await createMetaCampaign(preparedInput);
  const metaCampaignId = parseMetaId(campaign);
  if (!metaCampaignId) throw new Error("Meta campaign was created without id");

  let instagramPositionsFallback = false;
  let adSet: MetaJson;
  try {
    adSet = await createMetaAdSet({ ...preparedInput, campaignId: metaCampaignId });
  } catch (error) {
    if (!preparedInput.omitInstagramPositions && shouldRetryWithoutInstagramPositions(error)) {
      instagramPositionsFallback = true;
      addWarning(warnings, INSTAGRAM_PLACEMENT_FALLBACK_WARNING);
      adSet = await createMetaAdSet({ ...preparedInput, campaignId: metaCampaignId, omitInstagramPositions: true });
    } else {
      throw error;
    }
  }
  const metaAdSetId = parseMetaId(adSet);
  if (!metaAdSetId) throw new Error("Meta ad set was created without id");

  let creative: MetaJson;
  let instagramActorFallback = false;
  let creativeUsesInstagramActor = Boolean(resolveInstagramActorId(preparedInput, getMetaConfig().instagramActorId));
  let creativeObjectStorySpecType: "link_data" | "video_data" = "link_data";
  let creativeUsesLinkData = true;
  let creativeUsesVideoData = false;
  let imageHashReceived = false;
  let imageUploadMode: MetaImageUploadMode = "adimages";
  let imageUploadCapabilityFallback = false;
  let pictureUrlUsed = false;
  let creativeInput: MetaLaunchInput = preparedInput;
  if (preparedInput.creativeType === "video" && !preparedInput.videoId) {
    const videoId = await uploadMetaVideoAndGetId({
      videoUrl: preparedInput.videoUrl || "",
      title: preparedInput.creativeName || `${preparedInput.campaignName} - Video`,
    });
    creativeInput = { ...preparedInput, videoId };
  }
  try {
    const creativeResult = await createMetaCreative(creativeInput);
    creative = creativeResult.data;
    creativeObjectStorySpecType = creativeResult.objectStorySpecType;
    creativeUsesLinkData = creativeResult.usesLinkData;
    creativeUsesVideoData = creativeResult.usesVideoData;
    imageHashReceived = creativeResult.imageHashReceived;
    imageUploadMode = creativeResult.imageUploadMode || imageUploadMode;
    imageUploadCapabilityFallback = Boolean(creativeResult.imageUploadCapabilityFallback);
    pictureUrlUsed = Boolean(creativeResult.pictureUrlUsed);
    addWarning(warnings, creativeResult.warning);
  } catch (error) {
    if (preparedInput.status === "PAUSED" && shouldRetryWithoutInstagramActor(error)) {
      instagramActorFallback = true;
      creativeUsesInstagramActor = false;
      addWarning(warnings, INSTAGRAM_ACTOR_FALLBACK_WARNING);
      const creativeResult = await createMetaCreative({ ...creativeInput, omitInstagramActor: true });
      creative = creativeResult.data;
      creativeObjectStorySpecType = creativeResult.objectStorySpecType;
      creativeUsesLinkData = creativeResult.usesLinkData;
      creativeUsesVideoData = creativeResult.usesVideoData;
      imageHashReceived = creativeResult.imageHashReceived;
      imageUploadMode = creativeResult.imageUploadMode || imageUploadMode;
      imageUploadCapabilityFallback = Boolean(creativeResult.imageUploadCapabilityFallback);
      pictureUrlUsed = Boolean(creativeResult.pictureUrlUsed);
      addWarning(warnings, creativeResult.warning);
    } else {
      throw error;
    }
  }
  const metaCreativeId = parseMetaId(creative);
  if (!metaCreativeId) throw new Error("Meta creative was created without id");

  const ad = await createMetaAd({ ...preparedInput, adSetId: metaAdSetId, creativeId: metaCreativeId });
  const metaAdId = parseMetaId(ad);
  if (!metaAdId) throw new Error("Meta ad was created without id");

  return {
    campaign,
    adSet,
    creative,
    ad,
    metaCampaignId,
    metaAdSetId,
    metaCreativeId,
    metaAdId,
    warning: warnings.join(" "),
    warnings,
    creativeUsesInstagramActor,
    instagramActorFallback,
    creativeObjectStorySpecType,
    creativeUsesLinkData,
    creativeUsesVideoData,
    imageHashReceived,
    imageUploadMode,
    imageUploadCapabilityFallback,
    pictureUrlUsed,
    instagramPositionsFallback,
  };
}

export async function checkMetaAdAccount(): Promise<MetaJson> {
  const { adAccountId } = assertMetaConfigured();
  return metaRequest(`/${adAccountId}`, "GET", {
    fields: "id,name,account_status,currency,timezone_name",
  });
}

export async function checkMetaInstagramActor(): Promise<MetaJson> {
  const { instagramActorId } = assertMetaConfigured();
  if (!instagramActorId) {
    return { configured: false, valid: false };
  }

  return metaRequest(`/${instagramActorId}`, "GET", {
    fields: "id,username,name",
  }, "instagram_actor_validate");
}

export async function getMetaCampaignStatus(campaignId: string): Promise<MetaJson> {
  return metaRequest(`/${campaignId}`, "GET", {
    fields: "id,name,status,effective_status,configured_status,updated_time",
  });
}

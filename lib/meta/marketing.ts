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
};

type MetaAdSetPayloadInput = MetaLaunchInput & {
  campaignId: string;
  adSetName?: string;
  dailyBudgetUsd?: unknown;
  budgetDailyUsd?: unknown;
  dailyBudget?: unknown;
};

const INSTAGRAM_ACTOR_FALLBACK_WARNING =
  "Instagram actor ID отклонён Meta. Кампания создана через Facebook Page. Для запуска в Instagram нужно переподключить Instagram account.";

function readEnv(key: string): string {
  return process.env[key]?.trim() || "";
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

function buildMetaTargeting(targeting?: MetaJson): MetaJson {
  const hasCustomTargeting = targeting && Object.keys(targeting).length > 0;
  const baseTargeting: MetaJson = hasCustomTargeting
    ? { ...targeting }
    : {
        geo_locations: { countries: ["KZ"] },
        age_min: 25,
        age_max: 55,
      };
  const currentAutomation =
    baseTargeting.targeting_automation && typeof baseTargeting.targeting_automation === "object" && !Array.isArray(baseTargeting.targeting_automation)
      ? (baseTargeting.targeting_automation as MetaJson)
      : {};

  return {
    ...baseTargeting,
    targeting_automation: {
      ...currentAutomation,
      advantage_audience: 0,
    },
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
    targeting: buildMetaTargeting(input.targeting),
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
    name: `${input.campaignName} - Creative`,
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
    name: `${input.campaignName} - Video Creative`,
    object_story_spec: objectStorySpec,
  };
}

export async function createImageCreative(input: MetaLaunchInput): Promise<MetaJson> {
  const { adAccountId, pageId, instagramActorId: configuredInstagramActorId } = assertMetaConfigured();
  const instagramActorId = resolveInstagramActorId(input, configuredInstagramActorId);

  if (!input.imageUrl) {
    throw new MetaApiError({
      step: "image_upload",
      message: "Meta image_hash не получен. Проверьте загрузку изображения в Meta.",
    });
  }

  const image = await uploadMetaImageFromUrl({
    imageUrl: input.imageUrl,
    name: `${input.campaignName} - Image`,
  });
  const imageHash = assertMetaImageHash(parseMetaImageHash(image), {
    responseKeys: Object.keys(image),
    imageKeys:
      image.images && typeof image.images === "object" && !Array.isArray(image.images)
        ? Object.keys(image.images as Record<string, unknown>)
        : [],
  });

  return metaRequest(`/${adAccountId}/adcreatives`, "POST", {
    ...buildImageLinkCreativePayload({
      ...input,
      pageId,
      imageHash,
      instagramActorId,
    }),
  }, "creative");
}

export async function createVideoCreative(input: MetaLaunchInput & { videoId: string }): Promise<MetaJson> {
  const { adAccountId, pageId, instagramActorId: configuredInstagramActorId } = assertMetaConfigured();
  const instagramActorId = resolveInstagramActorId(input, configuredInstagramActorId);

  return metaRequest(`/${adAccountId}/adcreatives`, "POST", {
    ...buildVideoCreativePayload({
      ...input,
      pageId,
      instagramActorId,
    }),
  }, "creative");
}

export async function createMetaCreative(input: MetaLaunchInput): Promise<MetaJson> {
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
    name: `${input.campaignName} - Ad`,
    adset_id: input.adSetId,
    creative: { creative_id: input.creativeId },
    status: input.status,
  }, "ad");
}

export async function launchMetaCampaign(input: MetaLaunchInput): Promise<MetaLaunchResult> {
  if (input.creativeType === "video") {
    throw new Error("Видео-реклама через Meta API требует video_id. Сначала протестируйте запуск фото.");
  }
  const preparedInput = { ...input, creativeType: "image" as const, videoUrl: undefined, videoId: undefined };

  const campaign = await createMetaCampaign(preparedInput);
  const metaCampaignId = parseMetaId(campaign);
  if (!metaCampaignId) throw new Error("Meta campaign was created without id");

  const adSet = await createMetaAdSet({ ...preparedInput, campaignId: metaCampaignId });
  const metaAdSetId = parseMetaId(adSet);
  if (!metaAdSetId) throw new Error("Meta ad set was created without id");

  let creative: MetaJson;
  let warning = "";
  let instagramActorFallback = false;
  let creativeUsesInstagramActor = Boolean(resolveInstagramActorId(preparedInput, getMetaConfig().instagramActorId));
  try {
    creative = await createMetaCreative(preparedInput);
  } catch (error) {
    if (preparedInput.status === "PAUSED" && shouldRetryWithoutInstagramActor(error)) {
      instagramActorFallback = true;
      creativeUsesInstagramActor = false;
      warning = INSTAGRAM_ACTOR_FALLBACK_WARNING;
      creative = await createMetaCreative({ ...preparedInput, omitInstagramActor: true });
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
    warning,
    warnings: warning ? [warning] : [],
    creativeUsesInstagramActor,
    instagramActorFallback,
    creativeObjectStorySpecType: "link_data",
    creativeUsesLinkData: true,
    creativeUsesVideoData: false,
    imageHashReceived: true,
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

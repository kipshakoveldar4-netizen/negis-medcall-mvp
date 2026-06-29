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
  startTime?: string;
  endTime?: string;
  targeting?: MetaJson;
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
};

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

export async function metaRequest(path: string, method: "GET" | "POST", body: MetaJson = {}): Promise<MetaJson> {
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
          body: new URLSearchParams(
            Object.fromEntries(
              Object.entries(payload)
                .filter(([, value]) => value !== undefined && value !== null && value !== "")
                .map(([key, value]) => [key, typeof value === "object" ? JSON.stringify(value) : String(value)]),
            ),
          ).toString(),
        });

  const data = await parseMetaResponse(response);
  if (!response.ok) {
    throw new Error(`${sanitizeMetaError(data)} (HTTP ${response.status})`);
  }

  return data;
}

export async function createMetaCampaign(input: MetaLaunchInput): Promise<MetaJson> {
  const { adAccountId } = assertMetaConfigured();
  return metaRequest(`/${adAccountId}/campaigns`, "POST", {
    name: input.campaignName,
    objective: input.objective || "OUTCOME_LEADS",
    buying_type: "AUCTION",
    special_ad_categories: [],
    status: input.status,
  });
}

export async function createMetaAdSet(input: MetaLaunchInput & { campaignId: string }): Promise<MetaJson> {
  const { adAccountId } = assertMetaConfigured();
  return metaRequest(`/${adAccountId}/adsets`, "POST", {
    name: `${input.campaignName} - Ad Set`,
    campaign_id: input.campaignId,
    daily_budget: input.dailyBudgetMinor,
    ...(input.lifetimeBudgetMinor ? { lifetime_budget: input.lifetimeBudgetMinor } : {}),
    billing_event: "IMPRESSIONS",
    optimization_goal: "LEAD_GENERATION",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    targeting: input.targeting || {
      geo_locations: { countries: ["KZ"] },
      age_min: 25,
      age_max: 55,
    },
    start_time: input.startTime,
    end_time: input.endTime,
    status: input.status,
  });
}

export async function createMetaCreative(input: MetaLaunchInput): Promise<MetaJson> {
  const { adAccountId, pageId, instagramActorId } = assertMetaConfigured();
  const objectStorySpec: MetaJson = {
    page_id: pageId,
    ...(instagramActorId ? { instagram_actor_id: instagramActorId } : {}),
    link_data: {
      message: input.primaryText,
      link: input.landingUrl,
      name: input.headline,
      description: input.description,
      ...(input.imageUrl ? { picture: input.imageUrl } : {}),
      call_to_action: {
        type: input.cta || "LEARN_MORE",
        value: {
          link: input.landingUrl,
        },
      },
    },
  };

  return metaRequest(`/${adAccountId}/adcreatives`, "POST", {
    name: `${input.campaignName} - Creative`,
    object_story_spec: objectStorySpec,
  });
}

export async function createMetaAd(input: MetaLaunchInput & { adSetId: string; creativeId: string }): Promise<MetaJson> {
  const { adAccountId } = assertMetaConfigured();
  return metaRequest(`/${adAccountId}/ads`, "POST", {
    name: `${input.campaignName} - Ad`,
    adset_id: input.adSetId,
    creative: { creative_id: input.creativeId },
    status: input.status,
  });
}

export async function launchMetaCampaign(input: MetaLaunchInput): Promise<MetaLaunchResult> {
  const campaign = await createMetaCampaign(input);
  const metaCampaignId = parseMetaId(campaign);
  if (!metaCampaignId) throw new Error("Meta campaign was created without id");

  const adSet = await createMetaAdSet({ ...input, campaignId: metaCampaignId });
  const metaAdSetId = parseMetaId(adSet);
  if (!metaAdSetId) throw new Error("Meta ad set was created without id");

  const creative = await createMetaCreative(input);
  const metaCreativeId = parseMetaId(creative);
  if (!metaCreativeId) throw new Error("Meta creative was created without id");

  const ad = await createMetaAd({ ...input, adSetId: metaAdSetId, creativeId: metaCreativeId });
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
  };
}

export async function checkMetaAdAccount(): Promise<MetaJson> {
  const { adAccountId } = assertMetaConfigured();
  return metaRequest(`/${adAccountId}`, "GET", {
    fields: "id,name,account_status,currency,timezone_name",
  });
}

export async function getMetaCampaignStatus(campaignId: string): Promise<MetaJson> {
  return metaRequest(`/${campaignId}`, "GET", {
    fields: "id,name,status,effective_status,configured_status,updated_time",
  });
}

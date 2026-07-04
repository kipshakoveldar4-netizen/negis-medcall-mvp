import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type ApiBody = {
  success?: boolean;
  mode?: string;
  error?: string;
  details?: string[];
  data?: unknown;
};

export {};

const baseUrl = (
  process.env.NEGIS_SMOKE_BASE_URL ||
  process.env.NEGIS_BASE_URL ||
  "http://localhost:5173"
).replace(/\/$/, "");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function assertSourceIncludes(source: string, expected: string, label: string) {
  if (!source.includes(expected)) {
    throw new Error(`AdsAutomation source is missing ${label}`);
  }
}

function assertSourceExcludes(source: string, forbidden: string, label: string) {
  if (source.includes(forbidden)) {
    throw new Error(`AdsAutomation source still contains ${label}`);
  }
}

async function checkAdsAutomationSource() {
  const source = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "AdsAutomation.tsx"), "utf8");

  assertSourceIncludes(source, "publicURL", "publicURL normalization");
  assertSourceIncludes(source, "buildFrontendStoragePublicUrl(storagePath, storageBucket)", "publicUrl derivation from storagePath");
  assertSourceIncludes(source, "Техническая информация", "collapsed technical info block");
  assertSourceIncludes(source, "Перейти к подтверждению запуска", "step 5 launch confirmation button");
  assertSourceIncludes(source, "Назад к отчёту", "step 6 back to report button");
  assertSourceIncludes(source, 'imageUrl: creative?.fileType === "image" ? creativeUrl : ""', "imageUrl launch payload");
  assertSourceIncludes(source, 'videoUrl: creative?.fileType === "video" ? creativeUrl : ""', "videoUrl launch payload");
  assertSourceIncludes(source, "Загрузка не прошла. Попробуйте другой файл.", "failed upload message");
  assertSourceIncludes(source, "getting_signed_url", "signed URL status");
  assertSourceIncludes(source, "uploading_to_storage", "Storage upload status");
  assertSourceIncludes(source, "saving_metadata", "metadata save status");
  assertSourceIncludes(source, "setUploadStatus(\"failed\")", "failed upload state");
  assertSourceIncludes(source, "creativeCanContinue = Boolean(creative?.publicUrl)", "ready state requires publicUrl");
  assertSourceIncludes(source, "uploadToSignedUrl", "signed Supabase upload call");
  assertSourceIncludes(source, "/api/crm/ad-creatives/signed-upload", "signed upload endpoint");
  assertSourceIncludes(source, "/api/crm/ad-creatives", "metadata save endpoint");
  assertSourceIncludes(source, "signed_url", "signed upload metadata marker");
  assertSourceIncludes(source, "lastUploadError", "detailed upload error state");
  assertSourceIncludes(source, "VERCEL_FUNCTION_FILE_LIMIT_BYTES", "Vercel payload guard");
  assertSourceIncludes(source, "creative.imageUploadMode", "Meta image upload mode debug");
  assertSourceIncludes(source, "creative.pictureUrl", "Meta picture URL fallback debug");
  assertSourceIncludes(source, "creative.imageUploadCapabilityFallback", "Meta image upload fallback debug");
  assertSourceIncludes(source, "VIDEO_REAL_LAUNCH_DISABLED_MESSAGE", "video real launch disabled copy");
  assertSourceIncludes(source, "VIDEO_LAUNCH_SOON_MESSAGE", "video launch soon helper text");
  assertSourceIncludes(source, "MOV_VIDEO_WARNING", "MOV upload warning");
  assertSourceIncludes(source, "VIDEO_LAUNCH_ENABLED_MESSAGE", "video launch enabled helper text");
  assertSourceIncludes(source, "VIDEO_FORMAT_ERROR", "video format validation message");
  assertSourceIncludes(source, "creative.videoLaunchEnabled", "video launch flag debug");
  assertSourceIncludes(source, "creative.metaVideoLaunchStatus", "video launch status debug");
  assertSourceIncludes(source, "video.mimeType", "video MIME debug");
  assertSourceIncludes(source, "video.uploadMode", "video upload mode debug");
  assertSourceIncludes(source, "video.videoId", "video ID debug");
  assertSourceIncludes(source, "Meta Video ID", "video ID launch result");
  assertSourceIncludes(source, "KZ_META_CITY_OPTIONS", "controlled Kazakhstan city options");
  assertSourceIncludes(source, "selectedCityId", "selected city id launch payload");
  assertSourceIncludes(source, "selectedCityCanonicalName", "selected city canonical name launch payload");
  assertSourceIncludes(source, "<select", "controlled city select");
  assertSourceExcludes(source, 'Field label="Город" value={brief.city}', "free-text city Field");
  assertSourceIncludes(source, "cityRadiusKm", "city radius disabled debug");
  assertSourceIncludes(source, "usesRadius", "usesRadius debug");
  assertSourceExcludes(source, "targetingRadiusKm", "city radius report variable");
  assertSourceExcludes(source, "радиус ${targeting", "radius wording in final city report");
  assertSourceIncludes(source, "Meta не разрешила загрузить изображение через /adimages", "Meta image upload fallback warning");
  assertSourceExcludes(source, "/api/crm/ad-creative-upload", "file upload endpoint in UI");
  assertSourceExcludes(source, "new FormData(", "multipart upload from UI");
  assertSourceExcludes(source, ".upload(storagePath, file", "anonymous Supabase upload call");
  assertSourceExcludes(source, "Файл загружается. Подождите несколько секунд.", "stale endless upload message");
  assertSourceIncludes(source, "resolveLaunchMode", "history launch mode normalization");
  assertSourceIncludes(source, "isDryRunMetaId", "dryrun_ Meta ID detection");
  assertSourceIncludes(source, "DRY-RUN / Проверка", "dry-run history badge");
  assertSourceIncludes(source, "Meta API не вызывался", "dry-run entries must say Meta API was not called");
  assertSourceIncludes(source, "PAUSED / выключено", "real PAUSED history badge");
  assertSourceIncludes(source, "Видео обрабатывается", "video processing history badge");
  assertSourceIncludes(source, "Проверить готовность видео", "video processing recheck action");
  assertSourceIncludes(source, "Видео принято Meta и обрабатывается. Это не ошибка.", "video processing in-progress copy");
  assertSourceIncludes(source, "lastCheckedAt", "video processing lastCheckedAt display");
  assertSourceIncludes(source, "VideoProcessingPendingError", "controlled pending video state");
  assertSourceIncludes(source, 'metaVideoId: creative.metaVideoId || ""', "video_id reuse in meta upload request");
  assertSourceIncludes(source, "captureVideoThumbnail", "automatic video thumbnail capture");
  assertSourceIncludes(source, "uploadVideoThumbnail", "thumbnail upload through signed storage flow");
  assertSourceIncludes(source, "Обложка видео создана автоматически", "auto thumbnail ready message");
  assertSourceIncludes(source, "Не удалось автоматически создать обложку видео", "controlled thumbnail failure warning");
  assertSourceIncludes(source, "Создать обложку заново", "thumbnail regenerate action");
  assertSourceIncludes(source, 'thumbnailSource: "auto_frame"', "auto_frame thumbnail source metadata");
  assertSourceIncludes(source, "thumbnailGeneratedAt", "thumbnail generation timestamp metadata");
  assertSourceIncludes(source, "video.thumbnailUrl", "thumbnail debug in technical info");
  assertSourceIncludes(source, "creative.videoDataHasImageUrl", "video_data image_url debug in technical info");

  console.log("AdsAutomation source checks: ok");
}

async function checkMetaMarketingSource() {
  const source = await readFile(path.join(repoRoot, "lib", "meta", "marketing.ts"), "utf8");
  const citiesSource = await readFile(path.join(repoRoot, "lib", "meta", "cities.ts"), "utf8");

  if (!source.includes("uploadMetaImageFromUrl")) {
    throw new Error("Meta marketing source is missing uploadMetaImageFromUrl");
  }
  if (!source.includes("/adimages")) {
    throw new Error("Meta marketing source is missing /adimages upload");
  }
  if (!source.includes("image_hash")) {
    throw new Error("Meta marketing source is missing image_hash creative flow");
  }
  if (!source.includes("buildImageLinkCreativePayload")) {
    throw new Error("Meta marketing source is missing explicit image link creative builder");
  }
  if (!source.includes("buildVideoCreativePayload")) {
    throw new Error("Meta marketing source is missing explicit video creative builder");
  }
  if (!source.includes("META_VIDEO_LAUNCH_DISABLED_MESSAGE")) {
    throw new Error("Meta marketing source must expose a controlled disabled message for video real launch");
  }
  if (!source.includes("META_VIDEO_LAUNCH_ENABLED")) {
    throw new Error("Meta marketing source must use META_VIDEO_LAUNCH_ENABLED feature flag");
  }
  if (!source.includes("uploadMetaVideoAndGetId")) {
    throw new Error("Meta marketing source is missing video_id upload flow");
  }
  if (!source.includes("/{adAccountId}/advideos") && !source.includes("`/${adAccountId}/advideos`")) {
    throw new Error("Meta marketing source must upload videos through /advideos");
  }
  if (!source.includes("pollMetaVideoProcessing")) {
    throw new Error("Meta video upload flow must poll processing status");
  }
  if (!source.includes("uploadMetaVideoBinary")) {
    throw new Error("Meta video upload flow must include binary fallback");
  }
  if (!source.includes("META_VIDEO_PROCESSING_TIMEOUT_MESSAGE")) {
    throw new Error("Meta video upload flow must return a controlled processing timeout message");
  }
  if (source.includes("status,processing_progress")) {
    throw new Error("Meta video polling must not request top-level processing_progress (Meta #100 nonexisting field)");
  }
  if (!source.includes("META_MOV_VIDEO_WARNING")) {
    throw new Error("Meta marketing source must warn but allow MOV");
  }
  if (!source.includes("buildImagePictureCreativePayload")) {
    throw new Error("Meta marketing source is missing picture URL fallback creative builder");
  }
  if (!source.includes("link_data:")) {
    throw new Error("Meta image creative source is missing object_story_spec.link_data");
  }
  if (!source.includes("video_data:")) {
    throw new Error("Meta video creative source is missing object_story_spec.video_data");
  }
  if (!source.includes("Meta image_hash не получен")) {
    throw new Error("Meta image creative source must fail clearly when image_hash is missing");
  }
  if (!source.includes("shouldFallbackImageUploadToPictureUrl")) {
    throw new Error("Meta marketing source is missing image upload capability fallback guard");
  }
  if (!source.includes('details.code === "3"')) {
    throw new Error("Meta image upload fallback must handle Meta code 3");
  }
  if (!source.includes("does not have the capability")) {
    throw new Error("Meta image upload fallback must handle capability errors");
  }
  if (!source.includes("picture: pictureUrl")) {
    throw new Error("Meta image fallback creative must use link_data.picture");
  }
  if (!source.includes("IMAGE_UPLOAD_CAPABILITY_FALLBACK_WARNING")) {
    throw new Error("Meta image upload fallback warning is missing");
  }
  if (source.includes('input.creativeType === "video" || input.videoId')) {
    throw new Error("Meta creative routing must not switch image assets into video path only because videoId exists");
  }
  if (source.includes('input.creativeType === "video" || input.videoUrl')) {
    throw new Error("Meta launch must not switch image assets into video path only because videoUrl exists");
  }
  if (!source.includes("META_VIDEO_LAUNCH_DISABLED_MESSAGE")) {
    throw new Error("Meta video real launch must return a controlled disabled message");
  }
  if (!source.includes("MetaApiError")) {
    throw new Error("Meta marketing source is missing detailed Meta API errors");
  }
  if (!source.includes("formatKazakhstanTimestamp")) {
    throw new Error("Meta marketing source is missing Kazakhstan launch timestamp helper");
  }
  if (!source.includes("resolveMetaTargetingForCity")) {
    throw new Error("Meta marketing source is missing city targeting resolver");
  }
  if (!source.includes("resolveMetaCityTarget")) {
    throw new Error("Meta marketing source is missing multi-city targeting resolver");
  }
  if (!source.includes("cityOptionMatchesCandidate")) {
    throw new Error("Meta marketing source is missing exact selected-city candidate matching");
  }
  if (!source.includes("readExactMetaCityFromSearch")) {
    throw new Error("Meta marketing source is missing exact Targeting Search candidate reader");
  }
  if (!citiesSource.includes("KZ_META_CITY_OPTIONS")) {
    throw new Error("Meta city options source is missing Kazakhstan city options");
  }
  if (!citiesSource.includes('id: "aktobe"') || !citiesSource.includes('id: "almaty"')) {
    throw new Error("Meta city options source must include Aktobe and Almaty");
  }
  if (!citiesSource.includes('metaKey: "1301648"')) {
    throw new Error("Meta city options source must keep Astana static city key 1301648");
  }
  if (!citiesSource.includes('metaKey: "1289458"')) {
    throw new Error("Meta city options source must keep Aktobe static city key 1289458");
  }
  if (!source.includes("metaCityTargetCache")) {
    throw new Error("Meta marketing source is missing city key cache");
  }
  if (!source.includes('type: "adgeolocation"') || !source.includes('location_types: ["city"]')) {
    throw new Error("Meta marketing source is missing Meta Targeting Search city fallback");
  }
  if (!source.includes("buildGeoLocations")) {
    throw new Error("Meta marketing source is missing geo location builder");
  }
  if (!source.includes("custom_locations")) {
    throw new Error("Meta marketing source must document custom_locations for future radius targeting");
  }
  if (source.includes("radius: 15") || source.includes('distance_unit: "kilometer"')) {
    throw new Error("Meta marketing source must not send radius/distance_unit for geo_locations.cities");
  }
  if (!source.includes('publisher_platforms: ["instagram"]')) {
    throw new Error("Meta marketing source must force Instagram-only publisher platforms");
  }
  if (!source.includes("instagram_positions: INSTAGRAM_POSITIONS")) {
    throw new Error("Meta marketing source must include Instagram positions in targeting");
  }
  if (!source.includes("INSTAGRAM_ACTOR_FALLBACK_WARNING")) {
    throw new Error("Meta marketing source is missing Instagram actor fallback warning");
  }
  if (!source.includes("shouldRetryWithoutInstagramActor")) {
    throw new Error("Meta marketing source is missing one-shot Instagram actor retry guard");
  }
  if (!source.includes("omitInstagramActor: true")) {
    throw new Error("Meta marketing source is missing creative retry without Instagram actor");
  }
  if (!source.includes('preparedInput.status === "PAUSED"')) {
    throw new Error("Meta marketing source must limit Instagram actor fallback to PAUSED launch");
  }
  if (!source.includes("instagram_actor_id: instagramActorId") && !source.includes("instagram_actor_id: input.instagramActorId")) {
    throw new Error("Meta marketing source is missing conditional instagram_actor_id payload");
  }
  if (!source.includes("creativeUsesInstagramActor")) {
    throw new Error("Meta marketing source is missing creativeUsesInstagramActor result flag");
  }
  if (!source.includes("is_adset_budget_sharing_enabled: false")) {
    throw new Error("Meta marketing source is missing campaign budget sharing opt-out");
  }
  if (!source.includes("daily_budget: String(dailyBudgetMinorUnits)")) {
    throw new Error("Meta marketing source is missing string ad set daily_budget");
  }
  if (!source.includes('optimization_goal: "LINK_CLICKS"')) {
    throw new Error("Meta marketing source must use LINK_CLICKS optimization for MVP ad sets");
  }
  if (!source.includes("targeting_automation:")) {
    throw new Error("Meta marketing source is missing targeting_automation inside targeting");
  }
  if (!source.includes("advantage_audience: 0")) {
    throw new Error("Meta marketing source is missing advantage_audience: 0");
  }
  if (!source.includes("Meta ad set payload missing daily_budget/lifetime_budget")) {
    throw new Error("Meta marketing source is missing ad set budget assertion");
  }
  if (!source.includes("serializeMetaFormPayload")) {
    throw new Error("Meta marketing source is missing explicit form serializer");
  }
  if (!source.includes("value !== undefined && value !== null")) {
    throw new Error("Meta marketing serializer must preserve false and numeric payload values");
  }
  if (!source.includes("typeof value === \"object\" ? JSON.stringify(value) : String(value)")) {
    throw new Error("Meta marketing serializer must JSON-serialize nested targeting");
  }
  if (source.includes(".filter(([, value]) => value)")) {
    throw new Error("Meta marketing serializer must not use truthy filtering");
  }
  if (!source.includes("META_VIDEO_THUMBNAIL_REQUIRED_MESSAGE")) {
    throw new Error("Meta marketing source must expose a controlled video thumbnail requirement message");
  }
  if (!source.includes("resolveVideoThumbnailUrl")) {
    throw new Error("Meta marketing source must normalize video thumbnail URLs before creative creation");
  }
  if (!source.includes("image_url: thumbnailUrl")) {
    throw new Error("Meta video creative must pass the generated thumbnail as video_data.image_url");
  }

  console.log("Meta marketing source checks: ok");
}

async function checkMetaCityResolverModule() {
  const moduleUrl = pathToFileURL(path.join(repoRoot, "lib", "meta", "marketing.ts")).href;
  const citiesModuleUrl = pathToFileURL(path.join(repoRoot, "lib", "meta", "cities.ts")).href;
  type SmokeMetaCityOption = {
    id: string;
    labelRu: string;
    labelEn: string;
    canonicalName: string;
    countryCode: "KZ";
    aliases: string[];
    metaKey?: string;
  };
  const marketing = (await import(moduleUrl)) as {
    resolveMetaCityTarget(city: string | SmokeMetaCityOption): Promise<{
      key: string | null;
      name?: string;
      source: string;
      warning?: string;
      selected?: { name?: string; key?: string } | null;
      candidates?: Array<{ name?: string; key?: string }>;
      rejectedCandidates?: Array<{ name?: string; key?: string; reason?: string }>;
    }>;
    resolveMetaTargetingForCity(city: string | SmokeMetaCityOption): Promise<{
      cityKey?: string;
      geoMode: string;
      fallbackCountry: boolean;
      source: string;
      warning?: string;
    }>;
    buildMetaAdSetPayload(input: Record<string, unknown>): Record<string, unknown>;
  };
  const cities = (await import(citiesModuleUrl)) as {
    getKzMetaCityOption(value: string): SmokeMetaCityOption;
    cityOptionMatchesCandidate(option: SmokeMetaCityOption, candidateName: string): boolean;
  };

  const originalEnv = {
    META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN,
    META_AD_ACCOUNT_ID: process.env.META_AD_ACCOUNT_ID,
    META_PAGE_ID: process.env.META_PAGE_ID,
    META_ASTANA_CITY_KEY: process.env.META_ASTANA_CITY_KEY,
  };
  const fetchBox = globalThis as unknown as {
    fetch: (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
      ok: boolean;
      status: number;
      text: () => Promise<string>;
    }>;
  };
  const originalFetch = fetchBox.fetch;

  try {
    delete process.env.META_ASTANA_CITY_KEY;
    process.env.META_ACCESS_TOKEN = "smoke_token";
    process.env.META_AD_ACCOUNT_ID = "act_smoke";
    process.env.META_PAGE_ID = "page_smoke";
    fetchBox.fetch = async (input) => {
      const url = new URL(String(input));
      const query = (url.searchParams.get("q") || "").toLowerCase();
      const data = query.includes("almaty")
        ? [{ key: "almaty_test_city_key", name: "Almaty", type: "city", country_code: "KZ", supports_city: true }]
        : query.includes("aktobe")
          ? [
              { key: "temir_wrong_key", name: "Temir, Aqtöbe, Kazakhstan", type: "city", country_code: "KZ", supports_city: true },
              { key: "aktobe_exact_key", name: "Aktobe", type: "city", country_code: "KZ", supports_city: true },
            ]
          : [];
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data }),
      };
    };

    const astana = await marketing.resolveMetaCityTarget("Астана");
    if (astana.key !== "1301648" || astana.source !== "static") {
      throw new Error("resolveMetaCityTarget must resolve Astana from static map with key 1301648");
    }

    const almaty = await marketing.resolveMetaCityTarget("Алматы");
    if (almaty.key !== "almaty_test_city_key" || almaty.source !== "targeting_search") {
      throw new Error("resolveMetaCityTarget must resolve Almaty through mocked Targeting Search");
    }

    const almatyCached = await marketing.resolveMetaCityTarget("Almaty");
    if (almatyCached.key !== "almaty_test_city_key" || almatyCached.source !== "cache") {
      throw new Error("resolveMetaCityTarget must cache Targeting Search city keys");
    }

    const aktobeOption = cities.getKzMetaCityOption("aktobe");
    const aktobe = await marketing.resolveMetaCityTarget(aktobeOption);
    if (aktobe.key !== "1289458" || aktobe.source !== "static") {
      throw new Error("resolveMetaCityTarget must resolve Aktobe from static map with key 1289458");
    }
    if (cities.cityOptionMatchesCandidate(aktobeOption, "Temir, Aqtöbe, Kazakhstan")) {
      throw new Error("cityOptionMatchesCandidate must reject Temir when selected city is Aktobe");
    }
    if (!cities.cityOptionMatchesCandidate(aktobeOption, "Aktobe, Kazakhstan")) {
      throw new Error("cityOptionMatchesCandidate must accept exact Aktobe primary city name");
    }

    const unknown = await marketing.resolveMetaTargetingForCity("Unknown City");
    if (unknown.geoMode !== "country" || !unknown.fallbackCountry || !unknown.warning) {
      throw new Error("unknown city must fall back to Kazakhstan country targeting with warning");
    }

    const astanaTargeting = await marketing.resolveMetaTargetingForCity("Astana");
    const cityAdSet = marketing.buildMetaAdSetPayload({
      campaignName: "Smoke",
      campaignId: "campaign_1",
      objective: "OUTCOME_LEADS",
      status: "PAUSED",
      dailyBudgetMinor: 2000,
      currency: "USD",
      primaryText: "Text",
      headline: "Headline",
      description: "Description",
      cta: "LEARN_MORE",
      landingUrl: "https://example.com",
      city: "Astana",
      targetingResolution: astanaTargeting,
    });
    const cityTargeting = cityAdSet.targeting as { geo_locations?: { cities?: Array<{ key?: string; radius?: unknown; distance_unit?: unknown }> } };
    if (cityTargeting.geo_locations?.cities?.[0]?.key !== "1301648") {
      throw new Error("city targeting must use geo_locations.cities with the resolved Meta city key");
    }
    if (
      Object.prototype.hasOwnProperty.call(cityTargeting.geo_locations?.cities?.[0] || {}, "radius") ||
      Object.prototype.hasOwnProperty.call(cityTargeting.geo_locations?.cities?.[0] || {}, "distance_unit")
    ) {
      throw new Error("city targeting must not send radius or distance_unit for geo_locations.cities");
    }

    const aktobeTargeting = await marketing.resolveMetaTargetingForCity(aktobeOption);
    const aktobeAdSet = marketing.buildMetaAdSetPayload({
      campaignName: "Smoke Aktobe",
      campaignId: "campaign_aktobe",
      objective: "OUTCOME_LEADS",
      status: "PAUSED",
      dailyBudgetMinor: 2000,
      currency: "USD",
      primaryText: "Text",
      headline: "Headline",
      description: "Description",
      cta: "LEARN_MORE",
      landingUrl: "https://example.com",
      city: "Aktobe",
      targetingResolution: aktobeTargeting,
    });
    const aktobePayloadTargeting = aktobeAdSet.targeting as { geo_locations?: { countries?: unknown; cities?: Array<{ key?: string; radius?: unknown; distance_unit?: unknown }> } };
    const aktobeCity = aktobePayloadTargeting.geo_locations?.cities?.[0] || {};
    if (aktobeCity.key !== "1289458") {
      throw new Error("Aktobe city targeting must use static city key 1289458");
    }
    if (Object.prototype.hasOwnProperty.call(aktobeCity, "radius") || Object.prototype.hasOwnProperty.call(aktobeCity, "distance_unit")) {
      throw new Error("Aktobe city targeting must not include radius or distance_unit");
    }
    if (Object.prototype.hasOwnProperty.call(aktobePayloadTargeting.geo_locations || {}, "countries")) {
      throw new Error("Aktobe city targeting must not fallback to countries when city key is found");
    }

    const fallbackAdSet = marketing.buildMetaAdSetPayload({
      campaignName: "Smoke",
      campaignId: "campaign_1",
      objective: "OUTCOME_LEADS",
      status: "PAUSED",
      dailyBudgetMinor: 2000,
      currency: "USD",
      primaryText: "Text",
      headline: "Headline",
      description: "Description",
      cta: "LEARN_MORE",
      landingUrl: "https://example.com",
      city: "Unknown City",
      targetingResolution: unknown,
    });
    const fallbackTargeting = fallbackAdSet.targeting as { geo_locations?: { countries?: string[]; cities?: unknown[] } };
    if (JSON.stringify(fallbackTargeting.geo_locations?.countries) !== JSON.stringify(["KZ"]) || fallbackTargeting.geo_locations?.cities) {
      throw new Error("fallback targeting must use geo_locations.countries [\"KZ\"]");
    }
  } finally {
    fetchBox.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  console.log("Meta city resolver module checks: ok");
}

async function checkMetaVideoModule() {
  const moduleUrl = pathToFileURL(path.join(repoRoot, "lib", "meta", "marketing.ts")).href;
  const marketing = (await import(moduleUrl)) as {
    uploadMetaVideoAndGetId(input: {
      videoUrl: string;
      fileName?: string;
      mimeType?: string;
      title?: string;
      processingPollAttempts?: number;
      processingPollDelayMs?: number;
    }): Promise<{ videoId: string; uploadMode: string; processingStatus?: string; warnings?: string[] }>;
    launchMetaCampaign(input: Record<string, unknown>): Promise<{ videoId?: string; videoUploadMode?: string; videoProcessingStatus?: string; metaCampaignId?: string; creativeUsesVideoData?: boolean; creativeUsesLinkData?: boolean }>;
    buildVideoCreativePayload(input: Record<string, unknown>): Record<string, unknown>;
    buildImageLinkCreativePayload(input: Record<string, unknown>): Record<string, unknown>;
    isSupportedMetaVideoFormat(input: { mimeType?: string; fileName?: string }): boolean;
  };

  const originalEnv = {
    META_VIDEO_LAUNCH_ENABLED: process.env.META_VIDEO_LAUNCH_ENABLED,
    META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN,
    META_AD_ACCOUNT_ID: process.env.META_AD_ACCOUNT_ID,
    META_PAGE_ID: process.env.META_PAGE_ID,
    META_INSTAGRAM_ACTOR_ID: process.env.META_INSTAGRAM_ACTOR_ID,
  };
  const fetchBox = globalThis as unknown as {
    fetch: (
      input: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string | Buffer },
    ) => Promise<{
      ok: boolean;
      status: number;
      text: () => Promise<string>;
      headers?: { get(name: string): string | null };
      arrayBuffer?: () => Promise<ArrayBuffer>;
    }>;
  };
  const originalFetch = fetchBox.fetch;
  const calls: Array<{ url: string; method: string; body: string }> = [];

  const jsonResponse = (data: unknown) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(data),
  });

  try {
    process.env.META_VIDEO_LAUNCH_ENABLED = "false";
    fetchBox.fetch = async () => {
      throw new Error("Meta API must not be called while video launch flag is disabled");
    };
    for (const file of [
      { fileName: "disabled.mp4", mimeType: "video/mp4", videoUrl: "https://example.com/disabled.mp4" },
      { fileName: "disabled.mov", mimeType: "video/quicktime", videoUrl: "https://example.com/disabled.mov" },
    ]) {
      let blocked = false;
      try {
        await marketing.launchMetaCampaign({
          campaignName: "Disabled Video Launch",
          objective: "OUTCOME_LEADS",
          status: "PAUSED",
          dailyBudgetMinor: 2000,
          currency: "USD",
          primaryText: "Text",
          headline: "Headline",
          description: "Description",
          cta: "LEARN_MORE",
          landingUrl: "https://example.com",
          creativeType: "video",
          ...file,
        });
      } catch (error) {
        blocked = error instanceof Error && error.message.includes("подготовке");
      }
      if (!blocked) {
        throw new Error("MP4/MOV real launch must be blocked while META_VIDEO_LAUNCH_ENABLED=false");
      }
    }

    process.env.META_VIDEO_LAUNCH_ENABLED = "true";
    process.env.META_ACCESS_TOKEN = "smoke_token";
    process.env.META_AD_ACCOUNT_ID = "act_smoke";
    process.env.META_PAGE_ID = "page_smoke";
    delete process.env.META_INSTAGRAM_ACTOR_ID;

    fetchBox.fetch = async (input, init = {}) => {
      const url = String(input);
      const method = init.method || "GET";
      const body = typeof init.body === "string" ? init.body : Buffer.isBuffer(init.body) ? init.body.toString("utf8") : "";
      calls.push({ url, method, body });

      if (url.includes("/advideos") && method === "POST") {
        const params = new URLSearchParams(body);
        const fileUrl = params.get("file_url") || "";
        if (fileUrl.includes("pending")) return jsonResponse({ id: "video_pending" });
        if (fileUrl.includes("mov")) return jsonResponse({ id: "video_mov" });
        return jsonResponse({ id: "video_launch" });
      }
      if (url.includes("/video_pending")) {
        if (url.includes("processing_progress")) {
          throw new Error("video polling must not request top-level processing_progress field");
        }
        return jsonResponse({ status: { video_status: "processing", processing_progress: 25 } });
      }
      if (url.includes("/video_mov")) {
        return jsonResponse({ status: { video_status: "ready", processing_progress: 100 } });
      }
      if (url.includes("/video_launch")) {
        return jsonResponse({ status: { video_status: "ready" } });
      }
      if (url.includes("/campaigns") && method === "POST") return jsonResponse({ id: "campaign_smoke" });
      if (url.includes("/adsets") && method === "POST") {
        const params = new URLSearchParams(body);
        const targeting = JSON.parse(params.get("targeting") || "{}") as { publisher_platforms?: string[]; instagram_positions?: string[] };
        if (JSON.stringify(targeting.publisher_platforms || []) !== JSON.stringify(["instagram"])) {
          throw new Error("video launch adset must preserve Instagram-only publisher platforms");
        }
        if (!["stream", "story", "explore", "reels"].every((position) => (targeting.instagram_positions || []).includes(position))) {
          throw new Error("video launch adset must preserve Instagram positions");
        }
        return jsonResponse({ id: "adset_smoke" });
      }
      if (url.includes("/adcreatives") && method === "POST") {
        const params = new URLSearchParams(body);
        const spec = JSON.parse(params.get("object_story_spec") || "{}") as {
          video_data?: { video_id?: string; image_url?: string };
          link_data?: unknown;
        };
        if (spec.video_data?.video_id !== "video_launch") {
          throw new Error("video launch creative must use object_story_spec.video_data.video_id");
        }
        if (spec.link_data) {
          throw new Error("video launch creative must not use link_data");
        }
        if (spec.video_data?.image_url !== "https://example.com/smoke-thumb.jpg") {
          throw new Error("video launch creative must pass the generated thumbnail as video_data.image_url");
        }
        if ((spec.video_data?.image_url || "").endsWith(".mp4")) {
          throw new Error("video launch creative must never use the video public URL as image_url");
        }
        return jsonResponse({ id: "creative_smoke" });
      }
      if (url.includes("/ads") && method === "POST") return jsonResponse({ id: "ad_smoke" });

      return jsonResponse({});
    };

    if (!marketing.isSupportedMetaVideoFormat({ fileName: "smoke.mp4", mimeType: "video/mp4" })) {
      throw new Error("MP4 must be supported for Meta video launch");
    }
    if (!marketing.isSupportedMetaVideoFormat({ fileName: "smoke.mov", mimeType: "video/quicktime" })) {
      throw new Error("MOV must be supported for Meta video launch");
    }
    if (marketing.isSupportedMetaVideoFormat({ fileName: "smoke.webm", mimeType: "video/webm" })) {
      throw new Error("WEBM must not be supported for real Meta video launch");
    }

    const movUpload = await marketing.uploadMetaVideoAndGetId({
      videoUrl: "https://example.com/smoke.mov",
      fileName: "smoke.mov",
      mimeType: "video/quicktime",
      title: "MOV Smoke",
      processingPollAttempts: 1,
      processingPollDelayMs: 0,
    });
    if (movUpload.videoId !== "video_mov" || movUpload.uploadMode !== "file_url" || !movUpload.warnings?.some((item) => item.includes("MOV"))) {
      throw new Error("MOV upload must return video_id, file_url mode, and a warning");
    }

    let processingTimeout = false;
    let pendingDetails: { pending?: boolean; debug?: { videoId?: string; status?: string } } | undefined;
    try {
      await marketing.uploadMetaVideoAndGetId({
        videoUrl: "https://example.com/pending.mp4",
        fileName: "pending.mp4",
        mimeType: "video/mp4",
        title: "Pending Smoke",
        processingPollAttempts: 1,
        processingPollDelayMs: 0,
      });
    } catch (error) {
      processingTimeout = error instanceof Error && error.message.includes("обрабатывается");
      pendingDetails = (error as { details?: { pending?: boolean; debug?: { videoId?: string; status?: string } } }).details;
    }
    if (!processingTimeout) {
      throw new Error("video processing timeout must return a controlled retry message");
    }
    if (pendingDetails?.pending !== true) {
      throw new Error("video processing timeout must be marked pending, not a real failure");
    }
    if (pendingDetails?.debug?.videoId !== "video_pending") {
      throw new Error("video processing timeout must preserve the received Meta video_id in debug");
    }

    const videoCreative = marketing.buildVideoCreativePayload({
      campaignName: "Smoke",
      creativeName: "Smoke Video Creative",
      pageId: "page_smoke",
      videoId: "video_123",
      headline: "Headline",
      primaryText: "Text",
      description: "Description",
      cta: "LEARN_MORE",
      landingUrl: "https://example.com",
    });
    const videoSpec = videoCreative.object_story_spec as { video_data?: { video_id?: string; image_url?: string }; link_data?: unknown };
    if (videoSpec.video_data?.video_id !== "video_123" || videoSpec.link_data) {
      throw new Error("video creative payload must use video_data.video_id and must not use link_data");
    }
    if (Object.prototype.hasOwnProperty.call(videoSpec.video_data || {}, "image_url")) {
      throw new Error("video creative payload without thumbnail must not invent image_url");
    }

    const videoCreativeWithThumb = marketing.buildVideoCreativePayload({
      campaignName: "Smoke",
      creativeName: "Smoke Video Creative",
      pageId: "page_smoke",
      videoId: "video_123",
      headline: "Headline",
      primaryText: "Text",
      description: "Description",
      cta: "LEARN_MORE",
      landingUrl: "https://example.com",
      videoUrl: "https://example.com/video.mp4",
      thumbnailUrl: "https://example.com/thumb.jpg",
    });
    const thumbSpec = videoCreativeWithThumb.object_story_spec as { video_data?: { image_url?: string } };
    if (thumbSpec.video_data?.image_url !== "https://example.com/thumb.jpg") {
      throw new Error("video creative payload must pass thumbnailUrl as video_data.image_url");
    }

    const videoCreativeVideoAsThumb = marketing.buildVideoCreativePayload({
      campaignName: "Smoke",
      creativeName: "Smoke Video Creative",
      pageId: "page_smoke",
      videoId: "video_123",
      headline: "Headline",
      primaryText: "Text",
      description: "Description",
      cta: "LEARN_MORE",
      landingUrl: "https://example.com",
      videoUrl: "https://example.com/video.mp4",
      thumbnailUrl: "https://example.com/video.mp4",
    });
    const videoAsThumbSpec = videoCreativeVideoAsThumb.object_story_spec as { video_data?: { image_url?: string } };
    if (Object.prototype.hasOwnProperty.call(videoAsThumbSpec.video_data || {}, "image_url")) {
      throw new Error("video creative payload must never use the video public URL as image_url");
    }

    const imageCreative = marketing.buildImageLinkCreativePayload({
      campaignName: "Smoke",
      creativeName: "Smoke Image Creative",
      pageId: "page_smoke",
      imageHash: "image_hash_123",
      headline: "Headline",
      primaryText: "Text",
      description: "Description",
      cta: "LEARN_MORE",
      landingUrl: "https://example.com",
    });
    const imageSpec = imageCreative.object_story_spec as { link_data?: { image_hash?: string }; video_data?: unknown };
    if (imageSpec.link_data?.image_hash !== "image_hash_123" || imageSpec.video_data) {
      throw new Error("image creative payload must still use link_data.image_hash and must not use video_data");
    }

    const launch = await marketing.launchMetaCampaign({
      campaignName: "Smoke Video Launch",
      objective: "OUTCOME_LEADS",
      status: "PAUSED",
      dailyBudgetMinor: 2000,
      currency: "USD",
      primaryText: "Text",
      headline: "Headline",
      description: "Description",
      cta: "LEARN_MORE",
      landingUrl: "https://example.com",
      creativeType: "video",
      videoUrl: "https://example.com/smoke.mp4",
      thumbnailUrl: "https://example.com/smoke-thumb.jpg",
      fileName: "smoke.mp4",
      mimeType: "video/mp4",
      city: "Astana",
    });
    if (launch.videoId !== "video_launch" || launch.videoUploadMode !== "file_url" || launch.videoProcessingStatus !== "ready") {
      throw new Error("real video launch must upload video and expose video_id/upload mode/processing status");
    }
    if (launch.metaCampaignId !== "campaign_smoke" || launch.creativeUsesVideoData !== true || launch.creativeUsesLinkData !== false) {
      throw new Error("real video launch must continue through PAUSED campaign/adset/creative/ad creation");
    }
    if (!calls.some((call) => call.url.includes("/advideos")) || !calls.some((call) => call.url.includes("/adcreatives"))) {
      throw new Error("real video launch must call advideos and adcreatives");
    }

    // Missing thumbnail must block before the Meta creative call with a controlled message.
    calls.length = 0;
    let thumbnailBlocked = false;
    try {
      await marketing.launchMetaCampaign({
        campaignName: "Smoke Video Launch No Thumb",
        objective: "OUTCOME_LEADS",
        status: "PAUSED",
        dailyBudgetMinor: 2000,
        currency: "USD",
        primaryText: "Text",
        headline: "Headline",
        description: "Description",
        cta: "LEARN_MORE",
        landingUrl: "https://example.com",
        creativeType: "video",
        videoUrl: "https://example.com/smoke.mp4",
        fileName: "smoke.mp4",
        mimeType: "video/mp4",
        city: "Astana",
      });
    } catch (error) {
      thumbnailBlocked = error instanceof Error && error.message.includes("обложка");
    }
    if (!thumbnailBlocked) {
      throw new Error("video launch without thumbnail must fail with the controlled thumbnail message");
    }
    if (calls.some((call) => call.url.includes("/adcreatives"))) {
      throw new Error("missing thumbnail must block before the Meta creative call");
    }
  } finally {
    fetchBox.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  console.log("Meta video module checks: ok");
}

async function checkCrmLaunchStateModule() {
  const crmModuleUrl = pathToFileURL(path.join(repoRoot, "lib", "crm", "server.ts")).href;
  const crm = (await import(crmModuleUrl)) as {
    handleMetaLaunch(req: unknown, res: unknown): Promise<unknown>;
    handleAdCreativeMetaUpload(req: unknown, res: unknown): Promise<unknown>;
  };

  const originalEnv = {
    META_VIDEO_LAUNCH_ENABLED: process.env.META_VIDEO_LAUNCH_ENABLED,
    META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN,
    META_AD_ACCOUNT_ID: process.env.META_AD_ACCOUNT_ID,
    META_PAGE_ID: process.env.META_PAGE_ID,
    META_INSTAGRAM_ACTOR_ID: process.env.META_INSTAGRAM_ACTOR_ID,
    META_VIDEO_PROCESSING_POLL_ATTEMPTS: process.env.META_VIDEO_PROCESSING_POLL_ATTEMPTS,
    META_VIDEO_PROCESSING_POLL_DELAY_MS: process.env.META_VIDEO_PROCESSING_POLL_DELAY_MS,
  };
  const fetchBox = globalThis as unknown as {
    fetch: (
      input: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string | Buffer },
    ) => Promise<{
      ok: boolean;
      status: number;
      text: () => Promise<string>;
      headers?: { get(name: string): string | null };
      arrayBuffer?: () => Promise<ArrayBuffer>;
    }>;
  };
  const originalFetch = fetchBox.fetch;
  const calls: Array<{ url: string; method: string }> = [];

  const jsonResponse = (data: unknown) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(data),
  });

  const makeRes = () => {
    const box: { statusCode: number; body: Record<string, unknown> } = { statusCode: 0, body: {} };
    const res = {
      status(code: number) {
        box.statusCode = code;
        return res;
      },
      setHeader() {
        return res;
      },
      json(payload: unknown) {
        box.body = (payload || {}) as Record<string, unknown>;
        return res;
      },
      end() {
        return res;
      },
    };
    return { res, box };
  };

  const baseLaunchBody = {
    workspaceId: "demo-workspace",
    campaignName: "Smoke CRM Video Launch",
    objective: "OUTCOME_LEADS",
    statusMode: "PAUSED",
    dailyBudget: 20,
    totalBudget: 140,
    currency: "USD",
    city: "Astana",
    targetAudience: "Women 25-55",
    primaryText: "Professional consultation in Astana. Book a specialist consultation.",
    headline: "Consultation in Astana",
    description: "Book a consultation with a specialist.",
    cta: "LEARN_MORE",
    landingUrl: "https://example.com",
    creativeType: "video",
    creativeUrl: "https://example.com/crm-pending.mp4",
    videoUrl: "https://example.com/crm-pending.mp4",
    thumbnailUrl: "https://example.com/crm-thumb.jpg",
    fileName: "crm-pending.mp4",
    mimeType: "video/mp4",
    complianceConfirmed: true,
    manualApprovalConfirmed: true,
    dryRun: false,
  };

  try {
    process.env.META_VIDEO_LAUNCH_ENABLED = "true";
    process.env.META_ACCESS_TOKEN = "smoke_token";
    process.env.META_AD_ACCOUNT_ID = "act_smoke";
    process.env.META_PAGE_ID = "page_smoke";
    delete process.env.META_INSTAGRAM_ACTOR_ID;
    process.env.META_VIDEO_PROCESSING_POLL_ATTEMPTS = "1";
    process.env.META_VIDEO_PROCESSING_POLL_DELAY_MS = "0";

    fetchBox.fetch = async (input, init = {}) => {
      const url = String(input);
      const method = init.method || "GET";
      calls.push({ url, method });
      if (url.includes("/advideos") && method === "POST") return jsonResponse({ id: "video_pending_crm" });
      if (url.includes("/video_pending_crm")) return jsonResponse({ status: { video_status: "processing", processing_progress: 40 } });
      if (url.includes("/video_ready_crm")) return jsonResponse({ status: { video_status: "ready" } });
      return jsonResponse({});
    };

    // Real video launch without a thumbnail must be blocked by validation before any Meta call.
    const missingThumb = makeRes();
    await crm.handleMetaLaunch({ method: "POST", body: { ...baseLaunchBody, thumbnailUrl: "" }, query: {}, headers: {} }, missingThumb.res);
    const missingThumbBody = missingThumb.box.body as { success?: boolean; details?: string[] };
    if (missingThumb.box.statusCode !== 400 || missingThumbBody.success !== false || !(missingThumbBody.details || []).some((item) => item.includes("обложка"))) {
      throw new Error("real video launch without thumbnail must be blocked with the controlled thumbnail message");
    }
    if (calls.length > 0) {
      throw new Error("missing thumbnail must block before any Meta API call");
    }

    // The video public URL must never be accepted as the thumbnail.
    const videoAsThumb = makeRes();
    await crm.handleMetaLaunch(
      { method: "POST", body: { ...baseLaunchBody, thumbnailUrl: baseLaunchBody.videoUrl }, query: {}, headers: {} },
      videoAsThumb.res,
    );
    const videoAsThumbBody = videoAsThumb.box.body as { success?: boolean; details?: string[] };
    if (videoAsThumb.box.statusCode !== 400 || videoAsThumbBody.success !== false || !(videoAsThumbBody.details || []).some((item) => item.includes("обложка"))) {
      throw new Error("video public URL must not be accepted as video thumbnail");
    }
    if (calls.length > 0) {
      throw new Error("video-as-thumbnail must block before any Meta API call");
    }

    // Real video launch with pending Meta processing must become video_processing, not PAUSED and not failed.
    const pendingLaunch = makeRes();
    await crm.handleMetaLaunch({ method: "POST", body: { ...baseLaunchBody }, query: {}, headers: {} }, pendingLaunch.res);
    const pendingBody = pendingLaunch.box.body as {
      success?: boolean;
      data?: { status?: string; metaVideoId?: string; launch?: { status?: string; metaVideoId?: string; lastError?: string } };
    };
    if (pendingLaunch.box.statusCode !== 202 || pendingBody.success !== true) {
      throw new Error("meta-launch with pending video processing must return 202 success, not a failure");
    }
    if (pendingBody.data?.status !== "video_processing" || pendingBody.data?.metaVideoId !== "video_pending_crm") {
      throw new Error("meta-launch pending video must report status video_processing with the Meta video_id");
    }
    if (pendingBody.data?.launch?.status !== "video_processing" || pendingBody.data?.launch?.metaVideoId !== "video_pending_crm") {
      throw new Error("meta-launch pending video history record must keep status video_processing and the video_id");
    }
    if (pendingBody.data?.launch?.lastError) {
      throw new Error("meta-launch pending video must not be recorded as failed");
    }
    if (calls.some((call) => call.url.includes("/campaigns"))) {
      throw new Error("meta-launch must not create a campaign while the video is still processing");
    }

    // A stored video_id must be reused: status re-check only, no second /advideos upload.
    calls.length = 0;
    const reuse = makeRes();
    await crm.handleAdCreativeMetaUpload(
      {
        method: "POST",
        body: { workspaceId: "demo-workspace", fileType: "video", fileName: "crm-pending.mp4", mimeType: "video/mp4", metaVideoId: "video_ready_crm" },
        query: {},
        headers: {},
      },
      reuse.res,
    );
    const reuseBody = reuse.box.body as {
      success?: boolean;
      data?: { metaVideoId?: string; reused?: boolean; videoReady?: boolean; lastCheckedAt?: string };
    };
    if (
      reuse.box.statusCode !== 200 ||
      reuseBody.success !== true ||
      reuseBody.data?.metaVideoId !== "video_ready_crm" ||
      reuseBody.data?.reused !== true ||
      reuseBody.data?.videoReady !== true
    ) {
      throw new Error("ad-creative-meta-upload must reuse an existing Meta video_id and report readiness");
    }
    if (!reuseBody.data?.lastCheckedAt) {
      throw new Error("ad-creative-meta-upload recheck must report lastCheckedAt");
    }
    if (calls.some((call) => call.url.includes("/advideos"))) {
      throw new Error("ad-creative-meta-upload must not upload the video again when video_id is already known");
    }

    // Rechecking a still-processing video stays video_processing and is not an error.
    calls.length = 0;
    const stillProcessing = makeRes();
    await crm.handleAdCreativeMetaUpload(
      {
        method: "POST",
        body: { workspaceId: "demo-workspace", fileType: "video", fileName: "crm-pending.mp4", mimeType: "video/mp4", metaVideoId: "video_pending_crm" },
        query: {},
        headers: {},
      },
      stillProcessing.res,
    );
    const stillBody = stillProcessing.box.body as {
      success?: boolean;
      data?: { status?: string; videoReady?: boolean; metaVideoId?: string };
    };
    if (
      stillProcessing.box.statusCode !== 202 ||
      stillBody.success !== true ||
      stillBody.data?.status !== "video_processing" ||
      stillBody.data?.videoReady !== false ||
      stillBody.data?.metaVideoId !== "video_pending_crm"
    ) {
      throw new Error("ad-creative-meta-upload recheck of a processing video must stay video_processing without failing");
    }

    // ACTIVE launch must remain gated.
    const gated = makeRes();
    await crm.handleMetaLaunch(
      {
        method: "POST",
        body: {
          ...baseLaunchBody,
          creativeType: "image",
          imageUrl: "https://example.com/smoke.jpg",
          creativeUrl: "https://example.com/smoke.jpg",
          videoUrl: "",
          fileName: "smoke.jpg",
          mimeType: "image/jpeg",
          statusMode: "ACTIVE",
        },
        query: {},
        headers: {},
      },
      gated.res,
    );
    const gatedBody = gated.box.body as { success?: boolean; details?: string[] };
    if (gated.box.statusCode < 400 || gatedBody.success !== false || !(gatedBody.details || []).some((item) => item.includes("ACTIVE"))) {
      throw new Error("ACTIVE launch must remain gated without Admin Center live launch approval");
    }
  } finally {
    fetchBox.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  console.log("CRM launch state module checks: ok");
}

async function checkHtmlRoute(path: string) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }

  if (!text.includes('<div id="root">')) {
    throw new Error(`${path} did not return the Negis app shell`);
  }

  console.log(`${path}: ok`);
}

async function checkTargetingHealth() {
  const response = await fetch(`${baseUrl}/api/targeting/health`);
  const text = await response.text();
  let body: ApiBody;

  try {
    body = JSON.parse(text) as ApiBody;
  } catch {
    throw new Error(`/api/targeting/health returned invalid JSON: ${text.slice(0, 120)}`);
  }

  if (!response.ok || body.success !== true) {
    const details = body.details?.join(", ");
    throw new Error(
      `/api/targeting/health failed: ${body.error || `HTTP ${response.status}`}${details ? ` (${details})` : ""}`,
    );
  }

  console.log(`/api/targeting/health: ok (${body.mode || "unknown"})`);
}

async function checkJsonEndpoint(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body: ApiBody;

  try {
    body = JSON.parse(text) as ApiBody;
  } catch {
    throw new Error(`${path} returned invalid JSON: ${text.slice(0, 120)}`);
  }

  if (!response.ok || body.success !== true) {
    const details = body.details?.join(", ");
    throw new Error(`${path} failed: ${body.error || `HTTP ${response.status}`}${details ? ` (${details})` : ""}`);
  }

  console.log(`${path}: ok (${body.mode || "unknown"})`);
  return body;
}

async function checkJsonFailure(path: string, init: RequestInit, expectedText?: string) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body: ApiBody;

  try {
    body = JSON.parse(text) as ApiBody;
  } catch {
    throw new Error(`${path} returned invalid JSON for failure check: ${text.slice(0, 120)}`);
  }

  if (response.ok && body.success !== false) {
    throw new Error(`${path} unexpectedly succeeded`);
  }

  const combined = [body.error, ...(body.details || [])].filter(Boolean).join(" ");
  if (expectedText && !combined.includes(expectedText)) {
    throw new Error(`${path} failed with unexpected message: ${combined}`);
  }

  console.log(`${path}: expected failure ok`);
  return body;
}

async function checkCrmEndpoint(path: string, payload: Record<string, unknown>) {
  await checkJsonEndpoint(`${path}?workspaceId=demo-workspace`);
  await checkJsonEndpoint(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      ...payload,
    }),
  });
}

async function main() {
  console.log(`Smoke testing Negis routes at ${baseUrl}`);
  await checkAdsAutomationSource();
  await checkMetaMarketingSource();
  await checkMetaCityResolverModule();
  await checkMetaVideoModule();
  await checkCrmLaunchStateModule();
  for (const route of [
    "/dashboard",
    "/clients",
    "/appointments",
    "/booking",
    "/reception",
    "/leads",
    "/calls",
    "/tasks",
    "/chat",
    "/market",
    "/reports",
    "/admin",
    "/ads",
    "/ads-automation",
    "/ads-automation/history",
    "/targeting-agent",
    "/content-studio",
    "/privacy",
    "/terms",
    "/data-deletion",
    "/login",
  ]) {
    await checkHtmlRoute(route);
  }
  await checkTargetingHealth();
  await checkJsonEndpoint("/api/crm/health");
  await checkJsonEndpoint("/api/crm/storage-health");
  await checkCrmEndpoint("/api/crm/clients", {
    name: "Smoke Client",
    phone: "+7 700 000 00 00",
    source: "smoke",
  });
  await checkCrmEndpoint("/api/crm/leads", {
    name: "Smoke Lead",
    phone: "+7 700 111 22 33",
    source: "smoke",
  });
  await checkCrmEndpoint("/api/crm/appointments", {
    client: "Smoke Client",
    phone: "+7 700 222 33 44",
    whatsapp: "+7 700 222 33 44",
    service: "Consultation",
    doctor: "Smoke Doctor",
    starts_at: new Date().toISOString(),
    durationMinutes: 60,
    status: "scheduled",
    source: "smoke",
  });
  await checkCrmEndpoint("/api/crm/tasks", {
    title: "Smoke task",
    status: "new",
  });
  await checkCrmEndpoint("/api/crm/chat", {
    dialog: "Smoke",
    author: "Smoke",
    text: "Smoke message",
  });
  await checkCrmEndpoint("/api/crm/staff", {
    name: "Smoke Staff",
    email: "smoke@example.com",
    role: "receptionist",
  });
  await checkCrmEndpoint("/api/crm/content-videos", {
    title: "Smoke content video",
    niche: "medical marketing",
  });
  await checkCrmEndpoint("/api/crm/admin-settings", {
    key: "clinic",
    value: {
      clinicName: "Smoke Clinic",
      city: "Astana",
    },
  });
  await checkCrmEndpoint("/api/crm/integration-statuses", {
    provider: "smoke",
    status: "configured",
  });
  await checkCrmEndpoint("/api/crm/ai-providers", {
    provider: "openai",
    purpose: "smoke",
    enabled: false,
    modelName: "smoke-model",
  });
  await checkCrmEndpoint("/api/crm/meta-accounts", {
    accountName: "Smoke Meta Account",
    status: "draft",
  });
  await checkCrmEndpoint("/api/crm/meta-launches", {
    campaignName: "Smoke Meta Launch",
    status: "draft",
  });
  await checkCrmEndpoint("/api/crm/ad-creatives", {
    fileName: "smoke-creative.jpg",
    fileType: "image",
    mimeType: "image/jpeg",
    fileSize: 2048,
    publicUrl: "https://example.com/smoke-creative.jpg",
    status: "uploaded",
  });
  const metadataSave = await checkJsonEndpoint("/api/crm/ad-creatives", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      fileName: "smoke-direct-upload.jpg",
      fileType: "image",
      mimeType: "image/jpeg",
      fileSize: 6_700_000,
      storageBucket: "ad-creatives",
      storagePath: "demo-workspace/smoke-direct-upload.jpg",
      publicUrl: "https://example.com/smoke-direct-upload.jpg",
      status: "uploaded",
      metadata: {
        source: "ads-automation",
        uploadMode: "signed_url",
        signedUpload: true,
      },
    }),
  });
  const metadataAsset = (metadataSave.data || {}) as { publicUrl?: string; item?: { publicUrl?: string; storagePath?: string } };
  if (!metadataAsset.publicUrl && !metadataAsset.item?.publicUrl) {
    throw new Error("/api/crm/ad-creatives did not return publicUrl for metadata save");
  }
  if (!metadataAsset.item?.storagePath) {
    throw new Error("/api/crm/ad-creatives did not keep storagePath for metadata save");
  }
  await checkJsonFailure(
    "/api/crm/ad-creatives/signed-upload",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        fileName: "smoke-bad.gif",
        fileType: "image",
        mimeType: "image/gif",
        fileSize: 2048,
      }),
    },
    "Формат",
  );
  await checkJsonFailure(
    "/api/crm/ad-creatives/signed-upload",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        fileName: "smoke-too-large.jpg",
        fileType: "image",
        mimeType: "image/jpeg",
        fileSize: 10 * 1024 * 1024 + 1,
      }),
    },
    "10 MB",
  );
  await checkJsonFailure(
    "/api/crm/ad-creatives/signed-upload",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        fileName: "smoke-too-large.mp4",
        fileType: "video",
        mimeType: "video/mp4",
        fileSize: 100 * 1024 * 1024 + 1,
      }),
    },
    "100 MB",
  );
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const signedUpload = await checkJsonEndpoint("/api/crm/ad-creatives/signed-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        fileName: "smoke-signed-upload.jpg",
        fileType: "image",
        mimeType: "image/jpeg",
        fileSize: 2048,
      }),
    });
    const signedData = (signedUpload.data || {}) as { storagePath?: string; publicUrl?: string; token?: string };
    if (!signedData.storagePath || !signedData.publicUrl || !signedData.token) {
      throw new Error("/api/crm/ad-creatives/signed-upload did not return storagePath/publicUrl/token");
    }
  } else {
    await checkJsonFailure(
      "/api/crm/ad-creatives/signed-upload",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "demo-workspace",
          fileName: "smoke-signed-upload.jpg",
          fileType: "image",
          mimeType: "image/jpeg",
          fileSize: 2048,
        }),
      },
      "SUPABASE_URL",
    );
  }
  const upload = await checkJsonEndpoint("/api/crm/ad-creative-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      fileName: "smoke-upload.jpg",
      fileType: "image",
      mimeType: "image/jpeg",
      fileSize: 2048,
      publicUrl: "https://example.com/smoke-upload.jpg",
      status: "uploaded",
    }),
  });
  const uploadedAsset = (upload.data || {}) as { publicUrl?: string; asset?: { publicUrl?: string } };
  if (!uploadedAsset.publicUrl && !uploadedAsset.asset?.publicUrl) {
    throw new Error("/api/crm/ad-creative-upload did not return publicUrl");
  }
  const snakeUpload = await checkJsonEndpoint("/api/crm/ad-creative-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      file_name: "smoke-upload-snake.jpg",
      file_type: "image",
      mime_type: "image/jpeg",
      file_size: 2048,
      storage_bucket: "ad-creatives",
      storage_path: "demo-workspace/ads/smoke-upload-snake.jpg",
      public_url: "https://example.com/smoke-upload-snake.jpg",
      status: "uploaded",
    }),
  });
  const snakeUploadedAsset = (snakeUpload.data || {}) as { publicUrl?: string; asset?: { publicUrl?: string } };
  if (!snakeUploadedAsset.publicUrl && !snakeUploadedAsset.asset?.publicUrl) {
    throw new Error("/api/crm/ad-creative-upload did not normalize public_url to publicUrl");
  }
  const urlUpload = await checkJsonEndpoint("/api/crm/ad-creative-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      fileName: "smoke-upload-url.jpg",
      fileType: "image",
      mimeType: "image/jpeg",
      fileSize: 2048,
      storageBucket: "ad-creatives",
      storagePath: "demo-workspace/ads/smoke-upload-url.jpg",
      url: "https://example.com/smoke-upload-url.jpg",
      status: "uploaded",
    }),
  });
  const urlUploadedAsset = (urlUpload.data || {}) as { publicUrl?: string; asset?: { publicUrl?: string } };
  if (!urlUploadedAsset.publicUrl && !urlUploadedAsset.asset?.publicUrl) {
    throw new Error("/api/crm/ad-creative-upload did not normalize url to publicUrl");
  }
  const publicURLUpload = await checkJsonEndpoint("/api/crm/ad-creative-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      fileName: "smoke-upload-public-url.jpg",
      fileType: "image",
      mimeType: "image/jpeg",
      fileSize: 2048,
      storageBucket: "ad-creatives",
      storagePath: "demo-workspace/ads/smoke-upload-public-url.jpg",
      publicURL: "https://example.com/smoke-upload-public-url.jpg",
      status: "uploaded",
    }),
  });
  const publicURLUploadedAsset = (publicURLUpload.data || {}) as { publicUrl?: string; asset?: { publicUrl?: string } };
  if (!publicURLUploadedAsset.publicUrl && !publicURLUploadedAsset.asset?.publicUrl) {
    throw new Error("/api/crm/ad-creative-upload did not normalize publicURL to publicUrl");
  }
  if (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL) {
    const derivedUpload = await checkJsonEndpoint("/api/crm/ad-creative-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        fileName: "smoke-upload-derived.jpg",
        fileType: "image",
        mimeType: "image/jpeg",
        fileSize: 2048,
        storageBucket: "ad-creatives",
        storagePath: "demo-workspace/ads/smoke-upload-derived.jpg",
        status: "uploaded",
      }),
    });
    const derivedUploadedAsset = (derivedUpload.data || {}) as { publicUrl?: string; asset?: { publicUrl?: string } };
    if (!derivedUploadedAsset.publicUrl && !derivedUploadedAsset.asset?.publicUrl) {
      throw new Error("/api/crm/ad-creative-upload did not derive publicUrl from storagePath");
    }
  }
  await checkJsonFailure(
    "/api/crm/ad-creative-upload",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        fileName: "smoke-upload-missing-url.jpg",
        fileType: "image",
        mimeType: "image/jpeg",
        fileSize: 2048,
        status: "demo",
      }),
    },
    "публичную ссылку",
  );
  await checkJsonEndpoint("/api/crm/ad-creative-meta-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      fileName: "smoke-video.mp4",
      fileType: "video",
      mimeType: "video/mp4",
      publicUrl: "https://example.com/smoke-video.mp4",
      dryRun: true,
    }),
  });
  const blockedVideoMetaUpload = await checkJsonFailure(
    "/api/crm/ad-creative-meta-upload",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        fileName: "smoke-video.mov",
        fileType: "video",
        mimeType: "video/quicktime",
        publicUrl: "https://example.com/smoke-video.mov",
        dryRun: false,
      }),
    },
    "автозапуск видео-рекламы",
  );
  if (((blockedVideoMetaUpload.data || {}) as { metaApiCalled?: unknown }).metaApiCalled !== false) {
    throw new Error("/api/crm/ad-creative-meta-upload must not call Meta API while video launch flag is disabled");
  }
  await checkJsonEndpoint("/api/crm/ads-ai-fill", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      creativeType: "image",
      creativeUrl: "https://example.com/smoke-creative.jpg",
      service: "Consultation",
      city: "Astana",
      leadDestination: "whatsapp",
      destinationValue: "+77000000000",
      dailyBudget: 20,
      offer: "Consultation",
      knownAudience: "Women 25-55",
      restrictions: "Safe medical wording",
    }),
  });
  await checkJsonEndpoint("/api/crm/meta-validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      dryRun: true,
    }),
  });
  const cityKeyCheck = await checkJsonEndpoint(`/api/crm/meta-city-key?city=${encodeURIComponent("Астана")}`);
  const cityKeyData = (cityKeyCheck.data || {}) as {
    key?: unknown;
    source?: unknown;
    geoMode?: unknown;
    fallbackCountry?: unknown;
    selected?: { key?: unknown; name?: unknown } | null;
    candidates?: unknown[];
    rejectedCandidates?: unknown[];
  };
  if (cityKeyData.key !== "1301648" || cityKeyData.source !== "static" || cityKeyData.geoMode !== "city" || cityKeyData.fallbackCountry !== false) {
    throw new Error("/api/crm/meta-city-key must resolve Astana to static city key 1301648");
  }
  if (!cityKeyData.selected || cityKeyData.selected.key !== "1301648" || !Array.isArray(cityKeyData.candidates) || !Array.isArray(cityKeyData.rejectedCandidates)) {
    throw new Error("/api/crm/meta-city-key must return selected/candidates/rejectedCandidates diagnostics");
  }
  const aktobeCityKeyCheck = await checkJsonEndpoint(`/api/crm/meta-city-key?city=${encodeURIComponent("Актобе")}`);
  const aktobeCityKeyData = (aktobeCityKeyCheck.data || {}) as {
    key?: unknown;
    source?: unknown;
    geoMode?: unknown;
    fallbackCountry?: unknown;
    selected?: { key?: unknown; name?: unknown } | null;
  };
  if (
    aktobeCityKeyData.key !== "1289458" ||
    aktobeCityKeyData.source !== "static" ||
    aktobeCityKeyData.geoMode !== "city" ||
    aktobeCityKeyData.fallbackCountry !== false ||
    aktobeCityKeyData.selected?.key !== "1289458"
  ) {
    throw new Error("/api/crm/meta-city-key must resolve Aktobe to static city key 1289458");
  }
  await checkJsonFailure(
    "/api/crm/meta-launch",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        campaignName: "Smoke Meta Campaign missing creative URL",
        objective: "OUTCOME_LEADS",
        statusMode: "PAUSED",
        dailyBudget: 20,
        totalBudget: 140,
        currency: "USD",
        city: "Astana",
        targetAudience: "Women 25-55",
        primaryText: "Professional consultation in Astana. Book a specialist consultation.",
        headline: "Consultation in Astana",
        description: "Book a consultation with a specialist.",
        cta: "LEARN_MORE",
        landingUrl: "https://example.com",
        creativeType: "image",
        complianceConfirmed: true,
        manualApprovalConfirmed: true,
        dryRun: false,
      }),
    },
    "Креатив",
  );
  const aktobeLaunch = await checkJsonEndpoint("/api/crm/meta-launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      campaignName: "Smoke Meta Campaign Aktobe",
      objective: "OUTCOME_LEADS",
      statusMode: "PAUSED",
      dailyBudget: 20,
      totalBudget: 140,
      currency: "USD",
      city: "Актобе",
      selectedCityId: "aktobe",
      targetAudience: "Women 25-55",
      primaryText: "Professional consultation in Aktobe. Book a specialist consultation.",
      headline: "Consultation in Aktobe",
      description: "Book a consultation with a specialist.",
      cta: "LEARN_MORE",
      landingUrl: "https://example.com",
      imageUrl: "https://example.com/smoke-creative.jpg",
      creativeType: "image",
      creativeUrl: "https://example.com/smoke-creative.jpg",
      complianceConfirmed: true,
      manualApprovalConfirmed: true,
      dryRun: true,
    }),
  });
  const aktobeAdSetPayload = (((aktobeLaunch.data || {}) as { metaPayload?: { adSet?: Record<string, unknown> } }).metaPayload?.adSet || {}) as {
    targeting?: {
      geo_locations?: { countries?: unknown; cities?: Array<{ key?: unknown; radius?: unknown; distance_unit?: unknown }> };
    };
    targetingDebug?: { cityKey?: unknown; usesRadius?: unknown; fallbackCountry?: unknown; cityRadiusKm?: unknown };
  };
  const aktobeAdSetCity = aktobeAdSetPayload.targeting?.geo_locations?.cities?.[0] || {};
  if (aktobeAdSetCity.key !== "1289458") {
    throw new Error("/api/crm/meta-launch dry-run Aktobe targeting must use static city key 1289458");
  }
  if (Object.prototype.hasOwnProperty.call(aktobeAdSetCity, "radius") || Object.prototype.hasOwnProperty.call(aktobeAdSetCity, "distance_unit")) {
    throw new Error("/api/crm/meta-launch dry-run Aktobe city targeting must not include radius or distance_unit");
  }
  if (Object.prototype.hasOwnProperty.call(aktobeAdSetPayload.targeting?.geo_locations || {}, "countries")) {
    throw new Error("/api/crm/meta-launch dry-run Aktobe targeting must not fallback to countries when city key is found");
  }
  if (aktobeAdSetPayload.targetingDebug?.usesRadius !== false || aktobeAdSetPayload.targetingDebug?.cityRadiusKm !== "-") {
    throw new Error("/api/crm/meta-launch dry-run Aktobe debug must expose usesRadius false and cityRadiusKm '-'");
  }
  const launch = await checkJsonEndpoint("/api/crm/meta-launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      campaignName: "Smoke Meta Campaign",
      objective: "OUTCOME_LEADS",
      statusMode: "PAUSED",
      dailyBudget: 20,
      totalBudget: 140,
      currency: "USD",
      city: "Astana",
      targetAudience: "Women 25-55",
      primaryText: "Professional consultation in Astana. Book a specialist consultation.",
      headline: "Consultation in Astana",
      description: "Book a consultation with a specialist.",
      cta: "LEARN_MORE",
      landingUrl: "https://wa.me/77000000000",
      imageUrl: "https://example.com/smoke-creative.jpg",
      creativeType: "image",
      creativeUrl: "https://example.com/smoke-creative.jpg",
      complianceConfirmed: true,
      manualApprovalConfirmed: true,
      dryRun: true,
    }),
  });
  const launchData = (launch.data || {}) as {
    metaCampaignId?: string;
    metaStatus?: string;
    status?: string;
    launch?: { status?: string };
    metaPayload?: {
      campaign?: Record<string, unknown>;
      adSet?: Record<string, unknown>;
      creative?: Record<string, unknown>;
      ad?: Record<string, unknown>;
      launchTimestamp?: string;
    };
    launchTimestamp?: string;
  };
  const campaignPayload = launchData.metaPayload?.campaign || {};
  const adSetPayload = launchData.metaPayload?.adSet || {};
  const creativePayload = launchData.metaPayload?.creative || {};
  const adPayload = launchData.metaPayload?.ad || {};
  const launchTimestamp = launchData.launchTimestamp || launchData.metaPayload?.launchTimestamp || "";
  if (!/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$/.test(launchTimestamp)) {
    throw new Error("/api/crm/meta-launch dry-run must return launchTimestamp in YYYY-MM-DD_HH-mm format");
  }
  const payloadNames = [campaignPayload.name, adSetPayload.name, creativePayload.name, adPayload.name].map((value) =>
    typeof value === "string" ? value : "",
  );
  if (payloadNames.some((name) => !name.includes(launchTimestamp))) {
    throw new Error("/api/crm/meta-launch dry-run must use one timestamp across campaign/adset/creative/ad names");
  }
  if (campaignPayload.is_adset_budget_sharing_enabled !== false) {
    throw new Error("/api/crm/meta-launch dry-run campaign payload must contain is_adset_budget_sharing_enabled: false");
  }
  if (Object.prototype.hasOwnProperty.call(campaignPayload, "daily_budget")) {
    throw new Error("/api/crm/meta-launch dry-run campaign payload must not contain campaign-level daily_budget");
  }
  if (adSetPayload.daily_budget !== "2000") {
    throw new Error('/api/crm/meta-launch dry-run adset payload must keep daily_budget "2000" at ad set level');
  }
  if (Object.prototype.hasOwnProperty.call(adSetPayload, "lifetime_budget")) {
    throw new Error("/api/crm/meta-launch dry-run adset payload must not contain lifetime_budget when daily budget is used");
  }
  if (Object.prototype.hasOwnProperty.call(adSetPayload, "end_time")) {
    throw new Error("/api/crm/meta-launch dry-run adset payload must not contain end_time when daily budget is used");
  }
  if (adSetPayload.billing_event !== "IMPRESSIONS") {
    throw new Error("/api/crm/meta-launch dry-run adset payload must include billing_event IMPRESSIONS");
  }
  if (adSetPayload.optimization_goal !== "LINK_CLICKS") {
    throw new Error("/api/crm/meta-launch dry-run adset payload must include optimization_goal LINK_CLICKS");
  }
  if (adSetPayload.bid_strategy !== "LOWEST_COST_WITHOUT_CAP") {
    throw new Error("/api/crm/meta-launch dry-run adset payload must include bid_strategy LOWEST_COST_WITHOUT_CAP");
  }
  if (!adSetPayload.campaign_id) {
    throw new Error("/api/crm/meta-launch dry-run adset payload must include campaign_id");
  }
  if (Object.prototype.hasOwnProperty.call(adSetPayload, "targeting_automation")) {
    throw new Error("/api/crm/meta-launch dry-run adset payload must keep targeting_automation inside targeting");
  }
  const adSetTargeting = (adSetPayload.targeting || {}) as {
    geo_locations?: { countries?: unknown; cities?: Array<{ key?: unknown; radius?: unknown; distance_unit?: unknown }> };
    targeting_automation?: { advantage_audience?: unknown };
    publisher_platforms?: unknown[];
    instagram_positions?: unknown[];
  };
  const adSetTargetingDebug = (adSetPayload.targetingDebug || {}) as {
    selectedCity?: { id?: unknown; labelRu?: unknown; canonicalName?: unknown };
    cityId?: unknown;
    cityKey?: unknown;
    cityRadiusKm?: unknown;
    usesRadius?: unknown;
    candidates?: unknown[];
    rejectedCandidates?: unknown[];
    fallbackCountry?: unknown;
  };
  if (!Array.isArray(adSetTargeting.geo_locations?.cities) || adSetTargeting.geo_locations?.cities?.[0]?.key !== "1301648") {
    throw new Error("/api/crm/meta-launch dry-run Astana targeting must use static city key 1301648 when city key is available");
  }
  if (Object.prototype.hasOwnProperty.call(adSetTargeting.geo_locations || {}, "countries")) {
    throw new Error("/api/crm/meta-launch dry-run Astana targeting must not use country-only mode when city key is available");
  }
  const astanaCity = adSetTargeting.geo_locations?.cities?.[0] || {};
  if (Object.prototype.hasOwnProperty.call(astanaCity, "radius") || Object.prototype.hasOwnProperty.call(astanaCity, "distance_unit")) {
    throw new Error("/api/crm/meta-launch dry-run Astana city targeting must not include radius or distance_unit");
  }
  if (adSetTargeting.targeting_automation?.advantage_audience !== 0) {
    throw new Error("/api/crm/meta-launch dry-run targeting must include targeting_automation.advantage_audience: 0");
  }
  if (adSetTargetingDebug.selectedCity?.id !== "astana" || adSetTargetingDebug.cityKey !== "1301648") {
    throw new Error("/api/crm/meta-launch dry-run targeting debug must expose selected city and city key");
  }
  if (!Array.isArray(adSetTargetingDebug.candidates) || !Array.isArray(adSetTargetingDebug.rejectedCandidates)) {
    throw new Error("/api/crm/meta-launch dry-run targeting debug must expose candidates and rejectedCandidates arrays");
  }
  if (adSetTargetingDebug.usesRadius !== false || adSetTargetingDebug.cityRadiusKm !== "-") {
    throw new Error("/api/crm/meta-launch dry-run targeting debug must expose usesRadius false and cityRadiusKm '-'");
  }
  const publisherPlatforms = (adSetTargeting.publisher_platforms || []).map(String);
  const instagramPositions = (adSetTargeting.instagram_positions || []).map(String);
  if (JSON.stringify(publisherPlatforms) !== JSON.stringify(["instagram"])) {
    throw new Error('/api/crm/meta-launch dry-run targeting must include publisher_platforms ["instagram"]');
  }
  if (!["stream", "story", "explore", "reels"].every((position) => instagramPositions.includes(position))) {
    throw new Error("/api/crm/meta-launch dry-run targeting must include Instagram positions");
  }
  for (const forbidden of ["facebook", "messenger", "whatsapp", "threads"]) {
    if (publisherPlatforms.includes(forbidden)) {
      throw new Error(`/api/crm/meta-launch dry-run targeting must not include ${forbidden} placement`);
    }
  }
  if (typeof creativePayload.usesInstagramActor !== "boolean") {
    throw new Error("/api/crm/meta-launch dry-run creative payload must expose usesInstagramActor");
  }
  if (creativePayload.instagramActorFallback !== false) {
    throw new Error("/api/crm/meta-launch dry-run creative payload must expose instagramActorFallback false");
  }
  const creativeAsset = (creativePayload.asset || {}) as { fileType?: unknown };
  if (creativeAsset.fileType !== "image") {
    throw new Error('/api/crm/meta-launch dry-run creative asset.fileType must be "image" for image assets');
  }
  if (creativePayload.objectStorySpecType !== "link_data") {
    throw new Error('/api/crm/meta-launch dry-run image creative must use objectStorySpecType "link_data"');
  }
  if (creativePayload.imageUploadMode !== "adimages") {
    throw new Error('/api/crm/meta-launch dry-run image creative must default imageUploadMode to "adimages"');
  }
  if (creativePayload.usesVideoData !== false) {
    throw new Error("/api/crm/meta-launch dry-run image creative must not use video_data");
  }
  if (creativePayload.usesLinkData !== true) {
    throw new Error("/api/crm/meta-launch dry-run image creative must use link_data");
  }
  if (creativePayload.imageHash !== true) {
    throw new Error("/api/crm/meta-launch dry-run image creative must show imageHash expected");
  }
  if (creativePayload.pictureUrl !== false) {
    throw new Error("/api/crm/meta-launch dry-run image creative must not use pictureUrl before fallback");
  }
  if (creativePayload.imageUploadCapabilityFallback !== false) {
    throw new Error("/api/crm/meta-launch dry-run image creative must expose imageUploadCapabilityFallback false");
  }
  if (campaignPayload.status !== "PAUSED" || launchData.metaStatus !== "PAUSED") {
    throw new Error("/api/crm/meta-launch dry-run must use PAUSED status");
  }
  if (launchData.status !== "dry_run") {
    throw new Error("/api/crm/meta-launch dry-run must report launch status dry_run, not a real PAUSED launch");
  }
  if (!String(launchData.metaCampaignId || "").startsWith("dryrun_")) {
    throw new Error("/api/crm/meta-launch dry-run must return a dryrun_ campaign id");
  }
  if (launchData.launch?.status !== "dry_run") {
    throw new Error("/api/crm/meta-launch dry-run history record must be saved with status dry_run");
  }
  const videoDryRun = await checkJsonEndpoint("/api/crm/meta-launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      campaignName: "Smoke Meta Video Campaign",
      objective: "OUTCOME_LEADS",
      statusMode: "PAUSED",
      dailyBudget: 20,
      totalBudget: 140,
      currency: "USD",
      city: "Astana",
      targetAudience: "Women 25-55",
      primaryText: "Professional consultation in Astana. Book a specialist consultation.",
      headline: "Consultation in Astana",
      description: "Book a consultation with a specialist.",
      cta: "LEARN_MORE",
      landingUrl: "https://example.com",
      creativeType: "video",
      creativeUrl: "https://example.com/smoke-creative.mp4",
      videoUrl: "https://example.com/smoke-creative.mp4",
      fileName: "smoke-creative.mp4",
      mimeType: "video/mp4",
      complianceConfirmed: true,
      manualApprovalConfirmed: true,
      dryRun: true,
    }),
  });
  const videoCreativePayload = ((videoDryRun.data || {}) as { metaPayload?: { creative?: Record<string, unknown> } }).metaPayload?.creative || {};
  if (videoCreativePayload.objectStorySpecType !== "video_data" || videoCreativePayload.usesVideoData !== true) {
    throw new Error('/api/crm/meta-launch dry-run video creative must stay on objectStorySpecType "video_data"');
  }
  const videoDebug = (videoCreativePayload.video || {}) as { mimeType?: unknown; videoId?: unknown; launchEnabled?: unknown };
  if (videoDebug.mimeType !== "video/mp4" || videoDebug.videoId !== false) {
    throw new Error("/api/crm/meta-launch dry-run video creative must expose video MIME and missing video_id debug");
  }
  const expectedVideoStatus = videoCreativePayload.videoLaunchEnabled ? "experimental" : "soon";
  if (videoCreativePayload.metaVideoLaunchStatus !== expectedVideoStatus || videoDebug.launchEnabled !== videoCreativePayload.videoLaunchEnabled) {
    throw new Error('/api/crm/meta-launch dry-run video creative must expose video launch flag/status debug');
  }
  const videoDryRunWarning = String(((videoDryRun.data || {}) as { warning?: unknown }).warning || "");
  if (!videoDryRunWarning.includes("обложка")) {
    throw new Error("/api/crm/meta-launch video dry-run without thumbnail must warn about the missing cover, not fail");
  }
  if (videoCreativePayload.videoDataHasImageUrl !== false) {
    throw new Error("/api/crm/meta-launch video dry-run without thumbnail must expose videoDataHasImageUrl false");
  }
  const videoDryRunWithThumb = await checkJsonEndpoint("/api/crm/meta-launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      campaignName: "Smoke Meta Video Campaign Thumb",
      objective: "OUTCOME_LEADS",
      statusMode: "PAUSED",
      dailyBudget: 20,
      totalBudget: 140,
      currency: "USD",
      city: "Astana",
      targetAudience: "Women 25-55",
      primaryText: "Professional consultation in Astana. Book a specialist consultation.",
      headline: "Consultation in Astana",
      description: "Book a consultation with a specialist.",
      cta: "LEARN_MORE",
      landingUrl: "https://example.com",
      creativeType: "video",
      creativeUrl: "https://example.com/smoke-creative.mp4",
      videoUrl: "https://example.com/smoke-creative.mp4",
      thumbnailUrl: "https://example.com/smoke-creative-thumb.jpg",
      fileName: "smoke-creative.mp4",
      mimeType: "video/mp4",
      complianceConfirmed: true,
      manualApprovalConfirmed: true,
      dryRun: true,
    }),
  });
  const thumbCreativePayload =
    ((videoDryRunWithThumb.data || {}) as { metaPayload?: { creative?: Record<string, unknown> } }).metaPayload?.creative || {};
  if (thumbCreativePayload.videoDataHasImageUrl !== true) {
    throw new Error("/api/crm/meta-launch video dry-run with thumbnail must expose videoDataHasImageUrl true");
  }
  const thumbVideoDebug = (thumbCreativePayload.video || {}) as { thumbnailUrl?: unknown; thumbnailSource?: unknown };
  if (thumbVideoDebug.thumbnailUrl !== true || thumbVideoDebug.thumbnailSource !== "auto_frame") {
    throw new Error("/api/crm/meta-launch video dry-run with thumbnail must expose thumbnail debug fields");
  }
  await checkJsonFailure(
    "/api/crm/meta-launch",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        campaignName: "Smoke Meta Video Campaign Real",
        objective: "OUTCOME_LEADS",
        statusMode: "PAUSED",
        dailyBudget: 20,
        totalBudget: 140,
        currency: "USD",
        city: "Astana",
        targetAudience: "Women 25-55",
        primaryText: "Professional consultation in Astana. Book a specialist consultation.",
        headline: "Consultation in Astana",
        description: "Book a consultation with a specialist.",
        cta: "LEARN_MORE",
        landingUrl: "https://example.com",
        creativeType: "video",
        creativeUrl: "https://example.com/smoke-creative.mp4",
        videoUrl: "https://example.com/smoke-creative.mp4",
        complianceConfirmed: true,
        manualApprovalConfirmed: true,
        dryRun: false,
      }),
    },
    "автозапуск видео-рекламы",
  );
  await checkJsonEndpoint(`/api/crm/meta-status?campaignId=${encodeURIComponent(launchData.metaCampaignId || "dryrun_campaign_smoke")}`);
  await checkCrmEndpoint("/api/crm/release-checks", {
    checkKey: "smoke-release",
    status: "passed",
    notes: "Smoke test",
  });
  await checkJsonEndpoint("/api/content-studio/videos");
  await checkJsonEndpoint("/api/content-studio/videos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Smoke content studio video",
      niche: "medical marketing",
      goal: "book more appointments",
    }),
  });
  await checkJsonEndpoint("/api/content-studio/generate-script", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Demo clinic video",
      niche: "medical marketing",
      goal: "book more appointments",
      audience: "clinic owners",
      style: "expert",
      duration: "30-45 seconds",
    }),
  });
  await checkJsonEndpoint("/api/content-studio/generate-avatar-prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Demo clinic video",
      style: "expert",
    }),
  });
  await checkJsonEndpoint("/api/content-studio/generate-tapnow-prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Demo clinic video",
      niche: "medical marketing",
      goal: "book more appointments",
    }),
  });
  await checkJsonEndpoint("/api/content-studio/send-telegram", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Demo clinic video",
      hook: "Clinic leads need fast follow-up",
      script: "Demo script",
      caption: "Demo caption",
      hashtags: ["#crm", "#ai"],
    }),
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

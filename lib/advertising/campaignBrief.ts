export const ADVERTISING_CAMPAIGN_PREFILL_KEY = "negis_ads_automation_prefill";
export const ADVERTISING_CAMPAIGN_BRIEF_VERSION = 1 as const;

export type AdvertisingPlatform = "meta" | "tiktok";
export type AdvertisingCreativeType = "image" | "video";
export type AdvertisingBriefSourceKind =
  | "photo"
  | "generated"
  | "package"
  | "library";

export type AdvertisingCampaignCreative = {
  type: AdvertisingCreativeType;
  url?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  format?: string;
  brief?: string;
};

export type AdvertisingCampaignPrefill = {
  schemaVersion: typeof ADVERTISING_CAMPAIGN_BRIEF_VERSION;
  platform: AdvertisingPlatform;
  sourceModule: "content-studio";
  sourceKind: AdvertisingBriefSourceKind;
  sourceId?: string;
  campaignName?: string;
  service?: string;
  city?: string;
  cityId?: string;
  offer?: string;
  audience?: string;
  primaryText?: string;
  headline?: string;
  description?: string;
  cta?: string;
  creative?: AdvertisingCampaignCreative;
  generatedAt?: string;
};

export type AdvertisingCampaignPrefillInput = Omit<
  AdvertisingCampaignPrefill,
  "schemaVersion" | "sourceModule"
>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return undefined;
  return Math.floor(value);
}

function normalizePlatform(value: unknown): AdvertisingPlatform | null {
  if (value === undefined || value === null || value === "") return "meta";
  return value === "meta" || value === "tiktok" ? value : null;
}

function normalizeSourceKind(
  record: Record<string, unknown>,
): AdvertisingBriefSourceKind {
  const raw = firstString(record.sourceKind, record.source)?.toLowerCase();
  if (raw === "photo" || raw === "content_studio_photo") return "photo";
  if (raw === "generated" || raw === "content_studio_generated")
    return "generated";
  if (raw === "library") return "library";
  return "package";
}

function normalizeCreative(
  record: Record<string, unknown>,
): AdvertisingCampaignCreative | undefined {
  const nested = asRecord(record.creative);
  const rawType = firstString(nested.type, record.creativeType)?.toLowerCase();
  const type: AdvertisingCreativeType = rawType === "video" ? "video" : "image";
  const url = firstString(nested.url, record.creativeUrl, record.imageUrl);
  const fileName = firstString(nested.fileName, record.fileName);
  const mimeType = firstString(nested.mimeType, record.mimeType);
  const fileSize = optionalNonNegativeInteger(
    nested.fileSize ?? record.fileSize,
  );
  const format = firstString(nested.format, record.format);
  const brief = firstString(nested.brief, record.creativeBrief);

  if (
    !url &&
    !fileName &&
    !mimeType &&
    fileSize === undefined &&
    !format &&
    !brief
  )
    return undefined;

  return {
    type,
    ...(url ? { url } : {}),
    ...(fileName ? { fileName } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(fileSize !== undefined ? { fileSize } : {}),
    ...(format ? { format } : {}),
    ...(brief ? { brief } : {}),
  };
}

function hasCampaignContent(prefill: AdvertisingCampaignPrefill): boolean {
  return Boolean(
    prefill.campaignName ||
    prefill.service ||
    prefill.offer ||
    prefill.audience ||
    prefill.primaryText ||
    prefill.headline ||
    prefill.creative,
  );
}

/**
 * Accepts both the versioned contract and all Content Studio payloads written
 * before the contract existed. A missing platform means legacy Meta handoff.
 */
export function parseAdvertisingCampaignPrefill(
  value: unknown,
): AdvertisingCampaignPrefill | null {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return null;

  const schemaVersion = record.schemaVersion;
  if (
    schemaVersion !== undefined &&
    schemaVersion !== ADVERTISING_CAMPAIGN_BRIEF_VERSION
  )
    return null;

  const platform = normalizePlatform(record.platform);
  if (!platform) return null;

  const creative = normalizeCreative(record);
  const prefill: AdvertisingCampaignPrefill = {
    schemaVersion: ADVERTISING_CAMPAIGN_BRIEF_VERSION,
    platform,
    sourceModule: "content-studio",
    sourceKind: normalizeSourceKind(record),
    sourceId: firstString(record.sourceId, record.contentPackageId),
    campaignName: firstString(record.campaignName, record.title),
    service: firstString(record.service, record.niche),
    city: firstString(record.city),
    cityId: firstString(record.cityId),
    offer: firstString(record.offer),
    audience: firstString(record.audience, record.targetAudience),
    primaryText: firstString(
      record.primaryText,
      record.adText,
      record.caption,
      record.script,
    ),
    headline: firstString(record.headline, record.hook, record.title),
    description: firstString(record.description, record.caption, record.offer),
    cta: firstString(record.cta),
    generatedAt: firstString(record.generatedAt),
    ...(creative ? { creative } : {}),
  };

  return hasCampaignContent(prefill) ? prefill : null;
}

export function parseAdvertisingCampaignPrefillForPlatform(
  value: unknown,
  platform: AdvertisingPlatform,
): AdvertisingCampaignPrefill | null {
  const prefill = parseAdvertisingCampaignPrefill(value);
  return prefill?.platform === platform ? prefill : null;
}

export function createAdvertisingCampaignPrefill(
  input: AdvertisingCampaignPrefillInput,
): AdvertisingCampaignPrefill {
  const parsed = parseAdvertisingCampaignPrefill({
    ...input,
    schemaVersion: ADVERTISING_CAMPAIGN_BRIEF_VERSION,
    sourceModule: "content-studio",
  });

  if (!parsed) {
    throw new Error(
      "Advertising campaign prefill must contain campaign or creative data",
    );
  }

  return parsed;
}

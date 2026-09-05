import { URL } from "node:url";
import type { TikTokIdentityType } from "./setup";
import {
  parseAdvertisingCampaignPrefill,
  type AdvertisingCampaignPrefill,
} from "../advertising/campaignBrief";

export const TIKTOK_CAMPAIGN_CREATE_ENDPOINT = "/open_api/v1.3/campaign/create/";
export const TIKTOK_ADGROUP_CREATE_ENDPOINT = "/open_api/v1.3/adgroup/create/";
export const TIKTOK_AD_CREATE_ENDPOINT = "/open_api/v1.3/ad/create/";
export const TIKTOK_DISABLED_OPERATION_STATUS = "DISABLE" as const;

type TikTokCurrency = "KZT" | "USD";

export type TikTokDryRunBlockerCode =
  | "invalid_brief"
  | "campaign_name_required"
  | "service_required"
  | "city_required"
  | "ad_text_required"
  | "video_required"
  | "destination_required"
  | "invalid_budget"
  | "invalid_currency"
  | "schedule_required"
  | "advertiser_not_configured"
  | "identity_not_configured"
  | "location_not_resolved"
  | "video_upload_required"
  | "live_adapter_disabled";

export type TikTokDryRunIssue = {
  code: TikTokDryRunBlockerCode;
  message: string;
};

export type TikTokCampaignDryRunContext = {
  advertiserConfigured?: boolean;
  identityConfigured?: boolean;
  identityType?: TikTokIdentityType;
  locationIds?: readonly string[];
  uploadedVideoIdAvailable?: boolean;
};

export type TikTokCampaignDryRun = {
  platform: "tiktok";
  dryRun: true;
  launchEnabled: false;
  targetOperationStatus: typeof TIKTOK_DISABLED_OPERATION_STATUS;
  readiness: {
    briefReady: boolean;
    providerReady: false;
    blockers: TikTokDryRunIssue[];
    providerDependencies: TikTokDryRunIssue[];
  };
  summary: {
    campaignName: string;
    service: string;
    city: string;
    creativeType: "video" | "image" | "unknown";
    placement: "TikTok";
    objective: "Переходы на сайт";
    dailyBudget: string;
    currency: TikTokCurrency | "";
    destinationConfigured: boolean;
    scheduleStartTime: string;
    status: "Будет создана выключенной";
  };
  payloadTemplate: {
    campaign: Record<string, unknown>;
    adGroup: Record<string, unknown>;
    ad: Record<string, unknown>;
  };
  safety: {
    providerCallsMade: false;
    createsCampaign: false;
    credentialsIncluded: false;
    rawCreativeUrlIncluded: false;
  };
};

type ParsedBudget = {
  currency: TikTokCurrency;
  decimal: string;
  amount: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown, maxLength = 500): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function readLocationIds(value: readonly string[] | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.map((item) => item.trim()).filter((item) => /^\d{3,32}$/.test(item)))].slice(0, 20);
}

function normalizeSchedule(value: unknown): string {
  const raw = readString(value, 32).replace("T", " ");
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(raw)) return "";
  return raw.length === 16 ? `${raw}:00` : raw;
}

function parseDailyBudget(value: unknown, rawCurrency: unknown): ParsedBudget | null {
  const currency = readString(rawCurrency, 3).toUpperCase();
  if (currency !== "KZT" && currency !== "USD") return null;

  const raw = (typeof value === "number" && Number.isFinite(value) ? String(value) : readString(value, 32))
    .replace(/\s/g, "")
    .replace(",", ".");
  const match = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) return null;

  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] || "").padEnd(2, "0"));
  const minor = whole * 100n + fraction;
  if (minor <= 0n || minor > 10_000_000_000n) return null;

  const decimal = `${whole.toString()}.${fraction.toString().padStart(2, "0")}`;
  return { currency, decimal, amount: Number(decimal) };
}

function isSafeDestination(value: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function issue(code: TikTokDryRunBlockerCode, message: string): TikTokDryRunIssue {
  return { code, message };
}

function parseBrief(record: Record<string, unknown>): AdvertisingCampaignPrefill | null {
  const nested = asRecord(record.brief);
  return parseAdvertisingCampaignPrefill(Object.keys(nested).length > 0 ? nested : record);
}

/**
 * Builds a provider-shaped template without contacting TikTok. Identifiers,
 * credentials and media URLs are deliberately represented only by booleans or
 * server placeholders, so this result is safe to return to an admin browser.
 */
export function buildTikTokCampaignDryRun(
  value: unknown,
  context: TikTokCampaignDryRunContext = {},
): TikTokCampaignDryRun {
  const record = asRecord(value);
  const brief = parseBrief(record);
  const campaignName = readString(brief?.campaignName, 128);
  const service = readString(brief?.service, 160);
  const city = readString(brief?.city, 100);
  const adText = readString(brief?.primaryText, 2000);
  const creativeType = brief?.creative?.type || "unknown";
  const destinationUrl = readString(record.destinationUrl, 2048);
  const destinationConfigured = isSafeDestination(destinationUrl);
  const scheduleStartTime = normalizeSchedule(record.scheduleStartTime);
  const currencyInput = readString(record.currency, 3).toUpperCase();
  const budget = parseDailyBudget(record.dailyBudget, currencyInput);
  const locationIds = readLocationIds(context.locationIds);

  const validationBlockers: TikTokDryRunIssue[] = [];
  if (!brief || brief.platform !== "tiktok") {
    validationBlockers.push(issue("invalid_brief", "Нужен отдельный бриф для TikTok."));
  }
  if (!campaignName) validationBlockers.push(issue("campaign_name_required", "Укажите название кампании."));
  if (!service) validationBlockers.push(issue("service_required", "Укажите услугу."));
  if (!city) validationBlockers.push(issue("city_required", "Укажите город показа."));
  if (!adText) validationBlockers.push(issue("ad_text_required", "Добавьте текст объявления."));
  if (creativeType !== "video") {
    validationBlockers.push(issue("video_required", "Для первого TikTok-потока нужен вертикальный видеокреатив."));
  }
  if (!destinationConfigured) {
    validationBlockers.push(issue("destination_required", "Укажите корректную ссылку назначения."));
  }
  if (currencyInput !== "KZT" && currencyInput !== "USD") {
    validationBlockers.push(issue("invalid_currency", "Поддерживаются валюты KZT и USD."));
  } else if (!budget) {
    validationBlockers.push(issue("invalid_budget", "Укажите положительный дневной бюджет."));
  }
  if (!scheduleStartTime) {
    validationBlockers.push(issue("schedule_required", "Укажите дату и время начала по часовому поясу рекламного аккаунта."));
  }

  const providerDependencies: TikTokDryRunIssue[] = [];
  if (!context.advertiserConfigured) {
    providerDependencies.push(issue("advertiser_not_configured", "Рекламный аккаунт TikTok ещё не подтверждён сервером."));
  }
  if (!context.identityConfigured) {
    providerDependencies.push(issue("identity_not_configured", "Подтвердите рекламный профиль TikTok перед проверкой плана."));
  }
  if (locationIds.length === 0) {
    providerDependencies.push(issue("location_not_resolved", `Нужно получить TikTok location ID для города ${city || "показа"}.`));
  }
  if (!context.uploadedVideoIdAvailable) {
    providerDependencies.push(issue("video_upload_required", "Нужно загрузить видео в TikTok и получить video_id."));
  }
  providerDependencies.push(issue("live_adapter_disabled", "Создание TikTok-рекламы ещё не включено."));

  const disabledStatus = TIKTOK_DISABLED_OPERATION_STATUS;
  const safeAdvertiserId = "__SERVER_ADVERTISER_ID__";
  const payloadTemplate = {
    campaign: {
      advertiser_id: safeAdvertiserId,
      campaign_name: campaignName || "__CAMPAIGN_NAME_REQUIRED__",
      objective_type: "TRAFFIC",
      budget_optimize_on: false,
      operation_status: disabledStatus,
    },
    adGroup: {
      advertiser_id: safeAdvertiserId,
      campaign_id: "__CREATED_CAMPAIGN_ID__",
      adgroup_name: campaignName ? `${campaignName} · группа` : "__ADGROUP_NAME_REQUIRED__",
      promotion_type: "WEBSITE",
      placements: ["PLACEMENT_TIKTOK"],
      billing_event: "CPC",
      optimization_goal: "CLICK",
      ...(budget ? { budget: budget.amount, budget_mode: "BUDGET_MODE_DAY" } : {}),
      pacing: "PACING_MODE_SMOOTH",
      schedule_type: "SCHEDULE_START_END",
      ...(scheduleStartTime ? { schedule_start_time: scheduleStartTime } : {}),
      ...(locationIds.length > 0 ? { location_ids: locationIds.map(() => "__SERVER_LOCATION_ID__") } : {}),
      operation_status: disabledStatus,
    },
    ad: {
      advertiser_id: safeAdvertiserId,
      adgroup_id: "__CREATED_ADGROUP_ID__",
      creatives: [
        {
          ad_name: campaignName ? `${campaignName} · объявление` : "__AD_NAME_REQUIRED__",
          ad_format: "SINGLE_VIDEO",
          identity_type: context.identityType || "CUSTOMIZED_USER",
          ...(context.identityType === "BC_AUTH_TT" && context.identityConfigured ? { identity_authorized_bc_id: "__SERVER_BUSINESS_CENTER_ID__" } : {}),
          ...(context.identityConfigured ? { identity_id: "__SERVER_IDENTITY_ID__" } : {}),
          ...(context.uploadedVideoIdAvailable ? { video_id: "__UPLOADED_TIKTOK_VIDEO_ID__" } : {}),
          ad_text: adText || "__AD_TEXT_REQUIRED__",
          ...(destinationConfigured ? { landing_page_url: "__CONFIGURED_DESTINATION_URL__" } : {}),
          call_to_action: "LEARN_MORE",
          operation_status: disabledStatus,
        },
      ],
    },
  };

  return {
    platform: "tiktok",
    dryRun: true,
    launchEnabled: false,
    targetOperationStatus: disabledStatus,
    readiness: {
      briefReady: validationBlockers.length === 0,
      providerReady: false,
      blockers: [...validationBlockers, ...providerDependencies],
      providerDependencies,
    },
    summary: {
      campaignName,
      service,
      city,
      creativeType,
      placement: "TikTok",
      objective: "Переходы на сайт",
      dailyBudget: budget?.decimal || "",
      currency: budget?.currency || "",
      destinationConfigured,
      scheduleStartTime,
      status: "Будет создана выключенной",
    },
    payloadTemplate,
    safety: {
      providerCallsMade: false,
      createsCampaign: false,
      credentialsIncluded: false,
      rawCreativeUrlIncluded: false,
    },
  };
}

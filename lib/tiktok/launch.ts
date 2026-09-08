import { createHash, randomUUID } from "node:crypto";
import { URL } from "node:url";
import { getSupabaseServerClient } from "../supabase/server";
import {
  buildTikTokCampaignDryRun,
  buildTikTokDisabledLaunchPayloads,
  TIKTOK_AD_CREATE_ENDPOINT,
  TIKTOK_ADGROUP_CREATE_ENDPOINT,
  TIKTOK_CAMPAIGN_CREATE_ENDPOINT,
  TIKTOK_DISABLED_OPERATION_STATUS,
  TikTokCampaignValidationError,
  type TikTokCurrency,
} from "./campaign";
import {
  readTikTokConnection,
  requireTikTokProvisionedWorkspace,
  TikTokConnectionError,
  type TikTokConnectionSummary,
} from "./connections";
import {
  getTikTokAdsConfig,
  validateTikTokAdsConnection,
  type TikTokAdsConnectionDiagnostic,
} from "./diagnostics";
import {
  readTikTokVerifiedSetup,
  verifyTikTokSetup,
  type TikTokIdentityType,
  type TikTokSetupSummary,
} from "./setup";
import {
  tikTokVideos,
  type TikTokReadyVideoForLaunch,
  type TikTokVideoSummary,
} from "./videoAssets";

type Env = Readonly<Record<string, string | undefined>>;
export type TikTokLaunchStatus =
  | "creating"
  | "campaign_created"
  | "adgroup_created"
  | "created_disabled"
  | "failed"
  | "unknown";
export type TikTokLaunchStep = "campaign" | "adgroup" | "ad" | "persistence";
export type TikTokLaunchErrorCode =
  | "launch_disabled"
  | "confirmation_required"
  | "invalid_request"
  | "currency_mismatch"
  | "setup_required"
  | "video_not_ready"
  | "provider_auth"
  | "provider_permission"
  | "provider_rate_limited"
  | "provider_rejected"
  | "provider_response_unknown"
  | "request_timeout"
  | "connection_revoked"
  | "persistence_failed";

export type TikTokLaunchRow = {
  id: string;
  workspace_id: string;
  advertiser_id: string;
  video_upload_id: string;
  requested_by_staff_user_id: string | null;
  idempotency_key: string;
  campaign_name: string;
  service: string;
  city: string;
  daily_budget_minor: string;
  currency: string;
  destination_fingerprint: string;
  operation_status: typeof TIKTOK_DISABLED_OPERATION_STATUS;
  status: TikTokLaunchStatus;
  current_step: "campaign" | "adgroup" | "ad" | "complete";
  campaign_id: string | null;
  adgroup_id: string | null;
  ad_id: string | null;
  error_step: TikTokLaunchStep | null;
  error_code: TikTokLaunchErrorCode | null;
  started_at: string;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TikTokDisabledLaunchSummary = {
  platform: "tiktok";
  targetOperationStatus: typeof TIKTOK_DISABLED_OPERATION_STATUS;
  status: TikTokLaunchStatus;
  message: string;
  campaignName: string;
  city: string;
  dailyBudgetMinor: string;
  currency: string;
  providerObjects: {
    campaignCreated: boolean;
    adGroupCreated: boolean;
    adCreated: boolean;
  };
  automaticRetryAllowed: false;
  startedAt: string;
  finishedAt: string | null;
};

export class TikTokLaunchError extends TikTokConnectionError {
  constructor(
    status: number,
    public readonly launchCode: TikTokLaunchErrorCode,
    message: string,
    public readonly step?: TikTokLaunchStep,
    public readonly uncertain = false,
  ) {
    super(status, launchCode, message);
    this.name = "TikTokLaunchError";
  }
}

type TikTokProviderFetch = (
  input: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    redirect: "error";
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type TikTokLaunchStore = {
  claim(
    row: TikTokLaunchRow,
  ): Promise<{ claimed: boolean; row: TikTokLaunchRow }>;
  advance(
    row: TikTokLaunchRow,
    expectedStatus: TikTokLaunchStatus,
    patch: Partial<TikTokLaunchRow>,
  ): Promise<TikTokLaunchRow>;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const TIKTOK_API_BASE_URL = "https://business-api.tiktok.com";
const launchFields = [
  "id",
  "workspace_id",
  "advertiser_id",
  "video_upload_id",
  "requested_by_staff_user_id",
  "idempotency_key",
  "campaign_name",
  "service",
  "city",
  "daily_budget_minor",
  "currency",
  "destination_fingerprint",
  "operation_status",
  "status",
  "current_step",
  "campaign_id",
  "adgroup_id",
  "ad_id",
  "error_step",
  "error_code",
  "started_at",
  "finished_at",
  "created_at",
  "updated_at",
].join(",");

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown, maxLength = 512): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function apiCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim()))
    return Number(value);
  return null;
}

function persistenceError(): TikTokLaunchError {
  return new TikTokLaunchError(
    503,
    "persistence_failed",
    "Не удалось сохранить безопасный журнал запуска. Объекты TikTok не создаются повторно автоматически.",
    "persistence",
    true,
  );
}

function serverStore(): TikTokLaunchStore {
  const client = getSupabaseServerClient();
  if (!client) throw persistenceError();
  return {
    async claim(row) {
      const { data, error } = await client
        .from("tiktok_campaign_launches")
        .insert(row)
        .select(launchFields)
        .single();
      if (!error && data)
        return { claimed: true, row: data as unknown as TikTokLaunchRow };
      if (error?.code !== "23505") throw persistenceError();
      const { data: existing, error: readError } = await client
        .from("tiktok_campaign_launches")
        .select(launchFields)
        .eq("workspace_id", row.workspace_id)
        .eq("idempotency_key", row.idempotency_key)
        .maybeSingle();
      if (readError || !existing) throw persistenceError();
      return { claimed: false, row: existing as unknown as TikTokLaunchRow };
    },
    async advance(row, expectedStatus, patch) {
      const { data, error } = await client
        .from("tiktok_campaign_launches")
        .update(patch)
        .eq("workspace_id", row.workspace_id)
        .eq("id", row.id)
        .eq("status", expectedStatus)
        .select(launchFields)
        .maybeSingle();
      if (error || !data) throw persistenceError();
      return data as unknown as TikTokLaunchRow;
    },
  };
}

function summary(row: TikTokLaunchRow): TikTokDisabledLaunchSummary {
  const messages: Record<TikTokLaunchStatus, string> = {
    creating:
      "Запуск уже принят. До проверки Ads Manager повторный запрос заблокирован.",
    campaign_created:
      "Кампания создана выключенной. Завершение запуска требует проверки оператором.",
    adgroup_created:
      "Кампания и группа созданы выключенными. Завершение запуска требует проверки оператором.",
    created_disabled:
      "Реклама создана в TikTok выключенной. Проверьте её в TikTok Ads Manager перед включением.",
    failed:
      "TikTok отклонил запуск. Проверьте настройки и создайте новую попытку после исправления.",
    unknown:
      "TikTok не подтвердил итог. Повторный запрос заблокирован, чтобы не создать дубль; проверьте Ads Manager.",
  };
  return {
    platform: "tiktok",
    targetOperationStatus: TIKTOK_DISABLED_OPERATION_STATUS,
    status: row.status,
    message: messages[row.status],
    campaignName: row.campaign_name,
    city: row.city,
    dailyBudgetMinor: row.daily_budget_minor,
    currency: row.currency,
    providerObjects: {
      campaignCreated: Boolean(row.campaign_id),
      adGroupCreated: Boolean(row.adgroup_id),
      adCreated: Boolean(row.ad_id),
    },
    automaticRetryAllowed: false,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function classifyProviderFailure(
  status: number,
  message: string,
  step: TikTokLaunchStep,
): TikTokLaunchError {
  const lower = message.toLowerCase();
  if (
    status === 401 ||
    /unauthor|access token|invalid token|token.*expir/.test(lower)
  ) {
    return new TikTokLaunchError(
      502,
      "provider_auth",
      "TikTok отклонил подключение. Обновите доступ к рекламному аккаунту.",
      step,
    );
  }
  if (
    status === 403 ||
    /permission|access denied|not authorized|scope/.test(lower)
  ) {
    return new TikTokLaunchError(
      502,
      "provider_permission",
      "TikTok не разрешил создать этот объект. Проверьте права рекламного аккаунта.",
      step,
    );
  }
  if (status === 429 || /rate limit|too many request/.test(lower)) {
    return new TikTokLaunchError(
      502,
      "provider_rate_limited",
      "TikTok временно ограничил запросы. Повторите новой попыткой позже.",
      step,
    );
  }
  if (status >= 500) {
    return new TikTokLaunchError(
      502,
      "provider_response_unknown",
      "TikTok не подтвердил результат. Проверьте Ads Manager перед новой попыткой.",
      step,
      true,
    );
  }
  return new TikTokLaunchError(
    502,
    "provider_rejected",
    "TikTok отклонил параметры рекламы. Проверьте бриф и настройки аккаунта.",
    step,
  );
}

function readProviderId(
  data: Record<string, unknown>,
  step: TikTokLaunchStep,
): string {
  let value = "";
  if (step === "campaign") value = string(data.campaign_id, 128);
  if (step === "adgroup") value = string(data.adgroup_id, 128);
  if (step === "ad") {
    const ids = Array.isArray(data.ad_ids) ? data.ad_ids : [];
    value = ids.length === 1 ? string(ids[0], 128) : string(data.ad_id, 128);
  }
  if (!PROVIDER_ID.test(value)) {
    throw new TikTokLaunchError(
      502,
      "provider_response_unknown",
      "TikTok не подтвердил идентификатор созданного объекта. Проверьте Ads Manager перед новой попыткой.",
      step,
      true,
    );
  }
  return value;
}

export async function createTikTokProviderObject(
  endpoint: string,
  payload: Record<string, unknown>,
  accessToken: string,
  step: TikTokLaunchStep,
  options: { fetchImpl?: TikTokProviderFetch; timeoutMs?: number } = {},
): Promise<string> {
  if (
    ![
      TIKTOK_CAMPAIGN_CREATE_ENDPOINT,
      TIKTOK_ADGROUP_CREATE_ENDPOINT,
      TIKTOK_AD_CREATE_ENDPOINT,
    ].includes(endpoint)
  ) {
    throw new TikTokLaunchError(
      500,
      "invalid_request",
      "Недопустимый этап создания TikTok-рекламы.",
      step,
    );
  }
  const url = new URL(endpoint, TIKTOK_API_BASE_URL);
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    Math.min(20_000, Math.max(1_000, options.timeoutMs ?? 12_000)),
  );
  try {
    const safeFetch =
      options.fetchImpl ?? (fetch as unknown as TikTokProviderFetch);
    const response = await safeFetch(url.toString(), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Access-Token": accessToken,
      },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = record(raw.trim() ? JSON.parse(raw) : null);
    } catch {
      throw new TikTokLaunchError(
        502,
        "provider_response_unknown",
        "TikTok вернул неполный ответ. Проверьте Ads Manager перед новой попыткой.",
        step,
        true,
      );
    }
    const code = apiCode(parsed.code);
    const message = string(parsed.message, 300);
    if (!response.ok || code !== 0) {
      throw classifyProviderFailure(response.status, message, step);
    }
    return readProviderId(record(parsed.data), step);
  } catch (error) {
    if (error instanceof TikTokLaunchError) throw error;
    throw new TikTokLaunchError(
      502,
      timedOut ? "request_timeout" : "provider_response_unknown",
      timedOut
        ? "TikTok не ответил вовремя. Проверьте Ads Manager перед новой попыткой."
        : "TikTok не подтвердил результат. Проверьте Ads Manager перед новой попыткой.",
      step,
      true,
    );
  } finally {
    clearTimeout(timeout);
  }
}

type VerifiedSetupContext = {
  locationIds: string[];
  identityConfigured: boolean;
  identityType?: TikTokIdentityType;
};

type TikTokLaunchServiceOptions = {
  env?: Env;
  store?: TikTokLaunchStore;
  now?: () => number;
  readConnection?: (workspaceId: string) => Promise<TikTokConnectionSummary>;
  validateConnection?: (env: Env) => Promise<TikTokAdsConnectionDiagnostic>;
  verifySetup?: (
    workspaceId: string,
    city: string,
    forceProvider?: boolean,
  ) => Promise<TikTokSetupSummary>;
  readSetup?: (workspaceId: string, city: string) => VerifiedSetupContext;
  checkVideo?: (
    workspaceId: string,
    assetId: string,
  ) => Promise<TikTokVideoSummary>;
  resolveVideo?: (
    workspaceId: string,
    assetId: string,
  ) => Promise<TikTokReadyVideoForLaunch>;
  createObject?: (
    step: TikTokLaunchStep,
    endpoint: string,
    payload: Record<string, unknown>,
  ) => Promise<string>;
};

function terminalPatch(
  row: TikTokLaunchRow,
  error: TikTokLaunchError,
  finishedAt: string,
): Partial<TikTokLaunchRow> {
  return {
    status: error.uncertain ? "unknown" : "failed",
    current_step: row.current_step,
    error_step: error.step || "persistence",
    error_code:
      error.launchCode === "request_timeout"
        ? "request_timeout"
        : error.launchCode === "provider_response_unknown"
          ? "provider_response_unknown"
          : error.launchCode === "provider_auth"
            ? "provider_auth"
            : error.launchCode === "provider_permission"
              ? "provider_permission"
              : error.launchCode === "provider_rate_limited"
                ? "provider_rate_limited"
                : error.launchCode === "connection_revoked"
                  ? "connection_revoked"
                  : error.launchCode === "persistence_failed"
                    ? "persistence_failed"
                    : "provider_rejected",
    finished_at: finishedAt,
    updated_at: finishedAt,
  };
}

export function createTikTokDisabledLaunchService(
  options: TikTokLaunchServiceOptions = {},
) {
  const env = () => options.env ?? process.env;
  const now = options.now ?? Date.now;

  async function launch(
    workspaceId: string,
    staffUserId: string,
    value: unknown,
  ): Promise<TikTokDisabledLaunchSummary> {
    const settings = env();
    if (settings.TIKTOK_DISABLED_LAUNCH_ENABLED !== "true") {
      throw new TikTokLaunchError(
        409,
        "launch_disabled",
        "Создание TikTok-рекламы пока отключено оператором.",
      );
    }
    requireTikTokProvisionedWorkspace(workspaceId, settings);

    const input = record(value);
    if (
      input.confirm !== true ||
      string(input.confirmationPhrase, 32) !== "СОЗДАТЬ"
    ) {
      throw new TikTokLaunchError(
        400,
        "confirmation_required",
        "Введите «СОЗДАТЬ», чтобы создать рекламу выключенной.",
      );
    }
    const idempotencyKey = string(input.idempotencyKey, 64);
    const videoAssetId = string(input.videoAssetId, 64);
    if (
      !UUID.test(idempotencyKey) ||
      !UUID.test(videoAssetId) ||
      !UUID.test(staffUserId)
    ) {
      throw new TikTokLaunchError(
        400,
        "invalid_request",
        "Проверьте выбранное видео и повторите подготовку запуска.",
      );
    }

    const initial = buildTikTokCampaignDryRun(input, {
      advertiserConfigured: true,
      identityConfigured: true,
      identityType: "CUSTOMIZED_USER",
      locationIds: ["100"],
      uploadedVideoIdAvailable: true,
      videoReadyForAd: true,
      launchFeatureEnabled: true,
    });
    if (!initial.readiness.briefReady) {
      throw new TikTokCampaignValidationError(
        initial.readiness.blockers.filter(
          (issue) =>
            ![
              "advertiser_not_configured",
              "identity_not_configured",
              "location_not_resolved",
              "video_upload_required",
              "video_not_ready",
              "identity_type_unsupported",
              "live_adapter_disabled",
            ].includes(issue.code),
        ),
      );
    }

    const connection = await (options.readConnection ?? readTikTokConnection)(
      workspaceId,
    );
    if (connection.state !== "connected") {
      throw new TikTokLaunchError(
        409,
        "connection_revoked",
        "Сначала заново подтвердите подключение TikTok.",
      );
    }
    const expectedCurrency = initial.summary.currency as TikTokCurrency;
    if (!connection.currency || connection.currency !== expectedCurrency) {
      throw new TikTokLaunchError(
        400,
        "currency_mismatch",
        `Бюджет должен быть указан в валюте рекламного аккаунта: ${connection.currency || "не определена"}.`,
      );
    }

    const config = getTikTokAdsConfig(settings);
    const diagnostic = await (
      options.validateConnection ??
      ((runtimeEnv) => validateTikTokAdsConnection({ env: runtimeEnv }))
    )(settings);
    if (!config.configured || !diagnostic.connected) {
      throw new TikTokLaunchError(
        502,
        "connection_revoked",
        "TikTok не подтвердил доступ к рекламному аккаунту.",
      );
    }

    const city = initial.summary.city;
    const setup = await (options.verifySetup ?? verifyTikTokSetup)(
      workspaceId,
      city,
      true,
    );
    const setupContext = (options.readSetup ?? readTikTokVerifiedSetup)(
      workspaceId,
      city,
    );
    if (
      setup.city.status !== "verified" ||
      setup.identity.status !== "verified" ||
      !setupContext.identityConfigured ||
      setupContext.locationIds.length === 0
    ) {
      throw new TikTokLaunchError(
        409,
        "setup_required",
        "Заново проверьте город и рекламный профиль TikTok.",
      );
    }
    const identityType =
      string(settings.TIKTOK_IDENTITY_TYPE, 32) || "CUSTOMIZED_USER";
    if (
      identityType !== "CUSTOMIZED_USER" ||
      setupContext.identityType !== "CUSTOMIZED_USER"
    ) {
      throw new TikTokLaunchError(
        409,
        "setup_required",
        "Для первого запуска нужен профиль TikTok типа CUSTOMIZED_USER.",
      );
    }
    const identityId = string(settings.TIKTOK_IDENTITY_ID, 128);

    const videoStatus = await (
      options.checkVideo ?? tikTokVideos.checkReadiness
    )(workspaceId, videoAssetId);
    if (!videoStatus.readyForAd) {
      throw new TikTokLaunchError(
        409,
        "video_not_ready",
        "Дождитесь обработки видео и подтвердите его готовность в TikTok.",
      );
    }
    const video = await (
      options.resolveVideo ?? tikTokVideos.resolveReadyForLaunch
    )(workspaceId, videoAssetId);
    const payloads = buildTikTokDisabledLaunchPayloads(input, {
      advertiserId: config.advertiserId,
      identityId,
      locationIds: setupContext.locationIds,
      videoId: video.videoId,
      idempotencyKey,
    });

    const startedAt = new Date(now()).toISOString();
    const baseRow: TikTokLaunchRow = {
      id: randomUUID(),
      workspace_id: workspaceId,
      advertiser_id: config.advertiserId,
      video_upload_id: video.receiptId,
      requested_by_staff_user_id: staffUserId,
      idempotency_key: idempotencyKey,
      campaign_name: payloads.campaignName,
      service: payloads.service,
      city: payloads.city,
      daily_budget_minor: payloads.dailyBudgetMinor,
      currency: payloads.currency,
      destination_fingerprint: createHash("sha256")
        .update(payloads.destinationUrl)
        .digest("hex"),
      operation_status: TIKTOK_DISABLED_OPERATION_STATUS,
      status: "creating",
      current_step: "campaign",
      campaign_id: null,
      adgroup_id: null,
      ad_id: null,
      error_step: null,
      error_code: null,
      started_at: startedAt,
      finished_at: null,
      created_at: startedAt,
      updated_at: startedAt,
    };
    const repository = options.store ?? serverStore();
    const claim = await repository.claim(baseRow);
    if (!claim.claimed) return summary(claim.row);
    let row = claim.row;
    const createObject =
      options.createObject ??
      ((
        step: TikTokLaunchStep,
        endpoint: string,
        payload: Record<string, unknown>,
      ) =>
        createTikTokProviderObject(
          endpoint,
          payload,
          config.accessToken,
          step,
        ));

    try {
      const campaignId = await createObject(
        "campaign",
        TIKTOK_CAMPAIGN_CREATE_ENDPOINT,
        payloads.campaign,
      );
      const campaignAt = new Date(now()).toISOString();
      row = await repository.advance(row, "creating", {
        status: "campaign_created",
        current_step: "adgroup",
        campaign_id: campaignId,
        updated_at: campaignAt,
      });

      const adGroupId = await createObject(
        "adgroup",
        TIKTOK_ADGROUP_CREATE_ENDPOINT,
        {
          ...payloads.adGroup,
          campaign_id: campaignId,
        },
      );
      const adGroupAt = new Date(now()).toISOString();
      row = await repository.advance(row, "campaign_created", {
        status: "adgroup_created",
        current_step: "ad",
        adgroup_id: adGroupId,
        updated_at: adGroupAt,
      });

      const adId = await createObject("ad", TIKTOK_AD_CREATE_ENDPOINT, {
        ...payloads.ad,
        adgroup_id: adGroupId,
      });
      const finishedAt = new Date(now()).toISOString();
      row = await repository.advance(row, "adgroup_created", {
        status: "created_disabled",
        current_step: "complete",
        ad_id: adId,
        finished_at: finishedAt,
        updated_at: finishedAt,
      });
      return summary(row);
    } catch (error) {
      const safe =
        error instanceof TikTokLaunchError ? error : persistenceError();
      if (safe.launchCode === "persistence_failed") throw safe;
      const finishedAt = new Date(now()).toISOString();
      try {
        await repository.advance(
          row,
          row.status,
          terminalPatch(row, safe, finishedAt),
        );
      } catch {
        throw persistenceError();
      }
      throw safe;
    }
  }

  return { launch };
}

const service = createTikTokDisabledLaunchService();
export const launchTikTokCampaignDisabled = service.launch;

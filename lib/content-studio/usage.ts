import type { SupabaseClient } from "@supabase/supabase-js";
import { planOf, type PlanKey } from "../billing/plans";
import { getSupabaseServerClient } from "../supabase/server";
import type { VideoRequestLifetime } from "./video-request-lifetime";

export type ContentGenerationKind = "text_request" | "image" | "video_seconds";
export type ContentGenerationOperation =
  | "content_package"
  | "ad_text_improvement"
  | "video_script"
  | "avatar_prompt"
  | "tapnow_prompt"
  | "generated_image"
  | "generated_video";
export type ContentGenerationCompletion = "succeeded" | "failed" | "unknown";
export type ContentGenerationErrorCode =
  | "provider_rejected"
  | "provider_unavailable"
  | "storage_failed"
  | "request_unknown";

type UsageRow = {
  kind?: unknown;
  units?: unknown;
  status?: unknown;
};

type ReservationRow = {
  allowed?: unknown;
  duplicate?: unknown;
  usage_id?: unknown;
  used_units?: unknown;
  limit_units?: unknown;
  remaining_units?: unknown;
  period_start?: unknown;
};

export type ContentUsageCounter = {
  used: number;
  limit: number | null;
  remaining: number | null;
  enabled: boolean;
};

export type ContentUsageSummary = {
  trackingAvailable: boolean;
  subscriptionActive: boolean;
  plan: PlanKey | null;
  planTitle: string;
  periodStart: string;
  textRequests: number;
  images: ContentUsageCounter;
  videoSeconds: ContentUsageCounter;
  warning?: string;
};

export type ContentUsageReservation = {
  allowed: boolean;
  tracked: boolean;
  duplicate: boolean;
  usageId: string;
  kind: ContentGenerationKind;
  used: number;
  limit: number | null;
  remaining: number | null;
  periodStart: string;
  reason?: "quota_exceeded" | "subscription_required" | "duplicate_request";
  warning?: string;
};

const COUNTED_STATUSES = new Set(["reserved", "succeeded", "unknown"]);
const MEDIA_TRACKING_REQUIRED_MESSAGE =
  "Учёт лимитов генерации не подключён. Фото и видео не запущены, чтобы не списывать средства без квитанции.";

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readNonNegativeInteger(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : 0;
  }
  return 0;
}

function reservationInteger(value: unknown): number | null {
  const candidate = typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : value;
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null;
}

function verifiedReservation(data: unknown, limit: number | null, units: number) {
  const refuse = (): never => { throw new Error("Не удалось подтвердить квитанцию лимита генерации. Генерация не запущена."); };
  if (Array.isArray(data) && data.length !== 1) return refuse();
  const row = readRecord(Array.isArray(data) ? data[0] : data) as ReservationRow;
  if (typeof row.allowed !== "boolean" || typeof row.duplicate !== "boolean" || (row.allowed && row.duplicate)) return refuse();
  const used = reservationInteger(row.used_units);
  const returnedLimit = row.limit_units === null ? null : reservationInteger(row.limit_units);
  const remaining = row.remaining_units === null ? null : reservationInteger(row.remaining_units);
  if (used === null || returnedLimit !== limit || (row.limit_units !== null && returnedLimit === null)
    || (limit === null ? row.remaining_units !== null : remaining !== Math.max(0, limit - used))) return refuse();
  const periodStart = readString(row.period_start);
  if (!/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-01$/.test(periodStart)) return refuse();
  const usageId = readString(row.usage_id);
  if (row.allowed || row.duplicate) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(usageId)) return refuse();
  } else if (row.usage_id !== null) return refuse();
  if (!Number.isSafeInteger(units) || units <= 0
    || (row.allowed && (used < units || (limit !== null && used > limit)))
    || (!row.allowed && !row.duplicate && (limit === null || used + units <= limit))) return refuse();
  return { allowed: row.allowed, duplicate: row.duplicate, usageId, used, limit, remaining, periodStart };
}

function currentPeriodStart(now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

function isMissingUsageFoundation(error: unknown): boolean {
  const record = readRecord(error);
  const code = readString(record.code);
  const message = readString(record.message).toLowerCase();
  return (
    code === "PGRST202" ||
    code === "PGRST205" ||
    code === "42P01" ||
    code === "42883" ||
    message.includes("content_generation_usage") ||
    message.includes("reserve_content_generation_usage") ||
    message.includes("complete_content_generation_usage")
  );
}

/**
 * Provider seconds are billable even when the UI does not receive the finished
 * file. A missing explicit value uses the provider's conservative MVP unit.
 */
export function billableVideoSeconds(value: unknown): number {
  const raw = readString(value);
  if (!/^\d+$/.test(raw)) return 8;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 60 ? parsed : 8;
}

export function quotaForPlan(plan: PlanKey | null, kind: ContentGenerationKind): number | null {
  if (kind === "text_request") return null;
  const definition = plan ? planOf(plan) : null;
  if (!definition) return 0;
  return kind === "image" ? definition.limits.images : definition.limits.videoSeconds;
}

export function summarizeUsageRows(rows: UsageRow[]): Record<ContentGenerationKind, number> {
  const totals: Record<ContentGenerationKind, number> = {
    text_request: 0,
    image: 0,
    video_seconds: 0,
  };
  for (const row of rows) {
    const kind = readString(row.kind);
    const status = readString(row.status);
    if (!(kind in totals) || !COUNTED_STATUSES.has(status)) continue;
    totals[kind as ContentGenerationKind] += readNonNegativeInteger(row.units);
  }
  return totals;
}

async function activePlan(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<{ plan: PlanKey | null; error: unknown | null }> {
  try {
    const { data, error } = await supabase
      .from("platform_subscriptions")
      .select("plan")
      .eq("workspace_id", workspaceId)
      .eq("status", "active")
      .order("started_at", { ascending: false })
      .limit(1);
    if (error) return { plan: null, error };
    const row = Array.isArray(data) && data.length > 0 ? readRecord(data[0]) : {};
    const candidate = readString(row.plan);
    return { plan: planOf(candidate)?.key ?? null, error: null };
  } catch (error) {
    return { plan: null, error };
  }
}

function counter(used: number, limit: number | null): ContentUsageCounter {
  return {
    used,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - used),
    enabled: limit === null || limit > 0,
  };
}

function unavailableSummary(warning: string): ContentUsageSummary {
  return {
    trackingAvailable: false,
    subscriptionActive: false,
    plan: null,
    planTitle: "Тариф не определён",
    periodStart: currentPeriodStart(),
    textRequests: 0,
    images: counter(0, null),
    videoSeconds: counter(0, null),
    warning,
  };
}

export async function getContentUsageSummary(workspaceId: string): Promise<ContentUsageSummary> {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return unavailableSummary("Учёт генераций временно недоступен.");
  }

  const planResult = await activePlan(supabase, workspaceId);
  if (planResult.error) {
    return unavailableSummary("Не удалось проверить тариф рабочего пространства.");
  }

  const periodStart = currentPeriodStart();
  let data: unknown = null;
  let usageError: unknown = null;
  try {
    const result = await supabase
      .from("content_generation_usage")
      .select("kind, units, status")
      .eq("workspace_id", workspaceId)
      .eq("period_start", periodStart);
    data = result.data;
    usageError = result.error;
  } catch (error) {
    usageError = error;
  }

  const plan = planResult.plan;
  const imageLimit = quotaForPlan(plan, "image");
  const videoLimit = quotaForPlan(plan, "video_seconds");
  const title = plan ? planOf(plan)?.title ?? plan : "Тариф не назначен";

  if (usageError && isMissingUsageFoundation(usageError)) {
    return {
      trackingAvailable: false,
      subscriptionActive: Boolean(plan),
      plan,
      planTitle: title,
      periodStart,
      textRequests: 0,
      images: counter(0, imageLimit),
      videoSeconds: counter(0, videoLimit),
      warning: "Учёт лимитов ещё не подключён.",
    };
  }
  if (usageError) {
    return {
      ...unavailableSummary("Не удалось загрузить использование генерации."),
      subscriptionActive: Boolean(plan),
      plan,
      planTitle: title,
      images: counter(0, imageLimit),
      videoSeconds: counter(0, videoLimit),
    };
  }

  const totals = summarizeUsageRows(Array.isArray(data) ? data : []);
  return {
    trackingAvailable: true,
    subscriptionActive: Boolean(plan),
    plan,
    planTitle: title,
    periodStart,
    textRequests: totals.text_request,
    images: counter(totals.image, imageLimit),
    videoSeconds: counter(totals.video_seconds, videoLimit),
  };
}

export async function reserveContentGeneration(input: {
  workspaceId: string;
  staffUserId: string;
  requestKey: string;
  operation: ContentGenerationOperation;
  kind: ContentGenerationKind;
  units: number;
  provider?: string;
  model?: string;
  requestLifetime?: VideoRequestLifetime;
}): Promise<ContentUsageReservation> {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    if (input.kind !== "text_request") throw new Error(MEDIA_TRACKING_REQUIRED_MESSAGE);
    return {
      allowed: true,
      tracked: false,
      duplicate: false,
      usageId: "",
      kind: input.kind,
      used: 0,
      limit: null,
      remaining: null,
      periodStart: currentPeriodStart(),
      warning: "Учёт генераций временно недоступен.",
    };
  }

  const readPlan = () => activePlan(supabase, input.workspaceId);
  const planResult = await (input.requestLifetime ? input.requestLifetime.run(readPlan) : readPlan());
  if (planResult.error) {
    throw new Error("Не удалось безопасно проверить тариф перед генерацией.");
  }

  const limit = quotaForPlan(planResult.plan, input.kind);
  const reserve = () => supabase.rpc("reserve_content_generation_usage", {
    p_workspace_id: input.workspaceId,
    p_staff_user_id: input.staffUserId,
    p_request_key: input.requestKey,
    p_operation: input.operation,
    p_kind: input.kind,
    p_units: input.units,
    p_limit_units: limit,
    p_provider: input.provider || null,
    p_model: input.model || null,
  });
  const { data, error } = await (input.requestLifetime ? input.requestLifetime.run(reserve) : reserve());

  if (error && isMissingUsageFoundation(error)) {
    // Text helpers have no artificial quota yet and keep their compatibility
    // mode. Media calls are billable units, so code-before-migration must stop
    // before the provider instead of silently spending outside the ledger.
    if (input.kind !== "text_request") throw new Error(MEDIA_TRACKING_REQUIRED_MESSAGE);
    return {
      allowed: true,
      tracked: false,
      duplicate: false,
      usageId: "",
      kind: input.kind,
      used: 0,
      limit,
      remaining: limit,
      periodStart: currentPeriodStart(),
      warning: "Учёт лимитов ещё не подключён.",
    };
  }
  if (error) {
    // A database outage must fail closed for a paid provider call. Otherwise a
    // quota incident would be most expensive exactly while accounting is down.
    throw new Error("Не удалось зарезервировать лимит генерации. Попробуйте позже.");
  }

  // An HTTP-successful RPC is not proof of a reservation without a valid
  // receipt and consistent counters. Never call a paid provider on ambiguity.
  const verified = verifiedReservation(data, limit, input.units);
  const { duplicate, allowed } = verified;
  const needsSubscription = input.kind !== "text_request" && !planResult.plan;
  return {
    allowed,
    tracked: true,
    duplicate,
    usageId: verified.usageId,
    kind: input.kind,
    used: verified.used,
    limit: verified.limit,
    remaining: verified.remaining,
    periodStart: verified.periodStart,
    ...(!allowed
      ? {
          reason: duplicate
            ? "duplicate_request" as const
            : needsSubscription
              ? "subscription_required" as const
              : "quota_exceeded" as const,
        }
      : {}),
  };
}

export async function completeContentGeneration(input: {
  workspaceId: string;
  reservation: ContentUsageReservation | null;
  status: ContentGenerationCompletion;
  errorCode?: ContentGenerationErrorCode;
  provider?: string;
  model?: string;
}): Promise<void> {
  if (!input.reservation?.tracked || !input.reservation.usageId) return;
  const supabase = getSupabaseServerClient();
  if (!supabase) return;
  try {
    const { error } = await supabase.rpc("complete_content_generation_usage", {
      p_workspace_id: input.workspaceId,
      p_usage_id: input.reservation.usageId,
      p_status: input.status,
      p_error_code: input.errorCode || null,
      p_provider: input.provider || null,
      p_model: input.model || null,
    });
    // Completion accounting must never erase a paid result. A reservation stays
    // conservative and still consumes quota if this best-effort update fails.
    if (!error || isMissingUsageFoundation(error)) return;
  } catch {
    // Logged below using identifiers only; never include provider or DB errors.
  }
  console.error("Content generation usage completion failed", {
    workspaceId: input.workspaceId,
    usageId: input.reservation.usageId,
  });
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { planOf, type PlanKey } from "../billing/plans";
import { getSupabaseServerClient } from "../supabase/server";

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

function readNullableInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : readNonNegativeInteger(value);
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
}): Promise<ContentUsageReservation> {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
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

  const planResult = await activePlan(supabase, input.workspaceId);
  if (planResult.error) {
    throw new Error("Не удалось безопасно проверить тариф перед генерацией.");
  }

  const limit = quotaForPlan(planResult.plan, input.kind);
  const { data, error } = await supabase.rpc("reserve_content_generation_usage", {
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

  if (error && isMissingUsageFoundation(error)) {
    // Deploy-before-migration compatibility: the working generation flow is
    // preserved, while the UI clearly says accounting is not active yet.
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

  const raw = Array.isArray(data) ? data[0] : data;
  const row = readRecord(raw) as ReservationRow;
  const duplicate = row.duplicate === true;
  const allowed = row.allowed === true;
  const needsSubscription = input.kind !== "text_request" && !planResult.plan;
  return {
    allowed,
    tracked: true,
    duplicate,
    usageId: readString(row.usage_id),
    kind: input.kind,
    used: readNonNegativeInteger(row.used_units),
    limit: readNullableInteger(row.limit_units),
    remaining: readNullableInteger(row.remaining_units),
    periodStart: readString(row.period_start) || currentPeriodStart(),
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

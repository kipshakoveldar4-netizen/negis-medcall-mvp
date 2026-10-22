export type GenerationUsageCounter = {
  used: number;
  limit: number | null;
  remaining: number | null;
  enabled: boolean;
};

export type GenerationUsageSummary = {
  trackingAvailable: boolean;
  subscriptionActive: boolean;
  plan: "basic" | "standard" | "pro" | null;
  planTitle: string;
  periodStart: string;
  textRequests: number;
  images: GenerationUsageCounter;
  videoSeconds: GenerationUsageCounter;
  videoSecondsPerGeneration: number;
  warning?: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function counter(value: unknown): GenerationUsageCounter | null {
  const row = record(value);
  if (!row || !integer(row.used) || (row.limit !== null && !integer(row.limit)) || typeof row.enabled !== "boolean") return null;
  if (row.enabled !== (row.limit === null || row.limit > 0)) return null;
  if (row.limit === null ? row.remaining !== null : !integer(row.remaining) || row.remaining !== Math.max(0, row.limit - row.used)) return null;
  return { used: row.used, limit: row.limit, remaining: row.remaining as number | null, enabled: row.enabled };
}

export function parseGenerationUsageSummary(value: unknown): GenerationUsageSummary | null {
  const row = record(value);
  if (!row || typeof row.trackingAvailable !== "boolean" || typeof row.subscriptionActive !== "boolean"
    || (row.plan !== null && !["basic", "standard", "pro"].includes(row.plan as string))
    || row.subscriptionActive !== (row.plan !== null)
    || typeof row.planTitle !== "string" || !row.planTitle.trim() || row.planTitle.length > 160
    || typeof row.periodStart !== "string" || !/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-01$/.test(row.periodStart)
    || !integer(row.textRequests) || !integer(row.videoSecondsPerGeneration)
    || row.videoSecondsPerGeneration < 1 || row.videoSecondsPerGeneration > 60
    || (row.warning !== undefined && (typeof row.warning !== "string" || row.warning.length > 2000))) return null;
  const images = counter(row.images), videoSeconds = counter(row.videoSeconds);
  if (!images || !videoSeconds || (row.trackingAvailable && (images.limit === null || videoSeconds.limit === null))) return null;
  return {
    trackingAvailable: row.trackingAvailable, subscriptionActive: row.subscriptionActive,
    plan: row.plan as GenerationUsageSummary["plan"], planTitle: row.planTitle,
    periodStart: row.periodStart, textRequests: row.textRequests,
    images, videoSeconds, videoSecondsPerGeneration: row.videoSecondsPerGeneration,
    ...(row.warning !== undefined ? { warning: row.warning as string } : {}),
  };
}

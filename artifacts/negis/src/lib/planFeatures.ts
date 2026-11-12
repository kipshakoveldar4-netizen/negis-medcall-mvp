export type NegisPlan = "demo" | "basic" | "standard" | "pro";

export type PlanFeature =
  | "image_ads_launch"
  | "video_ads_launch"
  | "ai_creative_analysis"
  | "meta_live_launch"
  | "active_launch"
  | "launch_history";

type PlanFeatureConfig = {
  enabled: boolean;
  badge?: string;
  note?: string;
};

const planMatrix: Record<NegisPlan, Record<PlanFeature, PlanFeatureConfig>> = {
  demo: {
    image_ads_launch: { enabled: true, badge: "Demo" },
    video_ads_launch: { enabled: false, badge: "Standard+", note: "Видео-запуск доступен на Standard+" },
    ai_creative_analysis: { enabled: false, badge: "Standard+", note: "Расширенный анализ доступен на Standard+" },
    meta_live_launch: { enabled: false, badge: "Pro", note: "Реальный запуск включается администратором" },
    active_launch: { enabled: false, badge: "Pro", note: "ACTIVE запуск доступен на Pro" },
    launch_history: { enabled: true, badge: "Demo" },
  },
  basic: {
    image_ads_launch: { enabled: true, badge: "Basic" },
    video_ads_launch: { enabled: false, badge: "Standard+", note: "Видео-запуск доступен на Standard+" },
    ai_creative_analysis: { enabled: false, badge: "Standard+", note: "Расширенный анализ доступен на Standard+" },
    meta_live_launch: { enabled: true, badge: "Basic" },
    active_launch: { enabled: false, badge: "Pro", note: "ACTIVE запуск доступен на Pro" },
    launch_history: { enabled: true, badge: "Basic" },
  },
  standard: {
    image_ads_launch: { enabled: true, badge: "Standard" },
    video_ads_launch: { enabled: true, badge: "Standard" },
    ai_creative_analysis: { enabled: true, badge: "Standard" },
    meta_live_launch: { enabled: true, badge: "Standard" },
    active_launch: { enabled: false, badge: "Pro", note: "ACTIVE запуск доступен на Pro" },
    launch_history: { enabled: true, badge: "Standard" },
  },
  pro: {
    image_ads_launch: { enabled: true, badge: "Pro" },
    video_ads_launch: { enabled: true, badge: "Pro" },
    ai_creative_analysis: { enabled: true, badge: "Pro" },
    meta_live_launch: { enabled: true, badge: "Pro" },
    active_launch: { enabled: true, badge: "Pro" },
    launch_history: { enabled: true, badge: "Pro" },
  },
};

export function normalizePlan(value: unknown): NegisPlan {
  if (value === "basic" || value === "standard" || value === "pro") return value;
  return "demo";
}

export function getPlanFeature(plan: NegisPlan, feature: PlanFeature): PlanFeatureConfig {
  return planMatrix[plan][feature];
}

export function planFeatureBadge(plan: NegisPlan, feature: PlanFeature): string {
  return getPlanFeature(plan, feature).badge || plan;
}

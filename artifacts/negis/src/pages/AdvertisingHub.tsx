import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Bot,
  CheckCircle2,
  Clapperboard,
  Clock3,
  FlaskConical,
  History,
  Megaphone,
  MousePointerClick,
  RefreshCw,
  Rocket,
  Target,
  Upload,
  WalletCards,
} from "lucide-react";
import { PageLayout } from "@/components/layout/PageLayout";
import { PageHeader } from "@/components/ui/page-header";
import { MetricCard } from "@/components/ui/metric-card";
import { useAuth } from "@/contexts/AuthContext";
import { crmFetch } from "@/lib/api";
import { isRealWorkspace, readDemoStorage, readWorkspaceId, workspaceScopedKey } from "@/lib/demoStorage";
import { getSupabaseAccessToken } from "@/lib/serverAuth";
import {
  ADVERTISING_CAMPAIGN_PREFILL_KEY,
  ADVERTISING_CONTENT_STUDIO_PREFILL_KEY,
  createAdvertisingCampaignPrefill,
} from "../../../../lib/advertising/campaignBrief";
import { KZ_META_CITY_OPTIONS } from "../../../../lib/meta/cities";

type LoadState = "loading" | "ready" | "error";
type LaunchState = "paused" | "active" | "failed" | "dry_run" | "video_processing" | "unknown";
type InsightsAccess = "idle" | "checking" | "ready" | "required" | "forbidden" | "error";
type InsightsAvailability = "available" | "not_synced" | "empty" | "running" | "failed" | "unavailable";

type AdvertisingLaunch = {
  id: string;
  campaignName: string;
  status: string;
  metaStatus: string;
  metaCampaignId: string;
  budgetDailyMinor: number | null;
  currency: string;
  lastError: string;
  createdAt: string;
};

type LaunchesResponse = {
  success?: boolean;
  mode?: string;
  data?: {
    launches?: unknown;
    items?: unknown;
  };
};

type ApiEnvelope<T> = {
  success?: boolean;
  mode?: string;
  data?: T;
  error?: string;
  details?: string[];
};

type ServerAdminAuthContext = {
  workspaceId?: string;
  role?: string;
  isAdmin?: boolean;
};

type MetaInsightsHistorySummary = {
  metaCampaignLaunchId: string;
  availability: InsightsAvailability;
  coveredDateStart: string | null;
  coveredDateStop: string | null;
  latestFetchedAt: string | null;
  rowCount: number;
  spendByCurrency: Array<{
    currency: string;
    currencyExponent: number;
    spendMinor: string;
  }>;
  impressions: string;
  clicks: string;
  inlineLinkClicks: string;
  metaLeads: string | null;
};

type AdvertisingInsightsAggregate = {
  campaignsWithData: number;
  spendByCurrency: Array<{
    currency: string;
    currencyExponent: number;
    spendMinor: bigint;
  }>;
  impressions: bigint;
  clicks: bigint;
  inlineLinkClicks: bigint;
  metaLeads: bigint;
  hasMetaLeads: boolean;
  coveredDateStart: string | null;
  coveredDateStop: string | null;
  latestFetchedAt: string | null;
};

type CampaignGoalForm = {
  service: string;
  cityId: string;
  targetPatients: string;
  durationDays: string;
  maxBudget: string;
};

type CampaignGoalDestination = "/ads-automation" | "/content-studio";

const defaultCampaignGoal: CampaignGoalForm = {
  service: "",
  cityId: "astana",
  targetPatients: "",
  durationDays: "14",
  maxBudget: "",
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

async function readJson<T>(response: Response): Promise<ApiEnvelope<T>> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as ApiEnvelope<T>;
  } catch {
    return {};
  }
}

function readNonNegativeBigInt(value: string | null | undefined): bigint {
  const normalized = (value || "").trim();
  if (!/^\d+$/.test(normalized)) return 0n;
  try {
    return BigInt(normalized);
  } catch {
    return 0n;
  }
}

function formatCount(value: bigint): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value);
}

function formatMinorAmount(value: bigint, currencyExponent: number, currency: string): string {
  if (!Number.isInteger(currencyExponent) || currencyExponent < 0 || currencyExponent > 6) return "Нет данных";
  const divisor = 10n ** BigInt(currencyExponent);
  const whole = value / divisor;
  const fraction = currencyExponent > 0
    ? (value % divisor).toString().padStart(currencyExponent, "0").replace(/0+$/, "")
    : "";
  const amount = `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(whole)}${fraction ? `,${fraction}` : ""}`;
  return `${amount} ${currency}`;
}

function formatInsightsDateRange(dateStart: string | null, dateStop: string | null): string {
  if (!dateStart || !dateStop) return "Период не указан";
  const start = new Date(`${dateStart}T00:00:00`);
  const stop = new Date(`${dateStop}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(stop.getTime())) return "Период не указан";
  const formatter = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" });
  return dateStart === dateStop ? formatter.format(start) : `${formatter.format(start)} - ${formatter.format(stop)}`;
}

function formatInsightsUpdate(value: string | null): string {
  if (!value) return "Время обновления не указано";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Время обновления не указано";
  return `Обновлено ${new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)}`;
}

function aggregateAdvertisingInsights(summaries: MetaInsightsHistorySummary[]): AdvertisingInsightsAggregate {
  const available = summaries.filter((summary) => summary.availability === "available" && summary.rowCount > 0);
  const spend = new Map<string, { currency: string; currencyExponent: number; spendMinor: bigint }>();
  let impressions = 0n;
  let clicks = 0n;
  let inlineLinkClicks = 0n;
  let metaLeads = 0n;
  let hasMetaLeads = false;
  let coveredDateStart: string | null = null;
  let coveredDateStop: string | null = null;
  let latestFetchedAt: string | null = null;
  let latestFetchedTime = Number.NEGATIVE_INFINITY;

  for (const summary of available) {
    impressions += readNonNegativeBigInt(summary.impressions);
    clicks += readNonNegativeBigInt(summary.clicks);
    inlineLinkClicks += readNonNegativeBigInt(summary.inlineLinkClicks);
    if (summary.metaLeads !== null) {
      metaLeads += readNonNegativeBigInt(summary.metaLeads);
      hasMetaLeads = true;
    }
    if (summary.coveredDateStart && (!coveredDateStart || summary.coveredDateStart < coveredDateStart)) {
      coveredDateStart = summary.coveredDateStart;
    }
    if (summary.coveredDateStop && (!coveredDateStop || summary.coveredDateStop > coveredDateStop)) {
      coveredDateStop = summary.coveredDateStop;
    }
    const fetchedTime = Date.parse(summary.latestFetchedAt || "");
    if (Number.isFinite(fetchedTime) && fetchedTime > latestFetchedTime) {
      latestFetchedTime = fetchedTime;
      latestFetchedAt = summary.latestFetchedAt;
    }
    for (const item of summary.spendByCurrency) {
      const currency = item.currency.trim().toUpperCase();
      if (!currency || !Number.isInteger(item.currencyExponent)) continue;
      const key = `${currency}:${item.currencyExponent}`;
      const current = spend.get(key);
      spend.set(key, {
        currency,
        currencyExponent: item.currencyExponent,
        spendMinor: (current?.spendMinor || 0n) + readNonNegativeBigInt(item.spendMinor),
      });
    }
  }

  return {
    campaignsWithData: available.length,
    spendByCurrency: [...spend.values()].sort((left, right) => left.currency.localeCompare(right.currency)),
    impressions,
    clicks,
    inlineLinkClicks,
    metaLeads,
    hasMetaLeads,
    coveredDateStart,
    coveredDateStop,
    latestFetchedAt,
  };
}

function normalizeLaunch(value: unknown): AdvertisingLaunch {
  const row = asRecord(value);
  return {
    id: readString(row.id),
    campaignName: readString(row.campaignName ?? row.campaign_name) || "Рекламная кампания",
    status: readString(row.status),
    metaStatus: readString(row.metaStatus ?? row.meta_status),
    metaCampaignId: readString(row.metaCampaignId ?? row.meta_campaign_id),
    budgetDailyMinor: readNullableNumber(row.budgetDailyMinor ?? row.budget_daily_minor),
    currency: readString(row.currency) || "USD",
    lastError: readString(row.lastError ?? row.last_error),
    createdAt: readString(row.createdAt ?? row.created_at),
  };
}

function isDryRunId(value: string): boolean {
  return value.toLowerCase().startsWith("dryrun_");
}

function launchState(launch: AdvertisingLaunch): LaunchState {
  const status = launch.status.toLowerCase();
  const metaStatus = launch.metaStatus.toLowerCase();
  if (status === "dry_run" || metaStatus === "dry_run" || isDryRunId(launch.metaCampaignId)) return "dry_run";
  if (status === "video_processing" || metaStatus === "video_processing") return "video_processing";
  if (status === "failed" || metaStatus === "failed" || launch.lastError) return "failed";
  if (status === "active" || metaStatus === "active") return "active";
  if (status === "paused" || metaStatus === "paused" || launch.metaCampaignId) return "paused";
  return "unknown";
}

const launchLabels: Record<LaunchState, string> = {
  paused: "Создана выключенной",
  active: "Отмечена активной",
  failed: "Требует внимания",
  dry_run: "Проверка без запуска",
  video_processing: "Видео обрабатывается",
  unknown: "Статус уточняется",
};

const launchTones: Record<LaunchState, { background: string; color: string }> = {
  paused: { background: "#ECFDF5", color: "#047857" },
  active: { background: "#EFF6FF", color: "#1D4ED8" },
  failed: { background: "#FEF2F2", color: "#B91C1C" },
  dry_run: { background: "#F3F4F6", color: "#475569" },
  video_processing: { background: "#FFFBEB", color: "#B45309" },
  unknown: { background: "#F3F4F6", color: "#64748B" },
};

function launchTime(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function formatLaunchDate(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "Дата не указана";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(time));
}

function formatPlannedBudget(minor: number | null, currency: string): string {
  if (minor === null || minor < 0) return "План не указан";
  try {
    return `${new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(minor / 100)} в день`;
  } catch {
    return `${(minor / 100).toLocaleString("ru-RU")} ${currency} в день`;
  }
}

function localHistoryKey(workspaceId: string): string {
  return `negis_ads_launch_history_${workspaceId}`;
}

export default function AdvertisingHub() {
  const [, setLocation] = useLocation();
  const { clinicId } = useAuth();
  const workspaceId = clinicId || readWorkspaceId();
  const productionWorkspace = isRealWorkspace(workspaceId);
  const [launches, setLaunches] = useState<AdvertisingLaunch[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [insightsAccess, setInsightsAccess] = useState<InsightsAccess>("idle");
  const [insightsSummaries, setInsightsSummaries] = useState<MetaInsightsHistorySummary[]>([]);
  const [insightsMessage, setInsightsMessage] = useState("");
  const [campaignGoal, setCampaignGoal] = useState<CampaignGoalForm>(defaultCampaignGoal);
  const [campaignGoalError, setCampaignGoalError] = useState("");

  const goalPlan = useMemo(() => {
    const targetPatients = Number(campaignGoal.targetPatients);
    const durationDays = Number(campaignGoal.durationDays);
    const maxBudget = Number(campaignGoal.maxBudget);
    const ready = Boolean(campaignGoal.service.trim())
      && Number.isInteger(targetPatients)
      && targetPatients > 0
      && Number.isInteger(durationDays)
      && durationDays > 0
      && durationDays <= 90
      && Number.isFinite(maxBudget)
      && maxBudget > 0;
    const dailyBudget = ready ? Math.round((maxBudget / durationDays) * 100) / 100 : null;

    return { ready, targetPatients, durationDays, maxBudget, dailyBudget };
  }, [campaignGoal]);

  function updateCampaignGoal(field: keyof CampaignGoalForm, value: string) {
    setCampaignGoal((current) => ({ ...current, [field]: value }));
    if (campaignGoalError) setCampaignGoalError("");
  }

  function prepareCampaign(destination: CampaignGoalDestination) {
    if (!goalPlan.ready || goalPlan.dailyBudget === null) {
      setCampaignGoalError("Укажите услугу, число пациентов, период до 90 дней и максимальный бюджет.");
      return;
    }

    const city = KZ_META_CITY_OPTIONS.find((option) => option.id === campaignGoal.cityId) || KZ_META_CITY_OPTIONS[0];
    try {
      const prefill = createAdvertisingCampaignPrefill({
        platform: "meta",
        sourceModule: "advertising-hub",
        sourceKind: "goal",
        campaignName: `${campaignGoal.service.trim()} · ${city.labelRu}`,
        service: campaignGoal.service.trim(),
        city: city.labelRu,
        cityId: city.id,
        targetPatients: goalPlan.targetPatients,
        durationDays: goalPlan.durationDays,
        maxBudget: goalPlan.maxBudget,
        dailyBudget: goalPlan.dailyBudget,
        budgetCurrency: "USD",
        generatedAt: new Date().toISOString(),
      });
      window.localStorage.setItem(
        workspaceScopedKey(
          destination === "/content-studio"
            ? ADVERTISING_CONTENT_STUDIO_PREFILL_KEY
            : ADVERTISING_CAMPAIGN_PREFILL_KEY,
        ),
        JSON.stringify(prefill),
      );
      setLocation(destination);
    } catch {
      setCampaignGoalError("Не удалось подготовить бриф. Проверьте введённые данные и повторите.");
    }
  }

  function submitCampaignGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    prepareCampaign("/ads-automation");
  }

  useEffect(() => {
    let cancelled = false;

    async function loadLaunches() {
      setLoadState("loading");

      if (!productionWorkspace) {
        const local = readDemoStorage<unknown[]>(localHistoryKey(workspaceId), []);
        if (!cancelled) {
          setLaunches(local.map(normalizeLaunch).sort((left, right) => launchTime(right.createdAt) - launchTime(left.createdAt)).slice(0, 40));
          setLoadState("ready");
        }
        return;
      }

      try {
        const response = await crmFetch(`/api/crm/meta-launches?workspaceId=${encodeURIComponent(workspaceId)}`);
        const text = await response.text();
        const body = text ? (JSON.parse(text) as LaunchesResponse) : {};
        if (!response.ok || body.success !== true || body.mode !== "supabase") {
          throw new Error("launches_unavailable");
        }

        const raw = Array.isArray(body.data?.launches)
          ? body.data.launches
          : Array.isArray(body.data?.items)
            ? body.data.items
            : [];
        const normalized = raw
          .map(normalizeLaunch)
          .sort((left, right) => launchTime(right.createdAt) - launchTime(left.createdAt))
          .slice(0, 40);

        if (!cancelled) {
          setLaunches(normalized);
          setLoadState("ready");
        }
      } catch {
        if (!cancelled) {
          setLaunches([]);
          setLoadState("error");
        }
      }
    }

    void loadLaunches();
    return () => {
      cancelled = true;
    };
  }, [productionWorkspace, reloadKey, workspaceId]);

  useEffect(() => {
    let cancelled = false;
    setInsightsSummaries([]);
    setInsightsMessage("");

    if (!productionWorkspace) {
      setInsightsAccess("idle");
      return () => {
        cancelled = true;
      };
    }

    setInsightsAccess("checking");
    void (async () => {
      try {
        const accessToken = await getSupabaseAccessToken();
        if (cancelled) return;
        if (!accessToken) {
          setInsightsAccess("required");
          setInsightsMessage("Войдите как владелец клиники, чтобы увидеть результаты рекламы.");
          return;
        }

        const authResponse = await crmFetch(
          `/api/crm/auth-context?workspaceId=${encodeURIComponent(workspaceId)}`,
          { accessToken },
        );
        const authBody = await readJson<ServerAdminAuthContext>(authResponse);
        if (cancelled) return;
        if (authResponse.status === 401) {
          setInsightsAccess("required");
          setInsightsMessage("Сессия истекла. Войдите снова, чтобы увидеть результаты рекламы.");
          return;
        }
        if (authResponse.status === 403) {
          setInsightsAccess("forbidden");
          setInsightsMessage("Результаты расходов доступны владельцу клиники.");
          return;
        }
        if (!authResponse.ok) throw new Error("auth_unavailable");
        if (
          authBody.success !== true
          || authBody.mode !== "supabase"
          || authBody.data?.isAdmin !== true
          || authBody.data.workspaceId !== workspaceId
        ) {
          setInsightsAccess("forbidden");
          setInsightsMessage("Результаты расходов доступны владельцу клиники.");
          return;
        }

        const insightsResponse = await crmFetch(
          `/api/crm/meta-insights-history?workspaceId=${encodeURIComponent(workspaceId)}`,
          { accessToken },
        );
        const insightsBody = await readJson<{ summaries?: MetaInsightsHistorySummary[] }>(insightsResponse);
        if (cancelled) return;
        if (insightsResponse.status === 401) {
          setInsightsAccess("required");
          setInsightsMessage("Сессия истекла. Войдите снова, чтобы увидеть результаты рекламы.");
          return;
        }
        if (insightsResponse.status === 403) {
          setInsightsAccess("forbidden");
          setInsightsMessage("Результаты расходов доступны владельцу клиники.");
          return;
        }
        if (!insightsResponse.ok || insightsBody.success !== true || insightsBody.mode !== "supabase") {
          throw new Error("insights_unavailable");
        }

        setInsightsSummaries(Array.isArray(insightsBody.data?.summaries) ? insightsBody.data.summaries : []);
        setInsightsAccess("ready");
      } catch {
        if (!cancelled) {
          setInsightsAccess("error");
          setInsightsMessage("Не удалось обновить результаты рекламы. Попробуйте позже.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [productionWorkspace, reloadKey, workspaceId]);

  const summary = useMemo(() => {
    const states = launches.map(launchState);
    return {
      created: states.filter((state) => state === "paused" || state === "active").length,
      paused: states.filter((state) => state === "paused").length,
      failed: states.filter((state) => state === "failed").length,
      dryRuns: states.filter((state) => state === "dry_run").length,
      processing: states.filter((state) => state === "video_processing").length,
    };
  }, [launches]);

  const insights = useMemo(() => aggregateAdvertisingInsights(insightsSummaries), [insightsSummaries]);

  const insightsStates = useMemo(() => ({
    available: insightsSummaries.filter((summary) => summary.availability === "available").length,
    empty: insightsSummaries.filter((summary) => summary.availability === "empty").length,
    running: insightsSummaries.filter((summary) => summary.availability === "running").length,
    failed: insightsSummaries.filter((summary) => summary.availability === "failed").length,
    notSynced: insightsSummaries.filter((summary) => summary.availability === "not_synced").length,
  }), [insightsSummaries]);

  const insightsEmptyMessage = useMemo(() => {
    if (insightsStates.running > 0) return "Meta обновляет данные. Результаты появятся после завершения синхронизации.";
    if (insightsStates.empty > 0) return "Meta не вернула данные за выбранный период. Это нормально для выключенных или не откручивавшихся кампаний.";
    if (insightsStates.failed > 0) return "Не удалось обновить данные Meta. Подробности доступны владельцу в истории запусков.";
    if (insightsStates.notSynced > 0) return "Результаты ещё не синхронизированы. Кампания и её плановый бюджет уже сохранены.";
    return "Фактические результаты появятся после первого рекламного показа.";
  }, [insightsStates]);

  const attention = useMemo(() => {
    if (loadState === "loading") {
      return { icon: Clock3, title: "Проверяем рекламные запуски", text: "Собираем последние статусы кампаний.", href: "/ads-automation/history", action: "Открыть историю" };
    }
    if (loadState === "error") {
      return { icon: AlertTriangle, title: "Не удалось обновить историю", text: "Повторите проверку. Новую рекламу можно подготовить отдельно.", href: "", action: "Повторить" };
    }
    if (summary.failed > 0) {
      return { icon: AlertTriangle, title: "Есть запуски, требующие внимания", text: `Неудачных запусков: ${summary.failed}. Причина и следующий шаг указаны в истории.`, href: "/ads-automation/history", action: "Проверить историю" };
    }
    if (summary.processing > 0) {
      return { icon: Clock3, title: "Meta обрабатывает видео", text: `Видео в обработке: ${summary.processing}. Это может занять несколько минут.`, href: "/ads-automation/history", action: "Проверить статус" };
    }
    if (summary.created === 0) {
      return { icon: Rocket, title: "Подготовьте первый рекламный запуск", text: "Добавьте креатив и ключевые параметры. Кампания будет создана выключенной.", href: "/ads-automation", action: "Создать рекламу" };
    }
    return { icon: CheckCircle2, title: "Рекламные запуски подготовлены", text: `Создано кампаний: ${summary.created}. Выключенных: ${summary.paused}.`, href: "/ads-automation/history", action: "Открыть историю" };
  }, [loadState, summary]);

  const AttentionIcon = attention.icon;
  const metricValue = (value: number) => (loadState === "ready" ? value : undefined);

  return (
    <PageLayout>
      <div className="mx-auto max-w-6xl space-y-7 px-4 py-6 sm:px-6">
        <PageHeader
          kicker="Рост"
          title="Рекламный агент"
          description="Создание креативов, безопасный запуск рекламы и понятная история кампаний в одном разделе."
          actions={(
            <Link href="/ads-automation">
              <span className="neu-btn-primary inline-flex cursor-pointer items-center justify-center gap-2 px-5 py-2.5 text-sm">
                <Rocket size={16} />
                Создать рекламу
              </span>
            </Link>
          )}
        />

        <section className="negis-glass overflow-hidden p-5 sm:p-6" aria-labelledby="campaign-goal-title">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ background: "var(--negis-primary-soft)", color: "var(--negis-primary)" }}>
                <Target size={19} />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase" style={{ color: "var(--negis-primary)", letterSpacing: 0 }}>Цель клиники</p>
                <h2 id="campaign-goal-title" className="mt-1 text-lg font-semibold" style={{ color: "var(--negis-text)" }}>Что должна дать реклама</h2>
                <p className="mt-1 max-w-2xl text-sm leading-relaxed" style={{ color: "var(--negis-muted)" }}>
                  Назовите ключевые ограничения. Рекламный мастер подготовит бриф и оставит запуск выключенным до вашей проверки.
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1 rounded-lg border p-1" style={{ borderColor: "var(--negis-border)", background: "var(--negis-surface)" }} aria-label="Рекламная площадка">
              <button type="button" className="min-h-9 rounded-md px-3 text-sm font-semibold" style={{ background: "var(--negis-primary)", color: "white" }} aria-pressed="true">
                Meta
              </button>
              <button type="button" className="min-h-9 rounded-md px-3 text-sm font-semibold opacity-60" style={{ color: "var(--negis-muted)" }} disabled title="Клиентский запуск TikTok готовится">
                TikTok · скоро
              </button>
            </div>
          </div>

          <form className="mt-5" onSubmit={submitCampaignGoal}>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
              <label className="min-w-0 sm:col-span-2 xl:col-span-1">
                <span className="mb-1.5 block text-sm font-semibold" style={{ color: "var(--negis-text)" }}>Услуга</span>
                <input
                  className="neu-input min-h-11 w-full"
                  value={campaignGoal.service}
                  onChange={(event) => updateCampaignGoal("service", event.target.value)}
                  placeholder="Например, консультация"
                  autoComplete="off"
                />
              </label>
              <label className="min-w-0">
                <span className="mb-1.5 block text-sm font-semibold" style={{ color: "var(--negis-text)" }}>Город показа</span>
                <select
                  className="neu-input min-h-11 w-full"
                  value={campaignGoal.cityId}
                  onChange={(event) => updateCampaignGoal("cityId", event.target.value)}
                >
                  {KZ_META_CITY_OPTIONS.map((city) => <option key={city.id} value={city.id}>{city.labelRu}</option>)}
                </select>
              </label>
              <label className="min-w-0">
                <span className="mb-1.5 block text-sm font-semibold" style={{ color: "var(--negis-text)" }}>Нужно пациентов</span>
                <input
                  className="neu-input min-h-11 w-full"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  step="1"
                  value={campaignGoal.targetPatients}
                  onChange={(event) => updateCampaignGoal("targetPatients", event.target.value)}
                  placeholder="20"
                />
              </label>
              <label className="min-w-0">
                <span className="mb-1.5 block text-sm font-semibold" style={{ color: "var(--negis-text)" }}>Период, дней</span>
                <input
                  className="neu-input min-h-11 w-full"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="90"
                  step="1"
                  value={campaignGoal.durationDays}
                  onChange={(event) => updateCampaignGoal("durationDays", event.target.value)}
                />
              </label>
              <label className="min-w-0">
                <span className="mb-1.5 block text-sm font-semibold" style={{ color: "var(--negis-text)" }}>Максимальный бюджет, USD</span>
                <input
                  className="neu-input min-h-11 w-full"
                  type="number"
                  inputMode="decimal"
                  min="1"
                  step="0.01"
                  value={campaignGoal.maxBudget}
                  onChange={(event) => updateCampaignGoal("maxBudget", event.target.value)}
                  placeholder="280"
                />
              </label>
            </div>

            <div className="mt-5 flex flex-col gap-4 border-t pt-4 sm:flex-row sm:items-center sm:justify-between" style={{ borderColor: "var(--negis-border)" }}>
              <div className="min-w-0">
                {goalPlan.dailyBudget !== null ? (
                  <p className="text-sm font-semibold" style={{ color: "var(--negis-text)" }}>
                    Дневной лимит в мастере: {goalPlan.dailyBudget.toLocaleString("ru-RU", { maximumFractionDigits: 2 })} USD
                  </p>
                ) : (
                  <p className="text-sm font-semibold" style={{ color: "var(--negis-text)" }}>Заполните цель кампании</p>
                )}
                <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--negis-muted)" }}>
                  Цель по пациентам является ориентиром, а не прогнозом или гарантией результата.
                </p>
                {campaignGoalError ? <p className="mt-2 text-sm font-semibold text-red-700" role="alert">{campaignGoalError}</p> : null}
              </div>
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                <button
                  type="button"
                  className="neu-btn-primary inline-flex min-h-11 items-center justify-center gap-2 px-5 text-sm"
                  onClick={() => prepareCampaign("/content-studio")}
                >
                  <Bot size={17} />
                  Создать креатив с ИИ
                  <ArrowRight size={16} />
                </button>
                <button type="submit" className="neu-btn inline-flex min-h-11 items-center justify-center gap-2 px-5 text-sm">
                  <Upload size={16} />
                  У меня есть креатив
                </button>
              </div>
            </div>
          </form>
        </section>

        <section aria-labelledby="advertising-summary-title">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <h2 id="advertising-summary-title" className="text-lg font-semibold" style={{ color: "var(--negis-text)" }}>Ключевые статусы</h2>
              <p className="mt-1 text-sm" style={{ color: "var(--negis-muted)" }}>Только сохранённые результаты запусков, без прогнозных показателей.</p>
            </div>
            <button
              type="button"
              className="neu-icon-btn shrink-0"
              aria-label="Обновить статусы рекламы"
              title="Обновить"
              onClick={() => setReloadKey((value) => value + 1)}
            >
              <RefreshCw size={17} />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard label="Кампаний создано" value={metricValue(summary.created)} icon={Megaphone} tone="primary" loading={loadState === "loading"} />
            <MetricCard label="Создано выключенными" value={metricValue(summary.paused)} icon={CheckCircle2} tone="success" loading={loadState === "loading"} />
            <MetricCard label="Требуют внимания" value={metricValue(summary.failed)} icon={AlertTriangle} tone={summary.failed > 0 ? "error" : "muted"} loading={loadState === "loading"} />
            <MetricCard label="Проверок без запуска" value={metricValue(summary.dryRuns)} icon={FlaskConical} tone="muted" loading={loadState === "loading"} />
          </div>
        </section>

        <section aria-labelledby="advertising-results-title">
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase" style={{ color: "var(--negis-primary)", letterSpacing: 0 }}>Отчёт владельца</p>
              <h2 id="advertising-results-title" className="mt-1 text-lg font-semibold" style={{ color: "var(--negis-text)" }}>Результаты рекламы</h2>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed" style={{ color: "var(--negis-muted)" }}>
                Только фактические данные Meta по последним синхронизированным кампаниям.
              </p>
            </div>
            <Link href="/ads-automation/history">
              <span className="cursor-pointer text-sm font-semibold" style={{ color: "var(--negis-primary)" }}>Подробнее по кампаниям</span>
            </Link>
          </div>

          {insightsAccess === "checking" ? (
            <div className="negis-glass p-5 text-sm font-medium" style={{ color: "var(--negis-muted)" }}>Загружаем фактические результаты…</div>
          ) : insightsAccess === "ready" && insights.campaignsWithData > 0 ? (
            <>
              <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                <MetricCard
                  label="Фактический расход Meta"
                  value={insights.spendByCurrency.length === 1
                    ? formatMinorAmount(
                        insights.spendByCurrency[0].spendMinor,
                        insights.spendByCurrency[0].currencyExponent,
                        insights.spendByCurrency[0].currency,
                      )
                    : insights.spendByCurrency.length > 1
                      ? "По валютам"
                      : "Нет данных"}
                  icon={WalletCards}
                  tone="primary"
                  delta={insights.spendByCurrency.length > 1
                    ? insights.spendByCurrency
                        .map((item) => formatMinorAmount(item.spendMinor, item.currencyExponent, item.currency))
                        .join(" · ")
                    : `Кампаний с данными: ${insights.campaignsWithData}`}
                />
                <MetricCard label="Показы" value={formatCount(insights.impressions)} icon={BarChart3} tone="info" />
                <MetricCard
                  label="Клики"
                  value={formatCount(insights.clicks)}
                  icon={MousePointerClick}
                  tone="secondary"
                  delta={`По ссылке: ${formatCount(insights.inlineLinkClicks)}`}
                />
                <MetricCard
                  label="Лиды по данным Meta"
                  value={insights.hasMetaLeads ? formatCount(insights.metaLeads) : "Нет данных"}
                  icon={Target}
                  tone="success"
                />
              </div>
              <div className="mt-3 flex flex-col gap-2 border-l-4 px-4 py-3 sm:flex-row sm:items-center sm:justify-between" style={{ borderColor: "var(--negis-primary)", background: "var(--negis-primary-soft)" }}>
                <div className="min-w-0">
                  <p className="text-sm font-semibold" style={{ color: "var(--negis-text)" }}>
                    {formatInsightsDateRange(insights.coveredDateStart, insights.coveredDateStop)}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--negis-muted)" }}>
                    Фактический расход Meta показан отдельно от планового бюджета. Лиды Meta не равны заявкам CRM. Это ещё не оценка эффективности рекламы.
                  </p>
                </div>
                <span className="shrink-0 text-xs font-semibold" style={{ color: "var(--negis-muted)" }}>{formatInsightsUpdate(insights.latestFetchedAt)}</span>
              </div>
            </>
          ) : (
            <div className="negis-glass flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-semibold" style={{ color: "var(--negis-text)" }}>
                  {insightsAccess === "ready"
                    ? "Фактических данных пока нет"
                    : insightsAccess === "idle"
                      ? "Фактические данные ещё не подключены"
                      : insightsAccess === "error"
                        ? "Не удалось обновить результаты"
                        : "Результаты доступны владельцу"}
                </p>
                <p className="mt-1 text-sm leading-relaxed" style={{ color: "var(--negis-muted)" }}>
                  {insightsAccess === "ready"
                    ? insightsEmptyMessage
                    : insightsAccess === "idle"
                      ? "В рабочем пространстве данные появятся после синхронизации Meta."
                      : insightsMessage}
                </p>
              </div>
              {insightsAccess === "ready" ? (
                <Link href="/ads-automation/history">
                  <span className="neu-btn inline-flex cursor-pointer items-center justify-center whitespace-nowrap text-sm">Открыть историю</span>
                </Link>
              ) : null}
            </div>
          )}
        </section>

        <section className="negis-glass p-5" aria-labelledby="advertising-attention-title">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ background: "var(--negis-primary-soft)", color: "var(--negis-primary)" }}>
                <AttentionIcon size={19} />
              </span>
              <div className="min-w-0">
                <h2 id="advertising-attention-title" className="text-base font-semibold" style={{ color: "var(--negis-text)" }}>{attention.title}</h2>
                <p className="mt-1 text-sm leading-relaxed" style={{ color: "var(--negis-muted)" }}>{attention.text}</p>
              </div>
            </div>
            {attention.href ? (
              <Link href={attention.href}>
                <span className="neu-btn inline-flex cursor-pointer items-center justify-center whitespace-nowrap text-sm">{attention.action}</span>
              </Link>
            ) : (
              <button type="button" className="neu-btn justify-center whitespace-nowrap text-sm" onClick={() => setReloadKey((value) => value + 1)}>
                {attention.action}
              </button>
            )}
          </div>
        </section>

        <section aria-labelledby="advertising-actions-title">
          <h2 id="advertising-actions-title" className="text-lg font-semibold" style={{ color: "var(--negis-text)" }}>Действия</h2>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
            {[
              { href: "/ads-automation", icon: Rocket, title: "Запустить рекламу", text: "Загрузить креатив, проверить параметры и создать кампанию выключенной." },
              { href: "/content-studio", icon: Clapperboard, title: "Подготовить креатив", text: "Создать текст, изображение или видео и передать его в рекламный запуск." },
              { href: "/ads-automation/history", icon: History, title: "Посмотреть историю", text: "Проверить результат создания кампаний и последние сохранённые статусы." },
            ].map(({ href, icon: Icon, title, text }) => (
              <Link key={href} href={href}>
                <div className="neu-sm h-full cursor-pointer p-4 transition-transform hover:-translate-y-0.5">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ background: "var(--negis-primary-soft)", color: "var(--negis-primary)" }}>
                    <Icon size={17} />
                  </span>
                  <h3 className="mt-3 text-sm font-semibold" style={{ color: "var(--negis-text)" }}>{title}</h3>
                  <p className="mt-1 text-sm leading-relaxed" style={{ color: "var(--negis-muted)" }}>{text}</p>
                </div>
              </Link>
            ))}
          </div>
        </section>

        <section aria-labelledby="recent-advertising-title">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="recent-advertising-title" className="text-lg font-semibold" style={{ color: "var(--negis-text)" }}>Последние запуски</h2>
              <p className="mt-1 text-sm" style={{ color: "var(--negis-muted)" }}>Плановый бюджет не является фактическим расходом Meta.</p>
            </div>
            <Link href="/ads-automation/history">
              <span className="cursor-pointer text-sm font-semibold" style={{ color: "var(--negis-primary)" }}>Вся история</span>
            </Link>
          </div>

          {loadState === "loading" ? (
            <div className="mt-3 negis-glass p-5 text-sm font-medium" style={{ color: "var(--negis-muted)" }}>Загружаем рекламные запуски…</div>
          ) : loadState === "error" ? (
            <div className="mt-3 negis-glass p-5 text-sm font-medium" style={{ color: "var(--negis-muted)" }}>Не удалось загрузить историю запусков.</div>
          ) : launches.length === 0 ? (
            <div className="mt-3 negis-glass p-5 text-sm font-medium" style={{ color: "var(--negis-muted)" }}>Запусков пока нет.</div>
          ) : (
            <div className="mt-3 grid gap-3">
              {launches.slice(0, 5).map((launch, index) => {
                const state = launchState(launch);
                const tone = launchTones[state];
                return (
                  <article key={launch.id || `${launch.campaignName}-${launch.createdAt}-${index}`} className="neu-sm flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <h3 className="break-words text-sm font-semibold" style={{ color: "var(--negis-text)" }}>{launch.campaignName}</h3>
                      <p className="mt-1 text-xs font-medium" style={{ color: "var(--negis-muted)" }}>
                        {formatLaunchDate(launch.createdAt)} · {formatPlannedBudget(launch.budgetDailyMinor, launch.currency)}
                      </p>
                    </div>
                    <span className="w-fit shrink-0 rounded-lg px-2.5 py-1 text-xs font-semibold" style={tone}>{launchLabels[state]}</span>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <p className="text-xs leading-relaxed" style={{ color: "var(--negis-muted)" }}>
          Безопасный режим: Negis создаёт новые кампании выключенными. Включение и расход бюджета остаются под контролем владельца рекламного кабинета.
        </p>
      </div>
    </PageLayout>
  );
}

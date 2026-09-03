import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
  CheckCircle2,
  Clapperboard,
  Clock3,
  FlaskConical,
  History,
  Megaphone,
  RefreshCw,
  Rocket,
} from "lucide-react";
import { PageLayout } from "@/components/layout/PageLayout";
import { PageHeader } from "@/components/ui/page-header";
import { MetricCard } from "@/components/ui/metric-card";
import { useAuth } from "@/contexts/AuthContext";
import { crmFetch } from "@/lib/api";
import { isRealWorkspace, readDemoStorage, readWorkspaceId } from "@/lib/demoStorage";

type LoadState = "loading" | "ready" | "error";
type LaunchState = "paused" | "active" | "failed" | "dry_run" | "video_processing" | "unknown";

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
  const { clinicId } = useAuth();
  const workspaceId = clinicId || readWorkspaceId();
  const productionWorkspace = isRealWorkspace(workspaceId);
  const [launches, setLaunches] = useState<AdvertisingLaunch[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [reloadKey, setReloadKey] = useState(0);

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

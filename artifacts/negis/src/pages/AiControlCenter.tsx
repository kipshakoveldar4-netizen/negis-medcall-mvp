import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "wouter";
import {
  ArrowRight,
  Bot,
  CalendarCheck,
  CheckCircle2,
  Circle,
  Clapperboard,
  ClipboardList,
  DollarSign,
  Inbox,
  Megaphone,
  MessageCircle,
  RefreshCw,
  Rocket,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import { PageLayout } from "@/components/layout/PageLayout";
import { apiUrl } from "@/lib/api";
import { readDemoStorage } from "@/lib/demoStorage";
import { defaultThemePresetId, getThemePreset } from "@/lib/themePresets";

// D3B — AI Control Center with minimal REAL operational data (Glass Morphic Medical AI).
// Real: latest ad launch + failed-launch count (from /api/crm/meta-launches), and system
// health (API / Supabase Storage / Targeting Agent / Meta configured). Everything CRM/sales
// (заявки, лиды, записи, выручка) stays an honest placeholder — no fake numbers. AI
// recommendations are simple rule-based signals from real statuses, not AI predictions.

const EMPTY_METRIC_HINT = "Данные появятся после подключения CRM.";

type Tone = "primary" | "ai" | "success" | "warning" | "error" | "muted";

function toneColor(tone: Tone): string {
  return `var(--negis-${tone})`;
}

function toneSoftBg(tone: Tone): string {
  switch (tone) {
    case "ai":
      return "rgba(124,58,237,0.10)";
    case "success":
      return "rgba(16,185,129,0.12)";
    case "warning":
      return "rgba(245,158,11,0.14)";
    case "error":
      return "rgba(239,68,68,0.10)";
    case "muted":
      return "rgba(148,163,184,0.14)";
    default:
      return "var(--negis-primary-soft)";
  }
}

type HealthState = "loading" | "ready" | "check" | "disconnected" | "unknown" | "pending" | "partial";

const healthLabel: Record<HealthState, { label: string; tone: Tone }> = {
  loading: { label: "Проверяем…", tone: "muted" },
  ready: { label: "Готово", tone: "success" },
  check: { label: "Требует проверки", tone: "warning" },
  disconnected: { label: "Не подключено", tone: "muted" },
  unknown: { label: "Не удалось проверить", tone: "muted" },
  pending: { label: "Ожидает", tone: "muted" },
  partial: { label: "Частично готово", tone: "warning" },
};

type LaunchMode = "paused" | "failed" | "dry_run" | "video_processing" | "unknown";

type LaunchItem = {
  status?: string;
  metaStatus?: string;
  metaCampaignId?: string;
  lastError?: string;
  createdAt?: string;
  payload?: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isDryRunId(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase().startsWith("dryrun_");
}

function classifyLaunch(item: LaunchItem): LaunchMode {
  const status = str(item.status).toLowerCase();
  const metaStatus = str(item.metaStatus).toLowerCase();
  if (status === "dry_run" || metaStatus === "dry_run" || isDryRunId(item.metaCampaignId)) return "dry_run";
  if (status === "video_processing" || metaStatus === "video_processing") return "video_processing";
  if (status === "failed" || metaStatus === "failed" || str(item.lastError)) return "failed";
  if (item.metaCampaignId && !isDryRunId(item.metaCampaignId)) return "paused";
  return "unknown";
}

const launchModeLabel: Record<LaunchMode, string> = {
  paused: "Создана выключенной",
  failed: "Не удалось создать",
  dry_run: "Тест без создания рекламы",
  video_processing: "Видео обрабатывается",
  unknown: "Статус неизвестен",
};

function readWorkspaceId(): string {
  try {
    const raw = localStorage.getItem("negis_demo_workspace");
    if (!raw) return "demo-workspace";
    const workspace = JSON.parse(raw) as { id?: unknown };
    return typeof workspace.id === "string" && workspace.id.trim() ? workspace.id.trim() : "demo-workspace";
  } catch {
    return "demo-workspace";
  }
}

async function fetchJson(path: string): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  try {
    const response = await fetch(apiUrl(path));
    const text = await response.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    return { ok: response.ok, body };
  } catch {
    return { ok: false, body: {} };
  }
}

/* ── CRM data (real counts, no AI, no invented numbers) ─────── */

// Same visual normalization as LeadsPage/ClientsPage — stored statuses stay untouched.
function normalizeLeadStatus(raw: string): "new" | "in_progress" | "booked" | "lost" {
  const value = raw.toLowerCase();
  if (/(work|в работе|прогресс|progress|contact|связ|звон)/.test(value)) return "in_progress";
  if (/(book|запис|schedul|пришёл|пришел|приш|arriv|visit|came|показ)/.test(value)) return "booked";
  if (/(lost|потер|отказ|reject|declin|cancel|отмен|fail|неудач|спам)/.test(value)) return "lost";
  return "new";
}

function isRepeatClient(status: string, lastVisit: string): boolean {
  const value = status.toLowerCase();
  if (/(неактив|inactive|arch)/.test(value)) return false;
  if (/(повтор|repeat|return|вернул)/.test(value)) return true;
  // Operational hint, not a medical rule: no visit for 90+ days suggests a follow-up.
  const visitTime = Date.parse(lastVisit);
  return Number.isFinite(visitTime) && Date.now() - visitTime > 90 * 24 * 60 * 60 * 1000;
}

function isTodayDate(value: string): boolean {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const date = new Date(timestamp);
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

type CrmList = { responded: boolean; items: Array<Record<string, unknown>> };

// Real API items when Supabase answers; in demo mode the endpoint responds but the
// data lives in the CRM pages' localStorage (read-only fallback). A failed endpoint
// reports responded: false and the metric shows "Не удалось проверить".
async function fetchCrmList(path: string, listKey: string, demoKey: string): Promise<CrmList> {
  const { ok, body } = await fetchJson(path);
  if (!ok || body.success !== true) return { responded: false, items: [] };
  if (body.mode === "supabase") {
    const rawItems = asRecord(body.data)[listKey];
    return { responded: true, items: Array.isArray(rawItems) ? rawItems.map((item) => asRecord(item)) : [] };
  }
  return { responded: true, items: readDemoStorage<unknown[]>(demoKey, []).map((item) => asRecord(item)) };
}

/* ── Presentational components ─────────────────────────────── */

function ControlMetricCard({
  label,
  icon: Icon,
  tone,
  value,
  hint,
  loading,
}: {
  label: string;
  icon: LucideIcon;
  tone: Tone;
  value?: string;
  hint?: string;
  loading?: boolean;
}) {
  return (
    <div className="negis-glass p-4 sm:p-5">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl" style={{ background: toneSoftBg(tone), color: toneColor(tone) }}>
          <Icon size={18} />
        </div>
        <p className="text-sm font-black" style={{ color: "var(--negis-text)" }}>{label}</p>
      </div>
      <p className="mt-3 text-3xl font-black" style={{ color: "var(--negis-text)" }}>{loading ? "…" : value ?? "—"}</p>
      <p className="mt-1 text-xs font-semibold leading-relaxed" style={{ color: "var(--negis-muted)" }}>{hint ?? EMPTY_METRIC_HINT}</p>
    </div>
  );
}

type Priority = "high" | "medium" | "low";

const priorityMeta: Record<Priority, { label: string; tone: Tone }> = {
  high: { label: "Высокий", tone: "error" },
  medium: { label: "Средний", tone: "warning" },
  low: { label: "Низкий", tone: "muted" },
};

type Recommendation = { title: string; priority: Priority; explanation: string; action: string; openHref?: string };

function AIActionCard({ title, priority, explanation, action, openHref }: Recommendation) {
  const meta = priorityMeta[priority];
  return (
    <div className="negis-glass flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: "rgba(124,58,237,0.10)", color: "var(--negis-ai)" }}>
            <Sparkles size={16} />
          </div>
          <p className="text-sm font-black" style={{ color: "var(--negis-text)" }}>{title}</p>
        </div>
        <span
          className="shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-black uppercase tracking-[0.06em]"
          style={{ background: toneSoftBg(meta.tone), color: toneColor(meta.tone) }}
        >
          {meta.label}
        </span>
      </div>
      <p className="text-sm font-semibold leading-relaxed" style={{ color: "var(--negis-muted)" }}>{explanation}</p>
      <p className="text-sm font-bold" style={{ color: "var(--negis-text)" }}>
        Действие: <span style={{ color: "var(--negis-primary)" }}>{action}</span>
      </p>
      <div className="mt-1 flex flex-wrap gap-2">
        {openHref ? (
          <Link href={openHref}>
            <button type="button" className="neu-btn justify-center px-4 py-2 text-xs">Открыть</button>
          </Link>
        ) : (
          <button type="button" className="neu-btn justify-center px-4 py-2 text-xs opacity-60" disabled>Открыть</button>
        )}
        <button type="button" className="neu-btn justify-center px-4 py-2 text-xs opacity-60" disabled title="Появится после подключения задач">
          Создать задачу
        </button>
        <button type="button" className="neu-btn justify-center px-4 py-2 text-xs opacity-60" disabled title="Появится на следующем этапе">
          Подробнее
        </button>
      </div>
    </div>
  );
}

function QuickActionButton({ label, icon: Icon, href, disabled }: { label: string; icon: LucideIcon; href?: string; disabled?: boolean }) {
  const inner = (
    <button
      type="button"
      className={`neu-btn justify-center gap-2 px-4 py-2.5 text-sm ${disabled ? "opacity-60" : ""}`}
      disabled={disabled}
      title={disabled ? "Появится на следующем этапе" : undefined}
    >
      <Icon size={16} />
      {label}
    </button>
  );
  if (disabled || !href) return inner;
  return <Link href={href}>{inner}</Link>;
}

type FlowState = "active" | "soon" | "pending";

function BusinessFlowStep({ label, state }: { label: string; state: FlowState }) {
  const tag = state === "active" ? "активно" : state === "soon" ? "скоро" : "данные не подключены";
  const color = state === "active" ? "var(--negis-primary)" : "var(--negis-muted)";
  return (
    <div className="negis-glass flex shrink-0 flex-col gap-1 px-4 py-3" style={{ minWidth: 128 }}>
      <span className="text-sm font-black" style={{ color: "var(--negis-text)" }}>{label}</span>
      <span className="text-[10px] font-black uppercase tracking-[0.06em]" style={{ color }}>{tag}</span>
    </div>
  );
}

function HealthRow({ label, state }: { label: string; state: HealthState }) {
  const meta = healthLabel[state];
  const ready = state === "ready";
  return (
    <div className="flex items-center gap-3">
      {ready ? <CheckCircle2 size={18} style={{ color: "var(--negis-success)" }} /> : <Circle size={18} style={{ color: toneColor(meta.tone) }} />}
      <span className="text-sm font-bold" style={{ color: ready ? "var(--negis-text)" : "var(--negis-muted)" }}>{label}</span>
      <span className="ml-auto text-xs font-bold" style={{ color: toneColor(meta.tone) }}>{meta.label}</span>
    </div>
  );
}

function SectionTitle({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-lg font-black" style={{ color: "var(--negis-text)" }}>{children}</h2>
      {hint ? <p className="mt-0.5 text-sm font-semibold" style={{ color: "var(--negis-muted)" }}>{hint}</p> : null}
    </div>
  );
}

const chipStyle: CSSProperties = { borderRadius: 999, padding: "4px 12px", fontSize: 11, fontWeight: 800 };

export default function AiControlCenter() {
  const theme = getThemePreset(defaultThemePresetId);
  const todayLabel = new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long" });

  const [loading, setLoading] = useState(true);
  const [launchesLoaded, setLaunchesLoaded] = useState(false);
  const [launches, setLaunches] = useState<LaunchItem[]>([]);
  const [apiState, setApiState] = useState<HealthState>("loading");
  const [storageState, setStorageState] = useState<HealthState>("loading");
  const [targetingState, setTargetingState] = useState<HealthState>("loading");
  const [metaState, setMetaState] = useState<HealthState>("loading");
  const [leadsState, setLeadsState] = useState<HealthState>("loading");
  const [clientsState, setClientsState] = useState<HealthState>("loading");
  const [appointmentsState, setAppointmentsState] = useState<HealthState>("loading");
  const [crmCounts, setCrmCounts] = useState({ newLeads: 0, unprocessedLeads: 0, appointmentsToday: 0, repeatClients: 0 });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const workspaceId = readWorkspaceId();
      const workspaceQuery = `workspaceId=${encodeURIComponent(workspaceId)}`;
      // Independent fetches: one failing endpoint must not block the page.
      const [health, storage, targeting, launchesRes, leadsRes, clientsRes, appointmentsRes] = await Promise.all([
        fetchJson("/api/crm/health"),
        fetchJson("/api/crm/storage-health"),
        fetchJson("/api/targeting/health"),
        fetchJson(`/api/crm/meta-launches?${workspaceQuery}`),
        fetchCrmList(`/api/crm/leads?${workspaceQuery}`, "leads", "negis_demo_leads"),
        fetchCrmList(`/api/crm/clients?${workspaceQuery}`, "clients", "negis_demo_clients"),
        fetchCrmList(`/api/crm/appointments?${workspaceQuery}`, "appointments", "negis_demo_appointments"),
      ]);
      if (cancelled) return;

      // CRM counts — real data only; failed endpoints stay "Не удалось проверить".
      setLeadsState(leadsRes.responded ? "ready" : "unknown");
      setClientsState(clientsRes.responded ? "ready" : "unknown");
      setAppointmentsState(appointmentsRes.responded ? "ready" : "unknown");
      setCrmCounts({
        newLeads: leadsRes.items.filter((lead) => normalizeLeadStatus(str(lead.status)) === "new").length,
        unprocessedLeads: leadsRes.items.filter((lead) => {
          const status = normalizeLeadStatus(str(lead.status));
          const hasClient = Boolean(str(lead.clientId) || str(lead.client_id));
          return status === "new" || (!hasClient && status !== "lost" && status !== "booked");
        }).length,
        appointmentsToday: appointmentsRes.items.filter((item) =>
          isTodayDate(str(item.startsAt) || str(item.starts_at) || str(item.time)),
        ).length,
        repeatClients: clientsRes.items.filter((client) =>
          isRepeatClient(str(client.status), str(client.lastVisit) || str(client.last_visit_at)),
        ).length,
      });

      // API health
      setApiState(health.ok && health.body.success === true ? "ready" : "unknown");

      // Meta configured (from health.meta.configured)
      if (health.ok && health.body.success === true) {
        const meta = asRecord(asRecord(health.body.data).meta);
        setMetaState(meta.configured === true ? "ready" : "disconnected");
      } else {
        setMetaState("unknown");
      }

      // Supabase Storage
      if (storage.ok && storage.body.success === true) {
        const data = asRecord(storage.body.data);
        if (data.exists && data.publicAccess) setStorageState("ready");
        else if (data.exists) setStorageState("check");
        else setStorageState("disconnected");
      } else {
        setStorageState("unknown");
      }

      // Targeting Agent (external; often unavailable)
      setTargetingState(targeting.ok && targeting.body.success === true ? "ready" : "disconnected");

      // Ad launches
      if (launchesRes.ok && launchesRes.body.success === true) {
        const data = asRecord(launchesRes.body.data);
        const list = (Array.isArray(data.launches) ? data.launches : Array.isArray(data.items) ? data.items : []) as LaunchItem[];
        const sorted = [...list].sort((a, b) => str(b.createdAt).localeCompare(str(a.createdAt)));
        setLaunches(sorted);
        setLaunchesLoaded(true);
      }

      setLoading(false);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const latest = launches[0];
  const latestMode = latest ? classifyLaunch(latest) : null;
  const failedCount = launches.filter((item) => classifyLaunch(item) === "failed").length;

  // CRM metric helper: value only when the endpoint responded, honest "Не удалось
  // проверить" when it failed — never invented numbers.
  const crmMetric = (state: HealthState, count: number, readyHint: string) => ({
    value: state === "ready" ? String(count) : undefined,
    hint: state === "unknown" ? "Не удалось проверить" : state === "ready" ? readyHint : "Загружаем данные CRM…",
    loading: state === "loading",
  });

  const metrics: Array<{ label: string; icon: LucideIcon; tone: Tone; value?: string; hint?: string; loading?: boolean }> = [
    {
      label: "Новые заявки",
      icon: Inbox,
      tone: "primary",
      ...crmMetric(leadsState, crmCounts.newLeads, "Ждут первого контакта."),
    },
    {
      label: "Необработанные лиды",
      icon: Users,
      tone: crmCounts.unprocessedLeads > 0 ? "warning" : "success",
      ...crmMetric(leadsState, crmCounts.unprocessedLeads, "Новые или ещё не связаны с карточкой клиента."),
    },
    {
      label: "Записи сегодня",
      icon: CalendarCheck,
      tone: "primary",
      ...crmMetric(appointmentsState, crmCounts.appointmentsToday, "По календарю записей на сегодня."),
    },
    {
      label: "Пациенты для повторного визита",
      icon: RefreshCw,
      tone: "ai",
      ...crmMetric(clientsState, crmCounts.repeatClients, "Статус «повторный визит» или нет визита более 90 дней — операционная подсказка."),
    },
    {
      label: "Реклама требует внимания",
      icon: Megaphone,
      tone: failedCount > 0 ? "error" : "success",
      value: launchesLoaded ? String(failedCount) : undefined,
      hint: launchesLoaded
        ? failedCount > 0
          ? "Неудачные запуски рекламы. Проверьте историю."
          : "Неудачных запусков нет."
        : "Проверяем статусы запусков…",
      loading,
    },
    // Honest placeholder until a deals/sales table exists — no invented revenue.
    { label: "Выручка сегодня", icon: DollarSign, tone: "success", hint: "Будет доступно после подключения продаж." },
  ];

  const flowSteps: Array<{ label: string; state: FlowState }> = [
    { label: "Реклама", state: "active" },
    { label: "Заявка", state: "active" },
    { label: "CRM", state: "active" },
    { label: "Запись", state: "active" },
    { label: "Продажа", state: "pending" },
    { label: "Повторный визит", state: "soon" },
    { label: "AI-действие", state: "soon" },
  ];

  // Rule-based operational recommendations from real CRM data and system statuses only (no AI calls).
  const recommendations: Recommendation[] = [];
  if (crmCounts.newLeads > 0) {
    recommendations.push({
      title: "Обработайте новые заявки",
      priority: "high",
      explanation: `Новых заявок: ${crmCounts.newLeads}. Свяжитесь с клиентами, пока обращения свежие.`,
      action: "Открыть заявки",
      openHref: "/leads",
    });
  }
  if (crmCounts.unprocessedLeads > 0) {
    recommendations.push({
      title: "Свяжите заявки с клиентами",
      priority: "medium",
      explanation: `Заявок без карточки клиента: ${crmCounts.unprocessedLeads}. Создайте клиентов, чтобы вести историю пациента.`,
      action: "Открыть заявки",
      openHref: "/leads",
    });
  }
  if (crmCounts.appointmentsToday > 0) {
    recommendations.push({
      title: "Проверьте записи на сегодня",
      priority: "medium",
      explanation: `Записей на сегодня: ${crmCounts.appointmentsToday}. Подтвердите визиты и подготовьте расписание.`,
      action: "Открыть записи",
      openHref: "/appointments",
    });
  }
  if (crmCounts.repeatClients > 0) {
    recommendations.push({
      title: "Подготовьте повторное предложение",
      priority: "low",
      explanation: `Пациентов для повторного визита: ${crmCounts.repeatClients}. Напомните о себе в WhatsApp.`,
      action: "Открыть клиентов",
      openHref: "/clients",
    });
  }
  if (failedCount > 0) {
    recommendations.push({
      title: "Проверьте неудачный запуск рекламы",
      priority: "high",
      explanation: `Есть неудачные запуски: ${failedCount}. Откройте историю и посмотрите причину.`,
      action: "Открыть историю запусков",
      openHref: "/ads-automation/history",
    });
  }
  if (metaState === "disconnected") {
    recommendations.push({
      title: "Проверьте подключение Meta",
      priority: "high",
      explanation: "Meta ещё не подключена — реклама не сможет запуститься.",
      action: "Открыть автозапуск рекламы",
      openHref: "/ads-automation",
    });
  }
  if (storageState === "disconnected" || storageState === "check") {
    recommendations.push({
      title: "Проверьте Supabase Storage",
      priority: "medium",
      explanation: "Хранилище креативов недоступно — загрузка фото и видео может не работать.",
      action: "Открыть автозапуск рекламы",
      openHref: "/ads-automation",
    });
  }

  return (
    <PageLayout>
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6">
        {/* 1. Hero */}
        <header className="negis-glass-hero p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-2">
            <span style={{ ...chipStyle, background: "var(--negis-primary-soft)", color: "var(--negis-primary)" }}>Negis OS</span>
            <span style={{ ...chipStyle, background: "rgba(37,99,235,0.10)", color: "var(--negis-secondary)" }}>Сегодня · {todayLabel}</span>
            {theme ? <span style={{ ...chipStyle, background: "rgba(124,58,237,0.10)", color: "var(--negis-ai)" }}>Glass AI</span> : null}
          </div>
          <h1 className="mt-3 text-3xl font-black" style={{ color: "var(--negis-text)" }}>AI Control Center</h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed" style={{ color: "var(--negis-muted)" }}>
            Главная картина клиники: заявки, реклама, записи, продажи и AI-рекомендации.
          </p>
          <div className="mt-3 flex items-start gap-2 rounded-2xl p-3" style={{ background: "rgba(124,58,237,0.06)" }}>
            <Bot size={16} className="mt-0.5" style={{ color: "var(--negis-ai)" }} />
            <p className="text-xs font-semibold leading-relaxed" style={{ color: "var(--negis-muted)" }}>
              AI помогает находить действия, но важные решения подтверждает пользователь.
            </p>
          </div>
        </header>

        {/* 2. Today metrics */}
        <section>
          <SectionTitle hint="Заявки, клиенты, записи и реклама — реальные данные. Выручка подключается после продаж.">Сегодня в клинике</SectionTitle>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {metrics.map((metric) => (
              <ControlMetricCard
                key={metric.label}
                label={metric.label}
                icon={metric.icon}
                tone={metric.tone}
                value={metric.value}
                hint={metric.hint}
                loading={metric.loading ?? false}
              />
            ))}
          </div>
        </section>

        {/* 3. Operational recommendations */}
        <section>
          <SectionTitle hint="Рекомендации формируются по данным CRM и системным статусам, без AI-прогнозов.">AI-рекомендации</SectionTitle>
          {loading ? (
            <div className="negis-glass p-5 text-sm font-semibold" style={{ color: "var(--negis-muted)" }}>Проверяем статусы…</div>
          ) : recommendations.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {recommendations.map((rec) => (
                <AIActionCard key={rec.title} {...rec} />
              ))}
            </div>
          ) : (
            <div className="negis-glass p-5 text-sm font-semibold leading-relaxed" style={{ color: "var(--negis-muted)" }}>
              Критичных CRM-действий пока нет.
            </div>
          )}
        </section>

        {/* 4. Quick actions */}
        <section className="negis-glass p-5">
          <SectionTitle>Быстрые действия</SectionTitle>
          <div className="flex flex-wrap gap-2">
            <QuickActionButton label="Открыть заявки" icon={Inbox} href="/leads" />
            <QuickActionButton label="Открыть клиентов" icon={Users} href="/clients" />
            <QuickActionButton label="Открыть записи" icon={CalendarCheck} href="/appointments" />
            <QuickActionButton label="Запустить рекламу" icon={Rocket} href="/ads-automation" />
            <QuickActionButton label="Открыть историю запусков" icon={ClipboardList} href="/ads-automation/history" />
            <QuickActionButton label="Открыть контент-студию" icon={Clapperboard} href="/content-studio" />
          </div>
        </section>

        {/* 5. Business flow strip */}
        <section className="negis-glass p-5">
          <SectionTitle hint="Стратегическая цепочка Negis OS.">Путь клиента</SectionTitle>
          <div className="flex flex-wrap items-stretch gap-2">
            {flowSteps.map((step, index) => (
              <div key={step.label} className="flex items-center gap-2">
                <BusinessFlowStep label={step.label} state={step.state} />
                {index < flowSteps.length - 1 ? <ArrowRight size={16} style={{ color: "var(--negis-muted)" }} /> : null}
              </div>
            ))}
          </div>
        </section>

        {/* 6 + 7. Ads health + system readiness */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <section className="negis-glass p-5">
            <SectionTitle>Реклама</SectionTitle>
            <div className="flex flex-wrap items-center gap-2">
              <span style={{ ...chipStyle, background: "rgba(16,185,129,0.12)", color: "var(--negis-success)" }}>Безопасный режим</span>
              <span style={{ ...chipStyle, background: "var(--negis-primary-soft)", color: "var(--negis-primary)" }}>Instagram</span>
            </div>
            {loading ? (
              <p className="mt-3 text-sm font-semibold" style={{ color: "var(--negis-muted)" }}>Загрузка…</p>
            ) : latest && latestMode ? (
              <div className="mt-3 space-y-1 text-sm font-semibold" style={{ color: "var(--negis-muted)" }}>
                <p>Последний запуск: <span style={{ color: "var(--negis-text)" }}>{launchModeLabel[latestMode]}</span></p>
                {latest.createdAt ? <p>Дата: <span style={{ color: "var(--negis-text)" }}>{new Date(latest.createdAt).toLocaleDateString("ru-RU")}</span></p> : null}
                <p>Тип креатива: <span style={{ color: "var(--negis-text)" }}>{str(asRecord(latest.payload).creativeType) === "video" ? "видео" : "фото"}</span></p>
                {str(asRecord(latest.payload).city) ? <p>Город: <span style={{ color: "var(--negis-text)" }}>{str(asRecord(latest.payload).city)}</span></p> : null}
                {str(asRecord(latest.payload).service) ? <p>Услуга: <span style={{ color: "var(--negis-text)" }}>{str(asRecord(latest.payload).service)}</span></p> : null}
              </div>
            ) : (
              <p className="mt-3 text-sm font-semibold" style={{ color: "var(--negis-text)" }}>Запусков пока нет.</p>
            )}
            <p className="mt-2 text-sm font-semibold leading-relaxed" style={{ color: "var(--negis-muted)" }}>
              Реклама в Negis OS создаётся выключенной. Включить её можно вручную в Meta Ads Manager.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href="/ads-automation">
                <button type="button" className="neu-btn-primary justify-center gap-2 px-5 py-2.5 text-sm">
                  <Rocket size={16} />
                  Открыть рекламу
                </button>
              </Link>
              <Link href="/ads-automation/history">
                <button type="button" className="neu-btn justify-center gap-2 px-5 py-2.5 text-sm">
                  <ClipboardList size={16} />
                  История запусков
                </button>
              </Link>
            </div>
          </section>

          <section className="negis-glass p-5">
            <SectionTitle hint="Реальные статусы систем. Технические детали доступны только администратору.">Готовность систем</SectionTitle>
            <div className="space-y-3">
              <HealthRow label="API" state={apiState} />
              <HealthRow label="Хранилище креативов" state={storageState} />
              <HealthRow label="Targeting Agent" state={targetingState} />
              <HealthRow label="Meta подключена" state={metaState} />
              <HealthRow label="Заявки" state={leadsState} />
              <HealthRow label="Клиенты" state={clientsState} />
              <HealthRow label="Записи" state={appointmentsState} />
              <HealthRow label="Продажи" state="pending" />
              <HealthRow label="AI-рекомендации" state="partial" />
            </div>
            <p className="mt-4 flex items-center gap-2 text-xs font-semibold" style={{ color: "var(--negis-muted)" }}>
              <MessageCircle size={14} style={{ color: "var(--negis-primary)" }} />
              Продажи и полный AI-слой подключаются следующими этапами.
            </p>
          </section>
        </div>

        <div className="rounded-2xl border p-4 text-sm font-semibold" style={{ borderColor: "var(--negis-warning)", background: "rgba(245,158,11,0.10)", color: "#8A5A00" }}>
          Полный AI Control Center собирается поэтапно: метрики и AI-рекомендации подключаются по мере готовности данных.
        </div>
      </div>
    </PageLayout>
  );
}

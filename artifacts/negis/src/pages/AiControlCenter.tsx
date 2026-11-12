import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "wouter";
import {
  ArrowRight,
  Bot,
  CalendarCheck,
  CalendarDays,
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
import { MetricCard } from "@/components/ui/metric-card";
import { PlatformRecommendations } from "@/components/crm/PlatformRecommendations";
import { WorkQueue } from "@/components/dashboard/work-queue";
import { RecentRecords } from "@/components/dashboard/recent-records";
import { DistributionPanel } from "@/components/dashboard/distribution-panel";
import { crmFetch } from "@/lib/api";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { capitalize, termsFor } from "../../../../lib/vertical/terms";
import { clinicToday, isOnClinicDay } from "@/lib/clinicDay";
import {
  buildLeadSourceDistribution,
  buildNewLeadsQueue,
  buildPendingDealsQueue,
  buildRecentRecords,
  buildUpcomingAppointmentsQueue,
  type DashboardRecord,
} from "@/lib/dashboardData";
import { hasSupabaseFrontendEnv, supabase, sessionAuth } from "@/lib/supabase";
import { getSignOutRevision, isSignOutPending } from "@/lib/authSignOut";
import { workspaceAllowsRoute } from "@/lib/workspaceRoutes";
import { isRealWorkspace } from "@/lib/demoStorage";
import { semanticGroupForLead } from "@/lib/leadPipeline";

// Операционный обзор (Medina OS UI-2) uses real workspace-scoped CRM
// collections and system health. Revenue comes only from paid deals for the
// current local date. Recommendations are rule-based operational signals, not
// AI predictions or campaign analytics. Work queues and recent records reuse
// the same single set of CRM responses — no extra requests.

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

function numberValue(value: unknown): number {
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : 0;
}

function formatRevenueMinor(amountMinor: number): string {
  const tenge = Math.max(0, amountMinor) / 100;
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(tenge)} ₸`;
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

type ControlAccess = {
  workspaceId: string;
  localDemo: boolean;
  isCurrent: () => boolean;
  request: (path: string, init?: RequestInit) => Promise<Response>;
};

async function fetchJson(access: ControlAccess, path: string): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  try {
    const response = await access.request(path);
    if (!response.ok) return { ok: false, body: {} };
    const text = await response.text();
    if (!access.isCurrent()) return { ok: false, body: {} };
    const body = asRecord(text ? JSON.parse(text) : null);
    return { ok: body.mode !== "demo", body };
  } catch {
    return { ok: false, body: {} };
  }
}

/* ── CRM data (real counts, no AI, no invented numbers) ─────── */

function isRepeatClient(status: string, lastVisit: string): boolean {
  const value = status.toLowerCase();
  if (/(неактив|inactive|arch)/.test(value)) return false;
  if (/(повтор|repeat|return|вернул)/.test(value)) return true;
  // Operational hint, not a medical rule: no visit for 90+ days suggests a follow-up.
  const visitTime = Date.parse(lastVisit);
  return Number.isFinite(visitTime) && Date.now() - visitTime > 90 * 24 * 60 * 60 * 1000;
}

// Прежняя версия сравнивала getFullYear/getMonth/getDate — то есть сутки
// ноутбука оператора. Два экрана отвечали на один вопрос по-разному, и оба не
// про клинику. Теперь общий помощник и пояс, приехавший вместе со списком.
function isTodayDate(value: string, dayKey: string, timeZone: string): boolean {
  return isOnClinicDay(value, dayKey, timeZone);
}

type CrmList = { responded: boolean; items: Array<Record<string, unknown>>; timeZone: string };

function isRecordList(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item));
}

const demoCollectionKeys: Record<string, string> = {
  leads: "negis_demo_leads", clients: "negis_demo_clients",
  appointments: "negis_demo_appointments", deals: "negis_demo_deals",
};

// Only explicit non-production demo Auth may read existing local collections.
// It never seeds storage, queries an endpoint, or falls back from a failed real read.
async function fetchCrmList(access: ControlAccess, path: string, listKey: string): Promise<CrmList> {
  if (access.localDemo) {
    try {
      if (!access.isCurrent()) throw new Error("Control view changed");
      const key = demoCollectionKeys[listKey];
      if (!key) throw new Error("Unknown demo collection");
      const raw = window.localStorage.getItem(key);
      const items: unknown = raw === null ? [] : JSON.parse(raw);
      if (!isRecordList(items)) throw new Error("Invalid demo collection");
      return { responded: true, items, timeZone: "" };
    } catch { return { responded: false, items: [], timeZone: "" }; }
  }
  const { ok, body } = await fetchJson(access, path);
  const data = asRecord(body.data);
  const rawItems = data[listKey];
  if (!ok || body.success !== true || body.mode !== "supabase" || !isRecordList(rawItems)) {
    return { responded: false, items: [], timeZone: "" };
  }
  return { responded: true, items: rawItems.map((item) => asRecord(item)), timeZone: str(data.timeZone) };
}

/* ── Presentational components ─────────────────────────────── */

type Priority = "high" | "medium" | "low";

const priorityMeta: Record<Priority, { label: string; tone: Tone }> = {
  high: { label: "Высокий", tone: "error" },
  medium: { label: "Средний", tone: "warning" },
  low: { label: "Низкий", tone: "muted" },
};

type Recommendation = { title: string; priority: Priority; explanation: string; action: string; openHref?: string };

function AIActionCard({
  title,
  priority,
  explanation,
  action,
  openHref,
  onCreateTask,
  creatingTask,
  taskDisabled,
}: Recommendation & { onCreateTask: () => void; creatingTask: boolean; taskDisabled: boolean }) {
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
        {/* Задачи давно подключены: рекомендация превращается в поручение
            одним нажатием, а не остаётся личным делом владельца. Мёртвой
            кнопки «Подробнее» больше нет — обещаний тут не вешают. */}
        <button type="button" className="neu-btn justify-center px-4 py-2 text-xs" disabled={taskDisabled || creatingTask} onClick={onCreateTask}>
          {creatingTask ? "Создаю…" : "Создать задачу"}
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

function UnavailableSection({ title }: { title: string }) {
  return <section className="neu p-4" aria-label={title}>
    <h3 className="text-sm font-semibold">{title}</h3>
    <p className="mt-3 text-sm" style={{ color: "var(--negis-muted)" }}>Не удалось загрузить данные.</p>
  </section>;
}

const chipStyle: CSSProperties = { borderRadius: 999, padding: "4px 12px", fontSize: 11, fontWeight: 800 };

const ONBOARDING_HINT_KEY = "negis_onboarding_hint_dismissed";

export default function AiControlCenter() {
  const auth = useAuth();
  const { user, clinicId, userRole, workspacePurpose, rolePermissions } = auth;
  const localDemo = auth.isDemoMode && !!clinicId && !isRealWorkspace(clinicId);
  const allowed = !auth.isLoading && !auth.isSigningOut && !auth.isImpersonation
    && (!auth.isDemoMode || localDemo)
    && !!user?.id && !!clinicId && userRole !== "lead_manager"
    && (userRole === "owner" || userRole === "manager" || !!rolePermissions.dashboard)
    && workspaceAllowsRoute(workspacePurpose, userRole, "/ai-control-center");
  const scopeKey = JSON.stringify([user?.id, clinicId, userRole, workspacePurpose, allowed, rolePermissions.tasks, localDemo]);
  const live = useRef(scopeKey);
  live.current = scopeKey;
  const observedActor = useRef(user?.id || "");
  const authObserved = useRef(false);
  const [authEpoch, setAuthEpoch] = useState(0);
  useLayoutEffect(() => {
    if (!hasSupabaseFrontendEnv || localDemo) return;
    const { data: { subscription } } = sessionAuth.onAuthStateChange((_event, session) => {
      authObserved.current = true;
      const next = session?.user.id || "";
      if (observedActor.current === next) return;
      observedActor.current = next;
      setAuthEpoch((value) => value + 1);
    });
    return () => subscription.unsubscribe();
  }, [localDemo]);
  if (!allowed || (!localDemo && authObserved.current && observedActor.current !== user?.id)) return null;
  return <AiControlLifetime key={`${scopeKey}:${authEpoch}`} actorId={user!.id} workspaceId={clinicId!} localDemo={localDemo} scopeKey={scopeKey} live={live} />;
}

function AiControlLifetime({ actorId, workspaceId, localDemo, scopeKey, live }: {
  actorId: string; workspaceId: string; localDemo: boolean; scopeKey: string; live: { current: string };
}) {
  const active = useRef<AbortController | null>(null);
  const retired = useRef(false);
  const [access, setAccess] = useState<ControlAccess | null>(null);
  useLayoutEffect(() => {
    const controller = new AbortController();
    const signOutRevision = getSignOutRevision();
    active.current = controller;
    const isCurrent = () => active.current === controller && !controller.signal.aborted && !retired.current
      && live.current === scopeKey && !isSignOutPending() && signOutRevision === getSignOutRevision();
    const retire = () => {
      retired.current = true;
      controller.abort();
      setAccess(null);
    };
    const subscription = hasSupabaseFrontendEnv && !localDemo ? sessionAuth.onAuthStateChange((_event, session) => {
      if ((session?.user.id || "") !== actorId) retire();
    }).data.subscription : null;
    setAccess({ workspaceId, localDemo, isCurrent, request: async (path, init) => {
      if (!isCurrent() || localDemo) throw new DOMException("Control request unavailable", "AbortError");
      const signal = init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
      const response = await crmFetch(path, {
        ...init, cache: "no-store", signal, expectedUserId: actorId, dispatchGuard: isCurrent,
      });
      signal.throwIfAborted();
      if (!isCurrent()) throw new DOMException("Control view changed", "AbortError");
      if ([401, 403].includes(response.status)) {
        retire();
        throw new DOMException("Control access ended", "AbortError");
      }
      return response;
    } });
    return () => { controller.abort(); subscription?.unsubscribe(); if (active.current === controller) active.current = null; };
  }, [actorId, workspaceId, localDemo, scopeKey, live]);
  if (!access || !access.isCurrent()) return null;
  return <AiControlSession key={access.workspaceId} access={access} />;
}

function AiControlSession({ access }: { access: ControlAccess }) {
  const { vertical, rolePermissions } = useAuth();
  const terms = termsFor(vertical);
  const todayLabel = new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
  // Задача из рекомендации: карточка «Требует внимания» становится поручением.
  const [creatingTaskFor, setCreatingTaskFor] = useState("");
  const pendingTask = useRef(false);
  const mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isCurrent = () => mounted.current && access.isCurrent();
  const createTaskFromRecommendation = async (rec: Recommendation) => {
    if (access.localDemo || !isCurrent() || pendingTask.current) return;
    pendingTask.current = true;
    setCreatingTaskFor(rec.title);
    try {
      const response = await access.request(`/api/crm/tasks?workspaceId=${encodeURIComponent(access.workspaceId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: access.workspaceId,
          title: rec.action || rec.title,
          status: "new",
          priority: rec.priority === "high" ? "high" : "medium",
        }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json().catch(() => null)) as { success?: boolean; mode?: string } | null;
      if (!isCurrent()) return;
      // 200 mode:"demo" — сервер ничего не записал: честный отказ, не успех.
      if (!response.ok || body?.success !== true || body.mode !== "supabase") {
        throw new Error(String(response.status));
      }
      toast.success("Задача создана — она в разделе задач на карточках заявок и клиентов");
    } catch (error) {
      if (!isCurrent()) return;
      console.warn("[control-center] task create refused", error instanceof Error ? error.message : error);
      toast.error("Не удалось создать задачу. Попробуйте позже.");
    } finally {
      if (isCurrent()) { pendingTask.current = false; setCreatingTaskFor(""); }
    }
  };
  // Commercial-2: dismissible onboarding reminder. Dismissal only hides this
  // card — step completion is derived from real data on /onboarding.
  const [showOnboardingHint, setShowOnboardingHint] = useState(
    () => typeof window !== "undefined" && window.localStorage.getItem(ONBOARDING_HINT_KEY) !== "1",
  );
  const dismissOnboardingHint = () => {
    if (access.localDemo || !isCurrent()) return;
    setShowOnboardingHint(false);
    try {
      window.localStorage.setItem(ONBOARDING_HINT_KEY, "1");
    } catch {
      // Storage unavailable — the card simply reappears next visit.
    }
  };

  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [launchesLoaded, setLaunchesLoaded] = useState(false);
  const [launches, setLaunches] = useState<LaunchItem[]>([]);
  const [apiState, setApiState] = useState<HealthState>("loading");
  const [storageState, setStorageState] = useState<HealthState>("loading");
  const [targetingState, setTargetingState] = useState<HealthState>("loading");
  const [metaState, setMetaState] = useState<HealthState>("loading");
  const [leadsState, setLeadsState] = useState<HealthState>("loading");
  const [clientsState, setClientsState] = useState<HealthState>("loading");
  const [appointmentsState, setAppointmentsState] = useState<HealthState>("loading");
  const [dealsState, setDealsState] = useState<HealthState>("loading");
  // UI-2: keep the fetched records for work queues, recency, and distribution.
  // Same responses as the counters — no additional requests.
  const [crmRecords, setCrmRecords] = useState<{
    leads: DashboardRecord[];
    clients: DashboardRecord[];
    appointments: DashboardRecord[];
    deals: DashboardRecord[];
  }>({ leads: [], clients: [], appointments: [], deals: [] });
  const [crmCounts, setCrmCounts] = useState({
    newLeads: 0,
    unprocessedLeads: 0,
    appointmentsToday: 0,
    repeatClients: 0,
    // CRM8 attribution counts remain separate from sales revenue.
    unattributedLeads: 0,
    // CRM9d: honest deal metrics only, never grouped by campaign.
    paidDealsToday: 0,
    revenueTodayMinor: 0,
    pendingDealsCount: 0,
    // CRM10: linked-revenue counts — manual attribution only, no ad-efficiency math.
    paidAttributedRevenueMinor: 0,
    paidUnattributedDealsCount: 0,
  });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const readAccess: ControlAccess = {
      ...access,
      isCurrent: () => !cancelled && isCurrent(),
      request: (path, init) => access.request(path, { ...init, signal: controller.signal }),
    };
    async function load() {
      const workspaceId = access.workspaceId;
      const workspaceQuery = `workspaceId=${encodeURIComponent(workspaceId)}`;
      // Independent fetches: one failing endpoint must not block the page.
      // Each unavailable collection stays unknown; no empty-success fallback.
      const remoteRead = (path: string) => access.localDemo
        ? Promise.resolve({ ok: false, body: {} as Record<string, unknown> })
        : fetchJson(readAccess, path);
      const [health, storage, targeting, launchesRes, leadsRes, clientsRes, appointmentsRes, dealsRes] = await Promise.all([
        remoteRead(`/api/crm/health?${workspaceQuery}`),
        remoteRead(`/api/crm/storage-health?${workspaceQuery}`),
        remoteRead(`/api/targeting/health?${workspaceQuery}`),
        remoteRead(`/api/crm/meta-launches?${workspaceQuery}`),
        fetchCrmList(readAccess, `/api/crm/leads?${workspaceQuery}`, "leads"),
        fetchCrmList(readAccess, `/api/crm/clients?${workspaceQuery}`, "clients"),
        fetchCrmList(readAccess, `/api/crm/appointments?${workspaceQuery}`, "appointments"),
        fetchCrmList(readAccess, `/api/crm/deals?${workspaceQuery}`, "deals"),
      ]);
      if (cancelled || !isCurrent()) return;
      const launchData = asRecord(launchesRes.body.data);
      const launchList = launchData.launches ?? launchData.items;
      const launchesResponded = launchesRes.ok && launchesRes.body.success === true
        && launchesRes.body.mode === "supabase" && isRecordList(launchList);
      setLoadFailed(![leadsRes, clientsRes, appointmentsRes, dealsRes].every((result) => result.responded)
        || (!access.localDemo && !launchesResponded));

      // Сутки клиники, а не сутки ноутбука: пояс приезжает вместе с записями.
      const clinicTimeZone = appointmentsRes.timeZone;
      const clinicDayKey = clinicToday(clinicTimeZone);

      // CRM counts — real data only; failed endpoints stay "Не удалось проверить".
      setLeadsState(leadsRes.responded ? "ready" : "unknown");
      setClientsState(clientsRes.responded ? "ready" : "unknown");
      setAppointmentsState(appointmentsRes.responded ? "ready" : "unknown");
      setDealsState(dealsRes.responded ? "ready" : "unknown");
      setCrmRecords({
        leads: leadsRes.items,
        clients: clientsRes.items,
        appointments: appointmentsRes.items,
        deals: dealsRes.items,
      });
      const paidDealsToday = appointmentsRes.responded ? dealsRes.items.filter((deal) =>
        str(deal.status).toLowerCase() === "paid"
        && isTodayDate(str(deal.paidAt) || str(deal.paid_at), clinicDayKey, clinicTimeZone),
      ) : [];
      setCrmCounts({
        newLeads: leadsRes.items.filter((lead) => semanticGroupForLead(lead) === "new").length,
        unprocessedLeads: leadsRes.items.filter((lead) => {
          const status = semanticGroupForLead(lead);
          const hasClient = Boolean(str(lead.clientId) || str(lead.client_id));
          return !hasClient && (status === "new" || status === "in_progress");
        }).length,
        appointmentsToday: appointmentsRes.items.filter((item) =>
          isTodayDate(str(item.startsAt) || str(item.starts_at) || str(item.time), clinicDayKey, clinicTimeZone),
        ).length,
        repeatClients: clientsRes.items.filter((client) =>
          isRepeatClient(str(client.status), str(client.lastVisit) || str(client.last_visit_at)),
        ).length,
        // Attributed = lead linked to a Meta launch via meta_campaign_launch_id.
        unattributedLeads: leadsRes.items.filter((lead) => !(str(lead.metaCampaignLaunchId) || str(lead.meta_campaign_launch_id))).length,
        paidDealsToday: paidDealsToday.length,
        revenueTodayMinor: paidDealsToday.reduce(
          (sum, deal) => sum + Math.max(0, Math.round(numberValue(deal.amountMinor ?? deal.amount_minor))),
          0,
        ),
        pendingDealsCount: dealsRes.items.filter((deal) => str(deal.status).toLowerCase() === "pending").length,
        // Linked share of today's revenue (manual attribution, not effectiveness).
        paidAttributedRevenueMinor: paidDealsToday
          .filter((deal) => Boolean(str(deal.metaCampaignLaunchId) || str(deal.meta_campaign_launch_id)))
          .reduce((sum, deal) => sum + Math.max(0, Math.round(numberValue(deal.amountMinor ?? deal.amount_minor))), 0),
        // All paid deals still missing a campaign link (any date) — drives the recommendation.
        paidUnattributedDealsCount: dealsRes.items.filter((deal) =>
          str(deal.status).toLowerCase() === "paid"
          && !(str(deal.metaCampaignLaunchId) || str(deal.meta_campaign_launch_id)),
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
      setTargetingState(targeting.ok && targeting.body.success === true ? "ready" : "unknown");

      // Ad launches
      if (launchesResponded) {
        const list = launchList as LaunchItem[];
        const sorted = [...list].sort((a, b) => str(b.createdAt).localeCompare(str(a.createdAt)));
        setLaunches(sorted);
        setLaunchesLoaded(true);
      }

      setLoading(false);
    }
    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [access]);

  const latest = launches[0];
  const latestMode = latest ? classifyLaunch(latest) : null;
  const failedCount = launches.filter((item) => classifyLaunch(item) === "failed").length;

  // UI-2 work queues and honest recency — pure derivations over the fetched records.
  const todayIso = new Date().toISOString();
  const newLeadsQueue = buildNewLeadsQueue(crmRecords.leads);
  const upcomingAppointmentsQueue = buildUpcomingAppointmentsQueue(crmRecords.appointments, todayIso);
  const pendingDealsQueue = buildPendingDealsQueue(crmRecords.deals);
  const recentRecords = buildRecentRecords({
    lead: crmRecords.leads,
    client: crmRecords.clients,
    appointment: crmRecords.appointments,
    deal: crmRecords.deals,
  });
  const leadSourceSlices = buildLeadSourceDistribution(crmRecords.leads);
  const revenueState = dealsState === "ready" ? appointmentsState : dealsState;
  const recentUnavailable = [leadsState, clientsState, appointmentsState, dealsState].includes("unknown");

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
      label: `${capitalize(terms.customerPlural)} для повторного визита`,
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
        : loading ? "Проверяем статусы запусков…" : "Не удалось проверить",
      loading,
    },
    {
      label: "Выручка сегодня",
      icon: DollarSign,
      tone: crmCounts.paidDealsToday > 0 ? "success" : "muted",
      value: revenueState === "ready" ? formatRevenueMinor(crmCounts.revenueTodayMinor) : undefined,
      // CRM10: the linked share is manually attributed revenue, not ad effectiveness.
      hint: revenueState === "unknown"
        ? "Не удалось проверить"
        : revenueState === "ready"
          ? crmCounts.paidAttributedRevenueMinor > 0
            ? `По оплаченным продажам за сегодня. Из них с рекламой: ${formatRevenueMinor(crmCounts.paidAttributedRevenueMinor)} (связано вручную).`
            : "По оплаченным продажам за сегодня."
          : "Загружаем данные CRM…",
      loading: revenueState === "loading",
    },
  ];

  const flowSteps: Array<{ label: string; state: FlowState }> = [
    { label: "Реклама", state: "active" },
    { label: "Заявка", state: "active" },
    { label: "CRM", state: "active" },
    { label: "Запись", state: "active" },
    { label: "Продажа", state: dealsState === "ready" ? "active" : "pending" },
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
  if (dealsState === "ready" && crmCounts.pendingDealsCount > 0) {
    recommendations.push({
      title: "Подтвердите оплату продаж",
      priority: "medium",
      explanation: `Есть продажи в статусе ожидания оплаты: ${crmCounts.pendingDealsCount}.`,
      action: "Открыть продажи",
      openHref: "/sales",
    });
  }
  // CRM10: only when the deals endpoint answered and paid deals miss a campaign link.
  // Hidden when there are no paid deals or all of them are attributed.
  if (dealsState === "ready" && crmCounts.paidUnattributedDealsCount > 0) {
    recommendations.push({
      title: "Свяжите продажи с рекламными кампаниями",
      priority: "low",
      explanation: `Есть оплаченные продажи без рекламной кампании: ${crmCounts.paidUnattributedDealsCount}. Это поможет позже считать эффективность рекламы.`,
      action: "Открыть продажи",
      openHref: "/sales",
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
  // CRM8: only when leads exist and some are missing attribution — no CPL/ROI math.
  if (crmCounts.unattributedLeads > 0) {
    recommendations.push({
      title: "Свяжите заявки с рекламными кампаниями",
      priority: "low",
      explanation: `Заявок без рекламной кампании: ${crmCounts.unattributedLeads}. Это поможет позже считать эффективность рекламы.`,
      action: "Открыть заявки",
      openHref: "/leads",
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
        {/* 1. Page header */}
        <header className="flex flex-col gap-2 border-b pb-5" style={{ borderColor: "var(--negis-border)" }}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--negis-primary)" }}>Medina OS</span>
            <span aria-hidden style={{ color: "var(--negis-border)" }}>·</span>
            <span className="text-xs font-medium" style={{ color: "var(--negis-muted)" }}>Сегодня · {todayLabel}</span>
          </div>
          <h1 className="text-2xl font-semibold leading-tight" style={{ color: "var(--negis-text)" }}>Операционный обзор</h1>
          <p className="max-w-3xl text-sm leading-relaxed" style={{ color: "var(--negis-muted)" }}>
            Заявки, записи, продажи, реклама и состояние систем — реальные данные {terms.orgGenitive}.
          </p>
        </header>
        {loadFailed ? <p role="alert" className="text-sm">Не удалось загрузить часть данных обзора. Попробуйте позже.</p> : null}

        {/* Календарь — в одно нажатие с главного экрана: журнал записей и
            есть рабочий стол салона, дашборд лишь прихожая перед ним. */}
        {rolePermissions.booking ? (
          <section className="neu flex flex-wrap items-center justify-between gap-3 p-4" aria-label="Календарь записей">
            <p className="min-w-0 text-sm" style={{ color: "var(--negis-muted)" }}>
              <span className="font-semibold" style={{ color: "var(--negis-text)" }}>Календарь записей.</span>{" "}
              Свободное время, запись в два касания и день целиком.
            </p>
            <Link href="/appointments">
              <span className="neu-btn-primary inline-flex cursor-pointer items-center gap-2 text-sm">
                <CalendarDays size={16} />
                Открыть календарь
              </span>
            </Link>
          </section>
        ) : null}

        {/* Советы владельца платформы: карточки видят владелец, админ и
            управляющий; при неприменённой миграции или любом сбое секция
            просто отсутствует. */}
        {!access.localDemo ? <PlatformRecommendations /> : null}

        {/* Commercial-2: onboarding entry card (dismissible; never marks setup done) */}
        {showOnboardingHint && !access.localDemo ? (
          <section className="neu flex flex-wrap items-center justify-between gap-3 p-4" aria-label="Настройка клиники">
            <p className="min-w-0 text-sm" style={{ color: "var(--negis-muted)" }}>
              <span className="font-semibold" style={{ color: "var(--negis-text)" }}>Продолжите настройку клиники.</span>{" "}
              Профиль, сотрудники и первая заявка — статусы шагов рассчитываются по реальным данным.
            </p>
            <div className="flex shrink-0 gap-2">
              <Link href="/onboarding">
                <span className="neu-btn-primary inline-flex cursor-pointer items-center text-sm">Открыть настройку</span>
              </Link>
              <button type="button" className="neu-btn text-sm" onClick={dismissOnboardingHint}>
                Скрыть
              </button>
            </div>
          </section>
        ) : null}

        {/* 2. Today metrics */}
        <section>
          <SectionTitle hint={`Заявки, клиенты, записи, продажи и реклама — реальные данные ${terms.orgGenitive}.`}>Сегодня в {terms.orgPrepositional}</SectionTitle>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {metrics.map((metric) => (
              <MetricCard
                key={metric.label}
                label={metric.label}
                icon={metric.icon}
                tone={metric.tone}
                value={metric.value}
                delta={metric.hint ?? EMPTY_METRIC_HINT}
                loading={metric.loading ?? false}
              />
            ))}
          </div>
        </section>

        {/* 3. Attention summary — rule-based signals from real data */}
        <section>
          <SectionTitle hint="Рекомендации формируются по данным CRM и системным статусам, без AI-прогнозов.">Требует внимания</SectionTitle>
          {loading ? (
            <div className="negis-glass p-5 text-sm font-semibold" style={{ color: "var(--negis-muted)" }}>Проверяем статусы…</div>
          ) : recommendations.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {recommendations.map((rec) => (
                <AIActionCard
                  key={rec.title}
                  {...rec}
                  onCreateTask={() => void createTaskFromRecommendation(rec)}
                  creatingTask={creatingTaskFor === rec.title}
                  taskDisabled={access.localDemo}
                />
              ))}
            </div>
          ) : (
            <div className="negis-glass p-5 text-sm font-semibold leading-relaxed" style={{ color: "var(--negis-muted)" }}>
              {loadFailed ? "Не удалось проверить все CRM-действия." : "Критичных CRM-действий пока нет."}
            </div>
          )}
        </section>

        {/* 3b. Work queues — same CRM responses, no extra requests */}
        <section>
          <SectionTitle hint="Ближайшая работа по реальным записям CRM.">Очереди работы</SectionTitle>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {leadsState === "unknown" ? <UnavailableSection title="Новые заявки" /> : <WorkQueue
              title="Новые заявки"
              items={newLeadsQueue}
              loading={loading}
              emptyText="Новых заявок нет."
              href="/leads"
            />}
            {appointmentsState === "unknown" ? <UnavailableSection title="Ближайшие записи" /> : <WorkQueue
              title="Ближайшие записи"
              items={upcomingAppointmentsQueue}
              loading={loading}
              emptyText="Запланированных записей нет."
              href="/appointments"
            />}
            {dealsState === "unknown" ? <UnavailableSection title="Неоплаченные продажи" /> : <WorkQueue
              title="Неоплаченные продажи"
              items={pendingDealsQueue}
              loading={loading}
              emptyText="Продаж в ожидании оплаты нет."
              href="/sales"
            />}
          </div>
        </section>

        {/* 3c. Distribution + honest recency */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {leadsState === "unknown" ? <UnavailableSection title="Заявки по источникам" /> : <DistributionPanel
            title="Заявки по источникам"
            hint="Распределение всех загруженных заявок по источнику обращения."
            slices={leadSourceSlices}
            loading={loading}
          />}
          {recentUnavailable ? <UnavailableSection title="Недавно созданные записи" /> : <RecentRecords records={recentRecords} loading={loading} />}
        </div>

        {/* 4. Quick actions */}
        <section className="negis-glass p-5">
          <SectionTitle>Быстрые действия</SectionTitle>
          <div className="flex flex-wrap gap-2">
            <QuickActionButton label="Открыть заявки" icon={Inbox} href="/leads" />
            <QuickActionButton label="Открыть клиентов" icon={Users} href="/clients" />
            <QuickActionButton label="Открыть записи" icon={CalendarCheck} href="/appointments" />
            <QuickActionButton label="Открыть продажи" icon={DollarSign} href="/sales" />
            <QuickActionButton label="Запустить рекламу" icon={Rocket} href="/ads-automation" />
            <QuickActionButton label="Открыть историю запусков" icon={ClipboardList} href="/ads-automation/history" />
            <QuickActionButton label="Открыть контент-студию" icon={Clapperboard} href="/content-studio" />
          </div>
        </section>

        {/* 5. Business flow strip */}
        <section className="negis-glass p-5">
          <SectionTitle hint="Операционная цепочка клиники.">Путь клиента</SectionTitle>
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
            ) : !launchesLoaded ? (
              <p className="mt-3 text-sm font-semibold" style={{ color: "var(--negis-muted)" }}>Не удалось проверить статусы запусков.</p>
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
              Реклама в Medina OS создаётся выключенной. Включить её можно вручную в Meta Ads Manager.
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
              {/* CRM7: leads can link to launch records; CPL/analytics come later. */}
              <HealthRow label="Атрибуция рекламы" state={leadsState === "ready" && launchesLoaded ? "partial" : "pending"} />
              <HealthRow label="Продажи" state={dealsState} />
            </div>
          </section>
        </div>
      </div>
    </PageLayout>
  );
}

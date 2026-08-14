import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { PlanCalculator } from "@/components/admin/PlanCalculator";
import { VerticalSwitch } from "@/components/admin/VerticalSwitch";
import {
  AlertTriangle,
  Bot,
  BrainCircuit,
  Building2,
  CheckCircle2,
  ClipboardCheck,
  Copy,
  Database,
  Facebook,
  FileCheck2,
  Gauge,
  Loader2,
  Megaphone,
  MessageCircle,
  RefreshCw,
  Rocket,
  Save,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { PageLayout } from "@/components/layout/PageLayout";
import { MetricCard } from "@/components/ui/metric-card";
import { WhatsAppChannels } from "@/components/admin/WhatsAppChannels";
import { DoctorSchedule } from "@/components/admin/DoctorSchedule";
import { useAuth } from "@/contexts/AuthContext";
import { apiUrl, crmFetch } from "@/lib/api";
import { readWorkspaceId, workspaceScopedKey } from "@/lib/demoStorage";
import { getSupabaseAccessToken } from "@/lib/serverAuth";
import {
  permissionLabels,
  permissionsForRole,
  roleLabels,
  staffRoles,
  type CrmPermission,
  type StaffRole,
} from "@/lib/permissions";
import { KZ_META_CITY_OPTIONS, getKzMetaCityOption, type MetaCitySearchCandidate } from "../../../../lib/meta/cities";
import { capitalize, termsFor } from "../../../../lib/vertical/terms";

type StaffInvitation = {
  id: string;
  email: string;
  role: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  createdAt: string;
};

type AdminTab =
  | "overview"
  | "staff"
  | "doctors"
  | "roles"
  | "clinic"
  | "whatsapp"
  | "integrations"
  | "ai"
  | "meta"
  | "release"
  | "diagnostics";

type Status = "configured" | "connected" | "not_configured" | "partial" | "error" | "checking" | "demo" | "draft";
type ReleaseStatus = "pending" | "passed" | "failed" | "skipped";

type ApiResponse<T> = {
  success?: boolean;
  mode?: string;
  data?: T;
  error?: string;
  warning?: string;
  details?: string[];
  telegramDescription?: string;
  hint?: string;
};

type AdminAuthContextData = {
  workspaceId: string;
  role: "owner" | "admin";
  staffUserId: string;
  isAdmin: boolean;
};

type ServerAdminAuthState = {
  status: "checking" | "confirmed" | "reauth" | "forbidden" | "unavailable";
  role?: "owner" | "admin";
};

type ProviderPresence = {
  status: Status;
  configured: number;
  total: number;
};

type CrmHealthData = {
  status: string;
  service: string;
  generatedAt: string;
  providers: Record<string, ProviderPresence | { status: Status; env: ProviderPresence }>;
  meta?: SafeMetaSummary;
};

type SafeMetaSummary = {
  configured: boolean;
  businessIdConfigured: boolean;
  adAccountConfigured: boolean;
  pageConfigured: boolean;
  instagramActorConfigured: boolean;
  astanaCityKeyConfigured?: boolean;
  cityResolver?: {
    staticCities?: string[];
    cache?: string;
    targetingSearchFallback?: boolean;
    targetingSearch?: boolean;
  };
  hasAccessToken: boolean;
  hasAppSecret: boolean;
};

type MetaCityKeyResult = {
  city?: string;
  cityId?: string;
  labelRu?: string;
  canonicalName?: string;
  key?: string | null;
  name?: string;
  country_code?: string;
  countryCode?: string;
  region?: string;
  source?: string;
  selected?: MetaCitySearchCandidate | null;
  candidates?: MetaCitySearchCandidate[];
  rejectedCandidates?: MetaCitySearchCandidate[];
  warning?: string;
  geoMode?: string;
  fallbackCountry?: boolean;
};

type StorageHealth = {
  bucket?: string;
  exists?: boolean;
  publicAccess?: boolean;
  canUpload?: boolean;
  publicUrlWorks?: boolean;
  hint?: string;
};

type StaffMember = {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: StaffRole;
  status: string;
};

type ClinicSettings = {
  clinicName: string;
  city: string;
  phone: string;
  whatsapp: string;
  address: string;
  defaultServices: string;
  brandTone: string;
  legalDisclaimer: string;
  timezone: string;
};

type IntegrationCard = {
  key: string;
  title: string;
  description: string;
  status: Status;
  icon: LucideIcon;
  details?: string;
  hint?: string;
};

type AiProviderSetting = {
  id: string;
  purpose: string;
  label: string;
  provider: string;
  modelName: string;
  enabled: boolean;
  status: Status;
  module: string;
};

type MetaAccount = {
  metaBusinessId: string;
  adAccountId: string;
  pageId: string;
  instagramActorId: string;
  accountName: string;
  currency: string;
  timezoneName: string;
  status: Status;
  permissions: Record<string, boolean>;
};

type MetaInsightsLaunchOption = {
  id: string;
  campaignName: string;
  status: string;
  metaStatus: string;
  metaCampaignId: string;
  createdAt?: string;
};

type MetaInsightsSyncRun = {
  id: string;
  metaCampaignLaunchId: string | null;
  status: "pending" | "running" | "succeeded" | "failed";
  dateStart: string | null;
  dateStop: string | null;
  rowsUpserted: number;
  errorCode: string | null;
  errorMessage: string | null;
  finishedAt: string | null;
  createdAt: string | null;
};

type MetaInsightsSyncResult = {
  run: MetaInsightsSyncRun;
  rowsUpserted: number;
  empty: boolean;
  pagesFetched: number;
  dateStart: string;
  dateStop: string;
};

type MetaCampaignInsight = {
  id: string;
  metaCampaignLaunchId: string;
  metaCampaignId: string;
  dateStart: string;
  dateStop: string;
  spendMinor: string;
  currency: string;
  impressions: string;
  reach: string;
  clicks: string;
  inlineLinkClicks: string;
  metaLeads: string | null;
  actionCounts: Record<string, string>;
  fetchedAt: string;
};

type MetaInsightsDiagnosticsSummary = {
  totalRows: number;
  latestFetchedAt: string | null;
  spendByCurrency: Array<{ currency: string; spendMinor: bigint }>;
};

type ReleaseCheck = {
  checkKey: string;
  title: string;
  critical: boolean;
  status: ReleaseStatus;
  notes: string;
  automated?: boolean;
};

const tabs: Array<{ id: AdminTab; label: string; icon: LucideIcon }> = [
  { id: "overview", label: "Обзор", icon: Gauge },
  { id: "staff", label: "Сотрудники", icon: Users },
  { id: "doctors", label: "Врачи", icon: Stethoscope },
  { id: "roles", label: "Роли и доступы", icon: ShieldCheck },
  { id: "clinic", label: "Клиника", icon: Building2 },
  { id: "whatsapp", label: "WhatsApp", icon: MessageCircle },
  { id: "integrations", label: "Интеграции", icon: Database },
  { id: "ai", label: "Нейросети", icon: Sparkles },
  { id: "meta", label: "Meta/Facebook Ads", icon: Facebook },
  { id: "release", label: "Release checklist", icon: ClipboardCheck },
  { id: "diagnostics", label: "Диагностика", icon: FileCheck2 },
];

const clinicDefaults: ClinicSettings = {
  clinicName: "Concept Med Clinic",
  city: "Astana",
  phone: "+7 700 000 00 00",
  whatsapp: "+7 700 000 00 00",
  address: "Astana, Kazakhstan",
  defaultServices: "Консультация, диагностика, первичный прием",
  brandTone: "Спокойный, экспертный, заботливый",
  legalDisclaimer: "Информация не является медицинской рекомендацией. Перед процедурой нужна консультация специалиста.",
  timezone: "Asia/Almaty",
};

const aiDefaults: AiProviderSetting[] = [
  {
    id: "content-text-openai",
    purpose: "content_text",
    label: "Content text generation",
    provider: "openai",
    modelName: "gpt-4.1-mini",
    enabled: true,
    status: "demo",
    module: "Content Studio",
  },
  {
    id: "targeting-anthropic",
    purpose: "targeting_analysis",
    label: "Targeting Agent analysis",
    provider: "anthropic",
    modelName: "claude-sonnet",
    enabled: true,
    status: "demo",
    module: "Targeting Agent",
  },
  {
    id: "image-prompt-gemini",
    purpose: "image_prompt",
    label: "Image prompt generation",
    provider: "gemini",
    modelName: "gemini-pro",
    enabled: false,
    status: "demo",
    module: "Content Studio",
  },
  {
    id: "voice-elevenlabs",
    purpose: "voice_generation",
    label: "Voice generation",
    provider: "elevenlabs",
    modelName: "manual-fallback",
    enabled: false,
    status: "demo",
    module: "Content Studio",
  },
  {
    id: "avatar-heygen",
    purpose: "avatar_video",
    label: "Avatar/video",
    provider: "heygen",
    modelName: "manual-fallback",
    enabled: false,
    status: "demo",
    module: "Content Studio",
  },
  {
    id: "reports-openai",
    purpose: "reports_summary",
    label: "Reports summary",
    provider: "openai",
    modelName: "demo-fallback",
    enabled: false,
    status: "demo",
    module: "Reports",
  },
];

const metaDefaults: MetaAccount = {
  metaBusinessId: "",
  adAccountId: "",
  pageId: "",
  instagramActorId: "",
  accountName: "Concept Med demo ad account",
  currency: "USD",
  timezoneName: "Asia/Almaty",
  status: "draft",
  permissions: {
    appCreated: false,
    marketingApi: false,
    adsRead: false,
    adsManagement: false,
    adAccountConnected: false,
    pageConnected: false,
    instagramConnected: false,
    manualApproval: true,
  },
};

const permissionChecklist: Array<{ key: keyof MetaAccount["permissions"]; label: string }> = [
  { key: "appCreated", label: "Meta Business app created" },
  { key: "marketingApi", label: "Marketing API access enabled" },
  { key: "adsRead", label: "ads_read available" },
  { key: "adsManagement", label: "ads_management available" },
  { key: "adAccountConnected", label: "Ad account connected" },
  { key: "pageConnected", label: "Facebook Page connected" },
  { key: "instagramConnected", label: "Instagram account connected" },
  { key: "manualApproval", label: "Manual approval enabled" },
];

const releaseDefaults: ReleaseCheck[] = [
  { checkKey: "supabase_configured", title: "Supabase configured", critical: true, status: "pending", notes: "", automated: true },
  { checkKey: "migrations_009_013", title: "Supabase migrations 009/010/011/012/013 applied", critical: false, status: "pending", notes: "" },
  { checkKey: "vercel_env", title: "Vercel env basic configured", critical: true, status: "pending", notes: "", automated: true },
  { checkKey: "staff_auth_env", title: "Staff auth env configured", critical: true, status: "pending", notes: "", automated: true },
  { checkKey: "staff_login", title: "Supabase Auth staff login tested", critical: true, status: "pending", notes: "" },
  { checkKey: "staff_users", title: "Staff users created", critical: false, status: "pending", notes: "" },
  { checkKey: "roles_checked", title: "Roles checked", critical: false, status: "pending", notes: "" },
  { checkKey: "telegram_test", title: "Telegram test passed", critical: true, status: "pending", notes: "", automated: true },
  { checkKey: "targeting_health", title: "Targeting Agent health passed", critical: true, status: "pending", notes: "", automated: true },
  { checkKey: "openai_env", title: "OpenAI configured", critical: false, status: "pending", notes: "", automated: true },
  { checkKey: "meta_env", title: "Meta env configured", critical: false, status: "pending", notes: "", automated: true },
  { checkKey: "content_script", title: "Content Studio generate script passed", critical: false, status: "pending", notes: "" },
  { checkKey: "appointments_tested", title: "Appointments create/edit tested", critical: true, status: "pending", notes: "" },
  { checkKey: "mobile_test", title: "Mobile test passed", critical: false, status: "pending", notes: "" },
  { checkKey: "backup_export", title: "Backup/export strategy ready", critical: false, status: "pending", notes: "" },
  { checkKey: "owner_account", title: "Admin owner account ready", critical: false, status: "pending", notes: "" },
  { checkKey: "employee_day", title: "Test employee day completed", critical: false, status: "pending", notes: "" },
];

const criticalBlockerKeys = new Set([
  "supabase_configured",
  "vercel_env",
  "staff_auth_env",
  "staff_login",
  "telegram_test",
  "targeting_health",
  "appointments_tested",
]);

const envList = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
  "HEYGEN_API_KEY",
  "TAPNOW_API_KEY",
];

// Selection-2: every key these two touch holds one clinic's data — its
// settings, its Meta ad account and page ids, its release checklist, its AI
// providers — so the scope belongs here rather than at fourteen call sites.
// Unscoped, switching clinics showed the previous clinic's Meta ids on the new
// clinic's admin screen, and saving the form wrote them to the new clinic.
function readStored<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(workspaceScopedKey(key));
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStored<T>(key: string, value: T) {
  window.localStorage.setItem(workspaceScopedKey(key), JSON.stringify(value));
}

function mergeReleaseChecks(stored: ReleaseCheck[]): ReleaseCheck[] {
  const storedByKey = new Map(stored.map((check) => [check.checkKey, check]));
  const defaults = releaseDefaults.map((defaultCheck) => ({
    ...defaultCheck,
    ...storedByKey.get(defaultCheck.checkKey),
    title: defaultCheck.title,
    critical: criticalBlockerKeys.has(defaultCheck.checkKey),
    automated: defaultCheck.automated,
  }));
  const custom = stored.filter((check) => !releaseDefaults.some((defaultCheck) => defaultCheck.checkKey === check.checkKey));
  return [...defaults, ...custom.map((check) => ({ ...check, critical: criticalBlockerKeys.has(check.checkKey) }))];
}

function hasMetaFormValues(account: MetaAccount): boolean {
  return Boolean(
    account.metaBusinessId.trim() ||
      account.adAccountId.trim() ||
      account.pageId.trim() ||
      account.instagramActorId.trim(),
  );
}

async function safeJson<T>(response: globalThis.Response): Promise<ApiResponse<T>> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as ApiResponse<T>;
  } catch {
    return {
      success: false,
      error: "Invalid JSON response",
      details: [text.slice(0, 160)],
    };
  }
}

// Security-2D: Content Studio is authenticated now, and the workspace travels as
// a query selector the server verifies against the caller's membership — never
// as a field in the body.
function withWorkspace(path: string): string {
  const workspaceId = readWorkspaceId();
  return `${path}${path.includes("?") ? "&" : "?"}workspaceId=${encodeURIComponent(workspaceId)}`;
}

// Security-2B: same reason as AdsAutomation — the token belongs to crmFetch,
// not to each call site. adminCrmRequest below stays separate because it also
// refuses to run at all without a session.
async function crmRequest<T>(path: string, init?: globalThis.RequestInit): Promise<ApiResponse<T>> {
  const response = await crmFetch(path, init);
  const body = await safeJson<T>(response);
  if (!response.ok || body.success === false) {
    throw new Error(body.error || body.details?.join(", ") || `HTTP ${response.status}`);
  }
  return body;
}

async function adminCrmRequest<T>(
  path: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<ApiResponse<T>> {
  // The session is checked up front so the operator gets this message rather
  // than a bare 401; crmFetch then resolves and attaches the token itself.
  const accessToken = await getSupabaseAccessToken();
  if (!accessToken) throw new Error("Нужно войти заново для защищённой синхронизации.");

  const response = await crmFetch(path, { ...init, accessToken });
  const body = await safeJson<T>(response);
  if (!response.ok || body.success !== true) {
    throw new Error(body.details?.[0] || body.error || `HTTP ${response.status}`);
  }
  return body;
}

function localIsoDateOffset(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function summarizeMetaInsightRows(rows: MetaCampaignInsight[]): MetaInsightsDiagnosticsSummary {
  const spendByCurrency = new Map<string, bigint>();
  let latestFetchedAt: string | null = null;
  let latestFetchedTimestamp = Number.NEGATIVE_INFINITY;

  for (const row of rows) {
    const currency = row.currency.trim().toUpperCase();
    if (currency && /^\d+$/.test(row.spendMinor)) {
      spendByCurrency.set(currency, (spendByCurrency.get(currency) || 0n) + BigInt(row.spendMinor));
    }

    const fetchedTimestamp = Date.parse(row.fetchedAt);
    if (Number.isFinite(fetchedTimestamp) && fetchedTimestamp > latestFetchedTimestamp) {
      latestFetchedTimestamp = fetchedTimestamp;
      latestFetchedAt = row.fetchedAt;
    }
  }

  return {
    totalRows: rows.length,
    latestFetchedAt,
    spendByCurrency: [...spendByCurrency.entries()]
      .map(([currency, spendMinor]) => ({ currency, spendMinor }))
      .sort((left, right) => left.currency.localeCompare(right.currency)),
  };
}

function formatMetaSpendMinor(spendMinor: bigint, currency: string): string {
  const major = spendMinor / 100n;
  const minor = (spendMinor % 100n).toString().padStart(2, "0");
  const majorLabel = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(major);
  const currencyLabel = currency === "KZT" ? "₸" : currency === "USD" ? "$" : currency;
  return `${majorLabel},${minor} ${currencyLabel}`;
}

function formatAdminDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function statusLabel(status: Status | ReleaseStatus) {
  const labels: Record<string, string> = {
    configured: "Настроено",
    connected: "Подключено",
    not_configured: "Не настроено",
    partial: "Частично",
    error: "Ошибка",
    checking: "Проверяется",
    demo: "Без подключения",
    draft: "Draft",
    pending: "Ожидает",
    passed: "Пройдено",
    failed: "Проблема",
    skipped: "Пропущено",
  };
  return labels[status] || status;
}

function statusClass(status: Status | ReleaseStatus) {
  if (status === "configured" || status === "connected" || status === "passed") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (status === "partial" || status === "draft" || status === "demo" || status === "skipped") return "bg-amber-50 text-amber-700 border-amber-200";
  if (status === "error" || status === "failed") return "bg-red-50 text-red-700 border-red-200";
  return "bg-slate-50 text-slate-600 border-slate-200";
}

function localStorageCount(key: string) {
  const value = readStored<unknown[]>(key, []);
  return Array.isArray(value) ? value.length : 0;
}

function providerStatus(health: CrmHealthData | null, key: string): Status {
  const item = health?.providers?.[key];
  if (!item) return "not_configured";
  if ("env" in item) return item.status;
  return item.status;
}

function providerDetails(health: CrmHealthData | null, key: string): string {
  const item = health?.providers?.[key];
  if (!item) return "Env не проверен";
  const presence = "env" in item ? item.env : item;
  return `${presence.configured}/${presence.total} env configured`;
}

function isProviderConfigured(health: CrmHealthData | null, key: string): boolean {
  return providerStatus(health, key) === "configured";
}

function permissionSummary(permissions: CrmPermission[]) {
  return permissions.map((permission) => permissionLabels[permission]).join(", ");
}

export default function AdminCenter() {
  const [, setLocation] = useLocation();
  const { clinicId, user, vertical } = useAuth();
  // Подпись вкладки исполнителей зависит от ниши: у клиники «Врачи», у салона
  // «Мастера». Ключ вкладки остаётся doctors — переименовывать его значило бы
  // трогать реестры, а не слово на кнопке.
  const tabLabel = (tab: { id: AdminTab; label: string }) =>
    tab.id === "doctors" ? capitalize(termsFor(vertical).specialistPlural) : tab.label;
  const workspaceId = clinicId || readWorkspaceId();
  const [activeTab, setActiveTab] = useState<AdminTab>("overview");
  // Проба маршрута платформы. Не владелец платформы получает 404 и ссылки не
  // видит; владелец видит. Одна проба на открытие админ-центра, не на каждый
  // экран продукта.
  const [platformPanelAvailable, setPlatformPanelAvailable] = useState(false);
  const [clinic, setClinic] = useState<ClinicSettings>(() => readStored("negis_clinic_settings", clinicDefaults));

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await crmFetch("/api/crm/platform-overview");
        if (!cancelled) setPlatformPanelAvailable(response.ok);
      } catch {
        if (!cancelled) setPlatformPanelAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  // Commercial-3B: the team is whatever the server says it is. This list used
  // to be seeded from localStorage demo data and written back there, so an
  // administrator saw people who were not members and suspended people who
  // still had access.
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [releaseChecks, setReleaseChecks] = useState<ReleaseCheck[]>(() => mergeReleaseChecks(readStored("negis_release_checks", releaseDefaults)));
  const [aiProviders, setAiProviders] = useState<AiProviderSetting[]>(() => readStored("negis_ai_provider_settings", aiDefaults));
  const [metaAccount, setMetaAccount] = useState<MetaAccount>(() => readStored("negis_meta_account", metaDefaults));
  const [metaLiveLaunchEnabled, setMetaLiveLaunchEnabled] = useState(() => readStored("negis_meta_live_launch_enabled", false));
  const [metaConfigMode, setMetaConfigMode] = useState<"none" | "local" | "supabase">(() => {
    const storedMode = readStored<"none" | "local" | "supabase">("negis_meta_config_save_mode", "none");
    if (storedMode !== "none") return storedMode;
    return hasMetaFormValues(readStored("negis_meta_account", metaDefaults)) ? "local" : "none";
  });
  const [health, setHealth] = useState<CrmHealthData | null>(null);
  const [serverAdminAuth, setServerAdminAuth] = useState<ServerAdminAuthState>({ status: "checking" });
  const [integrationCards, setIntegrationCards] = useState<IntegrationCard[]>(() => buildIntegrationCards(null));
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [metaCityKeyInput, setMetaCityKeyInput] = useState("almaty");
  const [metaCityKeyResult, setMetaCityKeyResult] = useState<MetaCityKeyResult | null>(null);
  const [metaInsightsLaunches, setMetaInsightsLaunches] = useState<MetaInsightsLaunchOption[]>([]);
  const [metaInsightsLaunchId, setMetaInsightsLaunchId] = useState("");
  const [metaInsightsDateStart, setMetaInsightsDateStart] = useState(() => localIsoDateOffset(-6));
  const [metaInsightsDateStop, setMetaInsightsDateStop] = useState(() => localIsoDateOffset(0));
  const [metaInsightsLastRun, setMetaInsightsLastRun] = useState<MetaInsightsSyncRun | null>(null);
  const [metaInsightsRows, setMetaInsightsRows] = useState<MetaCampaignInsight[]>([]);
  const [metaInsightsMessage, setMetaInsightsMessage] = useState("");
  // Commercial-3B: staff are added by invitation. The clinic names an address
  // and a role; the person proves control of that address through Supabase Auth
  // and redeems the token. Nothing here mints a password or a membership.
  const [inviteForm, setInviteForm] = useState({ email: "", role: "receptionist" as StaffRole });
  const [invitations, setInvitations] = useState<StaffInvitation[]>([]);
  const [issuedInvite, setIssuedInvite] = useState<{ email: string; acceptUrl: string; emailSent: boolean } | null>(null);

  const readiness = useMemo(() => {
    const total = releaseChecks.length || 1;
    const passed = releaseChecks.filter((check) => check.status === "passed" || check.status === "skipped").length;
    const blockers = releaseChecks.filter((check) => criticalBlockerKeys.has(check.checkKey) && check.status !== "passed" && check.status !== "skipped").length;
    return {
      score: Math.round((passed / total) * 100),
      blockers,
      complete: blockers === 0,
    };
  }, [releaseChecks]);

  const metaInsightsDiagnostics = useMemo(
    () => summarizeMetaInsightRows(metaInsightsRows),
    [metaInsightsRows],
  );

  const setBusy = (key: string, value: boolean) => setLoading((current) => ({ ...current, [key]: value }));

  async function checkServerAdminAccess() {
    setServerAdminAuth({ status: "checking" });

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId)) {
      setServerAdminAuth({ status: "reauth" });
      return;
    }

    try {
      const accessToken = await getSupabaseAccessToken();
      if (!accessToken) {
        setServerAdminAuth({ status: "reauth" });
        return;
      }

      const response = await crmFetch(`/api/crm/auth-context?workspaceId=${encodeURIComponent(workspaceId)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await safeJson<AdminAuthContextData>(response);

      if (response.status === 401) {
        setServerAdminAuth({ status: "reauth" });
        return;
      }
      if (response.status === 403) {
        setServerAdminAuth({ status: "forbidden" });
        return;
      }
      if (!response.ok || body.success !== true || !body.data?.isAdmin) {
        setServerAdminAuth({ status: "unavailable" });
        return;
      }

      setServerAdminAuth({ status: "confirmed", role: body.data.role });
    } catch {
      setServerAdminAuth({ status: "unavailable" });
    }
  }

  useEffect(() => {
    void checkServerAdminAccess();
  }, [workspaceId]);

  function isEligibleInsightsLaunch(launch: MetaInsightsLaunchOption): boolean {
    const status = launch.status.trim().toLowerCase();
    const metaStatus = launch.metaStatus.trim().toLowerCase();
    return (
      /^\d+$/.test(launch.metaCampaignId.trim()) &&
      ![status, metaStatus].some((value) => ["failed", "video_processing", "dry_run"].includes(value))
    );
  }

  async function loadMetaInsightsDiagnostics() {
    if (serverAdminAuth.status !== "confirmed") return;
    setBusy("meta-insights-load", true);
    setMetaInsightsMessage("");
    try {
      const [launchesBody, runsBody, insightsBody] = await Promise.all([
        adminCrmRequest<{ launches?: MetaInsightsLaunchOption[] }>(
          `/api/crm/meta-launches?workspaceId=${encodeURIComponent(workspaceId)}`,
        ),
        adminCrmRequest<{ runs?: MetaInsightsSyncRun[] }>(
          `/api/crm/meta-insights-sync-runs?workspaceId=${encodeURIComponent(workspaceId)}`,
        ),
        adminCrmRequest<{ insights?: MetaCampaignInsight[] }>(
          `/api/crm/meta-campaign-insights?workspaceId=${encodeURIComponent(workspaceId)}`,
        ),
      ]);
      if (
        launchesBody.mode !== "supabase" ||
        runsBody.mode !== "supabase" ||
        insightsBody.mode !== "supabase"
      ) {
        throw new Error("Meta Insights доступны только для рабочего Supabase workspace.");
      }

      const launches = (launchesBody.data?.launches || []).filter(isEligibleInsightsLaunch);
      setMetaInsightsLaunches(launches);
      setMetaInsightsLaunchId((current) =>
        current && launches.some((launch) => launch.id === current) ? current : launches[0]?.id || "",
      );
      setMetaInsightsLastRun(runsBody.data?.runs?.[0] || null);
      setMetaInsightsRows(insightsBody.data?.insights || []);
    } catch (error) {
      setMetaInsightsMessage(error instanceof Error ? error.message : "Не удалось загрузить диагностику Insights.");
    } finally {
      setBusy("meta-insights-load", false);
    }
  }

  async function synchronizeMetaInsights() {
    if (serverAdminAuth.status !== "confirmed") {
      setMetaInsightsMessage("Сначала подтвердите админ-доступ.");
      return;
    }
    if (!metaInsightsLaunchId) {
      setMetaInsightsMessage("Выберите реальный запуск Meta.");
      return;
    }

    setBusy("meta-insights-sync", true);
    setMetaInsightsMessage("");
    try {
      const body = await adminCrmRequest<MetaInsightsSyncResult>("/api/crm/meta-insights-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          metaCampaignLaunchId: metaInsightsLaunchId,
          dateStart: metaInsightsDateStart,
          dateStop: metaInsightsDateStop,
        }),
      });
      if (body.mode !== "supabase" || !body.data?.run) {
        throw new Error("Синхронизация не вернула подтверждённый Supabase run.");
      }
      const successMessage =
        body.data.empty
          ? "Синхронизация завершена: Meta не вернула дневные строки за выбранный период."
          : `Синхронизация завершена. Сохранено строк: ${body.data.rowsUpserted}.`;
      await loadMetaInsightsDiagnostics();
      setMetaInsightsMessage(successMessage);
      toast.success("Meta Insights синхронизированы");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось синхронизировать Meta Insights.";
      toast.error(message);
      await loadMetaInsightsDiagnostics();
      setMetaInsightsMessage(message);
    } finally {
      setBusy("meta-insights-sync", false);
    }
  }

  useEffect(() => {
    if (serverAdminAuth.status === "confirmed") {
      void loadMetaInsightsDiagnostics();
    } else {
      setMetaInsightsLaunches([]);
      setMetaInsightsLaunchId("");
      setMetaInsightsLastRun(null);
      setMetaInsightsRows([]);
    }
  }, [serverAdminAuth.status, workspaceId]);

  async function checkCrmHealth() {
    setBusy("crm-health", true);
    try {
      const body = await crmRequest<CrmHealthData>("/api/crm/health");
      const data = body.data || null;
      setHealth(data);
      setIntegrationCards(buildIntegrationCards(data));
      toast.success("Диагностика CRM обновлена");
      return data;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось проверить CRM health");
      return null;
    } finally {
      setBusy("crm-health", false);
    }
  }

  async function checkTelegram() {
    setBusy("telegram", true);
    try {
      const response = await crmFetch(withWorkspace("/api/content-studio/send-telegram"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: true }),
      });
      const body = await safeJson<Record<string, unknown>>(response);
      const description = body.telegramDescription || body.error || "Telegram не подключен";
      const hint = body.hint || body.warning || "";
      setIntegrationCards((cards) =>
        cards.map((card) =>
          card.key === "telegram"
            ? {
                ...card,
                status: response.ok && body.success !== false ? "connected" : "error",
                details: response.ok && body.success !== false ? "Test message accepted" : description,
                hint,
              }
            : card,
        ),
      );
      if (!response.ok || body.success === false) {
        toast.error(`Telegram: ${description}${hint ? `. ${hint}` : ""}`);
        return;
      }
      toast.success("Telegram подключен");
    } finally {
      setBusy("telegram", false);
    }
  }

  async function checkTargetingAgent() {
    setBusy("targeting", true);
    try {
      const body = await crmRequest<Record<string, unknown>>("/api/targeting/health");
      setIntegrationCards((cards) =>
        cards.map((card) =>
          card.key === "targetingAgent"
            ? { ...card, status: body.success === false ? "error" : "connected", details: "Railway Targeting Agent отвечает" }
            : card,
        ),
      );
      toast.success("Targeting Agent отвечает");
    } catch (error) {
      setIntegrationCards((cards) =>
        cards.map((card) =>
          card.key === "targetingAgent"
            ? { ...card, status: "error", details: error instanceof Error ? error.message : "Ошибка Targeting Agent" }
            : card,
        ),
      );
      toast.error(error instanceof Error ? error.message : "Ошибка Targeting Agent");
    } finally {
      setBusy("targeting", false);
    }
  }

  async function checkAdCreativesStorage() {
    setBusy("adCreativesStorage", true);
    try {
      const body = await crmRequest<StorageHealth>("/api/crm/storage-health");
      const storage = body.data || {};
      const ready = Boolean(storage.exists && storage.publicAccess && storage.publicUrlWorks);
      const details = [
        `bucket ${storage.bucket || "ad-creatives"}`,
        storage.exists ? "создан" : "не найден",
        storage.publicAccess ? "public access включён" : "public access не подтверждён",
        storage.canUpload ? "upload доступен" : "upload не подтверждён",
      ].join(" · ");

      setIntegrationCards((cards) =>
        cards.map((card) =>
          card.key === "adCreativesStorage"
            ? {
                ...card,
                status: ready ? "connected" : "error",
                details,
                hint: storage.hint,
              }
            : card,
        ),
      );
      if (ready) {
        toast.success("Storage ad-creatives готов");
      } else {
        toast.warning(storage.hint || "Проверьте bucket ad-creatives и public access.");
      }
    } catch (error) {
      setIntegrationCards((cards) =>
        cards.map((card) =>
          card.key === "adCreativesStorage"
            ? {
                ...card,
                status: "error",
                details: error instanceof Error ? error.message : "Не удалось проверить Storage.",
              }
            : card,
        ),
      );
      toast.error(error instanceof Error ? error.message : "Не удалось проверить Storage.");
    } finally {
      setBusy("adCreativesStorage", false);
    }
  }

  async function checkAllIntegrations() {
    const data = await checkCrmHealth();
    if (data) setIntegrationCards(buildIntegrationCards(data));
    await Promise.allSettled([checkTelegram(), checkTargetingAgent(), checkAdCreativesStorage()]);
  }

  async function runReleaseAutocheck() {
    setBusy("release-autocheck", true);
    try {
      const data = await checkCrmHealth();
      const targetingOk = await (async () => {
        try {
          const body = await crmRequest<Record<string, unknown>>("/api/targeting/health");
          return body.success !== false;
        } catch {
          return false;
        }
      })();
      const telegramEnvConfigured = isProviderConfigured(data, "telegram");
      const telegramOk = telegramEnvConfigured
        ? await (async () => {
            try {
              const response = await crmFetch(withWorkspace("/api/content-studio/send-telegram"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ test: true }),
              });
              const body = await safeJson<Record<string, unknown>>(response);
              return response.ok && body.success !== false;
            } catch {
              return false;
            }
          })()
        : false;

      const autoResults: Record<string, { status: ReleaseStatus; notes: string }> = {
        supabase_configured: {
          status: isProviderConfigured(data, "supabase") ? "passed" : "failed",
          notes: isProviderConfigured(data, "supabase") ? "Supabase env configured." : "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing.",
        },
        vercel_env: {
          status: isProviderConfigured(data, "vercelBasic") ? "passed" : "failed",
          notes: isProviderConfigured(data, "vercelBasic") ? "Basic Vercel env detected." : "TARGETING_AGENT_URL missing.",
        },
        staff_auth_env: {
          status: isProviderConfigured(data, "staffAuth") ? "passed" : "failed",
          notes: isProviderConfigured(data, "staffAuth") ? "Staff auth server env configured." : "Staff auth needs Supabase service env.",
        },
        telegram_test: {
          status: telegramOk ? "passed" : "failed",
          notes: telegramEnvConfigured ? (telegramOk ? "Telegram test passed." : "Telegram env configured, but test failed.") : "Telegram env missing.",
        },
        targeting_health: {
          status: targetingOk ? "passed" : "failed",
          notes: targetingOk ? "Targeting Agent health passed." : "Targeting Agent health failed.",
        },
        openai_env: {
          status: isProviderConfigured(data, "openai") ? "passed" : "pending",
          notes: isProviderConfigured(data, "openai") ? "OpenAI env configured." : "Optional: OPENAI_API_KEY is not configured.",
        },
        meta_env: {
          status: data?.meta?.configured ? "passed" : "pending",
          notes: data?.meta?.configured ? "Meta env configured. Save non-secret config in Meta tab." : "Optional before real ads launch: Meta env incomplete.",
        },
        migrations_009_013: {
          status: "pending",
          notes: isProviderConfigured(data, "supabase") ? "Env configured. Apply SQL migrations manually in Supabase SQL editor." : "Configure Supabase before applying migrations.",
        },
        staff_login: {
          status: "pending",
          notes: "Manual check: sign in as a staff user through /login.",
        },
        appointments_tested: {
          status: "pending",
          notes: "Manual check: create and edit an appointment in /appointments.",
        },
      };

      const next = releaseChecks.map((check) => {
        const result = autoResults[check.checkKey];
        return result ? { ...check, ...result } : check;
      });
      setReleaseChecks(next);
      writeStored("negis_release_checks", next);
      await Promise.allSettled(
        next
          .filter((check) => Boolean(autoResults[check.checkKey]))
          .map((check) =>
            crmRequest("/api/crm/release-checks", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                workspaceId,
                checkKey: check.checkKey,
                status: check.status,
                notes: check.notes,
                checkedAt: check.status === "passed" || check.status === "failed" ? new Date().toISOString() : null,
              }),
            }),
          ),
      );
      toast.success("Автопроверка релиза завершена");
    } finally {
      setBusy("release-autocheck", false);
    }
  }

  async function prefillMetaFromEnv() {
    setBusy("meta-prefill", true);
    try {
      const data = health || (await checkCrmHealth());
      const meta = data?.meta;
      if (!meta) {
        toast.error("Meta env summary недоступен");
        return;
      }
      const next: MetaAccount = {
        ...metaAccount,
        // The clinic's own stored record is the only source of these values now.
        metaBusinessId: metaAccount.metaBusinessId,
        adAccountId: metaAccount.adAccountId,
        pageId: metaAccount.pageId,
        instagramActorId: metaAccount.instagramActorId,
        accountName: "Negis Meta Ads",
        currency: "USD",
        timezoneName: "Asia/Almaty",
        status: "draft",
        permissions: {
          ...metaAccount.permissions,
          appCreated: meta.hasAppSecret || metaAccount.permissions.appCreated,
          adAccountConnected: Boolean(meta.adAccountConfigured) || metaAccount.permissions.adAccountConnected,
          pageConnected: Boolean(meta.pageConfigured) || metaAccount.permissions.pageConnected,
          instagramConnected: Boolean(meta.instagramActorConfigured) || metaAccount.permissions.instagramConnected,
          manualApproval: true,
        },
      };
      setMetaAccount(next);
      toast.success("Meta поля заполнены из безопасных env");
    } finally {
      setBusy("meta-prefill", false);
    }
  }

  async function checkMetaCityKey() {
    const city = getKzMetaCityOption(metaCityKeyInput);
    if (!city.id) {
      toast.error("Введите город для проверки");
      return;
    }

    setBusy("meta-city-key", true);
    try {
      const body = await crmRequest<MetaCityKeyResult>(`/api/crm/meta-city-key?city=${encodeURIComponent(city.id)}`);
      const result = body.data || null;
      setMetaCityKeyResult(result);
      if (result?.key) {
        toast.success(`Meta city key найден: ${result.key}`);
      } else {
        toast.warning(result?.warning || "City key не найден, будет использован Казахстан.");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось проверить Meta city key");
    } finally {
      setBusy("meta-city-key", false);
    }
  }

  async function saveClinicSettings() {
    writeStored("negis_clinic_settings", clinic);
    setBusy("clinic", true);
    try {
      await crmRequest("/api/crm/admin-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, key: "clinic", value: clinic }),
      });
      toast.success("Настройки клиники сохранены");
    } catch (error) {
      toast.warning(error instanceof Error ? error.message : "Сохранено локально, Supabase недоступен");
    } finally {
      setBusy("clinic", false);
    }
  }

  // The pending list is only meaningful on the staff tab, and it is the one
  // place it can go stale while someone works elsewhere in the admin centre.
  useEffect(() => {
    if (activeTab !== "staff") return;
    void loadStaff();
    void loadInvitations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, workspaceId]);

  async function loadInvitations() {
    try {
      const body = await crmRequest<{ invitations?: StaffInvitation[] }>(
        `/api/crm/staff-invitations?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      setInvitations(body.data?.invitations || []);
    } catch {
      // A clinic without the enrollment table yet simply has no invitations.
      setInvitations([]);
    }
  }

  async function sendInvitation() {
    const email = inviteForm.email.trim().toLowerCase();
    if (!email) {
      toast.error("Укажите email сотрудника");
      return;
    }

    setBusy("staff", true);
    try {
      const body = await crmRequest<{ invitation?: StaffInvitation; acceptUrl?: string; emailSent?: boolean }>(
        `/api/crm/staff-invitations?workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, role: inviteForm.role }),
        },
      );
      setIssuedInvite({
        email,
        acceptUrl: body.data?.acceptUrl || "",
        emailSent: Boolean(body.data?.emailSent),
      });
      setInviteForm({ email: "", role: "receptionist" });
      await loadInvitations();
      toast.success(body.data?.emailSent ? "Приглашение отправлено" : "Приглашение создано — передайте ссылку");
    } catch (error) {
      // No local fallback: an invitation that only exists in this browser would
      // be a person who believes they have access and does not.
      toast.error(error instanceof Error ? error.message : "Не удалось создать приглашение");
    } finally {
      setBusy("staff", false);
    }
  }

  async function revokeInvitation(id: string) {
    try {
      await crmRequest(`/api/crm/staff-invitations?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      await loadInvitations();
      toast.success("Приглашение отозвано");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось отозвать приглашение");
    }
  }

  async function loadStaff() {
    try {
      const body = await crmRequest<{ staff?: StaffMember[]; items?: StaffMember[] }>(
        `/api/crm/staff?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      setStaff(body.data?.staff || body.data?.items || []);
    } catch {
      // An administrator who cannot read the team is shown an empty table
      // rather than a plausible-looking one.
      setStaff([]);
    }
  }

  async function updateStaffStatus(id: string, status: string) {
    try {
      await crmRequest(`/api/crm/staff?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      await loadStaff();
      toast.success(status === "active" ? "Сотрудник активирован" : "Доступ приостановлен");
    } catch (error) {
      // No local edit on failure: the previous behaviour changed the row in
      // this browser only, so a suspended colleague kept working.
      toast.error(error instanceof Error ? error.message : "Не удалось изменить статус");
    }
  }

  async function saveAiProvider(provider: AiProviderSetting) {
    const next = aiProviders.map((item) => (item.id === provider.id ? provider : item));
    setAiProviders(next);
    writeStored("negis_ai_provider_settings", next);
    setBusy(`ai-${provider.id}`, true);
    try {
      await crmRequest("/api/crm/ai-providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          provider: provider.provider,
          purpose: provider.purpose,
          enabled: provider.enabled,
          modelName: provider.modelName,
          config: { module: provider.module, status: provider.status },
        }),
      });
      toast.success(`${provider.label} сохранен`);
    } catch (error) {
      toast.warning(error instanceof Error ? error.message : "Сохранено локально");
    } finally {
      setBusy(`ai-${provider.id}`, false);
    }
  }

  async function saveMetaConfig(status: Status = metaAccount.status) {
    const next = { ...metaAccount, status };
    setMetaAccount(next);
    writeStored("negis_meta_account", next);
    setBusy("meta", true);
    try {
      const body = await crmRequest("/api/crm/meta-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          ...next,
          metadata: { permissions: next.permissions, manualApprovalOnly: true, liveLaunchEnabled: metaLiveLaunchEnabled },
        }),
      });
      const mode = body.mode === "supabase" ? "supabase" : "local";
      setMetaConfigMode(mode);
      writeStored("negis_meta_config_save_mode", mode);
      toast.success("Meta config сохранен без secret token");
    } catch (error) {
      setMetaConfigMode("local");
      writeStored("negis_meta_config_save_mode", "local");
      toast.warning(error instanceof Error ? error.message : "Meta config сохранен локально");
    } finally {
      setBusy("meta", false);
    }
  }

  async function saveMetaLiveLaunchEnabled(enabled: boolean) {
    setMetaLiveLaunchEnabled(enabled);
    writeStored("negis_meta_live_launch_enabled", enabled);
    setBusy("meta-live-launch", true);
    try {
      await crmRequest("/api/crm/admin-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          key: "meta_live_launch_enabled",
          value: {
            enabled,
            updatedAt: new Date().toISOString(),
            note: "Controls ACTIVE Meta launch from /ads-automation",
          },
        }),
      });
      toast.success(enabled ? "Live launch разрешен" : "Live launch выключен");
    } catch (error) {
      toast.warning(error instanceof Error ? error.message : "Live launch сохранен локально");
    } finally {
      setBusy("meta-live-launch", false);
    }
  }

  async function saveReleaseCheck(check: ReleaseCheck) {
    const next = releaseChecks.map((item) => (item.checkKey === check.checkKey ? check : item));
    setReleaseChecks(next);
    writeStored("negis_release_checks", next);
    setBusy(`release-${check.checkKey}`, true);
    try {
      await crmRequest("/api/crm/release-checks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          checkKey: check.checkKey,
          status: check.status,
          notes: check.notes,
          checkedAt: check.status === "passed" || check.status === "failed" ? new Date().toISOString() : null,
        }),
      });
    } catch (error) {
      toast.warning(error instanceof Error ? error.message : "Release check сохранен локально");
    } finally {
      setBusy(`release-${check.checkKey}`, false);
    }
  }

  async function copyEnvList() {
    const text = envList.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Список env скопирован");
    } catch {
      toast.error("Не удалось скопировать автоматически");
    }
  }

  async function copyInviteLink() {
    if (!issuedInvite?.acceptUrl) return;
    try {
      await navigator.clipboard.writeText(issuedInvite.acceptUrl);
      toast.success("Ссылка скопирована");
    } catch {
      toast.error("Не удалось скопировать автоматически");
    }
  }

  function renderOverview() {
    const crmRecords = ["negis_demo_clients", "negis_demo_leads", "negis_demo_appointments", "negis_demo_tasks"].reduce(
      (sum, key) => sum + localStorageCount(key),
      0,
    );
    const today = new Date().toISOString().slice(0, 10);
    const todayAppointments = readStored<Array<{ startsAt?: string; time?: string }>>("negis_demo_appointments", []).filter((item) =>
      String(item.startsAt || item.time || "").startsWith(today),
    ).length;
    const connected = integrationCards.filter((card) => ["configured", "connected", "demo"].includes(card.status)).length;

    return (
      <div className="space-y-5">
        {/* Commercial-1: платформенная готовность живёт во внутреннем разделе
            диагностики; клиника видит только состояние интеграций и команду. */}
        <div className="grid gap-4 sm:grid-cols-2">
          <MetricCard label="Состояние интеграций" value={`${connected}/${integrationCards.length}`} icon={Database} tone="info" />
          <MetricCard label="Сотрудники" value={staff.length} icon={Users} tone="primary" />
        </div>
        <div className="grid gap-5 lg:grid-cols-3">
          <section className="neu-card lg:col-span-2">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-black text-[#0F172A]">Готовность к тестовому дню</h2>
                <p className="mt-1 text-sm text-[#64748B]">
                  {readiness.complete ? "Платформа готова к тестовой работе сотрудников." : "Есть блокеры, которые нужно закрыть перед сменой."}
                </p>
              </div>
              <button type="button" className="neu-btn-primary w-full sm:w-auto" onClick={() => setActiveTab("release")}>
                <ClipboardCheck size={16} />
                Открыть checklist
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <StatusTile title="Сегодня записей" value={String(todayAppointments)} />
              <StatusTile title="CRM записей" value={String(crmRecords)} />
              <StatusTile title="AI modules" value={`${aiProviders.filter((item) => item.enabled).length}/${aiProviders.length}`} />
            </div>
          </section>
          <section className="neu-card">
            <h2 className="text-lg font-black text-[#0F172A]">Быстрые действия</h2>
            <div className="mt-4 grid gap-2">
              <button type="button" className="neu-btn w-full justify-center" onClick={() => setActiveTab("integrations")}>
                <Database size={16} />
                Проверить интеграции
              </button>
              <button type="button" className="neu-btn w-full justify-center" onClick={() => setActiveTab("staff")}>
                <UserPlus size={16} />
                Добавить сотрудника
              </button>
              <button type="button" className="neu-btn w-full justify-center" onClick={() => setLocation("/ads-automation")}>
                <Rocket size={16} />
                AI запуск рекламы
              </button>
            </div>
          </section>
        </div>
      </div>
    );
  }

  function renderStaff() {
    return (
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
        <section className="neu-card">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-black text-[#0F172A]">Сотрудники</h2>
              <p className="text-sm text-[#64748B]">Доступы выдаются по ролям. Пароль показывается только сразу после создания.</p>
            </div>
            <span className="rounded-full bg-[#E0F2FE] px-3 py-1 text-xs font-bold text-[#0369A1]">{staff.length} профиля</span>
          </div>
          <div className="grid gap-3 md:hidden">
            {staff.map((member) => (
              <article key={member.id} className="rounded-2xl border border-[#E2E8F0] bg-white/70 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-bold text-[#0F172A]">{member.name}</h3>
                    <p className="mt-1 text-sm text-[#64748B]">{member.email}</p>
                    <p className="mt-1 text-xs text-[#64748B]">{roleLabels[member.role]}</p>
                  </div>
                  <StatusPill status={member.status === "active" ? "configured" : "partial"} label={member.status} />
                </div>
                <button
                  type="button"
                  className="neu-btn mt-4 w-full justify-center"
                  onClick={() => updateStaffStatus(member.id, member.status === "active" ? "paused" : "active")}
                >
                  {member.status === "active" ? "Поставить на паузу" : "Активировать"}
                </button>
              </article>
            ))}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="text-xs uppercase tracking-[0.12em] text-[#94A3B8]">
                <tr>
                  <th className="px-3 py-3">Имя</th>
                  <th className="px-3 py-3">Email</th>
                  <th className="px-3 py-3">Роль</th>
                  <th className="px-3 py-3">Статус</th>
                  <th className="px-3 py-3">Действие</th>
                </tr>
              </thead>
              <tbody>
                {staff.map((member) => (
                  <tr key={member.id} className="border-t border-[#E2E8F0]">
                    <td className="px-3 py-4 font-semibold text-[#0F172A]">{member.name}</td>
                    <td className="px-3 py-4 text-[#64748B]">{member.email}</td>
                    <td className="px-3 py-4 text-[#334155]">{roleLabels[member.role]}</td>
                    <td className="px-3 py-4"><StatusPill status={member.status === "active" ? "configured" : "partial"} label={member.status} /></td>
                    <td className="px-3 py-4">
                      <button
                        type="button"
                        className="neu-btn px-3 py-1.5 text-xs"
                        onClick={() => updateStaffStatus(member.id, member.status === "active" ? "paused" : "active")}
                      >
                        {member.status === "active" ? "Пауза" : "Активировать"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="neu-card">
          <h2 className="text-lg font-black text-[#0F172A]">Пригласить сотрудника</h2>
          <p className="mt-1 text-sm text-[#64748B]">
            Сотрудник получает письмо, задаёт свой пароль в Supabase Auth и принимает приглашение. Пароли за него не создаются.
          </p>
          <div className="mt-4 grid gap-3">
            <input
              className="neu-input"
              type="email"
              placeholder="Email"
              value={inviteForm.email}
              onChange={(event) => setInviteForm({ ...inviteForm, email: event.target.value })}
            />
            <select
              className="neu-input"
              value={inviteForm.role}
              onChange={(event) => setInviteForm({ ...inviteForm, role: event.target.value as StaffRole })}
            >
              {staffRoles
                .filter((role) => role !== "owner")
                .map((role) => (
                  <option key={role} value={role}>{roleLabels[role]}</option>
                ))}
            </select>
            <button type="button" className="neu-btn-primary w-full justify-center" disabled={loading.staff} onClick={sendInvitation}>
              {loading.staff ? <Loader2 className="animate-spin" size={16} /> : <UserPlus size={16} />}
              Отправить приглашение
            </button>
          </div>

          {issuedInvite && (
            <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
              <p className="font-bold">Приглашение для {issuedInvite.email}</p>
              <p className="mt-1">
                {issuedInvite.emailSent
                  ? "Письмо отправлено. Ссылка ниже — на случай, если оно не дошло."
                  : "Письмо отправить не удалось. Передайте ссылку сотруднику лично."}
              </p>
              <p className="mt-2 break-all font-mono text-xs text-emerald-900">{issuedInvite.acceptUrl}</p>
              <button type="button" className="neu-btn mt-3 w-full justify-center bg-white/80" onClick={copyInviteLink}>
                <Copy size={15} />
                Скопировать ссылку
              </button>
            </div>
          )}

          <div className="mt-6">
            <h3 className="text-sm font-black uppercase tracking-[0.12em] text-[#94A3B8]">Ожидают принятия</h3>
            {invitations.filter((invitation) => invitation.status === "pending").length === 0 ? (
              <p className="mt-2 text-sm text-[#64748B]">Активных приглашений нет.</p>
            ) : (
              <ul className="mt-3 grid gap-2">
                {invitations
                  .filter((invitation) => invitation.status === "pending")
                  .map((invitation) => (
                    <li key={invitation.id} className="flex items-center justify-between gap-3 rounded-2xl border border-[#E2E8F0] bg-white/70 px-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[#0F172A]">{invitation.email}</p>
                        <p className="text-xs text-[#64748B]">{roleLabels[invitation.role as StaffRole] || invitation.role}</p>
                      </div>
                      <button type="button" className="neu-btn px-3 py-1.5 text-xs" onClick={() => revokeInvitation(invitation.id)}>
                        Отозвать
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    );
  }

  function renderRoles() {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        {staffRoles.map((role) => {
          const permissions = permissionsForRole(role);
          return (
            <section key={role} className="neu-card">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-black text-[#0F172A]">{roleLabels[role]}</h2>
                  <p className="mt-1 text-sm text-[#64748B]">{permissions.length} прав доступа</p>
                </div>
                <ShieldCheck className="text-[#0D9488]" size={22} />
              </div>
              <p className="sr-only">{permissionSummary(permissions)}</p>
              <div className="flex flex-wrap gap-2">
                {permissions.map((permission) => (
                  <span key={permission} className="rounded-full border border-[#E2E8F0] bg-white/70 px-3 py-1 text-xs font-bold text-[#334155]">
                    {permissionLabels[permission]}
                  </span>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    );
  }

  function renderClinic() {
    const update = (key: keyof ClinicSettings, value: string) => setClinic((current) => ({ ...current, [key]: value }));
    return (
      <section className="neu-card">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-black text-[#0F172A]">Настройки клиники</h2>
            <p className="text-sm text-[#64748B]">Локальный fallback: negis_clinic_settings. При Supabase сохраняется в workspace_settings.</p>
          </div>
          <button type="button" className="neu-btn-primary w-full sm:w-auto" disabled={loading.clinic} onClick={saveClinicSettings}>
            {loading.clinic ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}
            Сохранить
          </button>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="clinicName" value={clinic.clinicName} onChange={(value) => update("clinicName", value)} />
          <Field label="city" value={clinic.city} onChange={(value) => update("city", value)} />
          <Field label="phone" value={clinic.phone} onChange={(value) => update("phone", value)} />
          <Field label="whatsapp" value={clinic.whatsapp} onChange={(value) => update("whatsapp", value)} />
          <Field label="address" value={clinic.address} onChange={(value) => update("address", value)} />
          <Field label="defaultServices" value={clinic.defaultServices} onChange={(value) => update("defaultServices", value)} />
          <Field label="brandTone" value={clinic.brandTone} onChange={(value) => update("brandTone", value)} />
          <Field label="timezone" value={clinic.timezone} onChange={(value) => update("timezone", value)} />
          <div className="md:col-span-2">
            <label className="mb-2 block text-xs font-bold uppercase tracking-[0.12em] text-[#64748B]">legalDisclaimer</label>
            <textarea className="neu-input min-h-28" value={clinic.legalDisclaimer} onChange={(event) => update("legalDisclaimer", event.target.value)} />
          </div>
        </div>
      </section>
    );
  }

  function renderIntegrations() {
    return (
      <div className="space-y-5">
        <div className="neu-card flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-black text-[#0F172A]">Integration health</h2>
            <p className="text-sm text-[#64748B]">Проверка читает только наличие env и health endpoints. Секреты не отображаются.</p>
          </div>
          <button type="button" className="neu-btn-primary w-full sm:w-auto" onClick={checkAllIntegrations}>
            <RefreshCw size={16} />
            Проверить всё
          </button>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {integrationCards.map((card) => (
            <IntegrationStatusCard
              key={card.key}
              card={card}
              loading={Boolean(loading[card.key] || (card.key === "telegram" && loading.telegram) || (card.key === "targetingAgent" && loading.targeting))}
              onCheck={
                card.key === "telegram"
                  ? checkTelegram
                  : card.key === "targetingAgent"
                    ? checkTargetingAgent
                    : card.key === "adCreativesStorage"
                      ? checkAdCreativesStorage
                    : card.key === "supabase"
                      ? () => { void checkCrmHealth(); }
                      : undefined
              }
            />
          ))}
        </div>
      </div>
    );
  }

  function renderAiProviders() {
    return (
      <div className="space-y-5">
        <section className="neu-card flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-black text-[#0F172A]">Нейросети для генерации контента</h2>
            <p className="text-sm text-[#64748B]">Реальные ключи добавляются только в Vercel Environment Variables.</p>
          </div>
          <button type="button" className="neu-btn w-full sm:w-auto" onClick={copyEnvList}>
            <Copy size={16} />
            Скопировать список env
          </button>
        </section>
        <div className="grid gap-4 lg:grid-cols-2">
          {aiProviders.map((provider) => (
            <section key={provider.id} className="neu-card">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-black text-[#0F172A]">{provider.label}</h3>
                  <p className="mt-1 text-sm text-[#64748B]">Используется в модуле: {provider.module}</p>
                </div>
                <StatusPill status={provider.status} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex items-center gap-2 text-sm font-semibold text-[#334155]">
                  <input
                    type="checkbox"
                    checked={provider.enabled}
                    onChange={(event) => {
                      const next = { ...provider, enabled: event.target.checked };
                      setAiProviders((current) => current.map((item) => (item.id === provider.id ? next : item)));
                    }}
                  />
                  enabled
                </label>
                <select
                  className="neu-input"
                  value={provider.provider}
                  onChange={(event) => {
                    const next = { ...provider, provider: event.target.value };
                    setAiProviders((current) => current.map((item) => (item.id === provider.id ? next : item)));
                  }}
                >
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="gemini">Gemini</option>
                  <option value="elevenlabs">ElevenLabs</option>
                  <option value="heygen">HeyGen</option>
                  <option value="tapnow">TapNow</option>
                  <option value="demo">Demo fallback</option>
                </select>
                <input
                  className="neu-input sm:col-span-2"
                  value={provider.modelName}
                  placeholder="modelName"
                  onChange={(event) => {
                    const next = { ...provider, modelName: event.target.value };
                    setAiProviders((current) => current.map((item) => (item.id === provider.id ? next : item)));
                  }}
                />
              </div>
              <button type="button" className="neu-btn mt-4 w-full justify-center" disabled={loading[`ai-${provider.id}`]} onClick={() => saveAiProvider(provider)}>
                {loading[`ai-${provider.id}`] ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}
                Сохранить настройку
              </button>
            </section>
          ))}
        </div>
      </div>
    );
  }

  function renderMeta() {
    const update = (key: keyof Omit<MetaAccount, "permissions">, value: string) => setMetaAccount((current) => ({ ...current, [key]: value }));
    const metaStatus = providerStatus(health, "meta");
    const metaSummary = health?.meta;
    const metaEnvFound = Boolean(
      metaSummary?.configured ||
        metaSummary?.businessIdConfigured ||
        metaSummary?.adAccountConfigured ||
        metaSummary?.pageConfigured ||
        metaSummary?.instagramActorConfigured ||
        metaSummary?.hasAccessToken ||
        metaSummary?.hasAppSecret,
    );
    const metaFormEmpty = !hasMetaFormValues(metaAccount);
    const metaNotice =
      metaConfigMode === "supabase"
        ? "Сохранено в Supabase"
        : metaConfigMode === "local"
          ? "Сохранено локально, Supabase недоступен"
          : metaEnvFound && metaFormEmpty
            ? "Meta env найдены. Нажмите 'Заполнить из env' и сохраните конфиг."
            : metaEnvFound
              ? "Env настроены, config не сохранён"
              : "Meta env пока не найдены. Добавьте переменные в Vercel перед реальным запуском рекламы.";
    return (
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="neu-card">
          <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-black text-[#0F172A]">Meta/Facebook Ads connector foundation</h2>
              <p className="text-sm text-[#64748B]">MVP готовит config и draft preview. Реальный launch рекламы вручную подтверждается позже.</p>
            </div>
            <StatusPill status={metaStatus} />
          </div>
          <div className={`mb-5 rounded-2xl border px-4 py-3 text-sm font-semibold ${
            metaConfigMode === "supabase"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : metaEnvFound
                ? "border-amber-200 bg-amber-50 text-amber-800"
                : "border-slate-200 bg-slate-50 text-slate-700"
          }`}>
            {metaNotice}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Meta Business ID" value={metaAccount.metaBusinessId} onChange={(value) => update("metaBusinessId", value)} />
            <Field label="Ad Account ID" value={metaAccount.adAccountId} onChange={(value) => update("adAccountId", value)} />
            <Field label="Page ID" value={metaAccount.pageId} onChange={(value) => update("pageId", value)} />
            <Field label="Instagram Actor ID" value={metaAccount.instagramActorId} onChange={(value) => update("instagramActorId", value)} />
            <Field label="Account name" value={metaAccount.accountName} onChange={(value) => update("accountName", value)} />
            <Field label="Currency" value={metaAccount.currency} onChange={(value) => update("currency", value)} />
            <Field label="Timezone" value={metaAccount.timezoneName} onChange={(value) => update("timezoneName", value)} />
            <select className="neu-input" value={metaAccount.status} onChange={(event) => update("status", event.target.value)}>
              <option value="draft">draft</option>
              <option value="configured">configured</option>
              <option value="error">error</option>
            </select>
          </div>
          <div className="mt-5 rounded-2xl border border-[#E2E8F0] bg-white/70 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="font-black text-[#0F172A]">Разрешить live launch</h3>
                <p className="mt-1 text-sm text-[#64748B]">
                  Если выключено, /ads-automation создает только PAUSED campaigns. ACTIVE доступен owner/admin после ручного подтверждения.
                </p>
              </div>
              <label className="flex items-center gap-3 rounded-2xl bg-[#F8FAFC] px-4 py-3 text-sm font-bold text-[#334155]">
                <input
                  type="checkbox"
                  checked={metaLiveLaunchEnabled}
                  disabled={loading["meta-live-launch"]}
                  onChange={(event) => void saveMetaLiveLaunchEnabled(event.target.checked)}
                />
                <span>{metaLiveLaunchEnabled ? "ACTIVE разрешен" : "Только PAUSED"}</span>
              </label>
            </div>
          </div>
          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <button type="button" className="neu-btn w-full justify-center" onClick={checkCrmHealth}>
              <RefreshCw size={16} />
              Проверить настройки
            </button>
            <button type="button" className="neu-btn w-full justify-center" disabled={loading["meta-prefill"]} onClick={prefillMetaFromEnv}>
              {loading["meta-prefill"] ? <Loader2 className="animate-spin" size={16} /> : <Copy size={16} />}
              Заполнить из env
            </button>
            <button type="button" className="neu-btn-primary w-full justify-center" disabled={loading.meta} onClick={() => saveMetaConfig()}>
              {loading.meta ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}
              Сохранить Meta config
            </button>
            <button type="button" className="neu-btn w-full justify-center" onClick={() => setLocation("/ads-automation")}>
              <Megaphone size={16} />
              Открыть Ads Automation
            </button>
          </div>
        </section>

        <section className="neu-card">
          <h3 className="font-black text-[#0F172A]">Permissions checklist</h3>
          <div className="mt-4 grid gap-2">
            {permissionChecklist.map((item) => (
              <label key={item.key} className="flex items-center gap-3 rounded-2xl border border-[#E2E8F0] bg-white/70 px-3 py-2 text-sm font-semibold text-[#334155]">
                <input
                  type="checkbox"
                  checked={Boolean(metaAccount.permissions[item.key])}
                  onChange={(event) =>
                    setMetaAccount((current) => ({
                      ...current,
                      permissions: { ...current.permissions, [item.key]: event.target.checked },
                    }))
                  }
                />
                <span>{item.label}</span>
              </label>
            ))}
          </div>
          <button
            type="button"
            className="neu-btn-primary mt-4 w-full justify-center"
            onClick={() => {
              void saveMetaConfig("draft");
              toast.success("Тестовый draft подготовлен. Реальная реклама не запущена.");
            }}
          >
            <FileCheck2 size={16} />
            Подготовить тестовый draft
          </button>

          <div className="mt-5 rounded-2xl border border-[#E2E8F0] bg-white/70 p-4">
            <h3 className="font-black text-[#0F172A]">Проверить Meta city key</h3>
            <p className="mt-1 text-sm text-[#64748B]">Введите город Казахстана. Backend вернет безопасный city key/source без секретов.</p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <select
                className="neu-input"
                value={getKzMetaCityOption(metaCityKeyInput).id}
                onChange={(event) => setMetaCityKeyInput(event.target.value)}
              >
                {KZ_META_CITY_OPTIONS.map((city) => (
                  <option key={city.id} value={city.id}>
                    {city.labelRu}
                  </option>
                ))}
              </select>
              <button type="button" className="neu-btn-primary justify-center" disabled={loading["meta-city-key"]} onClick={() => void checkMetaCityKey()}>
                {loading["meta-city-key"] ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}
                Проверить
              </button>
            </div>
            {metaCityKeyResult ? (
              <div className="mt-3 rounded-2xl border border-[#E2E8F0] bg-[#F8FAFC] p-3 text-sm font-semibold text-[#334155]">
                <p>city: {metaCityKeyResult.city || metaCityKeyInput}</p>
                <p>cityId: {metaCityKeyResult.cityId || getKzMetaCityOption(metaCityKeyInput).id}</p>
                <p>canonicalName: {metaCityKeyResult.canonicalName || getKzMetaCityOption(metaCityKeyInput).canonicalName}</p>
                <p>key: {metaCityKeyResult.key || "-"}</p>
                <p>name: {metaCityKeyResult.name || "-"}</p>
                <p>country_code: {metaCityKeyResult.country_code || metaCityKeyResult.countryCode || "KZ"}</p>
                <p>source: {metaCityKeyResult.source || "-"}</p>
                <p>selected: {metaCityKeyResult.selected?.name || "-"}</p>
                <p>candidates: {metaCityKeyResult.candidates?.length || 0}</p>
                <p>rejectedCandidates: {metaCityKeyResult.rejectedCandidates?.length || 0}</p>
                {metaCityKeyResult.rejectedCandidates?.length ? (
                  <p>rejectedCandidateNames: {metaCityKeyResult.rejectedCandidates.map((item) => item.name || item.reason || "unknown").join(", ")}</p>
                ) : null}
                <p>geoMode: {metaCityKeyResult.geoMode || (metaCityKeyResult.key ? "city" : "country")}</p>
                {metaCityKeyResult.warning ? <p className="mt-2 text-amber-700">warning: {metaCityKeyResult.warning}</p> : null}
              </div>
            ) : null}
          </div>
        </section>
      </div>
    );
  }

  function renderReleaseChecklist() {
    return (
      <section className="neu-card">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-black text-[#0F172A]">Release checklist</h2>
            <p className="text-sm text-[#64748B]">Хранится в release_checks, fallback: negis_release_checks.</p>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <StatusPill status={readiness.complete ? "passed" : "pending"} label={readiness.complete ? "Готово" : `Проблем: ${readiness.blockers}`} />
            <button type="button" className="neu-btn-primary w-full justify-center sm:w-auto" disabled={loading["release-autocheck"]} onClick={runReleaseAutocheck}>
              {loading["release-autocheck"] ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}
              Автопроверка релиза
            </button>
          </div>
        </div>
        <div className="grid gap-3">
          {releaseChecks.map((check) => (
            <article key={check.checkKey} className="rounded-2xl border border-[#E2E8F0] bg-white/70 p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-bold text-[#0F172A]">{check.title}</h3>
                    {check.critical && <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-bold text-red-700">critical</span>}
                    {check.automated && <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-bold text-blue-700">automated</span>}
                  </div>
                  <textarea
                    className="neu-input mt-3 min-h-20"
                    placeholder="Заметка"
                    value={check.notes}
                    onChange={(event) => {
                      const next = { ...check, notes: event.target.value };
                      setReleaseChecks((current) => current.map((item) => (item.checkKey === check.checkKey ? next : item)));
                    }}
                  />
                </div>
                <div className="flex w-full flex-col gap-2 lg:w-48">
                  <StatusPill status={check.status} />
                  {(["passed", "failed", "skipped"] as ReleaseStatus[]).map((status) => (
                    <button
                      key={status}
                      type="button"
                      className="neu-btn w-full justify-center px-3 py-2 text-xs"
                      disabled={loading[`release-${check.checkKey}`]}
                      onClick={() => saveReleaseCheck({ ...check, status })}
                    >
                      {statusLabel(status)}
                    </button>
                  ))}
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
    );
  }

  function renderDiagnostics() {
    const providers = health?.providers ? Object.entries(health.providers) : [];
    const lastRunLabel = metaInsightsLastRun
      ? {
          pending: "Ожидает",
          running: "Выполняется",
          succeeded: "Завершена",
          failed: "Ошибка",
        }[metaInsightsLastRun.status]
      : "Ещё не запускалась";
    const diagnosticsCampaign = metaInsightsLastRun?.metaCampaignLaunchId
      ? metaInsightsLaunches.find((launch) => launch.id === metaInsightsLastRun.metaCampaignLaunchId)
      : metaInsightsLaunches.find((launch) => launch.id === metaInsightsLaunchId);
    const spendSummaryLabel = metaInsightsDiagnostics.spendByCurrency.length
      ? metaInsightsDiagnostics.spendByCurrency
          .map(({ currency, spendMinor }) => formatMetaSpendMinor(spendMinor, currency))
          .join(" · ")
      : "0";
    const currencySummaryLabel = metaInsightsDiagnostics.spendByCurrency.length
      ? metaInsightsDiagnostics.spendByCurrency.map(({ currency }) => currency).join(", ")
      : "—";
    const showEmptyInsightsNote =
      metaInsightsLastRun?.status === "succeeded" && metaInsightsLastRun.rowsUpserted === 0;
    return (
      <div className="space-y-5">
        <section className="neu-card flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-black text-[#0F172A]">Health diagnostics</h2>
            <p className="text-sm text-[#64748B]">Последняя проверка: {health?.generatedAt || "еще не выполнялась"}</p>
          </div>
          <button type="button" className="neu-btn-primary w-full sm:w-auto" onClick={checkCrmHealth} disabled={loading["crm-health"]}>
            {loading["crm-health"] ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}
            Обновить
          </button>
        </section>
        <section className="neu-card" data-testid="meta-insights-manual-sync">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#0D9488]">Admin · read-only</p>
              <h2 className="mt-1 text-lg font-black text-[#0F172A]">Meta Insights: ручная синхронизация</h2>
              <p className="mt-1 max-w-3xl text-sm text-[#64748B]">
                Получает дневные факты Meta для выбранного сохранённого запуска. Кампания и её статус не изменяются; коэффициенты эффективности не рассчитываются.
              </p>
            </div>
            <span className={`w-fit rounded-full px-3 py-1 text-xs font-black ${
              serverAdminAuth.status === "confirmed"
                ? "bg-emerald-50 text-emerald-700"
                : "bg-amber-50 text-amber-700"
            }`}>
              {serverAdminAuth.status === "confirmed" ? "Админ подтверждён" : "Требуется админ-доступ"}
            </span>
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_180px_180px]">
            <label className="min-w-0 text-sm font-bold text-[#334155]">
              Кампания Meta
              <select
                className="neu-input mt-2 w-full"
                value={metaInsightsLaunchId}
                onChange={(event) => setMetaInsightsLaunchId(event.target.value)}
                disabled={loading["meta-insights-load"] || serverAdminAuth.status !== "confirmed"}
              >
                {metaInsightsLaunches.length === 0 ? <option value="">Нет подходящих реальных запусков</option> : null}
                {metaInsightsLaunches.map((launch) => (
                  <option key={launch.id} value={launch.id}>
                    {launch.campaignName || "Кампания без названия"} · {launch.metaStatus || launch.status || "создана"}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-bold text-[#334155]">
              Дата начала
              <input
                type="date"
                className="neu-input mt-2 w-full"
                value={metaInsightsDateStart}
                max={localIsoDateOffset(0)}
                onChange={(event) => setMetaInsightsDateStart(event.target.value)}
              />
            </label>
            <label className="text-sm font-bold text-[#334155]">
              Дата окончания
              <input
                type="date"
                className="neu-input mt-2 w-full"
                value={metaInsightsDateStop}
                max={localIsoDateOffset(0)}
                onChange={(event) => setMetaInsightsDateStop(event.target.value)}
              />
            </label>
          </div>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              className="neu-btn w-full justify-center sm:w-auto"
              onClick={() => void loadMetaInsightsDiagnostics()}
              disabled={loading["meta-insights-load"] || serverAdminAuth.status !== "confirmed"}
            >
              {loading["meta-insights-load"] ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}
              Обновить список
            </button>
            <button
              type="button"
              className="neu-btn-primary w-full justify-center sm:w-auto"
              onClick={() => void synchronizeMetaInsights()}
              disabled={
                loading["meta-insights-sync"] ||
                serverAdminAuth.status !== "confirmed" ||
                !metaInsightsLaunchId ||
                !metaInsightsDateStart ||
                !metaInsightsDateStop
              }
            >
              {loading["meta-insights-sync"] ? <Loader2 className="animate-spin" size={16} /> : <Database size={16} />}
              Синхронизировать Insights
            </button>
          </div>

          {metaInsightsMessage ? (
            <p className="mt-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-[#334155]">
              {metaInsightsMessage}
            </p>
          ) : null}
        </section>
        <section className="neu-card" data-testid="meta-insights-diagnostics">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#64748B]">Admin only · read-only</p>
              <h2 className="mt-1 text-lg font-black text-[#0F172A]">Meta Insights · диагностика</h2>
              <p className="mt-1 text-sm text-[#64748B]">
                Сводка безопасных дневных строк, сохранённых после ручной синхронизации.
              </p>
            </div>
            <span className={`w-fit rounded-full border px-3 py-1 text-xs font-black ${
              metaInsightsLastRun?.status === "succeeded"
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : metaInsightsLastRun?.status === "failed"
                  ? "border-red-200 bg-red-50 text-red-700"
                  : "border-slate-200 bg-slate-50 text-slate-600"
            }`}>
              {lastRunLabel}
            </span>
          </div>

          <div className="mt-5 grid gap-x-6 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-[#64748B]">Последняя синхронизация</p>
              <p className="mt-1 font-black text-[#0F172A]">{lastRunLabel}</p>
            </div>
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-[#64748B]">Дата и время</p>
              <p className="mt-1 font-black text-[#0F172A]">
                {formatAdminDateTime(metaInsightsLastRun?.finishedAt || metaInsightsLastRun?.createdAt)}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-[#64748B]">Кампания</p>
              <p className="mt-1 break-words font-black text-[#0F172A]">
                {diagnosticsCampaign?.campaignName || "—"}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-[#64748B]">Запрошенный период</p>
              <p className="mt-1 font-black text-[#0F172A]">
                {metaInsightsLastRun?.dateStart && metaInsightsLastRun?.dateStop
                  ? `${metaInsightsLastRun.dateStart} — ${metaInsightsLastRun.dateStop}`
                  : "—"}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-[#64748B]">Строк сохранено за запуск</p>
              <p className="mt-1 font-black text-[#0F172A]">{metaInsightsLastRun?.rowsUpserted ?? "—"}</p>
            </div>
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-[#64748B]">Всего строк Insights</p>
              <p className="mt-1 font-black text-[#0F172A]">{metaInsightsDiagnostics.totalRows}</p>
            </div>
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-[#64748B]">Последние данные fetched_at</p>
              <p className="mt-1 font-black text-[#0F172A]">
                {formatAdminDateTime(metaInsightsDiagnostics.latestFetchedAt)}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-[#64748B]">Расход в доступных строках</p>
              <p className="mt-1 break-words font-black text-[#0F172A]">{spendSummaryLabel}</p>
            </div>
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-[#64748B]">Валюта</p>
              <p className="mt-1 font-black text-[#0F172A]">{currencySummaryLabel}</p>
            </div>
          </div>

          {showEmptyInsightsNote ? (
            <p className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
              Meta не вернула данные за выбранный период. Это нормально для выключенных или не откручивавшихся кампаний.
            </p>
          ) : null}
          {metaInsightsLastRun?.status === "failed" && metaInsightsLastRun.errorMessage ? (
            <p className="mt-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
              {metaInsightsLastRun.errorMessage}
            </p>
          ) : null}

          <div className="mt-5 border-t border-[#E2E8F0] pt-4 text-sm text-[#64748B]">
            <p>Расходы Meta показываются отдельно от выручки CRM.</p>
            <p className="mt-1 font-semibold text-[#475569]">Это ещё не ROI и не эффективность рекламы.</p>
          </div>
        </section>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {providers.length === 0 ? (
            <section className="neu-card">
              <p className="text-sm text-[#64748B]">Нажмите “Обновить”, чтобы получить server-side health.</p>
            </section>
          ) : (
            providers.map(([key]) => (
              <section key={key} className="neu-card">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-black capitalize text-[#0F172A]">{key}</h3>
                  <StatusPill status={providerStatus(health, key)} />
                </div>
                <p className="mt-3 text-sm text-[#64748B]">{providerDetails(health, key)}</p>
              </section>
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <PageLayout>
      <div className="space-y-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#64748B]">Администрирование</p>
            <h1 className="mt-2 text-2xl font-semibold text-[#0F172A]">Настройки клиники</h1>
            <p className="mt-2 max-w-3xl text-sm text-[#64748B]">
              Клиника: {workspaceId}. Владелец: {user?.email || "demo user"}.
            </p>
          </div>
          <button type="button" className="neu-btn w-full justify-center xl:w-auto" onClick={() => setLocation("/ai-control-center")}>
            Вернуться в приложение
          </button>
        </div>

        {/* Internal platform diagnostics — progressive disclosure for Medina
            Platform staff only; hidden by default from the clinic settings flow.
            Commercial-2+ will move this behind a server-verified superadmin role. */}
        <details className="rounded-xl border border-slate-700 bg-slate-900 text-white">
          <summary className="cursor-pointer select-none p-4 text-sm font-semibold text-slate-200">
            Диагностика платформы · внутренний раздел Medina Platform
          </summary>
          <div className="border-t border-slate-700 p-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-teal-300">Панель платформы · Medina OS</p>
            <h2 className="mt-1 text-lg font-semibold">Внутренняя диагностика платформы</h2>
            {/*
              Ссылка на панель владельца платформы появляется только после
              успешной пробы серверного маршрута. Показывать её всем нельзя:
              владелец клиники узнал бы, что в продукте есть экран со списком
              всех клиник, — а существование панели тоже сведения. Не владелец
              платформы пробу не проходит и ссылки не видит.
            */}
            {platformPanelAvailable ? (
              <Link href="/platform">
                <div className="neu-btn mt-3 inline-flex items-center gap-2 px-4 py-2 text-sm">
                  Открыть панель платформы
                </div>
              </Link>
            ) : null}
            <p className="mt-1 max-w-3xl text-sm text-slate-300">
              Раздел для команды Medina Platform. Секреты, токены и service role key здесь не отображаются.
            </p>
            <div className="mt-4">
              <ReleaseBanner readiness={readiness} />
            </div>
          </div>
        </details>

        <section className="neu-card flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between" data-testid="server-admin-auth">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-teal-50 text-teal-700">
              {serverAdminAuth.status === "checking" ? (
                <Loader2 className="animate-spin" size={19} />
              ) : serverAdminAuth.status === "confirmed" ? (
                <ShieldCheck size={19} />
              ) : (
                <AlertTriangle size={19} />
              )}
            </span>
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#64748B]">Сессия</p>
              <h2 className="mt-1 text-base font-black text-[#0F172A]">
                {serverAdminAuth.status === "confirmed" && "Админ-доступ подтверждён"}
                {serverAdminAuth.status === "reauth" && "Сессия завершена"}
                {serverAdminAuth.status === "forbidden" && "Недостаточно прав"}
                {serverAdminAuth.status === "unavailable" && "Не удалось проверить доступ"}
                {serverAdminAuth.status === "checking" && "Проверяем доступ…"}
              </h2>
              <p className="mt-1 text-sm text-[#64748B]">
                {serverAdminAuth.status === "confirmed" && "Доступ администратора подтверждён для текущей клиники."}
                {serverAdminAuth.status === "reauth" && "Для защиты данных необходимо войти в аккаунт повторно."}
                {serverAdminAuth.status === "forbidden" && "Для этого раздела нужна активная роль владельца или администратора."}
                {serverAdminAuth.status === "unavailable" && "Сервис авторизации временно недоступен. Остальные разделы можно использовать."}
                {serverAdminAuth.status === "checking" && "Проверяем сессию и права доступа."}
              </p>
            </div>
          </div>
          <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row">
            {serverAdminAuth.status === "reauth" ? (
              <button
                type="button"
                className="neu-btn-primary w-full justify-center sm:w-auto"
                onClick={() => setLocation("/login")}
              >
                Войти снова
              </button>
            ) : null}
            <button
              type="button"
              className="neu-btn w-full justify-center sm:w-auto"
              onClick={() => void checkServerAdminAccess()}
              disabled={serverAdminAuth.status === "checking"}
            >
              <RefreshCw size={16} />
              Проверить доступ
            </button>
          </div>
        </section>

        {/* Commercial-2: honest pilot status + support path. There is no billing
            domain yet — no payment claims, no fake purchase flow, no dead CTA
            buttons. The only action is a functional workspace-ID copy for support. */}
        <div className="grid gap-4 lg:grid-cols-2">
          {/*
            Здесь была одна фраза: «условия пилота и тариф согласуются с
            менеджером». Тарифов на экране не было вовсе — их ключи жили во
            фронтенде, цен не было нигде, и клиника не могла узнать, за что и
            сколько платит. Теперь текущий тариф читается из её собственной
            подписки, рядом стоит прайс, а расчёт стоимости считает нашу часть
            счёта и позволяет вписать чужую.
          */}
          <PlanCalculator />
          <VerticalSwitch />
          <section className="neu-card" aria-label="Поддержка">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#64748B]">Поддержка</p>
            <h2 className="mt-1 text-base font-black text-[#0F172A]">Связь с Medina OS</h2>
            <p className="mt-1 text-sm text-[#64748B]">
              Канал поддержки настраивается для вашей клиники. До подключения обращайтесь к вашему менеджеру Medina OS и указывайте идентификатор клиники.
            </p>
            <button
              type="button"
              className="neu-btn mt-3"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(workspaceId);
                  toast.success("Идентификатор клиники скопирован");
                } catch {
                  toast.error("Не удалось скопировать идентификатор");
                }
              }}
            >
              Скопировать идентификатор клиники
            </button>
          </section>
        </div>

        <div className="md:hidden">
          <label className="mb-2 block text-xs font-bold uppercase tracking-[0.12em] text-[#64748B]">Раздел админки</label>
          <select className="neu-input w-full" value={activeTab} onChange={(event) => setActiveTab(event.target.value as AdminTab)}>
            {tabs.map((tab) => (
              <option key={tab.id} value={tab.id}>{tabLabel(tab)}</option>
            ))}
          </select>
        </div>

        <nav className="hidden overflow-x-auto md:block" aria-label="Admin sections">
          <div className="inline-flex min-w-max gap-2 rounded-[28px] border border-white/70 bg-white/55 p-2 shadow-[8px_10px_28px_rgba(116,135,154,0.12)]">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`flex min-h-11 items-center gap-2 rounded-2xl px-4 text-sm font-bold transition ${
                  activeTab === tab.id ? "bg-[#0D9488] text-white shadow-[0_8px_20px_rgba(13,148,136,0.22)]" : "text-[#64748B] hover:bg-white/80"
                }`}
                onClick={() => setActiveTab(tab.id)}
              >
                <tab.icon size={16} />
                {tabLabel(tab)}
              </button>
            ))}
          </div>
        </nav>

        {activeTab === "overview" && renderOverview()}
        {activeTab === "staff" && renderStaff()}
        {activeTab === "doctors" && <DoctorSchedule />}
        {activeTab === "roles" && renderRoles()}
        {activeTab === "clinic" && renderClinic()}
        {activeTab === "whatsapp" && <WhatsAppChannels />}
        {activeTab === "integrations" && renderIntegrations()}
        {activeTab === "ai" && renderAiProviders()}
        {activeTab === "meta" && renderMeta()}
        {activeTab === "release" && renderReleaseChecklist()}
        {activeTab === "diagnostics" && renderDiagnostics()}
      </div>
    </PageLayout>
  );
}

function buildIntegrationCards(health: CrmHealthData | null): IntegrationCard[] {
  return [
    {
      key: "supabase",
      title: "Supabase",
      description: "Storage для CRM, настроек и release checklist",
      status: providerStatus(health, "supabase"),
      icon: Database,
      details: providerDetails(health, "supabase"),
    },
    {
      key: "adCreativesStorage",
      title: "Ad creatives storage",
      description: "Bucket ad-creatives для фото и видео рекламы",
      status: providerStatus(health, "adCreativesStorage"),
      icon: FileCheck2,
      details: `${providerDetails(health, "adCreativesStorage")}. Дополнительно проверьте /api/crm/storage-health.`,
    },
    {
      key: "telegram",
      title: "Telegram",
      description: "Content Studio handoff",
      status: providerStatus(health, "telegram"),
      icon: MessageCircle,
      details: providerDetails(health, "telegram"),
    },
    {
      key: "openai",
      title: "OpenAI",
      description: "Content text, summaries, reports",
      status: providerStatus(health, "openai"),
      icon: Sparkles,
      details: providerDetails(health, "openai"),
    },
    {
      key: "anthropic",
      title: "Anthropic",
      description: "Targeting Agent analysis",
      status: providerStatus(health, "anthropic"),
      icon: Bot,
      details: providerDetails(health, "anthropic"),
    },
    {
      key: "gemini",
      title: "Gemini",
      description: "Prompt generation fallback",
      status: providerStatus(health, "gemini"),
      icon: BrainCircuit,
      details: providerDetails(health, "gemini"),
    },
    {
      key: "elevenlabs",
      title: "ElevenLabs",
      description: "Voice generation",
      status: providerStatus(health, "elevenlabs"),
      icon: Stethoscope,
      details: providerDetails(health, "elevenlabs"),
    },
    {
      key: "heygen",
      title: "HeyGen",
      description: "Avatar/video generation",
      status: providerStatus(health, "heygen"),
      icon: Bot,
      details: providerDetails(health, "heygen"),
    },
    {
      key: "targetingAgent",
      title: "Railway Targeting Agent",
      description: "MedCall analyze / launch / report proxy",
      status: providerStatus(health, "targetingAgent"),
      icon: BrainCircuit,
      details: providerDetails(health, "targetingAgent"),
    },
    {
      key: "meta",
      title: "Meta/Facebook Ads",
      description: "Manual approval connector foundation",
      status: providerStatus(health, "meta"),
      icon: Facebook,
      details: providerDetails(health, "meta"),
    },
  ];
}

function ReleaseBanner({ readiness }: { readiness: { complete: boolean; blockers: number; score: number } }) {
  return (
    <section className={`rounded-[22px] border p-4 ${readiness.complete ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          {readiness.complete ? <CheckCircle2 className="mt-0.5 text-emerald-700" size={20} /> : <AlertTriangle className="mt-0.5 text-amber-700" size={20} />}
          <div>
            <p className={`font-bold ${readiness.complete ? "text-emerald-800" : "text-amber-800"}`}>
              {readiness.complete
                ? "Платформа готова к тестовой работе сотрудников"
                : "Платформа в режиме подготовки к релизу"}
            </p>
            <p className={`mt-1 text-sm ${readiness.complete ? "text-emerald-700" : "text-amber-700"}`}>
              Готовность платформы: {readiness.score}% · критические проблемы: {readiness.blockers}
            </p>
            <p className={`mt-1 text-xs ${readiness.complete ? "text-emerald-700" : "text-amber-700"}`}>
              Optional AI providers вроде ElevenLabs, HeyGen, Gemini, Anthropic и TapNow не считаются blocker.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function StatusTile({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[#E2E8F0] bg-white/70 p-4">
      <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#94A3B8]">{title}</p>
      <p className="mt-2 text-2xl font-black text-[#0F172A]">{value}</p>
    </div>
  );
}

function StatusPill({ status, label }: { status: Status | ReleaseStatus | string; label?: string }) {
  return (
    <span className={`inline-flex w-fit items-center rounded-full border px-3 py-1 text-xs font-bold ${statusClass(status as Status | ReleaseStatus)}`}>
      {label || statusLabel(status as Status | ReleaseStatus)}
    </span>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-bold uppercase tracking-[0.12em] text-[#64748B]">{label}</span>
      <input className="neu-input w-full" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function IntegrationStatusCard({
  card,
  loading,
  onCheck,
}: {
  card: IntegrationCard;
  loading: boolean;
  onCheck?: () => void | Promise<void>;
}) {
  const Icon = card.icon;
  return (
    <section className="neu-card">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="rounded-2xl bg-[#E0F2FE] p-2 text-[#0369A1]">
            <Icon size={20} />
          </div>
          <div className="min-w-0">
            <h3 className="font-black text-[#0F172A]">{card.title}</h3>
            <p className="mt-1 text-sm text-[#64748B]">{card.description}</p>
          </div>
        </div>
        <StatusPill status={card.status} />
      </div>
      <p className="text-sm text-[#334155]">{card.details || "Проверка не выполнялась"}</p>
      {card.hint && <p className="mt-2 rounded-2xl bg-amber-50 px-3 py-2 text-sm text-amber-800">{card.hint}</p>}
      {onCheck && (
        <button type="button" className="neu-btn mt-4 w-full justify-center" disabled={loading} onClick={() => void onCheck()}>
          {loading ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}
          Проверить
        </button>
      )}
    </section>
  );
}

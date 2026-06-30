import { useMemo, useState } from "react";
import { useLocation } from "wouter";
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
import { useAuth } from "@/contexts/AuthContext";
import { apiUrl } from "@/lib/api";
import {
  permissionLabels,
  permissionsForRole,
  roleLabels,
  staffRoles,
  type CrmPermission,
  type StaffRole,
} from "@/lib/permissions";

type AdminTab =
  | "overview"
  | "staff"
  | "roles"
  | "clinic"
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

type ProviderPresence = {
  status: Status;
  configured: number;
  total: number;
  keys: Array<{ key: string; configured: boolean }>;
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
  businessId: string;
  adAccountId: string;
  pageId: string;
  instagramActorId: string;
  hasAccessToken: boolean;
  hasAppSecret: boolean;
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
  temporaryPasswordSet?: boolean;
};

type ClinicSettings = {
  clinicName: string;
  city: string;
  phone: string;
  whatsapp: string;
  address: string;
  workingHours: string;
  defaultDoctors: string;
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
  { id: "roles", label: "Роли и доступы", icon: ShieldCheck },
  { id: "clinic", label: "Клиника", icon: Building2 },
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
  workingHours: "Пн-Сб 09:00-20:00",
  defaultDoctors: "Косметолог, стоматолог, администратор",
  defaultServices: "Консультация, диагностика, первичный прием",
  brandTone: "Спокойный, экспертный, заботливый",
  legalDisclaimer: "Информация не является медицинской рекомендацией. Перед процедурой нужна консультация специалиста.",
  timezone: "Asia/Almaty",
};

const staffDefaults: StaffMember[] = [
  {
    id: "staff-owner",
    name: "Администратор Negis",
    email: "owner@negis.demo",
    phone: "+7 700 000 00 01",
    role: "owner",
    status: "active",
    temporaryPasswordSet: true,
  },
  {
    id: "staff-reception",
    name: "Ресепшн",
    email: "reception@negis.demo",
    phone: "+7 700 000 00 02",
    role: "receptionist",
    status: "active",
    temporaryPasswordSet: true,
  },
];

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

function readStored<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStored<T>(key: string, value: T) {
  window.localStorage.setItem(key, JSON.stringify(value));
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

async function crmRequest<T>(path: string, init?: globalThis.RequestInit): Promise<ApiResponse<T>> {
  const response = await fetch(apiUrl(path), init);
  const body = await safeJson<T>(response);
  if (!response.ok || body.success === false) {
    throw new Error(body.error || body.details?.join(", ") || `HTTP ${response.status}`);
  }
  return body;
}

function statusLabel(status: Status | ReleaseStatus) {
  const labels: Record<string, string> = {
    configured: "Настроено",
    connected: "Подключено",
    not_configured: "Не настроено",
    partial: "Частично",
    error: "Ошибка",
    checking: "Проверяется",
    demo: "Demo fallback",
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

function defaultTemporaryPassword() {
  return `Negis2026!${Math.random().toString(36).slice(2, 8)}`;
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
  const { clinicId, user } = useAuth();
  const workspaceId = clinicId || "demo-workspace";
  const [activeTab, setActiveTab] = useState<AdminTab>("overview");
  const [clinic, setClinic] = useState<ClinicSettings>(() => readStored("negis_clinic_settings", clinicDefaults));
  const [staff, setStaff] = useState<StaffMember[]>(() => readStored("negis_demo_staff", staffDefaults));
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
  const [integrationCards, setIntegrationCards] = useState<IntegrationCard[]>(() => buildIntegrationCards(null));
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [staffForm, setStaffForm] = useState({
    name: "",
    email: "",
    phone: "",
    role: "receptionist" as StaffRole,
    status: "active",
    temporaryPassword: defaultTemporaryPassword(),
  });
  const [createdCredentials, setCreatedCredentials] = useState<{ email: string; temporaryPassword: string; loginUrl: string } | null>(null);

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

  const setBusy = (key: string, value: boolean) => setLoading((current) => ({ ...current, [key]: value }));

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
      const response = await fetch(apiUrl("/api/content-studio/send-telegram"), {
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
              const response = await fetch(apiUrl("/api/content-studio/send-telegram"), {
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
        metaBusinessId: meta.businessId || metaAccount.metaBusinessId,
        adAccountId: meta.adAccountId || metaAccount.adAccountId,
        pageId: meta.pageId || metaAccount.pageId,
        instagramActorId: meta.instagramActorId || metaAccount.instagramActorId,
        accountName: "Negis Meta Ads",
        currency: "USD",
        timezoneName: "Asia/Almaty",
        status: "draft",
        permissions: {
          ...metaAccount.permissions,
          appCreated: meta.hasAppSecret || metaAccount.permissions.appCreated,
          adAccountConnected: Boolean(meta.adAccountId) || metaAccount.permissions.adAccountConnected,
          pageConnected: Boolean(meta.pageId) || metaAccount.permissions.pageConnected,
          instagramConnected: Boolean(meta.instagramActorId) || metaAccount.permissions.instagramConnected,
          manualApproval: true,
        },
      };
      setMetaAccount(next);
      toast.success("Meta поля заполнены из безопасных env");
    } finally {
      setBusy("meta-prefill", false);
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

  async function createStaffMember() {
    if (!staffForm.name.trim() || !staffForm.email.trim()) {
      toast.error("Укажите имя и email сотрудника");
      return;
    }

    setBusy("staff", true);
    const draft: StaffMember = {
      id: `staff-${Date.now()}`,
      name: staffForm.name.trim(),
      email: staffForm.email.trim().toLowerCase(),
      phone: staffForm.phone.trim(),
      role: staffForm.role,
      status: staffForm.status,
      temporaryPasswordSet: true,
    };

    try {
      const body = await crmRequest<{ item?: StaffMember; staff?: StaffMember; temporaryPassword?: string; loginUrl?: string }>("/api/crm/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          ...draft,
          temporaryPassword: staffForm.temporaryPassword,
        }),
      });
      const item = body.data?.staff || body.data?.item || draft;
      const next = [item, ...staff.filter((member) => member.email !== item.email)];
      setStaff(next);
      writeStored("negis_demo_staff", next);
      setCreatedCredentials({
        email: item.email,
        temporaryPassword: body.data?.temporaryPassword || staffForm.temporaryPassword,
        loginUrl: body.data?.loginUrl || "/login",
      });
      setStaffForm({
        name: "",
        email: "",
        phone: "",
        role: "receptionist",
        status: "active",
        temporaryPassword: defaultTemporaryPassword(),
      });
      toast.success("Сотрудник добавлен");
    } catch (error) {
      const next = [draft, ...staff.filter((member) => member.email !== draft.email)];
      setStaff(next);
      writeStored("negis_demo_staff", next);
      setCreatedCredentials({ email: draft.email, temporaryPassword: staffForm.temporaryPassword, loginUrl: "/login" });
      toast.warning(error instanceof Error ? error.message : "Сотрудник сохранен локально");
    } finally {
      setBusy("staff", false);
    }
  }

  function updateStaffStatus(id: string, status: string) {
    const next = staff.map((member) => (member.id === id ? { ...member, status } : member));
    setStaff(next);
    writeStored("negis_demo_staff", next);
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

  async function copyCredentials() {
    if (!createdCredentials) return;
    try {
      await navigator.clipboard.writeText(
        [
          "Negis CRM login",
          `Email: ${createdCredentials.email}`,
          `Temporary password: ${createdCredentials.temporaryPassword}`,
          `URL: ${createdCredentials.loginUrl}`,
        ].join("\n"),
      );
      toast.success("Данные входа скопированы");
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
        <ReleaseBanner readiness={readiness} />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard title="Release readiness" value={`${readiness.score}%`} icon={Gauge} tone={readiness.complete ? "emerald" : "amber"} />
          <MetricCard title="Critical blockers" value={String(readiness.blockers)} icon={AlertTriangle} tone={readiness.blockers ? "red" : "emerald"} />
          <MetricCard title="Integration health" value={`${connected}/${integrationCards.length}`} icon={Database} tone="blue" />
          <MetricCard title="Staff count" value={String(staff.length)} icon={Users} tone="teal" />
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
              <button type="button" className="neu-btn w-full justify-center" onClick={() => setLocation("/targeting-agent")}>
                <BrainCircuit size={16} />
                ИИ таргетолог
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
          <h2 className="text-lg font-black text-[#0F172A]">Новый сотрудник</h2>
          <div className="mt-4 grid gap-3">
            <input className="neu-input" placeholder="Имя" value={staffForm.name} onChange={(event) => setStaffForm({ ...staffForm, name: event.target.value })} />
            <input className="neu-input" placeholder="Email" value={staffForm.email} onChange={(event) => setStaffForm({ ...staffForm, email: event.target.value })} />
            <input className="neu-input" placeholder="Телефон" value={staffForm.phone} onChange={(event) => setStaffForm({ ...staffForm, phone: event.target.value })} />
            <select className="neu-input" value={staffForm.role} onChange={(event) => setStaffForm({ ...staffForm, role: event.target.value as StaffRole })}>
              {staffRoles.map((role) => (
                <option key={role} value={role}>{roleLabels[role]}</option>
              ))}
            </select>
            <input
              className="neu-input"
              placeholder="Временный пароль"
              value={staffForm.temporaryPassword}
              onChange={(event) => setStaffForm({ ...staffForm, temporaryPassword: event.target.value })}
            />
            <button type="button" className="neu-btn-primary w-full justify-center" disabled={loading.staff} onClick={createStaffMember}>
              {loading.staff ? <Loader2 className="animate-spin" size={16} /> : <UserPlus size={16} />}
              Создать сотрудника
            </button>
          </div>
          {createdCredentials && (
            <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
              <p className="font-bold">Данные для входа готовы</p>
              <p className="mt-1">Email: {createdCredentials.email}</p>
              <p>Пароль: {createdCredentials.temporaryPassword}</p>
              <button type="button" className="neu-btn mt-3 w-full justify-center bg-white/80" onClick={copyCredentials}>
                <Copy size={15} />
                Скопировать
              </button>
            </div>
          )}
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
          <Field label="workingHours" value={clinic.workingHours} onChange={(value) => update("workingHours", value)} />
          <Field label="defaultDoctors" value={clinic.defaultDoctors} onChange={(value) => update("defaultDoctors", value)} />
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
        metaSummary?.businessId ||
        metaSummary?.adAccountId ||
        metaSummary?.pageId ||
        metaSummary?.instagramActorId ||
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
            <StatusPill status={readiness.complete ? "passed" : "pending"} label={readiness.complete ? "Готово" : `${readiness.blockers} blockers`} />
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
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#64748B]">Admin Center</p>
            <h1 className="mt-2 text-3xl font-black text-[#0F172A]">Release-ready управление Negis CRM</h1>
            <p className="mt-2 max-w-3xl text-sm text-[#64748B]">
              Workspace: {workspaceId}. Owner: {user?.email || "demo user"}. Секретные ключи хранятся только в Vercel env.
            </p>
          </div>
          <button type="button" className="neu-btn w-full justify-center xl:w-auto" onClick={() => setLocation("/dashboard")}>
            Вернуться в dashboard
          </button>
        </div>

        <ReleaseBanner readiness={readiness} />

        <div className="md:hidden">
          <label className="mb-2 block text-xs font-bold uppercase tracking-[0.12em] text-[#64748B]">Раздел админки</label>
          <select className="neu-input w-full" value={activeTab} onChange={(event) => setActiveTab(event.target.value as AdminTab)}>
            {tabs.map((tab) => (
              <option key={tab.id} value={tab.id}>{tab.label}</option>
            ))}
          </select>
        </div>

        <nav className="hidden overflow-x-auto md:block" aria-label="Admin sections">
          <div className="inline-flex min-w-max gap-2 rounded-[28px] border border-white/70 bg-white/55 p-2 shadow-[8px_10px_28px_rgba(116,135,154,0.12)]">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className={`flex min-h-11 items-center gap-2 rounded-2xl px-4 text-sm font-bold transition ${
                  activeTab === id ? "bg-[#0D9488] text-white shadow-[0_8px_20px_rgba(13,148,136,0.22)]" : "text-[#64748B] hover:bg-white/80"
                }`}
                onClick={() => setActiveTab(id)}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </div>
        </nav>

        {activeTab === "overview" && renderOverview()}
        {activeTab === "staff" && renderStaff()}
        {activeTab === "roles" && renderRoles()}
        {activeTab === "clinic" && renderClinic()}
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
              Readiness {readiness.score}% · blockers {readiness.blockers}
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

function MetricCard({ title, value, icon: Icon, tone }: { title: string; value: string; icon: LucideIcon; tone: "emerald" | "amber" | "red" | "blue" | "teal" }) {
  const toneClass = {
    emerald: "bg-emerald-50 text-emerald-700",
    amber: "bg-amber-50 text-amber-700",
    red: "bg-red-50 text-red-700",
    blue: "bg-blue-50 text-blue-700",
    teal: "bg-teal-50 text-teal-700",
  }[tone];

  return (
    <section className="neu-card">
      <div className="mb-3 flex items-center gap-3">
        <div className={`rounded-2xl p-2 ${toneClass}`}>
          <Icon size={20} />
        </div>
        <p className="text-sm font-bold text-[#64748B]">{title}</p>
      </div>
      <p className="text-3xl font-black text-[#0F172A]">{value}</p>
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

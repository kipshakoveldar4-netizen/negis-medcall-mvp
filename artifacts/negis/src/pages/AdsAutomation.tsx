import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  FileImage,
  History,
  Loader2,
  Megaphone,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Sparkles,
  Trash2,
  UploadCloud,
  Video,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";
import { PageLayout } from "@/components/layout/PageLayout";
import { useAuth } from "@/contexts/AuthContext";
import { apiUrl } from "@/lib/api";
import { hasSupabaseFrontendEnv, supabase } from "@/lib/supabase";
import { getPlanFeature, normalizePlan, planFeatureBadge, type NegisPlan } from "@/lib/planFeatures";

type ApiResponse<TData = Record<string, unknown>> =
  | {
      success: true;
      mode?: string;
      warning?: string;
      data: TData;
    }
  | {
      success: false;
      error: string;
      details?: string[];
      hint?: string;
      data?: TData;
    };

type CreativeAsset = {
  id?: string;
  fileName: string;
  fileType: "image" | "video";
  mimeType: string;
  fileSize: number;
  previewUrl: string;
  publicUrl?: string;
  storagePath?: string;
  storageBucket?: string;
  metaVideoId?: string;
  status: string;
};

type LeadDestination = "whatsapp" | "instagram_profile" | "website" | "lead_form" | "call";

type Brief = {
  service: string;
  city: string;
  leadDestination: LeadDestination;
  destinationValue: string;
  dailyBudget: string;
  startDate: string;
  endDate: string;
  days: string;
  offer: string;
  knownAudience: string;
  restrictions: string;
};

type AiPackage = {
  campaignName?: string;
  objective?: string;
  objectiveLabel?: string;
  primaryText?: string;
  headline?: string;
  description?: string;
  cta?: string;
  ctaLabel?: string;
  destinationLabel?: string;
  destinationUrl?: string;
  audience?: string;
  targeting?: Record<string, unknown>;
  placements?: string[];
  budgetPlan?: Record<string, unknown>;
  metaPayloadPreview?: Record<string, unknown>;
  humanReport?: {
    summary?: string;
    whatWillRun?: string;
    whereLeadsGo?: string;
    risks?: string[];
    recommendations?: string[];
  };
  safeWording?: Record<string, unknown>;
  generatedBy?: string;
};

type ComplianceResult = {
  status?: "safe" | "needs_review" | "blocked";
  issues?: Array<{ code?: string; message?: string; severity?: string }>;
  safeText?: string;
};

type LaunchResult = {
  launchId?: string;
  metaCampaignId?: string;
  metaAdSetId?: string;
  metaCreativeId?: string;
  metaAdId?: string;
  status?: string;
  metaStatus?: string;
  dryRun?: boolean;
  compliance?: ComplianceResult;
  safeText?: string;
  launch?: Record<string, unknown>;
  metaPayload?: Record<string, unknown>;
  warning?: string;
};

type MetaSummary = {
  configured?: boolean;
  adAccountId?: string;
  pageId?: string;
  instagramActorId?: string;
  hasAccessToken?: boolean;
};

type StorageHealth = {
  bucket?: string;
  exists?: boolean;
  publicAccess?: boolean;
  canUpload?: boolean;
  publicUrlWorks?: boolean;
  hint?: string;
};

type UploadStatus = "idle" | "validating" | "getting_signed_url" | "uploading_to_storage" | "saving_metadata" | "ready" | "failed";

type UploadDebug = {
  assetId?: string;
  fileName?: string;
  fileType?: string;
  uploadMode?: string;
  signedUpload?: boolean;
  storagePath?: string;
  storagePathExists?: boolean;
  publicUrlExists: boolean;
  publicUrlPreview?: string;
  uploadStage?: string;
  lastError?: string;
  responseKeys: string[];
};

type SignedUploadData = {
  bucket?: string;
  storageBucket?: string;
  storagePath?: string;
  signedUrl?: string;
  token?: string;
  publicUrl?: string;
};

type ConfirmationState = {
  textChecked: boolean;
  budgetChecked: boolean;
  leadDestinationChecked: boolean;
  clinicAuthority: boolean;
  manualApproval: boolean;
  spendUnderstood: boolean;
};

type LaunchHistoryItem = {
  id?: string;
  campaignName?: string;
  status?: string;
  metaCampaignId?: string;
  metaStatus?: string;
  budgetDailyMinor?: number | null;
  currency?: string;
  launchedBy?: string;
  lastError?: string;
  createdAt?: string;
  payload?: Record<string, unknown>;
};

const inputStyle: CSSProperties = {
  width: "100%",
  borderRadius: 14,
  border: "1px solid #D8E4EC",
  background: "rgba(255,255,255,0.78)",
  color: "#0F172A",
  fontSize: 14,
  padding: "12px 13px",
  outline: "none",
  boxShadow: "inset 2px 2px 7px rgba(116,135,154,0.10), inset -2px -2px 8px rgba(255,255,255,0.85)",
};

const labelStyle: CSSProperties = {
  display: "block",
  marginBottom: 7,
  fontSize: 11,
  fontWeight: 800,
  color: "#60728A",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const defaultBrief: Brief = {
  service: "Консультация косметолога",
  city: "Астана",
  leadDestination: "whatsapp",
  destinationValue: "+7 700 000 00 00",
  dailyBudget: "20",
  startDate: tomorrow,
  endDate: "",
  days: "7",
  offer: "Бесплатная консультация и диагностика",
  knownAudience: "Женщины 25-45, интересуются уходом за кожей и услугами клиники",
  restrictions: "Без обещаний результата, без до/после, без давления на внешность",
};

const confirmationDefaults: ConfirmationState = {
  textChecked: false,
  budgetChecked: false,
  leadDestinationChecked: false,
  clinicAuthority: false,
  manualApproval: false,
  spendUnderstood: false,
};

const VERCEL_FUNCTION_FILE_LIMIT_BYTES = 4 * 1024 * 1024;

const destinationOptions: Array<{ value: LeadDestination; label: string; placeholder: string }> = [
  { value: "whatsapp", label: "WhatsApp", placeholder: "+7 700 000 00 00" },
  { value: "instagram_profile", label: "Instagram профиль", placeholder: "@clinic или https://instagram.com/clinic" },
  { value: "website", label: "Сайт/лендинг", placeholder: "https://clinic.kz/offer" },
  { value: "lead_form", label: "Meta Lead Form", placeholder: "form_id, если уже создан в Meta" },
  { value: "call", label: "Звонок", placeholder: "+7 700 000 00 00" },
];

const wizardSteps = [
  "Креатив",
  "Параметры",
  "ИИ заполнит",
  "Проверка",
  "Отчёт",
  "Запуск",
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function readStringField(record: Record<string, unknown>, keys: string[], fallback = "") {
  return firstString(...keys.map((key) => record[key]), fallback);
}

function readNumberField(record: Record<string, unknown>, keys: string[], fallback: number) {
  for (const key of keys) {
    const value = record[key];
    const numeric = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return fallback;
}

function buildFrontendStoragePublicUrl(storagePath: string, storageBucket = "ad-creatives") {
  const env = import.meta.env as Record<string, string | undefined>;
  const supabaseUrl = firstString(env.VITE_SUPABASE_URL).replace(/\/$/, "");
  if (!supabaseUrl || !storagePath) return "";

  const encodedPath = storagePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${supabaseUrl}/storage/v1/object/public/${encodeURIComponent(storageBucket)}/${encodedPath}`;
}

function readStored<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function readWorkspaceId() {
  return readStored<{ id?: string }>("negis_demo_workspace", { id: "demo-workspace" }).id || "demo-workspace";
}

function normalizeAsset(value: unknown, fallback: CreativeAsset): CreativeAsset {
  const record = asRecord(value);
  const storageBucket = readStringField(record, ["storageBucket", "storage_bucket"], fallback.storageBucket || "ad-creatives");
  const storagePath = readStringField(record, ["storagePath", "storage_path"], fallback.storagePath || "");
  const publicUrl =
    readStringField(
      record,
      ["publicUrl", "public_url", "publicURL", "url", "imageUrl", "image_url", "imageURL", "videoUrl", "video_url", "videoURL", "creativeUrl", "creative_url"],
      fallback.publicUrl || "",
    ) ||
    buildFrontendStoragePublicUrl(storagePath, storageBucket);
  const explicitFileType = readStringField(record, ["fileType", "file_type", "creativeType", "creative_type"], fallback.fileType);
  return {
    id: readStringField(record, ["id"], fallback.id || "") || fallback.id,
    fileName: readStringField(record, ["fileName", "file_name"], fallback.fileName),
    fileType: explicitFileType === "video" ? "video" : "image",
    mimeType: readStringField(record, ["mimeType", "mime_type"], fallback.mimeType),
    fileSize: readNumberField(record, ["fileSize", "file_size"], fallback.fileSize),
    previewUrl: fallback.previewUrl,
    publicUrl,
    storagePath,
    storageBucket,
    metaVideoId: readStringField(record, ["metaVideoId", "meta_video_id", "videoId", "video_id"], fallback.metaVideoId || "") || undefined,
    status: readStringField(record, ["status"], fallback.status),
  };
}

function publicDestinationUrl(brief: Brief) {
  const value = brief.destinationValue.trim();
  if (!value) return "";

  if (brief.leadDestination === "whatsapp") {
    const digits = value.replace(/\D/g, "");
    return digits ? `https://wa.me/${digits}` : value;
  }

  if (brief.leadDestination === "instagram_profile") {
    if (value.startsWith("http")) return value;
    return `https://instagram.com/${value.replace(/^@/, "")}`;
  }

  if (brief.leadDestination === "call") {
    return `tel:${value.replace(/[^\d+]/g, "")}`;
  }

  if (brief.leadDestination === "website") {
    return value.startsWith("http") ? value : `https://${value}`;
  }

  return value;
}

function ctaLabel(value?: string) {
  if (value === "CONTACT_US") return "Кнопка: Написать";
  if (value === "CALL_NOW") return "Кнопка: Позвонить";
  return "Кнопка: Подробнее";
}

function statusModeLabel(value: "PAUSED" | "ACTIVE") {
  return value === "ACTIVE" ? "Реклама сразу активна" : "Создать выключенной";
}

function uploadStatusLabel(status: UploadStatus) {
  const labels: Record<UploadStatus, string> = {
    idle: "",
    validating: "Проверяем файл",
    getting_signed_url: "Получаем signed upload URL",
    uploading_to_storage: "Загружаем в Supabase Storage",
    saving_metadata: "Сохраняем креатив",
    ready: "Креатив готов для Meta",
    failed: "Ошибка загрузки",
  };
  return labels[status];
}

function creativeReadyLabel(creative: CreativeAsset | null, uploadStatus: UploadStatus = "idle") {
  if (!creative) return "Сначала загрузите фото или видео";
  if (uploadStatus === "failed" || creative.status === "failed" || creative.status === "upload_failed") return "Загрузка не прошла";
  if (!creative.publicUrl) return "Файл загружается";
  if (creative.fileType === "video") return "Видео готово для подготовки в Meta";
  return "Креатив готов для Meta";
}

function creativeReadyTone(creative: CreativeAsset | null, uploadStatus: UploadStatus = "idle"): "green" | "amber" | "red" | "slate" {
  if (!creative) return "slate";
  if (uploadStatus === "failed" || creative.status === "failed" || creative.status === "upload_failed") return "red";
  return creative.publicUrl ? "green" : "amber";
}

function uploadLinkMissingMessage(storageHealth?: StorageHealth | null) {
  if (storageHealth?.publicUrlWorks) {
    return "Публичная ссылка пока не получена. Повторите загрузку или проверьте ошибку выше.";
  }
  return "Файл загружен, но публичная ссылка не получена. Проверьте Supabase Storage bucket ad-creatives.";
}

function realLaunchNeedsCreativeLink(creative: CreativeAsset | null, storageHealth?: StorageHealth | null) {
  if (!creative) return "Сначала загрузите креатив. Система сама подготовит ссылку для Meta.";
  if (!creative.publicUrl) return uploadLinkMissingMessage(storageHealth);
  return "";
}

function uploadResponseKeys(value: unknown) {
  const record = asRecord(value);
  const keys = new Set(Object.keys(record));
  for (const nestedKey of ["asset", "item", "signedUpload", "metadata"]) {
    const nested = asRecord(record[nestedKey]);
    for (const key of Object.keys(nested)) keys.add(`${nestedKey}.${key}`);
  }
  return Array.from(keys).sort();
}

function buildUploadDebug(value: unknown, asset: CreativeAsset, extra: Partial<UploadDebug> = {}): UploadDebug {
  return {
    uploadMode: extra.uploadMode,
    signedUpload: extra.signedUpload,
    assetId: asset.id,
    fileName: asset.fileName,
    fileType: asset.fileType,
    storagePath: asset.storagePath,
    storagePathExists: Boolean(asset.storagePath),
    publicUrlExists: Boolean(asset.publicUrl),
    publicUrlPreview: asset.publicUrl ? asset.publicUrl.slice(0, 60) : "",
    uploadStage: extra.uploadStage,
    lastError: extra.lastError,
    responseKeys: uploadResponseKeys(value),
  };
}

function formatBytes(value: number) {
  if (value > 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} МБ`;
  return `${Math.max(1, Math.round(value / 1024))} КБ`;
}

function inferCreativeFileType(file: File): CreativeAsset["fileType"] {
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  if (file.type.startsWith("video/") || ["mp4", "mov", "webm"].includes(extension)) return "video";
  return "image";
}

function localHistoryKey(workspaceId: string) {
  return `negis_ads_launch_history_${workspaceId}`;
}

async function safeJson<T>(response: { text: () => Promise<string> }): Promise<ApiResponse<T>> {
  const text = await response.text();
  if (!text.trim()) return { success: false, error: "Пустой ответ сервера", details: ["Сервер вернул пустой ответ."] };

  try {
    return JSON.parse(text) as ApiResponse<T>;
  } catch {
    return { success: false, error: "Некорректный JSON", details: [text.slice(0, 160)] };
  }
}

async function crmRequest<T>(path: string, init?: RequestInit): Promise<Extract<ApiResponse<T>, { success: true }>> {
  const response = await fetch(apiUrl(path), init);
  const body = await safeJson<T>(response);

  if (!response.ok || body.success === false) {
    const details = body.success === false ? body.details?.join(". ") : "";
    const hint = body.success === false ? body.hint || "" : "";
    const metaError = body.success === false ? asRecord(asRecord(body.data).metaError) : {};
    const metaDetails = [
      firstString(metaError.step) ? `Шаг Meta: ${firstString(metaError.step)}` : "",
      firstString(metaError.message),
      firstString(metaError.code) ? `code: ${firstString(metaError.code)}` : "",
      firstString(metaError.error_subcode) ? `subcode: ${firstString(metaError.error_subcode)}` : "",
      firstString(metaError.error_user_msg),
      metaError.blame_field_specs ? `blame_field_specs: ${JSON.stringify(metaError.blame_field_specs).slice(0, 180)}` : "",
      firstString(metaError.fbtrace_id) ? `fbtrace_id: ${firstString(metaError.fbtrace_id)}` : "",
    ].filter(Boolean);
    throw new Error([details || (body.success === false ? body.error : `HTTP ${response.status}`), ...metaDetails, hint].filter(Boolean).join(" "));
  }

  return body as Extract<ApiResponse<T>, { success: true }>;
}

function Field({
  label,
  value,
  onChange,
  textarea,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  textarea?: boolean;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label>
      <span style={labelStyle}>{label}</span>
      {textarea ? (
        <textarea
          style={{ ...inputStyle, minHeight: 104, resize: "vertical" }}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input style={inputStyle} type={type} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      )}
    </label>
  );
}

function StatusPill({ tone, children }: { tone: "green" | "amber" | "red" | "blue" | "slate"; children: ReactNode }) {
  const palette = {
    green: "border-emerald-200 bg-emerald-50 text-emerald-700",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    red: "border-red-200 bg-red-50 text-red-700",
    blue: "border-blue-200 bg-blue-50 text-blue-700",
    slate: "border-slate-200 bg-white/70 text-slate-700",
  };
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-black ${palette[tone]}`}>{children}</span>;
}

function FeatureBadge({ plan, feature }: { plan: NegisPlan; feature: Parameters<typeof getPlanFeature>[1] }) {
  const config = getPlanFeature(plan, feature);
  if (config.enabled && config.badge !== "Standard" && config.badge !== "Pro") return null;
  return <StatusPill tone={config.enabled ? "green" : "amber"}>{config.badge || planFeatureBadge(plan, feature)}</StatusPill>;
}

export default function AdsAutomation() {
  const [location, setLocation] = useLocation();
  const { user, userRole, clinicId } = useAuth();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const workspaceId = clinicId || readWorkspaceId();
  const [plan] = useState<NegisPlan>(() => normalizePlan(readStored("negis_plan", "demo")));
  const [currentStep, setCurrentStep] = useState(1);
  const [brief, setBrief] = useState<Brief>(() => readStored("negis_ads_automation_brief", defaultBrief));
  const [creative, setCreative] = useState<CreativeAsset | null>(null);
  const [aiPackage, setAiPackage] = useState<AiPackage | null>(null);
  const [compliance, setCompliance] = useState<ComplianceResult | null>(null);
  const [confirmations, setConfirmations] = useState<ConfirmationState>(confirmationDefaults);
  const [activeConfirmation, setActiveConfirmation] = useState("");
  const [statusMode, setStatusMode] = useState<"PAUSED" | "ACTIVE">("PAUSED");
  const [metaSummary, setMetaSummary] = useState<MetaSummary | null>(null);
  const [storageHealth, setStorageHealth] = useState<StorageHealth | null>(null);
  const [uploadDebug, setUploadDebug] = useState<UploadDebug | null>(null);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>("idle");
  const [uploadStage, setUploadStage] = useState("");
  const [lastUploadError, setLastUploadError] = useState("");
  const [liveLaunchEnabled, setLiveLaunchEnabled] = useState(() => readStored("negis_meta_live_launch_enabled", false));
  const [loading, setLoading] = useState<"health" | "storage" | "upload" | "ai" | "check" | "video" | "launch" | "history" | null>(null);
  const [notice, setNotice] = useState("");
  const [launchResult, setLaunchResult] = useState<LaunchResult | null>(null);
  const [historyItems, setHistoryItems] = useState<LaunchHistoryItem[]>([]);
  const isHistoryView = location === "/ads-automation/history";

  useEffect(() => {
    window.localStorage.setItem("negis_ads_automation_brief", JSON.stringify(brief));
  }, [brief]);

  useEffect(() => {
    void checkHealth();
  }, []);

  useEffect(() => {
    if (isHistoryView) void loadHistory();
  }, [isHistoryView]);

  const destination = destinationOptions.find((item) => item.value === brief.leadDestination) || destinationOptions[0];
  const destinationUrl = aiPackage?.destinationUrl || publicDestinationUrl(brief);
  const adsManagerUrl = useMemo(() => {
    const accountId = String(metaSummary?.adAccountId || "").replace(/^act_/, "");
    return accountId ? `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${accountId}` : "https://adsmanager.facebook.com/";
  }, [metaSummary]);

  const totalBudget = useMemo(() => {
    const daily = Number(brief.dailyBudget || 0);
    const days = Math.max(1, Number(brief.days || 1));
    return Math.round(daily * days);
  }, [brief.dailyBudget, brief.days]);

  const updateBrief = (key: keyof Brief, value: string) => setBrief((current) => ({ ...current, [key]: value }));
  const updateConfirmation = (key: keyof ConfirmationState, value: boolean) => {
    setConfirmations((current) => ({ ...current, [key]: value }));
  };

  function goToStep(step: number) {
    setCurrentStep(step);
    window.setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0);
  }

  async function checkHealth() {
    setLoading("health");
    try {
      const body = await crmRequest<{ meta?: MetaSummary }>("/api/crm/health");
      setMetaSummary(body.data.meta || null);
      setLiveLaunchEnabled(Boolean(readStored("negis_meta_live_launch_enabled", false)));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось проверить Meta env.");
    } finally {
      setLoading(null);
    }
  }

  async function checkStorage() {
    setLoading("storage");
    setNotice("");
    try {
      const body = await crmRequest<StorageHealth>("/api/crm/storage-health");
      setStorageHealth(body.data);
      if (body.data.exists && body.data.publicAccess) {
        setNotice("Storage проверен: bucket ad-creatives найден, public access включён.");
        toast.success("Storage готов");
      } else {
        const message = body.data.hint || "Bucket ad-creatives требует проверки администратора.";
        setNotice(message);
        toast.warning(message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось проверить Supabase Storage.";
      setNotice(message);
      toast.error(message);
    } finally {
      setLoading(null);
    }
  }

  function validateFile(file: File): string[] {
    const isVideo = file.type.startsWith("video/");
    const isImage = file.type.startsWith("image/");
    const extension = file.name.split(".").pop()?.toLowerCase() || "";
    const allowedImage = ["jpg", "jpeg", "png", "webp"].includes(extension);
    const allowedVideo = ["mp4", "mov", "webm"].includes(extension);
    const details: string[] = [];

    if (!isImage && !isVideo && !allowedImage && !allowedVideo) {
      details.push("Формат не поддерживается. Используйте JPG, PNG, WEBP, MP4, MOV или WEBM.");
    }
    if ((isImage || allowedImage) && file.size > 10 * 1024 * 1024) {
      details.push("Фото больше 10 MB. Сожмите изображение.");
    }
    if ((isVideo || allowedVideo) && file.size > 100 * 1024 * 1024) {
      details.push("Видео больше 100 MB. Загрузите файл меньшего размера.");
    }

    return details;
  }

  async function uploadCreative(file: File) {
    setUploadStatus("validating");
    setUploadStage(uploadStatusLabel("validating"));
    setLastUploadError("");
    setUploadDebug(null);
    const details = validateFile(file);
    if (details.length > 0) {
      const message = details.join(" ");
      setUploadStatus("failed");
      setUploadStage(uploadStatusLabel("failed"));
      setLastUploadError(message);
      setNotice(message);
      toast.error(details.join(" "));
      return;
    }

    setLoading("upload");
    setNotice("");
    const fileType = inferCreativeFileType(file);
    const previewUrl = URL.createObjectURL(file);
    let publicUrl = "";
    let storagePath = "";
    type UploadResponse = Partial<CreativeAsset> & { asset?: unknown; item?: unknown };
    let signedUpload: SignedUploadData | null = null;
    let lastError = "";

    try {
      if (!hasSupabaseFrontendEnv) {
        const missingEnvMessage = "Для загрузки креативов нужны VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY в Vercel.";
        if (file.size > VERCEL_FUNCTION_FILE_LIMIT_BYTES) {
          throw new Error(`${missingEnvMessage} Файл нельзя отправлять через Vercel. Используется прямая загрузка в Supabase Storage.`);
        }

        throw new Error(missingEnvMessage);
      }

      setUploadStatus("getting_signed_url");
      setUploadStage(uploadStatusLabel("getting_signed_url"));
      const signedBody = await crmRequest<SignedUploadData>("/api/crm/ad-creatives/signed-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          fileName: file.name,
          fileType,
          mimeType: file.type,
          fileSize: file.size,
        }),
      });
      signedUpload = signedBody.data;
      const storageBucket = firstString(signedUpload.bucket, signedUpload.storageBucket, "ad-creatives");
      storagePath = firstString(signedUpload.storagePath);
      publicUrl = firstString(signedUpload.publicUrl) || buildFrontendStoragePublicUrl(storagePath, storageBucket);
      const token = firstString(signedUpload.token);

      if (!storagePath || !token || !publicUrl) {
        throw new Error("Signed upload URL неполный: backend не вернул storagePath, token или publicUrl.");
      }

      setUploadStatus("uploading_to_storage");
      setUploadStage(uploadStatusLabel("uploading_to_storage"));
      const { error: uploadError } = await supabase.storage.from(storageBucket).uploadToSignedUrl(storagePath, token, file, {
        contentType: file.type || (fileType === "video" ? "video/mp4" : "image/jpeg"),
      });
      if (uploadError) {
        throw new Error(`Supabase Storage: ${uploadError.message}`);
      }

      if (!publicUrl) {
        throw new Error("Публичная ссылка не получена. Проверьте public access bucket ad-creatives.");
      }

      const fallback: CreativeAsset = {
        fileName: file.name,
        fileType,
        mimeType: file.type,
        fileSize: file.size,
        previewUrl,
        publicUrl,
        storagePath,
        storageBucket,
        status: "uploaded",
      };

      setUploadStatus("saving_metadata");
      setUploadStage(uploadStatusLabel("saving_metadata"));
      const body = await crmRequest<UploadResponse>("/api/crm/ad-creatives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          uploadedBy: user?.email || user?.user_metadata?.full_name || "Negis user",
          fileName: file.name,
          fileType,
          mimeType: file.type,
          fileSize: file.size,
          storageBucket,
          storagePath,
          publicUrl,
          status: "uploaded",
          metadata: {
            source: "ads-automation",
            uploadMode: "signed_url",
            signedUpload: true,
          },
        }),
      });

      const uploadedAsset = normalizeAsset(body.data.item || body.data.asset || body.data, fallback);
      setCreative(uploadedAsset);
      setUploadStatus("ready");
      setUploadStage(uploadStatusLabel("ready"));
      setUploadDebug(
        buildUploadDebug(
          { signedUpload, metadata: body.data },
          uploadedAsset,
          {
            uploadMode: "signed_url",
            signedUpload: true,
            uploadStage: uploadStatusLabel("ready"),
          },
        ),
      );
      goToStep(2);
      toast.success(fileType === "video" ? "Видео загружено" : "Фото загружено");
      setNotice(
        uploadedAsset.publicUrl
          ? uploadedAsset.fileType === "video"
            ? "Видео загружено. Публичная ссылка получена. Видео готово для подготовки в Meta."
            : "Фото загружено. Публичная ссылка получена. Креатив готов для Meta."
          : uploadLinkMissingMessage(storageHealth),
      );
    } catch (error) {
      lastError = error instanceof Error ? error.message : uploadLinkMissingMessage(storageHealth);
      const fallback: CreativeAsset = {
        fileName: file.name,
        fileType,
        mimeType: file.type,
        fileSize: file.size,
        previewUrl,
        publicUrl,
        storagePath,
        storageBucket: firstString(signedUpload?.bucket, signedUpload?.storageBucket, "ad-creatives"),
        status: "failed",
      };
      setUploadStatus("failed");
      setUploadStage(uploadStatusLabel("failed"));
      setLastUploadError(lastError);
      setCreative(fallback);
      setUploadDebug({
        assetId: fallback.id,
        fileName: fallback.fileName,
        fileType: fallback.fileType,
        uploadMode: "signed_url",
        signedUpload: Boolean(signedUpload?.token),
        storagePath: fallback.storagePath,
        storagePathExists: Boolean(fallback.storagePath),
        publicUrlExists: Boolean(fallback.publicUrl),
        publicUrlPreview: fallback.publicUrl ? fallback.publicUrl.slice(0, 60) : "",
        uploadStage: uploadStatusLabel("failed"),
        lastError,
        responseKeys: signedUpload ? uploadResponseKeys({ signedUpload }) : ["error"],
      });
      setNotice(fallback.publicUrl ? "Креатив загружен в Storage, но metadata не сохранились." : lastError);
    } finally {
      setLoading(null);
    }
  }

  function removeCreative() {
    if (creative?.previewUrl.startsWith("blob:")) URL.revokeObjectURL(creative.previewUrl);
    setCreative(null);
    setAiPackage(null);
    setCompliance(null);
    setLaunchResult(null);
    setUploadDebug(null);
    setUploadStage("");
    setUploadStatus("idle");
    setLastUploadError("");
  }

  async function fillWithAi() {
    setLoading("ai");
    setNotice("");
    try {
      const body = await crmRequest<AiPackage>("/api/crm/ads-ai-fill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          creativeType: creative?.fileType || "image",
          creativeUrl: creative?.publicUrl || "",
          service: brief.service,
          city: brief.city,
          leadDestination: brief.leadDestination,
          destinationValue: brief.destinationValue,
          dailyBudget: Number(brief.dailyBudget),
          startDate: brief.startDate,
          endDate: brief.endDate,
          offer: brief.offer,
          knownAudience: brief.knownAudience,
          restrictions: brief.restrictions,
        }),
      });
      setAiPackage(body.data);
      setCompliance(null);
      goToStep(4);
      toast.success(body.data.generatedBy === "openai" ? "ИИ заполнил рекламу" : "Demo-пакет готов");
      if (body.warning) setNotice(body.warning);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось подготовить рекламу.";
      setNotice(message);
      toast.error(message);
    } finally {
      setLoading(null);
    }
  }

  function buildLaunchPayload(dryRun: boolean, forcedStatusMode = statusMode) {
    const text = compliance?.safeText && compliance.status !== "safe" ? compliance.safeText : aiPackage?.primaryText;
    const publicCreativeUrl = creative?.publicUrl || "";
    const dryRunPreviewUrl = dryRun ? creative?.previewUrl || "" : "";
    const creativeUrl = publicCreativeUrl || dryRunPreviewUrl;
    return {
      workspaceId,
      launchedBy: user?.user_metadata?.full_name || user?.email || "Negis user",
      launchedByRole: userRole || "owner",
      sourceModule: "ads-automation",
      sourceId: creative?.id || "",
      service: brief.service,
      city: brief.city,
      offer: brief.offer,
      campaignName: aiPackage?.campaignName || `${brief.service} - ${brief.city}`,
      objective: aiPackage?.objective || "OUTCOME_LEADS",
      statusMode: forcedStatusMode,
      dailyBudget: Number(brief.dailyBudget),
      totalBudget,
      currency: "USD",
      targetAudience: aiPackage?.audience || brief.knownAudience,
      primaryText: text || "",
      headline: aiPackage?.headline || `${brief.service} в ${brief.city}`,
      description: aiPackage?.description || brief.offer,
      cta: aiPackage?.cta || "LEARN_MORE",
      landingUrl: destinationUrl,
      imageUrl: creative?.fileType === "image" ? creativeUrl : "",
      creativeType: creative?.fileType || "image",
      creativeUrl,
      videoUrl: creative?.fileType === "video" ? creativeUrl : "",
      videoId: creative?.metaVideoId || "",
      startDate: brief.startDate,
      endDate: brief.endDate,
      complianceConfirmed: true,
      manualApprovalConfirmed: confirmations.manualApproval,
      budgetOverrideConfirmed: true,
      liveLaunchEnabled,
      activeConfirmation: activeConfirmation.trim(),
      dryRun,
    };
  }

  async function runComplianceCheck(stayOnLaunchStep = false) {
    if (!aiPackage) {
      toast.error("Сначала нажмите «ИИ заполнить рекламу»");
      return;
    }
    setLoading("check");
    setNotice("");
    try {
      const body = await crmRequest<LaunchResult>("/api/crm/meta-launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...buildLaunchPayload(true, "PAUSED"),
          manualApprovalConfirmed: true,
          complianceConfirmed: true,
        }),
      });
      setCompliance(body.data.compliance || null);
      setLaunchResult({ ...body.data, warning: body.warning || body.data.warning });
      goToStep(stayOnLaunchStep ? 6 : 5);
      toast.success(stayOnLaunchStep ? "Проверка прошла без запуска" : "Проверка безопасности готова");
      setNotice(body.warning || (stayOnLaunchStep ? "Проверка прошла без запуска. Кампания в Meta не создавалась." : ""));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Проверка не прошла.";
      setNotice(message);
      toast.error(message);
    } finally {
      setLoading(null);
    }
  }

  function prelaunchErrors(nextStatusMode: "PAUSED" | "ACTIVE"): string[] {
    const errors: string[] = [];
    const dailyBudget = Number(brief.dailyBudget);
    const start = new Date(brief.startDate);
    const end = brief.endDate ? new Date(brief.endDate) : null;

    if (!creative) errors.push("Добавьте фото или видео.");
    if (!aiPackage) errors.push("Нажмите «ИИ заполнить рекламу».");
    if (!destinationUrl) errors.push("Укажите, куда должны приходить заявки.");
    if (brief.leadDestination === "lead_form" && !brief.destinationValue.trim()) errors.push("Для Meta Lead Form нужен form_id. Пока этот режим только для черновика.");
    if (!dailyBudget || dailyBudget <= 0) errors.push("Укажите дневной бюджет больше 0.");
    if (Number.isNaN(start.getTime())) errors.push("Укажите корректную дату начала.");
    if (end && end <= start) errors.push("Дата окончания должна быть позже даты начала.");
    if (compliance?.status === "blocked") errors.push("Проверка безопасности заблокировала текст. Примите безопасную версию.");
    if (!confirmations.textChecked) errors.push("Подтвердите, что текст проверен.");
    if (!confirmations.budgetChecked) errors.push("Подтвердите бюджет.");
    if (!confirmations.leadDestinationChecked) errors.push("Подтвердите адрес заявок.");
    if (!confirmations.clinicAuthority) errors.push("Подтвердите право запускать рекламу клиники.");
    if (!confirmations.manualApproval) errors.push("Подтвердите ручное согласование.");
    if (!confirmations.spendUnderstood) errors.push("Подтвердите понимание расходов.");
    if (!metaSummary?.configured) errors.push("Meta env не настроены или не подтверждены.");
    if (creative && !creative.publicUrl) errors.push(uploadLinkMissingMessage(storageHealth));
    if (creative?.fileType === "video" && !creative.metaVideoId && !creative.publicUrl) {
      errors.push("Видео загружено в Negis, но ссылка для Meta ещё не готова. Проверьте Storage или повторите загрузку.");
    }
    if (nextStatusMode === "ACTIVE") {
      if (!liveLaunchEnabled) errors.push("ACTIVE запуск выключен в Admin Center.");
      if (!["owner", "admin", "manager"].includes(userRole || "")) errors.push("ACTIVE запуск доступен только owner/admin/manager.");
      if (activeConfirmation.trim().toUpperCase() !== "ЗАПУСТИТЬ") errors.push("Для ACTIVE введите ЗАПУСТИТЬ.");
    }
    return errors;
  }

  async function ensureVideoReady(): Promise<string> {
    if (!creative || creative.fileType !== "video") return "";
    if (creative.metaVideoId) return creative.metaVideoId;
    if (!creative.publicUrl) throw new Error(uploadLinkMissingMessage(storageHealth));

    setLoading("video");
    try {
      const body = await crmRequest<{ metaVideoId?: string }>("/api/crm/ad-creative-meta-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          assetId: creative.id,
          fileName: creative.fileName,
          fileType: creative.fileType,
          mimeType: creative.mimeType,
          publicUrl: creative.publicUrl,
        }),
      });
      const metaVideoId = body.data.metaVideoId || "";
      if (!metaVideoId) throw new Error("Meta не вернула video_id.");
      setCreative((current) => (current ? { ...current, metaVideoId, status: "meta_uploaded" } : current));
      return metaVideoId;
    } finally {
      setLoading(null);
    }
  }

  function saveLocalLaunch(result: LaunchResult, nextStatusMode: "PAUSED" | "ACTIVE") {
    const key = localHistoryKey(workspaceId);
    const current = readStored<LaunchHistoryItem[]>(key, []);
    const item: LaunchHistoryItem = {
      id: result.launchId || `local-${Date.now()}`,
      campaignName: aiPackage?.campaignName,
      status: nextStatusMode === "ACTIVE" ? "active" : "paused",
      metaCampaignId: result.metaCampaignId,
      metaStatus: result.metaStatus || nextStatusMode,
      budgetDailyMinor: Math.round(Number(brief.dailyBudget || 0) * 100),
      currency: "USD",
      launchedBy: user?.email || "Negis user",
      createdAt: new Date().toISOString(),
      payload: {
        creativeType: creative?.fileType,
        fileName: creative?.fileName,
        city: brief.city,
        leadDestination: brief.leadDestination,
      },
    };
    window.localStorage.setItem(key, JSON.stringify([item, ...current].slice(0, 30)));
  }

  async function launch(nextStatusMode: "PAUSED" | "ACTIVE") {
    const errors = prelaunchErrors(nextStatusMode);
    if (errors.length > 0) {
      setNotice(errors.join(" "));
      toast.error("Проверьте условия запуска");
      return;
    }

    setLoading("launch");
    setNotice("");
    try {
      let metaVideoId = creative?.metaVideoId || "";
      if (creative?.fileType === "video") {
        metaVideoId = await ensureVideoReady();
      }

      const body = await crmRequest<LaunchResult>("/api/crm/meta-launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...buildLaunchPayload(false, nextStatusMode),
          videoId: metaVideoId,
        }),
      });
      if (body.data.dryRun) {
        throw new Error("Meta вернула режим проверки для реального запуска. Кампания не создана.");
      }
      setLaunchResult({ ...body.data, warning: body.warning || body.data.warning });
      setCompliance(body.data.compliance || compliance);
      saveLocalLaunch(body.data, nextStatusMode);
      goToStep(6);
      toast.success(nextStatusMode === "ACTIVE" ? "Реклама запущена" : "Кампания создана выключенной");
      if (body.warning) setNotice(body.warning);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось создать рекламу в Meta.";
      setNotice(message);
      toast.error(message);
    } finally {
      setLoading(null);
    }
  }

  async function loadHistory() {
    setLoading("history");
    try {
      const body = await crmRequest<{ launches?: LaunchHistoryItem[]; items?: LaunchHistoryItem[] }>(`/api/crm/meta-launches?workspaceId=${encodeURIComponent(workspaceId)}`);
      const remote = body.data.launches || body.data.items || [];
      const local = readStored<LaunchHistoryItem[]>(localHistoryKey(workspaceId), []);
      setHistoryItems([...local, ...remote].slice(0, 40));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "История запусков пока недоступна.");
    } finally {
      setLoading(null);
    }
  }

  function renderCreativeStep() {
    const videoFeature = getPlanFeature(plan, "video_ads_launch");
    const uploadProblem =
      creative && !creative.publicUrl
        ? uploadStatus === "failed"
          ? lastUploadError || "Загрузка не прошла. Попробуйте другой файл."
          : uploadLinkMissingMessage(storageHealth)
        : "";
    const creativeCanContinue = Boolean(creative?.publicUrl) && uploadStatus !== "failed";

    return (
      <section className="neu-card p-5 sm:p-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-[#0D9488]">Шаг 1</p>
            <h2 className="mt-1 text-2xl font-black text-[#0F172A]">Креатив</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#64748B]">
              Загрузите фото или видео. Система сама подготовит ссылку для Meta, без ручного ввода URL.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <FeatureBadge plan={plan} feature="video_ads_launch" />
            {!videoFeature.enabled ? <span className="text-xs font-bold text-[#64748B]">Видео не блокируем, но помечаем как Standard+</span> : null}
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void uploadCreative(file);
            event.currentTarget.value = "";
          }}
        />

        {!creative ? (
          <>
            <button
              type="button"
              className="mt-6 flex min-h-[220px] w-full flex-col items-center justify-center gap-4 rounded-[26px] border-2 border-dashed border-[#BFD2DF] bg-white/50 p-6 text-center transition hover:border-[#0D9488] hover:bg-white/70"
              disabled={loading === "upload"}
              onClick={() => fileInputRef.current?.click()}
            >
              {loading === "upload" ? <Loader2 className="animate-spin text-[#0D9488]" size={34} /> : <UploadCloud className="text-[#0D9488]" size={38} />}
              <div>
                <p className="text-base font-black text-[#0F172A]">Загрузить фото или видео</p>
                <p className="mt-1 text-sm text-[#64748B]">JPG, PNG, WEBP до 10 МБ · MP4, MOV, WEBM до 100 МБ</p>
                {uploadStage ? <p className="mt-2 text-sm font-black text-[#0D9488]">{uploadStage}</p> : null}
              </div>
            </button>
            <div className="mt-5 flex flex-col gap-2 sm:items-end">
              <button type="button" className="neu-btn-primary justify-center opacity-60" disabled>
                Дальше к параметрам
              </button>
              <p className="text-sm font-bold text-[#64748B]">Сначала загрузите фото или видео</p>
            </div>
          </>
        ) : (
          <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="overflow-hidden rounded-[24px] border border-white/70 bg-black/5">
              {creative.fileType === "video" ? (
                <video className="h-full max-h-[460px] w-full bg-black object-contain" controls src={creative.previewUrl} />
              ) : (
                <img className="max-h-[460px] w-full object-contain" src={creative.previewUrl} alt="Креатив рекламы" />
              )}
            </div>
            <div className="space-y-3">
              <div className="rounded-2xl border border-[#D8E4EC] bg-white/65 p-4">
                <div className="flex items-center gap-2">
                  {creative.fileType === "video" ? <Video size={18} className="text-[#0D9488]" /> : <FileImage size={18} className="text-[#0D9488]" />}
                  <p className="min-w-0 truncate text-sm font-black text-[#0F172A]">{creative.fileName}</p>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <StatusPill tone={uploadStatus === "failed" ? "red" : creative.publicUrl ? "green" : "amber"}>
                    {uploadStatus === "failed" ? "Загрузка не прошла" : creative.fileType === "video" ? "Видео загружено" : "Фото загружено"}
                  </StatusPill>
                  <StatusPill tone={creative.publicUrl ? "green" : uploadStatus === "failed" ? "red" : "amber"}>
                    {creative.publicUrl ? "Публичная ссылка получена" : uploadStatus === "failed" ? "Публичная ссылка не получена" : "Публичная ссылка готовится"}
                  </StatusPill>
                  <StatusPill tone={creativeReadyTone(creative, uploadStatus)}>{creativeReadyLabel(creative, uploadStatus)}</StatusPill>
                  <StatusPill tone={creative.fileType === "video" && creative.metaVideoId ? "green" : "slate"}>
                    {creative.fileType === "video" ? creative.metaVideoId ? "Meta video_id готов" : "Meta video_id нужен перед запуском" : "Фото"}
                  </StatusPill>
                </div>
                <p className="mt-3 text-sm text-[#64748B]">{formatBytes(creative.fileSize)} · {creative.mimeType || "тип не определён"}</p>
                {uploadStage ? (
                  <div className="mt-3 rounded-2xl border border-teal-200 bg-teal-50 p-3 text-sm font-black text-teal-800">
                    {uploadStage}
                  </div>
                ) : null}
                {!creative.publicUrl ? (
                  <div className={`mt-3 rounded-2xl border p-3 ${uploadStatus === "failed" ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"}`}>
                    <p className={`text-sm font-semibold ${uploadStatus === "failed" ? "text-red-900" : "text-amber-900"}`}>{uploadProblem}</p>
                    {storageHealth?.hint ? <p className="mt-1 text-xs font-bold text-amber-800">{storageHealth.hint}</p> : null}
                    <button type="button" className="neu-btn mt-3 justify-center" disabled={loading === "storage"} onClick={checkStorage}>
                      {loading === "storage" ? <Loader2 className="animate-spin" size={16} /> : <ShieldCheck size={16} />}
                      Проверить Storage
                    </button>
                  </div>
                ) : null}
                {uploadDebug ? (
                  <details className="mt-3 rounded-2xl border border-blue-200 bg-blue-50 p-3">
                    <summary className="cursor-pointer text-xs font-black uppercase tracking-[0.1em] text-blue-700">Техническая информация</summary>
                    <div className="mt-2 grid gap-1 break-words text-xs font-semibold text-blue-900">
                      <p>fileName: {uploadDebug.fileName || "-"}</p>
                      <p>fileType: {uploadDebug.fileType || "-"}</p>
                      <p>assetId: {uploadDebug.assetId || "-"}</p>
                      <p>uploadMode: {uploadDebug.uploadMode || "-"}</p>
                      <p>signedUpload: {uploadDebug.signedUpload ? "yes" : "no"}</p>
                      <p>storagePath: {uploadDebug.storagePathExists ? "yes" : "no"}</p>
                      <p>storagePathValue: {uploadDebug.storagePath || "-"}</p>
                      <p>publicUrl: {uploadDebug.publicUrlExists ? "yes" : "no"}</p>
                      <p>publicUrlPreview: {uploadDebug.publicUrlPreview || "-"}</p>
                      <p>uploadStage: {uploadDebug.uploadStage || "-"}</p>
                      <p>lastError: {uploadDebug.lastError || "-"}</p>
                      <p>upload response keys: {uploadDebug.responseKeys.length ? uploadDebug.responseKeys.join(", ") : "-"}</p>
                    </div>
                  </details>
                ) : null}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" className="neu-btn justify-center" onClick={() => fileInputRef.current?.click()}>
                  <RefreshCw size={16} />
                  Заменить
                </button>
                <button type="button" className="neu-btn justify-center text-red-600" onClick={removeCreative}>
                  <Trash2 size={16} />
                  Удалить
                </button>
              </div>
              <button type="button" className="neu-btn-primary w-full justify-center" disabled={!creativeCanContinue} onClick={() => goToStep(2)}>
                Дальше к параметрам
              </button>
              {!creative.publicUrl ? (
                <p className={`text-sm font-bold ${uploadStatus === "failed" ? "text-red-700" : "text-amber-700"}`}>{uploadProblem}</p>
              ) : null}
            </div>
          </div>
        )}
      </section>
    );
  }

  function renderBriefStep() {
    return (
      <section className="neu-card p-5 sm:p-6">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-[#0D9488]">Шаг 2</p>
        <h2 className="mt-1 text-2xl font-black text-[#0F172A]">Важные параметры</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#64748B]">
          Только то, что сотрудник реально знает перед запуском.
        </p>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <Field label="Услуга" value={brief.service} onChange={(value) => updateBrief("service", value)} />
          <Field label="Город" value={brief.city} onChange={(value) => updateBrief("city", value)} />
          <label>
            <span style={labelStyle}>Куда вести заявки</span>
            <select
              style={inputStyle}
              value={brief.leadDestination}
              onChange={(event) => updateBrief("leadDestination", event.target.value as LeadDestination)}
            >
              {destinationOptions.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </label>
          <Field label="Адрес заявок" value={brief.destinationValue} placeholder={destination.placeholder} onChange={(value) => updateBrief("destinationValue", value)} />
          <Field label="Дневной бюджет, USD" type="number" value={brief.dailyBudget} onChange={(value) => updateBrief("dailyBudget", value)} />
          <Field label="Дней рекламы" type="number" value={brief.days} onChange={(value) => updateBrief("days", value)} />
          <Field label="Дата начала" type="date" value={brief.startDate} onChange={(value) => updateBrief("startDate", value)} />
          <Field label="Дата окончания" type="date" value={brief.endDate} onChange={(value) => updateBrief("endDate", value)} />
          <div className="md:col-span-2">
            <Field label="Короткий оффер" value={brief.offer} onChange={(value) => updateBrief("offer", value)} />
          </div>
          <div className="md:col-span-2">
            <Field label="Кого примерно ищем" value={brief.knownAudience} textarea onChange={(value) => updateBrief("knownAudience", value)} />
          </div>
          <div className="md:col-span-2">
            <Field label="Ограничения" value={brief.restrictions} textarea onChange={(value) => updateBrief("restrictions", value)} />
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-between">
          <button type="button" className="neu-btn justify-center" onClick={() => goToStep(1)}>Назад</button>
          <button type="button" className="neu-btn-primary justify-center" onClick={() => goToStep(3)}>ИИ заполнить рекламу</button>
        </div>
      </section>
    );
  }

  function renderAiStep() {
    const analysisFeature = getPlanFeature(plan, "ai_creative_analysis");
    return (
      <section className="neu-card p-5 sm:p-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-[#0D9488]">Шаг 3</p>
            <h2 className="mt-1 text-2xl font-black text-[#0F172A]">ИИ заполнит рекламу</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#64748B]">
              ИИ подготовит структуру Meta, текст, аудиторию, бюджетный план и отчёт для сотрудника.
            </p>
          </div>
          <FeatureBadge plan={plan} feature="ai_creative_analysis" />
        </div>

        {!analysisFeature.enabled ? (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
            Расширенный анализ отмечен как Standard+. В MVP owner может продолжить в demo-режиме.
          </div>
        ) : null}

        <button type="button" className="neu-btn-primary mt-6 w-full justify-center sm:w-auto" disabled={loading === "ai"} onClick={fillWithAi}>
          {loading === "ai" ? <Loader2 className="animate-spin" size={16} /> : <Wand2 size={16} />}
          ИИ заполнить рекламу
        </button>

        {aiPackage ? (
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            {[
              ["Кампания", aiPackage.campaignName],
              ["Цель", aiPackage.objectiveLabel || "Цель: заявки"],
              ["Основной текст", aiPackage.primaryText],
              ["Заголовок", aiPackage.headline],
              ["Описание", aiPackage.description],
              ["Кнопка", aiPackage.ctaLabel || ctaLabel(aiPackage.cta)],
              ["Кому показывать", aiPackage.audience],
              ["Куда идут заявки", aiPackage.destinationUrl || destinationUrl],
            ].map(([label, value]) => (
              <div key={label} className="rounded-2xl border border-[#D8E4EC] bg-white/65 p-4">
                <p className="text-xs font-black uppercase tracking-[0.1em] text-[#64748B]">{label}</p>
                <p className="mt-2 text-sm font-semibold leading-relaxed text-[#0F172A]">{value || "-"}</p>
              </div>
            ))}
          </div>
        ) : null}

        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-between">
          <button type="button" className="neu-btn justify-center" onClick={() => goToStep(2)}>Назад</button>
          <button type="button" className="neu-btn-primary justify-center" disabled={!aiPackage} onClick={() => goToStep(4)}>Перейти к проверке</button>
        </div>
      </section>
    );
  }

  function renderComplianceStep() {
    const tone = compliance?.status === "blocked" ? "red" : compliance?.status === "needs_review" ? "amber" : compliance?.status === "safe" ? "green" : "slate";
    return (
      <section className="neu-card p-5 sm:p-6">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-[#0D9488]">Шаг 4</p>
        <h2 className="mt-1 text-2xl font-black text-[#0F172A]">Проверка безопасности</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#64748B]">
          Проверяем медицинские формулировки и готовим безопасную версию перед запуском.
        </p>

        <button type="button" className="neu-btn-primary mt-6 justify-center" disabled={loading === "check"} onClick={() => void runComplianceCheck()}>
          {loading === "check" ? <Loader2 className="animate-spin" size={16} /> : <ShieldCheck size={16} />}
          Проверить безопасность
        </button>

        {compliance ? (
          <div className="mt-6 space-y-4">
            <StatusPill tone={tone}>{compliance.status === "safe" ? "Безопасно" : compliance.status === "needs_review" ? "Нужна проверка" : "Заблокировано"}</StatusPill>
            {compliance.issues?.length ? (
              <div className="grid gap-2">
                {compliance.issues.map((issue) => (
                  <div key={issue.code || issue.message} className="rounded-2xl border border-[#D8E4EC] bg-white/65 p-4 text-sm font-semibold text-[#334155]">
                    {issue.message || issue.code}
                  </div>
                ))}
              </div>
            ) : null}
            {compliance.safeText ? (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                <p className="text-xs font-black uppercase tracking-[0.1em] text-emerald-700">Безопасная версия</p>
                <p className="mt-2 text-sm font-semibold leading-relaxed text-emerald-900">{compliance.safeText}</p>
                <button
                  type="button"
                  className="neu-btn mt-3 justify-center"
                  onClick={() => {
                    setAiPackage((current) => current ? { ...current, primaryText: compliance.safeText } : current);
                    setCompliance((current) => current ? { ...current, status: "safe" } : current);
                  }}
                >
                  Принять безопасную версию
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-between">
          <button type="button" className="neu-btn justify-center" onClick={() => goToStep(3)}>Назад</button>
          <button type="button" className="neu-btn-primary justify-center" disabled={!compliance} onClick={() => goToStep(5)}>
            Сформировать финальный отчёт
          </button>
        </div>
      </section>
    );
  }

  function renderReportStep() {
    const report = aiPackage?.humanReport || {};
    const metaPayload = asRecord(launchResult?.metaPayload);
    const campaignPayload = asRecord(metaPayload.campaign);
    const adSetPayload = asRecord(metaPayload.adSet);
    const creativePayload = asRecord(metaPayload.creative);
    const campaignHasDailyBudget = Object.prototype.hasOwnProperty.call(campaignPayload, "daily_budget");
    const campaignBudgetSharing = Object.prototype.hasOwnProperty.call(campaignPayload, "is_adset_budget_sharing_enabled")
      ? String(campaignPayload.is_adset_budget_sharing_enabled)
      : "false";
    const adSetDailyBudget = adSetPayload.daily_budget ? String(adSetPayload.daily_budget) : String(Math.round(Number(brief.dailyBudget || 0) * 100));
    const adSetCampaignId = typeof adSetPayload.campaign_id === "string" ? adSetPayload.campaign_id : "META_CAMPAIGN_ID";
    const adSetBillingEvent = typeof adSetPayload.billing_event === "string" ? adSetPayload.billing_event : "IMPRESSIONS";
    const adSetOptimizationGoal = typeof adSetPayload.optimization_goal === "string" ? adSetPayload.optimization_goal : "LINK_CLICKS";
    const adSetBidStrategy = typeof adSetPayload.bid_strategy === "string" ? adSetPayload.bid_strategy : "LOWEST_COST_WITHOUT_CAP";
    const adSetTargeting = asRecord(adSetPayload.targeting);
    const targetingAutomation = asRecord(adSetTargeting.targeting_automation);
    const advantageAudience = Object.prototype.hasOwnProperty.call(targetingAutomation, "advantage_audience")
      ? String(targetingAutomation.advantage_audience)
      : "0";
    const creativeUsesInstagramActor = Object.prototype.hasOwnProperty.call(creativePayload, "usesInstagramActor")
      ? String(creativePayload.usesInstagramActor)
      : String(Boolean(metaSummary?.instagramActorId));
    const creativeInstagramActorFallback = Object.prototype.hasOwnProperty.call(creativePayload, "instagramActorFallback")
      ? String(creativePayload.instagramActorFallback)
      : "false";

    return (
      <section className="neu-card p-5 sm:p-6">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-[#0D9488]">Шаг 5</p>
        <h2 className="mt-1 text-2xl font-black text-[#0F172A]">Финальный отчёт перед запуском</h2>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          {[
            ["Что запускаем", report.whatWillRun || `${creative?.fileType === "video" ? "Видео" : "Фото"} + объявление`],
            ["Кому показываем", aiPackage?.audience || brief.knownAudience],
            ["Город", brief.city],
            ["Бюджет", `${brief.dailyBudget} USD/день · примерно ${totalBudget} USD всего`],
            ["Куда идут заявки", report.whereLeadsGo || destinationUrl],
            ["Текст для клиента", aiPackage?.primaryText],
          ].map(([label, value]) => (
            <div key={label} className="rounded-2xl border border-[#D8E4EC] bg-white/65 p-4">
              <p className="text-xs font-black uppercase tracking-[0.1em] text-[#64748B]">{label}</p>
              <p className="mt-2 text-sm font-semibold leading-relaxed text-[#0F172A]">{value || "-"}</p>
            </div>
          ))}
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-xs font-black uppercase tracking-[0.1em] text-amber-800">Риски</p>
            <ul className="mt-3 space-y-2 text-sm font-semibold text-amber-900">
              {(report.risks || ["Проверить текст, бюджет и адрес заявок перед ACTIVE запуском."]).map((item) => <li key={item}>• {item}</li>)}
            </ul>
          </div>
          <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4">
            <p className="text-xs font-black uppercase tracking-[0.1em] text-blue-800">Что будет создано в Meta</p>
            <ul className="mt-3 space-y-2 text-sm font-semibold text-blue-900">
              <li>• Кампания: {aiPackage?.campaignName || "-"}</li>
              <li>• Группа объявлений: город {brief.city}, бюджет {brief.dailyBudget} USD/день</li>
              <li>• Креатив: {creative?.fileType === "video" ? "видео" : "фото"}</li>
              <li>• Объявление: {aiPackage?.headline || "-"}</li>
            </ul>
          </div>
        </div>

        <details className="mt-5 rounded-2xl border border-[#D8E4EC] bg-white/65 p-4">
          <summary className="cursor-pointer text-sm font-black text-[#0F172A]">Подробности Meta payload</summary>
          <div className="mt-4 grid gap-3 text-sm">
            <p><b>Ad account:</b> {metaSummary?.adAccountId || "env/backend"}</p>
            <p><b>Page:</b> {metaSummary?.pageId || "env/backend"}</p>
            <p><b>Instagram actor:</b> {metaSummary?.instagramActorId || "env/backend"}</p>
            <p><b>Objective:</b> {aiPackage?.objective || "OUTCOME_LEADS"}</p>
            <p><b>CTA:</b> {aiPackage?.cta || "LEARN_MORE"}</p>
            <p><b>Status:</b> {statusMode}</p>
            <p><b>campaign.is_adset_budget_sharing_enabled:</b> {campaignBudgetSharing}</p>
            <p><b>campaign.daily_budget:</b> {campaignHasDailyBudget ? String(campaignPayload.daily_budget) : "absent"}</p>
            <p><b>adset.daily_budget:</b> "{adSetDailyBudget}"</p>
            <p><b>adset.campaign_id:</b> {adSetCampaignId}</p>
            <p><b>adset.billing_event:</b> {adSetBillingEvent}</p>
            <p><b>adset.optimization_goal:</b> {adSetOptimizationGoal}</p>
            <p><b>adset.bid_strategy:</b> {adSetBidStrategy}</p>
            <p><b>adset.targeting.targeting_automation.advantage_audience:</b> {advantageAudience}</p>
            <p><b>creative.usesInstagramActor:</b> {creativeUsesInstagramActor}</p>
            <p><b>creative.instagramActorFallback:</b> {creativeInstagramActorFallback}</p>
          </div>
        </details>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-between">
          <button type="button" className="neu-btn justify-center" onClick={() => goToStep(4)}>Назад к проверке</button>
          <button type="button" className="neu-btn-primary justify-center" onClick={() => goToStep(6)}>
            Перейти к подтверждению запуска
          </button>
        </div>
      </section>
    );
  }

  function renderLaunchStep() {
    const errors = prelaunchErrors(statusMode);
    const realLaunchBlockedByCreative = realLaunchNeedsCreativeLink(creative, storageHealth);
    const realLaunchBusy = loading === "launch" || loading === "video";
    const realLaunchDisabled = realLaunchBusy || Boolean(realLaunchBlockedByCreative);
    const launchResultTitle = launchResult?.dryRun
      ? "Проверка прошла без запуска"
      : launchResult?.metaStatus === "ACTIVE" || launchResult?.status === "active"
        ? "Реклама создана и запущена в Meta"
        : "Реклама создана в Meta выключенной";
    return (
      <section className="neu-card p-5 sm:p-6">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-[#0D9488]">Шаг 6</p>
        <h2 className="mt-1 text-2xl font-black text-[#0F172A]">Подтверждение запуска</h2>
        <div className="mt-4 flex flex-wrap gap-2">
          <StatusPill tone={metaSummary?.configured ? "green" : "amber"}>{metaSummary?.configured ? "Meta env настроены" : "Meta env не подтверждены"}</StatusPill>
          <StatusPill tone={liveLaunchEnabled ? "green" : "slate"}>{liveLaunchEnabled ? "ACTIVE разрешён в Admin" : "ACTIVE выключен в Admin"}</StatusPill>
          <StatusPill tone={creative?.fileType === "video" ? "blue" : "slate"}>{creative?.fileType === "video" ? "Видео" : "Фото"}</StatusPill>
        </div>

        <div className="mt-6 grid gap-3">
          {[
            ["textChecked", "Текст объявления проверен"],
            ["budgetChecked", "Бюджет проверен"],
            ["leadDestinationChecked", "Адрес заявок проверен"],
            ["clinicAuthority", "Есть право запускать рекламу от имени клиники"],
            ["manualApproval", "Реклама согласована вручную"],
            ["spendUnderstood", "Понятно, что реклама может тратить деньги"],
          ].map(([key, label]) => (
            <label key={key} className="flex items-center gap-3 rounded-2xl border border-[#D8E4EC] bg-white/65 px-4 py-3 text-sm font-bold text-[#334155]">
              <input
                type="checkbox"
                checked={Boolean(confirmations[key as keyof ConfirmationState])}
                onChange={(event) => updateConfirmation(key as keyof ConfirmationState, event.target.checked)}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <label>
            <span style={labelStyle}>Режим запуска</span>
            <select style={inputStyle} value={statusMode} onChange={(event) => setStatusMode(event.target.value as "PAUSED" | "ACTIVE")}>
              <option value="PAUSED">Создать в Meta выключенным</option>
              <option value="ACTIVE">Запустить рекламу сразу</option>
            </select>
            <p className="mt-2 text-xs font-bold text-[#64748B]">{statusModeLabel(statusMode)}</p>
          </label>
          <Field label="Для ACTIVE введите ЗАПУСТИТЬ" value={activeConfirmation} onChange={setActiveConfirmation} />
        </div>

        {errors.length ? (
          <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-900">
            {errors.join(" ")}
          </div>
        ) : null}

        {realLaunchBlockedByCreative ? (
          <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-900">{realLaunchBlockedByCreative}</p>
            <button type="button" className="neu-btn mt-3 justify-center" disabled={loading === "storage"} onClick={checkStorage}>
              {loading === "storage" ? <Loader2 className="animate-spin" size={16} /> : <ShieldCheck size={16} />}
              Проверить Storage
            </button>
          </div>
        ) : null}

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <button type="button" className="neu-btn justify-center" onClick={() => goToStep(5)}>
            Назад к отчёту
          </button>
          <button type="button" className="neu-btn justify-center" disabled={loading === "check"} onClick={() => void runComplianceCheck(true)}>
            {loading === "check" ? <Loader2 className="animate-spin" size={16} /> : <ShieldCheck size={16} />}
            Проверить без запуска
          </button>
          <button type="button" className="neu-btn-primary justify-center" disabled={realLaunchDisabled} onClick={() => void launch("PAUSED")}>
            {realLaunchBusy ? <Loader2 className="animate-spin" size={16} /> : <Rocket size={16} />}
            Создать в Meta выключенным
          </button>
          <button type="button" className="neu-btn justify-center border-red-200 text-red-700" disabled={realLaunchDisabled} onClick={() => void launch("ACTIVE")}>
            <AlertTriangle size={16} />
            Запустить рекламу
          </button>
        </div>

        {launchResult ? (
          <div className="mt-6 rounded-[24px] border border-emerald-200 bg-emerald-50 p-5">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 text-emerald-700" size={20} />
              <div>
                <p className="font-black text-emerald-900">{launchResultTitle}</p>
                <p className="mt-1 text-sm font-semibold text-emerald-800">
                  {launchResult.dryRun ? "Кампания в Meta не создавалась." : `Meta Campaign ID: ${launchResult.metaCampaignId || "ожидается"}`}
                </p>
                {launchResult.warning ? <p className="mt-2 text-sm font-bold text-amber-800">{launchResult.warning}</p> : null}
              </div>
            </div>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <a className="neu-btn justify-center" href={adsManagerUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={16} />
                Открыть Ads Manager
              </a>
              <button type="button" className="neu-btn-primary justify-center" onClick={() => setLocation("/ads-automation/history")}>
                <History size={16} />
                История запусков
              </button>
            </div>
          </div>
        ) : null}
      </section>
    );
  }

  function renderHistory() {
    return (
      <section className="neu-card p-5 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-[#0D9488]">История</p>
            <h1 className="mt-1 text-2xl font-black text-[#0F172A]">История запусков</h1>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button type="button" className="neu-btn justify-center" disabled={loading === "history"} onClick={() => void loadHistory()}>
              {loading === "history" ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}
              Обновить
            </button>
            <button type="button" className="neu-btn-primary justify-center" onClick={() => setLocation("/ads-automation")}>
              Новый запуск
            </button>
          </div>
        </div>

        <div className="mt-6 grid gap-3">
          {historyItems.length === 0 ? (
            <div className="rounded-2xl border border-[#D8E4EC] bg-white/65 p-5 text-sm font-semibold text-[#64748B]">
              История пока пустая. Первый запуск появится здесь после проверки без запуска или создания кампании.
            </div>
          ) : (
            historyItems.map((item, index) => {
              const payload = asRecord(item.payload);
              return (
                <article key={item.id || `${item.campaignName}-${index}`} className="rounded-2xl border border-[#D8E4EC] bg-white/70 p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <p className="font-black text-[#0F172A]">{item.campaignName || "Meta campaign"}</p>
                      <p className="mt-1 text-sm font-semibold text-[#64748B]">
                        {item.createdAt ? new Date(item.createdAt).toLocaleString("ru-RU") : "Дата не указана"} · {payload.creativeType === "video" ? "видео" : "фото"} · {item.status || "draft"}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <StatusPill tone={item.lastError ? "red" : "green"}>{item.lastError ? "ошибка" : item.metaStatus || item.status || "создано"}</StatusPill>
                      <StatusPill tone="slate">{item.budgetDailyMinor ? `${Math.round(item.budgetDailyMinor / 100)} ${item.currency || "USD"}/день` : "бюджет -"}</StatusPill>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2 text-sm font-semibold text-[#475569] md:grid-cols-2">
                    <p>Meta Campaign ID: {item.metaCampaignId || "-"}</p>
                    <p>Запустил: {item.launchedBy || "-"}</p>
                    <p>Город: {typeof payload.city === "string" ? payload.city : "-"}</p>
                    <p>Файл: {typeof payload.fileName === "string" ? payload.fileName : "-"}</p>
                  </div>
                  {item.lastError ? <p className="mt-3 text-sm font-bold text-red-600">{item.lastError}</p> : null}
                </article>
              );
            })
          )}
        </div>
      </section>
    );
  }

  const stepContent = [renderCreativeStep, renderBriefStep, renderAiStep, renderComplianceStep, renderReportStep, renderLaunchStep][currentStep - 1]();

  return (
    <PageLayout>
      <div className="space-y-6">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-[#0D9488]">Meta/Facebook/Instagram Ads</p>
            <h1 className="mt-2 text-3xl font-black text-[#0F172A]">Автозапуск рекламы</h1>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[#64748B]">
              Русский мастер для сотрудника: загрузить креатив, ответить на ключевые вопросы, проверить безопасность и создать рекламу в Meta.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Link href="/ads">
              <button type="button" className="neu-btn justify-center">
                <Megaphone size={16} />
                Раздел рекламы
              </button>
            </Link>
            <button type="button" className="neu-btn justify-center" onClick={() => setLocation(isHistoryView ? "/ads-automation" : "/ads-automation/history")}>
              <History size={16} />
              {isHistoryView ? "Новый запуск" : "История запусков"}
            </button>
            <button type="button" className="neu-btn-primary justify-center" disabled={loading === "health"} onClick={() => void checkHealth()}>
              {loading === "health" ? <Loader2 className="animate-spin" size={16} /> : <ShieldCheck size={16} />}
              Проверить Meta
            </button>
          </div>
        </header>

        {notice ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
            {notice}
          </div>
        ) : null}

        {isHistoryView ? (
          renderHistory()
        ) : (
          <>
            <nav className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6" aria-label="Шаги запуска рекламы">
              {wizardSteps.map((label, index) => {
                const step = index + 1;
                const active = step === currentStep;
                const done = step < currentStep;
                return (
                  <button
                    key={label}
                    type="button"
                    className={`rounded-2xl border px-3 py-3 text-left transition ${
                      active
                        ? "border-[#0D9488] bg-[#F0FDFA] text-[#0F172A]"
                        : done
                          ? "border-emerald-200 bg-white/70 text-emerald-700"
                          : "border-[#D8E4EC] bg-white/50 text-[#64748B]"
                    }`}
                    onClick={() => goToStep(step)}
                  >
                    <span className="block text-[11px] font-black uppercase tracking-[0.12em]">Шаг {step}</span>
                    <span className="mt-1 block text-sm font-black">{label}</span>
                  </button>
                );
              })}
            </nav>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_330px]">
              <div>{stepContent}</div>
              <aside className="space-y-4">
                <section className="neu-card p-5">
                  <div className="flex items-center gap-2">
                    <ClipboardList size={18} className="text-[#0D9488]" />
                    <h2 className="text-base font-black text-[#0F172A]">Сводка</h2>
                  </div>
                  <div className="mt-4 space-y-3 text-sm">
                    <p><b>Креатив:</b> {creative ? `${creative.fileType === "video" ? "Видео" : "Фото"} · ${creative.fileName}` : "не загружен"}</p>
                    <p><b>Услуга:</b> {brief.service}</p>
                    <p><b>Город:</b> {brief.city}</p>
                    <p><b>Заявки:</b> {destination.label}</p>
                    <p><b>Бюджет:</b> {brief.dailyBudget || 0} USD/день · {totalBudget} USD примерно</p>
                    <p><b>Статус:</b> {statusModeLabel(statusMode)}</p>
                  </div>
                </section>
                <section className="neu-card p-5">
                  <div className="flex items-center gap-2">
                    <Sparkles size={18} className="text-[#0D9488]" />
                    <h2 className="text-base font-black text-[#0F172A]">Готовность</h2>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <StatusPill tone={creative ? "green" : "slate"}>Креатив</StatusPill>
                    <StatusPill tone={aiPackage ? "green" : "slate"}>ИИ пакет</StatusPill>
                    <StatusPill tone={compliance ? (compliance.status === "blocked" ? "red" : "green") : "slate"}>Проверка</StatusPill>
                    <StatusPill tone={metaSummary?.configured ? "green" : "amber"}>Meta</StatusPill>
                    <StatusPill tone={hasSupabaseFrontendEnv ? "green" : "amber"}>Supabase Storage</StatusPill>
                  </div>
                </section>
              </aside>
            </div>
          </>
        )}
      </div>
    </PageLayout>
  );
}

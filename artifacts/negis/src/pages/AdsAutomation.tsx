import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  FileImage,
  FlaskConical,
  History,
  Loader2,
  Megaphone,
  RefreshCw,
  Rocket,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  UploadCloud,
  Video,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { PageLayout } from "@/components/layout/PageLayout";
import { useAuth } from "@/contexts/AuthContext";
import { apiUrl } from "@/lib/api";
import { hasSupabaseFrontendEnv, supabase } from "@/lib/supabase";
import { getPlanFeature, normalizePlan, planFeatureBadge, type NegisPlan } from "@/lib/planFeatures";
import { KZ_META_CITY_OPTIONS, getKzMetaCityOption } from "../../../../lib/meta/cities";

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
  videoUploadMode?: string;
  videoProcessingStatus?: string;
  videoWarnings?: string[];
  thumbnailUrl?: string;
  thumbnailGeneratedAt?: string;
  thumbnailSource?: string;
  thumbnailMimeType?: string;
  status: string;
};

type LeadDestination = "whatsapp" | "instagram_profile" | "website" | "lead_form" | "call";

type Brief = {
  service: string;
  city: string;
  cityId: string;
  cityLabelRu: string;
  cityCanonicalName: string;
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
  launchTimestamp?: string;
  metaCampaignId?: string;
  metaAdSetId?: string;
  metaCreativeId?: string;
  metaAdId?: string;
  metaVideoId?: string;
  videoId?: string;
  videoUploadMode?: string;
  videoProcessingStatus?: string;
  videoWarnings?: string[];
  lastCheckedAt?: string;
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
  videoLaunchEnabled?: boolean;
  hasAccessToken?: boolean;
  videoOptimization?: {
    enabled?: boolean;
    thresholdMb?: number;
    maxInputMb?: number;
    rawBucket?: string;
    workerSecretConfigured?: boolean;
  };
};

type VideoJobStatus = "awaiting_upload" | "queued" | "downloading" | "transcoding" | "uploading" | "ready" | "failed";

type VideoJob = {
  id: string;
  status: VideoJobStatus;
  progress?: number;
  error?: string;
  outputPublicUrl?: string;
  thumbnailPublicUrl?: string;
  thumbnailSource?: string;
  outputMimeType?: string;
  outputSizeBytes?: number;
  compressionRatio?: number;
  rawDeletedAt?: string;
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
type CreativeReadinessStatus =
  | "idle"
  | "selected"
  | "uploading"
  | "uploaded"
  | "generating_thumbnail"
  | "ready_for_meta"
  | "failed"
  | "too_large"
  | "needs_thumbnail"
  | "needs_optimization"
  | "optimizing"
  | "optimization_ready"
  | "optimization_failed"
  | "direct_upload_too_large_disabled"
  | "config_loading";
type RealLaunchStatus = "idle" | "creating" | "failed" | "created" | "video_processing";
type LaunchMode = "dry_run" | "video_processing" | "paused_created" | "active_created" | "failed";

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
  videoOptimizationLoaded?: boolean;
  videoOptimizationEnabled?: boolean;
  videoOptimizationThresholdMb?: number;
  videoOptimizationMaxInputMb?: number;
  fileSizeMb?: number;
  largeVideoBranch?: boolean;
  uploadTarget?: string;
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
  launchTimestamp?: string;
  status?: string;
  metaCampaignId?: string;
  metaAdSetId?: string;
  metaCreativeId?: string;
  metaAdId?: string;
  metaVideoId?: string;
  metaStatus?: string;
  budgetDailyMinor?: number | null;
  currency?: string;
  launchedBy?: string;
  lastError?: string;
  createdAt?: string;
  payload?: Record<string, unknown>;
  metaResponse?: Record<string, unknown>;
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
const VIDEO_REAL_LAUNCH_DISABLED_MESSAGE =
  "Видео загружено в Negis. Реклама будет подготовлена безопасно и создана выключенной после проверки.";
const VIDEO_LAUNCH_SOON_MESSAGE = "Видео-запуск через Meta API будет добавлен после отдельной проверки команды.";
const VIDEO_LAUNCH_ENABLED_MESSAGE = "Видео будет подготовлено для Meta автоматически перед созданием объявления.";
const VIDEO_REQUIREMENTS_MESSAGE = "Видео: желательно MP4, до 100 MB, кодек H.264, вертикальный формат 9:16 для Reels/Stories. MOV можно хранить в Negis, но для Meta автозапуска лучше MP4.";
const MOV_VIDEO_WARNING = "MOV поддерживается Meta, но обработка может быть дольше. Для стабильности лучше MP4/H.264.";
const VIDEO_FORMAT_ERROR = "Для автозапуска видео поддерживаются MP4 и MOV.";
const DRY_RUN_REFERENCE_MESSAGE = "Последняя проверка без запуска прошла. Meta API не вызывался.";
const VIDEO_PROCESSING_PENDING_MESSAGE = "Видео принято Meta и обрабатывается. Это не ошибка. Повторите создание объявления через несколько минут.";
const THUMBNAIL_FAILED_MESSAGE = "Не удалось автоматически создать обложку видео. Попробуйте MP4 или другое видео.";
const THUMBNAIL_READY_MESSAGE = "Обложка видео создана автоматически";
const THUMBNAIL_REQUIRED_FOR_LAUNCH_MESSAGE = "Обложка видео не создана — она обязательна для запуска видео-рекламы. Нажмите «Создать обложку заново» или загрузите другое видео.";
const VIDEO_OPTIMIZING_MESSAGE = "Видео загружено. Идёт оптимизация для рекламы.";
const VIDEO_OPTIMIZED_READY_MESSAGE = "Видео оптимизировано и готово для Meta";
const VIDEO_OPTIMIZING_LAUNCH_BLOCKED_MESSAGE =
  "Видео ещё оптимизируется. Реальный запуск будет доступен, когда оптимизация завершится. Проверку без запуска можно сделать уже сейчас.";
const VIDEO_OPTIMIZATION_FAILED_MESSAGE = "Не удалось оптимизировать видео. Попробуйте загрузить MP4 меньшего размера или другое видео.";
const VIDEO_OPTIMIZATION_CONFIG_LOADING_MESSAGE =
  "Настройки оптимизации видео ещё загружаются. Подождите несколько секунд и попробуйте снова.";
const STUDIO_PREFILL_KEY = "negis_ads_automation_prefill";
const STUDIO_PREFILL_NOTICE = "Данные перенесены из AI Контент-студии. Проверьте параметры перед запуском.";
const VIDEO_OPTIMIZATION_DISABLED_TOO_LARGE_MESSAGE =
  "Автоматическая оптимизация видео скоро будет доступна. Сейчас загрузите видео до 50 МБ или MP4 H.264.";
const VIDEO_NEEDS_OPTIMIZATION_MESSAGE = "Видео большое. Для запуска рекламы его нужно оптимизировать.";
const VIDEO_OPTIMIZATION_NEXT_STEP_MESSAGE = "Следующим этапом система подготовит MP4-версию для Meta.";

const videoJobStatusLabels: Record<VideoJobStatus, string> = {
  awaiting_upload: "Загружаем исходное видео",
  queued: "В очереди на обработку",
  downloading: "Подготовка файла",
  transcoding: "Оптимизируем видео",
  uploading: "Сохраняем готовое видео",
  ready: "Видео оптимизировано и готово",
  failed: "Не удалось оптимизировать видео",
};
const VIDEO_OPTIMIZING_TITLE = "Видео загружено для оптимизации";
const VIDEO_OPTIMIZING_BODY = "Мы подготовим MP4-версию для Meta. Запуск будет доступен после обработки.";
const VIDEO_OPTIMIZING_LAUNCH_AFTER_MESSAGE = "Запуск рекламы будет доступен после оптимизации.";

function normalizeVideoJob(record: Record<string, unknown>): VideoJob | null {
  const id = firstString(record.id);
  if (!id) return null;
  const statusRaw = firstString(record.status).toLowerCase();
  const known: VideoJobStatus[] = ["awaiting_upload", "queued", "downloading", "transcoding", "uploading", "ready", "failed"];
  const outputSizeBytes = Number(record.outputSizeBytes ?? record.output_size_bytes ?? record.outputSize ?? record.output_size);
  const compressionRatio = Number(record.compressionRatio ?? record.compression_ratio);
  return {
    id,
    status: known.includes(statusRaw as VideoJobStatus) ? (statusRaw as VideoJobStatus) : "queued",
    progress: Number(record.progress) || 0,
    error: firstString(record.error, record.errorMessage, record.error_message) || undefined,
    // Only the optimized output URL is ever surfaced — the raw original has no public URL
    // and the server (makeVideoJob) never returns raw bucket/path fields.
    outputPublicUrl:
      firstString(record.outputPublicUrl, record.output_public_url, record.optimizedPublicUrl, record.optimized_public_url) || undefined,
    thumbnailPublicUrl:
      firstString(record.thumbnailPublicUrl, record.thumbnail_public_url, record.thumbnailUrl, record.thumbnail_url) || undefined,
    thumbnailSource: firstString(record.thumbnailSource, record.thumbnail_source) || undefined,
    outputMimeType: firstString(record.outputMimeType, record.output_mime_type) || undefined,
    outputSizeBytes: Number.isFinite(outputSizeBytes) && outputSizeBytes > 0 ? outputSizeBytes : undefined,
    compressionRatio: Number.isFinite(compressionRatio) && compressionRatio > 0 ? compressionRatio : undefined,
    rawDeletedAt: firstString(record.rawDeletedAt, record.raw_deleted_at) || undefined,
  };
}

const defaultBrief: Brief = {
  service: "Консультация косметолога",
  city: "Астана",
  cityId: "astana",
  cityLabelRu: "Астана",
  cityCanonicalName: "Astana",
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

const clientWizardSteps = [
  { label: "Креатив", description: "Фото или видео", targetStep: 1 },
  { label: "Параметры", description: "Город, бюджет, заявки", targetStep: 2 },
  { label: "Предпросмотр", description: "Текст и проверка", targetStep: 3 },
  { label: "Запуск", description: "Создать выключенной", targetStep: 6 },
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

function normalizeBriefCity(brief: Brief): Brief {
  const city = getKzMetaCityOption(brief.cityId || brief.city || brief.cityLabelRu);
  return {
    ...brief,
    city: city.labelRu,
    cityId: city.id,
    cityLabelRu: city.labelRu,
    cityCanonicalName: city.canonicalName,
  };
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
    videoUploadMode: readStringField(record, ["videoUploadMode", "video_upload_mode", "uploadMode", "upload_mode"], fallback.videoUploadMode || "") || undefined,
    videoProcessingStatus: readStringField(record, ["videoProcessingStatus", "video_processing_status", "processingStatus", "processing_status"], fallback.videoProcessingStatus || "") || undefined,
    videoWarnings: Array.isArray(record.videoWarnings)
      ? record.videoWarnings.filter((item): item is string => typeof item === "string")
      : fallback.videoWarnings,
    thumbnailUrl:
      readStringField(record, ["thumbnailUrl", "thumbnail_url"], "") ||
      readStringField(asRecord(record.metadata), ["thumbnailUrl", "thumbnail_url"], fallback.thumbnailUrl || "") ||
      undefined,
    thumbnailGeneratedAt:
      readStringField(asRecord(record.metadata), ["thumbnailGeneratedAt", "thumbnail_generated_at"], fallback.thumbnailGeneratedAt || "") || undefined,
    thumbnailSource:
      readStringField(asRecord(record.metadata), ["thumbnailSource", "thumbnail_source"], fallback.thumbnailSource || "") || undefined,
    thumbnailMimeType:
      readStringField(asRecord(record.metadata), ["thumbnailMimeType", "thumbnail_mime_type"], fallback.thumbnailMimeType || "") || undefined,
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

function uploadStatusLabel(status: UploadStatus) {
  const labels: Record<UploadStatus, string> = {
    idle: "",
    validating: "Проверяем файл",
    getting_signed_url: "Готовим загрузку",
    uploading_to_storage: "Загружаем файл",
    saving_metadata: "Сохраняем креатив",
    ready: "Креатив готов для Meta",
    failed: "Не удалось подготовить креатив",
  };
  return labels[status];
}

type CreativeReadiness = {
  status: CreativeReadinessStatus;
  label: string;
  tone: "green" | "amber" | "red" | "blue" | "slate";
  isReadyForMeta: boolean;
  isBlocking: boolean;
  clientMessage: string;
  adminMessage: string;
};

type PreviewReadiness = {
  isReady: boolean;
  message: string;
  details: string[];
};

function isTooLargeUploadError(value?: string) {
  const text = (value || "").toLowerCase();
  return Boolean(
    text &&
      (text.includes("too large") ||
        text.includes("maximum allowed size") ||
        text.includes("exceeded the maximum") ||
        text.includes("object exceeded") ||
        text.includes("payload too large") ||
        text.includes("file_size_limit") ||
        text.includes("размер") ||
        text.includes("больше") ||
        text.includes("100 mb") ||
        text.includes("100 мб")),
  );
}

function friendlyCreativeError(rawError: string, creative?: CreativeAsset | null) {
  const text = rawError.toLowerCase();
  if (isTooLargeUploadError(rawError)) {
    return creative?.fileType === "image"
      ? "Файл слишком большой для прямой загрузки."
      : "Видео слишком большое для прямой загрузки. Попробуйте файл меньшего размера.";
  }
  if (text.includes("publicurl") || text.includes("public url") || text.includes("публич")) {
    return "Не удалось подготовить публичную ссылку для Meta.";
  }
  if (text.includes("thumbnail") || text.includes("облож")) {
    return "Не удалось создать обложку видео. Для запуска видео в Meta нужна обложка.";
  }
  if (text.includes("supabase storage") || text.includes("upload") || text.includes("signed")) {
    return "Не удалось загрузить файл.";
  }
  return rawError ? "Не удалось подготовить креатив." : "Не удалось подготовить креатив.";
}

function getCreativeReadiness({
  creative,
  uploadStatus,
  loading,
  videoJobPending,
  lastUploadError,
  videoJob,
  videoOptimization,
  configBlocked,
}: {
  creative: CreativeAsset | null;
  uploadStatus: UploadStatus;
  loading?: string | null;
  videoJobPending?: boolean;
  lastUploadError?: string;
  videoJob?: VideoJob | null;
  videoOptimization?: { enabled?: boolean; thresholdMb?: number; maxInputMb?: number } | null;
  configBlocked?: boolean;
}): CreativeReadiness {
  const rawError = lastUploadError || "";
  const failed = uploadStatus === "failed" || creative?.status === "failed" || creative?.status === "upload_failed";
  const tooLarge = failed && isTooLargeUploadError(rawError);

  // Optimization pipeline states take priority: a failure inside the large-video
  // branch must never be reported as a "direct upload too large" problem.
  if (configBlocked) {
    return {
      status: "config_loading",
      label: "Настройки оптимизации загружаются",
      tone: "amber",
      isReadyForMeta: false,
      isBlocking: true,
      clientMessage: VIDEO_OPTIMIZATION_CONFIG_LOADING_MESSAGE,
      adminMessage: rawError,
    };
  }
  if (videoJob?.status === "failed") {
    return {
      status: "optimization_failed",
      label: "Не удалось оптимизировать видео",
      tone: "red",
      isReadyForMeta: false,
      isBlocking: true,
      clientMessage: VIDEO_OPTIMIZATION_FAILED_MESSAGE,
      adminMessage: videoJob.error || rawError,
    };
  }
  if (videoJobPending) {
    return {
      status: "optimizing",
      label: "Идёт оптимизация видео",
      tone: "blue",
      isReadyForMeta: false,
      isBlocking: false,
      clientMessage: `${VIDEO_OPTIMIZING_MESSAGE} ${VIDEO_OPTIMIZING_LAUNCH_BLOCKED_MESSAGE}`,
      adminMessage: rawError,
    };
  }
  // Direct upload rejected by size while the optimization pipeline is disabled.
  if (tooLarge && videoOptimization && videoOptimization.enabled !== true && creative?.fileType !== "image") {
    return {
      status: "direct_upload_too_large_disabled",
      label: "Видео слишком большое для прямой загрузки",
      tone: "red",
      isReadyForMeta: false,
      isBlocking: true,
      clientMessage: VIDEO_OPTIMIZATION_DISABLED_TOO_LARGE_MESSAGE,
      adminMessage: rawError,
    };
  }

  if (!creative) {
    if (failed) {
      return {
        status: tooLarge ? "too_large" : "failed",
        label: tooLarge ? "Видео слишком большое для прямой загрузки" : "Не удалось подготовить креатив",
        tone: "red",
        isReadyForMeta: false,
        isBlocking: true,
        clientMessage: friendlyCreativeError(rawError, creative),
        adminMessage: rawError,
      };
    }
    if (loading === "upload" || uploadStatus === "validating" || uploadStatus === "getting_signed_url" || uploadStatus === "uploading_to_storage" || uploadStatus === "saving_metadata") {
      return {
        status: uploadStatus === "saving_metadata" ? "uploaded" : "uploading",
        label: uploadStatus === "saving_metadata" ? "Файл загружен" : "Загружаем файл",
        tone: "blue",
        isReadyForMeta: false,
        isBlocking: false,
        clientMessage: "Файл выбран. Идёт подготовка.",
        adminMessage: rawError,
      };
    }
    return {
      status: "idle",
      label: "Креатив не загружен",
      tone: "slate",
      isReadyForMeta: false,
      isBlocking: false,
      clientMessage: "Загрузите фото или видео.",
      adminMessage: rawError,
    };
  }

  if (creative.status === "needs_optimization") {
    return {
      status: "needs_optimization",
      label: "Видео нужно оптимизировать",
      tone: "amber",
      isReadyForMeta: false,
      isBlocking: true,
      clientMessage:
        videoOptimization?.enabled === true
          ? `${VIDEO_NEEDS_OPTIMIZATION_MESSAGE} Видео будет отправлено на оптимизацию перед запуском.`
          : `${VIDEO_NEEDS_OPTIMIZATION_MESSAGE} ${VIDEO_OPTIMIZATION_NEXT_STEP_MESSAGE} ${VIDEO_OPTIMIZATION_DISABLED_TOO_LARGE_MESSAGE}`,
      adminMessage: rawError,
    };
  }

  if (tooLarge) {
    return {
      status: "too_large",
      label: "Видео слишком большое для прямой загрузки",
      tone: "red",
      isReadyForMeta: false,
      isBlocking: true,
      clientMessage: friendlyCreativeError(rawError, creative),
      adminMessage: rawError,
    };
  }

  if (failed) {
    return {
      status: "failed",
      label: "Не удалось подготовить креатив",
      tone: "red",
      isReadyForMeta: false,
      isBlocking: true,
      clientMessage: friendlyCreativeError(rawError, creative),
      adminMessage: rawError,
    };
  }

  if (loading === "thumbnail") {
    return {
      status: "generating_thumbnail",
      label: "Создаём обложку видео",
      tone: "blue",
      isReadyForMeta: false,
      isBlocking: false,
      clientMessage: "Для видео готовится обложка.",
      adminMessage: rawError,
    };
  }

  if (!creative.publicUrl) {
    const uploading = loading === "upload" || videoJobPending || creative.status === "optimizing" || uploadStatus !== "idle";
    return {
      status: uploading ? "uploading" : "selected",
      label: uploading ? "Загружаем файл" : "Файл выбран. Идёт подготовка.",
      tone: uploading ? "blue" : "amber",
      isReadyForMeta: false,
      isBlocking: false,
      clientMessage: uploading ? "Файл выбран. Идёт подготовка." : "Не удалось подготовить публичную ссылку для Meta.",
      adminMessage: rawError,
    };
  }

  if (creative.fileType === "video" && !creative.thumbnailUrl) {
    return {
      status: "needs_thumbnail",
      label: "Для видео нужна обложка",
      tone: "amber",
      isReadyForMeta: false,
      isBlocking: true,
      clientMessage: "Не удалось создать обложку видео. Для запуска видео в Meta нужна обложка.",
      adminMessage: rawError,
    };
  }

  const optimizationReady = videoJob?.status === "ready";
  return {
    status: optimizationReady ? "optimization_ready" : "ready_for_meta",
    label: optimizationReady ? VIDEO_OPTIMIZED_READY_MESSAGE : "Креатив готов для Meta",
    tone: "green",
    isReadyForMeta: true,
    isBlocking: false,
    clientMessage: optimizationReady ? `${VIDEO_OPTIMIZED_READY_MESSAGE}. Можно продолжать запуск.` : "Креатив готов для Meta",
    adminMessage: rawError,
  };
}

function creativeReadyLabel(creative: CreativeAsset | null, uploadStatus: UploadStatus = "idle", lastUploadError = "") {
  return getCreativeReadiness({ creative, uploadStatus, lastUploadError }).label;
}

function creativeReadyTone(creative: CreativeAsset | null, uploadStatus: UploadStatus = "idle", lastUploadError = ""): "green" | "amber" | "red" | "blue" | "slate" {
  return getCreativeReadiness({ creative, uploadStatus, lastUploadError }).tone;
}

function uploadLinkMissingMessage(storageHealth?: StorageHealth | null) {
  if (storageHealth?.publicUrlWorks) {
    return "Не удалось подготовить публичную ссылку для Meta.";
  }
  return "Не удалось подготовить публичную ссылку для Meta.";
}

function realLaunchNeedsCreativeReadiness(readiness: CreativeReadiness) {
  if (!readiness.isReadyForMeta) return readiness.clientMessage || readiness.label;
  return "";
}

function getPreviewReadiness({
  creativeReadiness,
  brief,
  cityLabel,
  adText,
  requireAdText = true,
}: {
  creativeReadiness: CreativeReadiness;
  brief: Brief;
  cityLabel: string;
  adText?: string;
  requireAdText?: boolean;
}): PreviewReadiness {
  const details: string[] = [];
  const dailyBudget = Number(brief.dailyBudget);
  const hasCampaignParameters =
    Boolean(brief.service.trim()) &&
    Boolean(cityLabel.trim()) &&
    Number.isFinite(dailyBudget) &&
    dailyBudget > 0 &&
    Boolean(brief.days.trim()) &&
    Boolean(brief.destinationValue.trim());

  if (!creativeReadiness.isReadyForMeta) details.push("Сначала подготовьте креатив.");
  if (!hasCampaignParameters) details.push("Заполните параметры кампании.");
  if (brief.leadDestination !== "whatsapp") details.push("Для безопасного MVP-запуска выберите WhatsApp как назначение заявки.");
  if (requireAdText && !firstString(adText)) details.push("Подготовьте текст объявления.");

  return {
    isReady: details.length === 0,
    message: details[0] || "Предпросмотр готов.",
    details,
  };
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
    ...extra,
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

function isMovCreative(creative: Pick<CreativeAsset, "fileName" | "mimeType" | "fileType"> | null) {
  if (!creative || creative.fileType !== "video") return false;
  return creative.mimeType === "video/quicktime" || creative.fileName.toLowerCase().endsWith(".mov");
}

function isMetaVideoFormatSupported(creative: Pick<CreativeAsset, "fileName" | "mimeType" | "fileType"> | null) {
  if (!creative || creative.fileType !== "video") return true;
  const extension = creative.fileName.split(".").pop()?.toLowerCase() || "";
  return creative.mimeType === "video/mp4" || creative.mimeType === "video/quicktime" || extension === "mp4" || extension === "mov";
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim()))));
}

function localHistoryKey(workspaceId: string) {
  return `negis_ads_launch_history_${workspaceId}`;
}

type VideoThumbnailCapture = { blob: Blob; mimeType: string };

function captureVideoThumbnail(file: File): Promise<VideoThumbnailCapture | null> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = objectUrl;

    let finished = false;
    const finish = (result: VideoThumbnailCapture | null) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(totalTimer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(objectUrl);
      resolve(result);
    };
    const totalTimer = window.setTimeout(() => finish(null), 15000);

    const drawFrame = (): Promise<VideoThumbnailCapture | null> =>
      new Promise((resolveFrame) => {
        try {
          const width = video.videoWidth;
          const height = video.videoHeight;
          if (!width || !height) return resolveFrame(null);
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d");
          if (!context) return resolveFrame(null);
          context.drawImage(video, 0, 0, width, height);
          canvas.toBlob((blob) => resolveFrame(blob && blob.size > 0 ? { blob, mimeType: "image/jpeg" } : null), "image/jpeg", 0.86);
        } catch {
          resolveFrame(null);
        }
      });

    const seekTo = (time: number): Promise<boolean> =>
      new Promise((resolveSeek) => {
        let seekDone = false;
        const settle = (ok: boolean) => {
          if (seekDone) return;
          seekDone = true;
          window.clearTimeout(seekTimer);
          video.removeEventListener("seeked", onSeeked);
          video.removeEventListener("error", onSeekError);
          resolveSeek(ok);
        };
        const onSeeked = () => settle(true);
        const onSeekError = () => settle(false);
        const seekTimer = window.setTimeout(() => settle(false), 4000);
        try {
          video.addEventListener("seeked", onSeeked, { once: true });
          video.addEventListener("error", onSeekError, { once: true });
          video.currentTime = time;
        } catch {
          settle(false);
        }
      });

    video.addEventListener("error", () => finish(null), { once: true });
    video.addEventListener(
      "loadeddata",
      () => {
        void (async () => {
          const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
          // Prefer ~1 second in; for clips shorter than a second use 10% of the duration.
          const preferredTime = duration >= 1 ? 1 : Math.max(duration * 0.1, 0);
          const maxSeekable = Math.max(duration - 0.05, 0);
          // Fallback chain: preferred moment → 0.1s → first available frame.
          for (const time of [preferredTime, 0.1, 0]) {
            await seekTo(Math.max(Math.min(time, maxSeekable), 0));
            const frame = await drawFrame();
            if (frame) return finish(frame);
          }
          finish(null);
        })();
      },
      { once: true },
    );
  });
}

function isDryRunMetaId(value?: string) {
  return Boolean(value && value.trim().toLowerCase().startsWith("dryrun_"));
}

function isVideoStatusReady(value?: string) {
  const text = (value || "").toLowerCase();
  return text.includes("ready") || text.includes("available") || text.includes("complete") || text.includes("success") || text.includes("finished");
}

function resolveLaunchMode(item: LaunchHistoryItem): LaunchMode {
  const status = (item.status || "").toLowerCase();
  const metaStatus = (item.metaStatus || "").toLowerCase();
  const metaResponse = asRecord(item.metaResponse);
  const payload = asRecord(item.payload);
  const hasDryRunIds = [item.metaCampaignId, item.metaAdSetId, item.metaCreativeId, item.metaAdId].some((id) => isDryRunMetaId(id));

  if (status === "dry_run" || metaStatus === "dry_run" || metaResponse.dryRun === true || hasDryRunIds) return "dry_run";
  if (status === "video_processing" || metaStatus === "video_processing" || metaResponse.pendingVideoProcessing === true) return "video_processing";
  if (status === "failed" || metaStatus === "failed" || Boolean(item.lastError)) return "failed";

  const realCampaignId = item.metaCampaignId && !isDryRunMetaId(item.metaCampaignId) ? item.metaCampaignId : "";
  if (!realCampaignId) {
    const videoId = firstString(item.metaVideoId, payload.metaVideoId);
    if (videoId && !isDryRunMetaId(videoId)) return "video_processing";
    return "dry_run";
  }
  if (status === "active" || metaStatus === "active") return "active_created";
  return "paused_created";
}

type HistoryFilter = "all" | "real" | "processing" | "failed" | "dry_run" | "photo" | "video" | "optimized";

const historyFilterOptions: Array<{ id: HistoryFilter; label: string }> = [
  { id: "all", label: "Все" },
  { id: "real", label: "Создано в Meta" },
  { id: "processing", label: "Видео в обработке" },
  { id: "failed", label: "Требуют внимания" },
  { id: "dry_run", label: "Тесты" },
  { id: "photo", label: "Фото" },
  { id: "video", label: "Видео" },
  { id: "optimized", label: "Оптимизированные видео" },
];

function historyDestinationLabel(payload: Record<string, unknown>): string {
  const direct = firstString(payload.leadDestination);
  if (direct) {
    return destinationOptions.find((option) => option.value === direct)?.label || direct;
  }
  const url = firstString(payload.landingUrl).toLowerCase();
  if (url.includes("wa.me") || url.includes("whatsapp")) return "WhatsApp";
  if (url.includes("instagram.com")) return "Instagram профиль";
  if (url.startsWith("tel:")) return "Звонок";
  if (url) return "Сайт";
  return "-";
}

function matchesHistoryFilter(item: LaunchHistoryItem, filter: HistoryFilter): boolean {
  if (filter === "all") return true;
  const mode = resolveLaunchMode(item);
  const creativeType = firstString(asRecord(item.payload).creativeType) === "video" ? "video" : "photo";
  if (filter === "real") return mode === "paused_created" || mode === "active_created";
  if (filter === "processing") return mode === "video_processing";
  if (filter === "dry_run") return mode === "dry_run";
  if (filter === "failed") return mode === "failed";
  if (filter === "photo") return creativeType === "photo";
  if (filter === "optimized") return asRecord(item.payload).optimized === true;
  return creativeType === "video";
}

function matchesHistorySearch(item: LaunchHistoryItem, query: string): boolean {
  const text = query.trim().toLowerCase();
  if (!text) return true;
  const payload = asRecord(item.payload);
  const haystack = [
    item.campaignName,
    payload.service,
    payload.city,
    item.metaCampaignId,
    item.metaAdSetId,
    item.metaCreativeId,
    item.metaAdId,
    item.metaVideoId,
    payload.metaVideoId,
  ]
    .map((value) => String(value ?? ""))
    .join(" ")
    .toLowerCase();
  return haystack.includes(text);
}

function historyItemTimestamp(item: LaunchHistoryItem): number {
  const payload = asRecord(item.payload);
  for (const value of [item.createdAt, item.launchTimestamp, payload.launchTimestamp]) {
    const timestamp = Date.parse(String(value || ""));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function historyItemIdentity(item: LaunchHistoryItem): string {
  const payload = asRecord(item.payload);
  const campaignId = firstString(item.metaCampaignId, asRecord(item.metaResponse).metaCampaignId);
  if (campaignId) return `campaign:${campaignId}`;

  const eventTimestamp = firstString(item.launchTimestamp, payload.launchTimestamp, item.createdAt);
  const campaignName = firstString(item.campaignName, payload.campaignName);
  if (eventTimestamp && campaignName) return `event:${eventTimestamp}:${campaignName}:${resolveLaunchMode(item)}`;
  if (item.id) return `launch:${item.id}`;

  return `legacy:${campaignName}:${item.status || ""}:${item.createdAt || ""}`;
}

function mergeHistoryItem(base: LaunchHistoryItem, incoming: LaunchHistoryItem): LaunchHistoryItem {
  return {
    id: incoming.id || base.id,
    campaignName: incoming.campaignName || base.campaignName,
    launchTimestamp: incoming.launchTimestamp || base.launchTimestamp,
    status: incoming.status || base.status,
    metaCampaignId: incoming.metaCampaignId || base.metaCampaignId,
    metaAdSetId: incoming.metaAdSetId || base.metaAdSetId,
    metaCreativeId: incoming.metaCreativeId || base.metaCreativeId,
    metaAdId: incoming.metaAdId || base.metaAdId,
    metaVideoId: incoming.metaVideoId || base.metaVideoId,
    metaStatus: incoming.metaStatus || base.metaStatus,
    budgetDailyMinor: incoming.budgetDailyMinor ?? base.budgetDailyMinor,
    currency: incoming.currency || base.currency,
    launchedBy: incoming.launchedBy || base.launchedBy,
    lastError: incoming.lastError || base.lastError,
    createdAt: incoming.createdAt || base.createdAt,
    payload: { ...asRecord(base.payload), ...asRecord(incoming.payload) },
    metaResponse: { ...asRecord(base.metaResponse), ...asRecord(incoming.metaResponse) },
  };
}

function mergeHistoryCollections(localItems: LaunchHistoryItem[], remoteItems: LaunchHistoryItem[]): LaunchHistoryItem[] {
  const merged = new Map<string, LaunchHistoryItem>();
  for (const item of [...localItems, ...remoteItems]) {
    const key = historyItemIdentity(item);
    const current = merged.get(key);
    merged.set(key, current ? mergeHistoryItem(current, item) : item);
  }

  return [...merged.values()].sort((left, right) => historyItemTimestamp(right) - historyItemTimestamp(left)).slice(0, 40);
}

class CrmError extends Error {
  data: Record<string, unknown>;

  constructor(message: string, data: Record<string, unknown>) {
    super(message);
    this.name = "CrmError";
    this.data = data;
  }
}

class VideoProcessingPendingError extends Error {
  metaVideoId: string;
  processingStatus: string;

  constructor(metaVideoId: string, processingStatus: string) {
    super(VIDEO_PROCESSING_PENDING_MESSAGE);
    this.name = "VideoProcessingPendingError";
    this.metaVideoId = metaVideoId;
    this.processingStatus = processingStatus;
  }
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
    throw new CrmError(
      [details || (body.success === false ? body.error : `HTTP ${response.status}`), ...metaDetails, hint].filter(Boolean).join(" "),
      body.success === false ? asRecord(body.data) : {},
    );
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

// Negis OS Glass Morphic Medical AI tone helpers (mirrors AiControlCenter): teal/mint
// success, violet/blue AI accents, amber warnings, soft red only for real failures.
type NegisTone = "primary" | "secondary" | "ai" | "success" | "warning" | "error" | "muted";

function negisToneColor(tone: NegisTone): string {
  return `var(--negis-${tone})`;
}

function negisToneSoftBg(tone: NegisTone): string {
  switch (tone) {
    case "ai":
      return "rgba(124,58,237,0.10)";
    case "secondary":
      return "rgba(37,99,235,0.10)";
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

function HistoryMetricCard({ label, value, icon: Icon, tone }: { label: string; value: number; icon: LucideIcon; tone: NegisTone }) {
  return (
    <div className="negis-glass p-4">
      <div className="flex items-center gap-2.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ background: negisToneSoftBg(tone), color: negisToneColor(tone) }}>
          <Icon size={16} />
        </div>
        <p className="text-xs font-black leading-tight" style={{ color: "var(--negis-muted)" }}>{label}</p>
      </div>
      <p className="mt-2 text-2xl font-black" style={{ color: "var(--negis-text)" }}>{value}</p>
    </div>
  );
}

function HistoryFact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <p className="flex min-w-0 items-start justify-between gap-3">
      <span className="shrink-0 font-semibold" style={{ color: "var(--negis-muted)" }}>{label}</span>
      <span className="min-w-0 break-words text-right font-bold" style={{ color: "var(--negis-text)" }}>{value}</span>
    </p>
  );
}

function FeatureBadge({ plan, feature }: { plan: NegisPlan; feature: Parameters<typeof getPlanFeature>[1] }) {
  const config = getPlanFeature(plan, feature);
  if (config.enabled && config.badge !== "Standard" && config.badge !== "Pro") return null;
  return <StatusPill tone={config.enabled ? "green" : "amber"}>{config.badge || planFeatureBadge(plan, feature)}</StatusPill>;
}

type UiMode = "client" | "admin";
type ReadinessState = "ready" | "action" | "checking" | "error";

function clientStepForInternal(step: number) {
  if (step <= 1) return 1;
  if (step === 2) return 2;
  if (step <= 5) return 3;
  return 4;
}

function readinessLabel(state: ReadinessState) {
  const labels: Record<ReadinessState, string> = {
    ready: "Готово",
    action: "Нужно действие",
    checking: "Проверяется",
    error: "Ошибка",
  };
  return labels[state];
}

function readinessTone(state: ReadinessState): "green" | "amber" | "red" | "blue" {
  if (state === "ready") return "green";
  if (state === "error") return "red";
  if (state === "checking") return "blue";
  return "amber";
}

function ReadinessRow({ label, state, note }: { label: string; state: ReadinessState; note?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-2xl border border-[#D8E4EC] bg-white/70 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-black text-[#0F172A]">{label}</p>
        {note ? <p className="mt-1 text-xs font-semibold text-[#64748B]">{note}</p> : null}
      </div>
      <StatusPill tone={readinessTone(state)}>{readinessLabel(state)}</StatusPill>
    </div>
  );
}

export default function AdsAutomation() {
  const [location, setLocation] = useLocation();
  const { user, userRole, clinicId } = useAuth();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const workspaceId = clinicId || readWorkspaceId();
  const [plan] = useState<NegisPlan>(() => normalizePlan(readStored("negis_plan", "demo")));
  const [currentStep, setCurrentStep] = useState(1);
  const [brief, setBrief] = useState<Brief>(() => normalizeBriefCity(readStored("negis_ads_automation_brief", defaultBrief)));
  const [creative, setCreative] = useState<CreativeAsset | null>(null);
  const [aiPackage, setAiPackage] = useState<AiPackage | null>(null);
  const [compliance, setCompliance] = useState<ComplianceResult | null>(null);
  const [confirmations, setConfirmations] = useState<ConfirmationState>(confirmationDefaults);
  const [activeConfirmation, setActiveConfirmation] = useState("");
  const statusMode: "PAUSED" = "PAUSED";
  const [uiMode, setUiMode] = useState<UiMode>(() => (readStored<UiMode>("negis_ads_automation_ui_mode", "client") === "admin" ? "admin" : "client"));
  const [metaSummary, setMetaSummary] = useState<MetaSummary | null>(null);
  const [storageHealth, setStorageHealth] = useState<StorageHealth | null>(null);
  const [uploadDebug, setUploadDebug] = useState<UploadDebug | null>(null);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>("idle");
  const [uploadStage, setUploadStage] = useState("");
  const [lastUploadError, setLastUploadError] = useState("");
  const [liveLaunchEnabled, setLiveLaunchEnabled] = useState(() => readStored("negis_meta_live_launch_enabled", false));
  const [loading, setLoading] = useState<"health" | "storage" | "upload" | "ai" | "check" | "video" | "launch" | "history" | "thumbnail" | null>(null);
  const [creativeFile, setCreativeFile] = useState<File | null>(null);
  const [notice, setNotice] = useState("");
  const [launchResult, setLaunchResult] = useState<LaunchResult | null>(null);
  const [lastDryRunResult, setLastDryRunResult] = useState<LaunchResult | null>(null);
  const [launchTimestamp, setLaunchTimestamp] = useState("");
  const [realLaunchStatus, setRealLaunchStatus] = useState<RealLaunchStatus>("idle");
  const [realLaunchMessage, setRealLaunchMessage] = useState("");
  const [historyItems, setHistoryItems] = useState<LaunchHistoryItem[]>([]);
  const [historyVideoCheckId, setHistoryVideoCheckId] = useState("");
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const [historySearch, setHistorySearch] = useState("");
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [videoJob, setVideoJob] = useState<VideoJob | null>(null);
  const [videoConfigBlocked, setVideoConfigBlocked] = useState(false);
  const isHistoryView = location === "/ads-automation/history";
  const isAdminMode = uiMode === "admin";

  useEffect(() => {
    window.localStorage.setItem("negis_ads_automation_brief", JSON.stringify(brief));
  }, [brief]);

  useEffect(() => {
    window.localStorage.setItem("negis_ads_automation_ui_mode", JSON.stringify(uiMode));
  }, [uiMode]);

  useEffect(() => {
    void checkHealth();
  }, []);

  // Import a package handed off by AI Контент-студия (or legacy pages writing the
  // same key). Consume-once: the key is removed immediately so the import never
  // repeats. Nothing is launched or confirmed automatically.
  useEffect(() => {
    let raw = "";
    try {
      raw = window.localStorage.getItem(STUDIO_PREFILL_KEY) || "";
      if (!raw) return;
      window.localStorage.removeItem(STUDIO_PREFILL_KEY);
      const data = asRecord(JSON.parse(raw));

      const service = firstString(data.service, data.niche);
      const offer = firstString(data.offer);
      const audience = firstString(data.audience, data.targetAudience);
      const cityInput = firstString(data.cityId, data.city);
      const city = cityInput ? getKzMetaCityOption(cityInput) : null;
      setBrief((current) => ({
        ...current,
        service: service || current.service,
        offer: offer || current.offer,
        knownAudience: audience || current.knownAudience,
        ...(city && city.id
          ? { city: city.labelRu, cityId: city.id, cityLabelRu: city.labelRu, cityCanonicalName: city.canonicalName }
          : {}),
      }));

      const adText = firstString(data.adText, data.primaryText, data.caption, data.script);
      const headline = firstString(data.headline, data.hook, data.title);
      if (adText || headline) {
        const knownCtas = ["LEARN_MORE", "CONTACT_US", "CALL_NOW"];
        const ctaRaw = firstString(data.cta).toUpperCase();
        setAiPackage({
          campaignName: firstString(data.campaignName, data.title) || undefined,
          primaryText: adText || undefined,
          headline: headline || undefined,
          description: firstString(data.caption, data.offer) || undefined,
          cta: knownCtas.includes(ctaRaw) ? ctaRaw : "LEARN_MORE",
          audience: audience || undefined,
          generatedBy: "content-studio",
        });
        setCompliance(null);
      }

      // Restore a ready image creative from the studio's photo builder: the URL
      // points at the already-uploaded render in the public ad-creatives bucket.
      const creativeUrl = firstString(data.creativeUrl, data.imageUrl);
      if (creativeUrl && firstString(data.creativeType) !== "video") {
        setCreative({
          fileName: firstString(data.fileName) || "studio-creative.jpg",
          fileType: "image",
          mimeType: firstString(data.mimeType) || "image/jpeg",
          fileSize: Number(data.fileSize) || 0,
          previewUrl: creativeUrl,
          publicUrl: creativeUrl,
          status: "uploaded",
        });
        setCreativeFile(null);
        setVideoJob(null);
      }

      // Never pre-arm a launch from an import.
      setActiveConfirmation("");
      setLaunchResult(null);
      setLastDryRunResult(null);
      setNotice(STUDIO_PREFILL_NOTICE);
      toast.success("Данные из AI Контент-студии загружены");
    } catch {
      // A broken payload must never break the wizard; the key is already consumed.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isHistoryView) void loadHistory();
  }, [isHistoryView]);

  const videoJobPending = Boolean(videoJob && videoJob.status !== "ready" && videoJob.status !== "failed");

  const readCreativeReadiness = () =>
    getCreativeReadiness({
      creative,
      uploadStatus,
      loading,
      videoJobPending,
      lastUploadError,
      videoJob,
      videoOptimization: metaSummary?.videoOptimization || null,
      configBlocked: videoConfigBlocked,
    });

  useEffect(() => {
    if (!videoJob || videoJob.status === "ready" || videoJob.status === "failed") return;
    const timer = window.setInterval(() => {
      void pollVideoJob(videoJob.id);
    }, 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoJob?.id, videoJob?.status]);

  const destination = destinationOptions.find((item) => item.value === brief.leadDestination) || destinationOptions[0];
  const selectedCity = getKzMetaCityOption(brief.cityId || brief.city);
  const destinationUrl = aiPackage?.destinationUrl || publicDestinationUrl(brief);
  const clinicName = firstString(asRecord(user).workspaceName, asRecord(user).clinicName, "Concept Med");
  const previewAdText = firstString(compliance?.safeText, aiPackage?.primaryText, brief.offer);
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
  const updateSelectedCity = (cityId: string) => {
    const city = getKzMetaCityOption(cityId);
    setBrief((current) => ({
      ...current,
      city: city.labelRu,
      cityId: city.id,
      cityLabelRu: city.labelRu,
      cityCanonicalName: city.canonicalName,
    }));
    setLaunchResult(null);
    setCompliance(null);
  };
  const updateConfirmation = (key: keyof ConfirmationState, value: boolean) => {
    setConfirmations((current) => ({ ...current, [key]: value }));
  };

  function goToStep(step: number, options: { skipGuard?: boolean } = {}) {
    if (!options.skipGuard && clientStepForInternal(step) >= 3) {
      const previewGate = getPreviewReadiness({
        creativeReadiness: readCreativeReadiness(),
        brief,
        cityLabel: selectedCity.labelRu,
        adText: previewAdText,
        requireAdText: step >= 4,
      });
      if (!previewGate.isReady) {
        setNotice(previewGate.message);
        toast.warning(previewGate.message);
        return;
      }
    }
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
        setNotice("Загрузка проверена: файлы готовы для рекламы.");
        toast.success("Загрузка готова");
      } else {
        const message = body.data.hint || "Хранилище файлов требует проверки администратора.";
        setNotice(message);
        toast.warning(message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось проверить загрузку файлов.";
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
    const optimization = metaSummary?.videoOptimization;
    const maxVideoMb = optimization?.enabled ? optimization.maxInputMb || 500 : 100;
    if ((isVideo || allowedVideo) && file.size > maxVideoMb * 1024 * 1024) {
      details.push(
        optimization && optimization.enabled !== true
          ? VIDEO_OPTIMIZATION_DISABLED_TOO_LARGE_MESSAGE
          : `Видео больше ${maxVideoMb} MB. Загрузите файл меньшего размера.`,
      );
    }

    return details;
  }

  function applyVideoJobResult(job: VideoJob) {
    setCreative((current) =>
      current && current.fileType === "video"
        ? {
            ...current,
            // Only the optimized public URL ever reaches Meta — never the raw original.
            publicUrl: job.outputPublicUrl || current.publicUrl,
            // The worker always outputs an MP4 (H.264 + AAC); treat the ready creative as video/mp4.
            mimeType: job.outputPublicUrl ? job.outputMimeType || "video/mp4" : current.mimeType,
            thumbnailUrl: job.thumbnailPublicUrl || current.thumbnailUrl,
            thumbnailGeneratedAt: job.thumbnailPublicUrl ? new Date().toISOString() : current.thumbnailGeneratedAt,
            thumbnailSource: job.thumbnailSource || (job.thumbnailPublicUrl ? "worker" : current.thumbnailSource),
            thumbnailMimeType: job.thumbnailPublicUrl ? "image/jpeg" : current.thumbnailMimeType,
            status: "uploaded",
          }
        : current,
    );
    setNotice(`${VIDEO_OPTIMIZED_READY_MESSAGE}. Можно продолжать запуск.`);
    toast.success(VIDEO_OPTIMIZED_READY_MESSAGE);
  }

  async function pollVideoJob(jobId: string) {
    try {
      const body = await crmRequest<{ job?: Record<string, unknown> }>(
        `/api/crm/video-jobs?id=${encodeURIComponent(jobId)}&workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      const job = normalizeVideoJob(asRecord(body.data.job));
      if (!job || job.id !== jobId) return;
      const wasReady = videoJob?.status === "ready";
      setVideoJob(job);
      if (job.status === "ready" && !wasReady) {
        applyVideoJobResult(job);
      }
      if (job.status === "failed") {
        setNotice(friendlyCreativeError(job.error || VIDEO_OPTIMIZATION_FAILED_MESSAGE, creative));
        setLastUploadError(job.error || VIDEO_OPTIMIZATION_FAILED_MESSAGE);
        toast.error(VIDEO_OPTIMIZATION_FAILED_MESSAGE);
      }
    } catch {
      // Keep polling silently; transient network/API errors must not kill the job card.
    }
  }

  // Retry a failed optimization job via the lower-level job endpoint. It resets the
  // job to queued; the existing polling effect resumes automatically. Launch stays blocked.
  async function retryVideoJob(jobId: string) {
    if (!jobId) return;
    setLoading("video");
    try {
      const body = await crmRequest<{ job?: Record<string, unknown> }>(
        `/api/crm/video-processing-jobs/${encodeURIComponent(jobId)}/retry`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId, status: "failed" }),
        },
      );
      const job = normalizeVideoJob(asRecord(body.data.job));
      if (job) {
        setVideoJob(job);
        setLastUploadError("");
        setNotice(`${VIDEO_OPTIMIZING_BODY} ${VIDEO_OPTIMIZING_LAUNCH_AFTER_MESSAGE}`);
        toast.success("Обработка перезапущена");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : VIDEO_OPTIMIZATION_FAILED_MESSAGE);
    } finally {
      setLoading(null);
    }
  }

  async function uploadLargeVideo(file: File, optimizationDebug: Partial<UploadDebug> = {}) {
    setLoading("upload");
    setVideoJob(null);
    setCreativeFile(file);
    const previewUrl = URL.createObjectURL(file);
    try {
      if (!hasSupabaseFrontendEnv) {
        throw new Error("Для загрузки креативов нужны VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY в Vercel.");
      }

      setUploadStatus("getting_signed_url");
      setUploadStage("Создаём задачу оптимизации видео");
      const created = await crmRequest<{ job?: Record<string, unknown>; signedUpload?: SignedUploadData | null; assetId?: string }>(
        "/api/crm/video-jobs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            uploadedBy: user?.email || user?.user_metadata?.full_name || "Negis user",
            fileName: file.name,
            mimeType: file.type,
            fileSize: file.size,
          }),
        },
      );
      const createdJob = normalizeVideoJob(asRecord(created.data.job));
      const signedUpload = created.data.signedUpload || null;
      const storageBucket = firstString(signedUpload?.bucket, signedUpload?.storageBucket);
      const storagePath = firstString(signedUpload?.storagePath);
      const token = firstString(signedUpload?.token);
      if (!createdJob || !storageBucket || !storagePath || !token) {
        throw new Error("Сервер не вернул данные для загрузки исходного видео. Проверьте настройки Supabase и migration 016.");
      }

      setUploadStatus("uploading_to_storage");
      setUploadStage("Загружаем исходное видео в защищённое хранилище");
      const { error: uploadError } = await supabase.storage.from(storageBucket).uploadToSignedUrl(storagePath, token, file, {
        contentType: file.type || "video/mp4",
      });
      if (uploadError) {
        throw new Error(
          `Не удалось загрузить исходное видео в хранилище оптимизации: ${uploadError.message}. Проверьте общий лимит загрузки файлов в Supabase (Settings → Storage → Upload file size limit).`,
        );
      }

      setUploadStage("Подтверждаем загрузку исходника");
      const patched = await crmRequest<{ job?: Record<string, unknown> }>("/api/crm/video-jobs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: createdJob.id, workspaceId, rawSize: file.size }),
      });
      const queuedJob = normalizeVideoJob(asRecord(patched.data.job)) || { ...createdJob, status: "queued" as VideoJobStatus };

      setCreative({
        id: firstString(created.data.assetId) || undefined,
        fileName: file.name,
        fileType: "video",
        mimeType: file.type,
        fileSize: file.size,
        previewUrl,
        // publicUrl stays empty until the worker publishes the optimized MP4 —
        // the raw original has no public URL and must never be sent to Meta.
        publicUrl: "",
        status: "optimizing",
      });
      setVideoJob(queuedJob);
      setUploadDebug({
        ...optimizationDebug,
        assetId: firstString(created.data.assetId) || undefined,
        fileName: file.name,
        fileType: "video",
        uploadMode: "video_job_signed_url",
        signedUpload: true,
        storagePath,
        storagePathExists: true,
        publicUrlExists: false,
        publicUrlPreview: "",
        uploadStage: VIDEO_OPTIMIZING_MESSAGE,
        // The raw bucket name comes from the server response — the UI never hardcodes it.
        uploadTarget: storageBucket,
        responseKeys: uploadResponseKeys({ job: created.data.job, signedUpload }),
      });
      setUploadStatus("uploading_to_storage");
      setUploadStage(VIDEO_OPTIMIZING_MESSAGE);
      setNotice(`${VIDEO_OPTIMIZING_MESSAGE} ${VIDEO_OPTIMIZING_LAUNCH_BLOCKED_MESSAGE}`);
      toast.success("Видео загружено, оптимизация запущена");
    } catch (error) {
      const message = error instanceof Error ? error.message : VIDEO_OPTIMIZATION_FAILED_MESSAGE;
      setCreative({
        fileName: file.name,
        fileType: "video",
        mimeType: file.type,
        fileSize: file.size,
        previewUrl,
        publicUrl: "",
        status: "failed",
      });
      // Mark the failure as an optimization-branch failure so the readiness card
      // reports optimization_failed instead of the direct-upload too-large state.
      setVideoJob({ id: "local-failed", status: "failed", error: message });
      setUploadStatus("failed");
      setUploadStage(uploadStatusLabel("failed"));
      setLastUploadError(message);
      setUploadDebug({
        ...optimizationDebug,
        fileName: file.name,
        fileType: "video",
        uploadMode: "video_job_signed_url",
        publicUrlExists: false,
        uploadStage: uploadStatusLabel("failed"),
        lastError: message,
        responseKeys: ["error"],
      });
      setNotice(message);
      toast.error(VIDEO_OPTIMIZATION_FAILED_MESSAGE);
    } finally {
      setLoading(null);
    }
  }

  async function uploadVideoThumbnail(
    capture: VideoThumbnailCapture,
    sourceFileName: string,
  ): Promise<{ publicUrl: string; generatedAt: string; mimeType: string } | null> {
    try {
      const baseName = sourceFileName.replace(/\.[^.]+$/, "") || "video";
      const thumbnailFileName = `${baseName}-thumbnail.jpg`;
      const signedBody = await crmRequest<SignedUploadData>("/api/crm/ad-creatives/signed-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          fileName: thumbnailFileName,
          fileType: "image",
          mimeType: capture.mimeType,
          fileSize: capture.blob.size,
        }),
      });
      const storageBucket = firstString(signedBody.data.bucket, signedBody.data.storageBucket, "ad-creatives");
      const storagePath = firstString(signedBody.data.storagePath);
      const token = firstString(signedBody.data.token);
      const thumbnailPublicUrl = firstString(signedBody.data.publicUrl) || buildFrontendStoragePublicUrl(storagePath, storageBucket);
      if (!storagePath || !token || !thumbnailPublicUrl) return null;
      const { error: uploadError } = await supabase.storage.from(storageBucket).uploadToSignedUrl(storagePath, token, capture.blob, {
        contentType: capture.mimeType,
      });
      if (uploadError) return null;
      return { publicUrl: thumbnailPublicUrl, generatedAt: new Date().toISOString(), mimeType: capture.mimeType };
    } catch {
      return null;
    }
  }

  async function regenerateThumbnail() {
    if (!creative || creative.fileType !== "video") return;
    if (!creativeFile) {
      setNotice("Исходный файл видео недоступен в этой сессии. Загрузите видео заново, чтобы создать обложку.");
      return;
    }
    setLoading("thumbnail");
    try {
      const capture = await captureVideoThumbnail(creativeFile);
      const thumbnail = capture ? await uploadVideoThumbnail(capture, creativeFile.name) : null;
      if (!thumbnail) {
        setNotice(THUMBNAIL_FAILED_MESSAGE);
        toast.error(THUMBNAIL_FAILED_MESSAGE);
        return;
      }
      setCreative((current) =>
        current
          ? {
              ...current,
              thumbnailUrl: thumbnail.publicUrl,
              thumbnailGeneratedAt: thumbnail.generatedAt,
              thumbnailSource: "auto_frame",
              thumbnailMimeType: thumbnail.mimeType,
            }
          : current,
      );
      if (creative.id) {
        try {
          await crmRequest("/api/crm/ad-creatives", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              workspaceId,
              id: creative.id,
              metadata: {
                source: "ads-automation",
                uploadMode: "signed_url",
                signedUpload: true,
                thumbnailUrl: thumbnail.publicUrl,
                thumbnailGeneratedAt: thumbnail.generatedAt,
                thumbnailSource: "auto_frame",
                thumbnailMimeType: thumbnail.mimeType,
              },
            }),
          });
        } catch {
          // Local state keeps the thumbnail; metadata sync is best-effort.
        }
      }
      setNotice("");
      toast.success("Обложка видео создана заново");
    } finally {
      setLoading(null);
    }
  }

  async function uploadCreative(file: File) {
    setUploadStatus("validating");
    setUploadStage(uploadStatusLabel("validating"));
    setLastUploadError("");
    setUploadDebug(null);
    const fileType = inferCreativeFileType(file);
    const isMovVideo = fileType === "video" && (file.type === "video/quicktime" || file.name.toLowerCase().endsWith(".mov"));

    // Large-video branch decision. All "MB" here means MiB (1024*1024 bytes),
    // consistently with the server-side limits and the bucket file_size_limit.
    const optimization = metaSummary?.videoOptimization;
    const optimizationThresholdMb = optimization?.thresholdMb || 50;
    const optimizationThresholdBytes = optimizationThresholdMb * 1024 * 1024;
    const fileSizeMb = Number((file.size / (1024 * 1024)).toFixed(1));
    const exceedsThreshold = fileType === "video" && file.size > optimizationThresholdBytes;
    const optimizationDebug: Partial<UploadDebug> = {
      videoOptimizationLoaded: Boolean(optimization),
      videoOptimizationEnabled: Boolean(optimization?.enabled),
      videoOptimizationThresholdMb: optimizationThresholdMb,
      videoOptimizationMaxInputMb: optimization?.maxInputMb || 500,
      fileSizeMb,
      largeVideoBranch: exceedsThreshold && optimization?.enabled === true,
      uploadTarget: "ad-creatives",
    };

    // A large video must never silently fall back to the direct ad-creatives upload.
    // If the optimization config has not arrived from /api/crm/health yet, block and refresh.
    setVideoConfigBlocked(false);
    if (exceedsThreshold && !optimization) {
      setUploadStatus("idle");
      setUploadStage("");
      setVideoConfigBlocked(true);
      setNotice(VIDEO_OPTIMIZATION_CONFIG_LOADING_MESSAGE);
      toast.error(VIDEO_OPTIMIZATION_CONFIG_LOADING_MESSAGE);
      void checkHealth();
      return;
    }

    if (exceedsThreshold && optimization?.enabled !== true) {
      const previewUrl = URL.createObjectURL(file);
      const message = `${VIDEO_NEEDS_OPTIMIZATION_MESSAGE} ${VIDEO_OPTIMIZATION_NEXT_STEP_MESSAGE} ${VIDEO_OPTIMIZATION_DISABLED_TOO_LARGE_MESSAGE}`;
      setCreativeFile(file);
      setVideoJob(null);
      setCreative({
        fileName: file.name,
        fileType: "video",
        mimeType: file.type,
        fileSize: file.size,
        previewUrl,
        publicUrl: "",
        status: "needs_optimization",
      });
      setUploadStatus("idle");
      setUploadStage("Видео нужно оптимизировать");
      setLastUploadError(message);
      setUploadDebug({
        ...optimizationDebug,
        fileName: file.name,
        fileType: "video",
        uploadMode: "video_optimization_required",
        signedUpload: false,
        storagePathExists: false,
        publicUrlExists: false,
        publicUrlPreview: "",
        uploadStage: "needs_optimization",
        lastError: message,
        responseKeys: ["localFile", "videoOptimization"],
      });
      setNotice(message);
      toast.warning("Видео нужно оптимизировать");
      return;
    }

    const details = validateFile(file);
    if (details.length > 0) {
      const message = details.join(" ");
      const friendlyMessage = friendlyCreativeError(message, { fileName: file.name, fileType, mimeType: file.type, fileSize: file.size, previewUrl: "", status: "failed" });
      setUploadStatus("failed");
      setUploadStage(uploadStatusLabel("failed"));
      setLastUploadError(message);
      setNotice(friendlyMessage);
      toast.error(friendlyMessage);
      return;
    }

    const largeVideoBranch = exceedsThreshold && optimization?.enabled === true;

    if (largeVideoBranch) {
      await uploadLargeVideo(file, optimizationDebug);
      return;
    }
    setVideoJob(null);

    setLoading("upload");
    setNotice(isMovVideo ? MOV_VIDEO_WARNING : "");
    if (isMovVideo) toast.warning(MOV_VIDEO_WARNING);
    setCreativeFile(file);
    const previewUrl = URL.createObjectURL(file);
    let publicUrl = "";
    let storagePath = "";
    type UploadResponse = Partial<CreativeAsset> & { asset?: unknown; item?: unknown };
    let signedUpload: SignedUploadData | null = null;
    let lastError = "";
    let thumbnail: { publicUrl: string; generatedAt: string; mimeType: string } | null = null;
    let thumbnailWarning = "";

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

      // Auto-generate a video thumbnail: Meta requires image_url inside video_data,
      // and the clinic must not have to upload a separate cover image manually.
      if (fileType === "video") {
        setUploadStage("Создаём обложку видео автоматически");
        const capture = await captureVideoThumbnail(file);
        thumbnail = capture ? await uploadVideoThumbnail(capture, file.name) : null;
        if (!thumbnail) {
          thumbnailWarning = THUMBNAIL_FAILED_MESSAGE;
          toast.warning(THUMBNAIL_FAILED_MESSAGE);
        }
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
        thumbnailUrl: thumbnail?.publicUrl,
        thumbnailGeneratedAt: thumbnail?.generatedAt,
        thumbnailSource: thumbnail ? "auto_frame" : undefined,
        thumbnailMimeType: thumbnail?.mimeType,
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
            ...(thumbnail
              ? {
                  thumbnailUrl: thumbnail.publicUrl,
                  thumbnailGeneratedAt: thumbnail.generatedAt,
                  thumbnailSource: "auto_frame",
                  thumbnailMimeType: thumbnail.mimeType,
                }
              : {}),
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
            ...optimizationDebug,
            uploadMode: "signed_url",
            signedUpload: true,
            uploadStage: uploadStatusLabel("ready"),
          },
        ),
      );
      toast.success(fileType === "video" ? "Видео загружено" : "Фото загружено");
      const uploadedReadiness = getCreativeReadiness({ creative: uploadedAsset, uploadStatus: "ready", loading: null, videoJobPending: false, lastUploadError: "" });
      if (uploadedReadiness.isReadyForMeta) goToStep(2);
      setNotice([uploadedReadiness.clientMessage, thumbnailWarning].filter(Boolean).join(" "));
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
        thumbnailUrl: thumbnail?.publicUrl,
        thumbnailGeneratedAt: thumbnail?.generatedAt,
        thumbnailSource: thumbnail ? "auto_frame" : undefined,
        thumbnailMimeType: thumbnail?.mimeType,
        status: "failed",
      };
      setUploadStatus("failed");
      setUploadStage(uploadStatusLabel("failed"));
      setLastUploadError(lastError);
      setCreative(fallback);
      setUploadDebug({
        ...optimizationDebug,
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
      setNotice(friendlyCreativeError(lastError, fallback));
    } finally {
      setLoading(null);
    }
  }

  function removeCreative() {
    if (creative?.previewUrl.startsWith("blob:")) URL.revokeObjectURL(creative.previewUrl);
    setCreative(null);
    setCreativeFile(null);
    setVideoJob(null);
    setVideoConfigBlocked(false);
    setAiPackage(null);
    setCompliance(null);
    setLaunchResult(null);
    setUploadDebug(null);
    setUploadStage("");
    setUploadStatus("idle");
    setLastUploadError("");
  }

  async function fillWithAi() {
    const readiness = readCreativeReadiness();
    if (!readiness.isReadyForMeta) {
      setNotice(readiness.clientMessage);
      toast.error("Креатив ещё не готов");
      goToStep(1);
      return;
    }
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
          city: selectedCity.labelRu,
          selectedCityId: selectedCity.id,
          selectedCityLabelRu: selectedCity.labelRu,
          selectedCityCanonicalName: selectedCity.canonicalName,
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
      setLaunchTimestamp("");
      goToStep(5, { skipGuard: true });
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

  function repeatLaunchFromHistory(item: LaunchHistoryItem) {
    const payload = asRecord(item.payload);
    const city = getKzMetaCityOption(firstString(payload.selectedCityId, payload.city) || brief.cityId);
    const landingUrl = firstString(payload.landingUrl);
    const storedDestination = firstString(payload.leadDestination);
    const knownDestinations: LeadDestination[] = ["whatsapp", "instagram_profile", "website", "lead_form", "call"];
    const inferredDestination: LeadDestination = landingUrl.includes("wa.me")
      ? "whatsapp"
      : landingUrl.includes("instagram.com")
        ? "instagram_profile"
        : landingUrl.startsWith("tel:")
          ? "call"
          : "website";
    const leadDestination = knownDestinations.includes(storedDestination as LeadDestination)
      ? (storedDestination as LeadDestination)
      : landingUrl
        ? inferredDestination
        : brief.leadDestination;
    const destinationValue =
      firstString(payload.destinationValue) ||
      (leadDestination === "whatsapp" && landingUrl.includes("wa.me/") ? `+${landingUrl.split("wa.me/")[1]}` : "") ||
      (landingUrl && leadDestination !== "lead_form" ? landingUrl : "") ||
      brief.destinationValue;
    const dailyBudget = item.budgetDailyMinor
      ? String(Math.round(item.budgetDailyMinor / 100))
      : firstString(payload.dailyBudget) || brief.dailyBudget;

    setBrief((current) => ({
      ...current,
      service: firstString(payload.service) || current.service,
      city: city.labelRu,
      cityId: city.id,
      cityLabelRu: city.labelRu,
      cityCanonicalName: city.canonicalName,
      leadDestination,
      destinationValue,
      dailyBudget,
      offer: firstString(payload.offer) || current.offer,
      knownAudience: firstString(payload.targetAudience, payload.knownAudience) || current.knownAudience,
      // Dates are intentionally reset to fresh defaults — the old launch window is in the past.
      startDate: tomorrow,
      endDate: "",
    }));

    // Restore the creative from its stored public URL when possible; metaVideoId and thumbnail
    // are reused so the video is not uploaded to Meta a second time.
    const creativeUrl = firstString(payload.creativeUrl, payload.videoUrl, payload.imageUrl);
    const restoredFileType = firstString(payload.creativeType, payload.fileType) === "video" ? "video" : "image";
    if (creativeUrl) {
      const restoredVideoId = firstString(item.metaVideoId, payload.metaVideoId);
      setCreative({
        id: firstString(payload.sourceId) || undefined,
        fileName: firstString(payload.fileName) || (restoredFileType === "video" ? "video.mp4" : "photo.jpg"),
        fileType: restoredFileType,
        mimeType: firstString(payload.mimeType),
        fileSize: Number(payload.fileSize) || 0,
        previewUrl: creativeUrl,
        publicUrl: creativeUrl,
        metaVideoId: restoredVideoId && !isDryRunMetaId(restoredVideoId) ? restoredVideoId : undefined,
        videoProcessingStatus: firstString(payload.videoProcessingStatus) || undefined,
        thumbnailUrl: firstString(payload.thumbnailUrl) || undefined,
        thumbnailSource: firstString(payload.thumbnailSource) || undefined,
        status: "uploaded",
      });
    } else {
      setCreative(null);
    }
    setCreativeFile(null);

    // Only prefill — never auto-launch: the AI package, safety check, and every
    // confirmation checkbox must be walked through again by the employee.
    setAiPackage(null);
    setCompliance(null);
    setLaunchResult(null);
    setLastDryRunResult(null);
    setConfirmations(confirmationDefaults);
    setRealLaunchStatus("idle");
    setRealLaunchMessage("");
    setActiveConfirmation("");
    setLaunchTimestamp("");
    setUploadDebug(null);
    setUploadStage("");
    setUploadStatus("idle");
    setLocation("/ads-automation");
    goToStep(creativeUrl ? 2 : 1);
    setNotice("Параметры перенесены из истории. Проверьте шаги, пройдите проверку безопасности и запустите заново — автозапуска нет.");
    toast.success("Параметры перенесены из истории");
  }

  function startNewLaunch() {
    removeCreative();
    setLastDryRunResult(null);
    setConfirmations(confirmationDefaults);
    setRealLaunchStatus("idle");
    setRealLaunchMessage("");
    setNotice("");
    setLaunchTimestamp("");
    goToStep(1);
  }

  function buildLaunchPayload(dryRun: boolean, forcedStatusMode: "PAUSED" | "ACTIVE" = statusMode) {
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
      city: selectedCity.labelRu,
      selectedCityId: selectedCity.id,
      selectedCityLabelRu: selectedCity.labelRu,
      selectedCityCanonicalName: selectedCity.canonicalName,
      offer: brief.offer,
      campaignName: aiPackage?.campaignName || `${brief.service} - ${selectedCity.labelRu}`,
      launchTimestamp,
      objective: aiPackage?.objective || "OUTCOME_LEADS",
      statusMode: forcedStatusMode,
      dailyBudget: Number(brief.dailyBudget),
      totalBudget,
      currency: "USD",
      targetAudience: aiPackage?.audience || brief.knownAudience,
      primaryText: text || "",
      headline: aiPackage?.headline || `${brief.service} в ${selectedCity.labelRu}`,
      description: aiPackage?.description || brief.offer,
      cta: aiPackage?.cta || "LEARN_MORE",
      landingUrl: destinationUrl,
      imageUrl: creative?.fileType === "image" ? creativeUrl : "",
      creativeType: creative?.fileType || "image",
      creativeUrl,
      videoUrl: creative?.fileType === "video" ? creativeUrl : "",
      videoId: creative?.metaVideoId || "",
      metaVideoId: creative?.metaVideoId || "",
      thumbnailUrl: creative?.fileType === "video" ? creative?.thumbnailUrl || "" : "",
      thumbnailSource: creative?.fileType === "video" ? creative?.thumbnailSource || "" : "",
      // Optimized-video metadata (worker output). Never carries raw bucket/path/URL.
      optimized: creative?.fileType === "video" && videoJob?.status === "ready",
      optimizedOutputSizeBytes: creative?.fileType === "video" ? videoJob?.outputSizeBytes || 0 : 0,
      optimizedCompressionRatio: creative?.fileType === "video" ? videoJob?.compressionRatio || 0 : 0,
      fileName: creative?.fileName || "",
      fileType: creative?.fileType || "image",
      mimeType: creative?.mimeType || "",
      fileSize: creative?.fileSize || 0,
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
      const result = { ...body.data, warning: body.warning || body.data.warning };
      setLaunchResult(result);
      setLastDryRunResult(result);
      setLaunchTimestamp(firstString(result.launchTimestamp, asRecord(result.metaPayload).launchTimestamp, launchTimestamp));
      setRealLaunchStatus("idle");
      setRealLaunchMessage("");
      goToStep(stayOnLaunchStep ? 6 : 5);
      toast.success(stayOnLaunchStep ? "Проверка прошла без запуска" : "Проверка безопасности готова");
      setNotice(
        [
          body.warning || (stayOnLaunchStep ? "Проверка прошла без запуска. Кампания в Meta не создавалась." : ""),
          videoJobPending ? VIDEO_OPTIMIZING_LAUNCH_BLOCKED_MESSAGE : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
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
    const readiness = readCreativeReadiness();
    const previewGate = getPreviewReadiness({
      creativeReadiness: readiness,
      brief,
      cityLabel: selectedCity.labelRu,
      adText: previewAdText,
    });

    if (!creative) errors.push("Добавьте фото или видео.");
    if (creative && !readiness.isReadyForMeta) errors.push(readiness.clientMessage);
    if (!previewGate.isReady) errors.push(previewGate.message);
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
    if (videoJobPending) errors.push(VIDEO_OPTIMIZING_LAUNCH_BLOCKED_MESSAGE);
    if (videoJob?.status === "failed") errors.push(VIDEO_OPTIMIZATION_FAILED_MESSAGE);
    if (creative?.fileType === "video" && !metaSummary?.videoLaunchEnabled) errors.push(VIDEO_REAL_LAUNCH_DISABLED_MESSAGE);
    if (creative?.fileType === "video" && metaSummary?.videoLaunchEnabled && !isMetaVideoFormatSupported(creative)) errors.push(VIDEO_FORMAT_ERROR);
    if (nextStatusMode === "ACTIVE") {
      if (!liveLaunchEnabled) errors.push("ACTIVE запуск выключен в Admin Center.");
      if (!["owner", "admin", "manager"].includes(userRole || "")) errors.push("ACTIVE запуск доступен только owner/admin/manager.");
      if (activeConfirmation.trim().toUpperCase() !== "ЗАПУСТИТЬ") errors.push("Для ACTIVE введите ЗАПУСТИТЬ.");
    }
    return Array.from(new Set(errors));
  }

  async function ensureVideoReady(): Promise<string> {
    if (!creative || creative.fileType !== "video") return "";
    // Reuse the stored video_id: if Meta already confirmed it is ready, no API call is needed;
    // otherwise the server re-checks processing status for the same video_id instead of uploading again.
    if (creative.metaVideoId && isVideoStatusReady(creative.videoProcessingStatus)) return creative.metaVideoId;
    if (!creative.metaVideoId && !creative.publicUrl) throw new Error(uploadLinkMissingMessage(storageHealth));

    setLoading("video");
    try {
      const body = await crmRequest<{
        metaVideoId?: string;
        videoId?: string;
        uploadMode?: string;
        videoReady?: boolean;
        processingStatus?: string;
        lastCheckedAt?: string;
        warnings?: string[];
      }>("/api/crm/ad-creative-meta-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          assetId: creative.id,
          fileName: creative.fileName,
          fileType: creative.fileType,
          mimeType: creative.mimeType,
          publicUrl: creative.publicUrl,
          metaVideoId: creative.metaVideoId || "",
        }),
      });
      const metaVideoId = body.data.metaVideoId || body.data.videoId || "";
      if (!metaVideoId) throw new Error("Meta не вернула video_id.");
      const warnings = Array.isArray(body.data.warnings) ? body.data.warnings : [];
      const videoReady = body.data.videoReady !== false;
      const processingStatus = body.data.processingStatus || (videoReady ? "ready" : "processing");
      setCreative((current) =>
        current
          ? {
              ...current,
              metaVideoId,
              videoUploadMode: body.data.uploadMode || current.videoUploadMode,
              videoProcessingStatus: processingStatus,
              videoWarnings: uniqueStrings([...(current.videoWarnings || []), ...warnings]),
              status: videoReady ? "meta_uploaded" : "meta_processing",
            }
          : current,
      );
      if (warnings.length) setNotice(warnings.join(" "));
      if (!videoReady) throw new VideoProcessingPendingError(metaVideoId, processingStatus);
      return metaVideoId;
    } catch (error) {
      // Older/error responses report pending processing as a video_processing error with the
      // video_id in the payload — keep that id so the next attempt does not upload again.
      if (error instanceof CrmError) {
        const metaError = asRecord(error.data.metaError);
        const debug = asRecord(metaError.debug);
        const pendingVideoId = firstString(error.data.metaVideoId, error.data.videoId, debug.videoId);
        const isPendingProcessing = firstString(error.data.status) === "video_processing" || firstString(metaError.step) === "video_processing";
        if (pendingVideoId && isPendingProcessing) {
          const processingStatus = firstString(error.data.processingStatus, debug.status) || "processing";
          setCreative((current) =>
            current
              ? {
                  ...current,
                  metaVideoId: pendingVideoId,
                  videoProcessingStatus: processingStatus,
                  status: "meta_processing",
                }
              : current,
          );
          throw new VideoProcessingPendingError(pendingVideoId, processingStatus);
        }
      }
      throw error;
    } finally {
      setLoading(null);
    }
  }

  function saveLocalLaunch(result: LaunchResult, nextStatusMode: "PAUSED" | "ACTIVE", statusOverride?: string) {
    const key = localHistoryKey(workspaceId);
    const current = readStored<LaunchHistoryItem[]>(key, []);
    const metaPayload = asRecord(result.metaPayload);
    const campaignPayload = asRecord(metaPayload.campaign);
    const adSetPayload = asRecord(metaPayload.adSet);
    const creativePayload = asRecord(metaPayload.creative);
    const adPayload = asRecord(metaPayload.ad);
    const launchPayload = asRecord(result.launch);
    const resolvedTimestamp = firstString(result.launchTimestamp, metaPayload.launchTimestamp, launchPayload.launchTimestamp);
    const item: LaunchHistoryItem = {
      id: result.launchId || `local-${Date.now()}`,
      campaignName: firstString(campaignPayload.name, launchPayload.campaignName, aiPackage?.campaignName),
      launchTimestamp: resolvedTimestamp,
      status: statusOverride || (nextStatusMode === "ACTIVE" ? "active" : "paused"),
      metaCampaignId: result.metaCampaignId,
      metaAdSetId: result.metaAdSetId,
      metaCreativeId: result.metaCreativeId,
      metaAdId: result.metaAdId,
      metaVideoId: result.metaVideoId || result.videoId || creative?.metaVideoId,
      metaStatus: result.metaStatus || statusOverride?.toUpperCase() || nextStatusMode,
      budgetDailyMinor: Math.round(Number(brief.dailyBudget || 0) * 100),
      currency: "USD",
      launchedBy: user?.email || "Negis user",
      createdAt: new Date().toISOString(),
      payload: {
        creativeType: creative?.fileType,
        fileName: creative?.fileName,
        mimeType: creative?.mimeType,
        fileSize: creative?.fileSize,
        creativeUrl: creative?.publicUrl,
        sourceId: creative?.id,
        service: brief.service,
        offer: brief.offer,
        destinationValue: brief.destinationValue,
        landingUrl: destinationUrl,
        dailyBudget: brief.dailyBudget,
        targetAudience: aiPackage?.audience || brief.knownAudience,
        metaVideoId: result.metaVideoId || result.videoId || creative?.metaVideoId,
        videoUploadMode: result.videoUploadMode || creative?.videoUploadMode,
        videoProcessingStatus: result.videoProcessingStatus || creative?.videoProcessingStatus,
        lastCheckedAt: result.lastCheckedAt,
        thumbnailUrl: creative?.fileType === "video" ? creative?.thumbnailUrl : undefined,
        thumbnailSource: creative?.fileType === "video" ? creative?.thumbnailSource : undefined,
        // Optimized-video metadata for history. Raw bucket/path/URL are never stored.
        optimized: creative?.fileType === "video" ? videoJob?.status === "ready" : undefined,
        optimizedOutputSizeBytes: creative?.fileType === "video" ? videoJob?.outputSizeBytes : undefined,
        optimizedCompressionRatio: creative?.fileType === "video" ? videoJob?.compressionRatio : undefined,
        videoWarnings: uniqueStrings([...(creative?.videoWarnings || []), ...(result.videoWarnings || [])]),
        city: selectedCity.labelRu,
        selectedCityId: selectedCity.id,
        leadDestination: brief.leadDestination,
        launchTimestamp: resolvedTimestamp,
        campaignName: firstString(campaignPayload.name),
        adSetName: firstString(adSetPayload.name),
        creativeName: firstString(creativePayload.name),
        adName: firstString(adPayload.name),
        placementsMode: firstString(adSetPayload.placementsMode, asRecord(adSetPayload.targetingDebug).placementsMode),
      },
      metaResponse: asRecord(result),
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

    if (creative?.fileType === "video" && !metaSummary?.videoLaunchEnabled) {
      setNotice(VIDEO_REAL_LAUNCH_DISABLED_MESSAGE);
      setRealLaunchStatus("failed");
      setRealLaunchMessage(VIDEO_REAL_LAUNCH_DISABLED_MESSAGE);
      toast.error(VIDEO_REAL_LAUNCH_DISABLED_MESSAGE);
      return;
    }

    setLoading("launch");
    setNotice("");
    setLaunchResult(null);
    setRealLaunchStatus("creating");
    setRealLaunchMessage(nextStatusMode === "ACTIVE" ? "Создаём и запускаем кампанию в Meta." : "Создаём кампанию в Meta выключенной.");
    try {
      let metaVideoId = creative?.metaVideoId || "";
      if (creative?.fileType === "video") {
        metaVideoId = await ensureVideoReady();
        setLoading("launch");
        setRealLaunchMessage(nextStatusMode === "ACTIVE" ? "Создаём и запускаем кампанию в Meta." : "Создаём кампанию в Meta выключенной.");
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
      if (body.data.status === "video_processing") {
        const pendingVideoId = body.data.metaVideoId || body.data.videoId || metaVideoId;
        if (pendingVideoId) {
          setCreative((current) =>
            current && current.fileType === "video"
              ? { ...current, metaVideoId: pendingVideoId, videoProcessingStatus: body.data.videoProcessingStatus || "processing", status: "meta_processing" }
              : current,
          );
        }
        saveLocalLaunch(body.data, nextStatusMode, "video_processing");
        setRealLaunchStatus("video_processing");
        setRealLaunchMessage(VIDEO_PROCESSING_PENDING_MESSAGE);
        toast.info(VIDEO_PROCESSING_PENDING_MESSAGE);
        return;
      }
      setLaunchResult({ ...body.data, warning: body.warning || body.data.warning });
      const launchedMetaVideoId = body.data.metaVideoId || body.data.videoId || metaVideoId;
      if (creative?.fileType === "video" && launchedMetaVideoId) {
        setCreative((current) =>
          current
            ? {
                ...current,
                metaVideoId: launchedMetaVideoId,
                videoUploadMode: body.data.videoUploadMode || current.videoUploadMode,
                videoProcessingStatus: body.data.videoProcessingStatus || current.videoProcessingStatus,
                videoWarnings: uniqueStrings([...(current.videoWarnings || []), ...(body.data.videoWarnings || [])]),
                status: "meta_uploaded",
              }
            : current,
        );
      }
      setCompliance(body.data.compliance || compliance);
      saveLocalLaunch(body.data, nextStatusMode);
      setLaunchTimestamp("");
      setRealLaunchStatus("created");
      setRealLaunchMessage(nextStatusMode === "ACTIVE" ? "Реклама создана и запущена в Meta." : "Кампания создана в Meta выключенной.");
      goToStep(6);
      toast.success(nextStatusMode === "ACTIVE" ? "Реклама запущена" : "Кампания создана выключенной");
      if (body.warning) setNotice(body.warning);
    } catch (error) {
      if (error instanceof VideoProcessingPendingError) {
        // Not a failure: Meta accepted the video and is still processing it.
        saveLocalLaunch(
          {
            metaVideoId: error.metaVideoId,
            videoId: error.metaVideoId,
            videoProcessingStatus: error.processingStatus,
            lastCheckedAt: new Date().toISOString(),
            metaStatus: "VIDEO_PROCESSING",
          },
          nextStatusMode,
          "video_processing",
        );
        setRealLaunchStatus("video_processing");
        setRealLaunchMessage(VIDEO_PROCESSING_PENDING_MESSAGE);
        setNotice("");
        toast.info(VIDEO_PROCESSING_PENDING_MESSAGE);
        return;
      }
      const message = error instanceof Error ? error.message : "Не удалось создать рекламу в Meta.";
      setNotice(message);
      setRealLaunchStatus("failed");
      setRealLaunchMessage(message);
      toast.error(message);
    } finally {
      setLoading(null);
    }
  }

  async function loadHistory() {
    const local = readStored<LaunchHistoryItem[]>(localHistoryKey(workspaceId), []);
    setHistoryItems(mergeHistoryCollections(local, []));
    setLoading("history");
    setNotice("");
    try {
      const body = await crmRequest<{ launches?: LaunchHistoryItem[]; items?: LaunchHistoryItem[] }>(`/api/crm/meta-launches?workspaceId=${encodeURIComponent(workspaceId)}`);
      const remote = body.data.launches || body.data.items || [];
      setHistoryItems(mergeHistoryCollections(local, remote));
    } catch (error) {
      const fallbackMessage = local.length
        ? "Не удалось обновить историю. Показываем запуски, сохранённые на этом устройстве."
        : "История запусков временно недоступна. Попробуйте обновить страницу позже.";
      setNotice(isAdminMode && error instanceof Error ? `${fallbackMessage} ${error.message}` : fallbackMessage);
    } finally {
      setHistoryLoaded(true);
      setLoading(null);
    }
  }

  async function recheckHistoryVideo(item: LaunchHistoryItem) {
    const payload = asRecord(item.payload);
    const metaResponse = asRecord(item.metaResponse);
    const videoId = firstString(item.metaVideoId, payload.metaVideoId, metaResponse.videoId, metaResponse.metaVideoId);
    if (!videoId || isDryRunMetaId(videoId)) return;
    const checkId = item.id || videoId;
    setHistoryVideoCheckId(checkId);
    try {
      const body = await crmRequest<{ videoReady?: boolean; processingStatus?: string; lastCheckedAt?: string }>("/api/crm/ad-creative-meta-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          assetId: firstString(payload.sourceId),
          fileType: "video",
          fileName: firstString(payload.fileName, "negis-video.mp4"),
          mimeType: firstString(payload.mimeType, "video/mp4"),
          metaVideoId: videoId,
        }),
      });
      const videoReady = body.data.videoReady === true;
      const processingStatus = firstString(body.data.processingStatus) || (videoReady ? "ready" : "processing");
      const lastCheckedAt = firstString(body.data.lastCheckedAt) || new Date().toISOString();
      const patchPayload = (entry: LaunchHistoryItem): LaunchHistoryItem => ({
        ...entry,
        payload: { ...asRecord(entry.payload), videoProcessingStatus: processingStatus, lastCheckedAt },
      });
      setHistoryItems((items) => items.map((entry) => (entry === item ? patchPayload(entry) : entry)));
      const key = localHistoryKey(workspaceId);
      const stored = readStored<LaunchHistoryItem[]>(key, []);
      if (item.id && stored.some((entry) => entry.id === item.id)) {
        window.localStorage.setItem(key, JSON.stringify(stored.map((entry) => (entry.id === item.id ? patchPayload(entry) : entry))));
      }
      if (videoReady) {
        toast.success("Видео в Meta готово. Можно создавать объявление.");
      } else {
        toast.info(VIDEO_PROCESSING_PENDING_MESSAGE);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось проверить готовность видео.");
    } finally {
      setHistoryVideoCheckId("");
    }
  }

  function renderCreativeStep() {
    const videoFeature = getPlanFeature(plan, "video_ads_launch");
    const readiness = readCreativeReadiness();
    const uploadProblem = readiness.clientMessage;
    const creativeCanContinue = readiness.isReadyForMeta;

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
                <p className="mt-2 text-xs font-bold text-[#64748B]">{VIDEO_REQUIREMENTS_MESSAGE}</p>
                {uploadStage ? <p className="mt-2 text-sm font-black text-[#0D9488]">{uploadStage}</p> : null}
              </div>
            </button>
            <div className="mt-5 flex flex-col gap-2 sm:items-end">
              <button type="button" className="neu-btn-primary justify-center opacity-60" disabled>
                Дальше к параметрам
              </button>
              <p className={`text-sm font-bold ${readiness.isBlocking ? "text-red-700" : "text-[#64748B]"}`}>{readiness.isBlocking ? uploadProblem : "Сначала загрузите фото или видео"}</p>
              {isAdminMode && readiness.adminMessage ? (
                <details className="w-full rounded-2xl border border-blue-200 bg-blue-50 p-3 text-left">
                  <summary className="cursor-pointer text-xs font-black uppercase tracking-[0.1em] text-blue-700">Технические данные</summary>
                  <p className="mt-2 break-words text-xs font-semibold text-blue-900">upload error raw: {readiness.adminMessage}</p>
                </details>
              ) : null}
            </div>
          </>
        ) : (
          <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="overflow-hidden rounded-[24px] border border-white/70 bg-black/5">
              <div className="border-b border-white/70 bg-white/80 px-4 py-2 text-xs font-black uppercase tracking-[0.1em] text-[#64748B]">
                Предпросмотр выбранного файла
              </div>
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
                  <StatusPill tone={readiness.tone}>{readiness.label}</StatusPill>
                  {!readiness.isBlocking && creative.publicUrl ? <StatusPill tone="green">Файл загружен</StatusPill> : null}
                  {!readiness.isBlocking && creative.fileType === "video" ? (
                    <>
                      {creative.thumbnailUrl ? <StatusPill tone="green">Обложка готова</StatusPill> : <StatusPill tone="amber">Для видео нужна обложка</StatusPill>}
                      {readiness.isReadyForMeta ? <StatusPill tone="green">Видео готово для Meta</StatusPill> : null}
                      <StatusPill tone={metaSummary?.videoLaunchEnabled ? "blue" : "slate"}>
                        {metaSummary?.videoLaunchEnabled ? "Подготовка Meta включена" : "Meta запуск скоро"}
                      </StatusPill>
                    </>
                  ) : null}
                  {!readiness.isBlocking ? <StatusPill tone={creative.fileType === "video" && creative.metaVideoId ? "green" : loading === "video" ? "amber" : "slate"}>
                    {creative.fileType === "video"
                      ? creative.metaVideoId
                        ? "Видео принято Meta"
                        : loading === "video"
                          ? "Готовим видео в Meta"
                          : metaSummary?.videoLaunchEnabled
                            ? "Подготовится при запуске"
                            : "Meta запуск скоро"
                      : "Фото"}
                  </StatusPill> : null}
                </div>
                <p className="mt-3 text-sm text-[#64748B]">{formatBytes(creative.fileSize)} · {creative.mimeType || "тип не определён"}</p>
                {creative.fileType === "video" && videoJob ? (
                  videoJob.status === "failed" ? (
                    <div className="mt-3 rounded-2xl border border-red-200 bg-red-50 p-3">
                      <p className="text-sm font-black text-red-900">{VIDEO_OPTIMIZATION_FAILED_MESSAGE}</p>
                      {isAdminMode && videoJob.error ? <p className="mt-1 text-xs font-semibold text-red-800">{videoJob.error}</p> : null}
                      <p className="mt-1 text-xs font-semibold text-red-800">Повторите обработку или загрузите другое видео.</p>
                      <button
                        type="button"
                        className="neu-btn mt-3 justify-center"
                        disabled={loading === "video"}
                        onClick={() => void retryVideoJob(videoJob.id)}
                      >
                        {loading === "video" ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}
                        Повторить обработку
                      </button>
                    </div>
                  ) : videoJob.status === "ready" ? (
                    <div className="mt-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-3">
                      <p className="text-sm font-black text-emerald-900">{VIDEO_OPTIMIZED_READY_MESSAGE}</p>
                      <p className="mt-1 text-xs font-semibold text-emerald-800">Оптимизированный MP4 и обложка готовы. Можно продолжать запуск.</p>
                      {videoJob.outputSizeBytes ? (
                        <p className="mt-1 text-xs font-semibold text-emerald-800">
                          Итоговый размер: {formatBytes(videoJob.outputSizeBytes)}
                          {videoJob.compressionRatio && videoJob.compressionRatio < 1
                            ? ` · меньше на ${Math.round((1 - videoJob.compressionRatio) * 100)}%`
                            : ""}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 p-3">
                      <p className="text-sm font-black text-amber-900">{VIDEO_OPTIMIZING_TITLE}</p>
                      <p className="mt-1 text-xs font-semibold text-amber-800">{VIDEO_OPTIMIZING_BODY}</p>
                      <p className="mt-2 text-xs font-semibold text-amber-800">Размер файла: {formatBytes(creative.fileSize)}</p>
                      <p className="mt-1 text-xs font-semibold text-amber-800">
                        Статус: {videoJobStatusLabels[videoJob.status]}
                        {videoJob.progress ? ` · ${videoJob.progress}%` : ""}
                      </p>
                      <p className="mt-1 text-xs font-bold text-amber-900">{VIDEO_OPTIMIZING_LAUNCH_AFTER_MESSAGE}</p>
                    </div>
                  )
                ) : null}
                {creative.fileType === "video" && (!videoJobPending || creative.thumbnailUrl) ? (
                  creative.thumbnailUrl ? (
                    <div className="mt-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-3">
                      <p className="text-sm font-black text-emerald-900">{THUMBNAIL_READY_MESSAGE}</p>
                      <img className="mt-2 max-h-40 rounded-xl border border-emerald-200 object-contain" src={creative.thumbnailUrl} alt="Обложка видео" />
                      <button type="button" className="neu-btn mt-3 justify-center" disabled={loading === "thumbnail"} onClick={() => void regenerateThumbnail()}>
                        {loading === "thumbnail" ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}
                        Создать обложку заново
                      </button>
                    </div>
                  ) : (
                    <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 p-3">
                      <p className="text-sm font-semibold text-amber-900">{THUMBNAIL_FAILED_MESSAGE}</p>
                      <p className="mt-1 text-xs font-bold text-amber-800">Обложка обязательна для запуска видео-рекламы в Meta.</p>
                      <button type="button" className="neu-btn mt-3 justify-center" disabled={loading === "thumbnail"} onClick={() => void regenerateThumbnail()}>
                        {loading === "thumbnail" ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}
                        Создать обложку заново
                      </button>
                    </div>
                  )
                ) : null}
                {creative.fileType === "video" && !readiness.isBlocking ? (
                  <div className="mt-3 rounded-2xl border border-blue-200 bg-blue-50 p-3 text-sm font-semibold text-blue-900">
                    <p>
                      {readiness.isReadyForMeta
                        ? "Видео загружено. Файл подготовлен. Обложка готова. Креатив готов для Meta."
                        : readiness.status === "needs_thumbnail"
                          ? "Видео загружено, но перед запуском нужна обложка."
                          : "Файл выбран. Идёт подготовка."}
                    </p>
                    {creative.metaVideoId ? <p className="mt-1 font-black">Видео принято Meta.</p> : null}
                    {creative.videoProcessingStatus ? <p className="mt-1">Видео обрабатывается.</p> : null}
                    <p className="mt-1">{VIDEO_REQUIREMENTS_MESSAGE}</p>
                    {(creative.mimeType === "video/quicktime" || creative.fileName.toLowerCase().endsWith(".mov")) ? (
                      <p className="mt-1 font-black text-amber-800">{MOV_VIDEO_WARNING}</p>
                    ) : null}
                    <p className="mt-1 font-black">{metaSummary?.videoLaunchEnabled ? VIDEO_LAUNCH_ENABLED_MESSAGE : VIDEO_LAUNCH_SOON_MESSAGE}</p>
                    {creative.videoWarnings?.length ? (
                      <ul className="mt-2 space-y-1 text-amber-900">
                        {creative.videoWarnings.map((item) => <li key={item}>• {item}</li>)}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
                {uploadStage ? (
                  <div className="mt-3 rounded-2xl border border-teal-200 bg-teal-50 p-3 text-sm font-black text-teal-800">
                    {uploadStage}
                  </div>
                ) : null}
                {!readiness.isReadyForMeta ? (
                  <div className={`mt-3 rounded-2xl border p-3 ${uploadStatus === "failed" ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"}`}>
                    <p className={`text-sm font-semibold ${uploadStatus === "failed" ? "text-red-900" : "text-amber-900"}`}>{uploadProblem}</p>
                    {isAdminMode && storageHealth?.hint ? <p className="mt-1 text-xs font-bold text-amber-800">{storageHealth.hint}</p> : null}
                    <button type="button" className="neu-btn mt-3 justify-center" disabled={loading === "storage"} onClick={checkStorage}>
                      {loading === "storage" ? <Loader2 className="animate-spin" size={16} /> : <ShieldCheck size={16} />}
                      Проверить загрузку
                    </button>
                  </div>
                ) : null}
                {isAdminMode && uploadDebug ? (
                  <details className="mt-3 rounded-2xl border border-blue-200 bg-blue-50 p-3">
                    <summary className="cursor-pointer text-xs font-black uppercase tracking-[0.1em] text-blue-700">Техническая информация</summary>
                    <div className="mt-2 grid gap-1 break-words text-xs font-semibold text-blue-900">
                      <p>fileName: {uploadDebug.fileName || "-"}</p>
                      <p>fileType: {uploadDebug.fileType || "-"}</p>
                      <p>internalStatus: {readiness.status}</p>
                      <p>assetId: {uploadDebug.assetId || "-"}</p>
                      <p>uploadMode: {uploadDebug.uploadMode || "-"}</p>
                      <p>signedUpload: {uploadDebug.signedUpload ? "yes" : "no"}</p>
                      <p>storagePath: {uploadDebug.storagePathExists ? "yes" : "no"}</p>
                      <p>storagePathValue: {uploadDebug.storagePath || "-"}</p>
                      <p>publicUrl: {uploadDebug.publicUrlExists ? "yes" : "no"}</p>
                      <p>thumbnailUrl: {creative.thumbnailUrl ? "yes" : "no"}</p>
                      <p>fileSize: {formatBytes(creative.fileSize)}</p>
                      <p>mimeType: {creative.mimeType || "-"}</p>
                      <p>publicUrlPreview: {uploadDebug.publicUrlPreview || "-"}</p>
                      <p>uploadStage: {uploadDebug.uploadStage || "-"}</p>
                      <p>lastError: {uploadDebug.lastError || "-"}</p>
                      <p>videoOptimization.loaded: {uploadDebug.videoOptimizationLoaded === undefined ? "-" : String(uploadDebug.videoOptimizationLoaded)}</p>
                      <p>videoOptimization.enabled: {uploadDebug.videoOptimizationEnabled === undefined ? "-" : String(uploadDebug.videoOptimizationEnabled)}</p>
                      <p>videoOptimization.thresholdMb: {uploadDebug.videoOptimizationThresholdMb ?? "-"}</p>
                      <p>videoOptimization.maxInputMb: {uploadDebug.videoOptimizationMaxInputMb ?? "-"}</p>
                      <p>videoOptimization.rawBucket: {metaSummary?.videoOptimization?.rawBucket || "-"}</p>
                      <p>videoOptimization.workerSecretConfigured: {metaSummary?.videoOptimization?.workerSecretConfigured === undefined ? "-" : String(metaSummary.videoOptimization.workerSecretConfigured)}</p>
                      <p>fileSizeMb: {uploadDebug.fileSizeMb ?? "-"} (1 MB = 1024×1024 байт)</p>
                      <p>largeVideoBranch: {uploadDebug.largeVideoBranch === undefined ? "-" : String(uploadDebug.largeVideoBranch)}</p>
                      <p>uploadTarget: {uploadDebug.uploadTarget || "-"}</p>
                      {videoJob ? (
                        <>
                          <p>jobId: {videoJob.id}</p>
                          <p>job.status: {videoJob.status}</p>
                          <p>job.progress: {videoJob.progress ?? "-"}</p>
                          <p>job.errorMessage: {videoJob.error || "-"}</p>
                          <p>optimized_public_url present: {videoJob.outputPublicUrl ? "yes" : "no"}</p>
                          <p>thumbnail_url present: {videoJob.thumbnailPublicUrl ? "yes" : "no"}</p>
                          <p>output_size_bytes: {videoJob.outputSizeBytes ?? "-"}</p>
                          <p>compression_ratio: {videoJob.compressionRatio ?? "-"}</p>
                          <p>thumbnail_source: {videoJob.thumbnailSource || "-"}</p>
                          <p>raw deleted: {videoJob.status === "ready" ? (videoJob.rawDeletedAt ? "yes" : "no") : "-"}</p>
                          <p>rawBucket: {uploadDebug.uploadTarget || "-"}</p>
                          <p>rawPath: {uploadDebug.storagePath || "-"}</p>
                          <p>rawPublicUrl present: {uploadDebug.publicUrlExists ? "yes" : "no"}</p>
                          <p>inputSizeBytes: {creative.fileSize || 0}</p>
                        </>
                      ) : null}
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
              {!readiness.isReadyForMeta ? (
                <p className={`text-sm font-bold ${uploadStatus === "failed" ? "text-red-700" : "text-amber-700"}`}>{uploadProblem}</p>
              ) : null}
            </div>
          </div>
        )}
      </section>
    );
  }

  function renderBriefStep() {
    const readiness = readCreativeReadiness();
    return (
      <section className="neu-card p-5 sm:p-6">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-[#0D9488]">Шаг 2</p>
        <h2 className="mt-1 text-2xl font-black text-[#0F172A]">Важные параметры</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#64748B]">
          Только то, что сотрудник реально знает перед запуском.
        </p>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <Field label="Услуга" value={brief.service} onChange={(value) => updateBrief("service", value)} />
          <label>
            <span style={labelStyle}>Город</span>
            <select
              style={inputStyle}
              value={selectedCity.id}
              onChange={(event) => updateSelectedCity(event.target.value)}
            >
              {KZ_META_CITY_OPTIONS.map((city) => (
                <option key={city.id} value={city.id}>
                  {city.labelRu}
                </option>
              ))}
            </select>
          </label>
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
          <div className="flex flex-col gap-2 sm:items-end">
            <button type="button" className="neu-btn-primary justify-center" disabled={!readiness.isReadyForMeta} onClick={() => goToStep(3)}>ИИ заполнить рекламу</button>
            {!readiness.isReadyForMeta ? <p className="max-w-sm text-sm font-bold text-amber-700">{readiness.clientMessage}</p> : null}
          </div>
        </div>
      </section>
    );
  }

  function renderAiStep() {
    const analysisFeature = getPlanFeature(plan, "ai_creative_analysis");
    const readiness = readCreativeReadiness();
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

        {!readiness.isReadyForMeta ? (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
            {readiness.clientMessage}
          </div>
        ) : null}

        <button type="button" className="neu-btn-primary mt-6 w-full justify-center sm:w-auto" disabled={loading === "ai" || !readiness.isReadyForMeta} onClick={fillWithAi}>
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
          <button type="button" className="neu-btn-primary justify-center" disabled={!aiPackage} onClick={() => goToStep(5)}>
            Перейти к предпросмотру
          </button>
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
    const adPayload = asRecord(metaPayload.ad);
    const creativeAssetPayload = asRecord(creativePayload.asset);
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
    const adSetTargetingDebug = asRecord(adSetPayload.targetingDebug);
    const selectedCityDebug = asRecord(adSetTargetingDebug.selectedCity);
    const debugCandidates = Array.isArray(adSetTargetingDebug.candidates) ? adSetTargetingDebug.candidates.map(asRecord) : [];
    const debugRejectedCandidates = Array.isArray(adSetTargetingDebug.rejectedCandidates) ? adSetTargetingDebug.rejectedCandidates.map(asRecord) : [];
    const publisherPlatforms = Array.isArray(adSetTargeting.publisher_platforms) ? adSetTargeting.publisher_platforms.map(String) : [];
    const instagramPositions = Array.isArray(adSetTargeting.instagram_positions) ? adSetTargeting.instagram_positions.map(String) : [];
    const targetingGeoMode = firstString(adSetTargetingDebug.geoMode, adSetTargetingDebug.geo_mode, Array.isArray(asRecord(adSetTargeting.geo_locations).cities) ? "city" : "country");
    const targetingCityInput = firstString(adSetTargetingDebug.cityInput, brief.city);
    const targetingSelectedCityId = firstString(selectedCityDebug.id, adSetTargetingDebug.cityId, selectedCity.id);
    const targetingSelectedCityLabel = firstString(selectedCityDebug.labelRu, adSetTargetingDebug.labelRu, selectedCity.labelRu);
    const targetingSelectedCityCanonicalName = firstString(selectedCityDebug.canonicalName, adSetTargetingDebug.canonicalName, selectedCity.canonicalName);
    const targetingCityKey = firstString(adSetTargetingDebug.cityKey);
    const targetingCityKeySource = firstString(adSetTargetingDebug.cityKeySource, adSetTargetingDebug.source, targetingGeoMode === "city" ? "static" : "fallback");
    const targetingCityWarning = firstString(adSetTargetingDebug.cityWarning, adSetTargetingDebug.warning);
    const targetingCity = firstString(adSetTargetingDebug.city, targetingGeoMode === "city" ? brief.city : "");
    const targetingUsesRadius = Object.prototype.hasOwnProperty.call(adSetTargetingDebug, "usesRadius")
      ? Boolean(adSetTargetingDebug.usesRadius)
      : false;
    const targetingCityRadiusKm = targetingUsesRadius
      ? firstString(adSetTargetingDebug.cityRadiusKm, adSetTargetingDebug.radiusKm, adSetTargetingDebug.radius_km)
      : "-";
    const targetingFallbackCountry = Object.prototype.hasOwnProperty.call(adSetTargetingDebug, "fallbackCountry")
      ? String(adSetTargetingDebug.fallbackCountry)
      : String(targetingGeoMode !== "city");
    const placementsMode = firstString(adSetPayload.placementsMode, adSetTargetingDebug.placementsMode, "instagram_only");
    const reportLaunchTimestamp = firstString(metaPayload.launchTimestamp, launchResult?.launchTimestamp, launchTimestamp);
    const reportCampaignName = firstString(campaignPayload.name, aiPackage?.campaignName);
    const reportAdSetName = firstString(adSetPayload.name);
    const reportCreativeName = firstString(creativePayload.name);
    const reportAdName = firstString(adPayload.name);
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
    const assetFileType = typeof creativeAssetPayload.fileType === "string" ? creativeAssetPayload.fileType : creative?.fileType || "image";
    const creativeObjectStorySpecType =
      typeof creativePayload.objectStorySpecType === "string"
        ? creativePayload.objectStorySpecType
        : assetFileType === "video"
          ? "video_data"
          : "link_data";
    const creativeImageHash = Object.prototype.hasOwnProperty.call(creativePayload, "imageHash")
      ? Boolean(creativePayload.imageHash)
      : assetFileType === "image" && Boolean(creative?.publicUrl);
    const creativeUsesVideoData = Object.prototype.hasOwnProperty.call(creativePayload, "usesVideoData")
      ? Boolean(creativePayload.usesVideoData)
      : creativeObjectStorySpecType === "video_data";
    const creativeUsesLinkData = Object.prototype.hasOwnProperty.call(creativePayload, "usesLinkData")
      ? Boolean(creativePayload.usesLinkData)
      : creativeObjectStorySpecType === "link_data";
    const creativeImageUploadMode =
      typeof creativePayload.imageUploadMode === "string"
        ? creativePayload.imageUploadMode
        : assetFileType === "image"
          ? "adimages"
          : "-";
    const creativePictureUrl = Object.prototype.hasOwnProperty.call(creativePayload, "pictureUrl")
      ? Boolean(creativePayload.pictureUrl)
      : false;
    const creativeImageUploadCapabilityFallback = Object.prototype.hasOwnProperty.call(creativePayload, "imageUploadCapabilityFallback")
      ? Boolean(creativePayload.imageUploadCapabilityFallback)
      : false;
    const creativeVideoLaunchEnabled = Object.prototype.hasOwnProperty.call(creativePayload, "videoLaunchEnabled")
      ? Boolean(creativePayload.videoLaunchEnabled)
      : Boolean(metaSummary?.videoLaunchEnabled);
    const creativeMetaVideoLaunchStatus = firstString(creativePayload.metaVideoLaunchStatus, assetFileType === "video" ? "soon" : "not_applicable");
    const creativeVideoPayload = asRecord(creativePayload.video);
    const creativeVideoMimeType = firstString(creativeVideoPayload.mimeType, creative?.mimeType);
    const creativeVideoUploadMode = firstString(creativeVideoPayload.uploadMode, creative?.videoUploadMode);
    const creativeVideoId = Object.prototype.hasOwnProperty.call(creativeVideoPayload, "videoId")
      ? Boolean(creativeVideoPayload.videoId)
      : Boolean(creative?.metaVideoId);
    const creativeVideoProcessingStatus = firstString(creativeVideoPayload.processingStatus, creative?.videoProcessingStatus);
    const creativeVideoThumbnail = Object.prototype.hasOwnProperty.call(creativeVideoPayload, "thumbnailUrl")
      ? Boolean(creativeVideoPayload.thumbnailUrl)
      : Boolean(creative?.thumbnailUrl);
    const creativeVideoThumbnailSource = firstString(creativeVideoPayload.thumbnailSource, creative?.thumbnailSource);
    const creativeVideoDataHasImageUrl = Object.prototype.hasOwnProperty.call(creativePayload, "videoDataHasImageUrl")
      ? Boolean(creativePayload.videoDataHasImageUrl)
      : Boolean(creative?.thumbnailUrl);
    const creativeVideoWarnings = Array.isArray(creativeVideoPayload.warnings)
      ? creativeVideoPayload.warnings.map(String).filter(Boolean)
      : creative?.videoWarnings || [];
    const previewHeadline = firstString(aiPackage?.headline, `${brief.service} в ${selectedCity.labelRu}`);
    const previewDescription = firstString(aiPackage?.description, brief.offer);
    const previewCampaignName = firstString(reportCampaignName, aiPackage?.campaignName, `${brief.service} - ${selectedCity.labelRu}`);
    const previewMediaUrl =
      creative?.fileType === "video"
        ? firstString(creative.thumbnailUrl, creative.previewUrl, creative.publicUrl)
        : firstString(creative?.previewUrl, creative?.publicUrl);
    const previewGate = getPreviewReadiness({
      creativeReadiness: readCreativeReadiness(),
      brief,
      cityLabel: selectedCity.labelRu,
      adText: previewAdText,
    });

    if (!previewGate.isReady) {
      return (
        <section className="neu-card p-5 sm:p-6">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-[#0D9488]">Шаг 3</p>
          <h2 className="mt-1 text-2xl font-black text-[#0F172A]">Предпросмотр рекламы</h2>
          <div className="mt-5 rounded-[24px] border border-amber-200 bg-amber-50 p-5">
            <p className="text-base font-black text-amber-950">{previewGate.message}</p>
            {previewGate.details.length > 1 ? (
              <ul className="mt-3 space-y-2 text-sm font-semibold text-amber-900">
                {previewGate.details.map((item) => <li key={item}>• {item}</li>)}
              </ul>
            ) : null}
          </div>
          <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-between">
            <button type="button" className="neu-btn justify-center" onClick={() => goToStep(2)}>Назад</button>
            <button type="button" className="neu-btn-primary justify-center" onClick={() => goToStep(3)}>
              Подготовить текст объявления
            </button>
          </div>
        </section>
      );
    }

    return (
      <section className="neu-card p-5 sm:p-6">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-[#0D9488]">Шаг 3</p>
        <h2 className="mt-1 text-2xl font-black text-[#0F172A]">Так будет выглядеть реклама</h2>

        <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
          <article className="mx-auto w-full max-w-[400px] overflow-hidden rounded-[28px] border border-[#D8E4EC] bg-white shadow-[0_22px_55px_rgba(15,23,42,0.12)]">
            <div className="flex items-center justify-between gap-3 border-b border-[#E2EDF2] px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-black text-[#0F172A]">{clinicName}</p>
                <p className="text-xs font-bold text-[#64748B]">Площадка: Instagram</p>
              </div>
              <StatusPill tone="green">Выключена</StatusPill>
            </div>

            <div className="relative aspect-[9/16] w-full bg-[#E6F7F5]">
              {creative?.fileType === "video" && previewMediaUrl ? (
                <img src={previewMediaUrl} alt="Обложка видео для рекламы" className="h-full w-full object-cover" />
              ) : previewMediaUrl ? (
                <img src={previewMediaUrl} alt="Креатив рекламы" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full items-center justify-center text-[#0D9488]">
                  {creative?.fileType === "video" ? <Video size={42} /> : <FileImage size={42} />}
                </div>
              )}
              <div className="absolute left-3 top-3 rounded-full bg-black/58 px-3 py-1 text-xs font-black text-white">
                Instagram Reels
              </div>
              {creative?.fileType === "video" ? (
                <div className="absolute bottom-3 left-3 rounded-full bg-white/88 px-3 py-1 text-xs font-black text-[#0F172A]">
                  Видео · обложка готова
                </div>
              ) : null}
            </div>

            <div className="space-y-3 p-4">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.1em] text-[#64748B]">Клиника и услуга</p>
                <h3 className="mt-1 break-words text-lg font-black text-[#0F172A]">{brief.service}</h3>
                <p className="mt-1 text-sm font-semibold text-[#64748B]">Город показа: {selectedCity.labelRu}</p>
              </div>
              <p className="break-words text-sm font-semibold leading-relaxed text-[#334155]">{previewAdText}</p>
              <button type="button" className="w-full rounded-2xl bg-[#25D366] px-4 py-3 text-sm font-black text-white shadow-sm">
                WhatsApp
              </button>
              <p className="text-center text-xs font-bold text-[#64748B]">Кнопка ведёт в WhatsApp</p>
            </div>
          </article>

          <div className="min-w-0 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                ["Название кампании", previewCampaignName],
                ["Заголовок", previewHeadline],
                ["Описание", previewDescription],
                ["Площадка", "Instagram"],
                ["Бюджет в день", `${brief.dailyBudget} USD`],
                ["Примерный общий бюджет", `${totalBudget} USD`],
                ["Назначение", "WhatsApp"],
                ["Статус", "будет создана выключенной"],
              ].map(([label, value]) => (
                <div key={label} className="rounded-2xl border border-[#D8E4EC] bg-white/65 p-4">
                  <p className="text-xs font-black uppercase tracking-[0.1em] text-[#64748B]">{label}</p>
                  <p className="mt-2 break-words text-sm font-semibold leading-relaxed text-[#0F172A]">{value || "-"}</p>
                </div>
              ))}
            </div>

            <div className="rounded-[24px] border border-emerald-200 bg-emerald-50 p-5">
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 text-emerald-700" size={22} />
                <div>
                  <p className="text-base font-black text-emerald-950">Безопасный запуск</p>
                  <p className="mt-1 text-sm font-semibold leading-relaxed text-emerald-800">
                    Мы создадим кампанию в Meta выключенной. Включить её можно вручную в Meta Ads Manager после проверки.
                  </p>
                </div>
              </div>
            </div>

            {isAdminMode ? (
              <details className="rounded-2xl border border-[#D8E4EC] bg-white/65 p-4">
                <summary className="cursor-pointer text-sm font-black text-[#0F172A]">Технические данные предпросмотра</summary>
                <div className="mt-4 grid gap-2 text-sm font-semibold text-[#475569]">
                  <p><b>creative type:</b> {creative?.fileType || "-"}</p>
                  <p><b>publicUrl present:</b> {creative?.publicUrl ? "true" : "false"}</p>
                  <p><b>thumbnailUrl present:</b> {creative?.thumbnailUrl ? "true" : "false"}</p>
                  <p><b>placement config:</b> Instagram / Reels</p>
                  <p><b>destination config:</b> WhatsApp</p>
                  <p><b>launch status target:</b> PAUSED</p>
                  <p><b>campaign name:</b> {previewCampaignName}</p>
                  <p><b>adset name:</b> {reportAdSetName || `Instagram, ${selectedCity.labelRu}, ${brief.dailyBudget} USD/day`}</p>
                  <p><b>creative name:</b> {reportCreativeName || previewHeadline}</p>
                  <p><b>ad name:</b> {reportAdName || previewHeadline}</p>
                </div>
              </details>
            ) : null}
          </div>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          {[
            ["Что запускаем", report.whatWillRun || `${creative?.fileType === "video" ? "Видео" : "Фото"} + объявление`],
            ["Кому показываем", aiPackage?.audience || brief.knownAudience],
            ["Город", selectedCity.labelRu],
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
              {(report.risks || ["Проверить текст, бюджет и адрес заявок перед созданием кампании."]).map((item) => <li key={item}>• {item}</li>)}
            </ul>
          </div>
          <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4">
            <p className="text-xs font-black uppercase tracking-[0.1em] text-blue-800">Что будет создано в Meta</p>
            <ul className="mt-3 space-y-2 text-sm font-semibold text-blue-900">
              <li>• Кампания: {reportCampaignName || "-"}</li>
              <li>• Группа объявлений: {reportAdSetName || `Instagram, ${selectedCity.labelRu}, ${brief.dailyBudget} USD/день`}</li>
              <li>• Площадки: Instagram</li>
              <li>• Гео: {targetingGeoMode === "city" ? `${targetingSelectedCityLabel || targetingCity || selectedCity.labelRu}, город Meta` : `Казахстан; city key для ${targetingSelectedCityLabel} не найден`}</li>
              <li>• Креатив: {creative?.fileType === "video" ? "видео" : "фото"}</li>
              <li>• Объявление: {aiPackage?.headline || "-"}</li>
              <li>• Статус: выключено</li>
            </ul>
          </div>
        </div>

        {targetingCityWarning ? (
          <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-bold text-amber-900">
            Предупреждение по гео: {targetingCityWarning}
          </div>
        ) : null}

        {isAdminMode ? (
          <details className="mt-5 rounded-2xl border border-[#D8E4EC] bg-white/65 p-4">
            <summary className="cursor-pointer text-sm font-black text-[#0F172A]">Подробности Meta payload</summary>
            <div className="mt-4 grid gap-3 text-sm">
            <p><b>Ad account:</b> {metaSummary?.adAccountId || "env/backend"}</p>
            <p><b>Page:</b> {metaSummary?.pageId || "env/backend"}</p>
            <p><b>Instagram actor:</b> {metaSummary?.instagramActorId || "env/backend"}</p>
            <p><b>launchTimestamp:</b> {reportLaunchTimestamp || "-"}</p>
            <p><b>campaign.name:</b> {reportCampaignName || "-"}</p>
            <p><b>adset.name:</b> {reportAdSetName || "-"}</p>
            <p><b>creative.name:</b> {reportCreativeName || "-"}</p>
            <p><b>ad.name:</b> {reportAdName || "-"}</p>
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
            <p><b>adset.targeting.selectedCity.id:</b> {targetingSelectedCityId || "-"}</p>
            <p><b>adset.targeting.selectedCity.labelRu:</b> {targetingSelectedCityLabel || "-"}</p>
            <p><b>adset.targeting.selectedCity.canonicalName:</b> {targetingSelectedCityCanonicalName || "-"}</p>
            <p><b>adset.targeting.cityInput:</b> {targetingCityInput || "-"}</p>
            <p><b>adset.targeting.cityKey:</b> {targetingCityKey || "-"}</p>
            <p><b>adset.targeting.cityKeySource:</b> {targetingCityKeySource || "-"}</p>
            <p><b>adset.targeting.candidates:</b> {debugCandidates.length}</p>
            <p><b>adset.targeting.rejectedCandidates:</b> {debugRejectedCandidates.length}</p>
            {debugRejectedCandidates.length ? (
              <p><b>adset.targeting.rejectedCandidateNames:</b> {debugRejectedCandidates.map((item) => firstString(item.name, item.reason)).filter(Boolean).join(", ")}</p>
            ) : null}
            <p><b>adset.targeting.geoMode:</b> {targetingGeoMode}</p>
            <p><b>adset.targeting.city:</b> {targetingCity || "-"}</p>
            <p><b>adset.targeting.cityRadiusKm:</b> {targetingCityRadiusKm}</p>
            <p><b>adset.targeting.usesRadius:</b> {String(targetingUsesRadius)}</p>
            <p><b>adset.targeting.fallbackCountry:</b> {targetingFallbackCountry}</p>
            <p><b>adset.targeting.cityWarning:</b> {targetingCityWarning || "-"}</p>
            <p><b>adset.targeting.publisher_platforms:</b> {JSON.stringify(publisherPlatforms)}</p>
            <p><b>adset.targeting.instagram_positions:</b> {JSON.stringify(instagramPositions)}</p>
            <p><b>placementsMode:</b> {placementsMode}</p>
            <p><b>asset.fileType:</b> {assetFileType}</p>
            <p><b>creative.objectStorySpecType:</b> {creativeObjectStorySpecType}</p>
            <p><b>creative.imageUploadMode:</b> {creativeImageUploadMode}</p>
            <p><b>creative.imageHash:</b> {creativeImageHash ? "yes" : "no"}</p>
            <p><b>creative.pictureUrl:</b> {creativePictureUrl ? "yes" : "no"}</p>
            <p><b>creative.imageUploadCapabilityFallback:</b> {String(creativeImageUploadCapabilityFallback)}</p>
            <p><b>creative.usesVideoData:</b> {String(creativeUsesVideoData)}</p>
            <p><b>creative.usesLinkData:</b> {String(creativeUsesLinkData)}</p>
            <p><b>creative.videoLaunchEnabled:</b> {String(creativeVideoLaunchEnabled)}</p>
            <p><b>creative.metaVideoLaunchStatus:</b> {creativeMetaVideoLaunchStatus}</p>
            <p><b>video.mimeType:</b> {creativeVideoMimeType || "-"}</p>
            <p><b>video.uploadMode:</b> {creativeVideoUploadMode || "-"}</p>
            <p><b>video.videoId:</b> {creativeVideoId ? "yes" : "no"}</p>
            <p><b>video.processingStatus:</b> {creativeVideoProcessingStatus || "-"}</p>
            <p><b>video.thumbnailUrl:</b> {creativeVideoThumbnail ? "yes" : "no"}</p>
            <p><b>video.thumbnailSource:</b> {creativeVideoThumbnailSource || "-"}</p>
            <p><b>creative.videoDataHasImageUrl:</b> {String(creativeVideoDataHasImageUrl)}</p>
            <p><b>video.launchEnabled:</b> {String(creativeVideoLaunchEnabled)}</p>
            <p><b>creative.usesInstagramActor:</b> {creativeUsesInstagramActor}</p>
            <p><b>creative.instagramActorFallback:</b> {creativeInstagramActorFallback}</p>
            </div>
          </details>
        ) : null}

        {assetFileType === "video" && creativeVideoWarnings.length ? (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-bold text-amber-900">
            {creativeVideoWarnings.join(" ")}
          </div>
        ) : null}

        {creativeImageUploadCapabilityFallback ? (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-bold text-amber-900">
            Meta не разрешила стандартную загрузку изображения. Система попробовала создать креатив через подготовленную публичную ссылку файла.
          </div>
        ) : null}

        {assetFileType === "video" && !creativeVideoLaunchEnabled ? (
          <div className="mt-4 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm font-bold text-blue-900">
            {VIDEO_REAL_LAUNCH_DISABLED_MESSAGE}
          </div>
        ) : null}

        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-between">
          <button type="button" className="neu-btn justify-center" onClick={() => goToStep(2)}>Назад</button>
          <button type="button" className="neu-btn-primary justify-center" onClick={() => goToStep(6)}>
            Перейти к запуску
          </button>
        </div>
      </section>
    );
  }

  function renderLaunchStep() {
    const readiness = readCreativeReadiness();
    const errors = prelaunchErrors("PAUSED");
    const realLaunchBlockedByCreative = realLaunchNeedsCreativeReadiness(readiness);
    const realLaunchBlockedByVideo = creative?.fileType === "video" && !metaSummary?.videoLaunchEnabled ? VIDEO_REAL_LAUNCH_DISABLED_MESSAGE : "";
    const realLaunchBusy = loading === "launch" || loading === "video";
    const realLaunchDisabled = realLaunchBusy || errors.length > 0 || Boolean(realLaunchBlockedByCreative) || Boolean(realLaunchBlockedByVideo);
    const realLaunchTone =
      realLaunchStatus === "failed" ? "red" : realLaunchStatus === "created" ? "green" : realLaunchStatus === "video_processing" ? "amber" : "blue";
    const realLaunchLabel =
      realLaunchStatus === "creating"
        ? "Создаём кампанию в Meta"
        : realLaunchStatus === "failed"
          ? "Запуск в Meta не прошёл"
          : realLaunchStatus === "video_processing"
            ? "Видео обрабатывается в Meta"
            : "Кампания создана в Meta";
    const launchCreativePayload = asRecord(asRecord(launchResult?.metaPayload).creative);
    const launchImageUploadCapabilityFallback = Boolean(launchCreativePayload.imageUploadCapabilityFallback);
    const launchMetaVideoId = firstString(launchResult?.metaVideoId, launchResult?.videoId, creative?.metaVideoId);
    const launchVideoUploadMode = firstString(launchResult?.videoUploadMode, creative?.videoUploadMode);
    const launchVideoProcessingStatus = firstString(launchResult?.videoProcessingStatus, creative?.videoProcessingStatus);
    const launchVideoWarnings = uniqueStrings([...(creative?.videoWarnings || []), ...(launchResult?.videoWarnings || [])]);
    const launchIsActive = launchResult?.metaStatus === "ACTIVE" || launchResult?.status === "active";
    const launchResultTitle = launchResult?.dryRun
      ? "Проверка без запуска"
      : launchIsActive
        ? "Реклама создана и запущена в Meta"
        : "Реклама создана в Meta выключенной";
    const launchCampaignName = firstString(
      asRecord(asRecord(launchResult?.metaPayload).campaign).name,
      asRecord(launchResult?.launch).campaignName,
      aiPackage?.campaignName,
      `${brief.service} - ${selectedCity.labelRu}`,
    );
    return (
      <section className="neu-card p-5 sm:p-6">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-[#0D9488]">Шаг 6</p>
        <h2 className="mt-1 text-2xl font-black text-[#0F172A]">Подтверждение запуска</h2>
        <div className="mt-4 flex flex-wrap gap-2">
          <StatusPill tone={metaSummary?.configured ? "green" : "amber"}>{metaSummary?.configured ? "Meta env настроены" : "Meta env не подтверждены"}</StatusPill>
          <StatusPill tone="green">Безопасный режим</StatusPill>
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

        <div className="mt-5 rounded-[24px] border border-emerald-200 bg-emerald-50 p-5">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 text-emerald-700" size={22} />
            <div>
              <p className="text-base font-black text-emerald-950">Безопасный режим: реклама создаётся выключенной</p>
              <p className="mt-1 text-sm font-semibold leading-relaxed text-emerald-800">
                Negis подготовит кампанию в Meta, но она не начнёт тратить бюджет. Сотрудник или администратор сможет проверить объявление и включить его вручную в Ads Manager.
              </p>
            </div>
          </div>
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
              Проверить загрузку
            </button>
          </div>
        ) : null}

        {!readiness.isReadyForMeta ? (
          <div className="mt-5 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm font-semibold text-blue-900">
            Это тест без создания рекламы. Креатив ещё не готов для запуска.
          </div>
        ) : null}

        {realLaunchBlockedByVideo ? (
          <div className="mt-5 rounded-2xl border border-blue-200 bg-blue-50 p-4">
            <p className="text-sm font-black text-blue-900">{realLaunchBlockedByVideo}</p>
            <p className="mt-1 text-sm font-semibold text-blue-800">{VIDEO_LAUNCH_SOON_MESSAGE}</p>
          </div>
        ) : null}

        {realLaunchStatus !== "idle" ? (
          <div className={`mt-5 rounded-2xl border p-4 ${
            realLaunchTone === "red"
              ? "border-red-200 bg-red-50 text-red-900"
              : realLaunchTone === "green"
                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                : realLaunchTone === "amber"
                  ? "border-amber-200 bg-amber-50 text-amber-900"
                  : "border-blue-200 bg-blue-50 text-blue-900"
          }`}>
            <p className="text-sm font-black">{realLaunchLabel}</p>
            {realLaunchMessage ? <p className="mt-1 text-sm font-semibold">{realLaunchMessage}</p> : null}
          </div>
        ) : null}

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <button type="button" className="neu-btn justify-center" onClick={() => goToStep(5)}>
            Назад к предпросмотру
          </button>
          <button type="button" className="neu-btn justify-center" disabled={loading === "check"} onClick={() => void runComplianceCheck(true)}>
            {loading === "check" ? <Loader2 className="animate-spin" size={16} /> : <ShieldCheck size={16} />}
            Проверить без запуска
          </button>
          <button type="button" className="neu-btn-primary justify-center" disabled={realLaunchDisabled} onClick={() => void launch("PAUSED")}>
            {realLaunchBusy ? <Loader2 className="animate-spin" size={16} /> : <Rocket size={16} />}
            Создать рекламу в Meta выключенной
          </button>
        </div>

        {launchResult && launchResult.dryRun ? (
          <div className="mt-6 rounded-[24px] border border-slate-200 bg-white/70 p-5">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 text-slate-500" size={20} />
              <div>
                <p className="font-black text-slate-700">{launchResultTitle}</p>
                <p className="mt-1 text-sm font-semibold text-slate-600">{DRY_RUN_REFERENCE_MESSAGE} Кампания в Meta не создавалась.</p>
                {launchResult.warning ? <p className="mt-2 text-sm font-bold text-amber-800">{launchResult.warning}</p> : null}
              </div>
            </div>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <button type="button" className="neu-btn-primary justify-center" onClick={() => setLocation("/ads-automation/history")}>
                <History size={16} />
                История запусков
              </button>
            </div>
          </div>
        ) : null}

        {launchResult && !launchResult.dryRun ? (
          <div className="mt-6 rounded-[24px] border border-emerald-200 bg-emerald-50 p-5">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 text-emerald-700" size={20} />
              <div className="min-w-0 flex-1">
                <p className="text-lg font-black text-emerald-900">{launchResultTitle}</p>
                <p className="mt-1 text-sm font-semibold text-emerald-800">
                  {launchIsActive
                    ? "Кампания активна и может тратить бюджет. Контролируйте её в Ads Manager."
                    : "Кампания не тратит деньги: она создана выключенной. Включить её можно в Ads Manager после проверки."}
                </p>
              </div>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {[
                ["Кампания", launchCampaignName],
                ["Услуга", brief.service],
                ["Город", selectedCity.labelRu],
                ["Бюджет в день", `${brief.dailyBudget || 0} USD`],
                ["Бюджет всего (примерно)", `${totalBudget} USD`],
                ["Плейсмент", "Instagram"],
                ["Куда идут заявки", destination.label],
                ["Тип креатива", creative?.fileType === "video" ? "видео" : "фото"],
                ["Статус", launchIsActive ? "активна" : "выключено"],
              ].map(([label, value]) => (
                <div key={label} className="rounded-2xl border border-emerald-100 bg-white/70 px-4 py-3">
                  <p className="text-xs font-black uppercase tracking-[0.1em] text-emerald-700">{label}</p>
                  <p className="mt-1 truncate text-sm font-bold text-[#0F172A]">{value || "-"}</p>
                </div>
              ))}
            </div>

            {launchResult.warning ? <p className="mt-3 text-sm font-bold text-amber-800">{launchResult.warning}</p> : null}
            {creative?.fileType === "video" && launchVideoWarnings.length ? (
              <p className="mt-2 text-sm font-bold text-amber-800">{launchVideoWarnings.join(" ")}</p>
            ) : null}
            {launchImageUploadCapabilityFallback ? (
              <p className="mt-2 text-sm font-bold text-amber-800">
                Meta не разрешила стандартную загрузку изображения. Система попробовала создать креатив через подготовленную публичную ссылку файла.
              </p>
            ) : null}
            <p className="mt-2 text-xs font-semibold text-amber-800">
              В Ads Manager могли остаться предыдущие тестовые выключенные кампании. Их можно удалить вручную.
            </p>

            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <a className="neu-btn-primary justify-center" href={adsManagerUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={16} />
                Открыть Ads Manager
              </a>
              <button type="button" className="neu-btn justify-center" onClick={() => setLocation("/ads-automation/history")}>
                <History size={16} />
                История запусков
              </button>
              <button type="button" className="neu-btn justify-center" onClick={startNewLaunch}>
                <RefreshCw size={16} />
                Создать новый запуск
              </button>
            </div>

            {isAdminMode ? (
              <details className="mt-4 rounded-2xl border border-emerald-100 bg-white/60 p-3">
                <summary className="cursor-pointer text-xs font-black uppercase tracking-[0.1em] text-emerald-700">Технические данные</summary>
                <div className="mt-2 grid gap-1 break-words text-xs font-semibold text-[#475569]">
                  <p>Campaign ID: {launchResult.metaCampaignId || "-"}</p>
                  <p>Ad Set ID: {launchResult.metaAdSetId || "-"}</p>
                  <p>Creative ID: {launchResult.metaCreativeId || "-"}</p>
                  <p>Ad ID: {launchResult.metaAdId || "-"}</p>
                  {creative?.fileType === "video" ? <p>Video ID: {launchMetaVideoId || "-"}</p> : null}
                  {creative?.fileType === "video" ? <p>Video upload mode: {launchVideoUploadMode || "-"}</p> : null}
                  {creative?.fileType === "video" ? <p>Video processing: {launchVideoProcessingStatus || "-"}</p> : null}
                </div>
              </details>
            ) : null}
          </div>
        ) : null}

        {lastDryRunResult?.dryRun && (realLaunchStatus !== "idle" || (launchResult && !launchResult.dryRun)) ? (
          <div className="mt-4 rounded-2xl border border-slate-200 bg-white/70 p-4 text-sm font-semibold text-slate-700">
            {DRY_RUN_REFERENCE_MESSAGE} Это справка, реальный статус запуска показан выше.
          </div>
        ) : null}
      </section>
    );
  }

  function renderHistory() {
    const visibleHistoryItems = historyItems.filter(
      (item) => matchesHistoryFilter(item, historyFilter) && matchesHistorySearch(item, historySearch),
    );
    const historyModes = historyItems.map((item) => resolveLaunchMode(item));
    const createdCount = historyModes.filter((mode) => mode === "paused_created" || mode === "active_created").length;
    const processingCount = historyModes.filter((mode) => mode === "video_processing").length;
    const failedCount = historyModes.filter((m) => m === "failed").length;
    const dryRunCount = historyModes.filter((m) => m === "dry_run").length;
    const summaryMetrics: Array<{ label: string; value: number; icon: LucideIcon; tone: NegisTone }> = [
      { label: "Создано в Meta", value: createdCount, icon: CheckCircle2, tone: "success" },
      { label: "Видео в обработке", value: processingCount, icon: Video, tone: processingCount > 0 ? "warning" : "muted" },
      { label: "Требуют внимания", value: failedCount, icon: AlertTriangle, tone: failedCount > 0 ? "error" : "muted" },
      { label: "Тестов без создания", value: dryRunCount, icon: FlaskConical, tone: "secondary" },
    ];
    const showingInitialLoader = !historyLoaded && historyItems.length === 0;

    return (
      <div className="space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm font-semibold" style={{ color: "var(--negis-muted)" }}>
            {showingInitialLoader
              ? "Загружаем историю запусков"
              : historyItems.length === 0
                ? "Пока нет запусков"
                : `Показано ${visibleHistoryItems.length} из ${historyItems.length}`}
          </p>
          <button type="button" className="neu-btn justify-center sm:w-auto" disabled={loading === "history"} onClick={() => void loadHistory()}>
            {loading === "history" ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}
            Обновить
          </button>
        </div>

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Сводка по запускам">
          {summaryMetrics.map((metric) => (
            <HistoryMetricCard key={metric.label} label={metric.label} value={metric.value} icon={metric.icon} tone={metric.tone} />
          ))}
        </section>

        <section className="negis-glass p-4 sm:p-5">
          <div>
            <h2 className="text-sm font-black" style={{ color: "var(--negis-text)" }}>Найти запуск</h2>
            <p className="mt-1 text-xs font-semibold" style={{ color: "var(--negis-muted)" }}>
              Отфильтруйте историю по результату или типу креатива.
            </p>
          </div>
          <div className="mt-4 flex flex-wrap gap-2" aria-label="Фильтры истории запусков">
            {historyFilterOptions.map((option) => {
              const active = historyFilter === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  className="rounded-full border px-4 py-2 text-xs font-black transition"
                  style={
                    active
                      ? { background: "var(--negis-primary)", borderColor: "var(--negis-primary)", color: "#FFFFFF" }
                      : { background: "var(--negis-surface)", borderColor: "var(--negis-border)", color: "var(--negis-muted)" }
                  }
                  aria-pressed={active}
                  onClick={() => setHistoryFilter(option.id)}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <label className="relative mt-3 block">
            <span className="sr-only">Поиск по истории запусков</span>
            <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2" size={17} style={{ color: "var(--negis-muted)" }} />
            <input
              style={{ ...inputStyle, paddingLeft: 42 }}
              type="search"
              value={historySearch}
              placeholder={isAdminMode ? "Кампания, услуга, город или Meta ID" : "Кампания, услуга или город"}
              onChange={(event) => setHistorySearch(event.target.value)}
            />
          </label>
        </section>

        {showingInitialLoader ? (
          <section className="negis-glass flex min-h-44 flex-col items-center justify-center gap-3 p-8 text-center" aria-live="polite">
            <Loader2 className="animate-spin" size={24} style={{ color: "var(--negis-primary)" }} />
            <p className="text-sm font-bold" style={{ color: "var(--negis-muted)" }}>Собираем запуски из Negis OS</p>
          </section>
        ) : historyItems.length === 0 ? (
          <section className="negis-glass-hero flex flex-col items-center gap-3 p-8 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl" style={{ background: "var(--negis-primary-soft)", color: "var(--negis-primary)" }}>
              <Rocket size={24} />
            </div>
            <h2 className="text-xl font-black" style={{ color: "var(--negis-text)" }}>Запусков пока нет</h2>
            <p className="max-w-md text-sm font-semibold leading-relaxed" style={{ color: "var(--negis-muted)" }}>
              Создайте первую рекламную кампанию. Negis OS подготовит креатив, проверит данные и создаст кампанию в Meta выключенной.
            </p>
            <button type="button" className="neu-btn-primary justify-center" onClick={() => setLocation("/ads-automation")}>
              <Rocket size={16} />
              Создать рекламу
            </button>
          </section>
        ) : visibleHistoryItems.length === 0 ? (
          <section className="negis-glass flex flex-col items-center gap-3 p-6 text-center">
            <p className="text-sm font-semibold" style={{ color: "var(--negis-muted)" }}>
              Ничего не найдено. Измените фильтр или поисковый запрос.
            </p>
            <button
              type="button"
              className="neu-btn justify-center"
              onClick={() => {
                setHistoryFilter("all");
                setHistorySearch("");
              }}
            >
              Сбросить фильтры
            </button>
          </section>
        ) : (
          <section className="space-y-3">
            {visibleHistoryItems.map((item, index) => {
              const payload = asRecord(item.payload);
              const metaResponse = asRecord(item.metaResponse);
              const mode = resolveLaunchMode(item);
              const historyMetaVideoId = firstString(item.metaVideoId, payload.metaVideoId, metaResponse.videoId, metaResponse.metaVideoId);
              const historyVideoUploadMode = firstString(payload.videoUploadMode, metaResponse.videoUploadMode);
              const historyVideoProcessingStatus = firstString(payload.videoProcessingStatus, metaResponse.videoProcessingStatus);
              const historyLastCheckedAt = firstString(payload.lastCheckedAt, metaResponse.lastCheckedAt);
              const historyThumbnailUrl = firstString(payload.thumbnailUrl, metaResponse.thumbnailUrl);
              const historyThumbnailSource = firstString(payload.thumbnailSource, metaResponse.thumbnailSource);
              const historyImageHash = firstString(payload.imageHash, payload.image_hash, metaResponse.imageHash);
              const historyOptimized = payload.optimized === true;
              const historyOptimizedSize = Number(payload.optimizedOutputSizeBytes) || 0;
              const historyOptimizedRatio = Number(payload.optimizedCompressionRatio) || 0;
              const optimizedReductionText =
                historyOptimizedRatio && historyOptimizedRatio < 1 ? ` · меньше на ${Math.round((1 - historyOptimizedRatio) * 100)}%` : "";
              const historyVideoWarnings = Array.isArray(payload.videoWarnings)
                ? payload.videoWarnings.map(String).filter(Boolean)
                : Array.isArray(metaResponse.videoWarnings)
                  ? metaResponse.videoWarnings.map(String).filter(Boolean)
                  : [];
              const isRealLaunch = mode === "paused_created" || mode === "active_created";
              const isVideo = payload.creativeType === "video" || mode === "video_processing";
              const creativeTypeLabel = isVideo ? "Видео" : "Фото";
              const service = typeof payload.service === "string" && payload.service ? payload.service : "";
              const city = typeof payload.city === "string" && payload.city ? payload.city : "";
              const payloadDailyBudget = firstString(payload.dailyBudget);
              const budgetPerDay = item.budgetDailyMinor != null
                ? `${Math.round(item.budgetDailyMinor / 100)} ${item.currency || "USD"}/день`
                : payloadDailyBudget
                  ? `${payloadDailyBudget} USD/день`
                  : "—";
              const createdAt = historyItemTimestamp(item);
              const createdAtLabel = createdAt ? new Date(createdAt).toLocaleString("ru-RU") : "Дата не указана";
              // A video history card renders only its thumbnail, never the raw video URL.
              const creativePreviewUrl = isVideo
                ? historyThumbnailUrl
                : firstString(payload.thumbnailUrl, payload.creativeUrl, payload.imageUrl);
              const modeBadge =
                mode === "dry_run"
                  ? { tone: "blue" as const, label: "Тест завершён" }
                  : mode === "video_processing"
                    ? { tone: "amber" as const, label: "Видео обрабатывается" }
                    : mode === "failed"
                      ? { tone: "red" as const, label: "Требует внимания" }
                      : mode === "active_created"
                        ? { tone: "green" as const, label: "Активна" }
                        : { tone: "green" as const, label: "Создана выключенной" };
              const modeDescription =
                mode === "dry_run"
                  ? "Параметры проверены. Реклама в Meta не создавалась."
                  : mode === "video_processing"
                    ? "Видео принято Meta и обрабатывается. Кампания ещё не создана — это не ошибка."
                    : mode === "failed"
                      ? "Не удалось создать рекламу. Ниже указан безопасный следующий шаг."
                      : mode === "active_created"
                        ? "Кампания активна в Meta. Следите за расходом в Ads Manager."
                        : "Кампания создана в Meta выключенной и пока не тратит бюджет.";
              const whatCreated =
                mode === "dry_run"
                  ? "Проверка без создания рекламы."
                  : mode === "video_processing"
                    ? "Видео обрабатывается, кампания ещё не создана."
                  : mode === "failed"
                      ? "Кампания не создана."
                      : mode === "active_created"
                        ? "Кампания создана и активна в Meta."
                        : "Кампания создана в Meta выключенной.";
              const nextAction =
                mode === "dry_run"
                  ? "Создайте кампанию, когда параметры проверены."
                  : mode === "video_processing"
                    ? "Дождитесь готовности видео и проверьте снова."
                  : mode === "failed"
                      ? "Проверьте детали и создайте новый запуск."
                      : mode === "active_created"
                        ? "Проверьте результаты и расход в Ads Manager."
                        : "Откройте Ads Manager и включите кампанию, когда будете готовы.";
              const checking = Boolean(historyVideoCheckId) && historyVideoCheckId === (item.id || historyMetaVideoId);
              return (
                <article
                  key={item.id || `${item.campaignName}-${index}`}
                  className="negis-glass p-4 sm:p-5"
                  style={mode === "failed" ? { borderColor: "var(--negis-error)" } : undefined}
                >
                  <div className="flex min-w-0 items-start gap-3 sm:gap-4">
                    <div
                      className="relative flex h-20 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl border"
                      style={{
                        background: negisToneSoftBg(isVideo ? "ai" : "primary"),
                        borderColor: "var(--negis-border)",
                        color: negisToneColor(isVideo ? "ai" : "primary"),
                      }}
                    >
                      {isVideo ? <Video size={20} /> : <FileImage size={20} />}
                      {creativePreviewUrl ? (
                        <img
                          alt={isVideo ? "Обложка видео" : "Превью рекламного креатива"}
                          className="absolute inset-0 h-full w-full object-cover"
                          loading="lazy"
                          src={creativePreviewUrl}
                          onError={(event) => {
                            event.currentTarget.style.display = "none";
                          }}
                        />
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <p className="break-words font-black" style={{ color: "var(--negis-text)" }}>{item.campaignName || "Рекламная кампания"}</p>
                          <p className="mt-1 text-xs font-semibold" style={{ color: "var(--negis-muted)" }}>
                            {createdAtLabel} · {creativeTypeLabel}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                          <StatusPill tone={modeBadge.tone}>{modeBadge.label}</StatusPill>
                          {historyOptimized ? <StatusPill tone="blue">Видео оптимизировано</StatusPill> : null}
                        </div>
                      </div>
                      <p className="mt-2 text-sm font-semibold leading-relaxed" style={{ color: "var(--negis-muted)" }}>{modeDescription}</p>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-x-5 gap-y-2 border-t pt-4 text-sm sm:grid-cols-2" style={{ borderColor: "var(--negis-border)" }}>
                    <HistoryFact label="Услуга" value={service || "—"} />
                    <HistoryFact label="Город" value={city || "—"} />
                    <HistoryFact label="Заявки" value={historyDestinationLabel(payload)} />
                    <HistoryFact label="Площадка" value="Instagram" />
                    <HistoryFact label="Тип креатива" value={creativeTypeLabel} />
                    <HistoryFact label="Бюджет в день" value={budgetPerDay} />
                    <HistoryFact label="Запустил" value={item.launchedBy || "—"} />
                    {historyOptimized ? (
                      <HistoryFact
                        label="Оптимизация видео"
                        value={`${historyOptimizedSize ? formatBytes(historyOptimizedSize) : "готово"}${optimizedReductionText}`}
                      />
                    ) : null}
                    {isVideo ? <HistoryFact label="Обложка" value={historyThumbnailUrl ? "готова" : "не найдена"} /> : null}
                    {isVideo ? (
                      <HistoryFact label="Проверено" value={historyLastCheckedAt ? new Date(historyLastCheckedAt).toLocaleString("ru-RU") : "—"} />
                    ) : null}
                  </div>

                  {historyVideoWarnings.length ? (
                    <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm font-bold text-amber-800">
                      {historyVideoWarnings.join(" ")}
                    </div>
                  ) : null}

                  {mode === "failed" ? (
                    <div className="mt-3 rounded-2xl border border-red-200 bg-red-50 p-3">
                      <p className="text-sm font-black text-red-800">Запуск не прошёл. Кампания в Meta не создана.</p>
                      {isAdminMode && item.lastError ? (
                        <p className="mt-1 break-words text-xs font-semibold text-red-700">{item.lastError}</p>
                      ) : (
                        <p className="mt-1 text-xs font-semibold text-red-700">Техническая причина скрыта. Нажмите «Проверить детали».</p>
                      )}
                      <div className="mt-3 flex flex-wrap gap-2">
                        {!isAdminMode ? (
                          <button type="button" className="neu-btn justify-center px-4 py-2 text-xs" onClick={() => setUiMode("admin")}>
                            Проверить детали
                          </button>
                        ) : null}
                        <button type="button" className="neu-btn justify-center px-4 py-2 text-xs" onClick={() => setLocation("/ads-automation")}>
                          Создать новый запуск
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <details className="mt-3 overflow-hidden rounded-2xl border" style={{ borderColor: "var(--negis-border)" }}>
                    <summary className="cursor-pointer list-none px-4 py-2.5 text-xs font-black uppercase tracking-[0.1em]" style={{ color: "var(--negis-primary)" }}>
                      Подробности запуска
                    </summary>
                    <div className="grid gap-1.5 px-4 pb-4 pt-1 text-xs font-semibold" style={{ color: "var(--negis-muted)" }}>
                      <p>Что создано: {whatCreated}</p>
                      <p>Услуга и город: {[service, city].filter(Boolean).join(" · ") || "—"}</p>
                      <p>Бюджет в день: {budgetPerDay}</p>
                      <p>Тип креатива: {creativeTypeLabel}</p>
                      <p>
                        Оптимизация видео:{" "}
                        {historyOptimized
                          ? `видео оптимизировано${historyOptimizedSize ? ` (${formatBytes(historyOptimizedSize)}${optimizedReductionText})` : ""}`
                          : isVideo
                            ? "не требовалась или не выполнялась"
                            : "не требуется"}
                      </p>
                      {historyVideoWarnings.length ? <p>Предупреждения: {historyVideoWarnings.join(" ")}</p> : null}
                      <p>Следующий шаг: {nextAction}</p>
                      {isAdminMode ? (
                        <div className="mt-2 grid gap-1 border-t pt-2" style={{ borderColor: "var(--negis-border)" }}>
                          <p className="font-black uppercase tracking-[0.1em]" style={{ color: "var(--negis-muted)" }}>Технические данные</p>
                          <p>Campaign ID: {item.metaCampaignId || "-"}</p>
                          <p>Ad Set ID: {item.metaAdSetId || "-"}</p>
                          <p>Ad ID: {item.metaAdId || "-"}</p>
                          <p>Creative ID: {item.metaCreativeId || "-"}</p>
                          <p>Meta Video ID: {historyMetaVideoId || "-"}</p>
                          <p>Image hash: {historyImageHash || "-"}</p>
                          <p>publicUrl present: {payload.creativeUrl ? "yes" : "no"}</p>
                          <p>thumbnailUrl present: {historyThumbnailUrl ? "yes" : "no"}</p>
                          <p>video upload: {historyVideoUploadMode || "-"}</p>
                          <p>processing: {historyVideoProcessingStatus || "-"}</p>
                          <p>thumbnail source: {historyThumbnailSource || "-"}</p>
                          <p>файл: {typeof payload.fileName === "string" ? payload.fileName : "-"}</p>
                          <p>MIME: {typeof payload.mimeType === "string" ? payload.mimeType : "-"}</p>
                        </div>
                      ) : null}
                    </div>
                  </details>

                  <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                    {mode === "video_processing" && historyMetaVideoId ? (
                      <button type="button" className="neu-btn justify-center" disabled={checking} onClick={() => void recheckHistoryVideo(item)}>
                        {checking ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}
                        Проверить готовность видео
                      </button>
                    ) : null}
                    {isRealLaunch ? (
                      <a className="neu-btn justify-center" href={adsManagerUrl} target="_blank" rel="noopener noreferrer">
                        <ExternalLink size={16} />
                        Открыть Ads Manager
                      </a>
                    ) : null}
                    <button type="button" className="neu-btn justify-center" onClick={() => repeatLaunchFromHistory(item)}>
                      <Rocket size={16} />
                      Повторить запуск с этими параметрами
                    </button>
                  </div>
                </article>
              );
            })}
          </section>
        )}
      </div>
    );
  }

  const stepContent = [renderCreativeStep, renderBriefStep, renderAiStep, renderComplianceStep, renderReportStep, renderLaunchStep][currentStep - 1]();
  const activeClientStep = clientStepForInternal(currentStep);
  const creativeReadinessInfo = readCreativeReadiness();
  const creativeReadiness: ReadinessState =
    creativeReadinessInfo.status === "ready_for_meta" || creativeReadinessInfo.status === "optimization_ready"
      ? "ready"
      : creativeReadinessInfo.status === "failed" ||
          creativeReadinessInfo.status === "too_large" ||
          creativeReadinessInfo.status === "optimization_failed" ||
          creativeReadinessInfo.status === "direct_upload_too_large_disabled"
        ? "error"
        : creativeReadinessInfo.status === "uploading" ||
            creativeReadinessInfo.status === "generating_thumbnail" ||
            creativeReadinessInfo.status === "optimizing" ||
            creativeReadinessInfo.status === "config_loading"
          ? "checking"
          : "action";
  const parametersReadiness: ReadinessState =
    brief.service.trim() && selectedCity.labelRu && Number(brief.dailyBudget) > 0 && brief.destinationValue.trim() ? "ready" : "action";
  const previewReadinessInfo = getPreviewReadiness({
    creativeReadiness: creativeReadinessInfo,
    brief,
    cityLabel: selectedCity.labelRu,
    adText: previewAdText,
  });
  const previewReadiness: ReadinessState =
    compliance?.status === "blocked" ? "error" : previewReadinessInfo.isReady ? "ready" : loading === "ai" || loading === "check" ? "checking" : "action";
  const metaReadiness: ReadinessState = loading === "health" ? "checking" : metaSummary?.configured ? "ready" : "action";
  const storageReadiness: ReadinessState =
    uploadStatus === "failed" ? "error" : creativeReadinessInfo.isReadyForMeta || storageHealth?.publicUrlWorks || hasSupabaseFrontendEnv ? "ready" : loading === "storage" ? "checking" : "action";
  const summaryRows = [
    ["Клиника", clinicName],
    ["Услуга", brief.service],
    ["Город", selectedCity.labelRu || brief.city],
    ["Площадка", "Instagram"],
    ["Бюджет в день", `${brief.dailyBudget || 0} USD`],
    ["Примерный общий бюджет", `${totalBudget} USD`],
    ["Назначение", destination.label],
    ["Статус", "будет создана выключенной"],
  ];

  return (
    <PageLayout>
      <div className="mx-auto max-w-[1440px] space-y-6 px-4 py-5 sm:px-6 lg:px-8">
        <header className="rounded-[28px] border border-white/70 bg-white/82 p-5 shadow-[0_18px_55px_rgba(15,118,110,0.10)] sm:p-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.18em] text-[#0D9488]">
                {isHistoryView ? "Negis OS · Реклама" : "Meta Ads · Clean Medical"}
              </p>
              <h1 className="mt-2 text-3xl font-black text-[#0F172A] sm:text-4xl">
                {isHistoryView ? "История запусков рекламы" : "Запуск рекламы в Meta"}
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-relaxed text-[#64748B]">
                {isHistoryView
                  ? "Здесь видно, что было создано в Meta, какие запуски требуют внимания и какой следующий шаг нужен клинике."
                  : "Спокойный мастер для клиники: загрузите креатив, заполните параметры, проверьте предпросмотр и создайте кампанию выключенной."}
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap xl:justify-end">
              <div className="inline-flex rounded-2xl border border-[#D8E4EC] bg-[#F8FCFB] p-1">
                {(["client", "admin"] as UiMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`rounded-xl px-3 py-2 text-xs font-black transition ${
                      uiMode === mode ? "bg-[#0D9488] text-white shadow-sm" : "text-[#64748B] hover:bg-white"
                    }`}
                    onClick={() => setUiMode(mode)}
                  >
                    {mode === "client" ? "Клиентский режим" : "Админ режим"}
                  </button>
                ))}
              </div>
              <Link href="/ads">
                <button type="button" className="neu-btn justify-center">
                  <Megaphone size={16} />
                  Раздел рекламы
                </button>
              </Link>
              <button
                type="button"
                className={`${isHistoryView ? "neu-btn-primary" : "neu-btn"} justify-center`}
                onClick={() => setLocation(isHistoryView ? "/ads-automation" : "/ads-automation/history")}
              >
                {isHistoryView ? <Rocket size={16} /> : <History size={16} />}
                {isHistoryView ? "Создать рекламу" : "История запусков"}
              </button>
              {!isHistoryView ? (
                <button type="button" className="neu-btn-primary justify-center" disabled={loading === "health"} onClick={() => void checkHealth()}>
                  {loading === "health" ? <Loader2 className="animate-spin" size={16} /> : <ShieldCheck size={16} />}
                  Проверить Meta
                </button>
              ) : null}
            </div>
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
            <nav className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Шаги запуска рекламы">
              {clientWizardSteps.map((item, index) => {
                const step = index + 1;
                const active = step === activeClientStep;
                const done = step < activeClientStep;
                return (
                  <button
                    key={item.label}
                    type="button"
                    className={`rounded-[24px] border px-4 py-4 text-left shadow-sm transition ${
                      active
                        ? "border-[#0D9488] bg-white text-[#0F172A] shadow-[0_16px_38px_rgba(13,148,136,0.14)]"
                        : done
                          ? "border-emerald-200 bg-white/78 text-emerald-800"
                          : "border-[#D8E4EC] bg-white/58 text-[#64748B] hover:bg-white/80"
                    }`}
                    onClick={() => goToStep(item.targetStep)}
                  >
                    <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#E6F7F5] text-xs font-black text-[#0D9488]">{step}</span>
                    <span className="mt-3 block text-base font-black">{item.label}</span>
                    <span className="mt-1 block text-xs font-semibold leading-relaxed">{item.description}</span>
                  </button>
                );
              })}
            </nav>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
              <div className="min-w-0">{stepContent}</div>
              <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start">
                <section className="rounded-[28px] border border-white/70 bg-white/86 p-5 shadow-[0_18px_50px_rgba(15,118,110,0.10)]">
                  <div className="flex items-center gap-2">
                    <ClipboardList size={18} className="text-[#0D9488]" />
                    <h2 className="text-base font-black text-[#0F172A]">Сводка запуска</h2>
                  </div>
                  <div className="mt-4 grid gap-3 text-sm">
                    {summaryRows.map(([label, value]) => (
                      <div key={label} className="rounded-2xl border border-[#E2EDF2] bg-[#F8FCFB] px-4 py-3">
                        <p className="text-[11px] font-black uppercase tracking-[0.1em] text-[#6B7B8F]">{label}</p>
                        <p className="mt-1 break-words font-bold text-[#0F172A]">{value || "-"}</p>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="rounded-[28px] border border-white/70 bg-white/86 p-5 shadow-[0_18px_50px_rgba(15,118,110,0.10)]">
                  <div className="flex items-center gap-2">
                    <Sparkles size={18} className="text-[#0D9488]" />
                    <h2 className="text-base font-black text-[#0F172A]">Готовность</h2>
                  </div>
                  <div className="mt-4 space-y-2">
                    <ReadinessRow label="Креатив" state={creativeReadiness} note={creativeReadinessInfo.label} />
                    <ReadinessRow label="Параметры" state={parametersReadiness} note={`${selectedCity.labelRu || "Город"} · ${destination.label}`} />
                    <ReadinessRow label="Предпросмотр" state={previewReadiness} note={previewReadinessInfo.isReady ? "Реклама готова к проверке" : previewReadinessInfo.message} />
                    <ReadinessRow label="Meta" state={metaReadiness} note={metaSummary?.configured ? "Подключение найдено" : "Проверьте подключение"} />
                    <ReadinessRow label="Storage" state={storageReadiness} note={creativeReadinessInfo.isReadyForMeta ? "Файл готов" : "Файл подготовится после загрузки"} />
                  </div>
                </section>

                <section className="rounded-[28px] border border-emerald-200 bg-emerald-50 p-5">
                  <div className="flex items-start gap-3">
                    <ShieldCheck className="mt-0.5 text-emerald-700" size={20} />
                    <div>
                      <p className="font-black text-emerald-950">Безопасный режим</p>
                      <p className="mt-1 text-sm font-semibold leading-relaxed text-emerald-800">
                        Реклама создаётся выключенной. Деньги не тратятся, пока её вручную не включат в Ads Manager.
                      </p>
                    </div>
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

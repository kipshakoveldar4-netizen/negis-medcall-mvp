import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useLocation } from "wouter";
import {
  ArrowRight,
  Check,
  Clapperboard,
  Copy,
  Download,
  FileText,
  ImagePlus,
  Megaphone,
  RefreshCw,
  Rocket,
  Send,
  Sparkles,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { PageLayout } from "@/components/layout/PageLayout";
import { useAuth } from "@/contexts/AuthContext";
import { apiUrl, CrmApiError, crmFetch } from "@/lib/api";
import { supabase, sessionAuth, hasSupabaseFrontendEnv } from "@/lib/supabase";
import { getSupabaseAccessToken } from "@/lib/serverAuth";
import { getSignOutRevision, isSignOutPending } from "@/lib/authSignOut";
import { uploadVerifiedCreativeImage, type VerifiedCreativeAsset } from "@/lib/verified-creative-upload";
import { parseGenerationUsageSummary, type GenerationUsageSummary } from "@/lib/contentGenerationUsage";
import {
  generatedVideoStorageKey, parseAcceptedGeneratedVideo, parseGeneratedVideoDraft, parseGeneratedVideoPoll, parseRecoverableGeneratedVideo,
  requireGeneratedVideoRetryReceipt, serializeGeneratedVideoDraft,
  type GeneratedVideoJobSnapshot, type NativeGeneratedVideoReceipt,
} from "@/lib/generated-video-receipt";
import { isRealWorkspace, readWorkspaceId, workspaceScopedKey } from "@/lib/demoStorage";
import {
  ADVERTISING_CAMPAIGN_PREFILL_KEY,
  ADVERTISING_CONTENT_STUDIO_PREFILL_KEY,
  ADVERTISING_CONTENT_APPROVAL_VERSION,
  createAdvertisingCampaignPrefill,
  normalizeAdvertisingContentApproval,
  parseAdvertisingCampaignPrefillForPlatform,
  type AdvertisingContentApproval,
  type AdvertisingCampaignPrefillInput,
} from "../../../../lib/advertising/campaignBrief";
import { checkMetaCompliance } from "../../../../lib/meta/compliance";
import { demoAvatarPrompt, demoContentPackage, demoScriptPackage, demoTapNowPrompt, type ContentAdVariant, type ContentPackage } from "../../../../lib/content-studio/core";
import {
  clearStoredPaidGenerationAttempt,
  readStoredPaidGenerationAttempt,
  resolvePaidGenerationAttempt,
  shouldKeepPaidGenerationAttempt,
  writeStoredPaidGenerationAttempt,
  type PaidGenerationAttempt,
  type PaidGenerationKind,
} from "../../../../lib/content-studio/paid-generation";
import {
  reserveTelegramDelivery, confirmTelegramDelivery, releaseUnsentTelegramDelivery, readContentVideoVersion,
  type TelegramDeliveryReceipt,
} from "../../../../lib/content-studio/telegram-delivery-guard";

type ContentVideoStatus = "idea" | "script_ready" | "avatar_ready" | "telegram_ready";

type ContentVideo = {
  id: string;
  title: string;
  niche: string;
  goal: string;
  duration: string;
  style: string;
  audience: string;
  hook?: string;
  script?: string;
  voiceover?: string;
  cta?: string;
  caption?: string;
  hashtags?: string[];
  avatarPrompt?: string;
  tapnowPrompt?: string;
  contentApproval?: AdvertisingContentApproval;
  status: ContentVideoStatus;
  createdAt: string;
  updatedAt?: string;
};

type ContentLibrarySnapshot = {
  form: Omit<ContentVideo, "id" | "status" | "createdAt" | "updatedAt">;
  videos: ContentVideo[];
  activeId: string;
};

type ContentLibraryWrite = {
  session: AbortController;
  snapshot: ContentLibrarySnapshot;
  storageKey: string;
  published?: ContentLibrarySnapshot;
  persistence?: "server" | "local";
};

type ScriptPackage = Pick<ContentVideo, "hook" | "script" | "voiceover" | "cta" | "caption" | "hashtags">;

type PromptPackage = {
  prompt: string;
  negativePrompt?: string;
  format?: "photo" | "video";
};

type ApiResponse<TData> =
  | {
      success: true;
      mode: string;
      warning?: string;
      data: TData;
    }
  | {
      success: false;
      error: string;
      details?: string[];
      telegramDescription?: string;
      telegramErrorCode?: number;
      status?: number;
      part?: number;
      totalParts?: number;
      hint?: string;
      code?: string;
      accepted?: boolean;
      data?: unknown;
    };

type TelegramResponse = {
  sent: boolean;
  packageText: string;
  test: boolean;
  parts?: number;
  replayed?: boolean;
  testRequestId?: string;
};

function createContentApproval(
  packageId: string,
  variant: ContentAdVariant,
): AdvertisingContentApproval {
  return {
    ...(packageId ? { packageId } : {}),
    variantId: variant.id,
    variantLabel: variant.label,
    variantAngle: variant.angle,
    version: ADVERTISING_CONTENT_APPROVAL_VERSION,
    approvedAt: new Date().toISOString(),
    approvedCopy: {
      primaryText: variant.primaryText,
      headline: variant.headline,
      description: variant.description,
    },
  };
}

const STORAGE_KEY = "negis_content_studio_videos";

type AdsAutomationPrefillInput = Omit<AdvertisingCampaignPrefillInput, "platform">;
type AdvertisingGoalContext = Pick<
  AdvertisingCampaignPrefillInput,
  "targetPatients" | "durationDays" | "maxBudget" | "dailyBudget" | "budgetCurrency"
>;

function writeAdsAutomationPrefill(input: AdsAutomationPrefillInput, storageKey = workspaceScopedKey(ADVERTISING_CAMPAIGN_PREFILL_KEY)) {
  const prefill = createAdvertisingCampaignPrefill({
    ...input,
    platform: "meta",
    generatedAt: input.generatedAt || new Date().toISOString(),
  });
  localStorage.setItem(
    storageKey,
    JSON.stringify(prefill),
  );
}

type PackageBrief = {
  mode: string;
  format: string;
  service: string;
  city: string;
  offer: string;
  audience: string;
  goal: string;
  tone: string;
  materialNotes: string;
};

const packageModes = [
  { id: "idea", label: "Из идеи" },
  { id: "materials", label: "Из материалов клиники" },
  { id: "ads", label: "Для рекламы" },
  { id: "social", label: "Для соцсетей" },
];

const packageFormats = [
  { id: "reels", label: "Reels 9:16" },
  { id: "tiktok", label: "TikTok 9:16" },
  { id: "stories", label: "Stories 9:16" },
  { id: "feed", label: "Feed 1:1" },
  { id: "universal", label: "Universal" },
];

const packageGoals = [
  { id: "leads", label: "Заявки" },
  { id: "awareness", label: "Узнаваемость" },
  { id: "appointment", label: "Запись на приём" },
  { id: "post", label: "Контент-пост" },
];

const packageTones = ["экспертно", "доверительно", "легко", "премиально"];

const defaultPackageBrief: PackageBrief = {
  mode: "idea",
  format: "reels",
  service: "Консультация косметолога",
  city: "Астана",
  offer: "Бесплатная первичная консультация",
  audience: "Женщины 25-45, уход за кожей",
  goal: "leads",
  tone: "доверительно",
  materialNotes: "",
};

const DEMO_AI_NOTICE = "ИИ-провайдер не подключён: показан образец, а не результат генерации.";

// Настоящая генерация файла. В отличие от текста, у неё нет демо-режима:
// картинки-заготовки не бывает, поэтому сервер отвечает честным «не
// подключено», а экран показывает этот ответ дословно, включая имя переменной
// окружения, которую должен задать владелец.
type GenerationNotice = { tone: "error" | "warning" | "info"; text: string };

type GeneratedFile = {
  url: string;
  assetId?: string;
  fileName?: string;
  mimeType: string;
  model: string;
  fileSize: number;
  thumbnailUrl?: string;
  thumbnailSource?: string;
};

type GeneratedVideoFile = GeneratedFile & Pick<NativeGeneratedVideoReceipt, "nativeValidated" | "validationJobId" | "sha256">;

type VideoJobState = GeneratedVideoJobSnapshot;

const VIDEO_POLL_INTERVAL_MS = 12_000;

/**
 * Задача рендера переживает уход со страницы.
 *
 * Ролик рендерится минутами и уже оплачен в момент постановки задачи. Если
 * подписанный идентификатор жил бы только в состоянии React, любой переход на
 * соседний экран терял бы его: провайдер досчитал бы ролик, деньги списались
 * бы, а забрать файл стало бы нечем. Поэтому задача лежит в localStorage под
 * ключом рабочего пространства.
 *
 * В хранилище остаётся только дескриптор задачи, отдельно для пользователя и
 * пространства. Публичные ссылки восстанавливаются только из свежей серверной
 * квитанции: локальный черновик не подтверждает завершение обработки.
 */
const VIDEO_JOB_KEY = "negis_content_studio_video_job";

function readStoredVideoJob(key: string, owner: { actorId: string; workspaceId: string }): VideoJobState | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return parseGeneratedVideoDraft(raw, owner);
  } catch {
    return null;
  }
}

function writeStoredVideoJob(value: VideoJobState | null, key: string, owner: { actorId: string; workspaceId: string }) {
  try {
    if (value) localStorage.setItem(key, serializeGeneratedVideoDraft(value, owner));
    else localStorage.removeItem(key);
  } catch {
    // Переполненное или запрещённое хранилище не должно ронять генерацию:
    // задача продолжит опрашиваться в этой вкладке.
  }
}

const videoJobLabels: Record<VideoJobState["status"], string> = {
  queued: "Ролик в очереди",
  in_progress: "Ролик рендерится",
  completed: "Ролик готов",
  failed: "Не удалось подтвердить готовность",
};

function formatFileSize(bytes: number): string {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

type PhotoFormatId = "story" | "feed" | "universal";
type PhotoLayoutId = "top_bottom" | "gradient_bottom" | "medical_card" | "minimal_premium";

type PhotoCreativeTexts = {
  headline: string;
  offer: string;
  cta: string;
  disclaimer: string;
};

const photoFormats: Array<{ id: PhotoFormatId; label: string; width: number; height: number }> = [
  { id: "story", label: "Reels/Stories 9:16", width: 1080, height: 1920 },
  { id: "feed", label: "Feed 1:1", width: 1080, height: 1080 },
  { id: "universal", label: "Universal 4:5", width: 1080, height: 1350 },
];

const photoLayouts: Array<{ id: PhotoLayoutId; label: string }> = [
  { id: "top_bottom", label: "Заголовок сверху + CTA снизу" },
  { id: "gradient_bottom", label: "Тёмный градиент снизу" },
  { id: "medical_card", label: "Чистая медицинская карточка" },
  { id: "minimal_premium", label: "Минимальный премиум" },
];

const photoSourceTypes = ["Фото врача", "Кабинет клиники", "Процедура", "Общее фото клиники"];

const defaultPhotoTexts: PhotoCreativeTexts = {
  headline: "Консультация косметолога",
  offer: "Бесплатная первичная консультация",
  cta: "Записаться в WhatsApp",
  disclaimer: "Имеются противопоказания. Необходима консультация специалиста.",
};

function loadCanvasImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Не удалось загрузить фото для макета"));
    image.src = url;
  });
}

function wrapCanvasText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (ctx.measureText(word).width > maxWidth) {
      if (line) lines.push(line);
      line = "";
      for (const character of word) {
        if (ctx.measureText(character).width > maxWidth) throw new Error("Текст не помещается в макет. Сократите его и повторите.");
        if (line && ctx.measureText(line + character).width > maxWidth) {
          lines.push(line);
          line = "";
        }
        line += character;
      }
      continue;
    }
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawWrapped(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): number {
  const lines = wrapCanvasText(ctx, text, maxWidth);
  lines.forEach((line, index) => ctx.fillText(line, x, y + index * lineHeight));
  return y + lines.length * lineHeight;
}

function drawFittedCanvasLine(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number): number {
  const originalFont = ctx.font;
  const size = Number(originalFont.match(/([\d.]+)px/)?.[1]);
  if (!Number.isFinite(size) || size <= 0) throw new Error("Не удалось определить шрифт макета.");
  const minimum = Math.max(12, Math.ceil(size / 2));
  try {
    for (let current = size; current >= minimum; current -= 1) {
      ctx.font = originalFont.replace(/[\d.]+px/, `${current}px`);
      const width = ctx.measureText(text).width;
      if (width <= maxWidth) {
        ctx.fillText(text, x, y);
        return width;
      }
    }
    throw new Error("Текст не помещается в макет. Сократите подпись или дисклеймер и повторите.");
  } finally {
    ctx.font = originalFont;
  }
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Browser-only renderer: cover-fit the photo into the target format and paint
// one of the safe preset layouts. Exported as JPEG via canvas.toBlob.
export async function renderPhotoCreative(input: {
  imageUrl: string;
  width: number;
  height: number;
  layout: PhotoLayoutId;
  texts: PhotoCreativeTexts;
}): Promise<Blob | null> {
  const image = await loadCanvasImage(input.imageUrl);
  const { width, height, layout, texts } = input;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const scale = Math.max(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);

  const margin = Math.round(width * 0.07);
  const contentWidth = width - margin * 2;
  const headlineFont = `900 ${Math.round(width * 0.062)}px Inter, Arial, sans-serif`;
  const offerFont = `600 ${Math.round(width * 0.04)}px Inter, Arial, sans-serif`;
  const ctaFont = `800 ${Math.round(width * 0.038)}px Inter, Arial, sans-serif`;
  const headlineLine = Math.round(width * 0.075);
  const offerLine = Math.round(width * 0.052);

  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  if (layout === "top_bottom") {
    ctx.font = headlineFont;
    const headlineLines = wrapCanvasText(ctx, texts.headline, contentWidth);
    const bandHeight = margin * 1.2 + headlineLines.length * headlineLine;
    ctx.fillStyle = "rgba(255,255,255,0.94)";
    ctx.fillRect(0, 0, width, bandHeight);
    ctx.fillStyle = "#0F172A";
    drawWrapped(ctx, texts.headline, margin, margin * 0.7, contentWidth, headlineLine);

    ctx.font = offerFont;
    const offerLines = wrapCanvasText(ctx, texts.offer, contentWidth);
    const bottomBand = margin * 2.4 + offerLines.length * offerLine + Math.round(width * 0.1);
    if (bandHeight + bottomBand + margin > height) throw new Error("Текст не помещается в макет. Сократите заголовок или оффер и повторите.");
    ctx.fillStyle = "rgba(255,255,255,0.94)";
    ctx.fillRect(0, height - bottomBand, width, bottomBand);
    ctx.fillStyle = "#334155";
    const afterOffer = drawWrapped(ctx, texts.offer, margin, height - bottomBand + margin * 0.6, contentWidth, offerLine);
    ctx.fillStyle = "#0D9488";
    const buttonWidth = Math.min(contentWidth, width * 0.62);
    const buttonPadding = Math.round(width * 0.04);
    drawRoundedRect(ctx, margin, afterOffer + margin * 0.3, buttonWidth, Math.round(width * 0.09), Math.round(width * 0.045));
    ctx.fill();
    ctx.fillStyle = "#FFFFFF";
    ctx.font = ctaFont;
    drawFittedCanvasLine(ctx, texts.cta, margin + buttonPadding, afterOffer + margin * 0.3 + Math.round(width * 0.026), buttonWidth - buttonPadding * 2);
  }

  if (layout === "gradient_bottom") {
    const gradient = ctx.createLinearGradient(0, height * 0.45, 0, height);
    gradient.addColorStop(0, "rgba(2,6,23,0)");
    gradient.addColorStop(1, "rgba(2,6,23,0.88)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, height * 0.45, width, height * 0.55);

    ctx.font = offerFont;
    const offerLines = wrapCanvasText(ctx, texts.offer, contentWidth);
    ctx.font = headlineFont;
    const headlineLines = wrapCanvasText(ctx, texts.headline, contentWidth);
    const blockHeight = headlineLines.length * headlineLine + offerLines.length * offerLine + Math.round(width * 0.16);
    let cursor = height - blockHeight - margin;
    if (cursor < margin) throw new Error("Текст не помещается в макет. Сократите заголовок или оффер и повторите.");
    ctx.fillStyle = "#FFFFFF";
    cursor = drawWrapped(ctx, texts.headline, margin, cursor, contentWidth, headlineLine);
    ctx.font = offerFont;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    cursor = drawWrapped(ctx, texts.offer, margin, cursor + Math.round(width * 0.015), contentWidth, offerLine);
    ctx.fillStyle = "#2DD4BF";
    ctx.font = ctaFont;
    drawFittedCanvasLine(ctx, `→ ${texts.cta}`, margin, cursor + Math.round(width * 0.02), contentWidth);
  }

  if (layout === "medical_card") {
    ctx.font = headlineFont;
    const headlineLines = wrapCanvasText(ctx, texts.headline, contentWidth - margin);
    ctx.font = offerFont;
    const offerLines = wrapCanvasText(ctx, texts.offer, contentWidth - margin);
    const cardHeight = headlineLines.length * headlineLine + offerLines.length * offerLine + Math.round(width * 0.22);
    const cardTop = height - cardHeight - margin;
    if (cardTop < margin) throw new Error("Текст не помещается в макет. Сократите заголовок или оффер и повторите.");
    ctx.fillStyle = "rgba(255,255,255,0.97)";
    drawRoundedRect(ctx, margin * 0.7, cardTop, width - margin * 1.4, cardHeight, Math.round(width * 0.03));
    ctx.fill();
    ctx.fillStyle = "#0D9488";
    ctx.fillRect(margin * 0.7, cardTop, Math.round(width * 0.012), cardHeight);
    ctx.fillStyle = "#0F172A";
    ctx.font = headlineFont;
    let cursor = drawWrapped(ctx, texts.headline, margin * 1.3, cardTop + margin * 0.6, contentWidth - margin, headlineLine);
    ctx.fillStyle = "#475569";
    ctx.font = offerFont;
    cursor = drawWrapped(ctx, texts.offer, margin * 1.3, cursor + Math.round(width * 0.012), contentWidth - margin, offerLine);
    ctx.fillStyle = "#0D9488";
    ctx.font = ctaFont;
    drawFittedCanvasLine(ctx, texts.cta, margin * 1.3, cursor + Math.round(width * 0.015), contentWidth - margin);
  }

  if (layout === "minimal_premium") {
    ctx.fillStyle = "rgba(15,23,42,0.30)";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#FFFFFF";
    ctx.font = `700 ${Math.round(width * 0.05)}px Georgia, 'Times New Roman', serif`;
    const cursor = drawWrapped(ctx, texts.headline.toUpperCase(), margin, margin, contentWidth, Math.round(width * 0.068));
    ctx.fillRect(margin, cursor + Math.round(width * 0.012), Math.round(width * 0.14), 3);
    ctx.font = offerFont;
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    const afterOffer = drawWrapped(ctx, texts.offer, margin, cursor + Math.round(width * 0.04), contentWidth, offerLine);
    ctx.font = ctaFont;
    ctx.fillStyle = "#FFFFFF";
    const ctaY = height - margin - Math.round(width * 0.05);
    if (afterOffer + margin * 0.3 > ctaY) throw new Error("Текст не помещается в макет. Сократите заголовок или оффер и повторите.");
    const ctaWidth = drawFittedCanvasLine(ctx, texts.cta, margin, ctaY, contentWidth);
    ctx.fillRect(margin, ctaY + Math.round(width * 0.05), ctaWidth, 2);
  }

  if (texts.disclaimer.trim()) {
    ctx.font = `500 ${Math.round(width * 0.02)}px Inter, Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillStyle = layout === "top_bottom" || layout === "medical_card" ? "rgba(51,65,85,0.85)" : "rgba(255,255,255,0.8)";
    drawFittedCanvasLine(ctx, texts.disclaimer, width / 2, height - Math.round(width * 0.035), contentWidth);
    ctx.textAlign = "left";
  }

  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.92));
}

const complianceRules = [
  "Без гарантий результата",
  "Без «100% результат»",
  "Без диагностики по внешности",
  "Без нереалистичных обещаний «до/после»",
  "Без давления и медицинских страхов",
];

const inputStyle: CSSProperties = {
  width: "100%",
  borderRadius: 10,
  border: "1px solid #E7ECF3",
  background: "#F8FAFC",
  color: "#0B1220",
  fontSize: 13,
  padding: "10px 12px",
  outline: "none",
};

const labelStyle: CSSProperties = {
  display: "block",
  marginBottom: 6,
  fontSize: 11,
  fontWeight: 800,
  color: "#64748B",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const initialVideo: Omit<ContentVideo, "id" | "status" | "createdAt" | "updatedAt"> = {
  title: "Почему клиника теряет заявки после рекламы",
  niche: "медицинский маркетинг",
  goal: "получить больше записей из рекламных лидов",
  duration: "30-45 seconds",
  style: "экспертный разбор",
  audience: "собственники клиник, маркетологи и администраторы",
  hook: "",
  script: "",
  voiceover: "",
  cta: "",
  caption: "",
  hashtags: [],
  avatarPrompt: "",
  tapnowPrompt: "",
};

/**
 * Раньше здесь стоял список из восьми шагов, среди которых были ElevenLabs,
 * HeyGen и CapCut. Ни один из трёх сервисов в коде не вызывается — экран
 * перечислял цепочку, которой не существует, и клиника могла решить, что
 * озвучка и монтаж происходят внутри продукта.
 *
 * Список теперь разделён: слева то, что действительно делает Negis, справа —
 * то, что остаётся делать руками во внешних инструментах. Если шаг переедет
 * внутрь продукта, он переезжает и здесь, а не наоборот.
 */
const workflow: Array<{ step: string; inProduct: boolean }> = [
  { step: "Пакет контента: сценарий, тексты объявления, prompts", inProduct: true },
  { step: "Изображение из описания", inProduct: true },
  { step: "Ролик из описания", inProduct: true },
  { step: "Фото-креатив из фотографии клиники", inProduct: true },
  { step: "Проверка формулировок и передача в запуск рекламы", inProduct: true },
  { step: "Озвучка диктором или синтезом речи", inProduct: false },
  { step: "Монтаж, субтитры, брендирование", inProduct: false },
  { step: "Публикация в соцсетях клиники", inProduct: false },
];

const statusLabels: Record<ContentVideoStatus, string> = {
  idea: "Идея",
  script_ready: "Сценарий готов",
  avatar_ready: "Prompts готовы",
  telegram_ready: "Пакет готов",
};

function newVideoId() {
  return `content-${Date.now()}`;
}

async function safeJson<TData>(response: Response): Promise<ApiResponse<TData> | null> {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as ApiResponse<TData>;
  } catch {
    return null;
  }
}


// Security-2D: Content Studio is authenticated now, and the workspace travels as
// a query selector the server verifies against the caller's membership — never
// as a field in the body.
function withWorkspace(path: string): string {
  const workspaceId = readWorkspaceId();
  return `${path}${path.includes("?") ? "&" : "?"}workspaceId=${encodeURIComponent(workspaceId)}`;
}

function handoffAccessDenied(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const { status, statusCode } = value as { status?: unknown; statusCode?: unknown };
  return [status, statusCode].some((code) => code === 401 || code === 403 || code === "401" || code === "403");
}

function paidGenerationHeaders(requestKey: string): Record<string, string> {
  return { "Content-Type": "application/json", "X-Idempotency-Key": requestKey };
}

const PAID_GENERATION_ATTEMPT_KEY = "negis_content_studio_paid_generation_attempt";

function paidGenerationAttemptKey(kind: PaidGenerationKind): string {
  return workspaceScopedKey(`${PAID_GENERATION_ATTEMPT_KEY}:${kind}`);
}

function readBrowserPaidGenerationAttempt(kind: PaidGenerationKind): PaidGenerationAttempt | null {
  return readStoredPaidGenerationAttempt(window.sessionStorage, paidGenerationAttemptKey(kind));
}

function writeBrowserPaidGenerationAttempt(kind: PaidGenerationKind, attempt: PaidGenerationAttempt): void {
  writeStoredPaidGenerationAttempt(window.sessionStorage, paidGenerationAttemptKey(kind), attempt);
}

function clearBrowserPaidGenerationAttempt(kind: PaidGenerationKind, key = paidGenerationAttemptKey(kind), expectedRequestKey?: string): void {
  try {
    if (expectedRequestKey && readStoredPaidGenerationAttempt(window.sessionStorage, key)?.requestKey !== expectedRequestKey) return;
    clearStoredPaidGenerationAttempt(window.sessionStorage, key);
  } catch { /* A receipt cleanup failure must not discard an accepted paid result. */ }
}

function parseContentVideo(value: unknown): ContentVideo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const video = value as ContentVideo;
  if (![video.id, video.title, video.niche, video.goal, video.duration, video.style, video.audience, video.createdAt]
    .every((item) => typeof item === "string") || !video.id.trim() || !video.title.trim()
    || !Number.isFinite(Date.parse(video.createdAt)) || typeof video.status !== "string" || !Object.hasOwn(statusLabels, video.status)) return null;
  const optionalText = [video.hook, video.script, video.voiceover, video.cta, video.caption, video.avatarPrompt, video.tapnowPrompt];
  if (optionalText.some((item) => item !== undefined && typeof item !== "string")
    || (video.hashtags !== undefined && (!Array.isArray(video.hashtags) || !video.hashtags.every((tag) => typeof tag === "string")))) return null;
  const contentApproval = normalizeAdvertisingContentApproval(video.contentApproval);
  if (video.contentApproval !== undefined && !contentApproval) return null;
  const updatedAt = readContentVideoVersion(video.updatedAt);
  if (video.updatedAt !== undefined && !updatedAt) return null;
  return {
    id: video.id, title: video.title, niche: video.niche, goal: video.goal, duration: video.duration,
    style: video.style, audience: video.audience, createdAt: video.createdAt, status: video.status,
    hook: video.hook, script: video.script, voiceover: video.voiceover, cta: video.cta, caption: video.caption,
    hashtags: video.hashtags, avatarPrompt: video.avatarPrompt, tapnowPrompt: video.tapnowPrompt,
    ...(contentApproval ? { contentApproval } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function readVideos(key = workspaceScopedKey(STORAGE_KEY)): ContentVideo[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const videos = parsed.map(parseContentVideo);
    return videos.every((video): video is ContentVideo => video !== null) ? videos : [];
  } catch {
    return [];
  }
}

function writeVideos(videos: ContentVideo[], key = workspaceScopedKey(STORAGE_KEY)) {
  localStorage.setItem(key, JSON.stringify(videos));
}

function combinePrompt(result: PromptPackage) {
  return [result.prompt, result.negativePrompt ? `Negative prompt: ${result.negativePrompt}` : null]
    .filter(Boolean)
    .join("\n\n");
}

function parseScriptPackage(value: unknown): ScriptPackage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const script = value as ScriptPackage;
  if (![script.hook, script.script, script.voiceover, script.cta, script.caption].every((item) => typeof item === "string")
    || !Array.isArray(script.hashtags) || !script.hashtags.every((tag) => typeof tag === "string")) return null;
  return { hook: script.hook, script: script.script, voiceover: script.voiceover, cta: script.cta, caption: script.caption, hashtags: script.hashtags };
}

function parsePromptPackage(value: unknown): PromptPackage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prompt = value as PromptPackage;
  if (typeof prompt.prompt !== "string" || !prompt.prompt.trim()
    || (prompt.negativePrompt !== undefined && typeof prompt.negativePrompt !== "string")
    || (prompt.format !== undefined && prompt.format !== "photo" && prompt.format !== "video")) return null;
  return { prompt: prompt.prompt, negativePrompt: prompt.negativePrompt, format: prompt.format };
}

function parseTelegramResponse(value: unknown, mode: string, test: boolean, packageText?: string, testRequestId?: string): TelegramResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as TelegramResponse;
  if (typeof result.sent !== "boolean" || result.test !== test || typeof result.packageText !== "string" || !result.packageText.trim()
    || (!test && result.packageText !== packageText)) return null;
  if (("replayed" in result && typeof result.replayed !== "boolean") || (result.replayed === true && !result.sent)
    || (test && ((result.sent && "replayed" in result) || "testRequestId" in result)
      && (typeof result.testRequestId !== "string" || result.testRequestId !== testRequestId))
    || (!test && "testRequestId" in result)) return null;
  if (result.sent ? mode !== "telegram" || !Number.isSafeInteger(result.parts) || (result.parts ?? 0) < 1
    : mode !== "demo" || result.parts !== undefined) return null;
  return { sent: result.sent, test: result.test, packageText: result.packageText, parts: result.parts,
    replayed: result.replayed, testRequestId: result.testRequestId };
}

function telegramErrorMessage<TData>(body: ApiResponse<TData> | null, fallback: string) {
  if (body?.success === false) {
    const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
    const details = Array.isArray(body.details) ? body.details.map(text).filter(Boolean).join(", ") : "";
    const description = details || text(body.telegramDescription) || text(body.error);
    const part = Number.isSafeInteger(body.part) && Number.isSafeInteger(body.totalParts)
      && body.part! > 0 && body.part! <= body.totalParts! ? `Часть ${body.part}/${body.totalParts}. ` : "";
    const hint = text(body.hint);
    return `${fallback}: ${part}${description || "Ответ сервера не подтверждён"}${hint ? `. ${hint}` : ""}`;
  }

  return fallback;
}

/**
 * Отказ сервера пересказывается оператору целиком: заголовок, подробности и
 * подсказка. Обрезать до одной строки здесь нельзя — в подробностях лежит имя
 * переменной окружения, без которого «не подключено» превращается в загадку.
 */
function generationRefusalText<TData>(body: ApiResponse<TData> | null, status: number, fallback: string): string {
  if (body?.success === false) {
    const parts = [body.error, ...(body.details || []), body.hint].filter(Boolean) as string[];
    // Заголовок часто дублирует первую подробность — показываем один раз.
    const unique = parts.filter((part, index) => parts.indexOf(part) === index);
    if (unique.length > 0) return unique.join(" — ");
  }
  return `${fallback} (HTTP ${status})`;
}

function buildTelegramPackage(video: ContentVideo) {
  return [
    `ИИ студия контента: ${video.title}`,
    video.hook ? `Hook:\n${video.hook}` : null,
    video.script ? `Script:\n${video.script}` : null,
    video.voiceover ? `Voiceover:\n${video.voiceover}` : null,
    video.cta ? `CTA:\n${video.cta}` : null,
    video.caption ? `Caption:\n${video.caption}` : null,
    video.hashtags?.length ? `Hashtags:\n${video.hashtags.join(" ")}` : null,
    video.avatarPrompt ? `Avatar prompt:\n${video.avatarPrompt}` : null,
    video.tapnowPrompt ? `TapNow prompt:\n${video.tapnowPrompt}` : null,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

function Field({
  label,
  value,
  onChange,
  textarea,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  textarea?: boolean;
}) {
  return (
    <label>
      <span style={labelStyle}>{label}</span>
      {textarea ? (
        <textarea
          style={{ ...inputStyle, minHeight: 108, resize: "vertical" }}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input style={inputStyle} value={value} onChange={(event) => onChange(event.target.value)} />
      )}
    </label>
  );
}

function SectionTitle({ icon: Icon, title, subtitle }: { icon: LucideIcon; title: string; subtitle?: string }) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#E0F2FE] text-[#0369A1]">
        <Icon size={19} />
      </div>
      <div>
        <h3 className="text-base font-black text-[#0B1220]">{title}</h3>
        {subtitle ? <p className="mt-1 text-sm leading-relaxed text-[#64748B]">{subtitle}</p> : null}
      </div>
    </div>
  );
}

function PromptBox({ title, value, onCopy }: { title: string; value?: string; onCopy: () => void }) {
  return (
    <div className="neu-sm p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs font-bold uppercase text-[#64748B]">{title}</p>
        <button className="neu-btn flex items-center gap-2 px-3 py-1.5 text-xs" onClick={onCopy} type="button">
          <Copy size={13} />
          Copy
        </button>
      </div>
      <textarea
        readOnly
        style={{ ...inputStyle, minHeight: 170, resize: "vertical", background: "#FFFFFF" }}
        value={value || "Данные появятся после генерации."}
      />
    </div>
  );
}

export default function ContentStudio() {
  const { user, userRole, clinicId, workspacePurpose, isLoading, isSigningOut, isDemoMode, isImpersonation } = useAuth();
  const actorId = !isLoading && !isSigningOut && !isDemoMode && !isImpersonation ? user?.id || "" : "";
  const workspaceId = clinicId || readWorkspaceId();
  const localDraftsOnly = isDemoMode && !isLoading && !isSigningOut && !isImpersonation
    && !isRealWorkspace(workspaceId) && readWorkspaceId() === workspaceId;
  const observedActorRef = useRef(user?.id || "");
  const [authEpoch, setAuthEpoch] = useState(0);
  useLayoutEffect(() => {
    if (!hasSupabaseFrontendEnv) return;
    const { data: { subscription } } = sessionAuth.onAuthStateChange((_event, session) => {
      const nextActor = session?.user.id || "";
      if (observedActorRef.current === nextActor) return;
      observedActorRef.current = nextActor;
      setAuthEpoch((value) => value + 1);
    });
    return () => subscription.unsubscribe();
  }, []);
  return <ContentStudioSession key={JSON.stringify([actorId, workspaceId, userRole, workspacePurpose, authEpoch, localDraftsOnly])} actorId={actorId} workspaceId={workspaceId} localDraftsOnly={localDraftsOnly} />;
}

function ContentStudioSession({ actorId, workspaceId, localDraftsOnly }: { actorId: string; workspaceId: string; localDraftsOnly: boolean }) {
  const [, setLocation] = useLocation();
  const sessionRef = useRef<AbortController | null>(null);
  const signOutRevisionRef = useRef(getSignOutRevision());
  useLayoutEffect(() => {
    const session = new AbortController();
    sessionRef.current = session;
    const subscription = hasSupabaseFrontendEnv
      ? sessionAuth.onAuthStateChange((_event, next) => {
          if ((next?.user.id || "") !== actorId) session.abort();
        }).data.subscription
      : null;
    return () => {
      session.abort();
      subscription?.unsubscribe();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [actorId, workspaceId]);

  function isSessionAlive(session: AbortController | null): session is AbortController {
    return Boolean(actorId && workspaceId && session && sessionRef.current === session && !session.signal.aborted
      && readWorkspaceId() === workspaceId && !isSignOutPending() && signOutRevisionRef.current === getSignOutRevision());
  }

  async function isGenerationSessionCurrent(session: AbortController | null): Promise<boolean> {
    if (!isSessionAlive(session)) return false;
    try {
      const token = await getSupabaseAccessToken(actorId);
      return Boolean(token && isSessionAlive(session));
    } catch { return false; }
  }

  function isHandoffSessionAlive(session: AbortController | null): session is AbortController {
    return Boolean(localDraftsOnly && !actorId && workspaceId
      && !isRealWorkspace(workspaceId) && readWorkspaceId() === workspaceId
      && session && sessionRef.current === session && !session.signal.aborted
      && !isSignOutPending() && signOutRevisionRef.current === getSignOutRevision()) || isSessionAlive(session);
  }

  async function isHandoffSessionCurrent(session: AbortController | null): Promise<boolean> {
    if (!isHandoffSessionAlive(session)) return false;
    return localDraftsOnly || await isGenerationSessionCurrent(session);
  }

  async function pollingSessionState(session: AbortController | null): Promise<"current" | "unverified" | "ended"> {
    if (await isGenerationSessionCurrent(session)) return "current";
    if (!isSessionAlive(session)) return "ended";
    try {
      const { data, error } = await supabase.auth.getSession();
      if (!isSessionAlive(session)) return "ended";
      if (!error && (data.session?.user.id || "") !== actorId) {
        session.abort();
        return "ended";
      }
    } catch { /* A temporary SDK outage does not invalidate an unchanged lifetime. */ }
    return "unverified";
  }
  const [form, setForm] = useState(initialVideo);
  const [videos, setVideos] = useState<ContentVideo[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  // Replacing this snapshot also invalidates work after a form/selection A-B-A.
  const librarySnapshotRef = useRef<ContentLibrarySnapshot>({ form, videos, activeId });
  const libraryWritePending = useRef<ContentLibraryWrite | null>(null);
  const libraryReadEpoch = useRef(0);
  const clipboardPending = useRef<object | null>(null);
  const libraryHandoffPending = useRef<object | null>(null);
  const libraryView = librarySnapshotRef.current;
  const libraryStorageKey = `${STORAGE_KEY}::${workspaceId}`;

  function beginLibraryWrite(snapshot: ContentLibrarySnapshot): ContentLibraryWrite | null {
    const session = sessionRef.current;
    if (libraryWritePending.current || !isHandoffSessionAlive(session) || librarySnapshotRef.current !== snapshot) return null;
    const write = { session, snapshot, storageKey: libraryStorageKey };
    libraryReadEpoch.current += 1;
    libraryWritePending.current = write;
    return write;
  }

  function isLibraryWriteCurrent(write: ContentLibraryWrite) {
    return libraryWritePending.current === write && isHandoffSessionAlive(write.session)
      && librarySnapshotRef.current === (write.published ?? write.snapshot);
  }

  async function isLibraryWriteVerified(write: ContentLibraryWrite) {
    return isLibraryWriteCurrent(write) && await isHandoffSessionCurrent(write.session) && isLibraryWriteCurrent(write);
  }

  const updateIdeaForm = (key: "title" | "niche" | "goal" | "audience" | "style" | "duration", value: string) => {
    const snapshot = librarySnapshotRef.current;
    if (snapshot.form[key] === value) return;
    const nextForm = { ...snapshot.form, [key]: value };
    librarySnapshotRef.current = { ...snapshot, form: nextForm };
    setForm(nextForm);
  };

  const selectLibraryVideo = (id: string) => {
    const snapshot = librarySnapshotRef.current;
    if (!isHandoffSessionAlive(sessionRef.current) || snapshot.activeId === id || !snapshot.videos.some((video) => video.id === id)) return;
    librarySnapshotRef.current = { ...snapshot, activeId: id };
    setActiveId(id);
  };
  const [loading, setLoading] = useState<"video" | "script" | "avatar" | "tapnow" | "telegram" | "telegram-test" | "package" | null>(null);
  const [notice, setNotice] = useState("");
  const [packageBrief, setPackageBrief] = useState<PackageBrief>(defaultPackageBrief);
  const packageBriefRef = useRef(packageBrief);
  const packageBriefRevision = useRef(0);
  const packageBriefViewRevision = packageBriefRevision.current;
  const packageGenerationPending = useRef<object | null>(null);
  const [advertisingGoalContext, setAdvertisingGoalContext] = useState<AdvertisingGoalContext>({});
  const advertisingGoalContextRef = useRef(advertisingGoalContext);
  const [contentPackage, setContentPackage] = useState<ContentPackage | null>(null);
  const [selectedAdVariantId, setSelectedAdVariantId] = useState("");
  const packageCopySnapshotRef = useRef({ contentPackage, selectedAdVariantId });
  const packageCopyView = packageCopySnapshotRef.current;

  function publishPackageContent(next: ContentPackage | null) {
    const snapshot = packageCopySnapshotRef.current;
    if (snapshot.contentPackage === next) return;
    packageCopySnapshotRef.current = { ...snapshot, contentPackage: next };
    setContentPackage(next);
  }

  function selectPackageVariant(id: string, expected = packageCopyView) {
    const snapshot = packageCopySnapshotRef.current;
    if (snapshot !== expected || snapshot.selectedAdVariantId === id
      || (id && !snapshot.contentPackage?.adVariants.some((variant) => variant.id === id))) return;
    packageCopySnapshotRef.current = { ...snapshot, selectedAdVariantId: id };
    setSelectedAdVariantId(id);
  }
  const [packageGenerationMode, setPackageGenerationMode] = useState("");
  const [contentPackageId, setContentPackageId] = useState("");
  const photoFileInputRef = useRef<HTMLInputElement | null>(null);
  const [photoSourceUrl, setPhotoSourceUrl] = useState("");
  const [photoSourceName, setPhotoSourceName] = useState("");
  const [photoSourceType, setPhotoSourceType] = useState(photoSourceTypes[0]);
  const [photoFormat, setPhotoFormat] = useState<PhotoFormatId>("story");
  const [photoLayout, setPhotoLayout] = useState<PhotoLayoutId>("gradient_bottom");
  const [photoTexts, setPhotoTexts] = useState<PhotoCreativeTexts>(defaultPhotoTexts);
  const photoTextInputsRef = useRef({ format: photoFormat, layout: photoLayout, sourceType: photoSourceType, sourceName: photoSourceName, sourceUrl: photoSourceUrl, texts: photoTexts });
  const photoTextRevision = useRef(0);
  const photoCopyView = photoTextInputsRef.current;
  const photoCopyViewRevision = photoTextRevision.current;
  const photoTextPending = useRef<object | null>(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState("");
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const photoArtifactRef = useRef<{
    blob: Blob; previewUrl: string; inputs: typeof photoTextInputsRef.current;
    revision: number; session: AbortController;
  } | null>(null);
  const photoRenderPending = useRef<object | null>(null);
  const photoHandoffPending = useRef<object | null>(null);
  const photoUploadAttempts = useRef(new WeakMap<Blob, { requestKey: string; fileName: string }>());
  const photoObjectUrls = useRef(new Set<string>());
  const [photoBusy, setPhotoBusy] = useState<"render" | "suggest" | "handoff" | null>(null);
  const [photoSuggestMode, setPhotoSuggestMode] = useState("");

  useLayoutEffect(() => () => {
    for (const url of photoObjectUrls.current) URL.revokeObjectURL(url);
    photoObjectUrls.current.clear();
    photoArtifactRef.current = null;
  }, []);

  function releasePhotoUrl(url: string) {
    if (photoObjectUrls.current.delete(url)) URL.revokeObjectURL(url);
  }

  function invalidatePhotoPreview() {
    const artifact = photoArtifactRef.current;
    photoArtifactRef.current = null;
    if (!artifact) return;
    releasePhotoUrl(artifact.previewUrl);
    setPhotoBlob(null);
    setPhotoPreviewUrl("");
  }

  function isPhotoArtifactCurrent(
    artifact: typeof photoArtifactRef.current,
    session: AbortController | null,
  ): artifact is NonNullable<typeof photoArtifactRef.current> {
    return Boolean(artifact && isHandoffSessionAlive(session) && artifact.session === session
      && photoArtifactRef.current === artifact && photoTextInputsRef.current === artifact.inputs
      && photoTextRevision.current === artifact.revision && artifact.blob === photoBlob
      && artifact.previewUrl === photoPreviewUrl);
  }

  const [genPrompt, setGenPrompt] = useState("");
  const [genFormat, setGenFormat] = useState("reels");
  const [genBusy, setGenBusy] = useState<"photo" | "video" | null>(null);
  const [genNotice, setGenNotice] = useState<GenerationNotice | null>(null);
  const [genImage, setGenImage] = useState<GeneratedFile | null>(null);
  const [genVideo, setGenVideo] = useState<GeneratedVideoFile | null>(null);
  const [videoJob, setVideoJob] = useState<VideoJobState | null>(null);
  const videoJobRef = useRef(videoJob);
  videoJobRef.current = videoJob;
  const videoCommandRef = useRef<object | null>(null);
  const [videoRetryBusy, setVideoRetryBusy] = useState(false);
  const [generationUsage, setGenerationUsage] = useState<GenerationUsageSummary | null>(null);
  const [generationUsageLoading, setGenerationUsageLoading] = useState(false);
  const usageRequestRef = useRef(0);
  const photoGenerationAttempt = useRef<PaidGenerationAttempt | null>(null);
  const videoGenerationAttempt = useRef<PaidGenerationAttempt | null>(null);
  const videoGenerationRevision = useRef(0);

  function videoJobStorageKey(): string {
    return generatedVideoStorageKey(VIDEO_JOB_KEY, { actorId, workspaceId });
  }

  function videoReceiptContext(validationJobId?: string) {
    const env = import.meta.env as Record<string, string | undefined>;
    return { workspaceId, storageOrigin: new URL(env.VITE_SUPABASE_URL || "").origin, validationJobId };
  }

  function clearGeneratedVideoAccess() {
    videoGenerationRevision.current += 1;
    setGenVideo(null);
    setVideoJob(null);
    writeStoredVideoJob(null, videoJobStorageKey(), { actorId, workspaceId });
    setGenNotice({ tone: "error", text: "Доступ к видео отозван. Обновите страницу." });
  }

  function displayGeneratedVideoReceipt(receipt: NativeGeneratedVideoReceipt) {
    setGenVideo({ url: receipt.creativeUrl, assetId: receipt.assetId, fileName: receipt.fileName,
      mimeType: receipt.mimeType, model: "", fileSize: receipt.fileSize, thumbnailUrl: receipt.thumbnailUrl,
      nativeValidated: true, validationJobId: receipt.validationJobId, sha256: receipt.sha256 });
  }

  const refreshGenerationUsage = useCallback(async () => {
    const session = sessionRef.current;
    if (!isSessionAlive(session)) return;
    const request = ++usageRequestRef.current;
    setGenerationUsage(null);
    setGenerationUsageLoading(true);
    try {
      const response = await crmFetch(withWorkspace("/api/content-studio/usage"), {
        expectedUserId: actorId, dispatchGuard: () => isSessionAlive(session), signal: session.signal, cache: "no-store",
      });
      const body = await safeJson<unknown>(response);
      if (!await isGenerationSessionCurrent(session) || request !== usageRequestRef.current) return;
      if (response.ok && body?.success === true) setGenerationUsage(parseGenerationUsageSummary(body.data));
    } catch {
      // The paid write still checks its quota server-side. A diagnostic read
      // must never replace the working studio with an error screen.
    } finally {
      if (isSessionAlive(session) && request === usageRequestRef.current) setGenerationUsageLoading(false);
    }
  }, [actorId, workspaceId]);

  useEffect(() => {
    void refreshGenerationUsage();
  }, [refreshGenerationUsage]);

  const writeContentToAdsAutomation = (input: AdsAutomationPrefillInput) =>
    writeAdsAutomationPrefill({ ...advertisingGoalContext, ...input }, `${ADVERTISING_CAMPAIGN_PREFILL_KEY}::${workspaceId}`);

  useEffect(() => {
    const key = workspaceScopedKey(ADVERTISING_CONTENT_STUDIO_PREFILL_KEY);
    const raw = window.localStorage.getItem(key);
    if (!raw) return;

    window.localStorage.removeItem(key);
    try {
      const incoming = parseAdvertisingCampaignPrefillForPlatform(JSON.parse(raw), "meta");
      if (!incoming || incoming.sourceModule !== "advertising-hub") return;

      const context: AdvertisingGoalContext = {
        targetPatients: incoming.targetPatients,
        durationDays: incoming.durationDays,
        maxBudget: incoming.maxBudget,
        dailyBudget: incoming.dailyBudget,
        budgetCurrency: incoming.budgetCurrency,
      };
      advertisingGoalContextRef.current = context;
      setAdvertisingGoalContext(context);

      const goalDetails = [
        incoming.targetPatients ? `${incoming.targetPatients} пациентов` : "",
        incoming.durationDays ? `${incoming.durationDays} дней` : "",
        incoming.maxBudget && incoming.budgetCurrency
          ? `лимит ${incoming.maxBudget.toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ${incoming.budgetCurrency}`
          : "",
      ].filter(Boolean);
      const goalNote = goalDetails.length > 0
        ? `Контекст рекламной цели: ${goalDetails.join(" · ")}. Не обещать достижение цели.`
        : "";

      const nextBrief = {
        ...packageBriefRef.current,
        mode: "ads",
        format: "reels",
        service: incoming.service || packageBriefRef.current.service,
        city: incoming.city || packageBriefRef.current.city,
        offer: incoming.offer || "",
        audience: incoming.audience || "",
        goal: "leads",
        materialNotes: goalNote,
      };
      packageBriefRevision.current += 1;
      packageBriefRef.current = nextBrief;
      setPackageBrief(nextBrief);
      setNotice(`Цель рекламы перенесена из рекламного центра${goalDetails.length > 0 ? `: ${goalDetails.join(" · ")}` : ""}. Дополните оффер и аудиторию. Генерация начнётся только после вашего нажатия.`);
      toast.success("Цель рекламы загружена");
    } catch {
      // Invalid local handoff is consumed and never allowed to break the studio.
    }
  }, []);

  const updatePhotoTexts = (key: keyof PhotoCreativeTexts, value: string) => {
    const inputs = photoTextInputsRef.current;
    if (inputs.texts[key] === value) return;
    const texts = { ...inputs.texts, [key]: value };
    photoTextRevision.current += 1;
    photoTextInputsRef.current = { ...inputs, texts };
    invalidatePhotoPreview();
    setPhotoTexts(texts);
  };

  const updatePhotoFormat = (format: PhotoFormatId) => {
    if (photoTextInputsRef.current.format === format) return;
    photoTextRevision.current += 1;
    photoTextInputsRef.current = { ...photoTextInputsRef.current, format };
    invalidatePhotoPreview();
    setPhotoFormat(format);
  };

  const updatePhotoLayout = (layout: PhotoLayoutId) => {
    if (photoTextInputsRef.current.layout === layout) return;
    photoTextRevision.current += 1;
    photoTextInputsRef.current = { ...photoTextInputsRef.current, layout };
    invalidatePhotoPreview();
    setPhotoLayout(layout);
  };

  const updatePhotoSourceType = (sourceType: string) => {
    if (photoTextInputsRef.current.sourceType === sourceType) return;
    photoTextRevision.current += 1;
    photoTextInputsRef.current = { ...photoTextInputsRef.current, sourceType };
    invalidatePhotoPreview();
    setPhotoSourceType(sourceType);
  };

  // Дисклеймер печатается на самом макете, но в проверку не отдавался — и
  // правило про дисклеймер требовало добавить то, что уже стоит на картинке.
  // Раньше этого не было видно: правило не срабатывало вообще ни на чём.
  // Проверять надо весь текст, который окажется на креативе, а не три поля из
  // четырёх.
  const photoCompliance = useMemo(
    () =>
      checkMetaCompliance({
        headline: photoTexts.headline,
        text: photoTexts.offer,
        description: [photoTexts.cta, photoTexts.disclaimer].filter(Boolean).join("\n"),
      }),
    [photoTexts],
  );

  const onPhotoFileSelected = (file: File | null) => {
    if (!isHandoffSessionAlive(sessionRef.current)) return;
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Загрузите изображение (JPG, PNG или WEBP)");
      return;
    }
    const sourceUrl = URL.createObjectURL(file);
    photoObjectUrls.current.add(sourceUrl);
    releasePhotoUrl(photoTextInputsRef.current.sourceUrl);
    photoTextRevision.current += 1;
    photoTextInputsRef.current = { ...photoTextInputsRef.current, sourceName: file.name, sourceUrl };
    invalidatePhotoPreview();
    setPhotoSourceUrl(sourceUrl);
    setPhotoSourceName(file.name);
  };

  const suggestPhotoTexts = async () => {
    const session = sessionRef.current;
    if (photoTextPending.current || !isHandoffSessionAlive(session)) return;
    const brief = packageBriefRef.current;
    const briefRevision = packageBriefRevision.current;
    const inputs = photoTextInputsRef.current;
    const revision = photoTextRevision.current;
    const attempt = {};
    photoTextPending.current = attempt;
    const isCurrent = () => photoTextPending.current === attempt && isHandoffSessionAlive(session)
      && packageBriefRef.current === brief && packageBriefRevision.current === briefRevision
      && photoTextInputsRef.current === inputs && photoTextRevision.current === revision;
    const isVerified = async () => isCurrent() && await isHandoffSessionCurrent(session) && isCurrent();
    setPhotoBusy("suggest");
    try {
      if (!await isVerified()) return;
      const payload = {
        mode: "ads",
        format: inputs.format,
        service: brief.service,
        city: brief.city,
        offer: brief.offer,
        audience: brief.audience,
        goal: brief.goal,
        tone: brief.tone,
        materialNotes: `${inputs.sourceType}${inputs.sourceName ? `: ${inputs.sourceName}` : ""}`,
      };
      let data: ContentPackage;
      let mode: string;
      if (localDraftsOnly) {
        data = demoContentPackage(payload);
        mode = "demo";
      } else {
        const response = await crmFetch(`/api/content-studio/generate-package?workspaceId=${encodeURIComponent(workspaceId)}`, {
          expectedUserId: actorId, dispatchGuard: isCurrent, signal: session.signal,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (handoffAccessDenied(response)) throw new Error("Доступ к подбору текстов отозван. Обновите страницу.");
        if (!await isVerified()) return;
        const body = await safeJson<ContentPackage>(response);
        if (!await isVerified()) return;
        if (!response.ok || body?.success !== true) {
          throw new Error(body?.success === false ? body.error : "Не удалось предложить тексты");
        }
        data = body.data;
        mode = body.mode;
      }
      if (!await isVerified()) return;
      if (!data || typeof mode !== "string" || ![data.adHeadline, data.adPrimaryText, data.cta].every((value) => typeof value === "string")) {
        throw new Error("Сервер вернул неполные тексты. Прежние поля сохранены.");
      }
      const texts = {
        ...inputs.texts,
        headline: data.adHeadline || inputs.texts.headline,
        offer: brief.offer || data.adPrimaryText.split(".")[0] || inputs.texts.offer,
        cta: data.cta || inputs.texts.cta,
      };
      photoTextRevision.current += 1;
      photoTextInputsRef.current = { ...inputs, texts };
      invalidatePhotoPreview();
      setPhotoTexts(texts);
      setPhotoSuggestMode(mode);
      toast.success(mode === "demo" ? "Образец текстов готов" : "Тексты готовы");
    } catch (error) {
      if (!await isVerified()) return;
      toast.error(handoffAccessDenied(error) ? "Доступ к подбору текстов отозван. Обновите страницу."
        : error instanceof Error ? error.message : "Ошибка генерации текстов");
    } finally {
      if (photoTextPending.current === attempt) {
        photoTextPending.current = null;
        if (session && sessionRef.current === session && !session.signal.aborted) {
          setPhotoBusy((current) => current === "suggest" ? null : current);
        }
      }
    }
  };

  const generatePhotoLayout = async (layoutOverride?: PhotoLayoutId) => {
    const session = sessionRef.current;
    if (photoRenderPending.current || !isHandoffSessionAlive(session)) return;
    if (!photoTextInputsRef.current.sourceUrl) {
      toast.error("Сначала загрузите фото клиники");
      return;
    }
    if (layoutOverride) updatePhotoLayout(layoutOverride);
    const inputs = photoTextInputsRef.current;
    const revision = photoTextRevision.current;
    const attempt = {};
    photoRenderPending.current = attempt;
    const isCurrent = () => photoRenderPending.current === attempt && isHandoffSessionAlive(session)
      && photoTextInputsRef.current === inputs && photoTextRevision.current === revision;
    const isVerified = async () => isCurrent() && await isHandoffSessionCurrent(session) && isCurrent();
    setPhotoBusy("render");
    try {
      if (!await isVerified()) return;
      const format = photoFormats.find((item) => item.id === inputs.format) || photoFormats[0];
      const blob = await renderPhotoCreative({
        imageUrl: inputs.sourceUrl,
        width: format.width,
        height: format.height,
        layout: inputs.layout,
        texts: inputs.texts,
      });
      if (!await isVerified()) return;
      if (!blob) throw new Error("Не удалось создать макет");
      const previewUrl = URL.createObjectURL(blob);
      photoObjectUrls.current.add(previewUrl);
      invalidatePhotoPreview();
      photoArtifactRef.current = { blob, previewUrl, inputs, revision, session };
      setPhotoBlob(blob);
      setPhotoPreviewUrl(previewUrl);
      toast.success("Макет креатива готов");
    } catch (error) {
      if (!await isVerified()) return;
      toast.error(error instanceof Error ? error.message : "Ошибка создания макета");
    } finally {
      if (photoRenderPending.current === attempt) {
        photoRenderPending.current = null;
        if (session && sessionRef.current === session && !session.signal.aborted) {
          setPhotoBusy((current) => current === "render" ? null : current);
        }
      }
    }
  };

  const createAnotherPhotoVersion = async () => {
    if (photoRenderPending.current || !isHandoffSessionAlive(sessionRef.current)) return;
    const currentIndex = photoLayouts.findIndex((item) => item.id === photoTextInputsRef.current.layout);
    const next = photoLayouts[(currentIndex + 1) % photoLayouts.length].id;
    await generatePhotoLayout(next);
  };

  const downloadPhotoCreative = async () => {
    const session = sessionRef.current;
    const artifact = photoArtifactRef.current;
    if (!isHandoffSessionAlive(session)) return;
    if (!isPhotoArtifactCurrent(artifact, session) || photoRenderPending.current) {
      toast.error("Сначала сгенерируйте макет");
      return;
    }
    if (!await isHandoffSessionCurrent(session) || !isPhotoArtifactCurrent(artifact, session) || photoRenderPending.current) return;
    const link = document.createElement("a");
    link.href = artifact.previewUrl;
    link.download = `medina-os-photo-creative-${artifact.inputs.format}.jpg`;
    link.click();
    toast.success("Изображение скачивается");
  };

  const copyPhotoTexts = () =>
    void copyText([photoTexts.headline, photoTexts.offer, photoTexts.cta].filter(Boolean).join("\n"), "Тексты креатива", "photo");

  const usePhotoInAdsAutomation = async () => {
    const session = sessionRef.current;
    if (photoHandoffPending.current || !isHandoffSessionAlive(session)) return;
    const artifact = photoArtifactRef.current;
    if (!isPhotoArtifactCurrent(artifact, session) || photoRenderPending.current) {
      toast.error("Сначала сгенерируйте макет");
      return;
    }
    const inputs = artifact.inputs;
    const brief = packageBriefRef.current;
    const briefRevision = packageBriefRevision.current;
    const attempt = {};
    photoHandoffPending.current = attempt;
    const photoCurrent = () => photoHandoffPending.current === attempt && isPhotoArtifactCurrent(artifact, session)
      && !photoRenderPending.current && packageBriefRef.current === brief && packageBriefRevision.current === briefRevision;
    const photoVerified = async () => photoCurrent() && await isHandoffSessionCurrent(session) && photoCurrent();
    // The helper reconciles uncertain SDK results, but access denial must stay terminal.
    let uploadAccessError: unknown = null;
    const assertPhotoCurrent = async () => {
      if (!await photoVerified() || !photoCurrent()) throw new DOMException("Photo handoff changed", "AbortError");
      if (uploadAccessError) throw uploadAccessError;
    };
    let handoffStarted = false;
    try {
      if (!await photoVerified() || !photoCurrent()) return;
      setPhotoBusy("handoff");
      handoffStarted = true;
      let verifiedAsset: VerifiedCreativeAsset | null = null;
      if (hasSupabaseFrontendEnv && !localDraftsOnly) {
        try {
          let uploadAttempt = photoUploadAttempts.current.get(artifact.blob);
          if (!uploadAttempt) {
            const requestKey = crypto.randomUUID();
            uploadAttempt = { requestKey, fileName: `photo-creative-${requestKey}.jpg` };
            photoUploadAttempts.current.set(artifact.blob, uploadAttempt);
          }
          const env = import.meta.env as Record<string, string | undefined>;
          verifiedAsset = await uploadVerifiedCreativeImage({
            workspaceId,
            file: artifact.blob,
            fileName: uploadAttempt.fileName,
            mimeType: "image/jpeg",
            requestKey: uploadAttempt.requestKey,
            storageOrigin: new URL(env.VITE_SUPABASE_URL || "").origin,
            assertCurrent: assertPhotoCurrent,
            request: async (url, init) => {
              await assertPhotoCurrent();
              if (!photoCurrent()) throw new DOMException("Photo handoff changed", "AbortError");
              const response = await crmFetch(url, {
                ...init, expectedUserId: actorId, dispatchGuard: photoCurrent, signal: session.signal,
              });
              await assertPhotoCurrent();
              if (!photoCurrent()) throw new DOMException("Photo handoff changed", "AbortError");
              if (handoffAccessDenied(response)) {
                throw new CrmApiError(response.status, "creative_upload_denied", "Creative upload denied");
              }
              const body = await safeJson<unknown>(response);
              await assertPhotoCurrent();
              if (!photoCurrent()) throw new DOMException("Photo handoff changed", "AbortError");
              if (!response.ok || body?.success !== true) throw new Error("Creative upload failed");
              return { success: true, mode: body.mode, data: body.data };
            },
            upload: async (bucket, path, token, file, opts) => {
              await assertPhotoCurrent();
              if (!photoCurrent()) throw new DOMException("Photo handoff changed", "AbortError");
              let result;
              try {
                result = await supabase.storage.from(bucket).uploadToSignedUrl(path, token, file, opts);
              } catch (error) {
                if (handoffAccessDenied(error)) uploadAccessError = error;
                await assertPhotoCurrent();
                if (!photoCurrent()) throw new DOMException("Photo handoff changed", "AbortError");
                throw error;
              }
              if (handoffAccessDenied(result.error)) uploadAccessError = result.error;
              await assertPhotoCurrent();
              if (!photoCurrent()) throw new DOMException("Photo handoff changed", "AbortError");
              return result;
            },
          });
          if (!await photoVerified() || !photoCurrent()) return;
        } catch (error) {
          if (!await photoVerified() || !photoCurrent()) return;
          if (handoffAccessDenied(error)) {
            toast.error("Доступ к передаче креатива отозван. Обновите страницу.");
            return;
          }
        }
      }
      if (!await photoVerified() || !photoCurrent()) return;
      if (!verifiedAsset) {
        toast.warning("Не удалось загрузить креатив в Storage — передаём только тексты. Изображение можно скачать и загрузить вручную.");
      }

      const formatLabel = photoFormats.find((item) => item.id === inputs.format)?.label || inputs.format;
      const layoutLabel = photoLayouts.find((item) => item.id === inputs.layout)?.label || inputs.layout;

      // Persist metadata: content_videos keeps the whole body in raw_payload.
      try {
        if (!localDraftsOnly) {
          const response = await crmFetch(`/api/crm/content-videos?workspaceId=${encodeURIComponent(workspaceId)}`, {
            expectedUserId: actorId, dispatchGuard: photoCurrent, signal: session.signal,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: inputs.texts.headline,
              niche: brief.service,
              goal: "photo_creative",
              style: layoutLabel,
              audience: brief.audience,
              caption: inputs.texts.offer,
              cta: inputs.texts.cta,
              status: "idea",
              photoCreative: {
                format: inputs.format,
                layout: inputs.layout,
                sourceType: inputs.sourceType,
                ...(verifiedAsset ? { creativeUrl: verifiedAsset.publicUrl, assetId: verifiedAsset.id } : {}),
                texts: inputs.texts,
              },
            }),
          });
          if (!await photoVerified() || !photoCurrent()) return;
          if (handoffAccessDenied(response)) {
            toast.error("Доступ к передаче креатива отозван. Обновите страницу.");
            return;
          }
        }
      } catch (error) {
        if (!await photoVerified() || !photoCurrent()) return;
        if (handoffAccessDenied(error)) {
          toast.error("Доступ к передаче креатива отозван. Обновите страницу.");
          return;
        }
        // A metadata outage does not discard the current user's local draft.
      }

      if (!await photoVerified() || !photoCurrent()) return;
      writeContentToAdsAutomation({
        sourceKind: "photo",
        campaignName: inputs.texts.headline,
        service: brief.service,
        city: brief.city,
        offer: inputs.texts.offer,
        audience: brief.audience,
        primaryText: `${inputs.texts.offer}. ${inputs.texts.cta}.`,
        headline: inputs.texts.headline,
        description: inputs.texts.offer,
        cta: "LEARN_MORE",
        creative: verifiedAsset ? {
          type: "image",
          assetId: verifiedAsset.id,
          url: verifiedAsset.publicUrl,
          fileName: verifiedAsset.fileName,
          mimeType: verifiedAsset.mimeType,
          fileSize: verifiedAsset.fileSize,
          format: inputs.format,
          brief: `Фото-креатив: ${layoutLabel}, формат ${formatLabel}, CTA «${inputs.texts.cta}»`,
        } : undefined,
      });
      toast.success(verifiedAsset ? "Фото-креатив передан в AI запуск рекламы" : "Тексты переданы в AI запуск рекламы");
      setLocation("/ads-automation");
    } finally {
      if (photoHandoffPending.current === attempt) {
        photoHandoffPending.current = null;
        if (handoffStarted && session && sessionRef.current === session && !session.signal.aborted) {
          setPhotoBusy((current) => current === "handoff" ? null : current);
        }
      }
    }
  };

  // --- Настоящая генерация изображения и видео -----------------------------

  const generatePhoto = async () => {
    const session = sessionRef.current;
    if (!isSessionAlive(session)) return;
    const attemptKey = paidGenerationAttemptKey("photo");
    const prompt = genPrompt.trim();
    if (!prompt) {
      setGenNotice({ tone: "warning", text: "Опишите кадр — без описания генерировать нечего." });
      return;
    }

    let attempt: PaidGenerationAttempt;
    try {
      photoGenerationAttempt.current = readBrowserPaidGenerationAttempt("photo");
      attempt = resolvePaidGenerationAttempt(
        photoGenerationAttempt.current,
        { kind: "photo", prompt, format: genFormat },
        () => globalThis.crypto?.randomUUID?.() || "",
      );
      // The request cannot reach the paid provider until its retry key survives
      // a full reload of this tab.
      writeBrowserPaidGenerationAttempt("photo", attempt);
      photoGenerationAttempt.current = attempt;
    } catch (error) {
      setGenNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Не удалось защитить платную генерацию от повтора.",
      });
      return;
    }

    setGenBusy("photo");
    setGenNotice(null);
    try {
      const response = await crmFetch(withWorkspace("/api/content-studio/generate-photo"), {
        expectedUserId: actorId, dispatchGuard: () => isSessionAlive(session), signal: session.signal,
        method: "POST",
        headers: paidGenerationHeaders(attempt.requestKey),
        body: JSON.stringify({ prompt, format: genFormat }),
      });
      const body = await safeJson<{
        creativeUrl: string;
        assetId?: string;
        fileName?: string;
        mimeType: string;
        model: string;
        fileSize: number;
      }>(response);
      if (!await isGenerationSessionCurrent(session)) return;
      const keepAttempt = shouldKeepPaidGenerationAttempt({
        responseReceived: true,
        status: response.status,
        success: body?.success,
        code: body?.success === false ? body.code : undefined,
      });
      if (!keepAttempt && photoGenerationAttempt.current === attempt) {
        photoGenerationAttempt.current = null;
        clearBrowserPaidGenerationAttempt("photo", attemptKey, attempt.requestKey);
      }

      if (!response.ok || body?.success !== true) {
        void refreshGenerationUsage();
        setGenNotice({
          tone: "error",
          text: `${generationRefusalText(body, response.status, "Не удалось сгенерировать изображение")}${
            keepAttempt && (body?.success !== false || body.code !== "generation_request_duplicate")
              ? " Повтор без изменения описания использует прежний защитный ключ и не запустит второй платный запрос."
              : ""
          }`,
        });
        return;
      }

      setGenImage({
        url: body.data.creativeUrl,
        assetId: body.data.assetId,
        fileName: body.data.fileName,
        mimeType: body.data.mimeType,
        model: body.data.model,
        fileSize: body.data.fileSize,
      });
      // Файл может лечь в хранилище, а строка в библиотеке креативов — нет.
      // Ссылка при этом рабочая, поэтому это предупреждение, а не отказ; но
      // промолчать нельзя: в списке креативов файла не будет.
      if (body.warning) {
        setGenNotice({
          tone: "warning",
          text: `Файл сохранён, ссылка работает, но запись в библиотеке креативов не создана: ${body.warning}`,
        });
      }
      toast.success("Изображение сгенерировано");
      void refreshGenerationUsage();
    } catch (error) {
      if (!await isGenerationSessionCurrent(session)) return;
      setGenNotice({
        tone: "error",
        text: `${error instanceof Error ? error.message : "Не удалось сгенерировать изображение"} Повтор без изменения описания использует прежний защитный ключ и не запустит второй платный запрос.`,
      });
    } finally {
      if (isSessionAlive(session)) setGenBusy(null);
    }
  };

  const generateVideo = async () => {
    const session = sessionRef.current;
    if (!isSessionAlive(session) || videoCommandRef.current) return;
    const attemptKey = paidGenerationAttemptKey("video");
    const prompt = genPrompt.trim();
    if (!prompt) {
      setGenNotice({ tone: "warning", text: "Опишите ролик — без описания генерировать нечего." });
      return;
    }

    let attempt: PaidGenerationAttempt;
    try {
      videoGenerationAttempt.current = readBrowserPaidGenerationAttempt("video");
      attempt = resolvePaidGenerationAttempt(
        videoGenerationAttempt.current,
        { kind: "video", prompt, format: genFormat },
        () => globalThis.crypto?.randomUUID?.() || "",
      );
      writeBrowserPaidGenerationAttempt("video", attempt);
      videoGenerationAttempt.current = attempt;
    } catch (error) {
      setGenNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Не удалось защитить платную генерацию от повтора.",
      });
      return;
    }

    const command = {};
    videoCommandRef.current = command;
    const revision = ++videoGenerationRevision.current;
    const current = () => isSessionAlive(session) && videoCommandRef.current === command && videoGenerationRevision.current === revision;
    setGenBusy("video");
    setGenNotice(null);
    setGenVideo(null);
    // Прошлая задача перестаёт нас интересовать в тот же момент, когда
    // поставлена новая — и в состоянии тоже, а не только в хранилище. Пока
    // ответ на новый POST не пришёл, карточка иначе показывала бы «Ролик готов
    // 100%» от прошлой задачи рядом с кнопкой «Отправляем задачу...», причём
    // без самого ролика: genVideo уже очищен строкой выше.
    setVideoJob(null);
    writeStoredVideoJob(null, videoJobStorageKey(), { actorId, workspaceId });
    try {
      const response = await crmFetch(withWorkspace("/api/content-studio/generate-video"), {
        expectedUserId: actorId, dispatchGuard: current, signal: session.signal,
        method: "POST",
        headers: paidGenerationHeaders(attempt.requestKey),
        body: JSON.stringify({ prompt, format: genFormat }),
      });
      if (!current()) return;
      const body = await safeJson<unknown>(response);
      if (!current() || !await isGenerationSessionCurrent(session) || !current()) return;
      if (handoffAccessDenied(response)) {
        clearGeneratedVideoAccess();
        return;
      }
      const keepAttempt = (body?.success === false && body.accepted === true) || shouldKeepPaidGenerationAttempt({
        responseReceived: true,
        status: response.status,
        success: body?.success,
        code: body?.success === false ? body.code : undefined,
      });
      if (!keepAttempt && videoGenerationAttempt.current === attempt) {
        videoGenerationAttempt.current = null;
        clearBrowserPaidGenerationAttempt("video", attemptKey, attempt.requestKey);
      }

      if (!response.ok || body?.success !== true) {
        void refreshGenerationUsage();
        const acceptedJob = parseRecoverableGeneratedVideo(body, videoReceiptContext());
        if (acceptedJob) writeStoredVideoJob(acceptedJob, videoJobStorageKey(), { actorId, workspaceId });
        setVideoJob(acceptedJob);
        setGenNotice({
          tone: "error",
          text: `${generationRefusalText(body, response.status, "Не удалось запустить генерацию видео")}${
            keepAttempt && (body?.success !== false || body.code !== "generation_request_duplicate")
              ? " Повтор без изменения описания использует прежний защитный ключ и не запустит второй платный запрос."
              : ""
          }`,
        });
        return;
      }

      // Подмена формата живёт в карточке задачи, а не в genNotice: genNotice
      // общий с генерацией изображения, и один клик по соседней кнопке стирал
      // бы предупреждение о том, что «квадратный» ролик на самом деле 9:16.
      const acceptedJob = parseAcceptedGeneratedVideo(body.data, videoReceiptContext());
      // Keep the accepted handle if the later persistence effect cannot recheck auth.
      writeStoredVideoJob(acceptedJob, videoJobStorageKey(), { actorId, workspaceId });
      setVideoJob(acceptedJob);
      void refreshGenerationUsage();
    } catch (error) {
      if (!current() || !await isGenerationSessionCurrent(session) || !current()) return;
      if (handoffAccessDenied(error)) {
        clearGeneratedVideoAccess();
        return;
      }
      setVideoJob(null);
      setGenNotice({
        tone: "error",
        text: `${error instanceof Error ? error.message : "Не удалось запустить генерацию видео"} Повтор без изменения описания использует прежний защитный ключ и не запустит второй платный запрос.`,
      });
    } finally {
      if (videoCommandRef.current === command) {
        videoCommandRef.current = null;
        if (isSessionAlive(session)) setGenBusy(null);
      }
    }
  };

  const retryNativeVideo = async () => {
    const session = sessionRef.current;
    const original = videoJob;
    if (!isSessionAlive(session) || videoCommandRef.current || !original?.validationJobId
      || original.status !== "failed" || original.phase !== "validation" || videoJobRef.current !== original) return;
    const command = {};
    videoCommandRef.current = command;
    const generation = videoGenerationRevision.current;
    const current = () => isSessionAlive(session) && videoCommandRef.current === command
      && videoGenerationRevision.current === generation && videoJobRef.current === original;
    setVideoRetryBusy(true);
    try {
      if (!current() || !await isGenerationSessionCurrent(session) || !current()) return;
      const response = await crmFetch(`/api/crm/video-processing-jobs/${encodeURIComponent(original.validationJobId)}/retry?workspaceId=${encodeURIComponent(workspaceId)}`, {
        expectedUserId: actorId, dispatchGuard: current, signal: session.signal,
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, status: "failed" }),
      });
      if (!current()) return;
      const body = await safeJson<unknown>(response);
      if (!current() || !await isGenerationSessionCurrent(session) || !current()) return;
      if (handoffAccessDenied(response)) {
        clearGeneratedVideoAccess();
        return;
      }
      if (response.ok) requireGeneratedVideoRetryReceipt(body, { actorId, workspaceId }, original.validationJobId);
      else if (response.status !== 409 && response.status < 500) {
        setGenNotice({ tone: "error", text: "Повторная обработка недоступна. Исходная задача сохранена." });
        return;
      }
      // A conflict or uncertain acknowledgement is reconciled by the same read, never another paid POST.
      setGenNotice(response.ok ? null : { tone: "warning", text: "Проверяем состояние прежней задачи обработки." });
      setVideoJob((job) => job === original ? { ...job, status: "in_progress", progress: Math.min(95, job.progress) } : job);
    } catch (error) {
      if (!current() || !await isGenerationSessionCurrent(session) || !current()) return;
      if (handoffAccessDenied(error)) {
        clearGeneratedVideoAccess();
        return;
      }
      setGenNotice({ tone: "warning", text: "Не удалось подтвердить повторную обработку. Исходная задача сохранена." });
    } finally {
      if (videoCommandRef.current === command) {
        videoCommandRef.current = null;
        if (isSessionAlive(session)) setVideoRetryBusy(false);
      }
    }
  };

  /**
   * Опрос состояния ролика.
   *
   * Счётчик поколений — против того же дефекта, что и в панели задач: ответ на
   * предыдущую задачу не должен перезаписать состояние новой. Цепочка таймеров,
   * а не интервал: следующий запрос ставится только после ответа предыдущего,
   * поэтому медленный ответ не копит очередь.
   */
  useEffect(() => {
    const session = sessionRef.current;
    if (!isSessionAlive(session)) return;
    if (!videoJob) return;
    if (videoJob.status === "completed" || videoJob.status === "failed") return;

    const handle = videoJob.handle;
    const generation = videoGenerationRevision.current;
    const validationJobId = videoJob.validationJobId;
    const requestController = new AbortController();
    const signal = AbortSignal.any([session.signal, requestController.signal]);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const isStale = () => stopped || !isSessionAlive(session) || videoGenerationRevision.current !== generation
      || videoJobRef.current?.handle !== handle;
    const schedule = () => {
      if (!isStale()) timer = setTimeout(() => void tick(), VIDEO_POLL_INTERVAL_MS);
    };

    const tick = async () => {
      if (isStale()) return;
      try {
        const response = await crmFetch(
          withWorkspace(`/api/content-studio/video-generation?handle=${encodeURIComponent(handle)}`),
          { expectedUserId: actorId, dispatchGuard: () => !isStale(), signal, cache: "no-store" },
        );
        if (isStale()) return;
        const body = await safeJson<unknown>(response);
        if (isStale()) return;
        if (await pollingSessionState(session) !== "current") {
          schedule();
          return;
        }
        if (isStale()) return;
        if (handoffAccessDenied(response)) {
          clearGeneratedVideoAccess();
          return;
        }

        if (!response.ok || body?.success !== true) {
          setVideoJob((current) => (current && current.handle === handle ? { ...current, status: "failed" } : current));
          setGenNotice({
            tone: "error",
            text: generationRefusalText(body, response.status, "Не удалось получить состояние ролика"),
          });
          return;
        }

        let confirmed: ReturnType<typeof parseGeneratedVideoPoll>;
        try {
          confirmed = parseGeneratedVideoPoll(body.data, videoReceiptContext(validationJobId));
        } catch {
          setGenVideo(null);
          setVideoJob((current) => current?.handle === handle ? { ...current, status: "failed" } : current);
          setGenNotice({ tone: "error", text: "Проверка видео не подтверждена. Нажмите «Проверить ещё раз»: новая генерация не запускается." });
          return;
        }
        const completedUrl = confirmed.receipt?.creativeUrl || "";
        setVideoJob((current) =>
          current && current.handle === handle
            ? { ...current, status: confirmed.status, progress: confirmed.progress, phase: confirmed.phase,
                ...(confirmed.validationJobId ? { validationJobId: confirmed.validationJobId } : {}) }
            : current,
        );

        if (confirmed.status === "failed") {
          setGenVideo(null);
          setGenNotice({
            tone: "error",
            text: confirmed.phase === "validation"
              ? "Проверка и обработка видео не завершились. Исходная задача сохранена."
              : "Сервис генерации не смог собрать ролик. Исходная задача сохранена.",
          });
          return;
        }

        if (confirmed.status === "completed" && confirmed.receipt && completedUrl) {
          displayGeneratedVideoReceipt(confirmed.receipt);
          // The live job card announces completion without covering mobile file actions.
          setGenNotice(null);
          return;
        }
      } catch (error) {
        if (isStale()) return;
        if (await pollingSessionState(session) === "current" && !isStale()) {
          if (handoffAccessDenied(error)) {
            clearGeneratedVideoAccess();
            return;
          }
          setGenNotice({
            tone: "warning",
            text: error instanceof Error ? error.message : "Связь с сервером прервалась, опрос продолжается.",
          });
        }
      }

      schedule();
    };

    // Первый опрос — сразу. Так карточка перестаёт стоять на нуле двенадцать
    // секунд, и так же работает кнопка «Проверить ещё раз»: она возвращает
    // статус в «идёт рендер», эффект перезапускается и спрашивает немедленно.
    void tick();
    return () => {
      stopped = true;
      requestController.abort();
      if (timer) clearTimeout(timer);
    };
  }, [videoJob?.handle, videoJob?.status, actorId, workspaceId]);

  // Задача и её результат переживают уход со страницы: см. VIDEO_JOB_KEY.
  useEffect(() => {
    const session = sessionRef.current;
    if (!videoJob || !isSessionAlive(session)) return;
    const key = videoJobStorageKey();
    let stopped = false;
    void (async () => {
      if (!await isGenerationSessionCurrent(session) || stopped || !isSessionAlive(session) || videoJobRef.current !== videoJob) return;
      writeStoredVideoJob({ ...videoJob }, key, { actorId, workspaceId });
    })();
    return () => { stopped = true; };
  }, [videoJob, actorId, workspaceId]);

  async function persistSelectedContentApproval(
    approval: AdvertisingContentApproval,
    session: AbortController | null,
  ): Promise<boolean | null> {
    if (!contentPackageId || !contentPackage || localDraftsOnly
      || !await isHandoffSessionCurrent(session) || !isHandoffSessionAlive(session)) return false;

    try {
      const response = await crmFetch(`/api/crm/content-videos?workspaceId=${encodeURIComponent(workspaceId)}`, {
        expectedUserId: actorId, dispatchGuard: () => isHandoffSessionAlive(session), signal: session.signal,
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: contentPackageId,
          title: contentPackage.ideaTitle,
          niche: packageBrief.service,
          goal: packageBrief.goal,
          duration: "30-45 seconds",
          style: packageBrief.tone,
          audience: packageBrief.audience,
          hook: contentPackage.hook,
          script: contentPackage.script,
          voiceover: contentPackage.voiceover,
          cta: contentPackage.cta,
          caption: contentPackage.caption,
          status: "script_ready",
          packageBrief,
          packageData: contentPackage,
          selectedAdVariantId: approval.variantId,
          contentApproval: approval,
          approvalStatus: "approved_for_ads",
          contentVersion: approval.version,
        }),
      });
      if (handoffAccessDenied(response)) return null;
      if (!await isHandoffSessionCurrent(session) || !isHandoffSessionAlive(session)) return false;
      const body = await safeJson<unknown>(response);
      if (!await isHandoffSessionCurrent(session) || !isHandoffSessionAlive(session)) return false;
      return response.ok && body?.success === true;
    } catch (error) {
      return handoffAccessDenied(error) ? null : false;
    }
  }

  const useGeneratedInAdsAutomation = async (file: GeneratedFile, creativeType: "image" | "video") => {
    const session = sessionRef.current;
    if (!await isHandoffSessionCurrent(session) || !isHandoffSessionAlive(session)) return;
    if (packageCompliance?.status === "blocked") {
      toast.error("Выбранный текст нельзя передавать в рекламу. Выберите безопасный вариант.");
      return;
    }
    const contentApproval = selectedAdVariant
      ? createContentApproval(contentPackageId, selectedAdVariant)
      : undefined;
    const approvalPersisted = contentApproval
      ? await persistSelectedContentApproval(contentApproval, session)
      : false;
    if (!await isHandoffSessionCurrent(session) || !isHandoffSessionAlive(session)) return;
    if (approvalPersisted === null) {
      toast.error("Доступ к передаче креатива отозван. Обновите страницу.");
      return;
    }
    writeContentToAdsAutomation({
      sourceKind: "generated",
      sourceId: contentPackageId || undefined,
      campaignName: contentPackage?.ideaTitle || packageBrief.service,
      service: packageBrief.service,
      city: packageBrief.city,
      offer: packageBrief.offer,
      audience: packageBrief.audience,
      primaryText: selectedAdVariant?.primaryText || contentPackage?.adPrimaryText || packageBrief.offer,
      headline: selectedAdVariant?.headline || contentPackage?.adHeadline || packageBrief.service,
      description: selectedAdVariant?.description || contentPackage?.caption || packageBrief.offer,
      cta: "LEARN_MORE",
      contentApproval,
      creative: {
        type: creativeType,
        assetId: file.assetId,
        url: file.url,
        fileName: file.fileName,
        mimeType: file.mimeType,
        fileSize: file.fileSize,
        thumbnailUrl: file.thumbnailUrl,
        thumbnailSource: file.thumbnailSource,
        format: genFormat,
        brief: genPrompt.trim(),
      },
    });
    if (contentApproval && contentPackageId && !approvalPersisted) {
      toast.warning("Креатив передан, но отметка согласования не сохранилась в библиотеке контента");
    } else {
      toast.success(creativeType === "image" ? "Изображение передано в AI запуск рекламы" : "Ролик передан в AI запуск рекламы");
    }
    setLocation("/ads-automation");
  };

  const updatePackageBrief = (key: keyof PackageBrief, value: string) => {
    if (packageBriefRef.current[key] === value) return;
    packageBriefRevision.current += 1;
    const nextBrief = { ...packageBriefRef.current, [key]: value };
    packageBriefRef.current = nextBrief;
    setPackageBrief(nextBrief);
  };

  const selectedAdVariant = useMemo(
    () =>
      contentPackage?.adVariants.find((variant) => variant.id === selectedAdVariantId) ||
      contentPackage?.adVariants[0] ||
      null,
    [contentPackage, selectedAdVariantId],
  );

  const adVariantCompliance = useMemo(
    () =>
      (contentPackage?.adVariants || []).map((variant) =>
        checkMetaCompliance({
          headline: variant.headline,
          text: variant.primaryText,
          description: variant.description,
        }),
      ),
    [contentPackage],
  );

  const packageCompliance = useMemo(
    () =>
      selectedAdVariant
        ? checkMetaCompliance({
            headline: selectedAdVariant.headline,
            text: selectedAdVariant.primaryText,
            description: selectedAdVariant.description,
          })
        : null,
    [selectedAdVariant],
  );

  const generatePackage = async () => {
    const session = sessionRef.current;
    if (packageGenerationPending.current || !isHandoffSessionAlive(session)) return;
    const brief = packageBriefRef.current;
    const revision = packageBriefRevision.current;
    const attempt = {};
    packageGenerationPending.current = attempt;
    const isCurrent = () => packageGenerationPending.current === attempt
      && isHandoffSessionAlive(session) && packageBriefRevision.current === revision
      && packageBriefRef.current === brief;
    const isVerified = async () => isCurrent() && await isHandoffSessionCurrent(session) && isCurrent();
    const denyAccess = () => {
      setContentPackageId("");
      publishPackageContent(null);
      selectPackageVariant("", packageCopySnapshotRef.current);
      setPackageGenerationMode("");
      const message = "Доступ к пакету контента отозван. Обновите страницу.";
      setNotice(message);
      toast.error(message);
    };
    setLoading("package");
    setNotice("");
    try {
      if (!await isVerified()) return;
      let data: ContentPackage;
      let mode: string;
      if (localDraftsOnly) {
        data = demoContentPackage(brief);
        mode = "demo";
      } else {
        const response = await crmFetch(`/api/content-studio/generate-package?workspaceId=${encodeURIComponent(workspaceId)}`, {
          expectedUserId: actorId, dispatchGuard: isCurrent, signal: session.signal,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(brief),
        });
        if (handoffAccessDenied(response)) {
          if (await isVerified()) denyAccess();
          return;
        }
        if (!await isVerified()) return;
        const body = await safeJson<ContentPackage>(response);
        if (!await isVerified()) return;
        if (!response.ok || body?.success !== true) {
          throw new Error(body?.success === false ? body.error : "Не удалось сгенерировать пакет контента");
        }
        data = body.data;
        mode = body.mode;
      }
      if (!await isVerified()) return;
      const isText = (value: unknown): value is string => typeof value === "string";
      if (typeof mode !== "string" || !data
        || ![data.ideaTitle, data.hook, data.script, data.voiceover, data.caption,
          data.adPrimaryText, data.adHeadline, data.cta, data.photoPrompt,
          data.videoPrompt, data.whatsappMessage].every(isText)
        || ![data.shotList, data.textOnScreen, data.complianceNotes]
          .every((items) => Array.isArray(items) && items.every(isText))
        || !Array.isArray(data.adVariants) || data.adVariants.length === 0
        || !data.adVariants.every((variant) => variant && [variant.id, variant.label,
          variant.angle, variant.primaryText, variant.headline, variant.description, variant.cta].every(isText))) {
        throw new Error("Сервер вернул неполный пакет контента. Прежний черновик сохранён.");
      }
      // A new draft must never inherit an approval/library ID from its predecessor.
      setContentPackageId("");
      publishPackageContent(data);
      selectPackageVariant(data.adVariants[0]?.id || "", packageCopySnapshotRef.current);
      setPackageGenerationMode(mode);
      // Готовый photo prompt — это ровно то, что нужно генератору изображения.
      // Заполняем только пустое поле: перезаписать текст, который оператор уже
      // правил руками, — худшее, что здесь можно сделать.
      setGenPrompt((current) => (current.trim() ? current : data.photoPrompt));
      toast.success(mode === "demo" ? "Образец пакета готов" : "Пакет контента готов");
      if (localDraftsOnly) return;

      // Persist the package: content_videos stores the whole body in raw_payload.
      try {
        if (!await isVerified()) return;
        const saveResponse = await crmFetch(`/api/crm/content-videos?workspaceId=${encodeURIComponent(workspaceId)}`, {
          expectedUserId: actorId, dispatchGuard: isCurrent, signal: session.signal,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: data.ideaTitle,
            niche: brief.service,
            goal: brief.goal,
            duration: "30-45 seconds",
            style: brief.tone,
            audience: brief.audience,
            hook: data.hook,
            script: data.script,
            voiceover: data.voiceover,
            cta: data.cta,
            caption: data.caption,
            status: "script_ready",
            packageBrief: brief,
            packageData: data,
            approvalStatus: "draft",
            contentVersion: ADVERTISING_CONTENT_APPROVAL_VERSION,
          }),
        });
        if (handoffAccessDenied(saveResponse)) {
          if (await isVerified()) denyAccess();
          return;
        }
        if (!await isVerified()) return;
        const saveBody = await safeJson<{ video?: { id?: unknown }; item?: { id?: unknown } }>(saveResponse);
        if (!await isVerified()) return;
        if (saveResponse.ok && saveBody?.success === true) {
          const savedId = [saveBody.data?.video?.id, saveBody.data?.item?.id]
            .find((id): id is string => typeof id === "string" && Boolean(id.trim()));
          if (savedId) {
            setContentPackageId(savedId.trim());
            return;
          }
        }
        throw new Error("Не удалось подтвердить сохранение пакета в библиотеке.");
      } catch (error) {
        if (!await isVerified()) return;
        if (handoffAccessDenied(error)) {
          denyAccess();
          return;
        }
        const message = "Пакет готов, но не сохранён в библиотеке. Черновик доступен на этой странице.";
        setNotice(message);
        toast.warning(message);
      }
    } catch (error) {
      if (!await isVerified()) return;
      if (handoffAccessDenied(error)) {
        denyAccess();
        return;
      }
      const message = error instanceof Error ? error.message : "Ошибка генерации пакета";
      setNotice(message);
      toast.error(message);
    } finally {
      if (packageGenerationPending.current === attempt) {
        packageGenerationPending.current = null;
        if (session && sessionRef.current === session && !session.signal.aborted) {
          setLoading((current) => current === "package" ? null : current);
        }
      }
    }
  };

  const useInAdsAutomation = async () => {
    const session = sessionRef.current;
    if (!await isHandoffSessionCurrent(session) || !isHandoffSessionAlive(session)) return;
    if (!contentPackage) {
      toast.error("Сначала сгенерируйте пакет контента");
      return;
    }
    if (!selectedAdVariant) {
      toast.error("Сначала выберите вариант объявления");
      return;
    }
    if (packageCompliance?.status === "blocked") {
      toast.error("Выбранный текст нельзя передавать в рекламу. Выберите безопасный вариант.");
      return;
    }
    const contentApproval = createContentApproval(contentPackageId, selectedAdVariant);
    const approvalPersisted = await persistSelectedContentApproval(contentApproval, session);
    if (!await isHandoffSessionCurrent(session) || !isHandoffSessionAlive(session)) return;
    if (approvalPersisted === null) {
      toast.error("Доступ к передаче креатива отозван. Обновите страницу.");
      return;
    }
    writeContentToAdsAutomation({
      sourceKind: "package",
      sourceId: contentPackageId || undefined,
      campaignName: contentPackage.ideaTitle,
      service: packageBrief.service,
      city: packageBrief.city,
      offer: packageBrief.offer,
      audience: packageBrief.audience,
      primaryText: selectedAdVariant.primaryText,
      headline: selectedAdVariant.headline,
      description: selectedAdVariant.description,
      cta: selectedAdVariant.cta,
      contentApproval,
      creative: {
        type: "video",
        format: packageBrief.format,
        brief: contentPackage.videoPrompt,
      },
    });
    if (contentPackageId && !approvalPersisted) {
      toast.warning("Пакет передан, но отметка согласования не сохранилась в библиотеке контента");
    } else {
      toast.success("Выбранный вариант согласован и передан в AI запуск рекламы");
    }
    setLocation("/ads-automation");
  };

  useEffect(() => {
    const session = sessionRef.current;
    if (!localDraftsOnly || isRealWorkspace(workspaceId) || readWorkspaceId() !== workspaceId || !isHandoffSessionAlive(session)) return;
    const saved = readVideos(libraryStorageKey);
    if (!isHandoffSessionAlive(session)) return;
    if (saved.length > 0) {
      librarySnapshotRef.current = { ...librarySnapshotRef.current, videos: saved, activeId: saved[0].id };
      setVideos(saved);
      setActiveId(saved[0].id);
    }
  }, [localDraftsOnly, workspaceId]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!isSessionAlive(session)) return;
    const key = videoJobStorageKey();
    const originalJob = videoJobRef.current;
    const originalGeneration = videoGenerationRevision.current;
    let expectedLibrary = librarySnapshotRef.current;
    const readEpoch = libraryReadEpoch.current;
    const controller = new AbortController();
    const signal = AbortSignal.any([session.signal, controller.signal]);
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const current = () => !stopped && isSessionAlive(session);
    const initialize = async () => {
      try {
        const state = await pollingSessionState(session);
        if (!current()) return;
        if (state === "unverified") {
          retryTimer = setTimeout(() => void initialize(), VIDEO_POLL_INTERVAL_MS);
          return;
        }
        if (state !== "current") return;
        if (videoJobRef.current === originalJob && videoGenerationRevision.current === originalGeneration) {
          const storedJob = readStoredVideoJob(key, { actorId, workspaceId });
          if (storedJob) {
            setGenVideo(null);
            setVideoJob(storedJob);
          }
        }
        const libraryCurrent = () => current() && librarySnapshotRef.current === expectedLibrary && libraryReadEpoch.current === readEpoch;
        if (!libraryCurrent()) return;
        const saved = readVideos(libraryStorageKey);
        if (saved.length > 0) {
          expectedLibrary = { ...expectedLibrary, videos: saved, activeId: saved[0].id };
          librarySnapshotRef.current = expectedLibrary;
          setVideos(saved);
          setActiveId(saved[0].id);
        }
        const response = await crmFetch(`/api/crm/content-videos?workspaceId=${encodeURIComponent(workspaceId)}`, {
          expectedUserId: actorId, dispatchGuard: libraryCurrent, signal, cache: "no-store",
        });
        if (!libraryCurrent()) return;
        if (handoffAccessDenied(response)) {
          if (!await isGenerationSessionCurrent(session) || !libraryCurrent()) return;
          librarySnapshotRef.current = { ...expectedLibrary, videos: [], activeId: "" };
          setVideos([]);
          setActiveId("");
          setNotice("Доступ к библиотеке контента отозван. Обновите страницу.");
          return;
        }
        const body = await safeJson<{ videos?: ContentVideo[]; items?: ContentVideo[] }>(response);
        if (!await isGenerationSessionCurrent(session) || !libraryCurrent()) return;
        if (!response.ok || body?.success !== true || body.mode !== "supabase") {
          setNotice("Библиотека на сервере не подтверждена. Прежний список не изменён.");
          return;
        }

        const rawVideos: unknown = body.data?.videos ?? body.data?.items;
        if (!Array.isArray(rawVideos)) {
          setNotice("Сервер вернул неполную библиотеку. Прежний список не изменён.");
          return;
        }
        const apiVideos = rawVideos.map(parseContentVideo);
        if (!apiVideos.every((video): video is ContentVideo => video !== null && isRealWorkspace(video.id))
          || new Set(apiVideos.map((video) => video.id)).size !== apiVideos.length) {
          setNotice("Сервер вернул неполную библиотеку. Прежний список не изменён.");
          return;
        }

        const localDrafts = expectedLibrary.videos.filter((video) => video.id.startsWith("content-"));
        const sorted = [...apiVideos, ...localDrafts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const nextId = sorted.some((video) => video.id === expectedLibrary.activeId) ? expectedLibrary.activeId : sorted[0]?.id || "";
        if (sorted.length === 0 && expectedLibrary.videos.length === 0 && !expectedLibrary.activeId) return;
        writeVideos(sorted, libraryStorageKey);
        if (!libraryCurrent()) return;
        librarySnapshotRef.current = { ...expectedLibrary, videos: sorted, activeId: nextId };
        setVideos(sorted);
        setActiveId(nextId);
      } catch {
        // Keep localStorage videos as the offline fallback.
      }
    };

    void initialize();
    return () => {
      stopped = true;
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [actorId, workspaceId]);

  const activeVideo = useMemo(
    () => videos.find((video) => video.id === activeId) ?? videos[0] ?? null,
    [activeId, videos],
  );

  const current = activeVideo ?? {
    id: "",
    status: "idea" as const,
    createdAt: new Date().toISOString(),
    ...form,
  };

  const packageText = buildTelegramPackage(current);

  const saveVideos = async (
    nextVideos: ContentVideo[], selectedId?: string,
    expected = libraryView, session = sessionRef.current, storageKey = libraryStorageKey,
    write?: ContentLibraryWrite,
  ) => {
    const current = () => isHandoffSessionAlive(session) && librarySnapshotRef.current === expected
      && (!write || (libraryWritePending.current === write && write.snapshot === expected && !write.published));
    if (!current() || !await isHandoffSessionCurrent(session) || !current()) return false;
    const parsed = nextVideos.map(parseContentVideo);
    if (!parsed.every((video): video is ContentVideo => video !== null)
      || new Set(parsed.map((video) => video.id)).size !== parsed.length
      || (selectedId && !parsed.some((video) => video.id === selectedId))) {
      setNotice("Данные библиотеки не подтверждены. Прежний список сохранён.");
      return false;
    }
    const sorted = parsed.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const nextId = selectedId ?? (sorted.some((video) => video.id === expected.activeId) ? expected.activeId : sorted[0]?.id || "");
    try { writeVideos(sorted, storageKey); }
    catch {
      if (current()) setNotice("Не удалось сохранить библиотеку в этом браузере. Обновите список перед повторной отправкой.");
      return false;
    }
    if (!current()) return false;
    const published = { ...expected, videos: sorted, activeId: nextId };
    librarySnapshotRef.current = published;
    if (write) write.published = published;
    setVideos(sorted);
    setActiveId(nextId);
    return true;
  };

  async function applyCurrentVideoPatch(patch: Partial<ContentVideo>, write: ContentLibraryWrite) {
    if (write.published || !await isLibraryWriteVerified(write)) return false;
    const active = write.snapshot.videos.find((video) => video.id === write.snapshot.activeId) ?? write.snapshot.videos[0];
    const keys = new Set(["title", "niche", "goal", "duration", "style", "audience", "hook", "script", "voiceover", "cta", "caption", "hashtags", "avatarPrompt", "tapnowPrompt", "status"]);
    if (!active || Object.keys(patch).some((key) => !keys.has(key))) return false;
    const nextVideo = parseContentVideo({ ...active, ...patch });
    if (!nextVideo) {
      setNotice("Изменение контента не подтверждено. Прежняя идея сохранена.");
      return false;
    }
    const result = await persistCurrentVideoPatch(active.id, patch, write);
    if (result === "stale" || !await isLibraryWriteVerified(write)) return false;
    if (result === "denied") {
      setNotice("Доступ к изменению контента отозван. Обновите страницу.");
      return false;
    }
    if (result === "conflict") {
      setNotice("Версия контента не подтверждена или изменилась на сервере. Обновите библиотеку; прежняя идея сохранена.");
      return false;
    }
    const accepted = typeof result === "object" ? result : nextVideo;
    if (!await saveVideos(write.snapshot.videos.map((video) => video.id === active.id ? accepted : video), active.id,
      write.snapshot, write.session, write.storageKey, write)) return false;
    if (!await isLibraryWriteVerified(write)) return false;
    write.persistence = result === "local" ? "local" : "server";
    if (result === "local") setNotice("Изменение сохранено только в этом браузере: запись на сервере не подтверждена.");
    return true;
  }

  const updateCurrentVideo = async (patch: Partial<ContentVideo>) => {
    const write = beginLibraryWrite(libraryView);
    if (!write) return false;
    try {
      return await applyCurrentVideoPatch(patch, write);
    } finally {
      if (libraryWritePending.current === write) libraryWritePending.current = null;
    }
  };

  const persistCurrentVideoPatch = async (
    videoId: string, patch: Partial<ContentVideo>, write: ContentLibraryWrite,
  ): Promise<ContentVideo | "local" | "denied" | "stale" | "conflict"> => {
    if (!await isLibraryWriteVerified(write)) return "stale";
    if (localDraftsOnly || videoId.startsWith("content-")) return "local";
    const finalReadiness = patch.status === "telegram_ready";
    const original = finalReadiness ? parseContentVideo(write.snapshot.videos.find((video) => video.id === videoId)) : null;
    const expectedUpdatedAt = readContentVideoVersion(original?.updatedAt);
    if (finalReadiness && !expectedUpdatedAt) return "conflict";
    try {
      const response = await crmFetch(`/api/crm/content-videos?workspaceId=${encodeURIComponent(workspaceId)}`, {
        expectedUserId: actorId, dispatchGuard: () => isLibraryWriteCurrent(write), signal: write.session.signal,
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...patch, id: videoId, ...(finalReadiness ? { expectedUpdatedAt } : {}) }),
      });
      if (handoffAccessDenied(response)) return "denied";
      if (!await isLibraryWriteVerified(write)) return "stale";
      if (response.status === 409) return "conflict";
      const body = await safeJson<{ video?: unknown; item?: unknown }>(response);
      if (!await isLibraryWriteVerified(write)) return "stale";
      const receipt = body?.success === true ? parseContentVideo(body.data?.video ?? body.data?.item) : null;
      if (finalReadiness && (!response.ok || body?.success !== true || body.mode !== "supabase"
        || receipt?.id !== videoId || receipt.status !== "telegram_ready" || !readContentVideoVersion(receipt.updatedAt)
        || JSON.stringify({ ...receipt, status: undefined, updatedAt: undefined })
          !== JSON.stringify({ ...original, status: undefined, updatedAt: undefined }))) return "conflict";
      return response.ok && body?.success === true && body.mode === "supabase" && receipt?.id === videoId ? receipt : "local";
    } catch (error) {
      if (handoffAccessDenied(error)) return "denied";
      if (!await isLibraryWriteVerified(write)) return "stale";
      return finalReadiness ? "conflict" : "local";
    }
  };

  const copyText = async (text: string, label: string, source: "library" | "package" | "photo" = "library") => {
    const session = sessionRef.current;
    const sourceCurrent = () => source === "library" ? librarySnapshotRef.current === libraryView
      : source === "package" ? packageCopySnapshotRef.current === packageCopyView
      : photoTextInputsRef.current === photoCopyView && photoTextRevision.current === photoCopyViewRevision;
    if (clipboardPending.current || !isHandoffSessionAlive(session) || !sourceCurrent()) return false;
    const attempt = {};
    clipboardPending.current = attempt;
    const current = () => clipboardPending.current === attempt && isHandoffSessionAlive(session) && sourceCurrent();
    const verified = async () => current() && await isHandoffSessionCurrent(session) && current();
    try {
      if (!await verified()) return false;
      if (!text.trim()) {
        toast.warning("Нет текста для копирования.");
        return false;
      }
      if (!current()) return false;
      await navigator.clipboard.writeText(text);
      if (!await verified()) return false;
      toast.success(`${label} скопирован`);
      return true;
    } catch {
      if (!await verified()) return false;
      const message = "Не удалось скопировать текст в буфер обмена.";
      setNotice(message);
      toast.error(message);
      return false;
    } finally {
      if (clipboardPending.current === attempt) clipboardPending.current = null;
    }
  };

  const createIdea = async () => {
    const write = beginLibraryWrite(libraryView);
    if (!write) return;
    let started = false;
    const localIdea = (): ContentVideo => {
      const base = newVideoId();
      const ids = new Set(write.snapshot.videos.map((video) => video.id));
      let id = base;
      for (let suffix = 1; ids.has(id); suffix += 1) id = `${base}-${suffix}`;
      return { ...write.snapshot.form, id, status: "idea", createdAt: new Date().toISOString() };
    };
    try {
      if (!await isLibraryWriteVerified(write)) return;
      if (!write.snapshot.form.title.trim()) {
        setNotice("Введите название идеи.");
        return;
      }
      setLoading("video");
      started = true;
      setNotice("");
      if (localDraftsOnly) {
        const video = localIdea();
        if (await saveVideos([video, ...write.snapshot.videos], video.id, write.snapshot, write.session, write.storageKey)) {
          setNotice("Идея сохранена только в этом браузере.");
          toast.success("Локальная идея готова");
        }
        return;
      }
      const response = await crmFetch(`/api/crm/content-videos?workspaceId=${encodeURIComponent(workspaceId)}`, {
        expectedUserId: actorId, dispatchGuard: () => isLibraryWriteCurrent(write), signal: write.session.signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(write.snapshot.form),
      });
      if (handoffAccessDenied(response)) {
        if (await isLibraryWriteVerified(write)) setNotice("Доступ к созданию контента отозван. Обновите страницу.");
        return;
      }
      if (!await isLibraryWriteVerified(write)) return;
      const body = await safeJson<{ video?: unknown; item?: unknown }>(response);
      if (!await isLibraryWriteVerified(write)) return;
      const receipt = body?.success === true ? parseContentVideo(body.data?.video ?? body.data?.item) : null;
      const apiVideo = response.ok && body?.success === true && body.mode === "supabase" && receipt && isRealWorkspace(receipt.id)
        && !write.snapshot.videos.some((video) => video.id === receipt.id) ? receipt : null;
      const video = apiVideo || localIdea();
      if (!await saveVideos([video, ...write.snapshot.videos], video.id, write.snapshot, write.session, write.storageKey)) return;
      if (apiVideo) {
        toast.success("Идея ролика создана");
      } else {
        const message = generationRefusalText(body, response.status, "Сервер не подтвердил сохранение идеи");
        setNotice(`${message}. Идея сохранена только в этом браузере.`);
        toast.warning("Идея сохранена локально: запись на сервере не подтверждена");
      }
    } catch (error) {
      if (!await isLibraryWriteVerified(write)) return;
      if (handoffAccessDenied(error)) {
        setNotice("Доступ к созданию контента отозван. Обновите страницу.");
        return;
      }
      const video = localIdea();
      if (await saveVideos([video, ...write.snapshot.videos], video.id, write.snapshot, write.session, write.storageKey)) {
        setNotice("Связь с сервером не подтверждена. Идея сохранена только в этом браузере.");
        toast.warning("API недоступен, идея сохранена локально");
      }
    } finally {
      if (libraryWritePending.current === write) {
        libraryWritePending.current = null;
        if (started && sessionRef.current === write.session && !write.session.signal.aborted) {
          setLoading((current) => current === "video" ? null : current);
        }
      }
    }
  };

  async function generateLibraryText(kind: "script" | "avatar" | "tapnow") {
    const write = beginLibraryWrite(libraryView);
    if (!write) return;
    let started = false;
    const denyAccess = () => {
      const message = "Доступ к созданию контента отозван. Обновите страницу.";
      setNotice(message);
      toast.error(message);
    };
    try {
      if (!await isLibraryWriteVerified(write)) return;
      const active = write.snapshot.videos.find((video) => video.id === write.snapshot.activeId) ?? write.snapshot.videos[0];
      if (kind !== "script" && !active) {
        setNotice("Сначала создайте идею ролика, затем её промпт.");
        return;
      }
      const payload = {
        ...write.snapshot.form, ...active,
        videoId: active && isRealWorkspace(active.id) ? active.id : undefined,
      };
      setLoading(kind);
      started = true;
      setNotice("");
      let data: unknown;
      let mode: string;
      if (localDraftsOnly) {
        data = kind === "script" ? demoScriptPackage() : kind === "avatar" ? demoAvatarPrompt(payload) : demoTapNowPrompt(payload);
        mode = "demo";
      } else {
        const resource = kind === "script" ? "generate-script" : `generate-${kind}-prompt`;
        const response = await crmFetch(`/api/content-studio/${resource}?workspaceId=${encodeURIComponent(workspaceId)}`, {
          expectedUserId: actorId, dispatchGuard: () => isLibraryWriteCurrent(write), signal: write.session.signal,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (handoffAccessDenied(response)) {
          if (await isLibraryWriteVerified(write)) denyAccess();
          return;
        }
        if (!await isLibraryWriteVerified(write)) return;
        const body = await safeJson<unknown>(response);
        if (!await isLibraryWriteVerified(write)) return;
        if (!response.ok || body?.success !== true) {
          throw new Error(generationRefusalText(body, response.status, "Не удалось подготовить контент"));
        }
        data = body.data;
        mode = body.mode;
      }
      if (!await isLibraryWriteVerified(write)) return;
      if (!["demo", "openai", "anthropic"].includes(mode)) throw new Error("Результат генерации не подтверждён. Прежний контент сохранён.");
      let patch: Partial<ContentVideo>;
      if (kind === "script") {
        const script = parseScriptPackage(data);
        if (!script) throw new Error("Сервер вернул неполный сценарий. Прежний контент сохранён.");
        patch = { ...script, status: "script_ready" };
      } else {
        const prompt = parsePromptPackage(data);
        if (!prompt) throw new Error("Сервер вернул неполный промпт. Прежний контент сохранён.");
        patch = { [kind === "avatar" ? "avatarPrompt" : "tapnowPrompt"]: combinePrompt(prompt), status: "avatar_ready" };
      }
      if (active) {
        if (!await applyCurrentVideoPatch(patch, write)) return;
      } else {
        // Without a saved idea, the generated script remains an explicit local draft.
        const video: ContentVideo = {
          ...write.snapshot.form, ...patch, id: newVideoId(), status: "script_ready",
          createdAt: new Date().toISOString(),
        };
        if (!await saveVideos([video, ...write.snapshot.videos], video.id, write.snapshot, write.session, write.storageKey, write)) return;
        if (!await isLibraryWriteVerified(write)) return;
        setNotice("Сценарий сохранён только в этом браузере. Запись на сервере не создавалась.");
      }
      if (!await isLibraryWriteVerified(write)) return;
      const ready = kind === "script" ? "Сценарий готов" : kind === "avatar" ? "Avatar prompt готов" : "TapNow prompt готов";
      toast.success(mode === "demo" ? kind === "script" ? "Образец сценария готов" : "Образец промпта готов" : ready);
    } catch (error) {
      if (!await isLibraryWriteVerified(write)) return;
      if (handoffAccessDenied(error)) {
        denyAccess();
        return;
      }
      const message = error instanceof Error ? error.message : "Не удалось подготовить контент";
      setNotice(message);
      toast.error(message);
    } finally {
      if (libraryWritePending.current === write) {
        libraryWritePending.current = null;
        if (started && sessionRef.current === write.session && !write.session.signal.aborted) {
          setLoading((current) => current === kind ? null : current);
        }
      }
    }
  }

  const generateScript = () => generateLibraryText("script");
  const generatePrompt = (kind: "avatar" | "tapnow") => generateLibraryText(kind);

  async function runLibraryTelegram(test: boolean) {
    const write = beginLibraryWrite(libraryView);
    if (!write) return;
    const kind = test ? "telegram-test" : "telegram";
    let started = false;
    let delivered = false;
    let deliveryNotice = "";
    let receipt: TelegramDeliveryReceipt | null = null;
    const denyAccess = () => {
      const message = "Доступ к Telegram отозван. Обновите страницу.";
      setNotice(message);
      toast.error(message);
    };
    try {
      if (!await isLibraryWriteVerified(write)) return;
      const active = write.snapshot.videos.find((video) => video.id === write.snapshot.activeId) ?? write.snapshot.videos[0];
      if (!test && !active) {
        setNotice("Сначала создайте идею ролика.");
        return;
      }
      if (localDraftsOnly) {
        const message = test ? "В локальном режиме Telegram не проверяется. Сообщение не отправлялось."
          : "Пакет доступен для копирования. В локальном режиме сообщение в Telegram не отправлялось.";
        setNotice(message);
        toast.warning(message);
        return;
      }
      if (!test && active && isRealWorkspace(active.id) && !readContentVideoVersion(active.updatedAt)) {
        const message = "Версия контента не подтверждена. Обновите библиотеку перед отправкой; сообщение в Telegram не отправлялось.";
        setNotice(message);
        toast.warning(message);
        return;
      }
      setLoading(kind);
      started = true;
      setNotice("");
      if (!test && active) {
        receipt = await reserveTelegramDelivery({
          storage: window.localStorage, locks: navigator.locks, actorId, workspaceId,
          videoId: active.id, packageText: buildTelegramPackage(active), isCurrent: () => isLibraryWriteCurrent(write),
        });
        if (!await isLibraryWriteVerified(write)) {
          releaseUnsentTelegramDelivery(window.localStorage, receipt);
          return;
        }
      }
      const testRequestId = test ? crypto.randomUUID() : undefined;
      const response = await crmFetch(`/api/content-studio/send-telegram?workspaceId=${encodeURIComponent(workspaceId)}`, {
        expectedUserId: actorId, dispatchGuard: () => isLibraryWriteCurrent(write), signal: write.session.signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(test ? { test: true, testRequestId } : active),
      });
      if (handoffAccessDenied(response)) {
        if (receipt) releaseUnsentTelegramDelivery(window.localStorage, receipt);
        if (await isLibraryWriteVerified(write)) denyAccess();
        return;
      }
      if (!await isLibraryWriteVerified(write)) return;
      const body = await safeJson<unknown>(response);
      const recipientUnsent = response.status === 503 && body?.success === false && body.code === "telegram_recipient_unconfirmed"
        && typeof body.data === "object" && body.data !== null && !Array.isArray(body.data)
        && (body.data as Record<string, unknown>).sent === false
        && (body.data as Record<string, unknown>).phase === "recipient_lookup"
        && body.part === undefined && body.totalParts === undefined;
      // This request never admitted a delivery; attempt-scoped cleanup is safe
      // even when the following session verification refuses the old callback.
      if (recipientUnsent && receipt) releaseUnsentTelegramDelivery(window.localStorage, receipt);
      if (!await isLibraryWriteVerified(write)) return;
      if (recipientUnsent) {
        const message = "Не удалось проверить получателя Telegram. В этом запросе сообщения не отправлялись; проверку можно повторить позже.";
        setNotice(message);
        toast.error(message);
        return;
      }
      if (!response.ok || body?.success !== true) {
        throw new Error(telegramErrorMessage(body, test ? "Проверка Telegram не подтверждена" : "Доставка в Telegram не подтверждена"));
      }
      const result = parseTelegramResponse(body.data, body.mode, test, active ? buildTelegramPackage(active) : undefined, testRequestId);
      if (!result) throw new Error("Сервер вернул неподтверждённый результат Telegram.");
      delivered = result.sent;
      const deliveryParts = !test && result.parts && result.parts > 1 ? ` частями: ${result.parts}` : "";
      // Legacy receipts confirm delivery, but only explicit false establishes a fresh send.
      deliveryNotice = result.replayed === true
        ? test ? "Проверочное сообщение было доставлено ранее. Повторно не отправлялось; новая проверка не выполнялась."
          : `Пакет был доставлен в Telegram ранее${deliveryParts}. Повторно не отправлялся.`
        : result.replayed === false
          ? test ? "Telegram подтвердил проверочное сообщение." : "Telegram подтвердил отправку."
          : test ? "Telegram подтвердил проверочное сообщение. Новая проверка не подтверждена."
            : `Telegram подтвердил доставку пакета${deliveryParts}. Новая отправка не подтверждена.`;
      if (body.warning !== undefined && typeof body.warning !== "string") throw new Error("Сервер вернул неполные данные Telegram.");
      if (!result.sent) {
        if (receipt) releaseUnsentTelegramDelivery(window.localStorage, receipt);
        const message = body.warning || "Telegram не подключён. Пакет доступен только для копирования; сообщение не отправлено.";
        setNotice(message);
        toast.warning(message);
        return;
      }
      if (test) {
        const message = result.replayed === false ? "Telegram подключён" : deliveryNotice;
        setNotice(message);
        toast.success(message);
        return;
      }
      if (receipt) confirmTelegramDelivery(window.localStorage, receipt);
      const saved = await applyCurrentVideoPatch({ status: "telegram_ready" }, write);
      if (!await isLibraryWriteVerified(write)) return;
      const published = write.published?.videos.find((video) => video.id === active?.id);
      if (!saved || write.persistence !== "server" || published?.status !== "telegram_ready") {
        const message = `${deliveryNotice} Статус в библиотеке на сервере не подтверждён. Не отправляйте пакет повторно ради статуса; обновите библиотеку.`;
        setNotice(message);
        toast.warning(message);
        return;
      }
      setNotice(result.replayed === false
        ? `Пакет отправлен в Telegram${result.parts && result.parts > 1 ? ` частями: ${result.parts}` : ""}.` : deliveryNotice);
      toast.success(result.replayed === false ? "Отправлено в Telegram" : deliveryNotice);
    } catch (error) {
      // This transport refusal proves no POST, even if the captured session has ended.
      if (receipt && !delivered && error instanceof CrmApiError
        && error.status === 401 && error.code === "authentication_required") {
        releaseUnsentTelegramDelivery(window.localStorage, receipt);
      }
      if (!await isLibraryWriteVerified(write)) return;
      if (handoffAccessDenied(error) && !delivered) {
        denyAccess();
        return;
      }
      const detail = error instanceof Error ? error.message : "Не удалось проверить Telegram";
      const message = delivered ? `${deliveryNotice} ${test ? "Дополнительные данные ответа не подтверждены."
        : "Статус в библиотеке не подтверждён. Не отправляйте пакет повторно ради статуса."}`
        : `${detail} Проверьте Telegram перед повторной попыткой: часть сообщения могла быть доставлена.`;
      setNotice(message);
      if (delivered) toast.warning(message);
      else toast.error(message);
    } finally {
      if (libraryWritePending.current === write) {
        libraryWritePending.current = null;
        if (started && sessionRef.current === write.session && !write.session.signal.aborted) {
          setLoading((current) => current === kind ? null : current);
        }
      }
    }
  }

  const testTelegram = () => runLibraryTelegram(true);
  const sendTelegram = () => runLibraryTelegram(false);

  // AI Target is no longer a standalone module: the studio hands content
  // straight to Ads Automation, where "ИИ заполнит" covers targeting.
  const transferToAdsAutomation = async () => {
    const session = sessionRef.current;
    const sourceCurrent = () => librarySnapshotRef.current === libraryView && !libraryWritePending.current
      && packageBriefRef.current === packageBrief && packageBriefRevision.current === packageBriefViewRevision
      && advertisingGoalContextRef.current === advertisingGoalContext;
    if (libraryHandoffPending.current || !isHandoffSessionAlive(session) || !sourceCurrent()) return;
    const attempt = {};
    libraryHandoffPending.current = attempt;
    const currentScope = () => libraryHandoffPending.current === attempt && isHandoffSessionAlive(session) && sourceCurrent();
    const verified = async () => currentScope() && await isHandoffSessionCurrent(session) && currentScope();
    try {
      if (!await verified()) return;
      const hasAdvertisingGoalContext = advertisingGoalContext.targetPatients !== undefined;
      writeContentToAdsAutomation({
        sourceKind: "library",
        sourceId: current.id,
        campaignName: hasAdvertisingGoalContext
          ? packageBrief.service || current.title || form.title
          : current.title || form.title,
        service: hasAdvertisingGoalContext
          ? packageBrief.service
          : current.niche || form.niche,
        city: hasAdvertisingGoalContext ? packageBrief.city : undefined,
        offer: hasAdvertisingGoalContext
          ? packageBrief.offer
          : current.cta || current.goal || form.goal,
        audience: hasAdvertisingGoalContext
          ? packageBrief.audience
          : current.audience || form.audience,
        primaryText: current.caption || current.script || current.hook || form.title,
        headline: current.hook || current.title || form.title,
        description: current.cta || current.goal || form.goal,
        cta: "LEARN_MORE",
      });
      if (!currentScope()) return;
      toast.success("Контент передан в AI запуск рекламы");
      setLocation("/ads-automation");
    } catch {
      if (!await verified()) return;
      const message = "Не удалось сохранить контент для рекламного раздела. Переход не выполнен.";
      setNotice(message);
      toast.error(message);
    } finally {
      if (libraryHandoffPending.current === attempt) libraryHandoffPending.current = null;
    }
  };

  return (
    <PageLayout>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-2xl font-black text-[#0B1220]">AI Контент-студия</h2>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[#64748B]">
              Пакеты контента для рекламы и соцсетей: идеи, сценарии, тексты объявлений, prompts и WhatsApp-сообщения. Дальше — в AI запуск рекламы.
            </p>
          </div>
          <button
            type="button"
            className="neu-btn-primary inline-flex items-center gap-2 px-5 py-2.5 text-sm"
            onClick={transferToAdsAutomation}
          >
            <Rocket size={16} />
            Создать рекламу из этого контента
            <ArrowRight size={15} />
          </button>
        </div>

        {/*
          notice пишут четыре разных места страницы: Telegram, создание идеи,
          сохранение сценария и сохранение prompt'ов. Раньше он выводился один
          раз — внизу, в карточке Telegram. Оператор, нажавший «Создать идею» в
          середине страницы, видел исчезающий тост, а объяснение «сохранено
          только в этом браузере» оставалось там, куда он не смотрит.
        */}
        {notice ? (
          <div
            aria-live="polite"
            className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900"
          >
            {notice}
          </div>
        ) : null}

        <section className="neu-card p-6">
          <SectionTitle
            icon={WandSparkles}
            title="Пакет контента"
            subtitle="Выберите режим и формат, заполните бриф — ИИ соберёт сценарий, тексты, prompts и WhatsApp-сообщение."
          />

          <p style={labelStyle}>Режим создания</p>
          <div className="mb-4 flex flex-wrap gap-2">
            {packageModes.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className={`rounded-full border px-4 py-2 text-xs font-black ${
                  packageBrief.mode === mode.id ? "border-[#0D9488] bg-[#0D9488] text-white" : "border-[#E7ECF3] bg-white text-[#475569]"
                }`}
                onClick={() => updatePackageBrief("mode", mode.id)}
              >
                {mode.label}
              </button>
            ))}
          </div>

          <p style={labelStyle}>Формат</p>
          <div className="mb-4 flex flex-wrap gap-2">
            {packageFormats.map((format) => (
              <button
                key={format.id}
                type="button"
                className={`rounded-full border px-4 py-2 text-xs font-black ${
                  packageBrief.format === format.id ? "border-[#0D9488] bg-[#0D9488] text-white" : "border-[#E7ECF3] bg-white text-[#475569]"
                }`}
                onClick={() => updatePackageBrief("format", format.id)}
              >
                {format.label}
              </button>
            ))}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Услуга" value={packageBrief.service} onChange={(value) => updatePackageBrief("service", value)} />
            <Field label="Город" value={packageBrief.city} onChange={(value) => updatePackageBrief("city", value)} />
            <Field label="Оффер" value={packageBrief.offer} onChange={(value) => updatePackageBrief("offer", value)} />
            <Field label="Аудитория" value={packageBrief.audience} onChange={(value) => updatePackageBrief("audience", value)} />
            <label>
              <span style={labelStyle}>Цель</span>
              <select style={inputStyle} value={packageBrief.goal} onChange={(event) => updatePackageBrief("goal", event.target.value)}>
                {packageGoals.map((goal) => (
                  <option key={goal.id} value={goal.id}>
                    {goal.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span style={labelStyle}>Тон</span>
              <select style={inputStyle} value={packageBrief.tone} onChange={(event) => updatePackageBrief("tone", event.target.value)}>
                {packageTones.map((tone) => (
                  <option key={tone} value={tone}>
                    {tone}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="mt-4">
            <Field
              label="Материалы клиники (заметки, если есть фото/видео)"
              value={packageBrief.materialNotes}
              onChange={(value) => updatePackageBrief("materialNotes", value)}
              textarea
            />
          </div>

          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              className="neu-btn-primary inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm"
              disabled={loading === "package"}
              onClick={() => void generatePackage()}
            >
              <Sparkles size={16} />
              {loading === "package" ? "Генерируем пакет..." : "Сгенерировать пакет"}
            </button>
            {contentPackage ? (
              <button
                type="button"
                className="neu-btn inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm"
                onClick={useInAdsAutomation}
              >
                <Rocket size={16} />
                Использовать в AI запуске рекламы
                <ArrowRight size={15} />
              </button>
            ) : null}
          </div>

          {packageGenerationMode === "demo" ? (
            <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-900">
              {DEMO_AI_NOTICE}
            </div>
          ) : null}

          {contentPackage ? (
            <div className="mt-6 space-y-4">
              <div className="rounded-2xl border border-[#E7ECF3] bg-white p-4">
                <p className="text-xs font-bold uppercase text-[#64748B]">Идея</p>
                <p className="mt-1 text-base font-black text-[#0B1220]">{contentPackage.ideaTitle}</p>
                <p className="mt-2 text-sm font-semibold text-[#334155]">{contentPackage.hook}</p>
              </div>

              <div className="rounded-2xl border border-[#D7E7E4] bg-[#F7FBFA] p-4 sm:p-5">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <p className="text-sm font-black text-[#0B1220]">Варианты объявления</p>
                    <p className="mt-1 text-sm leading-relaxed text-[#64748B]">
                      Выберите один подход. В рекламный мастер попадёт только выбранный текст.
                    </p>
                  </div>
                  <p className="text-xs font-bold text-[#0D9488]">Без дополнительной генерации</p>
                </div>

                <div className="mt-4 grid gap-3 xl:grid-cols-3">
                  {contentPackage.adVariants.map((variant, index) => {
                    const isSelected = selectedAdVariant?.id === variant.id;
                    const compliance = adVariantCompliance[index];
                    const complianceLabel = compliance?.status === "safe"
                      ? "Формулировки проверены"
                      : compliance?.status === "blocked"
                        ? "Нельзя передавать в рекламу"
                        : "Нужна ручная проверка";
                    const complianceTone = compliance?.status === "safe"
                      ? "text-emerald-700"
                      : compliance?.status === "blocked"
                        ? "text-rose-700"
                        : "text-amber-700";

                    return (
                      <button
                        key={variant.id}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => selectPackageVariant(variant.id)}
                        className={`min-w-0 rounded-xl border p-4 text-left transition-colors ${
                          isSelected
                            ? "border-[#0D9488] bg-white ring-2 ring-[#0D9488]/15"
                            : "border-[#DDE7E5] bg-white hover:border-[#8BC8BF]"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-xs font-bold uppercase text-[#64748B]">Вариант {index + 1}</p>
                            <p className="mt-1 text-sm font-black text-[#0B1220]">{variant.label}</p>
                          </div>
                          {isSelected ? (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-[11px] font-black text-emerald-700">
                              <Check size={12} /> Выбран
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-2 text-xs leading-relaxed text-[#64748B]">{variant.angle}</p>
                        <p className="mt-3 text-sm font-black leading-snug text-[#0F172A]">{variant.headline}</p>
                        <p className="mt-2 line-clamp-4 text-sm leading-relaxed text-[#475569]">{variant.primaryText}</p>
                        <p className={`mt-3 text-xs font-bold ${complianceTone}`}>{complianceLabel}</p>
                      </button>
                    );
                  })}
                </div>

                <div className="mt-4 rounded-xl border border-[#DDE7E5] bg-white px-4 py-3">
                  <p className="text-xs font-bold uppercase text-[#64748B]">Выбран для рекламы</p>
                  <p className="mt-1 text-sm font-black text-[#0B1220]">{selectedAdVariant?.label}</p>
                  <p className="mt-1 text-sm text-[#475569]">
                    Заголовок, основной текст и описание будут перенесены в Ads Automation. При передаче система зафиксирует выбранный вариант и его версию. Запуск останется выключенным до ручной проверки.
                  </p>
                </div>
              </div>

              <div className="grid gap-4 xl:grid-cols-2">
                <PromptBox title="Сценарий Reels/TikTok" value={contentPackage.script} onCopy={() => void copyText(contentPackage.script, "Сценарий", "package")} />
                <PromptBox title="Shot list" value={contentPackage.shotList.join("\n")} onCopy={() => void copyText(contentPackage.shotList.join("\n"), "Shot list", "package")} />
                <PromptBox title="Текст на экране" value={contentPackage.textOnScreen.join("\n")} onCopy={() => void copyText(contentPackage.textOnScreen.join("\n"), "Текст на экране", "package")} />
                <PromptBox title="Voiceover" value={contentPackage.voiceover} onCopy={() => void copyText(contentPackage.voiceover, "Voiceover", "package")} />
                <PromptBox title="Caption для соцсетей" value={contentPackage.caption} onCopy={() => void copyText(contentPackage.caption, "Caption", "package")} />
                <PromptBox
                  title="Текст объявления Meta"
                  value={`${selectedAdVariant?.primaryText || contentPackage.adPrimaryText}\n\nЗаголовок: ${selectedAdVariant?.headline || contentPackage.adHeadline}\nCTA: ${selectedAdVariant?.cta || contentPackage.cta}`}
                  onCopy={() => void copyText(selectedAdVariant?.primaryText || contentPackage.adPrimaryText, "Текст объявления", "package")}
                />
                <PromptBox title="Photo prompt" value={contentPackage.photoPrompt} onCopy={() => void copyText(contentPackage.photoPrompt, "Photo prompt", "package")} />
                <PromptBox title="Video prompt" value={contentPackage.videoPrompt} onCopy={() => void copyText(contentPackage.videoPrompt, "Video prompt", "package")} />
                <PromptBox title="WhatsApp сообщение" value={contentPackage.whatsappMessage} onCopy={() => void copyText(contentPackage.whatsappMessage, "WhatsApp сообщение", "package")} />
              </div>

              {/*
                Раньше здесь стояли пять зелёных галочек из постоянного массива:
                они появлялись всегда, независимо от текста, и означали лишь
                то, что список правил существует. В медицинском продукте это
                худший вид неправды — экран сообщал клинике, что её объявление
                безопасно, ничего не проверив. Теперь цвет и вердикт берутся
                из checkMetaCompliance по фактическому тексту, а список правил
                подписан как перечень проверок, а не как их результат.
              */}
              <div
                className={`rounded-2xl border p-4 ${
                  !packageCompliance
                    ? "border-[#E7ECF3] bg-white"
                    : packageCompliance.status === "safe"
                      ? "border-emerald-200 bg-emerald-50"
                      : packageCompliance.status === "blocked"
                        ? "border-rose-200 bg-rose-50"
                        : "border-amber-200 bg-amber-50"
                }`}
              >
                <p
                  className={`text-sm font-black ${
                    !packageCompliance
                      ? "text-[#0B1220]"
                      : packageCompliance.status === "safe"
                        ? "text-emerald-900"
                        : packageCompliance.status === "blocked"
                          ? "text-rose-900"
                          : "text-amber-900"
                  }`}
                >
                  {!packageCompliance
                    ? "Проверка формулировок"
                    : packageCompliance.status === "safe"
                      ? "Запрещённых формулировок не найдено"
                      : packageCompliance.status === "blocked"
                        ? "Текст нельзя запускать — перепишите"
                        : "Нужна ручная проверка текста"}
                </p>

                {packageCompliance && packageCompliance.status !== "safe" ? (
                  <ul className="mt-2 space-y-1 text-sm font-semibold text-[#334155]">
                    {(packageCompliance.issues || []).map((issue, index) => (
                      <li key={`${issue.code || "issue"}-${index}`}>• {issue.message}</li>
                    ))}
                  </ul>
                ) : null}

                <p className="mt-3 text-xs font-bold uppercase text-[#64748B]">Что проверяется автоматически</p>
                <ul className="mt-1 space-y-1 text-sm font-semibold text-[#475569]">
                  {complianceRules.map((rule) => (
                    <li key={rule}>— {rule}</li>
                  ))}
                </ul>
                <p className="mt-2 text-xs font-semibold text-[#64748B]">
                  Проверка ищет known-запрещённые формулировки в заголовке, основном тексте и подписи. Она не заменяет
                  юридическую проверку рекламы медицинских услуг.
                </p>

                {contentPackage.complianceNotes.length ? (
                  <>
                    <p className="mt-3 text-xs font-bold uppercase text-[#64748B]">Комментарий модели (не результат проверки)</p>
                    <ul className="mt-1 space-y-1 text-sm font-semibold text-[#475569]">
                      {contentPackage.complianceNotes.map((note) => (
                        <li key={note}>• {note}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>

        <section className="neu-card p-6">
          <SectionTitle
            icon={Sparkles}
            title="Генерация изображения и видео"
            subtitle="Описание кадра уходит в сервис генерации, а готовый файл сразу попадает в библиотеку креативов — оттуда его берёт AI запуск рекламы."
          />

          <div className="mb-5 border-y border-[#E7ECF3] py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-black text-[#0B1220]">
                Лимит креативов{generationUsage?.planTitle ? ` · ${generationUsage.planTitle}` : ""}
              </p>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs font-bold text-[#0D9488]"
                onClick={() => void refreshGenerationUsage()}
                disabled={generationUsageLoading}
              >
                <RefreshCw size={13} className={generationUsageLoading ? "animate-spin" : ""} />
                Обновить
              </button>
            </div>
            {generationUsageLoading && !generationUsage ? (
              <p className="mt-2 text-sm font-semibold text-[#64748B]">Проверяем доступный лимит…</p>
            ) : generationUsage ? (
              <div className="mt-2 grid gap-1 text-sm font-semibold text-[#475569] sm:grid-cols-2">
                <p>
                  Изображения: {generationUsage.images.used}
                  {generationUsage.images.limit === null ? "" : ` из ${generationUsage.images.limit}`}
                </p>
                <p>
                  Видео: {generationUsage.videoSeconds.used}
                  {generationUsage.videoSeconds.limit === null ? " сек." : ` из ${generationUsage.videoSeconds.limit} сек.`}
                </p>
                <p className="text-xs text-[#64748B] sm:col-span-2">
                  Лимит обновляется в начале месяца. Один ролик использует примерно {generationUsage.videoSecondsPerGeneration} сек.
                </p>
                {generationUsage.warning ? (
                  <p className="text-xs text-amber-800 sm:col-span-2">{generationUsage.warning}</p>
                ) : null}
              </div>
            ) : (
              <p className="mt-2 text-sm font-semibold text-amber-800">Не удалось проверить лимит. Нажмите «Обновить».</p>
            )}
          </div>

          <div className="mb-4">
            <Field
              label="Что должно быть в кадре"
              value={genPrompt}
              onChange={setGenPrompt}
              textarea
            />
            {contentPackage ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="neu-btn inline-flex items-center gap-2 px-3 py-1.5 text-xs"
                  onClick={() => setGenPrompt(contentPackage.photoPrompt)}
                >
                  <ImagePlus size={13} />
                  Подставить photo prompt из пакета
                </button>
                <button
                  type="button"
                  className="neu-btn inline-flex items-center gap-2 px-3 py-1.5 text-xs"
                  onClick={() => setGenPrompt(contentPackage.videoPrompt)}
                >
                  <Clapperboard size={13} />
                  Подставить video prompt из пакета
                </button>
              </div>
            ) : null}
          </div>

          <p style={labelStyle}>Формат</p>
          <div className="mb-4 flex flex-wrap gap-2">
            {packageFormats.map((format) => (
              <button
                key={format.id}
                type="button"
                // Выбранный формат отличается только заливкой. Без aria-pressed
                // читалка с экрана перечислит пять одинаковых кнопок и не
                // скажет, в каком формате сейчас будет сгенерирован файл.
                aria-pressed={genFormat === format.id}
                className={`rounded-full border px-4 py-2 text-xs font-black ${
                  genFormat === format.id ? "border-[#0D9488] bg-[#0D9488] text-white" : "border-[#E7ECF3] bg-white text-[#475569]"
                }`}
                onClick={() => setGenFormat(format.id)}
              >
                {format.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="neu-btn-primary inline-flex items-center gap-2 px-4 py-2.5 text-sm"
              disabled={
                genBusy !== null ||
                generationUsageLoading ||
                !generationUsage ||
                Boolean(
                  !generationUsage.trackingAvailable ||
                    !generationUsage.subscriptionActive ||
                    !generationUsage.images.enabled ||
                    generationUsage.images.remaining === 0,
                )
              }
              onClick={() => void generatePhoto()}
            >
              <ImagePlus size={15} />
              {genBusy === "photo" ? "Генерируем изображение..." : "Сгенерировать изображение"}
            </button>
            <button
              type="button"
              className="neu-btn inline-flex items-center gap-2 px-4 py-2.5 text-sm"
              disabled={
                genBusy !== null ||
                videoRetryBusy ||
                generationUsageLoading ||
                !generationUsage ||
                videoJob?.status === "queued" ||
                videoJob?.status === "in_progress" ||
                Boolean(
                  !generationUsage.trackingAvailable ||
                    !generationUsage.subscriptionActive ||
                    !generationUsage.videoSeconds.enabled ||
                    (generationUsage.videoSeconds.remaining !== null &&
                      generationUsage.videoSeconds.remaining < generationUsage.videoSecondsPerGeneration),
                )
              }
              onClick={() => void generateVideo()}
            >
              <Clapperboard size={15} />
              {genBusy === "video" ? "Отправляем задачу..." : "Сгенерировать видео"}
            </button>
          </div>

          {genNotice ? (
            <div
              aria-live="polite"
              className={`mt-4 rounded-2xl border p-3 text-sm font-semibold ${
                genNotice.tone === "error"
                  ? "border-rose-200 bg-rose-50 text-rose-900"
                  : genNotice.tone === "warning"
                    ? "border-amber-200 bg-amber-50 text-amber-900"
                    : "border-sky-200 bg-sky-50 text-sky-900"
              }`}
            >
              {genNotice.text}
            </div>
          ) : null}

          {/*
            Карточка остаётся на экране и после неудачи. Раньше она исчезала —
            вместе с единственной копией подписанного идентификатора задачи, —
            и оператору оставалось нажать «Сгенерировать видео» ещё раз, оплатив
            новый рендер, хотя прошлый мог давно закончиться и упасть уже у нас,
            на скачивании или записи в хранилище.
          */}
          {videoJob ? (
            <div
              className={`mt-4 rounded-lg border p-4 ${
                videoJob.status === "failed" ? "border-rose-200 bg-rose-50" : "border-[#E7ECF3] bg-white"
              }`}
              aria-live="polite"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className={`text-sm font-black ${videoJob.status === "failed" ? "text-rose-900" : "text-[#0B1220]"}`}>
                  {videoJob.phase === "validation" && videoJob.status !== "completed" && videoJob.status !== "failed"
                    ? "Проверяем и обрабатываем видео" : videoJobLabels[videoJob.status]}
                </p>
                <p className="text-sm font-bold text-[#64748B]">{videoJob.progress}%</p>
              </div>
              <div
                className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[#E7ECF3]"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={videoJob.progress}
                aria-label={videoJob.phase === "validation" ? "Проверка видео" : videoJobLabels[videoJob.status]}
              >
                <div
                  className={`h-full rounded-full ${videoJob.status === "failed" ? "bg-rose-400" : "bg-[#0D9488]"}`}
                  style={{ width: `${Math.max(3, videoJob.progress)}%` }}
                />
              </div>
              {videoJob.formatSubstituted ? (
                <p className="mt-2 text-xs font-bold text-[#0369A1]">
                  У видеомодели нет квадратного формата — этот ролик снимается вертикально 9:16.
                </p>
              ) : null}
              {videoJob.status === "queued" || videoJob.status === "in_progress" ? (
                <p className="mt-2 text-xs font-semibold text-[#64748B]">
                  {videoJob.phase === "validation" ? "Подготовка проверенного файла и обложки." : "Генерация видео в обработке."}
                </p>
              ) : null}
              {videoJob.status === "failed" ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="neu-btn inline-flex items-center gap-2 px-3 py-1.5 text-xs"
                    disabled={videoRetryBusy}
                    onClick={async () => {
                      const session = sessionRef.current;
                      const original = videoJob;
                      const handle = original?.handle;
                      const generation = videoGenerationRevision.current;
                      if (!handle || !isSessionAlive(session) || videoCommandRef.current || original.status !== "failed" || videoJobRef.current !== original) return;
                      if (!await isGenerationSessionCurrent(session) || !isSessionAlive(session)
                        || videoCommandRef.current || videoJobRef.current !== original || videoGenerationRevision.current !== generation) return;
                      setGenNotice(null);
                      setVideoJob((current) => current === original ? { ...current, status: "in_progress", progress: Math.min(95, current.progress) } : current);
                    }}
                  >
                    <RefreshCw size={13} />
                    Проверить ещё раз
                  </button>
                  {videoJob.phase === "validation" && videoJob.validationJobId ? (
                    <button type="button" className="neu-btn inline-flex items-center gap-2 px-3 py-1.5 text-xs"
                      disabled={videoRetryBusy} onClick={() => void retryNativeVideo()}>
                      <RefreshCw size={13} className={videoRetryBusy ? "animate-spin motion-reduce:animate-none" : ""} />
                      {videoRetryBusy ? "Повторяем обработку..." : "Повторить обработку"}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {genImage || genVideo ? (
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              {genImage ? (
                <div className="neu-sm p-3">
                  <p className="mb-2 text-xs font-bold uppercase text-[#64748B]">Сгенерированное изображение</p>
                  {/* Ссылка ведёт в хранилище, и она может не открыться:
                      объект удалили, bucket перестал быть публичным, файл ещё
                      не разошёлся. Без обработчика оператор увидел бы значок
                      битой картинки сразу после тоста «готово». */}
                  <img
                    src={genImage.url}
                    alt="Сгенерированное изображение"
                    className="max-h-[420px] w-full rounded-xl object-contain"
                    onError={() =>
                      setGenNotice({
                        tone: "error",
                        text: "Файл сохранён, но не открывается по ссылке. Проверьте, что bucket ad-creatives публичный.",
                      })
                    }
                  />
                  <p className="mt-2 text-xs font-semibold text-[#64748B]">
                    {[genImage.model, formatFileSize(genImage.fileSize)].filter(Boolean).join(" · ")}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <a
                      className="neu-btn inline-flex items-center gap-2 px-3 py-1.5 text-xs"
                      href={genImage.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Download size={13} />
                      Открыть файл
                    </a>
                    <button
                      type="button"
                      className="neu-btn-primary inline-flex items-center gap-2 px-3 py-1.5 text-xs"
                      onClick={() => useGeneratedInAdsAutomation(genImage, "image")}
                    >
                      <Rocket size={13} />
                      В AI запуск рекламы
                    </button>
                  </div>
                </div>
              ) : null}
              {genVideo ? (
                <div className="neu-sm p-3">
                  <p className="mb-2 text-xs font-bold uppercase text-[#64748B]">Сгенерированный ролик</p>
                  <video
                    src={genVideo.url}
                    controls
                    playsInline
                    preload="metadata"
                    className="max-h-[420px] w-full rounded-xl bg-black object-contain"
                    onError={() =>
                      setGenNotice({
                        tone: "error",
                        text: "Ролик сохранён, но не открывается по ссылке. Проверьте, что bucket ad-creatives публичный.",
                      })
                    }
                  />
                  <p className="mt-2 text-xs font-semibold text-[#64748B]">{formatFileSize(genVideo.fileSize)}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <a
                      className="neu-btn inline-flex items-center gap-2 px-3 py-1.5 text-xs"
                      href={genVideo.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Download size={13} />
                      Открыть файл
                    </a>
                    <button
                      type="button"
                      className="neu-btn-primary inline-flex items-center gap-2 px-3 py-1.5 text-xs"
                      onClick={() => useGeneratedInAdsAutomation(genVideo, "video")}
                    >
                      <Rocket size={13} />
                      В AI запуск рекламы
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>

        <section className="neu-card p-6">
          <SectionTitle
            icon={ImagePlus}
            title="Фото-креатив"
            subtitle="Загрузите фото клиники — Medina OS соберёт готовый рекламный креатив с безопасным текстом. Скачайте или отправьте в AI запуск рекламы."
          />

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p style={labelStyle}>Фото клиники</p>
              <input
                ref={photoFileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => onPhotoFileSelected(event.target.files?.[0] || null)}
              />
              <button
                type="button"
                className="neu-btn inline-flex items-center gap-2 px-5 py-2.5 text-sm"
                onClick={() => photoFileInputRef.current?.click()}
              >
                <ImagePlus size={16} />
                {photoSourceName ? "Заменить фото" : "Загрузить фото"}
              </button>
              {photoSourceName ? <p className="mt-2 text-xs font-semibold text-[#64748B]">{photoSourceName}</p> : null}
            </div>
            <label>
              <span style={labelStyle}>Тип фото</span>
              <select style={inputStyle} value={photoSourceType} onChange={(event) => updatePhotoSourceType(event.target.value)}>
                {photoSourceTypes.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <p className="mt-4" style={labelStyle}>Формат</p>
          <div className="mb-3 flex flex-wrap gap-2">
            {photoFormats.map((format) => (
              <button
                key={format.id}
                type="button"
                className={`rounded-full border px-4 py-2 text-xs font-black ${
                  photoFormat === format.id ? "border-[#0D9488] bg-[#0D9488] text-white" : "border-[#E7ECF3] bg-white text-[#475569]"
                }`}
                onClick={() => updatePhotoFormat(format.id)}
              >
                {format.label}
              </button>
            ))}
          </div>

          <p style={labelStyle}>Макет</p>
          <div className="mb-4 flex flex-wrap gap-2">
            {photoLayouts.map((layout) => (
              <button
                key={layout.id}
                type="button"
                className={`rounded-full border px-4 py-2 text-xs font-black ${
                  photoLayout === layout.id ? "border-[#0D9488] bg-[#0D9488] text-white" : "border-[#E7ECF3] bg-white text-[#475569]"
                }`}
                onClick={() => updatePhotoLayout(layout.id)}
              >
                {layout.label}
              </button>
            ))}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Заголовок" value={photoTexts.headline} onChange={(value) => updatePhotoTexts("headline", value)} />
            <Field label="Оффер" value={photoTexts.offer} onChange={(value) => updatePhotoTexts("offer", value)} />
            <Field label="CTA" value={photoTexts.cta} onChange={(value) => updatePhotoTexts("cta", value)} />
            <Field label="Дисклеймер (необязательно)" value={photoTexts.disclaimer} onChange={(value) => updatePhotoTexts("disclaimer", value)} />
          </div>

          {photoCompliance.status !== "safe" ? (
            <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-900">
              {/*
                Заголовок раньше был один на все случаи и утверждал, что в
                тексте есть рискованная формулировка. Единственное замечание
                уровня review может быть про отсутствующий дисклеймер — то есть
                про то, чего в тексте НЕТ. Называть это рискованной
                формулировкой значит сообщать клинике неправду о её же тексте.
              */}
              {photoCompliance.issues.some((issue) => issue.code !== "missing_disclaimer")
                ? `Рискованные формулировки для медицинской рекламы — ${
                    photoCompliance.status === "blocked" ? "перепишите текст перед использованием." : "проверьте текст вручную."
                  }`
                : "Текст без запрещённых формулировок, но дисклеймера в нём нет."}
              <ul className="mt-1 space-y-1">
                {(photoCompliance.issues || []).map((issue, index) => (
                  <li key={`photo-issue-${index}`}>• {issue.message}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {photoSuggestMode === "demo" ? (
            <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-900">
              {DEMO_AI_NOTICE}
            </div>
          ) : null}

          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              className="neu-btn inline-flex items-center gap-2 px-4 py-2.5 text-sm"
              disabled={photoBusy === "suggest"}
              onClick={() => void suggestPhotoTexts()}
            >
              <Sparkles size={15} />
              {photoBusy === "suggest" ? "Подбираем тексты..." : "Предложить тексты"}
            </button>
            <button
              type="button"
              className="neu-btn-primary inline-flex items-center gap-2 px-4 py-2.5 text-sm"
              disabled={photoBusy === "render"}
              onClick={() => void generatePhotoLayout()}
            >
              <WandSparkles size={15} />
              {photoBusy === "render" ? "Собираем макет..." : "Сгенерировать макет"}
            </button>
            <button type="button" className="neu-btn inline-flex items-center gap-2 px-4 py-2.5 text-sm" onClick={downloadPhotoCreative}>
              <Download size={15} />
              Скачать изображение
            </button>
            <button type="button" className="neu-btn inline-flex items-center gap-2 px-4 py-2.5 text-sm" onClick={copyPhotoTexts}>
              <Copy size={15} />
              Копировать текст
            </button>
            <button
              type="button"
              className="neu-btn inline-flex items-center gap-2 px-4 py-2.5 text-sm"
              disabled={photoBusy === "render"}
              onClick={() => void createAnotherPhotoVersion()}
            >
              <RefreshCw size={15} />
              Создать другую версию
            </button>
            <button
              type="button"
              className="neu-btn-primary inline-flex items-center gap-2 px-4 py-2.5 text-sm"
              disabled={photoBusy === "handoff"}
              onClick={() => void usePhotoInAdsAutomation()}
            >
              <Rocket size={15} />
              {photoBusy === "handoff" ? "Передаём..." : "Использовать в AI запуске рекламы"}
            </button>
          </div>

          {photoSourceUrl || photoPreviewUrl ? (
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <div className="neu-sm p-3">
                <p className="mb-2 text-xs font-bold uppercase text-[#64748B]">До: исходное фото</p>
                {photoSourceUrl ? (
                  <img src={photoSourceUrl} alt="Исходное фото клиники" className="max-h-[420px] w-full rounded-xl object-contain" />
                ) : (
                  <p className="text-sm font-semibold text-[#64748B]">Загрузите фото клиники.</p>
                )}
              </div>
              <div className="neu-sm p-3">
                <p className="mb-2 text-xs font-bold uppercase text-[#64748B]">После: готовый креатив</p>
                {photoPreviewUrl ? (
                  <img src={photoPreviewUrl} alt="Готовый фото-креатив" className="max-h-[420px] w-full rounded-xl object-contain" />
                ) : (
                  <p className="text-sm font-semibold text-[#64748B]">Нажмите «Сгенерировать макет», чтобы увидеть креатив.</p>
                )}
              </div>
            </div>
          ) : null}
        </section>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="neu-card p-6">
            <SectionTitle
              icon={Clapperboard}
              title="Идея ролика"
              subtitle="Сохраните базовые параметры ролика. Для MVP они лежат в localStorage и доступны после обновления страницы."
            />
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Название" value={form.title} onChange={(value) => updateIdeaForm("title", value)} />
              <Field label="Ниша" value={form.niche} onChange={(value) => updateIdeaForm("niche", value)} />
              <Field label="Цель" value={form.goal} onChange={(value) => updateIdeaForm("goal", value)} />
              <Field label="Аудитория" value={form.audience} onChange={(value) => updateIdeaForm("audience", value)} />
              <Field label="Стиль" value={form.style} onChange={(value) => updateIdeaForm("style", value)} />
              <Field label="Длительность" value={form.duration} onChange={(value) => updateIdeaForm("duration", value)} />
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              <button type="button" className="neu-btn-primary flex items-center gap-2 px-5 py-2.5 text-sm" onClick={createIdea} disabled={loading === "video"}>
                <Check size={15} />
                {loading === "video" ? "Сохраняем..." : "Создать идею"}
              </button>
              <button type="button" className="neu-btn flex items-center gap-2 px-5 py-2.5 text-sm" onClick={generateScript} disabled={loading === "script"}>
                <WandSparkles size={15} />
                {loading === "script" ? "Генерируем..." : "Сгенерировать сценарий"}
              </button>
            </div>
          </section>

          <aside className="neu-card p-6">
            <SectionTitle icon={Sparkles} title="Обзор" subtitle="Текущий ролик и последние сохранённые идеи." />
            <div className="space-y-3">
              <div className="neu-sm p-4">
                <p className="text-xs font-bold uppercase text-[#64748B]">Текущий статус</p>
                <p className="mt-2 text-xl font-black text-[#0B1220]">{statusLabels[current.status]}</p>
              </div>
              <div>
                <p className="mb-2 text-xs font-bold uppercase text-[#64748B]">Последние ролики</p>
                <div className="space-y-2">
                  {videos.length === 0 ? (
                    <p className="text-sm text-[#64748B]">Созданные идеи появятся здесь.</p>
                  ) : (
                    videos.slice(0, 4).map((video) => (
                      <button
                        key={video.id}
                        type="button"
                        onClick={() => selectLibraryVideo(video.id)}
                        className={`w-full rounded-xl border p-3 text-left text-sm transition ${
                          video.id === current.id ? "border-[#1A56DB] bg-[#EFF6FF]" : "border-[#E7ECF3] bg-white"
                        }`}
                      >
                        <span className="font-bold text-[#0B1220]">{video.title}</span>
                        <span className="mt-1 block text-xs text-[#64748B]">{statusLabels[video.status]}</span>
                        {video.contentApproval ? (
                          <span className="mt-1 block text-xs font-bold text-emerald-700">
                            Согласовано для рекламы · {video.contentApproval.variantLabel || "выбранный вариант"}
                          </span>
                        ) : null}
                      </button>
                    ))
                  )}
                </div>
              </div>
            </div>
          </aside>
        </div>

        <section className="neu-card p-6">
          <SectionTitle icon={FileText} title="Сценарий" subtitle="Hook, script, voiceover, CTA, caption и hashtags без сырого JSON." />
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="neu-sm p-4">
              <p className="text-xs font-bold uppercase text-[#64748B]">Hook</p>
              <p className="mt-2 text-sm leading-relaxed text-[#0B1220]">{current.hook || "Данные появятся после генерации."}</p>
            </div>
            <div className="neu-sm p-4 lg:col-span-2">
              <p className="text-xs font-bold uppercase text-[#64748B]">Script</p>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[#334155]">{current.script || "Данные появятся после генерации."}</p>
            </div>
            <div className="neu-sm p-4">
              <p className="text-xs font-bold uppercase text-[#64748B]">Voiceover</p>
              <p className="mt-2 text-sm leading-relaxed text-[#334155]">{current.voiceover || "Данные появятся после генерации."}</p>
            </div>
            <div className="neu-sm p-4">
              <p className="text-xs font-bold uppercase text-[#64748B]">CTA</p>
              <p className="mt-2 text-sm leading-relaxed text-[#334155]">{current.cta || "Данные появятся после генерации."}</p>
            </div>
            <div className="neu-sm p-4">
              <p className="text-xs font-bold uppercase text-[#64748B]">Caption / hashtags</p>
              <p className="mt-2 text-sm leading-relaxed text-[#334155]">{current.caption || "Данные появятся после генерации."}</p>
              {/* Здесь стояли три придуманных хэштега — они появлялись даже
                  тогда, когда модель не вернула ни одного, и выглядели как
                  результат генерации. Пустой список честнее выдуманного. */}
              <div className="mt-3 flex flex-wrap gap-2">
                {current.hashtags?.length ? (
                  current.hashtags.map((tag) => (
                    <span key={tag} className="rounded-full bg-[#E0F2FE] px-3 py-1 text-xs font-bold text-[#0369A1]">
                      {tag}
                    </span>
                  ))
                ) : (
                  <span className="text-xs font-semibold text-[#64748B]">Хэштеги появятся после генерации сценария.</span>
                )}
              </div>
            </div>
          </div>
        </section>

        <div className="grid gap-6 xl:grid-cols-2">
          <section className="neu-card p-6">
            <SectionTitle icon={WandSparkles} title="Avatar prompt" subtitle="Prompt для реалистичного AI-аватара." />
            <PromptBox title="Avatar prompt" value={current.avatarPrompt} onCopy={() => copyText(current.avatarPrompt || "", "Avatar prompt")} />
            <button type="button" className="neu-btn-primary mt-4 flex items-center gap-2 px-5 py-2.5 text-sm" onClick={() => generatePrompt("avatar")} disabled={loading === "avatar"}>
              <Sparkles size={15} />
              {loading === "avatar" ? "Генерируем..." : "Сгенерировать Avatar prompt"}
            </button>
          </section>

          <section className="neu-card p-6">
            <SectionTitle icon={Rocket} title="TapNow prompt" subtitle="Prompt для сцены и визуального ролика." />
            <PromptBox title="TapNow prompt" value={current.tapnowPrompt} onCopy={() => copyText(current.tapnowPrompt || "", "TapNow prompt")} />
            <button type="button" className="neu-btn-primary mt-4 flex items-center gap-2 px-5 py-2.5 text-sm" onClick={() => generatePrompt("tapnow")} disabled={loading === "tapnow"}>
              <Rocket size={15} />
              {loading === "tapnow" ? "Генерируем..." : "Сгенерировать TapNow prompt"}
            </button>
          </section>
        </div>

        <section className="neu-card p-6">
          <SectionTitle
            icon={Send}
            title="Telegram handoff"
            subtitle="Пакет можно отправить в Telegram или скопировать, если Telegram env ещё не подключены."
          />
          {/* Сообщение теперь выводится один раз — вверху страницы. */}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
            <textarea readOnly style={{ ...inputStyle, minHeight: 230, resize: "vertical", background: "#FFFFFF" }} value={packageText} />
            <div className="flex flex-col gap-3">
              <button type="button" className="neu-btn-primary flex items-center justify-center gap-2 px-5 py-2.5 text-sm" onClick={sendTelegram} disabled={loading === "telegram"}>
                <Send size={15} />
                {loading === "telegram" ? "Отправляем..." : "Отправить в Telegram"}
              </button>
              <button type="button" className="neu-btn flex items-center justify-center gap-2 px-5 py-2.5 text-sm" onClick={testTelegram} disabled={loading === "telegram-test"}>
                <Check size={15} />
                {loading === "telegram-test" ? "Проверяем..." : "Проверить Telegram"}
              </button>
              <button type="button" className="neu-btn flex items-center justify-center gap-2 px-5 py-2.5 text-sm" onClick={() => copyText(packageText, "Content package")}>
                <Copy size={15} />
                Copy package
              </button>
            </div>
          </div>
        </section>

        <section className="neu-card p-6">
          <SectionTitle
            icon={Clapperboard}
            title="Как собирается ролик"
            subtitle="Что делает Medina OS и что остаётся сделать во внешних инструментах."
          />
          <div className="grid gap-3 md:grid-cols-4">
            {workflow.map((item, index) => (
              <div key={item.step} className="neu-sm p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-black text-[#1A56DB]">{String(index + 1).padStart(2, "0")}</p>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-black uppercase ${
                      item.inProduct ? "bg-[#D1FAE5] text-[#065F46]" : "bg-[#F1F5F9] text-[#64748B]"
                    }`}
                  >
                    {item.inProduct ? "в Medina OS" : "вручную"}
                  </span>
                </div>
                <p className="mt-2 text-sm font-bold text-[#0B1220]">{item.step}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </PageLayout>
  );
}

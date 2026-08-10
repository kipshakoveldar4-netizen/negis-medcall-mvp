import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
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
import { apiUrl, crmFetch } from "@/lib/api";
import { supabase, hasSupabaseFrontendEnv } from "@/lib/supabase";
import { readWorkspaceId, workspaceScopedKey } from "@/lib/demoStorage";
import { checkMetaCompliance } from "../../../../lib/meta/compliance";
import type { ContentPackage } from "../../../../lib/content-studio/core";

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
  status: ContentVideoStatus;
  createdAt: string;
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
      hint?: string;
    };

type TelegramResponse = {
  sent: boolean;
  packageText: string;
  test?: boolean;
  parts?: number;
};

const STORAGE_KEY = "negis_content_studio_videos";

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
  mimeType: string;
  model: string;
  fileSize: number;
};

type VideoJobState = {
  handle: string;
  status: "queued" | "in_progress" | "completed" | "failed";
  progress: number;
  formatSubstituted: boolean;
};

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
 * Медицинских данных здесь нет: подписанный идентификатор задачи и ссылка на
 * публичный файл креатива. Готовая задача хранится вместе со ссылкой, поэтому
 * возврат на страницу показывает результат, а не опрашивает провайдера заново —
 * повторный опрос готовой задачи скачал бы и записал тот же ролик второй раз.
 */
const VIDEO_JOB_KEY = "negis_content_studio_video_job";

type StoredVideoJob = VideoJobState & { url?: string; mimeType?: string; fileSize?: number };

function readStoredVideoJob(): StoredVideoJob | null {
  try {
    const raw = localStorage.getItem(workspaceScopedKey(VIDEO_JOB_KEY));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredVideoJob;
    return parsed && typeof parsed.handle === "string" && parsed.handle ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredVideoJob(value: StoredVideoJob | null) {
  try {
    const key = workspaceScopedKey(VIDEO_JOB_KEY);
    if (value) localStorage.setItem(key, JSON.stringify(value));
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
  failed: "Генерация не удалась",
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
    ctx.fillStyle = "rgba(255,255,255,0.94)";
    ctx.fillRect(0, height - bottomBand, width, bottomBand);
    ctx.fillStyle = "#334155";
    const afterOffer = drawWrapped(ctx, texts.offer, margin, height - bottomBand + margin * 0.6, contentWidth, offerLine);
    ctx.fillStyle = "#0D9488";
    drawRoundedRect(ctx, margin, afterOffer + margin * 0.3, Math.min(contentWidth, width * 0.62), Math.round(width * 0.09), Math.round(width * 0.045));
    ctx.fill();
    ctx.fillStyle = "#FFFFFF";
    ctx.font = ctaFont;
    ctx.fillText(texts.cta, margin + Math.round(width * 0.04), afterOffer + margin * 0.3 + Math.round(width * 0.026));
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
    ctx.fillStyle = "#FFFFFF";
    cursor = drawWrapped(ctx, texts.headline, margin, cursor, contentWidth, headlineLine);
    ctx.font = offerFont;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    cursor = drawWrapped(ctx, texts.offer, margin, cursor + Math.round(width * 0.015), contentWidth, offerLine);
    ctx.fillStyle = "#2DD4BF";
    ctx.font = ctaFont;
    ctx.fillText(`→ ${texts.cta}`, margin, cursor + Math.round(width * 0.02));
  }

  if (layout === "medical_card") {
    ctx.font = headlineFont;
    const headlineLines = wrapCanvasText(ctx, texts.headline, contentWidth - margin);
    ctx.font = offerFont;
    const offerLines = wrapCanvasText(ctx, texts.offer, contentWidth - margin);
    const cardHeight = headlineLines.length * headlineLine + offerLines.length * offerLine + Math.round(width * 0.22);
    const cardTop = height - cardHeight - margin;
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
    ctx.fillText(texts.cta, margin * 1.3, cursor + Math.round(width * 0.015));
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
    drawWrapped(ctx, texts.offer, margin, cursor + Math.round(width * 0.04), contentWidth, offerLine);
    ctx.font = ctaFont;
    ctx.fillStyle = "#FFFFFF";
    const ctaY = height - margin - Math.round(width * 0.05);
    ctx.fillText(texts.cta, margin, ctaY);
    ctx.fillRect(margin, ctaY + Math.round(width * 0.05), ctx.measureText(texts.cta).width, 2);
  }

  if (texts.disclaimer.trim()) {
    ctx.font = `500 ${Math.round(width * 0.02)}px Inter, Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillStyle = layout === "top_bottom" || layout === "medical_card" ? "rgba(51,65,85,0.85)" : "rgba(255,255,255,0.8)";
    ctx.fillText(texts.disclaimer, width / 2, height - Math.round(width * 0.035));
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

const initialVideo: Omit<ContentVideo, "id" | "status" | "createdAt"> = {
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

function readVideos(): ContentVideo[] {
  try {
    const raw = localStorage.getItem(workspaceScopedKey(STORAGE_KEY));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ContentVideo[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeVideos(videos: ContentVideo[]) {
  localStorage.setItem(workspaceScopedKey(STORAGE_KEY), JSON.stringify(videos));
}

function combinePrompt(result: PromptPackage) {
  return [result.prompt, result.negativePrompt ? `Negative prompt: ${result.negativePrompt}` : null]
    .filter(Boolean)
    .join("\n\n");
}

function telegramErrorMessage<TData>(body: ApiResponse<TData> | null, fallback: string) {
  if (body?.success === false) {
    const description = body.details?.filter(Boolean).join(", ") || body.telegramDescription || body.error;
    return `${fallback}: ${description}${body.hint ? `. ${body.hint}` : ""}`;
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
  const [, setLocation] = useLocation();
  const [form, setForm] = useState(initialVideo);
  const [videos, setVideos] = useState<ContentVideo[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [loading, setLoading] = useState<"video" | "script" | "avatar" | "tapnow" | "telegram" | "telegram-test" | "package" | null>(null);
  const [notice, setNotice] = useState("");
  const [packageBrief, setPackageBrief] = useState<PackageBrief>(defaultPackageBrief);
  const [contentPackage, setContentPackage] = useState<ContentPackage | null>(null);
  const [packageGenerationMode, setPackageGenerationMode] = useState("");
  const [contentPackageId, setContentPackageId] = useState("");
  const photoFileInputRef = useRef<HTMLInputElement | null>(null);
  const [photoSourceUrl, setPhotoSourceUrl] = useState("");
  const [photoSourceName, setPhotoSourceName] = useState("");
  const [photoSourceType, setPhotoSourceType] = useState(photoSourceTypes[0]);
  const [photoFormat, setPhotoFormat] = useState<PhotoFormatId>("story");
  const [photoLayout, setPhotoLayout] = useState<PhotoLayoutId>("gradient_bottom");
  const [photoTexts, setPhotoTexts] = useState<PhotoCreativeTexts>(defaultPhotoTexts);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState("");
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const [photoBusy, setPhotoBusy] = useState<"render" | "suggest" | "handoff" | null>(null);
  const [photoSuggestMode, setPhotoSuggestMode] = useState("");

  const [genPrompt, setGenPrompt] = useState("");
  const [genFormat, setGenFormat] = useState("reels");
  const [genBusy, setGenBusy] = useState<"photo" | "video" | null>(null);
  const [genNotice, setGenNotice] = useState<GenerationNotice | null>(null);
  const [genImage, setGenImage] = useState<GeneratedFile | null>(null);
  const [genVideo, setGenVideo] = useState<GeneratedFile | null>(null);
  const [videoJob, setVideoJob] = useState<VideoJobState | null>(null);

  const updatePhotoTexts = (key: keyof PhotoCreativeTexts, value: string) =>
    setPhotoTexts((current) => ({ ...current, [key]: value }));

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
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Загрузите изображение (JPG, PNG или WEBP)");
      return;
    }
    if (photoSourceUrl.startsWith("blob:")) URL.revokeObjectURL(photoSourceUrl);
    if (photoPreviewUrl.startsWith("blob:")) URL.revokeObjectURL(photoPreviewUrl);
    setPhotoSourceUrl(URL.createObjectURL(file));
    setPhotoSourceName(file.name);
    setPhotoPreviewUrl("");
    setPhotoBlob(null);
  };

  const suggestPhotoTexts = async () => {
    setPhotoBusy("suggest");
    try {
      const response = await crmFetch(withWorkspace("/api/content-studio/generate-package"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
                    mode: "ads",
          format: photoFormat,
          service: packageBrief.service,
          city: packageBrief.city,
          offer: packageBrief.offer,
          audience: packageBrief.audience,
          goal: packageBrief.goal,
          tone: packageBrief.tone,
          materialNotes: `${photoSourceType}${photoSourceName ? `: ${photoSourceName}` : ""}`,
        }),
      });
      const body = await safeJson<ContentPackage>(response);
      if (!response.ok || body?.success !== true) {
        throw new Error(body?.success === false ? body.error : "Не удалось предложить тексты");
      }
      setPhotoTexts((current) => ({
        ...current,
        headline: body.data.adHeadline || current.headline,
        offer: packageBrief.offer || body.data.adPrimaryText.split(".")[0] || current.offer,
        cta: body.data.cta || current.cta,
      }));
      setPhotoSuggestMode(body.mode);
      toast.success(body.mode === "demo" ? "Demo-тексты готовы" : "Тексты готовы");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Ошибка генерации текстов");
    } finally {
      setPhotoBusy(null);
    }
  };

  const generatePhotoLayout = async (layoutOverride?: PhotoLayoutId) => {
    if (!photoSourceUrl) {
      toast.error("Сначала загрузите фото клиники");
      return;
    }
    const layout = layoutOverride || photoLayout;
    setPhotoBusy("render");
    try {
      const format = photoFormats.find((item) => item.id === photoFormat) || photoFormats[0];
      const blob = await renderPhotoCreative({
        imageUrl: photoSourceUrl,
        width: format.width,
        height: format.height,
        layout,
        texts: photoTexts,
      });
      if (!blob) throw new Error("Не удалось создать макет");
      if (photoPreviewUrl.startsWith("blob:")) URL.revokeObjectURL(photoPreviewUrl);
      setPhotoBlob(blob);
      setPhotoPreviewUrl(URL.createObjectURL(blob));
      toast.success("Макет креатива готов");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Ошибка создания макета");
    } finally {
      setPhotoBusy(null);
    }
  };

  const createAnotherPhotoVersion = async () => {
    const currentIndex = photoLayouts.findIndex((item) => item.id === photoLayout);
    const next = photoLayouts[(currentIndex + 1) % photoLayouts.length].id;
    setPhotoLayout(next);
    await generatePhotoLayout(next);
  };

  const downloadPhotoCreative = () => {
    if (!photoPreviewUrl) {
      toast.error("Сначала сгенерируйте макет");
      return;
    }
    const link = document.createElement("a");
    link.href = photoPreviewUrl;
    link.download = `negis-photo-creative-${photoFormat}.jpg`;
    link.click();
    toast.success("Изображение скачивается");
  };

  const copyPhotoTexts = () =>
    void copyText([photoTexts.headline, photoTexts.offer, photoTexts.cta].filter(Boolean).join("\n"), "Тексты креатива");

  const usePhotoInAdsAutomation = async () => {
    if (!photoBlob) {
      toast.error("Сначала сгенерируйте макет");
      return;
    }
    setPhotoBusy("handoff");
    try {
      // Upload the rendered JPEG through the existing signed upload flow so
      // Ads Automation gets a real public creative URL.
      let creativeUrl = "";
      let fileName = `photo-creative-${Date.now()}.jpg`;
      if (hasSupabaseFrontendEnv) {
        try {
          const signedResponse = await crmFetch("/api/crm/ad-creatives/signed-upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                            fileName,
              fileType: "image",
              mimeType: "image/jpeg",
              fileSize: photoBlob.size,
            }),
          });
          const signedBody = await safeJson<{ bucket?: string; storageBucket?: string; storagePath?: string; token?: string; publicUrl?: string }>(signedResponse);
          if (signedResponse.ok && signedBody?.success === true) {
            const bucket = signedBody.data.bucket || signedBody.data.storageBucket || "ad-creatives";
            const storagePath = signedBody.data.storagePath || "";
            const token = signedBody.data.token || "";
            if (storagePath && token) {
              const { error: uploadError } = await supabase.storage.from(bucket).uploadToSignedUrl(storagePath, token, photoBlob, {
                contentType: "image/jpeg",
              });
              if (!uploadError) {
                creativeUrl = signedBody.data.publicUrl || "";
                if (!creativeUrl) {
                  const env = import.meta.env as Record<string, string | undefined>;
                  const supabaseUrl = (env.VITE_SUPABASE_URL || "").replace(/\/$/, "");
                  if (supabaseUrl) {
                    creativeUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${storagePath.split("/").map(encodeURIComponent).join("/")}`;
                  }
                }
              }
            }
          }
        } catch {
          creativeUrl = "";
        }
      }
      if (!creativeUrl) {
        toast.warning("Не удалось загрузить креатив в Storage — передаём только тексты. Изображение можно скачать и загрузить вручную.");
        fileName = "";
      }

      const formatLabel = photoFormats.find((item) => item.id === photoFormat)?.label || photoFormat;
      const layoutLabel = photoLayouts.find((item) => item.id === photoLayout)?.label || photoLayout;

      // Persist metadata: content_videos keeps the whole body in raw_payload.
      try {
        await crmFetch("/api/crm/content-videos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
                        title: photoTexts.headline,
            niche: packageBrief.service,
            goal: "photo_creative",
            style: layoutLabel,
            audience: packageBrief.audience,
            caption: photoTexts.offer,
            cta: photoTexts.cta,
            status: "idea",
            photoCreative: {
              format: photoFormat,
              layout: photoLayout,
              sourceType: photoSourceType,
              creativeUrl,
              texts: photoTexts,
            },
          }),
        });
      } catch {
        // Metadata persistence is best-effort in demo mode.
      }

      localStorage.setItem(
        workspaceScopedKey("negis_ads_automation_prefill"),
        JSON.stringify({
          source: "content_studio_photo",
          service: packageBrief.service,
          city: packageBrief.city,
          offer: photoTexts.offer,
          audience: packageBrief.audience,
          adText: `${photoTexts.offer}. ${photoTexts.cta}.`,
          headline: photoTexts.headline,
          cta: "LEARN_MORE",
          format: photoFormat,
          creativeUrl,
          creativeType: "image",
          fileName,
          mimeType: "image/jpeg",
          fileSize: photoBlob.size,
          creativeBrief: `Фото-креатив: ${layoutLabel}, формат ${formatLabel}, CTA «${photoTexts.cta}»`,
          generatedAt: new Date().toISOString(),
          title: photoTexts.headline,
        }),
      );
      toast.success("Фото-креатив передан в AI запуск рекламы");
      setLocation("/ads-automation");
    } finally {
      setPhotoBusy(null);
    }
  };

  // --- Настоящая генерация изображения и видео -----------------------------

  const generatePhoto = async () => {
    const prompt = genPrompt.trim();
    if (!prompt) {
      setGenNotice({ tone: "warning", text: "Опишите кадр — без описания генерировать нечего." });
      return;
    }

    setGenBusy("photo");
    setGenNotice(null);
    try {
      const response = await crmFetch(withWorkspace("/api/content-studio/generate-photo"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, format: genFormat }),
      });
      const body = await safeJson<{
        creativeUrl: string;
        mimeType: string;
        model: string;
        fileSize: number;
      }>(response);

      if (!response.ok || body?.success !== true) {
        setGenNotice({
          tone: "error",
          text: generationRefusalText(body, response.status, "Не удалось сгенерировать изображение"),
        });
        return;
      }

      setGenImage({
        url: body.data.creativeUrl,
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
    } catch (error) {
      setGenNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Не удалось сгенерировать изображение",
      });
    } finally {
      setGenBusy(null);
    }
  };

  const generateVideo = async () => {
    const prompt = genPrompt.trim();
    if (!prompt) {
      setGenNotice({ tone: "warning", text: "Опишите ролик — без описания генерировать нечего." });
      return;
    }

    setGenBusy("video");
    setGenNotice(null);
    setGenVideo(null);
    // Прошлая задача перестаёт нас интересовать в тот же момент, когда
    // поставлена новая — и в состоянии тоже, а не только в хранилище. Пока
    // ответ на новый POST не пришёл, карточка иначе показывала бы «Ролик готов
    // 100%» от прошлой задачи рядом с кнопкой «Отправляем задачу...», причём
    // без самого ролика: genVideo уже очищен строкой выше.
    setVideoJob(null);
    writeStoredVideoJob(null);
    try {
      const response = await crmFetch(withWorkspace("/api/content-studio/generate-video"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, format: genFormat }),
      });
      const body = await safeJson<{
        handle: string;
        status: VideoJobState["status"];
        progress: number;
        formatSubstituted: boolean;
      }>(response);

      if (!response.ok || body?.success !== true) {
        setVideoJob(null);
        setGenNotice({
          tone: "error",
          text: generationRefusalText(body, response.status, "Не удалось запустить генерацию видео"),
        });
        return;
      }

      // Подмена формата живёт в карточке задачи, а не в genNotice: genNotice
      // общий с генерацией изображения, и один клик по соседней кнопке стирал
      // бы предупреждение о том, что «квадратный» ролик на самом деле 9:16.
      setVideoJob({
        handle: body.data.handle,
        status: body.data.status,
        progress: body.data.progress,
        formatSubstituted: Boolean(body.data.formatSubstituted),
      });
    } catch (error) {
      setVideoJob(null);
      setGenNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Не удалось запустить генерацию видео",
      });
    } finally {
      setGenBusy(null);
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
    if (!videoJob) return;
    if (videoJob.status === "completed" || videoJob.status === "failed") return;

    const handle = videoJob.handle;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    // Одного флага достаточно: React всегда выполняет очистку предыдущего
    // эффекта до запуска следующего, поэтому к моменту старта новой задачи
    // старая цепочка уже помечена как остановленная. Счётчик поколений здесь
    // был бы вторым названием того же условия — и следующему читателю пришлось
    // бы гадать, какое из двух настоящее.
    const isStale = () => stopped;

    const tick = async () => {
      if (isStale()) return;
      try {
        const response = await crmFetch(
          withWorkspace(`/api/content-studio/video-generation?handle=${encodeURIComponent(handle)}`),
        );
        const body = await safeJson<{
          status: VideoJobState["status"];
          progress: number;
          creativeUrl?: string;
          failureReason?: string;
          mimeType?: string;
          fileSize?: number;
        }>(response);
        if (isStale()) return;

        if (!response.ok || body?.success !== true) {
          setVideoJob((current) => (current && current.handle === handle ? { ...current, status: "failed" } : current));
          setGenNotice({
            tone: "error",
            text: generationRefusalText(body, response.status, "Не удалось получить состояние ролика"),
          });
          return;
        }

        setVideoJob((current) =>
          current && current.handle === handle
            ? { ...current, status: body.data.status, progress: body.data.progress }
            : current,
        );

        if (body.data.status === "failed") {
          setGenNotice({
            tone: "error",
            text: `Сервис генерации не смог собрать ролик: ${body.data.failureReason || "причина не сообщена"}.`,
          });
          return;
        }

        if (body.data.status === "completed") {
          const url = body.data.creativeUrl || "";
          if (!url) {
            setGenNotice({
              tone: "error",
              text: "Сервис сообщил, что ролик готов, но ссылка на файл не пришла.",
            });
            return;
          }
          setGenVideo({
            url,
            mimeType: body.data.mimeType || "video/mp4",
            model: "",
            fileSize: body.data.fileSize || 0,
          });
          if (body.warning) {
            setGenNotice({
              tone: "warning",
              text: `Ролик сохранён, ссылка работает, но запись в библиотеке креативов не создана: ${body.warning}`,
            });
          }
          toast.success("Ролик готов");
          return;
        }
      } catch (error) {
        if (isStale()) return;
        setGenNotice({
          tone: "warning",
          text: error instanceof Error ? error.message : "Связь с сервером прервалась, опрос продолжается.",
        });
      }

      if (isStale()) return;
      timer = setTimeout(() => void tick(), VIDEO_POLL_INTERVAL_MS);
    };

    // Первый опрос — сразу. Так карточка перестаёт стоять на нуле двенадцать
    // секунд, и так же работает кнопка «Проверить ещё раз»: она возвращает
    // статус в «идёт рендер», эффект перезапускается и спрашивает немедленно.
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [videoJob?.handle, videoJob?.status]);

  // Задача и её результат переживают уход со страницы: см. VIDEO_JOB_KEY.
  useEffect(() => {
    if (!videoJob) return;
    writeStoredVideoJob({
      ...videoJob,
      url: genVideo?.url,
      mimeType: genVideo?.mimeType,
      fileSize: genVideo?.fileSize,
    });
  }, [videoJob, genVideo]);

  const useGeneratedInAdsAutomation = (file: GeneratedFile, creativeType: "image" | "video") => {
    localStorage.setItem(
      workspaceScopedKey("negis_ads_automation_prefill"),
      JSON.stringify({
        source: "content_studio_generated",
        service: packageBrief.service,
        city: packageBrief.city,
        offer: packageBrief.offer,
        audience: packageBrief.audience,
        adText: contentPackage?.adPrimaryText || packageBrief.offer,
        headline: contentPackage?.adHeadline || packageBrief.service,
        caption: contentPackage?.caption,
        cta: "LEARN_MORE",
        format: genFormat,
        creativeUrl: file.url,
        creativeType,
        mimeType: file.mimeType,
        fileSize: file.fileSize,
        creativeBrief: genPrompt.trim(),
        generatedAt: new Date().toISOString(),
        title: contentPackage?.ideaTitle || packageBrief.service,
      }),
    );
    toast.success(creativeType === "image" ? "Изображение передано в AI запуск рекламы" : "Ролик передан в AI запуск рекламы");
    setLocation("/ads-automation");
  };

  const updatePackageBrief = (key: keyof PackageBrief, value: string) =>
    setPackageBrief((current) => ({ ...current, [key]: value }));

  const packageCompliance = useMemo(
    () =>
      contentPackage
        ? checkMetaCompliance({
            headline: contentPackage.adHeadline,
            text: contentPackage.adPrimaryText,
            description: contentPackage.caption,
          })
        : null,
    [contentPackage],
  );

  const generatePackage = async () => {
    setLoading("package");
    setNotice("");
    try {
      const response = await crmFetch(withWorkspace("/api/content-studio/generate-package"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...packageBrief }),
      });
      const body = await safeJson<ContentPackage>(response);
      if (!response.ok || body?.success !== true) {
        throw new Error(body?.success === false ? body.error : "Не удалось сгенерировать пакет контента");
      }
      setContentPackage(body.data);
      setPackageGenerationMode(body.mode);
      // Готовый photo prompt — это ровно то, что нужно генератору изображения.
      // Заполняем только пустое поле: перезаписать текст, который оператор уже
      // правил руками, — худшее, что здесь можно сделать.
      setGenPrompt((current) => (current.trim() ? current : body.data.photoPrompt));
      toast.success(body.mode === "demo" ? "Demo-пакет контента готов" : "Пакет контента готов");

      // Persist the package: content_videos stores the whole body in raw_payload.
      try {
        const saveResponse = await crmFetch("/api/crm/content-videos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
                        title: body.data.ideaTitle,
            niche: packageBrief.service,
            goal: packageBrief.goal,
            duration: "30-45 seconds",
            style: packageBrief.tone,
            audience: packageBrief.audience,
            hook: body.data.hook,
            script: body.data.script,
            voiceover: body.data.voiceover,
            cta: body.data.cta,
            caption: body.data.caption,
            status: "script_ready",
            packageBrief,
            packageData: body.data,
          }),
        });
        const saveBody = await safeJson<{ video?: { id?: string }; item?: { id?: string } }>(saveResponse);
        if (saveBody?.success === true) {
          const savedId = saveBody.data.video?.id || saveBody.data.item?.id || "";
          if (savedId) setContentPackageId(savedId);
        }
      } catch {
        // localStorage/demo mode: the package still lives in state.
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ошибка генерации пакета";
      setNotice(message);
      toast.error(message);
    } finally {
      setLoading(null);
    }
  };

  const useInAdsAutomation = () => {
    if (!contentPackage) {
      toast.error("Сначала сгенерируйте пакет контента");
      return;
    }
    localStorage.setItem(
      workspaceScopedKey("negis_ads_automation_prefill"),
      JSON.stringify({
        source: "content_studio",
        service: packageBrief.service,
        city: packageBrief.city,
        offer: packageBrief.offer,
        audience: packageBrief.audience,
        adText: contentPackage.adPrimaryText,
        headline: contentPackage.adHeadline,
        caption: contentPackage.caption,
        cta: contentPackage.cta,
        format: packageBrief.format,
        creativeBrief: contentPackage.videoPrompt,
        generatedAt: new Date().toISOString(),
        contentPackageId: contentPackageId || undefined,
        title: contentPackage.ideaTitle,
      }),
    );
    toast.success("Пакет передан в AI запуск рекламы");
    setLocation("/ads-automation");
  };

  useEffect(() => {
    const storedJob = readStoredVideoJob();
    if (storedJob) {
      setVideoJob({
        handle: storedJob.handle,
        // Готовая задача без ссылки — состояние, которого быть не должно;
        // считаем её незавершённой, чтобы карточка не осталась мёртвой.
        status: storedJob.status === "completed" && !storedJob.url ? "in_progress" : storedJob.status,
        progress: storedJob.progress,
        formatSubstituted: Boolean(storedJob.formatSubstituted),
      });
      if (storedJob.url) {
        setGenVideo({
          url: storedJob.url,
          mimeType: storedJob.mimeType || "video/mp4",
          model: "",
          fileSize: storedJob.fileSize || 0,
        });
      }
    }

    const saved = readVideos();
    if (saved.length > 0) {
      setVideos(saved);
      setActiveId(saved[0].id);
    }

    const loadApiVideos = async () => {
      try {
        const workspaceId = readWorkspaceId();
        const response = await crmFetch(`/api/crm/content-videos?workspaceId=${encodeURIComponent(workspaceId)}`);
        const body = await safeJson<{ videos?: ContentVideo[]; items?: ContentVideo[] }>(response);
        if (!response.ok || body?.success !== true || body.mode !== "supabase") return;

        const apiVideos = body.data.videos ?? body.data.items ?? [];
        if (apiVideos.length === 0) return;

        const sorted = [...apiVideos].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setVideos(sorted);
        writeVideos(sorted);
        setActiveId(sorted[0].id);
      } catch {
        // Keep localStorage videos as the offline fallback.
      }
    };

    void loadApiVideos();
  }, []);

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

  const saveVideos = (nextVideos: ContentVideo[], selectedId?: string) => {
    const sorted = [...nextVideos].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    setVideos(sorted);
    writeVideos(sorted);
    if (selectedId) setActiveId(selectedId);
  };

  const updateCurrentVideo = (patch: Partial<ContentVideo>) => {
    if (!activeVideo) return;
    const nextVideo = { ...activeVideo, ...patch };
    saveVideos(videos.map((video) => (video.id === nextVideo.id ? nextVideo : video)), nextVideo.id);
    void persistCurrentVideoPatch(nextVideo.id, patch);
  };

  const persistCurrentVideoPatch = async (videoId: string, patch: Partial<ContentVideo>) => {
    try {
      const response = await crmFetch("/api/crm/content-videos", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: videoId,
                    ...patch,
        }),
      });
      // Ответ раньше не читался вообще: сценарий, prompt или статус могли не
      // сохраниться на сервере, а экран продолжал показывать их как записанные.
      // Ошибку здесь нельзя показывать как отказ — локальная копия уже
      // обновлена и работает, — но и молчать о ней нельзя.
      if (!response.ok) {
        const body = await safeJson<unknown>(response);
        setNotice(
          `${generationRefusalText(body, response.status, "Сервер не сохранил изменение")}. ` +
            "Изменение осталось только в этом браузере.",
        );
      }
    } catch {
      setNotice("Нет связи с сервером: изменение осталось только в этом браузере.");
    }
  };

  const copyText = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} скопирован`);
  };

  const createIdea = async () => {
    setLoading("video");
    setNotice("");

    try {
      const response = await crmFetch("/api/crm/content-videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
                  }),
      });
      const body = await safeJson<{ video: ContentVideo }>(response);
      const apiVideo = response.ok && body?.success === true ? body.data.video : null;
      const video: ContentVideo = apiVideo || {
        ...form,
        id: newVideoId(),
        status: "idea",
        createdAt: new Date().toISOString(),
      };

      saveVideos([video, ...videos.filter((item) => item.id !== video.id)], video.id);

      if (apiVideo) {
        toast.success("Идея ролика создана");
      } else {
        // Отказ сервера доходил сюда молча: ответ не проверялся, идея падала в
        // localStorage, и экран говорил «создана». На другом устройстве её не
        // было. Теперь видно и то, что сохранено локально, и почему.
        const message = generationRefusalText(body, response.status, "Сервер не принял идею");
        setNotice(`${message}. Идея сохранена только в этом браузере.`);
        toast.warning("Идея сохранена локально: сервер её не принял");
      }
    } catch {
      const fallbackVideo: ContentVideo = {
        ...form,
        id: newVideoId(),
        status: "idea",
        createdAt: new Date().toISOString(),
      };
      saveVideos([fallbackVideo, ...videos], fallbackVideo.id);
      toast.warning("API недоступен, идея сохранена локально");
    } finally {
      setLoading(null);
    }
  };

  const generateScript = async () => {
    setLoading("script");
    setNotice("");

    try {
      const payload = { ...form, ...activeVideo, videoId: activeVideo?.id };
      const response = await crmFetch(withWorkspace("/api/content-studio/generate-script"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await safeJson<ScriptPackage>(response);
      if (!response.ok || body?.success !== true) {
        throw new Error(body?.success === false ? body.error : "Не удалось сгенерировать сценарий");
      }

      const patch: Partial<ContentVideo> = {
        ...body.data,
        status: "script_ready",
      };

      if (activeVideo) {
        updateCurrentVideo(patch);
      } else {
        const video: ContentVideo = {
          ...form,
          ...patch,
          id: newVideoId(),
          status: "script_ready",
          createdAt: new Date().toISOString(),
        };
        saveVideos([video, ...videos], video.id);
      }

      toast.success(body.mode === "demo" ? "Demo-сценарий готов" : "Сценарий готов");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Ошибка генерации сценария");
    } finally {
      setLoading(null);
    }
  };

  const generatePrompt = async (kind: "avatar" | "tapnow") => {
    setLoading(kind);
    setNotice("");

    const path =
      kind === "avatar"
        ? "/api/content-studio/generate-avatar-prompt"
        : "/api/content-studio/generate-tapnow-prompt";

    try {
      const response = await crmFetch(withWorkspace(path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, ...activeVideo, videoId: activeVideo?.id }),
      });
      const body = await safeJson<PromptPackage>(response);
      if (!response.ok || body?.success !== true) {
        throw new Error(body?.success === false ? body.error : "Не удалось сгенерировать prompt");
      }

      const prompt = combinePrompt(body.data);
      updateCurrentVideo({
        [kind === "avatar" ? "avatarPrompt" : "tapnowPrompt"]: prompt,
        status: "avatar_ready",
      });
      toast.success(kind === "avatar" ? "Avatar prompt готов" : "TapNow prompt готов");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Ошибка генерации prompt");
    } finally {
      setLoading(null);
    }
  };

  const testTelegram = async () => {
    setLoading("telegram-test");
    setNotice("");

    try {
      const response = await crmFetch(withWorkspace("/api/content-studio/send-telegram"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: true }),
      });
      const body = await safeJson<TelegramResponse>(response);
      if (!response.ok || body?.success !== true) {
        const message = telegramErrorMessage(body, "Не удалось проверить Telegram");
        setNotice(message);
        toast.error(message);
        return;
      }

      if (body.data.sent && body.mode === "telegram") {
        setNotice("Telegram подключён");
        toast.success("Telegram подключён");
      } else {
        const message = body.warning || "Telegram не подключён, пакет готов для копирования.";
        setNotice(message);
        toast.warning(message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось проверить Telegram";
      setNotice(message);
      toast.error(message);
    } finally {
      setLoading(null);
    }
  };

  const sendTelegram = async () => {
    if (!activeVideo) {
      toast.error("Сначала создайте идею ролика");
      return;
    }

    setLoading("telegram");
    setNotice("");

    try {
      const response = await crmFetch(withWorkspace("/api/content-studio/send-telegram"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(activeVideo),
      });
      const body = await safeJson<TelegramResponse>(response);
      if (!response.ok || body?.success !== true) {
        const message = telegramErrorMessage(body, "Не удалось отправить в Telegram");
        setNotice(message);
        toast.error(message);
        return;
      }

      updateCurrentVideo({ status: "telegram_ready" });
      setNotice(
        body.warning ||
          (body.data.sent
            ? `Пакет отправлен в Telegram${body.data.parts && body.data.parts > 1 ? ` частями: ${body.data.parts}` : ""}.`
            : "Telegram не подключён, но пакет готов для копирования."),
      );
      toast.success(body.data.sent ? "Отправлено в Telegram" : "Пакет готов для копирования");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ошибка Telegram";
      setNotice(message);
      toast.error(message);
    } finally {
      setLoading(null);
    }
  };

  // AI Target is no longer a standalone module: the studio hands content
  // straight to Ads Automation, where "ИИ заполнит" covers targeting.
  const transferToAdsAutomation = () => {
    localStorage.setItem(
      workspaceScopedKey("negis_ads_automation_prefill"),
      JSON.stringify({
        sourceModule: "content-studio",
        sourceId: current.id,
        title: current.title || form.title,
        campaignName: current.title || form.title,
        service: current.niche || form.niche,
        niche: current.niche || form.niche,
        offer: current.cta || current.goal || form.goal,
        targetAudience: current.audience || form.audience,
        audience: current.audience || form.audience,
        primaryText: current.caption || current.script || current.hook || form.title,
        caption: current.caption,
        script: current.script,
        hook: current.hook,
        headline: current.hook || current.title || form.title,
        description: current.cta || current.goal || form.goal,
        cta: "LEARN_MORE",
      }),
    );
    toast.success("Контент передан в AI запуск рекламы");
    setLocation("/ads-automation");
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

              <div className="grid gap-4 xl:grid-cols-2">
                <PromptBox title="Сценарий Reels/TikTok" value={contentPackage.script} onCopy={() => void copyText(contentPackage.script, "Сценарий")} />
                <PromptBox title="Shot list" value={contentPackage.shotList.join("\n")} onCopy={() => void copyText(contentPackage.shotList.join("\n"), "Shot list")} />
                <PromptBox title="Текст на экране" value={contentPackage.textOnScreen.join("\n")} onCopy={() => void copyText(contentPackage.textOnScreen.join("\n"), "Текст на экране")} />
                <PromptBox title="Voiceover" value={contentPackage.voiceover} onCopy={() => void copyText(contentPackage.voiceover, "Voiceover")} />
                <PromptBox title="Caption для соцсетей" value={contentPackage.caption} onCopy={() => void copyText(contentPackage.caption, "Caption")} />
                <PromptBox
                  title="Текст объявления Meta"
                  value={`${contentPackage.adPrimaryText}\n\nЗаголовок: ${contentPackage.adHeadline}\nCTA: ${contentPackage.cta}`}
                  onCopy={() => void copyText(contentPackage.adPrimaryText, "Текст объявления")}
                />
                <PromptBox title="Photo prompt" value={contentPackage.photoPrompt} onCopy={() => void copyText(contentPackage.photoPrompt, "Photo prompt")} />
                <PromptBox title="Video prompt" value={contentPackage.videoPrompt} onCopy={() => void copyText(contentPackage.videoPrompt, "Video prompt")} />
                <PromptBox title="WhatsApp сообщение" value={contentPackage.whatsappMessage} onCopy={() => void copyText(contentPackage.whatsappMessage, "WhatsApp сообщение")} />
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
              disabled={genBusy !== null}
              onClick={() => void generatePhoto()}
            >
              <ImagePlus size={15} />
              {genBusy === "photo" ? "Генерируем изображение..." : "Сгенерировать изображение"}
            </button>
            <button
              type="button"
              className="neu-btn inline-flex items-center gap-2 px-4 py-2.5 text-sm"
              disabled={genBusy !== null || videoJob?.status === "queued" || videoJob?.status === "in_progress"}
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
              className={`mt-4 rounded-2xl border p-4 ${
                videoJob.status === "failed" ? "border-rose-200 bg-rose-50" : "border-[#E7ECF3] bg-white"
              }`}
              aria-live="polite"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className={`text-sm font-black ${videoJob.status === "failed" ? "text-rose-900" : "text-[#0B1220]"}`}>
                  {videoJobLabels[videoJob.status]}
                </p>
                <p className="text-sm font-bold text-[#64748B]">{videoJob.progress}%</p>
              </div>
              <div
                className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[#E7ECF3]"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={videoJob.progress}
                aria-label={videoJobLabels[videoJob.status]}
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
                  Рендер идёт на стороне сервиса и занимает минуты. Страницу можно закрыть: задача сохраняется и опрос
                  продолжится, когда вы вернётесь в этот раздел.
                </p>
              ) : null}
              {videoJob.status === "failed" ? (
                <div className="mt-3">
                  <p className="text-xs font-semibold text-rose-900">
                    Если рендер у сервиса уже закончился, повторная проверка заберёт готовый файл и не будет стоить ничего.
                    Кнопка «Сгенерировать видео» запустит новый платный рендер.
                  </p>
                  <button
                    type="button"
                    className="neu-btn mt-2 inline-flex items-center gap-2 px-3 py-1.5 text-xs"
                    onClick={() => {
                      setGenNotice(null);
                      setVideoJob((current) => (current ? { ...current, status: "in_progress" } : current));
                    }}
                  >
                    <RefreshCw size={13} />
                    Проверить ещё раз
                  </button>
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
            subtitle="Загрузите фото клиники — Negis соберёт готовый рекламный креатив с безопасным текстом. Скачайте или отправьте в AI запуск рекламы."
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
              <select style={inputStyle} value={photoSourceType} onChange={(event) => setPhotoSourceType(event.target.value)}>
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
                onClick={() => setPhotoFormat(format.id)}
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
                onClick={() => setPhotoLayout(layout.id)}
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
              <Field label="Название" value={form.title} onChange={(value) => setForm((current) => ({ ...current, title: value }))} />
              <Field label="Ниша" value={form.niche} onChange={(value) => setForm((current) => ({ ...current, niche: value }))} />
              <Field label="Цель" value={form.goal} onChange={(value) => setForm((current) => ({ ...current, goal: value }))} />
              <Field label="Аудитория" value={form.audience} onChange={(value) => setForm((current) => ({ ...current, audience: value }))} />
              <Field label="Стиль" value={form.style} onChange={(value) => setForm((current) => ({ ...current, style: value }))} />
              <Field label="Длительность" value={form.duration} onChange={(value) => setForm((current) => ({ ...current, duration: value }))} />
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
                        onClick={() => setActiveId(video.id)}
                        className={`w-full rounded-xl border p-3 text-left text-sm transition ${
                          video.id === current.id ? "border-[#1A56DB] bg-[#EFF6FF]" : "border-[#E7ECF3] bg-white"
                        }`}
                      >
                        <span className="font-bold text-[#0B1220]">{video.title}</span>
                        <span className="mt-1 block text-xs text-[#64748B]">{statusLabels[video.status]}</span>
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
            subtitle="Что делает Negis и что остаётся сделать во внешних инструментах."
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
                    {item.inProduct ? "в Negis" : "вручную"}
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

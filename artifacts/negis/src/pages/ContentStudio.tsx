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
import { apiUrl } from "@/lib/api";
import { supabase, hasSupabaseFrontendEnv } from "@/lib/supabase";
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

const DEMO_AI_NOTICE = "Демо-режим: подключите AI provider для настоящей генерации.";

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

const workflow = [
  "Идея",
  "Сценарий",
  "Avatar prompt",
  "TapNow prompt",
  "ElevenLabs MP3",
  "HeyGen video",
  "CapCut subtitles",
  "Публикация",
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

function readVideos(): ContentVideo[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ContentVideo[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeVideos(videos: ContentVideo[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(videos));
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

  const updatePhotoTexts = (key: keyof PhotoCreativeTexts, value: string) =>
    setPhotoTexts((current) => ({ ...current, [key]: value }));

  const photoCompliance = useMemo(
    () => checkMetaCompliance({ headline: photoTexts.headline, text: photoTexts.offer, description: photoTexts.cta }),
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
      const response = await fetch(apiUrl("/api/content-studio/generate-package"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: readWorkspaceId(),
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
          const signedResponse = await fetch(apiUrl("/api/crm/ad-creatives/signed-upload"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              workspaceId: readWorkspaceId(),
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
        await fetch(apiUrl("/api/crm/content-videos"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: readWorkspaceId(),
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
        "negis_ads_automation_prefill",
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
      const response = await fetch(apiUrl("/api/content-studio/generate-package"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...packageBrief, workspaceId: readWorkspaceId() }),
      });
      const body = await safeJson<ContentPackage>(response);
      if (!response.ok || body?.success !== true) {
        throw new Error(body?.success === false ? body.error : "Не удалось сгенерировать пакет контента");
      }
      setContentPackage(body.data);
      setPackageGenerationMode(body.mode);
      toast.success(body.mode === "demo" ? "Demo-пакет контента готов" : "Пакет контента готов");

      // Persist the package: content_videos stores the whole body in raw_payload.
      try {
        const saveResponse = await fetch(apiUrl("/api/crm/content-videos"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: readWorkspaceId(),
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
      "negis_ads_automation_prefill",
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
    const saved = readVideos();
    if (saved.length > 0) {
      setVideos(saved);
      setActiveId(saved[0].id);
    }

    const loadApiVideos = async () => {
      try {
        const workspaceId = readWorkspaceId();
        const response = await fetch(apiUrl(`/api/crm/content-videos?workspaceId=${encodeURIComponent(workspaceId)}`));
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
      await fetch(apiUrl("/api/crm/content-videos"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: videoId,
          workspaceId: readWorkspaceId(),
          ...patch,
        }),
      });
    } catch {
      // LocalStorage remains the source of truth in demo/offline mode.
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
      const response = await fetch(apiUrl("/api/crm/content-videos"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          workspaceId: readWorkspaceId(),
        }),
      });
      const body = await safeJson<{ video: ContentVideo }>(response);
      const apiVideo = body?.success === true ? body.data.video : null;
      const video: ContentVideo = apiVideo || {
        ...form,
        id: newVideoId(),
        status: "idea",
        createdAt: new Date().toISOString(),
      };

      saveVideos([video, ...videos.filter((item) => item.id !== video.id)], video.id);
      toast.success("Идея ролика создана");
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
      const payload = { ...form, ...activeVideo, videoId: activeVideo?.id, workspaceId: readWorkspaceId() };
      const response = await fetch(apiUrl("/api/content-studio/generate-script"), {
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
      const response = await fetch(apiUrl(path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, ...activeVideo, videoId: activeVideo?.id, workspaceId: readWorkspaceId() }),
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
      const response = await fetch(apiUrl("/api/content-studio/send-telegram"), {
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
      const response = await fetch(apiUrl("/api/content-studio/send-telegram"), {
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
      "negis_ads_automation_prefill",
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

              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                <p className="text-sm font-black text-emerald-900">Проверка безопасных формулировок</p>
                <ul className="mt-2 space-y-1 text-sm font-semibold text-emerald-800">
                  {complianceRules.map((rule) => (
                    <li key={rule}>✓ {rule}</li>
                  ))}
                </ul>
                {contentPackage.complianceNotes.length ? (
                  <ul className="mt-3 space-y-1 text-sm font-semibold text-emerald-800">
                    {contentPackage.complianceNotes.map((note) => (
                      <li key={note}>• {note}</li>
                    ))}
                  </ul>
                ) : null}
                {packageCompliance && packageCompliance.status !== "safe" ? (
                  <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-900">
                    Статус проверки: {packageCompliance.status === "blocked" ? "заблокировано — перепишите текст" : "нужна ручная проверка"}
                    <ul className="mt-1 space-y-1">
                      {(packageCompliance.issues || []).map((issue, index) => (
                        <li key={`${issue.code || "issue"}-${index}`}>• {issue.message}</li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="mt-3 text-sm font-semibold text-emerald-800">Статус проверки: безопасно для медицинской рекламы.</p>
                )}
              </div>
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
              Рискованные формулировки для медицинской рекламы —{" "}
              {photoCompliance.status === "blocked" ? "перепишите текст перед использованием." : "проверьте текст вручную."}
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
              <div className="mt-3 flex flex-wrap gap-2">
                {(current.hashtags?.length ? current.hashtags : ["#ai", "#clinic", "#crm"]).map((tag) => (
                  <span key={tag} className="rounded-full bg-[#E0F2FE] px-3 py-1 text-xs font-bold text-[#0369A1]">
                    {tag}
                  </span>
                ))}
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
          {notice ? (
            <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
              {notice}
            </div>
          ) : null}
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
          <SectionTitle icon={Clapperboard} title="Workflow" subtitle="Полная цепочка production-процесса SAAF внутри Negis." />
          <div className="grid gap-3 md:grid-cols-4">
            {workflow.map((step, index) => (
              <div key={step} className="neu-sm p-4">
                <p className="text-xs font-black text-[#1A56DB]">{String(index + 1).padStart(2, "0")}</p>
                <p className="mt-2 text-sm font-bold text-[#0B1220]">{step}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </PageLayout>
  );
}

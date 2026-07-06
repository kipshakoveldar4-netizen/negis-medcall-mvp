import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useLocation } from "wouter";
import {
  ArrowRight,
  Check,
  Clapperboard,
  Copy,
  FileText,
  Megaphone,
  Rocket,
  Send,
  Sparkles,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { PageLayout } from "@/components/layout/PageLayout";
import { apiUrl } from "@/lib/api";
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

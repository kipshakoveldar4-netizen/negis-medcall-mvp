export type ContentStudioStatus = "idea" | "script_ready" | "avatar_ready" | "telegram_ready";

export type ContentStudioVideo = {
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
  status: ContentStudioStatus;
  createdAt: string;
};

export type ScriptPackage = {
  hook: string;
  script: string;
  voiceover: string;
  cta: string;
  caption: string;
  hashtags: string[];
};

export type PromptPackage = {
  prompt: string;
  negativePrompt?: string;
  format?: "photo" | "video";
};

export type ContentStudioMode = "demo" | "openai" | "telegram" | "mock";

// Phase 1 content package: everything a clinic needs for one creative —
// short-form video script, ad text, prompts, and the WhatsApp opener.
export type ContentPackage = {
  ideaTitle: string;
  hook: string;
  script: string;
  shotList: string[];
  textOnScreen: string[];
  voiceover: string;
  caption: string;
  adPrimaryText: string;
  adHeadline: string;
  cta: string;
  photoPrompt: string;
  videoPrompt: string;
  whatsappMessage: string;
  complianceNotes: string[];
};

export type ContentPackageBrief = {
  mode?: unknown;
  format?: unknown;
  service?: unknown;
  city?: unknown;
  offer?: unknown;
  audience?: unknown;
  goal?: unknown;
  tone?: unknown;
  materialNotes?: unknown;
};

function briefString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

// Deterministic, compliance-safe demo package. Never promises results,
// never uses "100%", never diagnoses by appearance.
export function demoContentPackage(input: ContentPackageBrief = {}): ContentPackage {
  const service = briefString(input.service, "услуга клиники");
  const city = briefString(input.city, "вашем городе");
  const offer = briefString(input.offer, "бесплатная первичная консультация");
  const audience = briefString(input.audience, "взрослые, которые заботятся о здоровье");
  const tone = briefString(input.tone, "доверительно");
  const format = briefString(input.format, "reels");
  const goal = briefString(input.goal, "leads");
  const materialNotes = briefString(input.materialNotes, "");

  const goalCta = goal === "appointment" ? "Записаться на приём" : goal === "awareness" ? "Узнать подробнее" : "Получить консультацию";

  return {
    ideaTitle: `${service} в ${city}: как проходит приём`,
    hook: `Думаете про ${service.toLowerCase()}? Вот что важно знать перед первым визитом.`,
    script: [
      `1. Хук (0-3 сек): «${service}: что происходит на первом приёме?»`,
      "2. Проблема (3-10 сек): многие откладывают визит, потому что не знают, чего ожидать.",
      `3. Решение (10-25 сек): врач рассказывает, как проходит консультация по услуге «${service}», какие вопросы задать и как подготовиться.`,
      `4. Предложение (25-35 сек): ${offer}.`,
      `5. CTA (35-45 сек): «${goalCta} — напишите нам в WhatsApp».`,
    ].join("\n"),
    shotList: [
      "Кадр 1: врач в кабинете, взгляд в камеру, дневной свет.",
      "Кадр 2: ресепшн клиники, администратор встречает пациента.",
      `Кадр 3: крупный план процесса консультации по услуге «${service}» (без медицинских манипуляций в кадре).`,
      "Кадр 4: пациент и врач обсуждают план — спокойная атмосфера.",
      "Кадр 5: финальный кадр с логотипом клиники и CTA.",
    ],
    textOnScreen: [
      `${service} — как проходит приём`,
      "Расскажем и покажем без сложных терминов",
      offer,
      `${goalCta} → WhatsApp`,
    ],
    voiceover: `Если вы давно думаете про ${service.toLowerCase()}, начните с консультации. Врач осмотрит, ответит на вопросы и предложит план, который подходит именно вам. ${offer}. Напишите нам в WhatsApp — администратор подберёт удобное время.`,
    caption: `${service} в ${city} 🏥\n\nРассказываем, как проходит первый приём: без спешки, с понятными объяснениями и планом действий.\n\n${offer}.\n\nНапишите в WhatsApp — ответим на вопросы и подберём время. Тон: ${tone}.`,
    adPrimaryText: `${service} в ${city}. Первый шаг — консультация: врач ответит на вопросы и предложит индивидуальный план. ${offer}. Запись в WhatsApp.`,
    adHeadline: `${service} в ${city}`,
    cta: goalCta,
    photoPrompt: `Реалистичное фото для медицинской рекламы: современный кабинет клиники, врач-специалист по направлению «${service}», доброжелательная атмосфера, мягкий дневной свет, чистые тона, без текста на изображении, формат ${format}. Без изображений процедур и шприцев крупным планом.${materialNotes ? ` Материалы клиники: ${materialNotes}.` : ""}`,
    videoPrompt: `Короткое вертикальное видео (${format}, 9:16, 30-45 секунд) для клиники: врач рассказывает про «${service}», кадры кабинета и ресепшн, спокойный ${tone} тон, субтитры на русском, финальный кадр с CTA «${goalCta}». Аудитория: ${audience}. Без обещаний результата и без кадров «до/после».`,
    whatsappMessage: `Здравствуйте! Пишу по рекламе про «${service}». Хочу узнать подробнее и записаться на консультацию.`,
    complianceNotes: [
      "Формулировки без гарантий результата и без «100% результат».",
      "Нет диагностики по внешности и обещаний «до/после».",
      "Медицинская услуга подаётся через консультацию и индивидуальный план.",
    ],
  };
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length > 0 ? items : fallback;
}

export function normalizeContentPackage(value: unknown, fallback: ContentPackage): ContentPackage {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const read = (key: keyof ContentPackage) =>
    typeof record[key] === "string" && (record[key] as string).trim() ? (record[key] as string).trim() : (fallback[key] as string);
  return {
    ideaTitle: read("ideaTitle"),
    hook: read("hook"),
    script: read("script"),
    shotList: normalizeStringArray(record.shotList, fallback.shotList),
    textOnScreen: normalizeStringArray(record.textOnScreen, fallback.textOnScreen),
    voiceover: read("voiceover"),
    caption: read("caption"),
    adPrimaryText: read("adPrimaryText"),
    adHeadline: read("adHeadline"),
    cta: read("cta"),
    photoPrompt: read("photoPrompt"),
    videoPrompt: read("videoPrompt"),
    whatsappMessage: read("whatsappMessage"),
    complianceNotes: normalizeStringArray(record.complianceNotes, fallback.complianceNotes),
  };
}

type CreateVideoInput = {
  title?: unknown;
  niche?: unknown;
  goal?: unknown;
  duration?: unknown;
  style?: unknown;
  audience?: unknown;
};

type OpenAIResponsesBody = {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      text?: string;
    }>;
  }>;
};

type ContentStudioFetchResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

type ContentStudioFetch = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<ContentStudioFetchResponse>;

type OpenAIResponseBody = OpenAIResponsesBody & {
  error?: {
    message?: string;
  };
  raw?: string;
};

const demoVideos: ContentStudioVideo[] = [
  {
    id: "demo-content-video",
    title: "Почему клиника теряет заявки после рекламы",
    niche: "медицинский маркетинг",
    goal: "показать ценность CRM и быстрой обработки лидов",
    duration: "30-45 seconds",
    style: "экспертный разбор",
    audience: "собственники клиник и маркетологи",
    hook: "У вас есть заявки, но нет стабильных продаж?",
    script:
      "Многие клиники думают, что проблема в рекламе. Но часто проблема в связке: оффер, скорость ответа, CRM и повторная коммуникация.",
    voiceover:
      "У вас есть заявки, но нет стабильных продаж? Значит, нужно смотреть не только рекламу, но и всю воронку.",
    cta: "Напишите “РАЗБОР”, и мы покажем, где теряются клиенты.",
    caption: "Реклама - это только первый шаг. Важно видеть всю систему: лиды, звонки, записи и продажи.",
    hashtags: ["#маркетинг", "#таргет", "#клиника", "#crm", "#ai"],
    avatarPrompt:
      "Realistic vertical 9:16 AI avatar, confident medical marketing strategist, modern clinic CRM dashboard in background, premium daylight, clean studio look.",
    tapnowPrompt:
      "Vertical 9:16 realistic scene: clinic owner sees ad leads, CRM dashboard, WhatsApp messages, call tracking, appointments pipeline, premium healthcare marketing style.",
    status: "telegram_ready",
    createdAt: new Date().toISOString(),
  },
];

let memoryVideos = [...demoVideos];

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeHashtags(value: unknown): string[] {
  if (Array.isArray(value)) {
    const tags = value.map(String).map((tag) => tag.trim()).filter(Boolean);
    if (tags.length > 0) return tags;
  }

  if (typeof value === "string") {
    const tags = value.split(/\s+/).map((tag) => tag.trim()).filter(Boolean);
    if (tags.length > 0) return tags;
  }

  return ["#маркетинг", "#таргет", "#клиника", "#crm", "#ai"];
}

function extractOutputText(body: OpenAIResponsesBody): string {
  if (typeof body.output_text === "string") return body.output_text;

  const text = body.output
    ?.flatMap((item) => item.content ?? [])
    .map((content) => content.text)
    .filter((value): value is string => Boolean(value))
    .join("\n");

  return text ?? "";
}

async function readJsonBody(response: ContentStudioFetchResponse): Promise<OpenAIResponseBody> {
  const rawText = await response.text();
  const trimmed = rawText.trim();

  if (!trimmed) return {};

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as OpenAIResponseBody) : { raw: trimmed };
  } catch {
    return { raw: trimmed };
  }
}

export function listContentVideos(): ContentStudioVideo[] {
  return [...memoryVideos].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createContentVideo(input: CreateVideoInput): ContentStudioVideo {
  const video: ContentStudioVideo = {
    id: `content-${Date.now()}`,
    title: readString(input.title, "Ролик для клиники"),
    niche: readString(input.niche, "клиника / медицинский маркетинг"),
    goal: readString(input.goal, "получить заявки"),
    duration: readString(input.duration, "30-45 seconds"),
    style: readString(input.style, "экспертный разбор"),
    audience: readString(input.audience, "собственники клиник и маркетологи"),
    status: "idea",
    createdAt: new Date().toISOString(),
    hashtags: [],
  };

  memoryVideos = [video, ...memoryVideos];
  return video;
}

export function updateContentVideo(id: string, patch: Partial<ContentStudioVideo>): ContentStudioVideo | null {
  let updated: ContentStudioVideo | null = null;
  memoryVideos = memoryVideos.map((video) => {
    if (video.id !== id) return video;
    updated = { ...video, ...patch };
    return updated;
  });

  return updated;
}

export function demoScriptPackage(): ScriptPackage {
  return {
    hook: "У вас есть заявки, но нет стабильных продаж?",
    script:
      "Многие клиники думают, что проблема в рекламе. Но часто проблема в связке: оффер, скорость ответа, CRM и повторная коммуникация. Если администратор отвечает через час, а заявки не попадают в единую систему, бюджет уходит без понятной картины.",
    voiceover:
      "У вас есть заявки, но нет стабильных продаж? Значит, нужно смотреть не только рекламу, но и всю воронку: оффер, скорость ответа, CRM, звонки, записи и повторные касания.",
    cta: "Напишите “РАЗБОР”, и мы покажем, где теряются клиенты.",
    caption: "Реклама - это только первый шаг. Важно видеть всю систему: лиды, звонки, записи и продажи.",
    hashtags: ["#маркетинг", "#таргет", "#клиника", "#crm", "#ai"],
  };
}

export function demoAvatarPrompt(input?: { title?: unknown; style?: unknown }): PromptPackage {
  return {
    format: "video",
    prompt: [
      "Realistic vertical 9:16 AI avatar video.",
      "Confident healthcare marketing strategist speaking to camera.",
      `Topic: ${readString(input?.title, "clinic marketing funnel audit")}.`,
      `Style: ${readString(input?.style, "premium expert, calm and direct")}.`,
      "Modern clinic office, soft daylight, CRM dashboard and lead notifications in background.",
      "Natural skin texture, clean framing, professional wardrobe, trustworthy tone.",
    ].join(" "),
    negativePrompt: "low quality, distorted face, extra fingers, unreadable text, cartoon, heavy blur, dark lighting",
  };
}

export function demoTapNowPrompt(input?: { title?: unknown; niche?: unknown; goal?: unknown }): PromptPackage {
  return {
    prompt: [
      "Vertical 9:16 premium realistic marketing video scene.",
      `Topic: ${readString(input?.title, "clinic lead funnel")}.`,
      `Niche: ${readString(input?.niche, "medical clinic marketing")}.`,
      `Goal: ${readString(input?.goal, "turn ad leads into booked appointments")}.`,
      "Show CRM dashboard, WhatsApp leads, call tracking, appointment pipeline, clean clinic brand visuals.",
      "Young AI strategist explains the funnel, modern office, smooth camera movement, production-ready lighting.",
    ].join(" "),
    negativePrompt: "low quality, text artifacts, medical claims, distorted UI, chaotic background, off-brand colors",
  };
}

export function normalizeScriptPackage(value: unknown): ScriptPackage {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};

  return {
    hook: readString(record.hook, demoScriptPackage().hook),
    script: readString(record.script, demoScriptPackage().script),
    voiceover: readString(record.voiceover, demoScriptPackage().voiceover),
    cta: readString(record.cta, demoScriptPackage().cta),
    caption: readString(record.caption, demoScriptPackage().caption),
    hashtags: normalizeHashtags(record.hashtags),
  };
}

export function normalizePromptPackage(value: unknown, fallback: PromptPackage): PromptPackage {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};

  return {
    format: record.format === "photo" || record.format === "video" ? record.format : fallback.format,
    prompt: readString(record.prompt, fallback.prompt),
    negativePrompt: readString(record.negativePrompt, fallback.negativePrompt ?? ""),
  };
}

export async function generateOpenAIJson<TData>(input: {
  system: string;
  user: unknown;
  fallback: TData;
  normalize: (value: unknown) => TData;
}): Promise<{ mode: ContentStudioMode; data: TData }> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    return { mode: "demo", data: input.fallback };
  }

  const safeFetch = fetch as unknown as ContentStudioFetch;
  const response = await safeFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: input.system,
        },
        {
          role: "user",
          content: JSON.stringify(input.user),
        },
      ],
      text: {
        format: {
          type: "json_object",
        },
      },
    }),
  });

  const body = await readJsonBody(response);

  if (!response.ok) {
    const rawDetails = body.raw ? `: ${body.raw.slice(0, 240)}` : "";
    throw new Error(body.error?.message || `OpenAI request failed: HTTP ${response.status}${rawDetails}`);
  }

  const outputText = extractOutputText(body);
  if (!outputText) {
    throw new Error("OpenAI response is empty");
  }

  return {
    mode: "openai",
    data: input.normalize(JSON.parse(outputText)),
  };
}

export function telegramPackageText(input: {
  title?: string;
  hook?: string;
  script?: string;
  voiceover?: string;
  cta?: string;
  caption?: string;
  hashtags?: string[];
  avatarPrompt?: string;
  tapnowPrompt?: string;
}): string {
  const parts = [
    `ИИ студия контента: ${input.title || "ролик"}`,
    input.hook ? `Hook:\n${input.hook}` : null,
    input.script ? `Script:\n${input.script}` : null,
    input.voiceover ? `Voiceover:\n${input.voiceover}` : null,
    input.cta ? `CTA:\n${input.cta}` : null,
    input.caption ? `Caption:\n${input.caption}` : null,
    input.hashtags?.length ? `Hashtags:\n${input.hashtags.join(" ")}` : null,
    input.avatarPrompt ? `Avatar prompt:\n${input.avatarPrompt}` : null,
    input.tapnowPrompt ? `TapNow prompt:\n${input.tapnowPrompt}` : null,
  ];

  return parts.filter(Boolean).join("\n\n---\n\n");
}

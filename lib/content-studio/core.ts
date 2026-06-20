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

  const response = await fetch("https://api.openai.com/v1/responses", {
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

  const body = (await response.json()) as OpenAIResponsesBody & { error?: { message?: string } };

  if (!response.ok) {
    throw new Error(body.error?.message || `OpenAI request failed: HTTP ${response.status}`);
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

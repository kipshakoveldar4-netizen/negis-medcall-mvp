import type { VercelRequest, VercelResponse } from "@vercel/node";
import { randomUUID } from "node:crypto";
import {
  demoAvatarPrompt,
  demoContentPackage,
  demoScriptPackage,
  demoTapNowPrompt,
  generateOpenAIJson,
  normalizeContentPackage,
  normalizePromptPackage,
  normalizeScriptPackage,
  telegramPackageText,
  updateContentVideo,
} from "../../lib/content-studio/core";
import { improveAdText } from "../../lib/meta/improve";
import {
  createVideoJob,
  downloadVideoContent,
  fetchVideoJob,
  generateImage,
  GenerationProviderError,
  imageGenerationRefusal,
  imageSizeForFormat,
  normalizePrompt,
  readGenerationConfig,
  videoFormatWasSubstituted,
  videoGenerationRefusal,
  videoSizeForFormat,
  type GenerationFetch,
  type GenerationRefusal,
} from "../../lib/content-studio/generation";
import { generatedVideoRequestDigest, readGeneratedVideoJobHandle, signGeneratedVideoJobHandle } from "../../lib/content-studio/generated-video-handle";
import {
  admitGeneratedVideoWorkflow,
  beginGeneratedVideoDispatch,
  cancelGeneratedVideoWorkflow,
  generatedVideoWorkflowConfig,
  linkGeneratedVideoProvider,
  readGeneratedVideoWorkflow,
  receiveGeneratedVideoInput,
  requireGeneratedVideoWorkflowReady,
  resumeGeneratedVideoWorkflow,
} from "../../lib/crm/generated-video-workflow";
import { persistContentVideoPatchIfAvailable, storeGeneratedCreative } from "../../lib/crm/server";
import { generatedCreativeIdentity, isLegacyGeneratedVideoIdentity } from "../../lib/crm/generated-identity";
import { resolveTextProvider } from "../../lib/ai/text-provider";
import {
  billableVideoSeconds,
  completeContentGeneration,
  getContentUsageSummary,
  reserveContentGeneration,
  type ContentGenerationErrorCode,
  type ContentGenerationOperation,
  type ContentUsageReservation,
} from "../../lib/content-studio/usage";
import {
  authorizePrivateRoute,
  normalizeRouteSegment,
  sendNotFound,
  type PrivateRouteAuthorization,
} from "../../lib/auth/route-guard";
import { requireWorkspaceAccess, WorkspaceAdminAuthError, type WorkspaceAccessContext } from "../../lib/auth/server";

// Security-2D — Content Studio is a private workspace surface.
//
// Every generator here calls OpenAI on the platform's key and then writes the
// result back to the caller's content_videos row. Until this phase none of that
// required a token, and the row was chosen by a workspaceId in the request body,
// so an anonymous caller could spend the platform's OpenAI budget and patch
// another clinic's generated content. send-telegram was worse: it accepted a
// chatId and relayed arbitrary text through the platform's bot.
//
// The registry below is the only description of what this function serves.
// Unknown segment is 404, wrong method is 405, and the workspace is always the
// verified one — payload.workspaceId is ignored.

const CONTENT_STUDIO_AUTHORIZATION: Readonly<Record<string, PrivateRouteAuthorization>> = {
  // The in-memory video list predates the CRM content-videos resource, has no
  // caller left, and its module-level store is shared by every tenant that
  // happens to hit the same warm lambda. Registered so it answers 410 rather
  // than quietly serving another workspace's drafts.
  videos: {
    kind: "disabled",
    methods: ["GET", "POST"],
    permissions: { GET: "view_ai_content", POST: "manage_ai_content" },
    disabledReason: "Use /api/crm/content-videos",
  },
  usage: {
    kind: "browser",
    methods: ["GET"],
    permissions: { GET: "view_ai_content" },
  },
  "generate-package": {
    kind: "browser",
    methods: ["POST"],
    permissions: { POST: "manage_ai_content" },
  },
  // Переписывание текста объявления. Право то же, что у генерации: тратится
  // тот же ключ платформы, и текст принадлежит тому же рабочему пространству.
  "improve-ad-text": {
    kind: "browser",
    methods: ["POST"],
    permissions: { POST: "manage_ai_content" },
  },
  "generate-script": {
    kind: "browser",
    methods: ["POST"],
    permissions: { POST: "manage_ai_content" },
  },
  "generate-avatar-prompt": {
    kind: "browser",
    methods: ["POST"],
    permissions: { POST: "manage_ai_content" },
  },
  "generate-tapnow-prompt": {
    kind: "browser",
    methods: ["POST"],
    permissions: { POST: "manage_ai_content" },
  },
  "send-telegram": {
    kind: "browser",
    methods: ["POST"],
    permissions: { POST: "manage_ai_content" },
  },
  // Настоящая генерация файла, а не текста. Право то же самое: тот, кому
  // доверено писать рекламный текст клиники, распоряжается и картинкой.
  "generate-photo": {
    kind: "browser",
    methods: ["POST"],
    permissions: { POST: "manage_ai_content" },
  },
  "generate-video": {
    kind: "browser",
    methods: ["POST"],
    permissions: { POST: "manage_ai_content" },
  },
  // Опрос состояния — чтение, но оно доводит готовый ролик до библиотеки
  // креативов, то есть пишет. Право записи, не просмотра.
  "video-generation": {
    kind: "browser",
    methods: ["GET"],
    permissions: { GET: "manage_ai_content" },
  },
};

type TelegramFetchResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

type TelegramFetch = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<TelegramFetchResponse>;

type TelegramApiBody = {
  ok?: boolean;
  error_code?: number;
  description?: string;
  raw?: string;
  result?: unknown;
};

function sendJson(res: VercelResponse, status: number, payload: unknown) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json(payload);
}

function generationRequestKey(req: VercelRequest): string | null {
  const headerValue = req.headers["x-idempotency-key"];
  const candidate = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return typeof candidate === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.trim())
    ? candidate.trim()
    : null;
}

function sendGenerationRequestKeyRefusal(res: VercelResponse) {
  return sendJson(res, 400, {
    success: false,
    error: "Платная генерация не запущена",
    details: ["Браузер не передал безопасный ключ повтора. Обновите страницу и повторите попытку."],
    code: "generation_idempotency_required",
  });
}

function sendUsageRefusal(res: VercelResponse, reservation: ContentUsageReservation) {
  if (reservation.reason === "subscription_required") {
    return sendJson(res, 403, {
      success: false,
      error: "Генерация файлов не входит в текущий доступ",
      details: ["Назначьте рабочему пространству активный тариф с генерацией креативов."],
      code: "generation_subscription_required",
    });
  }
  if (reservation.reason === "duplicate_request") {
    return sendJson(res, 409, {
      success: false,
      error: "Этот запрос генерации уже был принят",
      details: ["Не запускайте тот же платный запрос повторно. Обновите состояние страницы."],
      code: "generation_request_duplicate",
    });
  }
  const unit = reservation.kind === "video_seconds" ? "секунд видео" : "изображений";
  return sendJson(res, 429, {
    success: false,
    error: "Лимит генерации на этот месяц исчерпан",
    details: [
      reservation.limit === null
        ? `Доступный лимит ${unit} исчерпан.`
        : `Использовано ${reservation.used} из ${reservation.limit} ${unit}.`,
    ],
    code: "generation_quota_exceeded",
    usage: {
      kind: reservation.kind,
      used: reservation.used,
      limit: reservation.limit,
      remaining: reservation.remaining,
      periodStart: reservation.periodStart,
    },
  });
}

async function reserveTextRequest(
  context: WorkspaceAccessContext,
  operation: ContentGenerationOperation,
): Promise<ContentUsageReservation | null> {
  const provider = resolveTextProvider(process.env);
  if (!provider) return null;
  return reserveContentGeneration({
    workspaceId: context.workspaceId,
    staffUserId: context.staffUserId,
    requestKey: randomUUID(),
    operation,
    kind: "text_request",
    units: 1,
    provider,
  });
}

async function completeTextRequest(
  context: WorkspaceAccessContext,
  reservation: ContentUsageReservation | null,
  status: "succeeded" | "failed" | "unknown",
  provider?: string,
) {
  await completeContentGeneration({
    workspaceId: context.workspaceId,
    reservation,
    status,
    ...(status === "succeeded" ? {} : { errorCode: "request_unknown" as ContentGenerationErrorCode }),
    provider,
  });
}

function providerFailureAccounting(error: unknown): {
  status: "failed" | "unknown";
  errorCode: ContentGenerationErrorCode;
} {
  if (error instanceof GenerationProviderError && error.status >= 400 && error.status < 500 && error.status !== 429) {
    return { status: "failed", errorCode: "provider_rejected" };
  }
  if (error instanceof GenerationProviderError && error.status === 429) {
    return { status: "failed", errorCode: "provider_unavailable" };
  }
  return { status: "unknown", errorCode: "request_unknown" };
}

function readBody(req: VercelRequest): Record<string, unknown> {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
}

function readPathSegment(req: VercelRequest): string {
  const pathParam = req.query.path;
  const querySegment = Array.isArray(pathParam) ? pathParam[0] : pathParam;

  if (typeof querySegment === "string" && querySegment.trim()) {
    return querySegment.trim();
  }

  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  const [, segment] = pathname.split("/api/content-studio/");
  return (segment || "").split("/").filter(Boolean)[0] || "";
}

function splitLongText(text: string, maxLength: number): string[] {
  if (!Number.isInteger(maxLength) || maxLength < 2) throw new RangeError("Invalid Telegram chunk size");
  const chunks: string[] = [];
  for (let index = 0; index < text.length;) {
    let end = Math.min(index + maxLength, text.length);
    const before = text.charCodeAt(end - 1), after = text.charCodeAt(end);
    if (end < text.length && before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--;
    chunks.push(text.slice(index, end));
    index = end;
  }
  return chunks;
}

function splitTelegramMessage(text: string, maxLength = 3500): string[] {
  const source = text.trim() || "Пакет Content Studio пуст.";
  const blocks = source.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const block of blocks) {
    const normalizedBlock = block.trim();
    if (!normalizedBlock) continue;

    if (normalizedBlock.length > maxLength) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitLongText(normalizedBlock, maxLength));
      continue;
    }

    const next = current ? `${current}\n\n${normalizedBlock}` : normalizedBlock;
    if (next.length > maxLength) {
      if (current) chunks.push(current);
      current = normalizedBlock;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [source.slice(0, maxLength)];
}

function telegramHint(description: string, status: number): string {
  const lower = description.toLowerCase();

  if (status === 401 || lower.includes("unauthorized")) {
    return "Проверьте TELEGRAM_BOT_TOKEN.";
  }

  if (lower.includes("chat not found")) {
    return "Проверьте TELEGRAM_CHAT_ID и напишите /start боту.";
  }

  if (lower.includes("bot was blocked")) {
    return "Разблокируйте бота и напишите /start.";
  }

  if (lower.includes("message is too long")) {
    return "Сообщение слишком длинное. Система попробует отправить пакет частями.";
  }

  return "Проверьте TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID и что пользователь написал /start боту.";
}

async function readTelegramBody(response: TelegramFetchResponse): Promise<TelegramApiBody> {
  const rawText = await response.text();
  const trimmed = rawText.trim();

  if (!trimmed) return {};

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as TelegramApiBody) : { raw: trimmed };
  } catch {
    return { raw: trimmed };
  }
}

async function sendTelegramMessage(input: {
  safeFetch: TelegramFetch;
  token: string;
  chatId: string;
  text: string;
}) {
  const response = await input.safeFetch(`https://api.telegram.org/bot${input.token}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: input.chatId,
      text: input.text,
    }),
  });

  const body = await readTelegramBody(response);
  const message = body.result && typeof body.result === "object" && !Array.isArray(body.result)
    ? body.result as Record<string, unknown> : null;
  const chat = message?.chat && typeof message.chat === "object" && !Array.isArray(message.chat)
    ? message.chat as Record<string, unknown> : null;
  const acknowledged = body.ok === true && message !== null && chat !== null
    && Number.isSafeInteger(message.message_id) && Number(message.message_id) > 0
    && Number.isSafeInteger(message.date) && Number(message.date) >= 0
    && Number.isSafeInteger(chat.id) && Number(chat.id) !== 0
    && typeof message.text === "string" && Boolean(message.text.trim());
  const description =
    typeof body.description === "string" && body.description.trim() ? body.description
      : body.raw ? "Telegram returned a non-JSON response body."
      : !acknowledged && response.ok ? "Telegram did not return a valid sent-message acknowledgement."
      : `Telegram API error: HTTP ${response.status}`;

  if (!response.ok || !acknowledged) {
    return {
      success: false as const,
      status: response.status,
      // Provider text can echo credentials, recipient IDs or request content.
      telegramDescription: "Telegram не подтвердил доставку сообщения.",
      telegramErrorCode: Number.isSafeInteger(body.error_code) ? body.error_code : undefined,
      hint: telegramHint(description, response.status),
    };
  }

  return {
    success: true as const,
    status: response.status,
  };
}

async function handleUsage(_req: VercelRequest, res: VercelResponse, context: WorkspaceAccessContext) {
  const summary = await getContentUsageSummary(context.workspaceId);
  const config = readGenerationConfig();
  return sendJson(res, 200, {
    success: true,
    mode: summary.trackingAvailable ? "tracked" : "compatibility",
    data: {
      ...summary,
      videoSecondsPerGeneration: billableVideoSeconds(config.videoSeconds),
    },
  });
}

async function handleGeneratePackage(req: VercelRequest, res: VercelResponse, context: WorkspaceAccessContext) {
  let usage: ContentUsageReservation | null = null;
  try {
    usage = await reserveTextRequest(context, "content_package");
    if (usage && !usage.allowed) return sendUsageRefusal(res, usage);
    const payload = readBody(req);
    const fallback = demoContentPackage(payload);
    const result = await generateOpenAIJson({
      system:
        "You are a Russian medical/cosmetology marketing copywriter for clinics. Return valid JSON only. No markdown. " +
        "Strict compliance rules: never guarantee results, never write '100%', never diagnose by appearance, " +
        "never promise unrealistic before/after outcomes, never use fear-based medical claims. " +
        "Use safe wording: consultation, individual plan, doctor's assessment.",
      user: {
        task: "Generate a full clinic creative content package for short-form video and Meta ads.",
        requiredJsonFields: [
          "ideaTitle",
          "hook",
          "script",
          "shotList",
          "textOnScreen",
          "voiceover",
          "caption",
          "adPrimaryText",
          "adHeadline",
          "adVariants",
          "cta",
          "photoPrompt",
          "videoPrompt",
          "whatsappMessage",
          "complianceNotes",
        ],
        requirements: {
          language: "Russian",
          script: "numbered scenes with timing for a 30-45 second vertical video",
          shotList: "array of 4-6 shot descriptions",
          textOnScreen: "array of 3-5 short on-screen lines",
          adPrimaryText: "Meta ad primary text, 2-4 sentences, no result guarantees",
          adVariants:
            "array of exactly 3 distinct Meta ad variants: direct offer, expert explanation, and trust/comfort. Each item has id, label, angle, primaryText, headline, description, cta. Keep every variant medically safe and in Russian",
          complianceNotes: "array of short notes confirming safe medical wording",
        },
        input: payload,
      },
      fallback,
      normalize: (value) => normalizeContentPackage(value, fallback),
    });
    await completeTextRequest(context, usage, "succeeded", result.mode);

    return sendJson(res, 200, {
      success: true,
      mode: result.mode,
      data: result.data,
    });
  } catch (error) {
    await completeTextRequest(context, usage, "unknown");
    return sendJson(res, 500, {
      success: false,
      error: "Generation error",
      details: ["Не удалось завершить подготовку пакета контента. Повторите позже."],
    });
  }
}

/**
 * Переписать объявление так, чтобы оно прошло модерацию Meta.
 *
 * Отличие от остальных генераторов здесь одно и оно главное: ответ модели не
 * принимается на слово. improveAdText прогоняет его теми же правилами, что и
 * проверка текста, и возвращает вердикт по переписанному варианту. Экран
 * показывает именно этот вердикт, поэтому «улучшили» не может разойтись с
 * «стало можно запускать».
 */
async function handleImproveAdText(req: VercelRequest, res: VercelResponse, context: WorkspaceAccessContext) {
  let usage: ContentUsageReservation | null = null;
  try {
    usage = await reserveTextRequest(context, "ad_text_improvement");
    if (usage && !usage.allowed) return sendUsageRefusal(res, usage);
    const payload = readBody(req);
    const result = await improveAdText({
      fields: {
        headline: typeof payload.headline === "string" ? payload.headline : "",
        text: typeof payload.text === "string" ? payload.text : "",
        description: typeof payload.description === "string" ? payload.description : "",
      },
      // Генератор внедряется здесь, а не импортируется внутри improve.ts:
      // модуль обязан проверяться без сети и без ключа.
      generate: (input) => generateOpenAIJson({
        system: input.system,
        user: input.user,
        fallback: {},
        normalize: (value) => value,
      }),
    });
    await completeTextRequest(context, usage, "succeeded", result.mode);

    if (result.refusal) {
      return sendJson(res, 502, {
        success: false,
        error: "Не удалось переписать текст",
        details: ["Сервис генерации не подтвердил завершение обработки текста. Повторите позже."],
        data: { before: result.before },
      });
    }

    return sendJson(res, 200, {
      success: true,
      mode: result.mode,
      data: {
        mode: result.mode,
        fields: result.fields,
        status: result.status,
        issues: result.issues,
        // Улучшение обязано уметь проиграть исходному тексту. Без этого поля
        // экран показал бы кнопку «взять вариант», подставляющую то же самое.
        changed: result.changed,
        before: result.before,
        invented: result.candidates.flatMap((candidate) => candidate.invented),
        attempts: result.candidates.filter((candidate) => candidate.source !== "original").length,
        refusal: "",
      },
    });
  } catch (error) {
    await completeTextRequest(context, usage, "unknown");
    return sendJson(res, 500, {
      success: false,
      error: "Не удалось переписать текст",
      details: ["Не удалось завершить обработку текста. Повторите позже."],
    });
  }
}

async function handleGenerateScript(req: VercelRequest, res: VercelResponse, context: WorkspaceAccessContext) {
  let usage: ContentUsageReservation | null = null;
  try {
    usage = await reserveTextRequest(context, "video_script");
    if (usage && !usage.allowed) return sendUsageRefusal(res, usage);
    const payload = readBody(req);
    const result = await generateOpenAIJson({
      system: "You are a Russian AI video script strategist. Return valid JSON only. No markdown.",
      user: {
        task: "Generate a short-form AI video package for 30-45 seconds.",
        requiredJsonFields: ["hook", "script", "voiceover", "cta", "caption", "hashtags"],
        requirements: {
          language: "Russian",
          outputStyle: "ready for avatar video production",
          hashtags: "5-8 hashtags as array",
        },
        input: payload,
      },
      fallback: demoScriptPackage(),
      normalize: normalizeScriptPackage,
    });
    await completeTextRequest(context, usage, "succeeded", result.mode);

    if (typeof payload.videoId === "string") {
      const patch = {
        ...result.data,
        status: "script_ready" as const,
      };
      updateContentVideo(payload.videoId, patch);
      await persistContentVideoPatchIfAvailable({
        videoId: payload.videoId,
        workspaceId: context.workspaceId,
        patch,
      });
    }

    return sendJson(res, 200, {
      success: true,
      mode: result.mode,
      data: result.data,
    });
  } catch (error) {
    await completeTextRequest(context, usage, "unknown");
    return sendJson(res, 500, {
      success: false,
      error: "Generation error",
      details: ["Не удалось завершить подготовку сценария. Повторите позже."],
    });
  }
}

async function handleGenerateAvatarPrompt(req: VercelRequest, res: VercelResponse, context: WorkspaceAccessContext) {
  let usage: ContentUsageReservation | null = null;
  try {
    usage = await reserveTextRequest(context, "avatar_prompt");
    if (usage && !usage.allowed) return sendUsageRefusal(res, usage);
    const payload = readBody(req);
    const fallback = demoAvatarPrompt(payload);
    const result = await generateOpenAIJson({
      system:
        "Generate production-ready prompts for realistic AI avatar photo/video tools. Return valid JSON only.",
      user: {
        task: "Generate avatar prompt for healthcare and marketing short-form video.",
        requiredJsonFields: ["prompt", "negativePrompt", "format"],
        input: payload,
      },
      fallback,
      normalize: (value) => normalizePromptPackage(value, fallback),
    });
    await completeTextRequest(context, usage, "succeeded", result.mode);

    if (typeof payload.videoId === "string") {
      const patch = {
        avatarPrompt: [result.data.prompt, result.data.negativePrompt ? `Negative prompt: ${result.data.negativePrompt}` : null]
          .filter(Boolean)
          .join("\n\n"),
        status: "avatar_ready" as const,
      };
      updateContentVideo(payload.videoId, patch);
      await persistContentVideoPatchIfAvailable({
        videoId: payload.videoId,
        workspaceId: context.workspaceId,
        patch,
      });
    }

    return sendJson(res, 200, {
      success: true,
      mode: result.mode,
      data: result.data,
    });
  } catch (error) {
    await completeTextRequest(context, usage, "unknown");
    return sendJson(res, 500, {
      success: false,
      error: "Generation error",
      details: ["Не удалось завершить подготовку Avatar prompt. Повторите позже."],
    });
  }
}

async function handleGenerateTapNowPrompt(req: VercelRequest, res: VercelResponse, context: WorkspaceAccessContext) {
  let usage: ContentUsageReservation | null = null;
  try {
    usage = await reserveTextRequest(context, "tapnow_prompt");
    if (usage && !usage.allowed) return sendUsageRefusal(res, usage);
    const payload = readBody(req);
    const fallback = demoTapNowPrompt(payload);
    const result = await generateOpenAIJson({
      system: "Generate production-ready visual scene prompts for TapNow. Return valid JSON only.",
      user: {
        task: "Generate a TapNow visual video prompt.",
        requiredJsonFields: ["prompt", "negativePrompt"],
        mandatoryVisualDetails: [
          "vertical 9:16",
          "clinic CRM",
          "WhatsApp leads",
          "appointment pipeline",
          "premium realistic style",
        ],
        input: payload,
      },
      fallback,
      normalize: (value) => normalizePromptPackage(value, fallback),
    });
    await completeTextRequest(context, usage, "succeeded", result.mode);

    if (typeof payload.videoId === "string") {
      const patch = {
        tapnowPrompt: [result.data.prompt, result.data.negativePrompt ? `Negative prompt: ${result.data.negativePrompt}` : null]
          .filter(Boolean)
          .join("\n\n"),
        status: "avatar_ready" as const,
      };
      updateContentVideo(payload.videoId, patch);
      await persistContentVideoPatchIfAvailable({
        videoId: payload.videoId,
        workspaceId: context.workspaceId,
        patch,
      });
    }

    return sendJson(res, 200, {
      success: true,
      mode: result.mode,
      data: result.data,
    });
  } catch (error) {
    await completeTextRequest(context, usage, "unknown");
    return sendJson(res, 500, {
      success: false,
      error: "Generation error",
      details: ["Не удалось завершить подготовку TapNow prompt. Повторите позже."],
    });
  }
}

async function handleSendTelegram(req: VercelRequest, res: VercelResponse, context: WorkspaceAccessContext) {
  const payload = readBody(req);
  const isTest = payload.test === true;
  const packageText = telegramPackageText({
    title: typeof payload.title === "string" ? payload.title : undefined,
    hook: typeof payload.hook === "string" ? payload.hook : undefined,
    script: typeof payload.script === "string" ? payload.script : undefined,
    voiceover: typeof payload.voiceover === "string" ? payload.voiceover : undefined,
    cta: typeof payload.cta === "string" ? payload.cta : undefined,
    caption: typeof payload.caption === "string" ? payload.caption : undefined,
    hashtags: Array.isArray(payload.hashtags) ? payload.hashtags.map(String) : undefined,
    avatarPrompt: typeof payload.avatarPrompt === "string" ? payload.avatarPrompt : undefined,
    tapnowPrompt: typeof payload.tapnowPrompt === "string" ? payload.tapnowPrompt : undefined,
  });

  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  // The bot token belongs to the platform, so the destination does too: a
  // caller-supplied chatId turned this into an open relay.
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  const messageText = isTest ? "✅ Telegram подключён к Medina OS Content Studio" : packageText;

  if (!token || !chatId) {
    return sendJson(res, 200, {
      success: true,
      mode: "demo",
      warning: "Telegram не подключён, пакет готов для копирования.",
      data: {
        sent: false,
        packageText: messageText,
        test: isTest,
      },
    });
  }

  try {
    const safeFetch = fetch as unknown as TelegramFetch;
    const chunks = splitTelegramMessage(messageText);

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const text =
        chunks.length > 1 ? `SAAF Content Studio — пакет ролика, часть ${index + 1}/${chunks.length}\n\n${chunk}` : chunk;
      const result = await sendTelegramMessage({
        safeFetch,
        token,
        chatId,
        text,
      });

      if (!result.success) {
        return sendJson(res, 502, {
          success: false,
          error: "Telegram API request failed",
          details: [
            chunks.length > 1
              ? `Part ${index + 1}/${chunks.length}: ${result.telegramDescription}`
              : result.telegramDescription,
          ],
          telegramDescription: result.telegramDescription,
          telegramErrorCode: result.telegramErrorCode,
          status: result.status,
          part: chunks.length > 1 ? index + 1 : undefined,
          totalParts: chunks.length,
          hint: result.hint,
        });
      }
    }

    let statusPersisted: boolean | undefined;
    if (!isTest && typeof payload.videoId === "string") {
      const patch = { status: "telegram_ready" as const };
      statusPersisted = await persistContentVideoPatchIfAvailable({
        videoId: payload.videoId,
        workspaceId: context.workspaceId,
        patch,
        expectedUpdatedAt: payload.expectedUpdatedAt,
      });
      if (statusPersisted) updateContentVideo(payload.videoId, patch);
    }

    return sendJson(res, 200, {
      success: true,
      mode: "telegram",
      data: {
        sent: true,
        packageText: messageText,
        test: isTest,
        parts: chunks.length,
        ...(statusPersisted !== undefined ? { statusPersisted } : {}),
      },
    });
  } catch {
    return sendJson(res, 502, {
      success: false,
      error: "Telegram network error",
      details: ["Не удалось подтвердить доставку. Проверьте сообщения в Telegram перед повторной отправкой."],
      hint: "Проверьте доступность Telegram API, TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID.",
    });
  }
}

// ---------------------------------------------------------------------------
// Генерация файлов
//
// Отличие от всего, что выше: у генерации изображения нет демо-режима. Текст
// без ключа можно отдать заготовкой — она читается как текст и приносит
// пользу. Картинки-заготовки не существует, поэтому «не подключено» здесь
// говорится прямо, с именем переменной окружения, и кнопка в интерфейсе
// выключается. Тихая заглушка на этом месте означала бы рекламный креатив,
// которого никто не создавал.
// ---------------------------------------------------------------------------

function sendRefusal(res: VercelResponse, refusal: GenerationRefusal) {
  return sendJson(res, refusal.status, {
    success: false,
    error: refusal.error,
    details: refusal.details,
    ...(refusal.hint ? { hint: refusal.hint } : {}),
  });
}

/**
 * Отказ провайдера получает безопасную публичную категорию и свой статус.
 *
 * 401 от OpenAI — это наш ключ, а не сессия оператора: вернуть его наружу
 * значило бы выкинуть человека на экран входа из-за чужой проблемы. Наружу
 * уходит 502 без исходного текста, который может повторять данные запроса.
 */
function sendProviderFailure(res: VercelResponse, error: unknown, subject: string) {
  if (error instanceof GenerationProviderError) {
    if (error.status === 429) {
      return sendJson(res, 429, {
        success: false,
        error: `${subject}: сервис генерации ограничил частоту запросов`,
        details: ["Сервис генерации временно ограничил частоту запросов."],
        hint: "Попробуйте через минуту. Если повторяется — проверьте лимиты и баланс аккаунта OpenAI.",
      });
    }
    if (error.status === 400 || error.status === 422) {
      // Keep validation distinct without exposing the provider's request echo.
      return sendJson(res, 422, {
        success: false,
        error: `${subject}: сервис генерации отклонил запрос`,
        details: ["Провайдер не принял параметры или содержание запроса."],
        hint: "Перепишите описание кадра: провайдер отклоняет медицинские обещания, узнаваемых людей и защищённые бренды.",
      });
    }
    return sendJson(res, 502, {
      success: false,
      error: `${subject}: сервис генерации ответил отказом`,
      details: ["Сервис генерации не подтвердил выполнение запроса."],
    });
  }

  return sendJson(res, 502, {
    success: false,
    error: subject,
    details: ["Не удалось подтвердить результат запроса к сервису генерации."],
  });
}

function generatedFileName(kind: "photo" | "video", mimeType: string): string {
  const extension =
    mimeType === "image/png"
      ? "png"
      : mimeType === "image/webp"
        ? "webp"
        : mimeType === "image/jpeg"
          ? "jpg"
          : "mp4";
  return `negis-${kind}-${Date.now()}.${extension}`;
}

function requireGeneratedStorageReceipt(value: unknown, expected: {
  workspaceId: string; fileName: string; mimeType: string; fileSize: number; idempotencyKey?: string;
}): asserts value is { publicUrl: string; asset: { id: string }; mode: "supabase"; warning: string } {
  const invalid = () => new Error("generated_storage_receipt_unconfirmed");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const stored = value as Record<string, unknown>;
  const asset = stored.asset && typeof stored.asset === "object" && !Array.isArray(stored.asset)
    ? stored.asset as Record<string, unknown> : {};
  if (stored.mode !== "supabase" || stored.warning !== "" || typeof stored.publicUrl !== "string"
    || typeof asset.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(asset.id)
    || asset.workspaceId !== expected.workspaceId
    || asset.mimeType !== expected.mimeType || asset.fileSize !== expected.fileSize
    || asset.fileType !== (expected.mimeType.startsWith("image/") ? "image" : "video")
    || asset.storageBucket !== "ad-creatives" || typeof asset.storagePath !== "string"
    || !asset.storagePath.startsWith(`${expected.workspaceId}/`) || asset.publicUrl !== stored.publicUrl) throw invalid();
  if (expected.idempotencyKey !== undefined) {
    const identity = generatedCreativeIdentity({ ...expected, idempotencyKey: expected.idempotencyKey });
    const canonical = asset.id === identity.assetId && asset.fileName === identity.fileName && asset.storagePath === identity.storagePath;
    const legacy = expected.mimeType === "video/mp4" && isLegacyGeneratedVideoIdentity({ ...expected,
      idempotencyKey: expected.idempotencyKey, fileName: asset.fileName, storagePath: asset.storagePath });
    if (!canonical && !legacy) throw invalid();
  } else if (asset.fileName !== expected.fileName) throw invalid();
  const base = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const publicUrl = `${base}/storage/v1/object/public/ad-creatives/${asset.storagePath.split("/").map(encodeURIComponent).join("/")}`;
  if (!base || stored.publicUrl !== publicUrl) throw invalid();
}

async function handleGeneratePhoto(req: VercelRequest, res: VercelResponse, context: WorkspaceAccessContext) {
  const payload = readBody(req);
  const config = readGenerationConfig();
  const refusal = imageGenerationRefusal(config);
  if (refusal) return sendRefusal(res, refusal);

  const prompt = normalizePrompt(payload.prompt);
  if (!prompt) {
    return sendJson(res, 400, {
      success: false,
      error: "Validation error",
      details: ["Опишите кадр — без описания генерировать нечего."],
    });
  }
  const requestKey = generationRequestKey(req);
  if (!requestKey) return sendGenerationRequestKeyRefusal(res);

  const size = imageSizeForFormat(payload.format);
  let usage: ContentUsageReservation;
  try {
    usage = await reserveContentGeneration({
      workspaceId: context.workspaceId,
      staffUserId: context.staffUserId,
      requestKey,
      operation: "generated_image",
      kind: "image",
      units: 1,
      provider: "openai",
      model: config.imageModel,
    });
  } catch (error) {
    return sendJson(res, 503, {
      success: false,
      error: "Не удалось проверить лимит генерации",
      details: ["Учёт генераций временно недоступен. Генерация не запущена."],
      code: "generation_usage_unavailable",
    });
  }
  if (!usage.allowed) return sendUsageRefusal(res, usage);

  let image: Awaited<ReturnType<typeof generateImage>>;
  try {
    image = await generateImage({
      fetchImpl: fetch as unknown as GenerationFetch,
      config,
      prompt,
      size,
    });
  } catch (error) {
    const accounting = providerFailureAccounting(error);
    await completeContentGeneration({
      workspaceId: context.workspaceId,
      reservation: usage,
      status: accounting.status,
      errorCode: accounting.errorCode,
      provider: "openai",
      model: config.imageModel,
    });
    return sendProviderFailure(res, error, "Не удалось сгенерировать изображение");
  }
  await completeContentGeneration({
    workspaceId: context.workspaceId,
    reservation: usage,
    status: "succeeded",
    provider: "openai",
    model: image.model,
  });

  // Отдельная попытка — отдельный текст отказа. С этой строки картинка уже
  // сделана и оплачена, и «не удалось сгенерировать» здесь было бы неправдой:
  // сгенерировать удалось, не удалось сохранить, и оператор должен понимать,
  // что повторное нажатие потратит деньги второй раз.
  try {
    const fileName = generatedFileName("photo", image.mimeType);
    const stored = await storeGeneratedCreative({
      workspaceId: context.workspaceId,
      fileName,
      mimeType: image.mimeType,
      buffer: image.buffer,
      metadata: {
        source: "content-studio",
        kind: "generated-photo",
        provider: "openai",
        model: image.model,
        size,
        prompt,
      },
    });
    requireGeneratedStorageReceipt(stored, { workspaceId: context.workspaceId, fileName, mimeType: image.mimeType, fileSize: image.buffer.length });

    const warnings = [usage.warning, stored.warning].filter((value): value is string => Boolean(value));
    return sendJson(res, 200, {
      success: true,
      mode: "openai",
      ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
      data: {
        creativeUrl: stored.publicUrl,
        assetId: typeof stored.asset.id === "string" ? stored.asset.id : "",
        fileName,
        mimeType: image.mimeType,
        fileSize: image.buffer.length,
        size,
        model: image.model,
      },
    });
  } catch (error) {
    return sendJson(res, 502, {
      success: false,
      error: "Изображение сгенерировано, сохранение не подтверждено",
      details: ["Хранилище не подтвердило сохранение изображения."],
      hint: "Генерация уже оплачена. Проверьте хранилище прежде, чем повторять — повторный запуск создаст новое изображение за новую цену.",
    });
  }
}

/**
 * Ключ подписи идентификатора задачи.
 *
 * Служебный ключ Supabase взят потому, что он есть на сервере всегда, когда
 * вообще есть куда сохранять результат, и не существует в браузере. HMAC его
 * не раскрывает: наружу уходит только дайджест.
 */
function jobHandleSecret(): string {
  return (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
}

type GeneratedVideoApiState = {
  generationKey: string;
  requestDigest: string | null;
  providerJobId: string | null;
  status: string;
  validationJobId: string | null;
  needInput: boolean;
  progress: number;
  result: Record<string, unknown> | null;
};

function videoRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function generatedVideoApiState(value: unknown, generationKey: string): GeneratedVideoApiState {
  const state = videoRecord(value);
  if (state.generationKey !== generationKey
    || !["reserved", "dispatching", "rendering", "awaiting_upload", "queued", "processing", "ready", "failed", "cancelled"].includes(String(state.status))
    || (state.requestDigest !== null && (typeof state.requestDigest !== "string" || !/^[0-9a-f]{64}$/.test(state.requestDigest)))
    || (state.providerJobId !== null && (typeof state.providerJobId !== "string" || !state.providerJobId || state.providerJobId.length > 512))) {
    throw new Error("generated_video_state_unconfirmed");
  }
  const jobId = typeof state.validationJobId === "string" ? state.validationJobId : null;
  if (jobId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
    throw new Error("generated_video_state_unconfirmed");
  }
  const asset = videoRecord(state.asset);
  const result = state.status === "ready" && state.nativeValidated === true && asset.status === "ready"
    ? { assetId: asset.id, workspaceId: asset.workspaceId, fileType: asset.fileType, validationJobId: jobId, nativeValidated: true, fileName: asset.fileName,
      mimeType: asset.mimeType, fileSize: asset.fileSize, storageBucket: asset.storageBucket, storagePath: asset.storagePath,
      creativeUrl: asset.publicUrl, sha256: asset.sha256, thumbnailUrl: asset.thumbnailUrl, thumbnailPath: asset.thumbnailPath,
      thumbnailSize: asset.thumbnailSize, thumbnailSha256: asset.thumbnailSha256 }
    : null;
  if ((state.status === "ready" && !result) || (state.needInput === true && !["rendering", "awaiting_upload"].includes(String(state.status)))) {
    throw new Error("generated_video_state_unconfirmed");
  }
  return { generationKey, requestDigest: state.requestDigest as string | null, providerJobId: state.providerJobId as string | null,
    status: String(state.status), validationJobId: jobId, needInput: state.needInput === true,
    progress: typeof state.progress === "number" && Number.isFinite(state.progress) ? Math.max(0, Math.min(95, state.progress)) : 0,
    result };
}

async function requireCurrentVideoActor(req: VercelRequest, expected: WorkspaceAccessContext): Promise<void> {
  const actor = await requireWorkspaceAccess(req, expected.workspaceId, { permission: "manage_ai_content" });
  if (actor.workspaceId !== expected.workspaceId || actor.staffUserId !== expected.staffUserId || actor.userId !== expected.userId) {
    throw new WorkspaceAdminAuthError(403, "Access denied", "workspace_access_denied");
  }
}

function sendVideoRequestConflict(res: VercelResponse) {
  return sendJson(res, 409, { success: false, code: "generated_video_request_conflict", error: "Запрос видео не совпадает с уже принятым",
    details: ["Один ключ повтора нельзя использовать для другого описания или формата."] });
}

function sendVideoDispatchUnconfirmed(res: VercelResponse) {
  return sendJson(res, 409, { success: false, code: "generated_video_dispatch_unconfirmed", error: "Этот запрос уже принят или ожидает проверки",
    accepted: true, hint: "Не запускайте новый платный рендер. Повторите проверку этого же запроса; неподтверждённая отправка требует сверки." });
}

function sendVideoWorkflowFailure(res: VercelResponse, error?: unknown, handle?: string, accepted = false) {
  if (error instanceof WorkspaceAdminAuthError) {
    return sendJson(res, error.statusCode, { success: false, error: error.message, code: error.code });
  }
  const failure = videoRecord(error);
  const status = typeof failure.status === "number" && [400, 403, 404, 409, 413, 429, 502, 503].includes(failure.status) ? failure.status : 503;
  const code = typeof failure.code === "string" && /^generated_video_[a-z0-9_]{1,80}$/.test(failure.code)
    ? failure.code : "generated_video_workflow_unconfirmed";
  if (status === 403) return sendJson(res, 403, { success: false, code: "workspace_access_denied", error: "Access denied" });
  return sendJson(res, status, { success: false, code,
    error: accepted ? "Ролик принят, проверка результата пока не подтверждена" : "Не удалось подтвердить безопасную обработку видео",
    details: [accepted ? "Исходная задача сохранена; подтверждённой публичной ссылки пока нет." : "Закрытая очередь или подтверждение результата временно недоступны."],
    ...(accepted ? { accepted: true, hint: "Повторите проверку того же ролика, не запускайте новую платную генерацию." } : {}),
    ...(handle ? { data: { handle, status: "in_progress", phase: "validation" } } : {}) });
}

async function cancelUnsentVideo(config: ReturnType<typeof generatedVideoWorkflowConfig>, context: WorkspaceAccessContext, generationKey: string) {
  try { await cancelGeneratedVideoWorkflow(config, context, generationKey, null, false); }
  catch { /* An uncertain cancellation retains the reservation; it cannot authorize a provider call. */ }
}

function sendAcceptedVideo(res: VercelResponse, context: WorkspaceAccessContext, state: GeneratedVideoApiState, secret: string,
  options: { size: string; seconds: number; format: string; warning?: string; model?: string; progress?: number; status?: string }) {
  if (!state.providerJobId) throw new Error("generated_video_provider_link_unconfirmed");
  const handle = signGeneratedVideoJobHandle({ workspaceId: context.workspaceId, generationKey: state.generationKey, providerJobId: state.providerJobId }, secret);
  return sendJson(res, 202, { success: true, mode: "openai", ...(options.warning ? { warning: options.warning } : {}),
    data: { handle, status: options.status === "failed" ? "failed" : options.status === "queued" ? "queued" : "in_progress",
      progress: typeof options.progress === "number" && Number.isFinite(options.progress) ? Math.max(0, Math.min(95, options.progress)) : state.progress,
      phase: state.validationJobId || state.status === "ready" ? "validation" : "generation",
      ...(state.validationJobId ? { validationJobId: state.validationJobId } : {}),
      size: options.size, seconds: options.seconds, ...(options.model ? { model: options.model } : {}),
      formatSubstituted: videoFormatWasSubstituted(options.format) } });
}

function sendVideoWorkflowState(res: VercelResponse, context: WorkspaceAccessContext, state: GeneratedVideoApiState, handle: string) {
  if (state.status === "ready") {
    const result = state.result;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const digest = /^[0-9a-f]{64}$/;
    const origin = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
    const invalid = () => new Error("generated_video_native_receipt_unconfirmed");
    const identity = generatedCreativeIdentity({ workspaceId: context.workspaceId, idempotencyKey: state.generationKey, mimeType: "video/mp4" });
    if (!result || result.nativeValidated !== true || result.workspaceId !== context.workspaceId || result.fileType !== "video"
      || typeof result.assetId !== "string" || !uuid.test(result.assetId) || result.assetId !== identity.assetId || result.fileName !== identity.fileName
      || !state.validationJobId || result.validationJobId !== state.validationJobId
      || result.mimeType !== "video/mp4" || !Number.isSafeInteger(result.fileSize) || Number(result.fileSize) < 1 || Number(result.fileSize) > 100 * 1024 * 1024
      || typeof result.sha256 !== "string" || !digest.test(result.sha256)
      || typeof result.fileName !== "string" || !/^negis-video-[0-9a-f]{20}\.mp4$/.test(result.fileName)
      || result.storageBucket !== "ad-creatives" || typeof result.storagePath !== "string"
      || !new RegExp(`^optimized/${context.workspaceId}/${state.validationJobId}-[0-9a-f]{20}\\.mp4$`).test(result.storagePath)
      || !origin.startsWith("https://") || result.creativeUrl !== `${origin}/storage/v1/object/public/ad-creatives/${result.storagePath}`
      || result.thumbnailPath !== `${result.storagePath.slice(0, -4)}-thumbnail.jpg`
      || result.thumbnailUrl !== `${origin}/storage/v1/object/public/ad-creatives/${result.thumbnailPath}`
      || !Number.isSafeInteger(result.thumbnailSize) || Number(result.thumbnailSize) < 1 || Number(result.thumbnailSize) > 10 * 1024 * 1024
      || typeof result.thumbnailSha256 !== "string" || !digest.test(result.thumbnailSha256)) throw invalid();
    return sendJson(res, 200, { success: true, mode: "openai", data: { handle, status: "completed", phase: "validation", progress: 100,
      nativeValidated: true, validationJobId: state.validationJobId, assetId: result.assetId, creativeUrl: result.creativeUrl,
      fileName: result.fileName, mimeType: result.mimeType, fileSize: result.fileSize, sha256: result.sha256,
      storageBucket: result.storageBucket, storagePath: result.storagePath, thumbnailUrl: result.thumbnailUrl,
      thumbnailPath: result.thumbnailPath, thumbnailSize: result.thumbnailSize, thumbnailSha256: result.thumbnailSha256 } });
  }
  if (state.status === "failed" || state.status === "cancelled") {
    return sendJson(res, 200, { success: true, mode: "openai", data: { handle, status: "failed", phase: "validation", progress: state.progress,
      ...(state.validationJobId ? { validationJobId: state.validationJobId } : {}), failureReason: "Проверка файла не завершилась успешно. Повторная проверка не требует нового рендера." } });
  }
  return sendJson(res, 200, { success: true, mode: "openai", data: { handle, status: "in_progress", phase: "validation", progress: state.progress,
    ...(state.validationJobId ? { validationJobId: state.validationJobId } : {}) } });
}

async function handleGenerateVideo(req: VercelRequest, res: VercelResponse, context: WorkspaceAccessContext) {
  const payload = readBody(req);
  const secret = jobHandleSecret();
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  if (!prompt) {
    return sendJson(res, 400, {
      success: false,
      error: "Validation error",
      details: ["Опишите ролик — без описания генерировать нечего."],
    });
  }
  const requestKey = generationRequestKey(req);
  if (!requestKey) return sendGenerationRequestKeyRefusal(res);
  if (!secret) return sendVideoWorkflowFailure(res);
  const generationKey = `v2:${requestKey.toLowerCase()}`;
  const format = payload.format === undefined ? "universal" : typeof payload.format === "string" ? payload.format.trim().toLowerCase() : "";
  let requestDigest: string;
  try { requestDigest = generatedVideoRequestDigest(prompt, format); }
  catch {
    return sendJson(res, 400, { success: false, code: "generated_video_request_invalid", error: "Проверьте параметры ролика" });
  }
  const size = videoSizeForFormat(format);
  const config = readGenerationConfig();
  const seconds = billableVideoSeconds(config.videoSeconds);
  let nativeConfig: ReturnType<typeof generatedVideoWorkflowConfig>;
  let state: GeneratedVideoApiState;
  try {
    nativeConfig = generatedVideoWorkflowConfig();
    const existing = await readGeneratedVideoWorkflow(nativeConfig, context, generationKey);
    await requireCurrentVideoActor(req, context);
    if (existing) {
      state = generatedVideoApiState(existing, generationKey);
      if (state.requestDigest !== requestDigest) return sendVideoRequestConflict(res);
      if (state.providerJobId) return sendAcceptedVideo(res, context, state, secret, { size, seconds, format });
      if (state.status !== "reserved") return sendVideoDispatchUnconfirmed(res);
    }
    const refusal = videoGenerationRefusal(config);
    if (refusal) return sendRefusal(res, refusal);
    // Native capacity and a private bucket are confirmed before spending quota or calling the provider.
    await requireGeneratedVideoWorkflowReady(nativeConfig, context);
    await requireCurrentVideoActor(req, context);
    state = generatedVideoApiState(await admitGeneratedVideoWorkflow(nativeConfig, context, { generationKey, requestDigest }), generationKey);
    await requireCurrentVideoActor(req, context);
    if (state.requestDigest !== requestDigest) return sendVideoRequestConflict(res);
    if (state.providerJobId) return sendAcceptedVideo(res, context, state, secret, { size, seconds, format });
    if (state.status !== "reserved") return sendVideoDispatchUnconfirmed(res);
  } catch (error) { return sendVideoWorkflowFailure(res, error); }

  let usage: ContentUsageReservation;
  try {
    usage = await reserveContentGeneration({
      workspaceId: context.workspaceId,
      staffUserId: context.staffUserId,
      requestKey,
      operation: "generated_video",
      kind: "video_seconds",
      units: seconds,
      provider: "openai",
      model: config.videoModel,
    });
  } catch {
    await cancelUnsentVideo(nativeConfig, context, generationKey);
    return sendJson(res, 503, {
      success: false,
      error: "Не удалось проверить лимит генерации",
      details: ["Учёт генераций временно недоступен. Генерация не запущена."],
      code: "generation_usage_unavailable",
    });
  }
  if (!usage.allowed) {
    // A concurrent accepted request may have linked its job while quota was being checked.
    try {
      const current = await readGeneratedVideoWorkflow(nativeConfig, context, generationKey);
      await requireCurrentVideoActor(req, context);
      if (current) {
        const replay = generatedVideoApiState(current, generationKey);
        if (replay.requestDigest !== requestDigest) return sendVideoRequestConflict(res);
        if (replay.providerJobId) return sendAcceptedVideo(res, context, replay, secret, { size, seconds, format });
      }
      // Duplicate quota belongs to another request; do not cancel its native reservation.
      if (usage.reason !== "duplicate_request") await cancelUnsentVideo(nativeConfig, context, generationKey);
    } catch (error) { return sendVideoWorkflowFailure(res, error); }
    return sendUsageRefusal(res, usage);
  }

  const dispatchId = randomUUID();
  try {
    await requireCurrentVideoActor(req, context);
    const dispatched = await beginGeneratedVideoDispatch(nativeConfig, context, generationKey, dispatchId);
    state = generatedVideoApiState(dispatched, generationKey);
    if (state.providerJobId) {
      await requireCurrentVideoActor(req, context);
      return sendAcceptedVideo(res, context, state, secret, { size, seconds, format, warning: usage.warning });
    }
    if (videoRecord(dispatched).dispatchAccepted !== true) return sendVideoDispatchUnconfirmed(res);
    await requireCurrentVideoActor(req, context);
  } catch (error) {
    // An uncertain begin may have committed: never release its quota or dispatch again.
    return sendVideoWorkflowFailure(res, error);
  }

  let job: Awaited<ReturnType<typeof createVideoJob>>;
  try {
    job = await createVideoJob({
      fetchImpl: fetch as unknown as GenerationFetch,
      config,
      prompt,
      size,
    });
  } catch (error) {
    const accounting = providerFailureAccounting(error);
    if (accounting.status === "failed") {
      try { await cancelGeneratedVideoWorkflow(nativeConfig, context, generationKey, dispatchId, true); }
      catch (cancelError) { return sendVideoWorkflowFailure(res, cancelError, undefined, true); }
    }
    await completeContentGeneration({
      workspaceId: context.workspaceId,
      reservation: usage,
      status: accounting.status,
      errorCode: accounting.errorCode,
      provider: "openai",
      model: config.videoModel,
    });
    try { await requireCurrentVideoActor(req, context); }
    catch (accessError) { return sendVideoWorkflowFailure(res, accessError); }
    if (accounting.status === "unknown") return sendVideoDispatchUnconfirmed(res);
    return sendProviderFailure(res, error, "Сервис генерации отклонил запуск видео");
  }

  // The provider accepted the paid job. Linking/accounting failures must not be reported as a failed render.
  try {
    state = generatedVideoApiState(await linkGeneratedVideoProvider(nativeConfig, context, generationKey, dispatchId, job.id), generationKey);
    if (state.providerJobId !== job.id) throw new Error("generated_video_provider_link_unconfirmed");
    await completeContentGeneration({ workspaceId: context.workspaceId, reservation: usage, status: "succeeded", provider: "openai", model: config.videoModel });
    await requireCurrentVideoActor(req, context);
    return sendAcceptedVideo(res, context, state, secret, { size, seconds, format, warning: usage.warning, model: config.videoModel,
      progress: job.progress, status: job.status === "completed" ? "in_progress" : job.status });
  } catch (error) { return sendVideoWorkflowFailure(res, error, undefined, true); }
}

async function handleVideoGeneration(req: VercelRequest, res: VercelResponse, context: WorkspaceAccessContext) {
  const secret = jobHandleSecret();
  if (!secret) return sendVideoWorkflowFailure(res);
  const handleParam = Array.isArray(req.query.handle) ? req.query.handle[0] : req.query.handle;
  const handle = readGeneratedVideoJobHandle(handleParam, context.workspaceId, secret);
  if (!handle) {
    return sendJson(res, 404, {
      success: false,
      error: "Задача генерации не найдена",
      details: ["Идентификатор задачи не принадлежит этому рабочему пространству."],
    });
  }
  const generationKey = handle.generationKey;
  const signedHandle = String(handleParam);
  try {
    const nativeConfig = generatedVideoWorkflowConfig();
    let existing = await readGeneratedVideoWorkflow(nativeConfig, context, generationKey);
    await requireCurrentVideoActor(req, context);
    if (!existing && handle.legacy) {
      // A valid old handle can recover its existing render, never start a new paid job.
      await requireGeneratedVideoWorkflowReady(nativeConfig, context);
      await requireCurrentVideoActor(req, context);
      existing = await admitGeneratedVideoWorkflow(nativeConfig, context, { generationKey, requestDigest: null, providerJobId: handle.providerJobId });
      await requireCurrentVideoActor(req, context);
    }
    if (!existing) return sendJson(res, 404, { success: false, code: "generated_video_not_found", error: "Задача генерации не найдена" });
    let state = generatedVideoApiState(existing, generationKey);
    if (state.providerJobId !== handle.providerJobId) return sendVideoRequestConflict(res);
    state = generatedVideoApiState(await resumeGeneratedVideoWorkflow(nativeConfig, context, generationKey), generationKey);
    await requireCurrentVideoActor(req, context);
    if (state.providerJobId !== handle.providerJobId) return sendVideoRequestConflict(res);
    if (!state.needInput) return sendVideoWorkflowState(res, context, state, signedHandle);

    // Provider configuration is needed only to fetch missing input, not to replay a validated result.
    const config = readGenerationConfig();
    const refusal = videoGenerationRefusal(config);
    if (refusal) return sendVideoWorkflowFailure(res, undefined, signedHandle, true);
    await requireGeneratedVideoWorkflowReady(nativeConfig, context);
    await requireCurrentVideoActor(req, context);
    const job = await fetchVideoJob({ fetchImpl: fetch as unknown as GenerationFetch, config, jobId: handle.providerJobId });
    await requireCurrentVideoActor(req, context);
    if (job.status === "failed") {
      return sendJson(res, 200, {
        success: true,
        mode: "openai",
        data: {
          status: "failed",
          progress: job.progress,
          handle: signedHandle,
          phase: "generation",
          failureReason: "Сервис генерации сообщил об ошибке рендера.",
        },
      });
    }

    if (job.status !== "completed") {
      return sendJson(res, 200, {
        success: true,
        mode: "openai",
        data: { handle: signedHandle, status: job.status, progress: Math.min(95, job.progress), phase: "generation" },
      });
    }
    const buffer = await downloadVideoContent({ fetchImpl: fetch as unknown as GenerationFetch, config, jobId: handle.providerJobId });
    await requireCurrentVideoActor(req, context);
    state = generatedVideoApiState(await receiveGeneratedVideoInput(nativeConfig, context, generationKey, buffer), generationKey);
    await requireCurrentVideoActor(req, context);
    if (state.providerJobId !== handle.providerJobId) return sendVideoRequestConflict(res);
    return sendVideoWorkflowState(res, context, state, signedHandle);
  } catch (error) {
    const failure = videoRecord(error);
    if (handle.legacy && failure.status === 409 && failure.code === "generated_video_request_conflict") {
      return sendJson(res, 409, { success: false, accepted: true, code: "generated_video_legacy_review_required",
        error: "Ранее сохранённый ролик требует ручной проверки",
        details: ["Прежняя публичная запись несовместима с подтверждённой обработкой. Файл и его идентификатор не перезаписаны."],
        hint: "Нужна сверка старой записи. Не запускайте новый платный рендер для исправления этого конфликта.",
        data: { handle: signedHandle, status: "in_progress", phase: "validation" } });
    }
    return sendVideoWorkflowFailure(res, error, signedHandle, true);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const resource = normalizeRouteSegment(readPathSegment(req));
  if (resource === "generate-video" || resource === "video-generation") {
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Vary", "Authorization");
  }
  // По собственным ключам, а не по цепочке прототипов: сегмент «constructor»
  // иначе находит функцию Object, и запрос падает с TypeError вместо 404.
  const authorization = Object.prototype.hasOwnProperty.call(CONTENT_STUDIO_AUTHORIZATION, resource)
    ? CONTENT_STUDIO_AUTHORIZATION[resource]
    : undefined;
  if (!authorization) return sendNotFound(res);

  // Nothing below this line runs for an unauthenticated caller: no OpenAI
  // request, no Telegram request, no Supabase client.
  const context = await authorizePrivateRoute(req, res, authorization);
  if (!context) return;

  if (resource === "generate-package") return handleGeneratePackage(req, res, context);
  if (resource === "usage") return handleUsage(req, res, context);
  if (resource === "improve-ad-text") return handleImproveAdText(req, res, context);
  if (resource === "generate-script") return handleGenerateScript(req, res, context);
  if (resource === "generate-avatar-prompt") return handleGenerateAvatarPrompt(req, res, context);
  if (resource === "generate-tapnow-prompt") return handleGenerateTapNowPrompt(req, res, context);
  if (resource === "send-telegram") return handleSendTelegram(req, res, context);
  if (resource === "generate-photo") return handleGeneratePhoto(req, res, context);
  if (resource === "generate-video") return handleGenerateVideo(req, res, context);
  if (resource === "video-generation") return handleVideoGeneration(req, res, context);

  return sendNotFound(res);
}

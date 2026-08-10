import type { VercelRequest, VercelResponse } from "@vercel/node";
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
  readSignedVideoJobHandle,
  signVideoJobHandle,
  videoFormatWasSubstituted,
  videoGenerationRefusal,
  videoSizeForFormat,
  type GenerationFetch,
  type GenerationRefusal,
} from "../../lib/content-studio/generation";
import { persistContentVideoPatchIfAvailable, storeGeneratedCreative } from "../../lib/crm/server";
import {
  authorizePrivateRoute,
  normalizeRouteSegment,
  sendNotFound,
  type PrivateRouteAuthorization,
} from "../../lib/auth/route-guard";
import type { WorkspaceAccessContext } from "../../lib/auth/server";

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
};

function sendJson(res: VercelResponse, status: number, payload: unknown) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json(payload);
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
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += maxLength) {
    chunks.push(text.slice(index, index + maxLength));
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
  const description =
    body.description || (body.raw ? "Telegram returned a non-JSON response body." : `Telegram API error: HTTP ${response.status}`);

  if (!response.ok || body.ok === false) {
    return {
      success: false as const,
      status: response.status,
      telegramDescription: description,
      telegramErrorCode: body.error_code,
      hint: telegramHint(description, response.status),
    };
  }

  return {
    success: true as const,
    status: response.status,
  };
}

async function handleGeneratePackage(req: VercelRequest, res: VercelResponse, context: WorkspaceAccessContext) {
  try {
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
          complianceNotes: "array of short notes confirming safe medical wording",
        },
        input: payload,
      },
      fallback,
      normalize: (value) => normalizeContentPackage(value, fallback),
    });

    return sendJson(res, 200, {
      success: true,
      mode: result.mode,
      data: result.data,
    });
  } catch (error) {
    return sendJson(res, 500, {
      success: false,
      error: "Generation error",
      details: [error instanceof Error ? error.message : "Failed to generate content package"],
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
  void context;
  try {
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

    if (result.refusal) {
      return sendJson(res, 502, {
        success: false,
        error: "Не удалось переписать текст",
        details: [result.refusal],
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
        // Провайдер мог отказать на второй попытке — первая при этом цела.
        refusal: result.refusal,
      },
    });
  } catch (error) {
    return sendJson(res, 500, {
      success: false,
      error: "Не удалось переписать текст",
      details: [error instanceof Error ? error.message : "Провайдер не ответил"],
    });
  }
}

async function handleGenerateScript(req: VercelRequest, res: VercelResponse, context: WorkspaceAccessContext) {
  try {
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
    return sendJson(res, 500, {
      success: false,
      error: "Generation error",
      details: [error instanceof Error ? error.message : "Failed to generate script package"],
    });
  }
}

async function handleGenerateAvatarPrompt(req: VercelRequest, res: VercelResponse, context: WorkspaceAccessContext) {
  try {
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
    return sendJson(res, 500, {
      success: false,
      error: "Generation error",
      details: [error instanceof Error ? error.message : "Failed to generate avatar prompt"],
    });
  }
}

async function handleGenerateTapNowPrompt(req: VercelRequest, res: VercelResponse, context: WorkspaceAccessContext) {
  try {
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
    return sendJson(res, 500, {
      success: false,
      error: "Generation error",
      details: [error instanceof Error ? error.message : "Failed to generate TapNow prompt"],
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
  const messageText = isTest ? "✅ Telegram подключён к Negis Content Studio" : packageText;

  if (!token || !chatId) {
    if (typeof payload.videoId === "string") {
      const patch = { status: "telegram_ready" as const };
      updateContentVideo(payload.videoId, patch);
      await persistContentVideoPatchIfAvailable({
        videoId: payload.videoId,
        workspaceId: context.workspaceId,
        patch,
      });
    }

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

    if (!isTest && typeof payload.videoId === "string") {
      const patch = { status: "telegram_ready" as const };
      updateContentVideo(payload.videoId, patch);
      await persistContentVideoPatchIfAvailable({
        videoId: payload.videoId,
        workspaceId: context.workspaceId,
        patch,
      });
    }

    return sendJson(res, 200, {
      success: true,
      mode: "telegram",
      data: {
        sent: true,
        packageText: messageText,
        test: isTest,
        parts: chunks.length,
      },
    });
  } catch (error) {
    return sendJson(res, 502, {
      success: false,
      error: "Telegram network error",
      details: [error instanceof Error ? error.message : "Failed to send Telegram message"],
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
 * Отказ провайдера пересказывается оператору как есть, но своим статусом.
 *
 * 401 от OpenAI — это наш ключ, а не сессия оператора: вернуть его наружу
 * значило бы выкинуть человека на экран входа из-за чужой проблемы. Наружу
 * уходит 502 «сервис генерации ответил отказом» с исходным текстом.
 */
function sendProviderFailure(res: VercelResponse, error: unknown, subject: string) {
  if (error instanceof GenerationProviderError) {
    if (error.status === 429) {
      return sendJson(res, 429, {
        success: false,
        error: `${subject}: сервис генерации ограничил частоту запросов`,
        details: [error.message],
        hint: "Попробуйте через минуту. Если повторяется — проверьте лимиты и баланс аккаунта OpenAI.",
      });
    }
    if (error.status === 400 || error.status === 422) {
      // Отказ по содержанию запроса: провайдер отклонил prompt. Это не сбой,
      // это ответ, который оператору нужно прочитать и переписать текст.
      return sendJson(res, 422, {
        success: false,
        error: `${subject}: сервис генерации отклонил запрос`,
        details: [error.message],
        hint: "Перепишите описание кадра: провайдер отклоняет медицинские обещания, узнаваемых людей и защищённые бренды.",
      });
    }
    return sendJson(res, 502, {
      success: false,
      error: `${subject}: сервис генерации ответил отказом`,
      details: [error.message],
    });
  }

  return sendJson(res, 502, {
    success: false,
    error: subject,
    details: [error instanceof Error ? error.message : "Неизвестная ошибка"],
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

  const size = imageSizeForFormat(payload.format);

  let image: Awaited<ReturnType<typeof generateImage>>;
  try {
    image = await generateImage({
      fetchImpl: fetch as unknown as GenerationFetch,
      config,
      prompt,
      size,
    });
  } catch (error) {
    return sendProviderFailure(res, error, "Не удалось сгенерировать изображение");
  }

  // Отдельная попытка — отдельный текст отказа. С этой строки картинка уже
  // сделана и оплачена, и «не удалось сгенерировать» здесь было бы неправдой:
  // сгенерировать удалось, не удалось сохранить, и оператор должен понимать,
  // что повторное нажатие потратит деньги второй раз.
  try {
    const stored = await storeGeneratedCreative({
      workspaceId: context.workspaceId,
      fileName: generatedFileName("photo", image.mimeType),
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

    return sendJson(res, 200, {
      success: true,
      mode: "openai",
      ...(stored.warning ? { warning: stored.warning } : {}),
      data: {
        creativeUrl: stored.publicUrl,
        assetId: typeof stored.asset.id === "string" ? stored.asset.id : "",
        mimeType: image.mimeType,
        fileSize: image.buffer.length,
        size,
        model: image.model,
      },
    });
  } catch (error) {
    return sendJson(res, 502, {
      success: false,
      error: "Изображение сгенерировано, но не сохранено",
      details: [error instanceof Error ? error.message : "Хранилище не приняло файл"],
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

async function handleGenerateVideo(req: VercelRequest, res: VercelResponse, context: WorkspaceAccessContext) {
  const payload = readBody(req);
  const config = readGenerationConfig();
  const refusal = videoGenerationRefusal(config);
  if (refusal) return sendRefusal(res, refusal);

  const secret = jobHandleSecret();
  if (!secret) {
    return sendJson(res, 503, {
      success: false,
      error: "Генерация видео не подключена",
      details: ["Не настроено хранилище: без него готовый ролик некуда положить."],
    });
  }

  const prompt = normalizePrompt(payload.prompt);
  if (!prompt) {
    return sendJson(res, 400, {
      success: false,
      error: "Validation error",
      details: ["Опишите ролик — без описания генерировать нечего."],
    });
  }

  const size = videoSizeForFormat(payload.format);

  try {
    const job = await createVideoJob({
      fetchImpl: fetch as unknown as GenerationFetch,
      config,
      prompt,
      size,
    });

    return sendJson(res, 202, {
      success: true,
      mode: "openai",
      data: {
        handle: signVideoJobHandle({ workspaceId: context.workspaceId, jobId: job.id, secret }),
        status: job.status,
        progress: job.progress,
        size,
        model: config.videoModel,
        // Квадрата у видеомодели нет. Молча снять вертикально и не сказать —
        // значит отдать в Feed кадр, обрезанный не там, где ожидали.
        formatSubstituted: videoFormatWasSubstituted(payload.format),
      },
    });
  } catch (error) {
    return sendProviderFailure(res, error, "Не удалось запустить генерацию видео");
  }
}

async function handleVideoGeneration(req: VercelRequest, res: VercelResponse, context: WorkspaceAccessContext) {
  const config = readGenerationConfig();
  const refusal = videoGenerationRefusal(config);
  if (refusal) return sendRefusal(res, refusal);

  const secret = jobHandleSecret();
  if (!secret) {
    // Отдельно от «не найдено» ниже: без хранилища подпись проверить нечем, и
    // это отказ конфигурации, а не отказ доступа. Сказать «задача не найдена»
    // означало бы отправить оператора искать несуществующую ошибку.
    return sendJson(res, 503, {
      success: false,
      error: "Генерация видео не подключена",
      details: ["Не настроено хранилище: проверить принадлежность задачи и сохранить ролик нечем."],
    });
  }

  const handleParam = Array.isArray(req.query.handle) ? req.query.handle[0] : req.query.handle;
  const jobId = readSignedVideoJobHandle({ handle: handleParam, workspaceId: context.workspaceId, secret });

  if (!jobId) {
    // Один ответ и на подделанную подпись, и на чужую задачу, и на мусор:
    // различать их наружу — значит подсказывать, какой идентификатор угадан.
    return sendJson(res, 404, {
      success: false,
      error: "Задача генерации не найдена",
      details: ["Идентификатор задачи не принадлежит этому рабочему пространству."],
    });
  }

  try {
    const job = await fetchVideoJob({ fetchImpl: fetch as unknown as GenerationFetch, config, jobId });

    if (job.status === "failed") {
      return sendJson(res, 200, {
        success: true,
        mode: "openai",
        data: {
          status: "failed",
          progress: job.progress,
          creativeUrl: "",
          failureReason: job.error || "Сервис генерации не сообщил причину.",
        },
      });
    }

    if (job.status !== "completed") {
      return sendJson(res, 200, {
        success: true,
        mode: "openai",
        data: { status: job.status, progress: job.progress, creativeUrl: "" },
      });
    }

    const buffer = await downloadVideoContent({ fetchImpl: fetch as unknown as GenerationFetch, config, jobId });

    // Ролик уже отрендерен и оплачен. Отказ хранилища — не отказ генерации, и
    // называть его так означало бы предложить оператору запустить рендер ещё
    // раз. Ссылка провайдера живёт час, поэтому повтор опроса в этот час ещё
    // может забрать тот же файл: об этом и говорит подсказка.
    try {
      const stored = await storeGeneratedCreative({
        workspaceId: context.workspaceId,
        fileName: generatedFileName("video", "video/mp4"),
        mimeType: "video/mp4",
        buffer,
        metadata: {
          source: "content-studio",
          kind: "generated-video",
          provider: "openai",
          model: config.videoModel,
          jobId,
        },
        // Опрос — обычный GET, и провайдер отвечает «completed» на каждый
        // запрос. Потерянный по дороге ответ, перезагрузка страницы или второй
        // клик без этого ключа дали бы второй объект в хранилище и вторую
        // строку в библиотеке: два неразличимых креатива за одну генерацию.
        idempotencyKey: jobId,
      });

      return sendJson(res, 200, {
        success: true,
        mode: "openai",
        ...(stored.warning ? { warning: stored.warning } : {}),
        data: {
          status: "completed",
          progress: 100,
          creativeUrl: stored.publicUrl,
          assetId: typeof stored.asset.id === "string" ? stored.asset.id : "",
          fileSize: buffer.length,
          mimeType: "video/mp4",
        },
      });
    } catch (storageError) {
      return sendJson(res, 502, {
        success: false,
        error: "Ролик отрендерен, но не сохранён",
        details: [storageError instanceof Error ? storageError.message : "Хранилище не приняло файл"],
        hint: "Рендер уже оплачен. Ссылка у провайдера живёт около часа — проверьте хранилище и повторите опрос, не запуская генерацию заново.",
      });
    }
  } catch (error) {
    return sendProviderFailure(res, error, "Не удалось получить готовый ролик");
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const resource = normalizeRouteSegment(readPathSegment(req));
  const authorization = CONTENT_STUDIO_AUTHORIZATION[resource];
  if (!authorization) return sendNotFound(res);

  // Nothing below this line runs for an unauthenticated caller: no OpenAI
  // request, no Telegram request, no Supabase client.
  const context = await authorizePrivateRoute(req, res, authorization);
  if (!context) return;

  if (resource === "generate-package") return handleGeneratePackage(req, res, context);
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

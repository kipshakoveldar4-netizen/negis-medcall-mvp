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
import { persistContentVideoPatchIfAvailable } from "../../lib/crm/server";
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const resource = normalizeRouteSegment(readPathSegment(req));
  const authorization = CONTENT_STUDIO_AUTHORIZATION[resource];
  if (!authorization) return sendNotFound(res);

  // Nothing below this line runs for an unauthenticated caller: no OpenAI
  // request, no Telegram request, no Supabase client.
  const context = await authorizePrivateRoute(req, res, authorization);
  if (!context) return;

  if (resource === "generate-package") return handleGeneratePackage(req, res, context);
  if (resource === "generate-script") return handleGenerateScript(req, res, context);
  if (resource === "generate-avatar-prompt") return handleGenerateAvatarPrompt(req, res, context);
  if (resource === "generate-tapnow-prompt") return handleGenerateTapNowPrompt(req, res, context);
  if (resource === "send-telegram") return handleSendTelegram(req, res, context);

  return sendNotFound(res);
}

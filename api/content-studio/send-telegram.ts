import type { VercelRequest, VercelResponse } from "@vercel/node";
import { telegramPackageText, updateContentVideo } from "../../lib/content-studio/core";

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
  description?: string;
  raw?: string;
};

function sendJson(res: VercelResponse, status: number, payload: unknown) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json(payload);
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return sendJson(res, 405, {
      success: false,
      error: "Method not allowed",
      details: ["Use POST"],
    });
  }

  const payload = (req.body || {}) as Record<string, unknown>;
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
  const chatId = (typeof payload.chatId === "string" ? payload.chatId : process.env.TELEGRAM_CHAT_ID)?.trim();

  if (!token || !chatId) {
    if (typeof payload.videoId === "string") {
      updateContentVideo(payload.videoId, { status: "telegram_ready" });
    }

    return sendJson(res, 200, {
      success: true,
      mode: "demo",
      warning: "Telegram не подключён, но пакет готов для копирования.",
      data: {
        sent: false,
        packageText,
      },
    });
  }

  try {
    const safeFetch = fetch as unknown as TelegramFetch;
    const response = await safeFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: packageText,
      }),
    });

    const body = await readTelegramBody(response);
    if (!response.ok || body.ok === false) {
      const invalidJsonNote = body.raw ? " Telegram returned a non-JSON response body." : "";
      return sendJson(res, 502, {
        success: false,
        error: "Telegram API request failed",
        details: [body.description || `Telegram API error: HTTP ${response.status}.${invalidJsonNote}`],
      });
    }

    if (typeof payload.videoId === "string") {
      updateContentVideo(payload.videoId, { status: "telegram_ready" });
    }

    return sendJson(res, 200, {
      success: true,
      mode: "telegram",
      data: {
        sent: true,
        packageText,
      },
    });
  } catch (error) {
    return sendJson(res, 500, {
      success: false,
      error: "Telegram error",
      details: [error instanceof Error ? error.message : "Failed to send Telegram message"],
    });
  }
}

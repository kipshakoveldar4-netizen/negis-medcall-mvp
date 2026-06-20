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
  error_code?: number;
  description?: string;
  raw?: string;
};

function sendJson(res: VercelResponse, status: number, payload: unknown) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json(payload);
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return sendJson(res, 405, {
      success: false,
      error: "Method not allowed",
      details: ["Use POST"],
    });
  }

  const payload = (req.body || {}) as Record<string, unknown>;
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
  const chatId = (typeof payload.chatId === "string" ? payload.chatId : process.env.TELEGRAM_CHAT_ID)?.trim();
  const messageText = isTest ? "✅ Telegram подключён к Negis Content Studio" : packageText;

  if (!token || !chatId) {
    if (typeof payload.videoId === "string") {
      updateContentVideo(payload.videoId, { status: "telegram_ready" });
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
      updateContentVideo(payload.videoId, { status: "telegram_ready" });
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

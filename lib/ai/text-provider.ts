// Текстовая генерация: один вход, два провайдера.
//
// Тексты продукта (пакет Meta Ads, сценарии и посты контент-студии) писались
// только OpenAI. Владелец платформы завёл ключ Anthropic, и осмысленно
// использовать его именно здесь: текст — единственное, что обе модели делают,
// а картинки и видео остаются у OpenAI, потому что Claude их не генерирует.
//
// Правила этого слоя:
//
//   — выбор провайдера объявляется, а не угадывается: AI_TEXT_PROVIDER =
//     anthropic | openai | auto. Умолчание auto означает «Anthropic, если его
//     ключ задан, иначе OpenAI» — добавленный ключ включает Claude без
//     передеплоя кода, а снятый возвращает прежнее поведение;
//   — ключи не покидают этот модуль: наружу уходит только текст ответа и имя
//     провайдера. Ни в одном отказе нет ни ключа, ни заголовков;
//   — отказ провайдера — не тишина: вызывающий получает причину словами и сам
//     решает, показывать ли demo-fallback. Пустой ответ тоже отказ.

export type TextProviderName = "anthropic" | "openai";

export type TextGenerationRequest = {
  system: string;
  /** Уходит пользователю как есть, если строка; объект сериализуется в JSON. */
  user: unknown;
  /** Ответ обязан быть одним JSON-объектом без markdown. */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
};

export type TextGenerationResult =
  | { ok: true; provider: TextProviderName; text: string }
  | { ok: false; provider: TextProviderName | null; reason: string };

type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

type Env = Record<string, string | undefined>;

function readEnv(env: Env, name: string): string {
  return (env[name] || "").trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * Какой провайдер отвечает за текст при этих переменных окружения.
 *
 * Чистая функция без сети: её поведение — предмет тестов, а не догадок.
 */
export function resolveTextProvider(env: Env): TextProviderName | null {
  const requested = readEnv(env, "AI_TEXT_PROVIDER").toLowerCase();
  const hasAnthropic = Boolean(readEnv(env, "ANTHROPIC_API_KEY"));
  const hasOpenAi = Boolean(readEnv(env, "OPENAI_API_KEY"));

  // Явно названный провайдер без ключа — не повод молча уйти к соседу: это
  // ошибка настройки, и вызывающий сообщит о ней словами.
  if (requested === "anthropic") return hasAnthropic ? "anthropic" : null;
  if (requested === "openai") return hasOpenAi ? "openai" : null;

  if (hasAnthropic) return "anthropic";
  if (hasOpenAi) return "openai";
  return null;
}

/** Модель провайдера: переменная окружения важнее умолчания. */
export function modelFor(provider: TextProviderName, env: Env): string {
  if (provider === "anthropic") {
    // Sonnet 5 — рабочая лошадь для маркетинговых текстов: качество выше
    // прежнего gpt-4o-mini при сопоставимой цене. Меняется переменной.
    return readEnv(env, "ANTHROPIC_MODEL") || "claude-sonnet-5";
  }
  return readEnv(env, "OPENAI_ADS_MODEL") || readEnv(env, "OPENAI_MODEL") || "gpt-4o-mini";
}

/**
 * JSON из ответа модели.
 *
 * У Anthropic нет режима «отвечай объектом», поэтому модель просят вернуть
 * чистый JSON — а на случай, когда она всё же обрамит его пояснением или
 * ```-блоком, объект вырезается по внешним скобкам. Без этого один лишний
 * абзац вежливости превращал бы весь ответ в отказ.
 */
export function extractJsonObject(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) return candidate.slice(start, end + 1);
  return "";
}

/** Текст из ответа Anthropic Messages API: блоки type: "text" по порядку. */
export function extractAnthropicText(body: unknown): string {
  const content = asRecord(body).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = asRecord(block);
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("")
    .trim();
}

/** Текст из ответа OpenAI: и chat/completions, и responses. */
export function extractOpenAiText(body: unknown): string {
  const record = asRecord(body);
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const message = asRecord(asRecord(choices[0]).message);
  if (typeof message.content === "string" && message.content.trim()) return message.content.trim();

  const output = Array.isArray(record.output) ? record.output : [];
  for (const item of output) {
    const blocks = asRecord(item).content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      const blockRecord = asRecord(block);
      const text = typeof blockRecord.text === "string" ? blockRecord.text : "";
      if (text.trim()) return text.trim();
    }
  }
  return "";
}

/**
 * Один текстовый запрос к выбранному провайдеру.
 *
 * fetchImpl и env — параметры ради проверяемости: набор тестов гоняет этот
 * путь без сети и без единого настоящего ключа.
 */
export async function generateText(
  request: TextGenerationRequest,
  options: { env?: Env; fetchImpl?: FetchLike } = {},
): Promise<TextGenerationResult> {
  const env = options.env || (process.env as Env);
  const fetchImpl = options.fetchImpl || (fetch as unknown as FetchLike);
  const provider = resolveTextProvider(env);

  if (!provider) {
    const requested = readEnv(env, "AI_TEXT_PROVIDER").toLowerCase();
    return {
      ok: false,
      provider: null,
      reason: requested
        ? `Провайдер ${requested} выбран в AI_TEXT_PROVIDER, но его ключ не задан.`
        : "Ключи текстовых провайдеров не заданы.",
    };
  }

  const userContent = typeof request.user === "string" ? request.user : JSON.stringify(request.user);
  const system = request.json
    ? `${request.system}\n\nОтветь ОДНИМ JSON-объектом без markdown, без пояснений до и после.`
    : request.system;

  try {
    if (provider === "anthropic") {
      const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": readEnv(env, "ANTHROPIC_API_KEY"),
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: modelFor("anthropic", env),
          max_tokens: request.maxTokens ?? 2048,
          ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
          system,
          messages: [{ role: "user", content: userContent }],
        }),
      });

      const body = await response.json().catch(() => null);
      if (!response.ok) {
        // Наружу — код и сообщение провайдера, никогда не заголовки запроса.
        const message = String(asRecord(asRecord(body).error).message || `HTTP ${response.status}`);
        return { ok: false, provider, reason: `Anthropic не ответил успешно: ${message}` };
      }
      const text = extractAnthropicText(body);
      if (!text) return { ok: false, provider, reason: "Anthropic вернул пустой ответ" };
      return { ok: true, provider, text };
    }

    const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${readEnv(env, "OPENAI_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelFor("openai", env),
        ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
        ...(request.json ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
      }),
    });

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = String(asRecord(asRecord(body).error).message || `HTTP ${response.status}`);
      return { ok: false, provider, reason: `OpenAI не ответил успешно: ${message}` };
    }
    const text = extractOpenAiText(body);
    if (!text) return { ok: false, provider, reason: "OpenAI вернул пустой ответ" };
    return { ok: true, provider, text };
  } catch (error) {
    return {
      ok: false,
      provider,
      reason: error instanceof Error ? `${provider}: ${error.message}` : `${provider}: сеть не ответила`,
    };
  }
}

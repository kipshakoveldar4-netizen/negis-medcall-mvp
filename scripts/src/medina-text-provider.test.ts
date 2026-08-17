import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// AI — выбор текстового провайдера.
//
// Тексты продукта умеют двух провайдеров. Набор закрепляет то, что нельзя
// проверить глазами на живом ключе: выбор объявляется, ключ не покидает
// модуль, отказ называется словами, и картинки с видео остаются у OpenAI.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const modulePath = path.join(repoRoot, "lib", "ai", "text-provider.ts");

type ProviderModule = {
  resolveTextProvider: (env: Record<string, string | undefined>) => "anthropic" | "openai" | null;
  modelFor: (provider: "anthropic" | "openai", env: Record<string, string | undefined>) => string;
  extractJsonObject: (raw: string) => string;
  extractAnthropicText: (body: unknown) => string;
  extractOpenAiText: (body: unknown) => string;
  generateText: (
    request: { system: string; user: unknown; json?: boolean; maxTokens?: number; temperature?: number },
    options?: { env?: Record<string, string | undefined>; fetchImpl?: unknown },
  ) => Promise<{ ok: boolean; provider: string | null; text?: string; reason?: string }>;
};

const { resolveTextProvider, modelFor, extractJsonObject, extractAnthropicText, extractOpenAiText, generateText } =
  (await import(pathToFileURL(modulePath).href)) as ProviderModule;

const ANTHROPIC_ONLY = { ANTHROPIC_API_KEY: "test-key-not-real" };
const OPENAI_ONLY = { OPENAI_API_KEY: "test-key-not-real" };
const BOTH = { ...ANTHROPIC_ONLY, ...OPENAI_ONLY };

/** Записывает запрос и отвечает заданным телом — сети в тестах нет. */
function recordingFetch(response: { ok?: boolean; status?: number; body: unknown }) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
    return {
      ok: response.ok !== false,
      status: response.status ?? 200,
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    };
  };
  return { calls, fetchImpl };
}

test("AI1 выбор провайдера объявляется, а не угадывается", () => {
  assert.equal(resolveTextProvider({}), null, "без ключей — никакого провайдера");
  assert.equal(resolveTextProvider(OPENAI_ONLY), "openai");
  assert.equal(resolveTextProvider(ANTHROPIC_ONLY), "anthropic");
  // Ключ Anthropic включает Claude без правки кода — ровно то, ради чего
  // владелец платформы его заводил.
  assert.equal(resolveTextProvider(BOTH), "anthropic", "auto предпочитает Anthropic");
  assert.equal(resolveTextProvider({ ...BOTH, AI_TEXT_PROVIDER: "openai" }), "openai", "явный выбор сильнее умолчания");
  assert.equal(resolveTextProvider({ ...BOTH, AI_TEXT_PROVIDER: "anthropic" }), "anthropic");
  // Названный провайдер без ключа — ошибка настройки, а не повод молча уйти
  // к соседу: иначе владелец думал бы, что тексты пишет Claude.
  assert.equal(resolveTextProvider({ ...OPENAI_ONLY, AI_TEXT_PROVIDER: "anthropic" }), null);
  assert.equal(resolveTextProvider({ ...ANTHROPIC_ONLY, AI_TEXT_PROVIDER: "openai" }), null);
});

test("AI2 модель берётся из окружения, умолчание — из каталога актуальных", () => {
  assert.equal(modelFor("anthropic", ANTHROPIC_ONLY), "claude-sonnet-5");
  assert.equal(modelFor("anthropic", { ...ANTHROPIC_ONLY, ANTHROPIC_MODEL: "claude-opus-5" }), "claude-opus-5");
  assert.equal(modelFor("openai", OPENAI_ONLY), "gpt-4o-mini");
  assert.equal(modelFor("openai", { ...OPENAI_ONLY, OPENAI_ADS_MODEL: "gpt-4.1" }), "gpt-4.1");
});

test("AI3 запрос к Anthropic уходит по контракту Messages API", async () => {
  const { calls, fetchImpl } = recordingFetch({ body: { content: [{ type: "text", text: '{"headline":"Привет"}' }] } });
  const result = await generateText(
    { system: "Ты маркетолог", user: { task: "заголовок" }, json: true, maxTokens: 512, temperature: 0.3 },
    { env: BOTH, fetchImpl },
  );

  assert.equal(result.ok, true);
  assert.equal(result.provider, "anthropic");
  assert.equal(result.text, '{"headline":"Привет"}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].headers["anthropic-version"], "2023-06-01", "версия API обязательна");
  assert.ok(calls[0].headers["x-api-key"], "ключ идёт заголовком x-api-key, не Bearer");
  assert.equal(calls[0].body.max_tokens, 512, "max_tokens у Anthropic обязателен");
  assert.equal(calls[0].body.model, "claude-sonnet-5");
  // system — отдельным полем, не первым сообщением: у Messages API это разные вещи.
  assert.ok(String(calls[0].body.system).startsWith("Ты маркетолог"));
  assert.ok(/JSON-объектом/.test(String(calls[0].body.system)), "json-режим просится словами: формата json_object у Anthropic нет");
});

test("AI4 ключи не попадают ни в один ответ модуля", async () => {
  const secret = "sk-test-should-never-surface";
  const env = { ANTHROPIC_API_KEY: secret };

  const failed = recordingFetch({ ok: false, status: 401, body: { error: { message: "invalid x-api-key" } } });
  const refusal = await generateText({ system: "s", user: "u" }, { env, fetchImpl: failed.fetchImpl });
  assert.equal(refusal.ok, false);
  assert.ok(refusal.reason && !refusal.reason.includes(secret), "отказ не пересказывает ключ");
  assert.ok(/Anthropic не ответил успешно/.test(refusal.reason || ""), "и называет причину словами");

  const empty = recordingFetch({ body: { content: [] } });
  const emptyResult = await generateText({ system: "s", user: "u" }, { env, fetchImpl: empty.fetchImpl });
  assert.equal(emptyResult.ok, false, "пустой ответ — отказ, а не пустой текст наружу");

  const thrown = await generateText(
    { system: "s", user: "u" },
    {
      env,
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as never,
    },
  );
  assert.equal(thrown.ok, false);
  assert.ok(!(thrown.reason || "").includes(secret));

  const source = await readFile(modulePath, "utf8");
  assert.ok(!/console\./.test(source), "модуль ничего не логирует — ключ не утечёт в лог");
});

test("AI5 JSON вырезается из ответа, даже если модель обрамила его словами", () => {
  assert.equal(extractJsonObject('{"a":1}'), '{"a":1}');
  assert.equal(extractJsonObject('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractJsonObject('Конечно! {"a":1} Готово.'), '{"a":1}');
  assert.equal(extractJsonObject("никакого объекта"), "", "нет объекта — пусто, а не мусор");
  assert.equal(extractJsonObject(""), "");
});

test("AI6 текст читается из обоих форматов ответа", () => {
  assert.equal(extractAnthropicText({ content: [{ type: "text", text: "раз" }, { type: "text", text: "два" }] }), "раздва");
  assert.equal(extractAnthropicText({ content: [{ type: "tool_use", id: "x" }] }), "", "не-текстовые блоки игнорируются");
  assert.equal(extractOpenAiText({ choices: [{ message: { content: "ответ" } }] }), "ответ");
  assert.equal(extractOpenAiText({ output: [{ content: [{ text: "ответ" }] }] }), "ответ");
  assert.equal(extractOpenAiText({}), "");
});

test("AI7 картинки и видео остаются у OpenAI — Claude их не генерирует", async () => {
  const generation = await readFile(path.join(repoRoot, "lib", "content-studio", "generation.ts"), "utf8");
  assert.ok(/api\.openai\.com\/v1\/images\/generations/.test(generation), "картинки — OpenAI");
  assert.ok(/api\.openai\.com\/v1\/videos/.test(generation), "видео — OpenAI");
  assert.ok(!/anthropic/i.test(generation), "в файле генерации файлов Anthropic не появляется");

  const example = await readFile(path.join(repoRoot, ".env.example"), "utf8");
  assert.ok(/^ANTHROPIC_API_KEY=$/m.test(example), "ключ объявлен плейсхолдером, без значения");
  assert.ok(/^AI_TEXT_PROVIDER=$/m.test(example) && /^ANTHROPIC_MODEL=$/m.test(example));
});

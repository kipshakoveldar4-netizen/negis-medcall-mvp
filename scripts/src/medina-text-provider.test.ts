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
  modelFor: (provider: "anthropic" | "openai", env: Record<string, string | undefined>, purpose?: "ads" | "content") => string;
  isRealProvider: (value: unknown) => boolean;
  truncatedByLimit: (body: unknown) => boolean;
  extractJsonObject: (raw: string) => string;
  extractAnthropicText: (body: unknown) => string;
  extractOpenAiText: (body: unknown) => string;
  generateText: (
    request: { system: string; user: unknown; purpose: "ads" | "content"; json?: boolean; maxTokens?: number },
    options?: { env?: Record<string, string | undefined>; fetchImpl?: unknown },
  ) => Promise<{ ok: boolean; provider: string | null; text?: string; reason?: string; status?: number; retryable?: boolean }>;
};

const {
  resolveTextProvider,
  modelFor,
  isRealProvider,
  truncatedByLimit,
  extractJsonObject,
  extractAnthropicText,
  extractOpenAiText,
  generateText,
} = (await import(pathToFileURL(modulePath).href)) as ProviderModule;

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
  // Умолчание — OpenAI: на счету Anthropic нет средств, и заведённый ключ
  // отвечал бы отказом на каждый запрос.
  assert.equal(resolveTextProvider(BOTH), "openai", "auto предпочитает OpenAI");
  assert.equal(resolveTextProvider({ ...BOTH, AI_TEXT_PROVIDER: "openai" }), "openai", "явный выбор сильнее умолчания");
  assert.equal(resolveTextProvider({ ...BOTH, AI_TEXT_PROVIDER: "anthropic" }), "anthropic", "одна переменная включает Claude обратно");
  // Названный провайдер без ключа — ошибка настройки, а не повод молча уйти
  // к соседу: иначе владелец думал бы, что тексты пишет Claude.
  assert.equal(resolveTextProvider({ ...OPENAI_ONLY, AI_TEXT_PROVIDER: "anthropic" }), null);
  assert.equal(resolveTextProvider({ ...ANTHROPIC_ONLY, AI_TEXT_PROVIDER: "openai" }), null);
  // Пробельный ключ — не ключ: без trim он включал бы провайдера, который
  // немедленно ответит 401.
  assert.equal(resolveTextProvider({ ANTHROPIC_API_KEY: " \n " }), null, "ключ из пробелов не считается заданным");
  assert.equal(resolveTextProvider({ ...OPENAI_ONLY, AI_TEXT_PROVIDER: "  openai  " }), "openai", "имя провайдера тримится");
});

test("AI2 модель берётся из окружения; у рекламы и студии переменные РАЗНЫЕ", () => {
  assert.equal(modelFor("anthropic", ANTHROPIC_ONLY), "claude-sonnet-5");
  assert.equal(modelFor("anthropic", { ...ANTHROPIC_ONLY, ANTHROPIC_MODEL: "claude-opus-5" }), "claude-opus-5");
  assert.equal(modelFor("openai", OPENAI_ONLY, "ads"), "gpt-4o-mini");
  assert.equal(modelFor("openai", OPENAI_ONLY, "content"), "gpt-4.1-mini", "у контент-студии своё умолчание");
  // Приоритет проверяется при ОБЕИХ заданных переменных: порознь перестановка
  // читателей местами прошла бы незамеченной.
  const bothModels = { ...OPENAI_ONLY, OPENAI_ADS_MODEL: "gpt-ads", OPENAI_MODEL: "gpt-common" };
  assert.equal(modelFor("openai", bothModels, "ads"), "gpt-ads", "реклама предпочитает свою переменную");
  // OPENAI_ADS_MODEL заводили ДЛЯ РЕКЛАМЫ: она не должна править студией.
  assert.equal(modelFor("openai", bothModels, "content"), "gpt-common", "студия не читает рекламную переменную");
});

test("AI2b живой провайдер отличим от заготовки", () => {
  assert.equal(isRealProvider("anthropic"), true);
  assert.equal(isRealProvider("openai"), true);
  for (const fake of ["demo", "mock", "telegram", "rules", "", null, undefined]) {
    assert.equal(isRealProvider(fake), false, `«${String(fake)}» — не модель`);
  }
});

test("AI3 запрос к Anthropic уходит по контракту Messages API", async () => {
  const { calls, fetchImpl } = recordingFetch({ body: { content: [{ type: "text", text: '{"headline":"Привет"}' }] } });
  const result = await generateText(
    { system: "Ты маркетолог", user: { task: "заголовок" }, purpose: "ads", json: true, maxTokens: 512 },
    { env: { ...BOTH, AI_TEXT_PROVIDER: "anthropic" }, fetchImpl },
  );

  assert.equal(result.ok, true);
  assert.equal(result.provider, "anthropic");
  assert.equal(result.text, '{"headline":"Привет"}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].headers["anthropic-version"], "2023-06-01", "версия API обязательна");
  // Ключ идёт ИМЕННО в x-api-key и никогда Bearer-ом: проверяется и то, и другое.
  assert.equal(calls[0].headers["x-api-key"], "test-key-not-real");
  assert.equal(calls[0].headers.Authorization, undefined, "Authorization у Anthropic не используется");
  assert.equal(calls[0].body.max_tokens, 512, "max_tokens у Anthropic обязателен");
  assert.equal(calls[0].body.model, "claude-sonnet-5");
  // temperature НЕ отправляется: у моделей Claude 5 параметры сэмплирования
  // сняты, и любое не-дефолтное значение — 400. С ним реклама навсегда
  // оставалась бы demo-заготовкой.
  assert.equal("temperature" in calls[0].body, false, "temperature не уходит Anthropic");
  assert.equal("top_p" in calls[0].body, false);
  // system — отдельным полем, не первым сообщением: у Messages API это разные вещи.
  assert.ok(String(calls[0].body.system).startsWith("Ты маркетолог"));
  assert.ok(/JSON-объектом/.test(String(calls[0].body.system)), "json-режим просится словами: формата json_object у Anthropic нет");
});

test("AI3b ветка OpenAI: свой эндпоинт, Bearer и json_object", async () => {
  const { calls, fetchImpl } = recordingFetch({ body: { choices: [{ message: { content: '{"ok":true}' } }] } });
  const result = await generateText(
    { system: "Ты маркетолог", user: "бриф", purpose: "content", json: true },
    { env: OPENAI_ONLY, fetchImpl },
  );

  assert.equal(result.ok, true);
  assert.equal(result.provider, "openai");
  assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.equal(calls[0].headers.Authorization, "Bearer test-key-not-real");
  assert.equal(calls[0].headers["x-api-key"], undefined, "ключ OpenAI не уходит заголовком Anthropic");
  assert.equal(calls[0].body.model, "gpt-4.1-mini", "назначение выбирает модель");
  assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
  // json_object у OpenAI требует слова «json» в промпте — иначе 400.
  const messages = calls[0].body.messages as Array<{ role: string; content: string }>;
  assert.ok(/json/i.test(String(messages[0].content)));
  assert.equal(messages[1].content, "бриф", "строка уходит как есть, без JSON-обёртки");
});

test("AI3c обрыв по лимиту токенов называется своим именем, а не «пустым ответом»", async () => {
  assert.equal(truncatedByLimit({ stop_reason: "max_tokens" }), true);
  assert.equal(truncatedByLimit({ choices: [{ finish_reason: "length" }] }), true);
  assert.equal(truncatedByLimit({ stop_reason: "end_turn" }), false);

  const truncated = recordingFetch({
    body: { stop_reason: "max_tokens", content: [{ type: "text", text: '{"headline":"нача' }] },
  });
  const result = await generateText(
    { system: "s", user: "u", purpose: "ads" },
    { env: { ...ANTHROPIC_ONLY, AI_TEXT_PROVIDER: "anthropic" }, fetchImpl: truncated.fetchImpl },
  );
  assert.equal(result.ok, false);
  assert.ok(/лимит/i.test(result.reason || ""), "причина указывает на лимит, а не на сломанный ключ");
});

test("AI3d в auto-режиме отказ одного провайдера не гасит генерацию, явный выбор — гасит", async () => {
  // Пустой баланс, истёкший ключ, перегрузка — при живом соседе продукт
  // продолжает работать; но названный явно провайдер остаётся выбором.
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    if (url.includes("openai.com")) {
      return { ok: false, status: 429, json: async () => ({ error: { message: "rate limited" } }), text: async () => "" };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: "text", text: '{"ok":true}' }] }),
      text: async () => "",
    };
  };

  const auto = await generateText({ system: "s", user: "u", purpose: "ads" }, { env: BOTH, fetchImpl: fetchImpl as never });
  assert.equal(auto.ok, true, "auto: упавший OpenAI подхватывает Anthropic");
  assert.equal(auto.provider, "anthropic");
  assert.equal(calls.length, 2, "второй провайдер пробуется ровно один раз");

  const explicit = await generateText(
    { system: "s", user: "u", purpose: "ads" },
    { env: { ...BOTH, AI_TEXT_PROVIDER: "openai" }, fetchImpl: fetchImpl as never },
  );
  assert.equal(explicit.ok, false, "явный выбор не подменяется соседом");
  assert.equal(explicit.status, 429, "статус провайдера доезжает до вызывающего");
  assert.equal(explicit.retryable, true, "429 помечен как повторяемый");
});

test("AI4 ключи не попадают ни в один ответ модуля", async () => {
  const secret = "sk-test-should-never-surface";
  const env = { ANTHROPIC_API_KEY: secret };

  // Реальный путь утечки: провайдер эхом возвращает часть присланного
  // заголовка в тексте ошибки. Модуль обязан пересказать причину, но не
  // протащить секрет дальше — поэтому ключ подставлен в тело ответа.
  const echoed = recordingFetch({
    ok: false,
    status: 401,
    body: { error: { message: `invalid x-api-key: ${secret}` } },
  });
  const refusal = await generateText({ system: "s", user: "u", purpose: "ads" }, { env, fetchImpl: echoed.fetchImpl });
  assert.equal(refusal.ok, false);
  assert.ok(/Anthropic не ответил успешно/.test(refusal.reason || ""), "причина называется словами");
  assert.ok(!(refusal.reason || "").includes(secret), "ключ, вернувшийся эхом от провайдера, наружу не уходит");

  const empty = recordingFetch({ body: { content: [] } });
  const emptyResult = await generateText({ system: "s", user: "u", purpose: "ads" }, { env, fetchImpl: empty.fetchImpl });
  assert.equal(emptyResult.ok, false, "пустой ответ — отказ, а не пустой текст наружу");

  const thrown = await generateText(
    { system: "s", user: "u", purpose: "ads" },
    {
      env,
      fetchImpl: (async () => {
        throw new Error(`network down for ${secret}`);
      }) as never,
    },
  );
  assert.equal(thrown.ok, false);
  assert.ok(!(thrown.reason || "").includes(secret), "исключение fetch тоже не проносит ключ");

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
  // Судим КОД без комментариев: густо комментированный файл удовлетворял бы
  // грепу по URL даже после переноса вызова на другой эндпоинт (урок VT12).
  const generation = (await readFile(path.join(repoRoot, "lib", "content-studio", "generation.ts"), "utf8"))
    .replace(/(^|\s)\/\/[^\n]*/g, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  assert.ok(/fetchImpl\(\s*"https:\/\/api\.openai\.com\/v1\/images\/generations"/.test(generation), "картинки — вызов к OpenAI");
  assert.ok(/api\.openai\.com\/v1\/videos/.test(generation), "видео — OpenAI");
  assert.ok(!/anthropic/i.test(generation), "в файле генерации файлов Anthropic не появляется");
  assert.ok(!/text-provider/.test(generation), "и он не ходит через текстовый слой");

  const example = await readFile(path.join(repoRoot, ".env.example"), "utf8");
  assert.ok(/^ANTHROPIC_API_KEY=$/m.test(example), "ключ объявлен плейсхолдером, без значения");
  assert.ok(/^AI_TEXT_PROVIDER=$/m.test(example) && /^ANTHROPIC_MODEL=$/m.test(example));
});

test("AI8 живую модель узнают все потребители, а не только по имени «openai»", async () => {
  // Равенство «openai» выбрасывало уже оплаченный ответ Claude и печатало
  // «ИИ-провайдер не подключён»; на экране рекламы настоящая генерация
  // объявлялась «образцом пакета».
  const improve = await readFile(path.join(repoRoot, "lib", "meta", "improve.ts"), "utf8");
  assert.ok(/isRealProvider\(generated\.mode\)/.test(improve), "улучшение текста принимает любого живого провайдера");
  assert.ok(!/generated\.mode !== "openai"/.test(improve), "равенство одному провайдеру изгнано");

  const ads = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "AdsAutomation.tsx"), "utf8");
  assert.ok(
    /generatedBy === "openai" \|\| body\.data\.generatedBy === "anthropic"/.test(ads),
    "тост не называет генерацию Claude образцом",
  );

  const server = await readFile(path.join(repoRoot, "lib", "crm", "server.ts"), "utf8");
  assert.ok(/generatedBy: ai\.data \? ai\.provider : "demo"/.test(server), "сервер честно называет автора текста");
  assert.ok(!/temperature: 0\.35/.test(server), "температура не уходит моделям, где параметр снят");

  // Ошибка настройки не маскируется заготовкой: опечатка в AI_TEXT_PROVIDER
  // иначе выглядела бы как «ключей нет».
  const core = await readFile(path.join(repoRoot, "lib", "content-studio", "core.ts"), "utf8");
  assert.ok(/AI_TEXT_PROVIDER\?\.trim\(\)/.test(core) && /throw new Error/.test(core), "названный провайдер без ключа — явная ошибка");
});
